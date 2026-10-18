#!/usr/bin/env python3
"""Build the offline vector basemap for the app's street maps.

Output: app/src/static/data/basemap.json, a GeoJSON FeatureCollection that
Leaflet draws with L.geoJSON, with no network. (It is the only usable map
layer while Carto's keyless tile URLs serve "API KEY REQUIRED" images.)
Every feature has properties {k, n?}:
  k = "land"   shoreline polygons (NYC boroughs, water-clipped; NJ waterfront)
      "park"   major parks (n = park name)
      "road"   other main streets, one unnamed MultiLineString per borough
      "major"  the ~70 streets/avenues/bridges people navigate by (n = name)
Features are ordered land, park, road, major so a plain L.geoJSON paints them
in the right stacking order. The collection also carries a standard GeoJSON
"bbox" ([w, s, e, n], the true extent of every coordinate, so it can be used
directly for maxBounds) and an "attribution" string.

Sources (public, no keys):
  NYC Open Data  gthc-hcne  Borough Boundaries (water areas excluded, DCP)
                 enfh-gkve  Parks Properties (NYC Parks)
                 inkn-q76z  Centerline / CSCL (DoITT/OTI)
  U.S. Census    cb_2024_34_cousub_500k  NJ county subdivisions (cartographic,
                 shoreline-clipped) so the Hudson reads as a river, not open sea.

Raw downloads are cached in research/basemap/ (gitignored). Re-run with
--refresh to download again. A download failure, or output that fails the
sanity checks in check() (e.g. an upstream dataset went empty), exits non-zero
and leaves the existing basemap.json untouched.

  python3 -I tools/basemap_build.py [--refresh] [--max-kb 450] [--out PATH] [--cache DIR]

Standard library only. HTTPS goes through urllib, falling back to curl when
the local Python has no usable CA bundle (common on macOS framework builds).
"""
import argparse
import io
import json
import math
import os
import re
import struct
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'research', 'basemap')
OUT = os.path.join(ROOT, 'app', 'src', 'static', 'data', 'basemap.json')

# View/data box: Manhattan to ~155th St, north + west Brooklyn to Prospect Park,
# LIC/Astoria/LGA, Hoboken/Jersey City, and St George (Staten Island Ferry).
W, S, E, N = -74.09, 40.63, -73.85, 40.835
# Land is clipped a little wider so clip edges sit outside the usable view.
LAND_PAD = 0.01
# Degrees of longitude are shorter than latitude here; scale x so the
# simplification tolerance is isotropic (in degrees of latitude, ~111 km).
KX = math.cos(math.radians(40.73))

ATTRIBUTION = 'NYC Open Data (DCP, NYC Parks, OTI); U.S. Census Bureau'

SODA = 'https://data.cityofnewyork.us/resource/'
NJ_URL = 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_34_cousub_500k.zip'
BORO = {'1': 'Manhattan', '2': 'Bronx', '3': 'Brooklyn', '4': 'Queens', '5': 'Staten Island'}

# Outer-borough "road" lines are kept only inside these boxes (w, s, e, n):
# north/west Brooklyn + LIC/Astoria/Sunnyside, and St George on Staten Island.
OUTER_FOCUS = [(-74.03, 40.655, -73.89, 40.79), (-74.09, 40.63, -74.06, 40.65)]
# Inside these boxes the whole outer-borough street grid is kept, like
# Manhattan's, because these are the neighbourhoods a visitor walks and eats in.
OUTER_GRID = [
    (-74.005, 40.665, -73.955, 40.705),  # DUMBO, Bk Heights, Downtown, Cobble Hill, Carroll Gdns, Fort Greene, Park Slope
    (-73.972, 40.700, -73.930, 40.740),  # Williamsburg, Greenpoint
    (-73.962, 40.738, -73.925, 40.760),  # Long Island City / Hunters Point
    (-73.940, 40.755, -73.900, 40.782),  # Astoria
    (-74.085, 40.636, -74.072, 40.648),  # St George, by the Staten Island Ferry terminal
]
# Divided roadways, double-deck bridges and tunnel-portal lanes of one street
# within this distance (degrees of latitude, ~45 m) collapse to a single line.
PARALLEL_D = 0.0004

# Manhattan minor streets stop at ~110th St. The street runs along this line
# (fitted to the 110th St centerline: Riverside Dr end -> FDR end).
M110_A = (-73.96819, 40.80498)
M110_B = (-73.93611, 40.79130)
M110_MARGIN = 0.0004  # ~45 m: keeps 110th itself, drops 111th

