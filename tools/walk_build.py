#!/usr/bin/env python3
"""Build the offline pedestrian street graph for on-phone walking routes.

Output: app/src/static/data/walk.json. The food map loads it once and runs
every route (shortest walk, distance, time) on the phone, so the person's
location never leaves the device: no routing API, no request carrying
coordinates. The file is generic public NYC geodata only.

Coverage (whole neighbourhoods, nothing trip-specific):
  all of Manhattan (incl. Roosevelt / Randalls Islands);
  Brooklyn north and west of ~40.648 N / -73.925 W (to just below Prospect Park);
  Queens: Long Island City and Astoria (south of 40.785, west of -73.900);
  Staten Island: St George (40.635-40.650 N, -74.085 to -74.070 W).

Sources (public, keyless):
  NYC Open Data inkn-q76z  NYC Street Centerline (CSCL), NYC OTI / DCP.
      Kept: constructed (status 2) streets, at-grade bridges and bridge
      walkways (Brooklyn, Manhattan, Williamsburg, Queensboro, Pulaski,
      Roosevelt Island, RFK, footbridges / pedestrian overpasses), boardwalks,
      paths, step streets and alleys; Route 9A (West St / 11 Ave / 12 Ave)
      at grade south of ~W 59 St. Dropped: vehicle-only segments (nonped V),
      highways (FDR Dr, Harlem River Dr, Henry Hudson Pkwy, BQE, West Side Hwy
      main lanes, every expressway), tunnels, ramps / exits / entrances,
      driveways, U-turns, ferry routes, non-physical (paper) streets, demapped
      streets, bike-only bridge paths, rail bridges and the Central Park
      transverses (sunken roads).
  OpenStreetMap (Overpass API, one query per park box) footways, paths,
      pedestrian ways and steps inside these parks, (c) OpenStreetMap
      contributors, ODbL 1.0: Central Park, High Line, Hudson River Park /
      Greenway, The Battery, Brooklyn Bridge Park, Washington Square, Bryant
      Park, Madison Square, Union Square, Prospect Park, McCarren Park, Domino
      Park, Riverside Park, East River Esplanade. Sidewalks, traffic islands,
      indoor corridors and access=no/private ways are left out, and so are
      crossings except the ones over park drives (Central Park's East / West
      Drive, ...), which link the park's paths across the drive. Inside
      the parks with OSM coverage (all but the two riverside promenades) the
      centerline's own paths and park drives are replaced by the OSM ones.
      Loose OSM path ends are joined to the nearest at-grade street within
      20 m (or another OSM path within 8 m; a loose bridge end tries another
      OSM bridge or path first, so a deck never drops onto the street under
      it), and at-grade OSM paths that cross an at-grade street get a junction
      there, so the result is one graph. Boardwalks count as at grade.
      Duplicates: an OSM bridge way lying on a centerline bridge walkway (the
      Manhattan / Brooklyn Bridge walkways, Squibb Park Bridge) is dropped for
      the centerline one; the centerline High Line (an elevated path, met by
      the street only at its two ends) is dropped for the OSM one, which has
      the stairs and elevators.
      Bridge ends: a bridge end still loose after that is paired with another
      loose bridge end within 5 m (25 m with the same name), joined to a node
      of the main graph within 5 m, or landed on the nearest at-grade way
      within 30 m (60 m with the same name). check() fails on any loose bridge
      end in the main component that is not on the LOOSE_OK list (the far
      side outside the coverage, landings mapped in neither source).
      Pedestrian areas (plazas, area=yes) keep their outline and also get
      straight chords between the outline points where other paths attach,
      when a chord stays inside the area and beats the walk so far by more
      than 20% + 4 m (a sparse spanner), so routes cut across plazas.

Graph: real intersections are nodes; chains of degree-2 nodes with the same
name and flags are merged into one edge carrying shape points (Douglas-Peucker,
3 m). Centerline nodes are keyed by position and grade level (CSCL level
codes), so bridges and overpasses never connect to the streets they cross.
Components smaller than MIN_COMPONENT nodes are dropped; St George and
Governors Island (both reached by ferry only) stay as their own components,
so a router should snap both ends of a walk into the same component.

walk.json (plain JSON, integers only in the arrays):
  {"v": 1, "format": "<this description>", "attribution": "...",
   "bbox": [w, s, e, n], "counts": {"nodes", "edges", "shape"},
   "names": [...], "nodes": [...], "edges": [...], "shape": [...]}

  All coordinates are integers in units of 1e-5 degree, in (lon, lat) order.
  names  names[0] = "path" (unnamed car-free path), names[1] = "steps"
         (unnamed stairs), then street names most used first ("Broadway",
         "W 42nd St", "7th Ave", "Brooklyn Bridge", "High Line"); "" is an
         unnamed street (driveway-like centerline stubs).
  nodes  Flat [x0, y0, x1, y1, ...], delta-encoded: node i is the running sum
         of pairs 0..i (pair 0 is absolute). lon = x / 1e5, lat = y / 1e5.
         Nodes are in Hilbert-curve order, so nearby nodes have nearby indices.
  edges  Flat, stride 6, one record per undirected edge (walkable both ways),
         sorted by a then b:  [da, db, m, name, flags, ns]
           a     = previous record's a + da (the first record: a = da)
           b     = a + db  (so b >= a)
           m     = walking length in whole metres along the full-resolution
                   geometry
           name  = index into names
           flags = bit mask: 1 car-free path (park path, greenway, promenade,
                   park drive, bridge walkway), 2 bridge or footbridge,
                   4 steps / step street
           ns    = number of interior shape points
  shape  Flat [dx, dy, ...], the interior shape points of every edge, in
         edge-record order (edge k's points start at pair sum(ns of edges
         before k)). Each point is a delta from the previous point; the first
         point of an edge is a delta from node a. The polyline is
         node a -> shape points -> node b.

Snapping (the router and check() use the same rule): a point snaps to the
nearest edge without flag 2; a bridge edge wins only when it is within 40 m
and no other edge is within max(40 m, its distance + 25 m), or when it is
within 10 m and no other edge is within its distance + 15 m. So a point on
the street under a bridge snaps to the street, and a point out on the
Brooklyn Bridge, or on the High Line between two cross streets, snaps to the
deck.

Raw downloads live in research/routing/ (gitignored) and are reused; pass
--refresh to download again. A build ends with check(): the largest component
must hold >= 98% of nodes, no excluded highway name may appear, every loose
bridge end must be allowlisted, and the spot-check walks below must fall in
their expected ranges, else exit non-zero.

  python3 -I tools/walk_build.py [--refresh] [--out PATH]   build + check
  python3 -I tools/walk_build.py --check [--out PATH]       check an existing file

Standard library only. HTTPS goes through urllib, falling back to curl when
the local Python has no usable CA bundle.
"""
import argparse
import gzip
import heapq
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'research', 'routing')
OUT = os.path.join(ROOT, 'app', 'src', 'static', 'data', 'walk.json')
SODA = 'https://data.cityofnewyork.us/resource/'
OVERPASS = 'https://overpass-api.de/api/interpreter'
UA = 'nyc-trip-walkgraph/1 (offline pedestrian graph; one query per park)'

ATTRIBUTION = ('Streets: NYC Street Centerline (CSCL), NYC Office of Technology and Innovation / '
               'Dept. of City Planning, via NYC Open Data (inkn-q76z). Park paths: (c) OpenStreetMap '
               'contributors, available under the Open Database License (ODbL 1.0), '
               'openstreetmap.org/copyright.')
FORMAT = ('walk.json v1. Coordinates are integers in 1e-5 degree units, (lon, lat) order. '
          'nodes: flat [x0,y0,x1,y1,...], delta-encoded (node i = running sum of pairs 0..i; pair 0 is '
          'absolute); Hilbert order. edges: flat, stride 6, one record per undirected edge, sorted by a '
          'then b: [da, db, m, name, flags, ns]; a = previous record a + da (first: a = da), b = a + db '
          '(b >= a), m = walking length in whole metres along the full geometry, name = index into names, '
          'flags = 1 car-free path (park path/greenway/promenade/park drive/bridge walkway) | 2 bridge or '
          'footbridge | 4 steps, ns = number of interior shape points. shape: flat [dx,dy,...] interior '
          'shape points of every edge in edge-record order (edge k starts at pair sum of ns before k); each '
          'point is a delta from the previous point, the first from node a; polyline = a -> shape -> b. '
          'names: names[0] is always "path" (unnamed car-free path) and names[1] "steps" (unnamed stairs), '
          'the rest most used first; "" is an unnamed street. Snapping a point: prefer the nearest edge '
          'without flag 2; take a bridge edge only when it is within 40 m and no other edge is within '
          'max(40 m, its distance + 25 m), or within 10 m with no other edge within its distance + 15 m.')

# Local metric frame (equirectangular at 40.73 N; < 0.3% error across the coverage).
LON0, LAT0 = -73.98, 40.73
MX, MY = 84496.0, 111049.0   # metres per degree of longitude / latitude at 40.73 N
QUANT = 1e5                  # output quantum: 1e-5 degree

MIN_COMPONENT = 60    # drop islands smaller than this (nodes, before chain merging)
SNAP_STREET_M = 20.0  # loose OSM path end -> nearest at-grade street within this
SNAP_PATH_M = 8.0     # ... else -> nearest other OSM path within this
PARK_NEAR_M = 15.0    # an OSM path belongs to a park if it touches it or comes this close
BRIDGE_PAIR_M = 5.0   # two loose bridge ends this close are one walkway (any names) ...
BRIDGE_PAIR_NAMED_M = 25.0   # ... or this close when they carry the same name
BRIDGE_LAND_M = 30.0  # a loose bridge end still left lands on the nearest at-grade way this close ...
BRIDGE_LAND_NAMED_M = 60.0   # ... or on one of the same name this close
GENERIC_NAMES = {'path', 'steps', '', 'Pedestrian bridge'}
DUP_BRIDGE_M, DUP_SHARE, DUP_MIN_M = 6.0, 0.8, 100.0   # OSM bridge way on top of a centerline one
END_MERGE_M = 3.0     # a junction this close to an edge end reuses that end node
SPLIT_MERGE_M = 2.0   # two junctions this close on one edge become one
DP_TOL_M = 3.0        # shape simplification
MAX_BYTES = 1_300_000