# Named major roads: (display name, borough codes, raw CSCL full_street_name
# values after whitespace collapse). Each entry becomes one feature.
MAJOR = [
    # Manhattan avenues and north-south streets
    ('Broadway', '1', ['BROADWAY']),
    ('1st Ave', '1', ['1 AVE']),
    ('2nd Ave', '1', ['2 AVE']),
    ('3rd Ave', '1', ['3 AVE']),
    ('Lexington Ave', '1', ['LEXINGTON AVE']),
    ('Park Ave', '1', ['PARK AVE', 'PARK AVE S', 'PARK AVE VIADUCT']),
    ('Madison Ave', '1', ['MADISON AVE']),
    ('5th Ave', '1', ['5 AVE']),
    ('6th Ave', '1', ['AVE OF THE AMERICAS']),
    ('7th Ave', '1', ['7 AVE', '7 AVE S']),
    ('8th Ave', '1', ['8 AVE']),
    ('9th Ave', '1', ['9 AVE']),
    ('10th Ave', '1', ['10 AVE']),
    ('11th Ave', '1', ['11 AVE']),
    ('12th Ave', '1', ['12 AVE']),
    ('Columbus Ave', '1', ['COLUMBUS AVE']),
    ('Amsterdam Ave', '1', ['AMSTERDAM AVE']),
    ('Central Park W', '1', ['CENTRAL PARK W']),
    ('West End Ave', '1', ['W END AVE']),
    ('Riverside Dr', '1', ['RIVERSIDE DR']),
    ('York Ave', '1', ['YORK AVE']),
    ('Avenue A', '1', ['AVE A']),
    ('Bowery', '1', ['BOWERY']),
    ('Lafayette St', '1', ['LAFAYETTE ST']),
    ('Hudson St', '1', ['HUDSON ST']),
    ('Varick St', '1', ['VARICK ST']),
    ('Church St', '1', ['CHURCH ST']),
    ('West St', '1', ['WEST ST']),
    ('FDR Dr', '1', ['FRANKLIN D ROOSEVELT DR', 'FDR DR VIADUCT']),
    ('Henry Hudson Pkwy', '1', ['HENRY HUDSON PKWY']),
    # Manhattan cross streets
    ('Chambers St', '1', ['CHAMBERS ST']),
    ('Canal St', '1', ['CANAL ST']),
    ('Grand St', '1', ['GRAND ST']),
    ('Delancey St', '1', ['DELANCEY ST']),
    ('Houston St', '1', ['E HOUSTON ST', 'W HOUSTON ST']),
    ('Bleecker St', '1', ['BLEECKER ST']),
    ('8th St', '1', ['E 8 ST', 'W 8 ST', 'ST MARKS PL']),
    ('14th St', '1', ['E 14 ST', 'W 14 ST']),
    ('23rd St', '1', ['E 23 ST', 'W 23 ST']),
    ('34th St', '1', ['E 34 ST', 'W 34 ST']),
    ('42nd St', '1', ['E 42 ST', 'W 42 ST']),
    ('57th St', '1', ['E 57 ST', 'W 57 ST']),
    ('59th St', '1', ['E 59 ST', 'W 59 ST']),
    ('Central Park S', '1', ['CENTRAL PARK S']),
    ('72nd St', '1', ['E 72 ST', 'W 72 ST']),
    ('79th St', '1', ['E 79 ST', 'W 79 ST']),
    ('86th St', '1', ['E 86 ST', 'W 86 ST']),
    ('96th St', '1', ['E 96 ST', 'W 96 ST']),
    ('110th St', '1', ['E 110 ST', 'W 110 ST', 'CENTRAL PARK N', 'CATHEDRAL PKWY']),
    ('125th St', '1', ['E 125 ST', 'W 125 ST']),
    # East River crossings (decks only; ramps and paths are filtered out)
    ('Brooklyn Bridge', '13', ['BROOKLYN BRG']),
    ('Manhattan Bridge', '13', ['MANHATTAN BRG']),
    ('Williamsburg Bridge', '13', ['WILLIAMSBURG BRG']),
    ('Queensboro Bridge', '14', ['ED KOCH QUEENSBORO BRG']),
    ('Pulaski Bridge', '34', ['PULASKI BRG']),
    # Brooklyn
    ('Atlantic Ave', '3', ['ATLANTIC AVE']),
    ('Flatbush Ave', '3', ['FLATBUSH AVE', 'FLATBUSH AVE EXTENSION']),
    ('Fulton St', '3', ['FULTON ST']),
    ('Court St', '3', ['COURT ST']),
    ('Smith St', '3', ['SMITH ST']),
    ('Van Brunt St', '3', ['VAN BRUNT ST']),
    ('4th Ave', '3', ['4 AVE']),
    ('5th Ave', '3', ['5 AVE']),
    ('7th Ave', '3', ['7 AVE']),
    ('Prospect Park W', '3', ['PROSPECT PARK W']),
    ('Eastern Pkwy', '3', ['EASTERN PKWY']),
    ('Myrtle Ave', '3', ['MYRTLE AVE']),
    ('Broadway', '3', ['BROADWAY']),
    ('Bedford Ave', '3', ['BEDFORD AVE']),
    ('Kent Ave', '3', ['KENT AVE']),
    ('Grand St', '3', ['GRAND ST']),
    ('Metropolitan Ave', '3', ['METROPOLITAN AVE']),
    ('Manhattan Ave', '3', ['MANHATTAN AVE']),
    ('McGuinness Blvd', '3', ['MCGUINNESS BLVD']),
    ('BQE', '34', ['BROOKLYN QUEENS EXPY']),
    # Queens
    ('Vernon Blvd', '4', ['VERNON BLVD']),
    ('Jackson Ave', '4', ['JACKSON AVE']),
    ('Queens Blvd', '4', ['QUEENS BLVD']),
    ('Northern Blvd', '4', ['NORTHERN BLVD']),
    ('21st St', '4', ['21 ST']),
    ('31st St', '4', ['31 ST']),
    ('Steinway St', '4', ['STEINWAY ST']),
    ('Broadway', '4', ['BROADWAY']),
    ('30th Ave', '4', ['30 AVE']),
    ('Ditmars Blvd', '4', ['DITMARS BLVD']),
    ('Astoria Blvd', '4', ['ASTORIA BLVD', 'ASTORIA BLVD N', 'ASTORIA BLVD S']),
    # Staten Island (St George ferry terminal area)
    ('Richmond Ter', '5', ['RICHMOND TER']),
    ('Bay St', '5', ['BAY ST']),
]