class DownloadError(Exception):
    pass


_use_curl = False


def fetch(url, dest, data=None):
    """Download url (POST form `data` if given) to dest atomically.
    urllib first, curl when the local Python has no CA bundle."""
    global _use_curl
    tmp = dest + '.part'
    try:
        if not _use_curl:
            try:
                body = urllib.parse.urlencode(data).encode() if data else None
                req = urllib.request.Request(url, data=body, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=300) as r, open(tmp, 'wb') as f:
                    while True:
                        b = r.read(1 << 16)
                        if not b:
                            break
                        f.write(b)
                os.replace(tmp, dest)
                return
            except Exception as e:
                print(f'  urllib failed ({type(e).__name__}); using curl', file=sys.stderr)
                _use_curl = True
        cmd = ['curl', '-sS', '-f', '-L', '-m', '600', '-A', UA, '-o', tmp]
        if data:
            for k, v in data.items():
                cmd += ['--data-urlencode', f'{k}={v}']
        r = subprocess.run(cmd + [url], stderr=subprocess.PIPE, text=True)
        if r.returncode:
            raise DownloadError(f'{urllib.parse.urlsplit(url).netloc}: {r.stderr.strip() or "curl exit " + str(r.returncode)}')
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ---------------------------------------------------------------- coverage
# Generic coverage (whole neighbourhoods/boroughs), as SoQL filters on CSCL.
# Boxes are (west, south, east, north); a segment is kept when it touches its box.
AREAS = [
    ('manhattan', '1', None),                               # all of Manhattan
    ('brooklyn', '3', (-74.03, 40.648, -73.925, 40.741)),   # north + west Brooklyn
    ('queens', '4', (-73.965, 40.735, -73.900, 40.785)),    # Long Island City + Astoria
    ('stgeorge', '5', (-74.085, 40.635, -74.070, 40.650)),  # St George (ferry terminal)
]
CL_FIELDS = ('the_geom,objectid,physicalid,full_street_name,rw_type,status,nonped,boroughcode,'
             'from_level_code,to_level_code,trafdir,bike_lane,shape_length')
CL_FILE = 'centerline_walk.geojson'


def box_wkt(w, s, e, n):
    return f"POLYGON(({w} {s}, {e} {s}, {e} {n}, {w} {n}, {w} {s}))"


def download_centerline(path):
    """All CSCL segments (every roadway type; filtering happens offline) in the
    coverage areas, paged by objectid so a large result never truncates."""
    feats, page = [], 20000
    for name, boro, box in AREAS:
        where = f"boroughcode='{boro}'"
        if box:
            where += f" AND intersects(the_geom, '{box_wkt(*box)}')"
        off = 0
        while True:
            q = urllib.parse.urlencode({'$select': CL_FIELDS, '$where': where, '$order': 'objectid',
                                        '$limit': page, '$offset': off})
            part = path + '.page'
            fetch(f'{SODA}inkn-q76z.geojson?{q}', part)
            with open(part) as f:
                got = json.load(f).get('features')
            os.remove(part)
            if got is None:
                raise DownloadError('centerline: response has no features')
            feats += got
            print(f'    centerline {name}: +{len(got)} (total {len(feats)})', file=sys.stderr)
            if len(got) < page:
                break
            off += page
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f)
    os.replace(tmp, path)


# ---------------------------------------------------------------- OSM park paths
# One Overpass query per park/promenade box (south, west, north, east). A path
# is kept when it touches a leisure=park|garden polygon whose name matches the
# regex (so a box never pulls in footways from the blocks around the park).
# The last field says whether OSM replaces the centerline's own paths and park
# drives inside the park (False for the two long riverside promenades, where
# the centerline greenway is kept as well).
PARKS = [
    ('central', 'Central Park', (40.7635, -73.9825, 40.8010, -73.9485), r'^Central Park$', True),
    ('highline', 'High Line', (40.7385, -74.0100, 40.7550, -73.9995), r'High Line', True),
    ('hudson', 'Hudson River Park', (40.7010, -74.0230, 40.7745, -73.9930),
     r'Hudson River Park|Battery Park City|Rockefeller Park|Wagner|Esplanade|Pier \d|Riverside Park South', False),
    ('battery', 'The Battery', (40.7000, -74.0200, 40.7060, -74.0120), r'Battery', True),
    ('bbp', 'Brooklyn Bridge Park', (40.6890, -74.0040, 40.7060, -73.9880),
     r'Brooklyn Bridge Park|Main Street Park|Empire Fulton', True),
    ('wsp', 'Washington Square Park', (40.7290, -73.9990, 40.7325, -73.9955), r'Washington Square', True),
    ('bryant', 'Bryant Park', (40.7525, -73.9850, 40.7552, -73.9820), r'Bryant Park', True),
    ('madison', 'Madison Square Park', (40.7400, -73.9895, 40.7432, -73.9863), r'Madison Square', True),
    ('union', 'Union Square', (40.7340, -73.9920, 40.7375, -73.9885), r'Union Square', True),
    ('prospect', 'Prospect Park', (40.6490, -73.9800, 40.6735, -73.9580), r'^Prospect Park$', True),
    ('mccarren', 'McCarren Park', (40.7170, -73.9545, 40.7230, -73.9480), r'McCarren', True),
    ('domino', 'Domino Park', (40.7125, -73.9705, 40.7170, -73.9655), r'Domino', True),
    ('riverside', 'Riverside Park', (40.7720, -73.9960, 40.8320, -73.9450), r'Riverside Park', True),
    ('eastriver', 'East River Esplanade', (40.7000, -74.0080, 40.8000, -73.9280),
     r'East River|Esplanade|John Finley|Carl Schurz|Stuyvesant Cove|Andrew Haswell Green|Peter Detmold|'
     r'Pier 35|Pier 36|Corlears Hook', False),
]
OSM_HW = 'footway|path|pedestrian|steps'
OSM_SKIP_FOOTWAY = {'sidewalk', 'crossing', 'traffic_island', 'access_aisle', 'corridor'}


def overpass_query(box):
    s, w, n, e = box
    bb = f'({s},{w},{n},{e})'
    return (f'[out:json][timeout:120];('
            f'way["highway"~"^({OSM_HW})$"]["footway"!="sidewalk"]["access"!~"^(no|private)$"]{bb};'
            f'way["leisure"~"^(park|garden)$"]{bb};'
            f'relation["leisure"~"^(park|garden)$"]{bb};'
            f');out body geom;')


def download_parks(cache, refresh=False):
    """Fetch (or reuse) one Overpass response per park; returns {key: path}."""
    out, first = {}, True
    for key, _label, box, _rx, _drop in PARKS:
        path = os.path.join(cache, f'osm_{key}.json')
        out[key] = path
        if os.path.exists(path) and not refresh:
            continue
        if not first:
            time.sleep(6)  # be polite to the public Overpass server
        first = False
        for attempt in range(4):
            print(f'  overpass: {key}' + (f' (retry {attempt})' if attempt else ''), file=sys.stderr)
            try:
                fetch(OVERPASS, path, data={'data': overpass_query(box)})
                with open(path) as f:
                    doc = json.load(f)
                if 'elements' not in doc or doc.get('remark', '').startswith('runtime error'):
                    os.remove(path)
                    raise DownloadError(f'overpass {key}: incomplete ({doc.get("remark", "")[:200]})')
                break
            except (DownloadError, ValueError) as e:
                if os.path.exists(path):
                    os.remove(path)
                if attempt == 3:
                    raise
                print(f'    {e}; waiting', file=sys.stderr)
                time.sleep(30 * (attempt + 1))  # server busy: back off, then ask again
    return out


def load_sources(cache, refresh):
    os.makedirs(cache, exist_ok=True)
    cl = os.path.join(cache, CL_FILE)
    if refresh or not os.path.exists(cl):
        print('  downloading street centerline', file=sys.stderr)
        download_centerline(cl)
    return cl, download_parks(cache, refresh)


# ---------------------------------------------------------------- geometry helpers
def to_xy(lon, lat):
    return ((lon - LON0) * MX, (lat - LAT0) * MY)


def to_ll(x, y):
    return (x / MX + LON0, y / MY + LAT0)


def plen(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


def sample(pts, step):
    """Points every `step` metres along a polyline (both ends included)."""
    out = [pts[0]]
    carry = 0.0
    for i in range(len(pts) - 1):
        (ax, ay), (bx, by) = pts[i], pts[i + 1]
        L = math.hypot(bx - ax, by - ay)
        d = step - carry
        while d < L:
            out.append((ax + (bx - ax) * d / L, ay + (by - ay) * d / L))
            d += step
        carry = (carry + L) % step
    out.append(pts[-1])
    return out


def proj(px, py, ax, ay, bx, by):
    """Closest point on segment ab to p: (t, qx, qy, d2)."""
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    qx, qy = ax + t * dx, ay + t * dy
    return t, qx, qy, (px - qx) ** 2 + (py - qy) ** 2


def dp(pts, tol):
    """Douglas-Peucker on [(x, y)] metres; iterative, keeps ends."""
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
        best, idx = -1.0, -1
        for k in range(i + 1, j):
            d = proj(pts[k][0], pts[k][1], ax, ay, bx, by)[3]
            if d > best:
                best, idx = d, k
        if best > t2:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(pts, keep) if k]


CELL = 40.0


def cells(x0, y0, x1, y1):
    for i in range(int(math.floor(min(x0, x1) / CELL)), int(math.floor(max(x0, x1) / CELL)) + 1):
        for j in range(int(math.floor(min(y0, y1) / CELL)), int(math.floor(max(y0, y1) / CELL)) + 1):
            yield (i, j)