# Connectors, ramps and non-vehicle paths that share a road's name prefix.
SKIP_NAME = re.compile(r'\b(EXIT|ENTRANCE|EN RP|ET|EN|RAMP|RP|PATH|PED|BIKE|FOOTBRIDGE|GREENWAY|TRL|'
                       r'CONNECTOR|SERVICE RD|U TURN|TURN)\b')
# CSCL roadway types kept: 1 street, 2 highway, 3 bridge (tunnels, ramps,
# paths, ferries, driveways, alleys etc. are dropped).
RW_KEEP = {'1', '2', '3'}


# ---------------------------------------------------------------- download

class DownloadError(Exception):
    pass


_use_curl = False  # set after urllib fails once (e.g. no CA bundle), so later calls go straight to curl


def fetch(url, dest):
    """Download url to dest (atomic). urllib first, curl if SSL is broken.
    Raises DownloadError; a failed download never replaces dest."""
    global _use_curl
    tmp = dest + '.part'
    try:
        if not _use_curl:
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'nyc-trip-basemap/1'})
                with urllib.request.urlopen(req, timeout=300) as r, open(tmp, 'wb') as f:
                    while True:
                        b = r.read(1 << 16)
                        if not b:
                            break
                        f.write(b)
                os.replace(tmp, dest)
                return
            except Exception as e:  # SSL trust store missing, proxies, etc.
                print(f'  urllib failed ({type(e).__name__}); using curl', file=sys.stderr)
                _use_curl = True
        r = subprocess.run(['curl', '-sS', '-f', '-L', '-m', '600', '-o', tmp, url],
                           stderr=subprocess.PIPE, text=True)
        if r.returncode:
            raise DownloadError(f'{urllib.parse.urlsplit(url).netloc}: {r.stderr.strip() or "curl exit " + str(r.returncode)}')
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def soda_url(dataset, **params):
    q = urllib.parse.urlencode({'$' + k: v for k, v in params.items()})
    return f'{SODA}{dataset}.geojson?{q}'


def box_wkt(w, s, e, n):
    return f"POLYGON(({w} {s}, {e} {s}, {e} {n}, {w} {n}, {w} {s}))"


PARKS_LIMIT = 50000