class Poly:
    """Point-in-polygon (even-odd over every ring of a multipolygon) and
    near-boundary tests in the metric frame, indexed by horizontal bands."""
    H = 50.0

    def __init__(self, segs):
        self.band = defaultdict(list)
        xs = [s[0] for s in segs] + [s[2] for s in segs]
        ys = [s[1] for s in segs] + [s[3] for s in segs]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        for s in segs:
            for b in range(int(math.floor(min(s[1], s[3]) / self.H)), int(math.floor(max(s[1], s[3]) / self.H)) + 1):
                self.band[b].append(s)

    def contains(self, x, y):
        x0, y0, x1, y1 = self.bbox
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            return False
        c = False
        for ax, ay, bx, by in self.band.get(int(math.floor(y / self.H)), ()):
            if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
                c = not c
        return c

    def near(self, x, y, d):
        x0, y0, x1, y1 = self.bbox
        if not (x0 - d <= x <= x1 + d and y0 - d <= y <= y1 + d):
            return False
        for b in range(int(math.floor((y - d) / self.H)), int(math.floor((y + d) / self.H)) + 1):
            for s in self.band.get(b, ()):
                if proj(x, y, *s)[3] <= d * d:
                    return True
        return False

    def touches(self, x, y, d):
        return self.contains(x, y) or self.near(x, y, d)


# ---------------------------------------------------------------- street names
ABBR = {
    'ST': 'St', 'STREET': 'St', 'AVE': 'Ave', 'AV': 'Ave', 'AVENUE': 'Ave', 'BLVD': 'Blvd', 'PL': 'Pl',
    'DR': 'Dr', 'DRV': 'Dr', 'RD': 'Rd', 'PKWY': 'Pkwy', 'TER': 'Ter', 'CT': 'Ct', 'LN': 'Ln', 'SQ': 'Sq',
    'PLZ': 'Plaza', 'ESPL': 'Esplanade', 'CIR': 'Circle', 'ALY': 'Alley', 'BRG': 'Bridge', 'BRDG': 'Bridge',
    'BR': 'Bridge', 'OPAS': 'Overpass', 'HL': 'Hill', 'TRL': 'Trail', 'PRK': 'Park', 'RVR': 'River',
    'UNIV': 'University', 'CTR': 'Center', 'HTS': 'Heights', 'GDNS': 'Gardens', 'PT': 'Point', 'TRML': 'Terminal',
    'PROM': 'Promenade', 'LP': 'Loop', 'CRES': 'Crescent', 'EXT': 'Ext', 'SLP': 'Slip', 'WK': 'Walk',
    'MT': 'Mount', 'FT': 'Fort', 'PED': 'Pedestrian', 'BCH': 'Beach', 'HBR': 'Harbor', 'IS': 'Island',
    'BK': 'Brooklyn', 'TNNL': 'Tunnel', 'HSNG': 'Housing', 'EN': 'Entrance', 'ET': 'Exit', 'OVPS': 'Overpass',
}
ORD_NEXT = {'ST', 'STREET', 'AVE', 'AV', 'AVENUE', 'PL', 'DR', 'RD', 'TER', 'CT', 'LN', 'WALK', 'BLVD',
            'LOOP', 'PLACE', 'ROAD', 'DRIVE', 'TRANSVERSE'}
KEEP_UPPER = {'FDR', 'RFK', 'JFK', 'NYCHA', 'PS', 'IS', 'MS', 'HS', 'LIC', 'US', 'UN', 'NYU', 'CUNY', 'SI',
              'II', 'III', 'IV', 'JJ', 'NB', 'SB', 'EB', 'WB', 'YMCA'}
SMALL = {'OF', 'THE', 'AND', 'AT', 'ON', 'OVER', 'TO', 'IN', 'BY'}
JOINED = {('DE', 'KALB'): 'DeKalb', ('DE', 'GRAW'): 'DeGraw', ('LA', 'GUARDIA'): 'LaGuardia'}
SPELLED_DIR = {'BROADWAY', 'END', 'RIVER', 'LAKE'}  # E Broadway -> East Broadway, W End Ave -> West End Ave
DIRS = {'E': 'East', 'W': 'West', 'N': 'North', 'S': 'South'}
BRIDGE_BASE = {'ED KOCH QUEENSBORO': 'Queensboro', 'ROOSEVELT IS': 'Roosevelt Island', 'UNIV HEIGHTS': 'University Heights'}


def ordinal(s):
    n = int(s)
    suf = 'th' if 10 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
    return f'{n}{suf}'


def cap(t):
    out = '-'.join(p.capitalize() for p in t.split('-'))
    return re.sub(r"\b([OD])'([a-z])", lambda m: m.group(1) + "'" + m.group(2).upper(), out)


def fmt_tokens(toks):
    if len(toks) > 1 and toks[0] in DIRS and toks[1] in SPELLED_DIR:
        toks = [DIRS[toks[0]].upper()] + toks[1:]
    out, i = [], 0
    while i < len(toks):
        t, nxt = toks[i], toks[i + 1] if i + 1 < len(toks) else None
        if t in ('MC', 'MAC') and nxt and nxt.isalpha() and nxt not in ABBR:
            out.append(t.capitalize() + nxt.capitalize())
            i += 2
            continue
        if (t, nxt) in JOINED:
            out.append(JOINED[(t, nxt)])
            i += 2
            continue
        if t.isdigit() and nxt in ORD_NEXT:
            out.append(ordinal(t))
        elif t in KEEP_UPPER:
            out.append(t)
        elif t in ABBR and not (t == 'ST' and i == 0 and nxt):   # leading ST = Saint
            out.append(ABBR[t])
        elif t in SMALL and out:
            out.append(t.lower())
        elif len(t) == 1 or t.isdigit():
            out.append(t)
        else:
            out.append(cap(t))
        i += 1
    return ' '.join(out)


def fmt_cscl(n, rw):
    """Readable street name from a CSCL full_street_name (whitespace-collapsed)."""
    if n == 'AVE OF THE AMERICAS':
        return '6th Ave'
    m = re.match(r'^AVE ([A-Z])$', n)
    if m:
        return 'Avenue ' + m.group(1)
    m = re.match(r'^(.*?) (BRIDGE|BRDG|BRG|BR)\b(.*)$', n)
    if m and re.search(r'\b(PED|PEDESTRIAN)\b', m.group(3)) and not re.search(r'OPAS|OVPS', m.group(3)):
        base = m.group(1)
        return (BRIDGE_BASE.get(base) or fmt_tokens(base.split())) + ' Bridge'
    m = re.match(r'^(.*?) ?\b(PED|PEDESTRIAN) (BR|BRG|BRIDGE|OPAS|OVPS)\b', n)
    if m:
        base = m.group(1).strip()
        return (fmt_tokens(base.split()) + ' Pedestrian Bridge') if base else 'Pedestrian bridge'
    if n == 'E RIVER ESPL':
        return 'East River Esplanade'
    if re.search(r'\b(PATH|TRL|TRAIL|PATH LINK)$', n) and not re.search(r'GREENWAY|ESPL|PROMENADE', n):
        return 'path'
    if not n or n.startswith('UNNAMED'):
        return 'path' if rw in ('5', '6') else ''
    return fmt_tokens(n.split())


# ---------------------------------------------------------------- centerline filter
KEEP_RW = {'1', '3', '5', '6', '7', '10'}   # street, bridge, boardwalk, path, step street, alley
ROUTE_9A = {'WEST ST', '11 AVE', '12 AVE'}   # rw_type 2 but an at-grade boulevard with sidewalks
ROUTE_9A_MAX_LAT = 40.773                    # ~W 59 St
PATHLIKE = re.compile(r'\bPED\b|PEDESTRIAN|FOOTBRIDGE|GREENWAY|\bPATH\b|\bESPL\b|\bOPAS\b|\bOVPS\b|\bWALK\b')
PEDNAME = re.compile(r'\bPED\b|PEDESTRIAN|FOOTBRIDGE|\bOPAS\b|\bOVPS\b')
# Bike lanes of bridges that have a separate walkway (Manhattan, Williamsburg, Queensboro,
# Pulaski, Brooklyn Bridge roadway lane, ...). Other bike paths are shared-use paths and stay.
BIKE_ONLY = re.compile(r'\b(BRIDGE|BRDG|BRG|BR)\b.*\b(BIKE|BICYCLE)\b')
HIGHWAY = re.compile(
    r'^(FRANKLIN D ROOSEVELT|FDR) (DR|DRIVE|DRV)\b|^HARLEM RIVER (DR|DRIVE|DY)\b|HENRY HUDSON|'
    r'BROOKLYN QUEENS EXPY|\bBQE\b|\bEXPY\b|\bEXPWY\b|EXPRESSWAY|\bHWY\b|HIGHWAY|'
    r'\b(BELT|JACKIE ROBINSON|GRAND CENTRAL|BRONX RIVER|HUTCHINSON RIVER|CROSS ISLAND) PKWY|'
    r'VERRAZ|KOSCIUSZKO|GOETHALS|BAYONNE|VIADUCT|UNDERPASS|TUNNEL|TRANSVERSE|AMTRAK|HELL GATE')
RAMP = re.compile(r'\b(EXIT|ENTRANCE|EN|ET|RP|RAMP|APPR|APPROACH)\b')
PARK_DRIVE = re.compile(r'^(CENTRAL|PROSPECT) PARK ')


def cscl_excluded(n):
    if re.search(r'AMTRAK|HELL GATE', n):
        return True
    if BIKE_ONLY.search(n) and not re.search(r'\bPED\b|PEDESTRIAN', n):
        return True                      # bike-only bridge lanes
    if PATHLIKE.search(n):
        return False                     # FDR Drive Greenway, Holland Tunnel Exit Ped Opas, ...
    if HIGHWAY.search(n):
        return True
    return bool(RAMP.search(n)) and not PARK_DRIVE.search(n)


def lvl(v):
    return '13' if v in (None, '', '99') else v


def clean(n):
    return re.sub(r'\s+', ' ', (n or '').strip().upper())