def load_sources(refresh, cache=CACHE):
    """Fetch (or reuse cached) raw files; return parsed sources."""
    os.makedirs(cache, exist_ok=True)
    box = box_wkt(W - LAND_PAD, S - LAND_PAD, E + LAND_PAD, N + LAND_PAD)

    def cached(name, url_or_fn):
        path = os.path.join(cache, name)
        if refresh or not os.path.exists(path):
            print(f'  downloading {name}', file=sys.stderr)
            if callable(url_or_fn):
                url_or_fn(path)
            else:
                fetch(url_or_fn, path)
        return path

    boroughs = cached('boroughs.geojson', SODA + 'gthc-hcne.geojson')
    parks = cached('parks.geojson', soda_url(
        'enfh-gkve', select='multipolygon,signname,acres,typecategory,borough',
        where=f"intersects(multipolygon, '{box}')", limit=PARKS_LIMIT))

    def centerline(path):
        # Paged so a large result never truncates silently.
        feats, off, page = [], 0, 20000
        while True:
            url = soda_url(
                'inkn-q76z',
                select='the_geom,full_street_name,rw_type,status,boroughcode,truck_route_type,carto_display_level',
                where=f"rw_type in ('1','2','3') AND intersects(the_geom, '{box}')",
                order='objectid', limit=page, offset=off)
            part = path + '.page'
            fetch(url, part)
            with open(part) as f:
                got = json.load(f).get('features')
            os.remove(part)
            if got is None:
                raise DownloadError('centerline: response has no features')
            feats += got
            print(f'    centerline rows: {len(feats)}', file=sys.stderr)
            if len(got) < page:
                break
            off += page
        write_atomic(path, json.dumps({'type': 'FeatureCollection', 'features': feats}))

    cl = cached('centerline.geojson', centerline)
    nj = cached('nj_cousub_500k.zip', NJ_URL)

    boroughs, parks, cl = (read_features(p) for p in (boroughs, parks, cl))
    if len(parks) >= PARKS_LIMIT:
        raise DownloadError(f'parks: {len(parks)} rows hit the query limit; raise PARKS_LIMIT or page it')
    return boroughs, parks, cl, read_shapefile_zip(nj)


def read_features(path):
    """Features of a cached GeoJSON file. A SODA error body ({"error": ...})
    or a truncated file is reported as a DownloadError, not a KeyError."""
    try:
        with open(path) as f:
            doc = json.load(f)
        feats = doc['features']
    except (ValueError, KeyError, TypeError) as e:
        raise DownloadError(f'{os.path.basename(path)} is not a FeatureCollection ({type(e).__name__}); '
                            f're-run with --refresh')
    return [f for f in feats if isinstance(f, dict) and isinstance(f.get('properties'), dict)]


def write_atomic(path, text):
    """Write text to path via a temp file so a crash never leaves half a file."""
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write(text)
    os.replace(tmp, path)


# ---------------------------------------------------------------- shapefile

def read_shapefile_zip(path):
    """Minimal reader for a zipped polygon shapefile + DBF.
    Returns [(name, [ring, ...])] with rings as [(lon, lat), ...].
    Census cartographic files are NAD83; the ~1 m shift from WGS84 is ignored."""
    z = zipfile.ZipFile(path)
    base = next(n[:-4] for n in z.namelist() if n.endswith('.shp'))
    shp, dbf = z.read(base + '.shp'), z.read(base + '.dbf')
    names = read_dbf(dbf, 'NAMELSAD') or read_dbf(dbf, 'NAME')
    out, pos, i = [], 100, 0
    while pos < len(shp):
        _, clen = struct.unpack('>ii', shp[pos:pos + 8])
        body = shp[pos + 8:pos + 8 + clen * 2]
        pos += 8 + clen * 2
        stype = struct.unpack('<i', body[:4])[0]
        name = names[i] if i < len(names) else ''
        i += 1
        if stype != 5:  # polygon only (null shapes skipped)
            continue
        nparts, npts = struct.unpack('<ii', body[36:44])
        parts = list(struct.unpack(f'<{nparts}i', body[44:44 + 4 * nparts])) + [npts]
        xy = struct.unpack(f'<{2 * npts}d', body[44 + 4 * nparts:44 + 4 * nparts + 16 * npts])
        rings = [[(xy[2 * k], xy[2 * k + 1]) for k in range(parts[p], parts[p + 1])] for p in range(nparts)]
        out.append((name, rings))
    return out


def read_dbf(buf, field):
    """Return one text column from a dBASE III table, or [] if absent."""
    nrec, hlen, rlen = struct.unpack('<IHH', buf[4:12])
    fields, off = [], 32
    while buf[off] != 0x0D:
        fname = buf[off:off + 11].split(b'\0')[0].decode('ascii')
        fields.append((fname, buf[off + 16]))
        off += 32
    start, col = 1, None  # byte 0 of each record is the deletion flag
    for fname, flen in fields:
        if fname == field:
            col = (start, flen)
        start += flen
    if not col:
        return []
    return [buf[hlen + r * rlen + col[0]:hlen + r * rlen + col[0] + col[1]].decode('utf-8', 'replace').strip()
            for r in range(nrec)]


# ---------------------------------------------------------------- geometry