def load_cscl(path):
    with open(path) as f:
        feats = json.load(f)['features']
    out, why = [], Counter()
    for ft in feats:
        p = ft['properties']
        geom = ft.get('geometry') or {}
        parts = geom.get('coordinates') or []
        coords = []
        for part in parts:            # multi-part segments are contiguous: concatenate
            for c in part:
                if not coords or coords[-1] != c:
                    coords.append(c)
        if len(coords) < 2:
            why['no geometry'] += 1
            continue
        n, rw = clean(p.get('full_street_name')), p.get('rw_type')
        if p.get('status') != '2':
            why['not constructed'] += 1
            continue
        if p.get('nonped') == 'V':
            why['vehicle only'] += 1
            continue
        if rw == '2':
            if not (n in ROUTE_9A and max(c[1] for c in coords) < ROUTE_9A_MAX_LAT):
                why['highway'] += 1
                continue
        elif rw not in KEEP_RW:
            why[f'rw_type {rw}'] += 1
            continue
        elif cscl_excluded(n):
            why['excluded name'] += 1
            continue
        out.append({'n': n, 'rw': rw, 'np': p.get('nonped'), 'lf': lvl(p.get('from_level_code')),
                    'lt': lvl(p.get('to_level_code')), 'pts': [to_xy(c[0], c[1]) for c in coords],
                    'll': (coords[0], coords[-1])})
    print(f'  centerline: {len(feats)} segments, kept {len(out)}; dropped {dict(why)}', file=sys.stderr)
    return out


def drop_in_osm_park(s):
    """Centerline paths / park drives that the OSM park network replaces."""
    n = s['n']
    if PEDNAME.search(n) or s['lf'] != '13' or s['lt'] != '13':
        return False                     # bridge walkways passing over a park stay
    if s['rw'] in ('5', '6', '7') or s['np'] == 'D':
        return True
    return bool(re.search(r'\bPARK\b.*\b(PATH|BRIDGE|BRG)\b', n))


# ---------------------------------------------------------------- OSM loading
def poly_segs(el):
    segs = []
    rings = [el['geometry']] if el['type'] == 'way' else [m.get('geometry') or [] for m in el.get('members', [])
                                                           if m.get('type') == 'way']
    for g in rings:
        pts = [to_xy(q['lon'], q['lat']) for q in g if q]
        segs += [(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) for i in range(len(pts) - 1)]
    return segs


def osm_keep(t):
    if t.get('highway') not in ('footway', 'path', 'pedestrian', 'steps'):
        return False
    if t.get('footway') in OSM_SKIP_FOOTWAY or t.get('indoor') in ('yes', 'corridor', 'room'):
        return False
    if t.get('access') in ('no', 'private') or t.get('foot') in ('no', 'private'):
        return False
    return not (t.get('construction') or t.get('disused') or t.get('abandoned'))


AT_GRADE_BRIDGE = (None, 'no', 'boardwalk')   # a boardwalk sits on the ground, not over a street


def osm_at_grade(t):
    return (t.get('bridge') in AT_GRADE_BRIDGE and t.get('tunnel') in (None, 'no', 'building_passage')
            and t.get('layer') in (None, '0') and t.get('level') in (None, '0')
            and t.get('highway') != 'steps' and t.get('covered') in (None, 'no'))


def load_osm(paths):
    """Kept OSM ways {id: (tags, node ids, [(x, y)])} and the polygons of the
    parks whose centerline paths they replace."""
    ways, drop_polys, parks = {}, [], []
    for key, label, _box, rx, drop in PARKS:
        with open(paths[key]) as f:
            els = json.load(f)['elements']
        name_rx = re.compile(rx)
        polys = []
        for el in els:
            t = el.get('tags') or {}
            if t.get('leisure') in ('park', 'garden') and name_rx.search(t.get('name') or ''):
                segs = poly_segs(el)
                if segs:
                    polys.append(Poly(segs))
        if not polys:
            raise SystemExit(f'error: no park polygon for {label} in osm_{key}.json')
        if drop:
            drop_polys += polys
        n0 = len(ways)
        for el in els:
            if el['type'] != 'way' or el['id'] in ways or not osm_keep(el.get('tags') or {}):
                continue
            pts = osm_pts(el)
            if pts and any(pg.touches(x, y, PARK_NEAR_M) for x, y in pts for pg in polys):
                ways[el['id']] = (el['tags'], el['nodes'], pts)
        parks.append((els, polys))
        print(f'  osm {key}: {len(polys)} park polygon(s), +{len(ways) - n0} paths', file=sys.stderr)
    # Marked crossings are left out with the sidewalks, except the ones that tie two kept
    # park paths together across a park drive (Central Park's drives are not in the graph,
    # so without them a path on one side of East Drive would not reach the other side).
    kept = {n for _t, nodes, _p in ways.values() for n in nodes}
    nx = 0
    for els, polys in parks:
        for el in els:
            t = el.get('tags') or {}
            if el['type'] != 'way' or el['id'] in ways or t.get('footway') != 'crossing':
                continue
            if not osm_keep(dict(t, footway='')) or len({n for n in el['nodes'] if n in kept}) < 2:
                continue
            pts = osm_pts(el)
            if pts and any(pg.touches(x, y, PARK_NEAR_M) for x, y in pts for pg in polys):
                ways[el['id']] = (t, el['nodes'], pts)
                nx += 1
    print(f'  osm: +{nx} park-drive crossings', file=sys.stderr)
    return ways, drop_polys


def osm_pts(el):
    pts = [to_xy(q['lon'], q['lat']) for q in el.get('geometry') or []]
    return pts if len(pts) >= 2 and len(pts) == len(el['nodes']) else None


# ---------------------------------------------------------------- graph build
class Graph:
    def __init__(self):
        self.key = {}
        self.xy = []
        self.pri = []       # 0 centerline node, 1 OSM node, 2 synthetic junction
        self.parent = []
        self.E = []         # [u, v, pts, name, flags, kind, grade]

    def node(self, key, x, y, pri):
        i = self.key.get(key)
        if i is None:
            i = self.key[key] = len(self.xy)
            self.xy.append((x, y))
            self.pri.append(pri)
            self.parent.append(i)
        return i

    def new(self, x, y):
        self.xy.append((x, y))
        self.pri.append(2)
        self.parent.append(len(self.parent))
        return len(self.xy) - 1

    def find(self, i):
        p = self.parent
        while p[i] != i:
            p[i] = p[p[i]]
            i = p[i]
        return i

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a == b:
            return
        if (self.pri[b], b) < (self.pri[a], a):
            a, b = b, a
        self.parent[b] = a


def osm_name(t):
    n = (t.get('name') or '').strip()
    return n or ('steps' if t.get('highway') == 'steps' else 'path')


def osm_flags(t):
    return 1 | (2 if t.get('bridge') not in AT_GRADE_BRIDGE else 0) | (4 if t.get('highway') == 'steps' else 0)


def is_area(t, nodes):
    return t.get('area') == 'yes' and len(nodes) > 3 and nodes[0] == nodes[-1]


def inside_ring(x, y, ring):
    c = False
    for i in range(len(ring) - 1):
        (ax, ay), (bx, by) = ring[i], ring[i + 1]
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            c = not c
    return c


def chord_inside(p, q, ring, ip, iq):
    """Segment ring[ip]-ring[iq] stays inside the closed ring (no proper crossing of
    a ring edge, sample points inside)."""
    (px, py), (qx, qy) = p, q
    rx, ry = qx - px, qy - py
    n = len(ring) - 1
    for i in range(n):
        if i in (ip, iq) or (i + 1) % n in (ip, iq):
            continue
        (ax, ay), (bx, by) = ring[i], ring[i + 1]
        sx, sy = bx - ax, by - ay
        den = rx * sy - ry * sx
        if abs(den) < 1e-9:
            continue
        t = ((ax - px) * sy - (ay - py) * sx) / den
        u = ((ax - px) * ry - (ay - py) * rx) / den
        if 1e-6 < t < 1 - 1e-6 and -1e-6 <= u <= 1 + 1e-6:
            return False
    return all(inside_ring(px + f * rx, py + f * ry, ring) for f in (0.25, 0.5, 0.75))


def area_chords(nodes, pts, wuse, stretch=1.2, slack=4.0):
    """A pedestrian area (plaza) is walkable straight across, not just around its
    outline. Between the outline vertices where other paths attach, add straight
    chords that stay inside the area, greedily (shortest first) and only where the
    walk so far is more than stretch x the chord + slack: a sparse spanner."""
    ring = pts
    n = len(ring) - 1
    idx = sorted({i for i in range(n) if wuse[nodes[i]] > 1})
    if len(idx) < 2:
        return []
    cum = [0.0]
    for i in range(n):
        cum.append(cum[-1] + math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]))
    per = cum[-1]
    k = len(idx)
    adj = [[] for _ in range(k)]
    for a in range(k):
        b = (a + 1) % k
        d = (cum[idx[b]] - cum[idx[a]]) % per if k > 1 else 0.0
        adj[a].append((b, d))
        adj[b].append((a, d))
    cand = []
    for a in range(k):
        for b in range(a + 1, k):
            L = math.hypot(ring[idx[b]][0] - ring[idx[a]][0], ring[idx[b]][1] - ring[idx[a]][1])
            cand.append((L, a, b))
    cand.sort()
    out = []
    for L, a, b in cand:
        lim = stretch * L + slack
        dist, pq = {a: 0.0}, [(0.0, a)]
        while pq:
            d, x = heapq.heappop(pq)
            if x == b or d > lim:
                break
            if d > dist[x]:
                continue
            for y, w in adj[x]:
                nd = d + w
                if nd < dist.get(y, 1e18):
                    dist[y] = nd
                    heapq.heappush(pq, (nd, y))
        if dist.get(b, 1e18) <= lim or not chord_inside(ring[idx[a]], ring[idx[b]], ring, idx[a], idx[b]):
            continue
        adj[a].append((b, L))
        adj[b].append((a, L))
        out.append((idx[a], idx[b]))
    return out