def dp(pts, tol):
    """Douglas-Peucker on [(x, y)] in scaled coords; iterative, keeps ends."""
    n = len(pts)
    if n < 3:
        return pts[:]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack, t2 = [(0, n - 1)], tol * tol
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i]
        bx, by = pts[j]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k]
            if l2 == 0:
                qx, qy = ax, ay
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                qx, qy = ax + t * dx, ay + t * dy
            d = (px - qx) ** 2 + (py - qy) ** 2
            if d > best:
                best, idx = d, k
        if best > t2:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(pts, keep) if k]


def simplify(coords, tol):
    """Simplify lon/lat coords and round to 5 decimals (~1 m)."""
    scaled = [(x * KX, y) for x, y in coords]
    out = []
    for x, y in dp(scaled, tol):
        p = (round(x / KX, 5), round(y, 5))
        if not out or out[-1] != p:
            out.append(p)
    return out


def ring_area(r):
    """Signed area in scaled degrees^2 (positive = counter-clockwise)."""
    a = 0.0
    for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
        a += (x1 * KX) * y2 - (x2 * KX) * y1
    return a / 2


def clip_ring(ring, w, s, e, n):
    """Sutherland-Hodgman clip of a ring to a rectangle. Returns open ring."""
    pts = ring[:-1] if ring and ring[0] == ring[-1] else ring[:]
    edges = [
        (lambda p: p[0] >= w, lambda a, b: (w, a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= e, lambda a, b: (e, a[1] + (b[1] - a[1]) * (e - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= s, lambda a, b: (a[0] + (b[0] - a[0]) * (s - a[1]) / (b[1] - a[1]), s)),
        (lambda p: p[1] <= n, lambda a, b: (a[0] + (b[0] - a[0]) * (n - a[1]) / (b[1] - a[1]), n)),
    ]
    for inside, cross in edges:
        if not pts:
            break
        src, pts = pts, []
        prev = src[-1]
        for cur in src:
            if inside(cur):
                if not inside(prev):
                    pts.append(cross(prev, cur))
                pts.append(cur)
            elif inside(prev):
                pts.append(cross(prev, cur))
            prev = cur
    return pts


def point_in_ring(p, ring):
    x, y, inside = p[0], p[1], False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def polygon_out(rings, box, tol, min_area):
    """Clip + simplify one polygon ([outer, *holes]); None if it vanishes.
    Rings come out closed, outer counter-clockwise, holes clockwise (RFC 7946)."""
    out = []
    for i, ring in enumerate(rings):
        r = clip_ring([tuple(p[:2]) for p in ring], *box)
        if len(r) < 3:
            if i == 0:
                return None
            continue
        r = simplify(r + [r[0]], tol)
        if len(r) > 1 and r[0] == r[-1]:
            r = r[:-1]
        a = ring_area(r) if len(r) >= 3 else 0
        if abs(a) < min_area:
            if i == 0:
                return None
            continue
        if (a > 0) != (i == 0):
            r.reverse()
        out.append([list(p) for p in r + [r[0]]])
    return out or None


def norm_name(s):
    return re.sub(r'\s+', ' ', (s or '').strip().upper())


def in_box(p, b):
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def north_of_110th(p):
    (x1, y1), (x2, y2) = M110_A, M110_B
    line_y = y1 + (p[0] - x1) * (y2 - y1) / (x2 - x1)
    return p[1] > line_y + M110_MARGIN


def merge_lines(segs):
    """Join segments that share endpoints into longer chains, preferring the
    straightest continuation at forks, so simplification can drop the
    intersection vertices of a grid street."""
    key = lambda p: (round(p[0], 6), round(p[1], 6))
    at = {}
    for i, s in enumerate(segs):
        at.setdefault(key(s[0]), []).append(i)
        at.setdefault(key(s[-1]), []).append(i)
    used = [False] * len(segs)

    def heading(a, b):
        return math.atan2(b[1] - a[1], (b[0] - a[0]) * KX)

    def extend(chain):
        while True:
            tail, before = chain[-1], chain[-2]
            h0 = heading(before, tail)
            best, best_turn = None, None
            for j in at.get(key(tail), []):
                if used[j]:
                    continue
                s = segs[j] if key(segs[j][0]) == key(tail) else segs[j][::-1]
                turn = abs((heading(s[0], s[1]) - h0 + math.pi) % (2 * math.pi) - math.pi)
                if best_turn is None or turn < best_turn:
                    best, best_turn, best_j = s, turn, j
            if best is None or best_turn > math.radians(75):
                return chain
            used[best_j] = True
            chain.extend(best[1:])

    # Start from dead ends first so chains run end to end.
    order = sorted(range(len(segs)), key=lambda i: -(len(at[key(segs[i][0])]) == 1 or len(at[key(segs[i][-1])]) == 1))
    chains = []
    for i in order:
        if used[i]:
            continue
        used[i] = True
        c = extend(list(segs[i]))
        c = extend(c[::-1])
        chains.append(c)
    return chains


def clip_line(coords, box):
    """Split a line into runs inside box, keeping one outside vertex at each
    end so the line still reaches the box edge."""
    runs, cur = [], []
    for i, p in enumerate(coords):
        if in_box(p, box):
            if not cur and i > 0:
                cur.append(coords[i - 1])
            cur.append(p)
        elif cur:
            cur.append(p)
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def drop_parallel(chains, d=PARALLEL_D):
    """Keep the longest chain of a street and drop any other chain that runs
    (>= 80% of its length) within d of one already kept. Without this a divided
    avenue draws two or three overlapping casings that read as one fat band."""
    def length(c):
        return sum(math.hypot((b[0] - a[0]) * KX, b[1] - a[1]) for a, b in zip(c, c[1:]))

    grid = {}  # (cx, cy) cell of size d -> kept segments in scaled coords

    def cells(x0, y0, x1, y1):
        for cx in range(math.floor(min(x0, x1) / d), math.floor(max(x0, x1) / d) + 1):
            for cy in range(math.floor(min(y0, y1) / d), math.floor(max(y0, y1) / d) + 1):
                yield cx, cy

    def near(x, y):
        cx, cy = math.floor(x / d), math.floor(y / d)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for ax, ay, bx, by in grid.get((cx + i, cy + j), ()):
                    dx, dy = bx - ax, by - ay
                    l2 = dx * dx + dy * dy
                    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / l2))
                    if (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= d * d:
                        return True
        return False

    kept = []
    for c in sorted(chains, key=length, reverse=True):
        sc = [(x * KX, y) for x, y in c]
        # Sample every ~d/2 along the chain so long straight segments count fairly.
        samples = []
        for (ax, ay), (bx, by) in zip(sc, sc[1:]):
            n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / (d / 2)))
            samples += [(ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n)]
        samples.append(sc[-1])
        if kept and sum(near(x, y) for x, y in samples) >= 0.8 * len(samples):
            continue
        kept.append(c)
        for seg in zip(sc, sc[1:]):
            s = (*seg[0], *seg[1])
            for cell in cells(*s):
                grid.setdefault(cell, []).append(s)
    return kept