def elevated_osm_copies(cscl, ways):
    """Indexes of elevated centerline walkways (not bridges) that OSM maps as a bridge on the
    same line. The High Line is in both; the OSM copy carries the stairs and elevators, the
    centerline copy only meets the street at its two ends, so a snap onto it routes the long
    way round. Decided per run of same-named connected segments, so a ramp the OSM line
    leaves a few metres early goes with the rest."""
    og = defaultdict(list)
    for t, nodes, pts in ways.values():
        if osm_flags(t) & 2:
            for i in range(len(pts) - 1):
                (ax, ay), (bx, by) = pts[i], pts[i + 1]
                for c in cells(ax, ay, bx, by):
                    og[c].append((ax, ay, bx, by))
    M = DUP_BRIDGE_M

    def covered(x, y):
        return any(proj(x, y, *sg)[3] <= M * M for c in cells(x - M, y - M, x + M, y + M) for sg in og.get(c, ()))

    idx = [i for i, s in enumerate(cscl)
           if s['rw'] in ('5', '6') and not (s['lf'] == '13' and s['lt'] == '13')]
    parent = {i: i for i in idx}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    at = defaultdict(list)
    for i in idx:
        for lon, lat in cscl[i]['ll']:
            at[(cscl[i]['n'], round(lon * 1e6), round(lat * 1e6))].append(i)
    for lst in at.values():
        for j in lst[1:]:
            parent[find(j)] = find(lst[0])
    tot, cov = Counter(), Counter()
    for i in idx:
        smp = sample(cscl[i]['pts'], 10.0)
        L = plen(cscl[i]['pts'])
        tot[find(i)] += L
        cov[find(i)] += L * sum(covered(x, y) for x, y in smp) / len(smp)
    out = set()
    for r in tot:
        if tot[r] > DUP_MIN_M and cov[r] >= DUP_SHARE * tot[r]:
            grp = [i for i in idx if find(i) == r]
            out.update(grp)
            print(f"  centerline {cscl[r]['n']!r} ({tot[r]:.0f} m, {len(grp)} segments) is an OSM bridge "
                  f"walkway too: dropped for the OSM copy", file=sys.stderr)
    return out


def build_graph(cscl, ways, drop_polys):
    g = Graph()
    dropped = 0
    elev_dup = elevated_osm_copies(cscl, ways)
    cscl = [s for i, s in enumerate(cscl) if i not in elev_dup]
    ends = defaultdict(list)   # (lon, lat) -> [(level, name, node)]
    for s in cscl:
        pts = s['pts']
        if drop_polys:
            mid = pts[len(pts) // 2] if len(pts) > 2 else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
            if drop_in_osm_park(s) and any(pg.contains(*mid) for pg in drop_polys):
                dropped += 1
                continue
        (lon0, lat0), (lon1, lat1) = s['ll']
        u = g.node(('c', round(lon0 * 1e6), round(lat0 * 1e6), s['lf']), *pts[0], 0)
        v = g.node(('c', round(lon1 * 1e6), round(lat1 * 1e6), s['lt']), *pts[-1], 0)
        ends[(round(lon0 * 1e6), round(lat0 * 1e6))].append((s['lf'], s['n'], u))
        ends[(round(lon1 * 1e6), round(lat1 * 1e6))].append((s['lt'], s['n'], v))
        fl = (1 if s['rw'] in ('5', '6') or s['np'] == 'D' or PEDNAME.search(s['n']) else 0) \
            | (2 if s['rw'] == '3' else 0) | (4 if s['rw'] == '7' else 0)
        grade = s['lf'] == '13' and s['lt'] == '13' and s['rw'] != '3'
        g.E.append([u, v, pts, fmt_cscl(s['n'], s['rw']), fl, 'c', grade])
    print(f'  centerline paths/drives replaced by OSM park paths: {dropped}', file=sys.stderr)
    # CSCL is planar: a node where two levels meet is normally an overpass, not a junction.
    # But a few walkways change level code at a node instead of inside a segment (Robert R
    # Douglass and Greenwood Ave overpasses, Victory Blvd footbridge, ...). Join the levels at
    # a node only where the same street continues and one side would otherwise dead-end.
    nlev = 0
    for pt, lst in ends.items():
        by = defaultdict(list)
        for lv, nm, nid in lst:
            by[lv].append((nm, nid))
        if len(by) < 2:
            continue
        lv_list = sorted(by)
        for i, l1 in enumerate(lv_list):
            for l2 in lv_list[i + 1:]:
                if (len(by[l1]) == 1 or len(by[l2]) == 1) and \
                        {nm for nm, _ in by[l1]} & {nm for nm, _ in by[l2]}:
                    g.union(by[l1][0][1], by[l2][0][1])
                    nlev += 1
    print(f'  same-street level changes joined at nodes: {nlev}', file=sys.stderr)
    n_cscl = len(g.E)

    # An OSM bridge walkway that runs on top of a centerline bridge walkway is the same
    # path twice (the Manhattan Bridge north walkway is in both): keep the centerline one.
    bgrid = defaultdict(list)
    for e in g.E:
        if e[4] & 2:
            for i in range(len(e[2]) - 1):
                (ax, ay), (bx, by) = e[2][i], e[2][i + 1]
                for c in cells(ax, ay, bx, by):
                    bgrid[c].append((ax, ay, bx, by))

    def on_cscl_bridge(x, y):
        return any(proj(x, y, *sg)[3] <= DUP_BRIDGE_M ** 2
                   for c in cells(x - DUP_BRIDGE_M, y - DUP_BRIDGE_M, x + DUP_BRIDGE_M, y + DUP_BRIDGE_M)
                   for sg in bgrid.get(c, ()))

    dup = []
    for wid, (t, nodes, pts) in ways.items():
        if osm_flags(t) & 2 and plen(pts) > DUP_MIN_M:
            smp = sample(pts, 10.0)
            if sum(on_cscl_bridge(x, y) for x, y in smp) >= DUP_SHARE * len(smp):
                dup.append(wid)
    for wid in dup:
        t = ways.pop(wid)[0]
        print(f'  OSM way {wid} ({osm_name(t)}) duplicates a centerline bridge walkway: dropped', file=sys.stderr)

    use, wuse = Counter(), Counter()
    for t, nodes, pts in ways.values():
        use.update(nodes)
        wuse.update(set(nodes))
    nchord = 0
    for wid, (t, nodes, pts) in ways.items():
        if is_area(t, nodes):
            for i, j in area_chords(nodes, pts, wuse):
                u = g.node(('o', nodes[i]), *pts[i], 1)
                v = g.node(('o', nodes[j]), *pts[j], 1)
                g.E.append([u, v, [pts[i], pts[j]], osm_name(t), osm_flags(t), 'o', osm_at_grade(t)])
                nchord += 1
        name, fl, grade = osm_name(t), osm_flags(t), osm_at_grade(t)
        start = 0
        for k in range(1, len(nodes)):
            if k == len(nodes) - 1 or use[nodes[k]] > 1:
                seg = pts[start:k + 1]
                if nodes[start] != nodes[k] or len(seg) > 3:
                    u = g.node(('o', nodes[start]), *pts[start], 1)
                    v = g.node(('o', nodes[k]), *pts[k], 1)
                    g.E.append([u, v, seg, name, fl, 'o', grade])
                start = k
    print(f'  base edges: {n_cscl} centerline, {len(g.E) - n_cscl} OSM ({nchord} straight across plazas)',
          file=sys.stderr)

    # spatial index of centerline segments that OSM paths may cross / join at grade
    sgrid = defaultdict(list)
    ogrid = defaultdict(list)
    for eid, e in enumerate(g.E):
        if e[5] == 'c' and not e[6]:
            continue
        grid = sgrid if e[5] == 'c' else ogrid
        pts = e[2]
        for i in range(len(pts) - 1):
            for c in cells(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]):
                grid[c].append((eid, i))

    splits = defaultdict(list)   # eid -> [(seg index, t, node)]

    # at-grade crossings: OSM path x at-grade centerline
    ncross = 0
    for eid, e in enumerate(g.E):
        if e[5] != 'o' or not e[6]:
            continue
        pts, seen = e[2], []
        for i in range(len(pts) - 1):
            (px, py), (qx, qy) = pts[i], pts[i + 1]
            rx, ry = qx - px, qy - py
            cand = set()
            for c in cells(px, py, qx, qy):
                cand.update(sgrid.get(c, ()))
            for ceid, j in cand:
                (ax, ay), (bx, by) = g.E[ceid][2][j], g.E[ceid][2][j + 1]
                sx, sy = bx - ax, by - ay
                den = rx * sy - ry * sx
                if abs(den) < 1e-9:
                    continue
                t = ((ax - px) * sy - (ay - py) * sx) / den
                u = ((ax - px) * ry - (ay - py) * rx) / den
                if 0 <= t <= 1 and 0 <= u <= 1:
                    x, y = px + t * rx, py + t * ry
                    if any(c2 == ceid and math.hypot(x - x2, y - y2) < SPLIT_MERGE_M for c2, x2, y2 in seen):
                        continue
                    seen.append((ceid, x, y))
                    nid = g.new(x, y)
                    splits[eid].append((i, t, nid))
                    splits[ceid].append((j, u, nid))
                    ncross += 1

    # loose OSM path ends -> nearest at-grade street (20 m), else another OSM path (8 m)
    deg = Counter()
    inc = defaultdict(list)
    for eid, e in enumerate(g.E):
        if e[5] == 'o':
            deg[e[0]] += 1
            deg[e[1]] += 1
            inc[e[0]].append(eid)
            inc[e[1]].append(eid)
    conn = []
    nsnap = Counter()
    for nid, d in deg.items():
        if d != 1:
            continue
        x, y = g.xy[nid]
        own = inc[nid][0]
        hit = None
        # An elevated OSM end (High Line, a footbridge) belongs to the deck or stairs next to
        # it, not to the street underneath: try other elevated paths / steps first, then any
        # path, and only then the street.
        if g.E[own][4] & 2:
            order = ((ogrid, SNAP_PATH_M, 6, 'bridge'), (ogrid, SNAP_PATH_M, 0, 'path'),
                     (sgrid, SNAP_STREET_M, 0, 'street'))
        else:
            order = ((sgrid, SNAP_STREET_M, 0, 'street'), (ogrid, SNAP_PATH_M, 0, 'path'))
        for grid, r, need, label in order:
            best = None
            for c in cells(x - r, y - r, x + r, y + r):
                for ceid, j in grid.get(c, ()):
                    if ceid == own or (need and not g.E[ceid][4] & need):
                        continue
                    (ax, ay), (bx, by) = g.E[ceid][2][j], g.E[ceid][2][j + 1]
                    t, qx, qy, d2 = proj(x, y, ax, ay, bx, by)
                    if d2 <= r * r and (best is None or d2 < best[0]):
                        best = (d2, ceid, j, t, qx, qy)
            if best:
                hit = best
                nsnap[label] += 1
                break
        if not hit:
            nsnap['none'] += 1
            continue
        d2, ceid, j, t, qx, qy = hit
        sid = g.new(qx, qy)
        splits[ceid].append((j, t, sid))
        if d2 < 1.5 ** 2:
            g.union(sid, nid)
        else:
            e = g.E[own]
            conn.append([nid, sid, [(x, y), (qx, qy)], e[3], e[4], 'x', False])
    print(f'  junctions: {ncross} at-grade crossings; loose path ends joined {dict(nsnap)}', file=sys.stderr)

    final = apply_splits(g, [list(e[:7]) for e in g.E], splits)
    final += conn
    final = bridge_ends(g, final)

    edges = []
    for u, v, pts, name, fl, _kind, _grade in final:
        u, v = g.find(u), g.find(v)
        if u == v:
            continue
        pts = [g.xy[u]] + [p for p in pts[1:-1]] + [g.xy[v]]
        clean_pts = [pts[0]]
        for p in pts[1:]:
            if math.hypot(p[0] - clean_pts[-1][0], p[1] - clean_pts[-1][1]) > 0.01:
                clean_pts.append(p)
        if len(clean_pts) < 2:
            clean_pts = [pts[0], pts[-1]]
        edges.append((u, v, clean_pts, name, fl, plen(clean_pts)))
    return g, edges


def apply_splits(g, E, splits):
    """Cut edges [u, v, pts, name, flags, kind, grade] at their junctions
    {edge index: [(segment index, t, node)]}; junctions near an end or near each
    other become one node."""
    final = []
    for eid, e in enumerate(E):
        u, v, pts = e[0], e[1], e[2]
        sp = splits.get(eid)
        if not sp:
            final.append(e)
            continue
        cum = [0.0]
        for i in range(len(pts) - 1):
            cum.append(cum[-1] + math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]))
        L = cum[-1]
        cuts = []
        for i, t, nid in sorted(sp, key=lambda s: cum[s[0]] + s[1] * (cum[s[0] + 1] - cum[s[0]])):
            d = cum[i] + t * (cum[i + 1] - cum[i])
            if d < END_MERGE_M:
                g.union(nid, u)
            elif d > L - END_MERGE_M:
                g.union(nid, v)
            elif cuts and d - cuts[-1][0] < SPLIT_MERGE_M:
                g.union(nid, cuts[-1][3])
            else:
                cuts.append((d, i, t, nid))
        piece, k, a = [pts[0]], 0, u
        for d, i, t, nid in cuts:
            piece += pts[k + 1:i + 1]
            p = (pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1]))
            piece.append(p)
            final.append([a, nid, piece] + e[3:])
            piece, k, a = [p], i, nid
        piece += pts[k + 1:]
        final.append([a, v, piece] + e[3:])
    return final