# ---------------------------------------------------------------- layers

def build_land(boroughs, nj, tol, min_area):
    box = (W - LAND_PAD, S - LAND_PAD, E + LAND_PAD, N + LAND_PAD)
    feats = []
    for f in sorted(boroughs, key=lambda f: f['properties'].get('borocode', '')):
        g = f.get('geometry')
        if not g or g.get('type') not in ('Polygon', 'MultiPolygon'):
            continue
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        out = [p for p in (polygon_out(rings, box, tol, min_area) for rings in polys) if p]
        if out:
            feats.append(feature('land', f['properties'].get('boroname'), multi_polygon(out)))
    # NJ: one feature per municipality (they share edges; see style notes).
    for name, rings in nj:
        outers = [r for r in rings if ring_area(r) < 0]  # shapefile outers are clockwise
        holes = [r for r in rings if ring_area(r) >= 0]
        out = []
        for o in outers:
            mine = [h for h in holes if point_in_ring(h[0], o)]
            p = polygon_out([o] + mine, box, tol, min_area)
            if p:
                out.append(p)
        if out:
            feats.append(feature('land', re.sub(r'\s+(city|town|township|borough|village)$', '', name), multi_polygon(out)))
    return feats


def num(v):
    """Float from a SODA text field; 0 when missing or malformed."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


PARK_MIN_ACRES = 3.0
PARK_SKIP_TYPES = {'Parkway', 'Strip', 'Mall', 'Garden', 'Lot', 'Operations', 'Undeveloped', 'Cemetery'}
# Small parks people use as landmarks, kept regardless of size.
PARK_ALWAYS = {'Bryant Park', 'Washington Square Park', 'Union Square Park', 'Madison Square Park',
               'Tompkins Square Park', 'The High Line', 'City Hall Park', 'Bowling Green', 'Columbus Park',
               'Seward Park', 'Stuyvesant Square', 'Sara D. Roosevelt Park', 'Grand Army Plaza',
               'Cobble Hill Park', 'Carroll Park', 'Herald Square', 'Greeley Square Park', 'Father Duffy Square'}


def build_parks(parks, tol, min_area):
    box = (W, S, E, N)
    feats = []
    for f in sorted(parks, key=lambda f: -num(f['properties'].get('acres'))):
        p = f['properties']
        name = (p.get('signname') or '').strip()
        acres = num(p.get('acres'))
        if name not in PARK_ALWAYS and (acres < PARK_MIN_ACRES or p.get('typecategory') in PARK_SKIP_TYPES):
            continue
        g = f.get('geometry')
        if not g or g.get('type') not in ('Polygon', 'MultiPolygon'):
            continue
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        out = [q for q in (polygon_out(rings, box, tol, min_area) for rings in polys) if q]
        if out:
            feats.append(feature('park', name or None, multi_polygon(out)))
    return feats


def build_roads(cl, tol):
    major_of = {}
    for i, (_, boros, raws) in enumerate(MAJOR):
        for b in boros:
            for r in raws:
                major_of[(b, r)] = i
    major_segs = [[] for _ in MAJOR]
    road_segs = {}
    for f in cl:
        p, g = f['properties'], f.get('geometry')
        if not g or g.get('type') not in ('LineString', 'MultiLineString') \
                or p.get('status') not in (None, '2') or p.get('rw_type') not in RW_KEEP:
            continue
        name, boro = norm_name(p.get('full_street_name')), p.get('boroughcode')
        parts = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
        parts = [[tuple(c[:2]) for c in part] for part in parts if len(part) >= 2]
        if not parts:
            continue
        mi = major_of.get((boro, name))
        if mi is not None:
            major_segs[mi] += parts
            continue
        if SKIP_NAME.search(name):
            continue
        mid = parts[0][len(parts[0]) // 2]
        if boro == '1':
            # Manhattan: the whole street grid south of ~110th St.
            if p.get('rw_type') == '3' or north_of_110th(mid):
                continue
        elif boro in ('3', '4', '5'):
            # Outer boroughs: the full grid in the walkable neighbourhoods, else
            # arterials only (truck routes, highways, carto-ranked streets).
            arterial = p.get('truck_route_type') or p.get('carto_display_level') or p.get('rw_type') == '2'
            if any(in_box(mid, b) for b in OUTER_GRID):
                if p.get('rw_type') == '3' and not arterial:
                    continue
            elif not (arterial and any(in_box(mid, b) for b in OUTER_FOCUS)):
                continue
        else:
            continue
        road_segs.setdefault((boro, name), []).extend(parts)

    box = (W, S, E, N)

    def lines(segs):
        out = []
        for chain in drop_parallel(merge_lines(segs)):
            for run in clip_line(chain, box):
                s = simplify(run, tol)
                if len(s) >= 2:
                    out.append([list(c) for c in s])
        return out

    feats = []
    by_boro = {}
    for (boro, _), segs in sorted(road_segs.items()):
        by_boro.setdefault(boro, []).extend(lines(segs))
    for boro in sorted(by_boro):
        if by_boro[boro]:
            feats.append(feature('road', None, multi_line(by_boro[boro])))
    for (disp, _, _), segs in zip(MAJOR, major_segs):
        ls = lines(segs)
        if ls:
            feats.append(feature('major', disp, multi_line(ls)))
        else:
            print(f'  warning: no geometry for major road {disp!r}', file=sys.stderr)
    return feats


def feature(k, n, geom):
    props = {'k': k}
    if n:
        props['n'] = n
    return {'type': 'Feature', 'properties': props, 'geometry': geom}


def multi_polygon(polys):
    return {'type': 'Polygon', 'coordinates': polys[0]} if len(polys) == 1 else \
           {'type': 'MultiPolygon', 'coordinates': polys}


def multi_line(ls):
    return {'type': 'LineString', 'coordinates': ls[0]} if len(ls) == 1 else \
           {'type': 'MultiLineString', 'coordinates': ls}


# ---------------------------------------------------------------- main

def build(src, scale):
    boroughs, parks, cl, nj = src
    # Douglas-Peucker tolerances in degrees of latitude (0.0001 ~ 11 m).
    land_tol, park_tol, road_tol = 0.00012 * scale, 0.0001 * scale, 0.0001 * scale
    land = build_land(boroughs, nj, land_tol, min_area=(0.0004 * scale) ** 2)
    park = build_parks(parks, park_tol, min_area=(0.0002 * scale) ** 2)
    roads = build_roads(cl, road_tol)
    road = [f for f in roads if f['properties']['k'] == 'road']
    major = [f for f in roads if f['properties']['k'] == 'major']
    feats = land + park + road + major
    return {'type': 'FeatureCollection', 'bbox': extent(feats), 'attribution': ATTRIBUTION,
            'features': feats}


def coords(c):
    """Every [lon, lat] pair in a nested GeoJSON coordinates array."""
    if isinstance(c[0], (int, float)):
        yield c
    else:
        for x in c:
            yield from coords(x)


def extent(feats):
    """RFC 7946 bbox [w, s, e, n] of all coordinates. Land is clipped LAND_PAD
    wider than the W/S/E/N view box and lines keep one vertex past it, so this
    is a little larger than the box."""
    xs, ys = [], []
    for f in feats:
        for x, y in coords(f['geometry']['coordinates']):
            xs.append(x)
            ys.append(y)
    return [min(xs), min(ys), max(xs), max(ys)]


REQUIRED_LAND = {'Manhattan', 'Brooklyn', 'Queens', 'Hoboken', 'Jersey City'}
REQUIRED_PARKS = {'Central Park', 'Prospect Park', 'Washington Square Park', 'Bryant Park'}


def check(fc):
    """Return a list of problems that mean an upstream source changed or broke.
    The build refuses to write when this is non-empty."""
    feats, bad = fc['features'], []
    by = {}
    for f in feats:
        by.setdefault(f['properties']['k'], []).append(f)
    names = {k: {f['properties'].get('n') for f in v} for k, v in by.items()}
    if [f['properties']['k'] for f in feats] != sorted((f['properties']['k'] for f in feats),
                                                       key=['land', 'park', 'road', 'major'].index):
        bad.append('features are not ordered land, park, road, major')
    if REQUIRED_LAND - names.get('land', set()):
        bad.append(f"land missing {sorted(REQUIRED_LAND - names.get('land', set()))}")
    if any('n' not in f['properties'] for f in by.get('land', [])):
        bad.append('a land feature has no name (n)')
    if REQUIRED_PARKS - names.get('park', set()):
        bad.append(f"parks missing {sorted(REQUIRED_PARKS - names.get('park', set()))}")
    if len(by.get('park', [])) < 50:
        bad.append(f"only {len(by.get('park', []))} parks")
    if len(by.get('road', [])) < 3:
        bad.append(f"only {len(by.get('road', []))} road features (expected one per borough)")
    if len(by.get('major', [])) < 0.9 * len(MAJOR):
        bad.append(f"only {len(by.get('major', []))} of {len(MAJOR)} major roads have geometry")
    n = sum(1 for f in by.get('road', []) for _ in coords(f['geometry']['coordinates']))
    if n < 2000:
        bad.append(f'street layer has only {n} vertices')
    w, s, e, nn = fc['bbox']
    if not (w <= W and s <= S and e >= E - 0.01 and nn >= N - 0.01) or e - w > 0.5 or nn - s > 0.5:
        bad.append(f'extent {fc["bbox"]} does not match the view box')
    return bad


def dumps(fc):
    return json.dumps(fc, separators=(',', ':'), ensure_ascii=False)


def shown(path):
    """Path relative to the project when inside it, else absolute (for messages)."""
    rel = os.path.relpath(os.path.abspath(path), ROOT)
    return os.path.abspath(path) if rel.startswith('..') else rel


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--refresh', action='store_true', help='download sources again')
    ap.add_argument('--max-kb', type=float, default=450, help='size budget (KB, uncompressed)')
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--cache', default=CACHE, help='raw download cache (default research/basemap)')
    a = ap.parse_args()

    try:
        src = load_sources(a.refresh, a.cache)
    except DownloadError as e:
        sys.exit(f'basemap: download failed: {e}\n{shown(a.out)} left unchanged')
    # Coarsen tolerances step by step until the file fits the budget.
    for scale in (1.0, 1.25, 1.5, 2.0, 2.5):
        fc = build(src, scale)
        text = dumps(fc)
        kb = len(text.encode()) / 1024
        print(f'  scale {scale}: {kb:.0f} KB', file=sys.stderr)
        if kb <= a.max_kb:
            break
    else:
        sys.exit(f'basemap is {kb:.0f} KB, over the {a.max_kb} KB budget even at scale {scale}')

    bad = check(fc)
    if bad:
        sys.exit('basemap: output failed sanity checks (an upstream source may have changed):\n  - '
                 + '\n  - '.join(bad) + f'\n{shown(a.out)} left unchanged')
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    write_atomic(a.out, text)
    counts = {}
    for f in fc['features']:
        k = f['properties']['k']
        counts[k] = counts.get(k, 0) + 1
    pts = sum(1 for f in fc['features'] for _ in coords(f['geometry']['coordinates']))
    print(f'wrote {shown(a.out)}: {kb:.0f} KB, features {counts}, {pts} vertices')


if __name__ == '__main__':
    main()