def bridge_ends(g, E):
    """Bridges and footbridges that still end in mid-air. CSCL keys a bridge's
    nodes by grade level, so where a walkway lands on a street of another name
    (the Queensboro path on Queens Plaza, the East River footbridges on York /
    the esplanade, swing-bridge spans) nothing joins them. Two loose bridge ends
    within 5 m (or 25 m with the same name) are one walkway; a loose end within
    5 m of another way's end node is the same point under another level code;
    any other loose end lands on the nearest at-grade way within 30 m (60 m when
    it carries the same name). Ends further out stay loose (the far side of a
    bridge out of the coverage, a deck over a highway with no stairs nearby).
    Every join is printed."""
    deg, inc = Counter(), defaultdict(list)
    for k, e in enumerate(E):
        u, v = g.find(e[0]), g.find(e[1])
        if u == v:
            continue
        for n in (u, v):
            deg[n] += 1
            inc[n].append(k)
    loose = sorted((n, inc[n][0]) for n, d in deg.items() if d == 1 and E[inc[n][0]][4] & 2)
    add, splits, used = [], defaultdict(list), set()
    pairs = []
    for i, (n1, k1) in enumerate(loose):
        x1, y1 = g.xy[n1]
        for n2, k2 in loose[i + 1:]:
            if k1 == k2:
                continue
            d = math.hypot(g.xy[n2][0] - x1, g.xy[n2][1] - y1)
            if d <= BRIDGE_PAIR_M or (d <= BRIDGE_PAIR_NAMED_M and E[k1][3] == E[k2][3]
                                      and E[k1][3] not in GENERIC_NAMES):
                pairs.append((d, n1, k1, n2, k2))
    for d, n1, k1, n2, k2 in sorted(pairs):
        if n1 in used or n2 in used:
            continue
        used |= {n1, n2}
        if d < 1.5:
            g.union(n1, n2)
        else:
            add.append([n1, n2, [g.xy[n1], g.xy[n2]], E[k1][3], E[k1][4], 'x', False])
        print(f'    bridge ends paired: {E[k1][3]!r} + {E[k2][3]!r} at {to_ll(*g.xy[n1])[1]:.5f},'
              f'{to_ll(*g.xy[n1])[0]:.5f} ({d:.1f} m)', file=sys.stderr)
    # Only land on the network proper, never on an island (an unconnected plaza outline).
    parent = {}

    def root(i):
        parent.setdefault(i, i)
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in E:
        a, b = root(g.find(e[0])), root(g.find(e[1]))
        if a != b:
            parent[b] = a
    size = Counter(root(n) for n in list(parent))
    big = lambda n: size[root(g.find(n))] >= MIN_COMPONENT
    # a loose end on top of another way's end node: the same point under another level code
    # (W 72 St meeting Riverside Blvd on its platform, an overpass meeting park paths)
    ngrid = defaultdict(set)
    for e in E:
        for n in (g.find(e[0]), g.find(e[1])):
            if big(n):
                ngrid[(int(g.xy[n][0] // CELL), int(g.xy[n][1] // CELL))].add(n)
    for n, own in loose:
        if n in used:
            continue
        x, y = g.xy[n]
        far = {g.find(E[own][0]), g.find(E[own][1])}
        best = None
        for c in cells(x - BRIDGE_PAIR_M, y - BRIDGE_PAIR_M, x + BRIDGE_PAIR_M, y + BRIDGE_PAIR_M):
            for m in ngrid.get(c, ()):
                if m in far or g.find(m) in far:
                    continue
                d = math.hypot(g.xy[m][0] - x, g.xy[m][1] - y)
                if d <= BRIDGE_PAIR_M and (best is None or d < best[0]):
                    best = (d, m)
        if best:
            used.add(n)
            d, m = best
            if d < 1.5:
                g.union(n, m)
            else:
                add.append([n, m, [g.xy[n], g.xy[m]], E[own][3], E[own][4], 'x', False])
            print(f'    bridge end joined to a node: {E[own][3]!r} at {to_ll(x, y)[1]:.5f},{to_ll(x, y)[0]:.5f} '
                  f'({d:.1f} m)', file=sys.stderr)
    grid = defaultdict(list)
    for k, e in enumerate(E):
        if e[6] and big(e[0]):
            for i in range(len(e[2]) - 1):
                for c in cells(e[2][i][0], e[2][i][1], e[2][i + 1][0], e[2][i + 1][1]):
                    grid[c].append((k, i))
    r = BRIDGE_LAND_NAMED_M
    for n, own in loose:
        if n in used:
            continue
        x, y = g.xy[n]
        nm, best = E[own][3], None
        for c in cells(x - r, y - r, x + r, y + r):
            for k, i in grid.get(c, ()):
                if k == own:
                    continue
                t, qx, qy, d2 = proj(x, y, *E[k][2][i], *E[k][2][i + 1])
                lim = BRIDGE_LAND_NAMED_M if E[k][3] == nm and nm not in GENERIC_NAMES else BRIDGE_LAND_M
                if d2 <= lim * lim and (best is None or d2 < best[0]):
                    best = (d2, k, i, t, qx, qy)
        lat, lon = to_ll(x, y)[1], to_ll(x, y)[0]
        if not best:
            print(f'    bridge end left loose: {E[own][3]!r} at {lat:.5f},{lon:.5f}', file=sys.stderr)
            continue
        d2, k, i, t, qx, qy = best
        sid = g.new(qx, qy)
        splits[k].append((i, t, sid))
        if d2 < 1.5 ** 2:
            g.union(sid, n)
        else:
            add.append([n, sid, [(x, y), (qx, qy)], E[own][3], E[own][4], 'x', False])
        print(f'    bridge end landed: {E[own][3]!r} at {lat:.5f},{lon:.5f} -> {E[k][3]!r} '
              f'({math.sqrt(d2):.1f} m)', file=sys.stderr)
    return apply_splits(g, E, splits) + add


def components(n_of, edges):
    parent = {}

    def find(i):
        parent.setdefault(i, i)
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in edges:
        a, b = find(e[0]), find(e[1])
        if a != b:
            parent[b] = a
    comp = defaultdict(int)
    for i in list(parent):
        comp[find(i)] += 1
    return find, comp


def merge_chains(edges):
    """Merge degree-2 nodes whose two edges share name and flags."""
    inc = defaultdict(list)
    for k, e in enumerate(edges):
        inc[e[0]].append(k)
        inc[e[1]].append(k)

    def through(node, k):
        ks = inc[node]
        if len(ks) != 2 or ks[0] == ks[1]:
            return None
        o = ks[1] if ks[0] == k else ks[0]
        a, b = edges[k], edges[o]
        return o if (a[3], a[4]) == (b[3], b[4]) else None

    def oriented(k, start):
        e = edges[k]
        return (e[2], e[1]) if e[0] == start else (e[2][::-1], e[0])

    seen = [False] * len(edges)
    out = []
    for k in range(len(edges)):
        if seen[k]:
            continue
        seen[k] = True
        u, v, pts, name, fl, L = edges[k]
        pts = list(pts)
        # forward from v
        end, cur = v, k
        while True:
            o = through(end, cur)
            if o is None or seen[o]:
                break
            seen[o] = True
            p, end = oriented(o, end)
            pts += p[1:]
            L += edges[o][5]
            cur = o
        # backward from u
        start, cur = u, k
        while True:
            o = through(start, cur)
            if o is None or seen[o]:
                break
            seen[o] = True
            p, start = oriented(o, start)
            pts = p[::-1][:-1] + pts
            L += edges[o][5]
            cur = o
        if start != end:
            out.append((start, end, pts, name, fl, L))
    return out


def hilbert(n, x, y):
    d, s = 0, n // 2
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = n - 1 - x, n - 1 - y
            x, y = y, x
        s //= 2
    return d


def encode(g, edges):
    q = lambda p: tuple(int(round(c * QUANT)) for c in to_ll(*p))
    used = sorted({e[0] for e in edges} | {e[1] for e in edges})
    qxy = {i: q(g.xy[i]) for i in used}
    xs, ys = [p[0] for p in qxy.values()], [p[1] for p in qxy.values()]
    x0, y0 = min(xs), min(ys)
    span = max(max(xs) - x0, max(ys) - y0) + 1
    n = 1 << max(1, math.ceil(math.log2(span)))
    order = sorted(used, key=lambda i: hilbert(n, qxy[i][0] - x0, qxy[i][1] - y0))
    idx = {old: k for k, old in enumerate(order)}

    names = Counter(e[3] for e in edges)
    # "path" and "steps" always sit at 0 and 1 (the phone reads index 0 as an unnamed path)
    fixed = ['path', 'steps']
    name_list = fixed + [nm for nm, _ in sorted(names.items(), key=lambda kv: (-kv[1], kv[0]))
                         if nm not in fixed]
    name_idx = {nm: k for k, nm in enumerate(name_list)}

    recs = []
    for u, v, pts, name, fl, L in edges:
        a, b = idx[u], idx[v]
        if a > b:
            a, b, pts = b, a, pts[::-1]
        shp = dp(pts, DP_TOL_M)[1:-1]
        qs = []
        prev = qxy[order[a]]
        for p in shp:
            qp = q(p)
            if qp != prev:
                qs.append(qp)
                prev = qp
        if qs and qs[-1] == qxy[order[b]]:
            qs.pop()
        recs.append((a, b, int(round(L)), name_idx[name], fl, qs))
    recs.sort(key=lambda r: (r[0], r[1], r[2]))

    nodes, px, py = [], 0, 0
    for old in order:
        x, y = qxy[old]
        nodes += [x - px, y - py]
        px, py = x, y
    flat, shape, pa = [], [], 0
    for a, b, m, ni, fl, qs in recs:
        flat += [a - pa, b - a, m, ni, fl, len(qs)]
        pa = a
        lx, ly = qxy[order[a]]
        for x, y in qs:
            shape += [x - lx, y - ly]
            lx, ly = x, y
    lons, lats = [p[0] for p in qxy.values()], [p[1] for p in qxy.values()]
    return {
        'v': 1,
        'format': FORMAT,
        'attribution': ATTRIBUTION,
        'bbox': [min(lons) / QUANT, min(lats) / QUANT, max(lons) / QUANT, max(lats) / QUANT],
        'counts': {'nodes': len(order), 'edges': len(recs), 'shape': len(shape) // 2},
        'names': name_list,
        'nodes': nodes,
        'edges': flat,
        'shape': shape,
    }


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def build(args):
    cl_path, osm_paths = load_sources(args.cache, args.refresh)
    cscl = load_cscl(cl_path)
    ways, drop_polys = load_osm(osm_paths)
    g, edges = build_graph(cscl, ways, drop_polys)
    find, comp = components(None, edges)
    sizes = sorted(comp.values(), reverse=True)
    keep_roots = {r for r, s in comp.items() if s >= MIN_COMPONENT}
    total = sum(sizes)
    kept = [e for e in edges if find(e[0]) in keep_roots]
    print(f'  raw graph: {total} nodes, {len(edges)} edges, {len(sizes)} components '
          f'(largest {sizes[0]}, kept {len(keep_roots)} with >= {MIN_COMPONENT} nodes: '
          f'{sorted((s for s in sizes if s >= MIN_COMPONENT), reverse=True)}; '
          f'dropped {len(sizes) - len(keep_roots)} islands, {total - sum(s for s in sizes if s >= MIN_COMPONENT)} nodes)',
          file=sys.stderr)
    merged = merge_chains(kept)
    print(f'  merged chains: {len(kept)} -> {len(merged)} edges', file=sys.stderr)
    doc = encode(g, merged)
    text = json.dumps(doc, separators=(',', ':'), ensure_ascii=False)
    raw = text.encode('utf-8')
    write_atomic(args.out, text)
    print(f'wrote {args.out}: {len(raw):,} bytes raw, {len(gzip.compress(raw, 9)):,} bytes gzip; '
          f'{doc["counts"]["nodes"]} nodes, {doc["counts"]["edges"]} edges, {doc["counts"]["shape"]} shape points, '
          f'{len(doc["names"])} names')


# ---------------------------------------------------------------- check
EXCLUDED_NAMES = re.compile(
    r'^(FDR|Franklin D Roosevelt) (Dr|Drive)$|^Harlem River (Dr|Drive)$|Henry Hudson (Pkwy|Parkway|Bridge)|'
    r'Brooklyn[- ]Queens Expy|\bBQE\b|West Side (Hwy|Highway)|Joe Di ?Maggio|Miller (Hwy|Highway)|Verrazz|'
    r'Gowanus (Expy|Expressway)|Prospect Expy|Long Island Expy|Belt Pkwy|Cross Bronx|Grand Central Pkwy|'
    r'Jackie Robinson Pkwy|Park Ave Viaduct|Underpass|Kosciuszko|\bExpy\b|Expressway|\bHwy\b|Highway|'
    r'\bRamp\b|\b(65th|79th|86th|97th) St(reet)? Transverse', re.I)
SPOT = [
    # (label, from (lat, lon), to (lat, lon), km range, extra test)
    # Times Sq -> Union Sq is 2.49 km in a straight line and Broadway runs almost straight
    # between them, so the brief's 2.8 km floor cannot be met by a correct graph: 2.4-3.2.
    ('Times Sq <-> Union Sq', (40.7580, -73.9855), (40.7359, -73.9906), (2.4, 3.2), None),
    # Grand Central's 42nd St doors (the concourse itself is 50+ m inside the building) to
    # the Upper Terrace on the park's east side behind the library.
    ('Grand Central <-> Bryant Park', (40.7521, -73.9774), (40.7538, -73.9826), (0.45, 0.65), None),
    # 1.14 km in a straight line; West Drive and the Mall-side paths add ~20%: 1.3-1.9.
    ('Columbus Circle <-> Bethesda Terrace', (40.7681, -73.9819), (40.7740, -73.9708), (1.3, 1.9), 'park'),
    ('City Hall <-> DUMBO', (40.7128, -74.0060), (40.7033, -73.9897), (2.2, 2.8), 'Brooklyn Bridge'),
    ('Bedford Av L <-> Marsha P. Johnson SP', (40.7172, -73.9567), (40.7215, -73.9620), (0.6, 0.9), None),
    # Sutton Pl / E 60 St over the Ed Koch Queensboro walkway to Queens Plaza.
    ('E 60 St <-> Queens Plaza', (40.76124, -73.96388), (40.7506, -73.9402), (2.0, 2.9), 'Queensboro Bridge'),
    # Canal St / Bowery to Jay St / Water St in DUMBO: 129 m on Bowery, 2.06 km over the
    # north walkway to its Jay St landing, ~0.39 km down Jay St, so ~2.6 km (not 2.0-2.4).
    ('Canal/Bowery <-> Jay/Water', (40.71624, -73.99606), (40.70311, -73.98665), (2.3, 2.8), 'Manhattan Bridge'),
    ('Delancey/Clinton <-> Bedford/S 6 St', (40.7185, -73.9876), (40.7110, -73.9625), (1.9, 2.4),
     'Williamsburg Bridge'),
    # Points under or beside a bridge must snap to the ground, not to the deck above.
    ('DUMBO under the Manhattan Bridge -> Jay/Water', (40.70330, -73.98840), (40.70311, -73.98665),
     (0.1, 0.3), None),
    # (the nearest ground way there is N Loop Rd, 48 m off, which loops round to Main St)
    ('Roosevelt Island under the Queensboro -> tram', (40.7566, -73.9548), (40.7570, -73.9536), (0.1, 0.5), None),
    # The E 71 St footbridge lands on the esplanade and on York Ave.
    ('E 71 St esplanade -> York Ave', (40.76530, -73.95130), (40.76660, -73.95360), (0.2, 0.5), None),
    # Across Central Park on the 86 St line: crossings over East / West Drive are kept.
    ('5 Av/E 86 <-> CPW/W 86', (40.78153, -73.96042), (40.7853, -73.9705), (0.9, 1.3), 'park'),
    # On the High Line between W 25 and W 26 St, down the W 23 St stairs: the deck is one
    # line with its stairs, not a parallel copy that only meets the street at Gansevoort.
    ('High Line at W 25 St -> 10 Av/W 23 St', (40.7488, -74.0040), (40.7471, -74.0043), (0.15, 0.45), None),
]


# Bridge ends that may stay loose: the far side is outside the coverage, or the
# deck has no stairs within reach in either source.
OUT_N = 'the far side is outside the coverage'
LOOSE_OK = [
    ('George Washington Bridge', 40.85159, -73.95304, OUT_N + ' (New Jersey)'),
    ('High Bridge', 40.84228, -73.92958, OUT_N + ' (the Bronx)'),
    ('Washington Bridge', 40.84643, -73.92736, OUT_N + ' (the Bronx)'),
    ('University Heights Bridge', 40.86244, -73.91429, OUT_N + ' (the Bronx)'),
    ('RFK Bridge', 40.79889, -73.91881, OUT_N + ' (Bronx span)'),
    ('RFK Bridge', 40.79904, -73.91913, OUT_N + ' (Bronx span)'),
    ('RFK Bridge', 40.78778, -73.92798, 'Queens span foot on Wards Island, 69 m from Recovery Rd'),
    ('RFK Bridge', 40.80108, -73.92927, 'spur of the Manhattan span over Bobby Wagner Walk'),
    ('26th Ave', 40.76268, -73.90208, 'deck at the east edge of the Astoria coverage'),
    ('JJ Byrne Memorial Bridge', 40.73328, -73.94037, OUT_N + ' (Greenpoint Ave, Queens, south of 40.735)'),
    ('W 145th St', 40.81968, -73.93440, 'roadway stub beside the 145 St Bridge walkway'),
    ('E 51st St Pedestrian Bridge', 40.75357, -73.96308, 'riverside landing not mapped in either source'),
    ('East 51st Street Pedestrian Crossing', 40.75344, -73.96318, 'OSM copy of the E 51 St footbridge'),
    ('W 176th St Pedestrian Bridge', 40.84831, -73.94274, 'landing 43 m from Riverside Dr, nothing nearer'),
    ('Pedestrian bridge', 40.84717, -73.94564, 'Fort Washington Park overpass, no mapped stairs'),
    ('path', 40.72110, -73.97489, 'OSM copy of the E 6 St footbridge (centerline one is connected)'),
    ('path', 40.73198, -73.97292, 'Stuyvesant Cove ferry gangway'),
]


def decode(doc):
    nodes, px, py = [], 0, 0
    nd = doc['nodes']
    for i in range(0, len(nd), 2):
        px += nd[i]
        py += nd[i + 1]
        nodes.append((px, py))
    E, ed, sh, si, a = [], doc['edges'], doc['shape'], 0, 0
    for r in range(0, len(ed), 6):
        da, db, m, ni, fl, ns = ed[r:r + 6]
        a += da
        b = a + db
        pts, (lx, ly) = [nodes[a]], nodes[a]
        for _ in range(ns):
            lx += sh[si]
            ly += sh[si + 1]
            si += 2
            pts.append((lx, ly))
        pts.append(nodes[b])
        E.append((a, b, m, ni, fl, pts))
    assert si == len(sh), 'shape array length does not match the ns counts'
    return nodes, E


class Walk:
    """walk.json decoded for routing: the same steps the phone does (snap each
    point onto the nearest edge of the main component, Dijkstra from both ends
    of that edge, metres as cost)."""

    def __init__(self, doc):
        self.doc = doc
        self.names = doc['names']
        self.nodes, self.E = decode(doc)
        parent = list(range(len(self.nodes)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for a, b, *_ in self.E:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra
        self.find = find
        self.comp = Counter(find(i) for i in range(len(self.nodes)))
        self.main = max(self.comp, key=self.comp.get)
        self.adj = defaultdict(list)
        for k, (a, b, m, ni, fl, pts) in enumerate(self.E):
            self.adj[a].append((b, m, k))
            self.adj[b].append((a, m, k))
        self.segs = []
        for k, (a, b, m, ni, fl, pts) in enumerate(self.E):
            if find(a) != self.main:
                continue
            P = [self.xy(p) for p in pts]
            cum = [0.0]
            for i in range(len(P) - 1):
                cum.append(cum[-1] + math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]))
            for i in range(len(P) - 1):
                self.segs.append((k, P[i], P[i + 1], cum[i], cum[i + 1], cum[-1]))

    @staticmethod
    def xy(p):
        return to_xy(p[0] / QUANT, p[1] / QUANT)

    def snap(self, lat, lon):
        """(metres off the graph, edge, fraction along the edge from node a).
        Same rule as the phone: a bridge or footbridge deck is only taken when
        it is clearly the closest thing (within 40 m with no street or path
        within max(40, d + 25) m, or within 10 m with nothing else within
        d + 15 m), so a point under or beside a bridge snaps to the ground."""
        x, y = to_xy(lon, lat)
        best = {False: None, True: None}
        for k, p, q2, c0, c1, L in self.segs:
            t, qx, qy, d2 = proj(x, y, p[0], p[1], q2[0], q2[1])
            br = bool(self.E[k][4] & 2)
            if best[br] is None or d2 < best[br][0]:
                best[br] = (d2, k, (c0 + t * (c1 - c0)) / L if L else 0.0)
        nb, bb = best[False], best[True]
        pick = nb
        if bb is not None:
            db = math.sqrt(bb[0])
            dn = math.sqrt(nb[0]) if nb else float('inf')
            if (db <= 40 and dn > max(40, db + 25)) or (db <= 10 and dn > db + 15):
                pick = bb
        return math.sqrt(pick[0]), pick[1], pick[2]

    def route(self, A, B):
        da, ka, fa = self.snap(*A)
        db, kb, fb = self.snap(*B)
        E = self.E
        dist, prev, pq = {}, {}, []
        for nd, c in ((E[ka][0], fa * E[ka][2]), (E[ka][1], (1 - fa) * E[ka][2])):
            if c + da < dist.get(nd, 1e18):
                dist[nd] = c + da
                prev[nd] = None
                heapq.heappush(pq, (c + da, nd))
        targets = defaultdict(lambda: 1e18)
        for nd, c in ((E[kb][0], fb * E[kb][2]), (E[kb][1], (1 - fb) * E[kb][2])):
            targets[nd] = min(targets[nd], c + db)
        best, best_end, done = 1e18, None, set()
        if ka == kb:
            best = da + db + abs(fa - fb) * E[ka][2]
        while pq:
            d, nd = heapq.heappop(pq)
            if nd in done:
                continue
            done.add(nd)
            if d >= best:
                break
            if nd in targets and d + targets[nd] < best:
                best, best_end = d + targets[nd], nd
            for nb, m, k in self.adj[nd]:
                nd2 = d + m
                if nd2 < dist.get(nb, 1e18):
                    dist[nb] = nd2
                    prev[nb] = (nd, k)
                    heapq.heappush(pq, (nd2, nb))
        edges, cur = [ka], best_end
        mid = []
        while cur is not None and prev.get(cur):
            cur, k = prev[cur]
            mid.append(k)
        edges = [ka] + mid[::-1] + ([kb] if kb != ka else [])
        seq = []
        for k in edges:
            nm = self.names[E[k][3]]
            if not seq or seq[-1] != nm:
                seq.append(nm)
        walked = sum(E[k][2] for k in mid) or 1
        return {'m': best, 'snap': (da, db), 'edges': edges, 'names': seq,
                'path_share': sum(E[k][2] for k in mid if E[k][4] & 1) / walked}


def check(path):
    with open(path, 'rb') as f:
        raw = f.read()
    doc = json.loads(raw)
    ok = True
    w = Walk(doc)
    nodes, E, names = w.nodes, w.E, w.names
    print(f'check {path}: {len(raw):,} bytes raw ({len(gzip.compress(raw, 9)):,} gzip), '
          f'{len(nodes)} nodes, {len(E)} edges, {len(doc["shape"]) // 2} shape points, {len(names)} names')
    if len(raw) > MAX_BYTES:
        print(f'  FAIL size {len(raw):,} > {MAX_BYTES:,}')
        ok = False
    for k in ('format', 'attribution', 'bbox'):
        if not doc.get(k):
            print(f'  FAIL missing "{k}"')
            ok = False
    c = doc.get('counts', {})
    if (c.get('nodes'), c.get('edges'), c.get('shape')) != (len(nodes), len(E), len(doc['shape']) // 2):
        print('  FAIL counts do not match the arrays')
        ok = False
    if any(not (0 <= e[0] <= e[1] < len(nodes)) or not (0 <= e[3] < len(names)) for e in E):
        print('  FAIL edge index out of range')
        ok = False

    # metres vs drawn geometry (catches encoding slips)
    bad = sum(1 for a, b, m, ni, fl, pts in E if plen([w.xy(p) for p in pts]) > m + 3 + 0.03 * m)
    print(f'  edge length vs shape: {bad} edges shorter in metres than their drawn line'
          + ('' if bad < len(E) * 0.002 else '  FAIL'))
    ok &= bad < len(E) * 0.002

    sizes = sorted(w.comp.values(), reverse=True)
    share = sizes[0] / len(nodes)
    print(f'  components: {len(sizes)}; largest {sizes[0]} nodes = {share:.2%}'
          + ('' if share >= 0.98 else '  FAIL (< 98%)'))
    ok &= share >= 0.98
    for r, n in sorted(w.comp.items(), key=lambda kv: -kv[1]):
        if r != w.main:
            x, y = nodes[r]
            print(f'    separate component: {n} nodes near {y / QUANT:.4f}, {x / QUANT:.4f}')

    bad_names = [n for n in names if EXCLUDED_NAMES.search(n)]
    print(f'  excluded highway names present: {bad_names or "none"}' + ('  FAIL' if bad_names else ''))
    ok &= not bad_names

    # bridges and footbridges that end in mid-air: only the known ones may (see LOOSE_OK)
    deg = Counter()
    for a, b, *_ in E:
        deg[a] += 1
        deg[b] += 1
    loose = []
    for a, b, m, ni, fl, pts in E:
        if fl & 2 and w.find(a) == w.main:
            loose += [(names[ni], nodes[n][1] / QUANT, nodes[n][0] / QUANT) for n in (a, b) if deg[n] == 1]
    print(f'  loose bridge ends: {len(loose)}')
    for nm, lat, lon in sorted(loose):
        why = next((r for n2, la, lo, r in LOOSE_OK
                    if n2 == nm and math.hypot((lon - lo) * MX, (lat - la) * MY) < 40), None)
        print(f'    {"ok  " if why else "FAIL"} {nm!r} at {lat:.5f},{lon:.5f}' + (f' ({why})' if why else ''))
        ok &= bool(why)

    for label, A, B, (lo, hi), extra in SPOT:
        r = w.route(A, B)
        km = r['m'] / 1000
        good = lo <= km <= hi
        note = ''
        if extra == 'park':
            note = f', {r["path_share"]:.0%} on park paths'
            good &= r['path_share'] >= 0.5
        elif extra:
            note = f', uses {extra}: {"yes" if extra in r["names"] else "no"}'
            good &= extra in r['names']
        seq = r['names']
        print(f'  {"ok  " if good else "FAIL"} {label}: {km:.2f} km (expect {lo}-{hi}){note}; '
              f'snap {r["snap"][0]:.0f} m / {r["snap"][1]:.0f} m; via {" > ".join(seq[:12])}'
              f'{" ..." if len(seq) > 12 else ""}')
        ok &= good
    print('check passed' if ok else 'check FAILED')
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--refresh', action='store_true', help='download the sources again')
    ap.add_argument('--check', action='store_true', help='only check an existing walk.json')
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--cache', default=CACHE)
    args = ap.parse_args()
    if not args.check:
        try:
            build(args)
        except DownloadError as e:
            sys.exit(f'download failed: {e}')
    sys.exit(0 if check(args.out) else 1)


if __name__ == '__main__':
    main()
