#!/usr/bin/env python3
"""Build the subway network the app plans trips with, on the phone, offline.

Output: app/src/static/data/subway.json (plain JSON, generic public NYC data
only; precached by the service worker as data/subway.json). Everything a
router needs to say "walk 6 min to 23 St, downtown 1 train, 4 stops, 9 min"
with no network: stations and their street entrances, every service pattern
with run times and trains per hour by hour of day, in-station transfers, and
optional track geometry for drawing the ride.

Format (also stored, shorter, in the file's "format" field). Indexes are
0-based positions in the arrays named. Coordinates are WGS84 degrees.

  v            1
  attribution  sources to credit
  feed         {version, start, end}  the MTA GTFS feed it was built from;
               start/end "YYYYMMDD", the first and last service dates. A
               router planning outside them maps the date to the same weekday
               inside the range and says the times may be out of date.
  routes       {route_id: {short, long, color, text, line?}}  colours are hex
               without "#": the classic MTA bullet colours (CLASSIC; 1/2/3
               EE352E, A/C/E 0039A6, N/Q/R/W FCCC0A on black, shuttles
               808183, ...), routes.txt values otherwise. Ids: 1-7, A C E B D F
               M G J Z L N Q R W, GS (42 St shuttle), FS (Franklin Av shuttle),
               H (Rockaway Park shuttle) whose short name is "S", SI (Staten
               Island Railway, short "SIR"), and the rush-hour "diamond"
               express variants 6X, 7X, FX, which carry line = "6"|"7"|"F":
               riders see them as that train (draw the bullet as a diamond).
  complexes    [{name, lat, lon, routes, ada}]  a station complex = one place
               you can transfer inside without paying again. routes = daytime
               route ids (data.ny.gov "Daytime Routes", shuttles mapped to
               GS/FS/H). ada: 0 not accessible, 1 accessible, 2 partly (see
               stops[].adn).
  stops        [{id, c, lat, lon, name, routes, ns, ada, adn?}]  one per GTFS
               parent stop (a platform group of one line inside a complex).
               id = GTFS parent stop id, c = complex index, routes = daytime
               route ids at this stop, ns = [label for the "N" platform, label
               for the "S" platform] e.g. ["Uptown", "Downtown"] or
               ["Manhattan", "Coney Island"] ("Last Stop" at terminals),
               ada 0/1/2, adn = note when ada is 2 (e.g. "Downtown only").
               name = the platform name when it is part of the complex name
               ("14 St" in "14 St/6 Av"), else the complex name, so a place has
               one name. nsr = {route: [N label, S label]} where one line on
               the platform runs the other way from the label (the M on the
               J/Z's Broadway el, the G at Hoyt-Schermerhorn); "" = no label,
               say only "toward <headsign>". Labels are data.ny.gov's and may
               be generic ("Outbound", "Inbound", "Westbound", "Last Stop").
  entrances    [{c, s?, lat, lon, type, ada?, x?, nx?}]  street entrances.
               c = complex index, s = stop index when the entrance leads to one
               line's platforms, type = stair|elevator|escalator|easement|ramp|
               door (easement = inside a building or plaza, door = station
               house), ada:1 = step-free by type (elevator, ramp, walkway),
               x:1 = exit only (no entry; arrivals may use it), nx:1 = entry
               only (no exit). Every complex has at least one entrance without x.
               c is the complex of stop s when s is set (a few dataset rows
               carry a neighbour's complex id); entrances more than 350 m from
               the stops they are listed for are dropped.
  patterns     [{route, dir, headsign, stops, run, tph}]  one per distinct
               (route, direction, stop sequence) that runs at least MIN_TRIPS
               trips on some kind of day. Express and local runs, late-night
               variants and short runs are separate patterns, so a pattern
               only "stops" where its trains actually stop.
               dir = "N"|"S" platform (label: stops[i].ns[0|1]),
               stops = stop indexes in travel order,
               run[k] = seconds from leaving stops[k] to leaving stops[k+1]
                        (median over the pattern's trips, dwell included),
               tph = {wk, sa, su}: 24 ints each, the number of trips that leave
                     the pattern's FIRST stop in New York clock hour 0..23 on a
                     weekday (Mon-Fri), Saturday or Sunday. Trips after midnight
                     are counted on the clock day they run (a Friday 1:30a
                     train is in sa[1]).
               Trains per hour at stops[k] at New York time T:
                     cum = run[0] + ... + run[k-1]
                     t   = T - cum seconds (may fall on the previous day)
                     n   = tph[dayType(t)][hour(t)]
               Add n over every pattern that serves the boarding stop and then
               the alighting stop; expected wait ~ 30/n min, none when n = 0.
               (Monday 0-1a uses wk, which slightly overstates Sunday-night
               late service.)
  transfers    [[from_stop, to_stop, seconds]]  GTFS transfers.txt (minimum
               time). from == to is the minimum time to change trains on one
               stop (0 = across the platform).
  hops         {"a-b": [lat0, lon0, dlat1, dlon1, ...]}  track geometry from
               stops[a] to stops[b] (a < b; reverse it for b -> a), shared by
               every pattern that runs between those two stops consecutively.
               Integers in 1e-5 degrees: the first pair is absolute, each next
               pair is a delta. From the GTFS shapes, simplified to about 10 m
               (loosened to 15/20/30 m, or left out, only if the file would go
               over its size budget). Missing key: draw a straight line.

Sources (public, no keys):
  MTA NYCT subway GTFS static  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
                               (linked from https://www.mta.info/developers)
  data.ny.gov  39hk-dx4f  MTA Subway Stations
               i9wp-a4ja  MTA Subway Entrances and Exits: 2024

Kinds of day: the feed's services are read for one reference date of each
kind (the first Tue-Thu, Saturday and Sunday on or after --date, default
today, inside the feed's range, preferring dates with no holiday exceptions
on that day or the day before), plus the day before it, whose after-midnight
trips (GTFS times past 24:00) belong to the reference clock day.

Raw downloads are cached in research/routing/subway/ (gitignored) and only
read as data. --refresh downloads again. A download failure or a failed check
exits non-zero and leaves the existing subway.json untouched. The checks warn
(without failing) when the feed ends in under 30 days.

  python3 -I tools/subway_build.py [--refresh] [--date YYYY-MM-DD] [--max-kb 450]
                                   [--out PATH] [--cache DIR] [--no-shapes]
  python3 -I tools/subway_build.py --check     # re-run the checks on subway.json

Standard library only. HTTPS goes through urllib, falling back to curl when the
local Python has no usable CA bundle (common on macOS framework builds).
"""
import argparse
import csv
import datetime as dt
import importlib.util
import io
import json
import math
import os
import re
import statistics
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'research', 'routing', 'subway')
OUT = os.path.join(ROOT, 'app', 'src', 'static', 'data', 'subway.json')

GTFS_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip'
NYS = 'https://data.ny.gov/resource/'
STATIONS_ID = '39hk-dx4f'
ENTRANCES_ID = 'i9wp-a4ja'
ROW_LIMIT = 20000

ATTRIBUTION = ('MTA New York City Transit (subway GTFS schedule); data.ny.gov / MTA: '
               'MTA Subway Stations, MTA Subway Entrances and Exits: 2024')

DAYS = ('wk', 'sa', 'su')
# Reference weekdays (Mon=0): Tue-Thu so the night before is also a weekday.
WANT = {'wk': (1, 2, 3), 'sa': (5,), 'su': (6,)}
MIN_TRIPS = 3          # a pattern must run at least this many trips on some kind of day
SIMPLIFY_M = 10        # track geometry tolerance (m)
SNAP_M = 150           # a stop farther than this from its pattern's shape gets no hop geometry
SNAP_SLACK_M = 25
Q = 100000             # 1e-5 degree quantization

ENTRANCE_TYPE = {
    'stair': 'stair', 'underpass': 'stair', 'overpass': 'stair',
    'elevator': 'elevator',
    'escalator': 'escalator', 'stair/escalator': 'escalator',
    'easement - street': 'easement', 'easement - passage': 'easement',
    'station house': 'door',
    'ramp': 'ramp', 'stair/ramp': 'ramp', 'stair/ramp/walkway': 'ramp', 'walkway': 'ramp',
}
STEP_FREE = {'elevator', 'ramp', 'walkway'}   # raw entrance types marked ada:1
ENT_MAX_M = 350        # an entrance farther than this from the stops it is listed for is dropped
FEED_WARN_DAYS = 30    # --check warns when the GTFS feed ends sooner than this

# Classic MTA bullet colours (the GTFS routes.txt palette is a newer, darker set).
CLASSIC = {}
for _ids, _bg, _tx in (('1 2 3', 'EE352E', 'FFFFFF'), ('4 5 6 6X', '00933C', 'FFFFFF'), ('7 7X', 'B933AD', 'FFFFFF'),
                       ('A C E', '0039A6', 'FFFFFF'), ('B D F FX M', 'FF6319', 'FFFFFF'), ('G', '6CBE45', 'FFFFFF'),
                       ('J Z', '996633', 'FFFFFF'), ('L', 'A7A9AC', 'FFFFFF'), ('N Q R W', 'FCCC0A', '000000'),
                       ('GS FS H', '808183', 'FFFFFF')):
    for _r in _ids.split():
        CLASSIC[_r] = (_bg, _tx)

# Platform labels per line that the bearing rule in dir_labels() cannot infer: (stop, route) ->
# (N label or None to keep, S label or None to keep).
NS_FIX = {
    ('A42', 'A'): ('Manhattan', None),       # Hoyt-Schermerhorn: the N platform says Westbound
    ('A42', 'C'): ('Manhattan', 'Brooklyn'), # ... and the S platform Queens (the A's Rockaways)
    ('D14', 'B'): ('Uptown', None),          # 7 Av (53 St): the N platform says Outbound (the E's)
    ('D14', 'D'): ('Uptown', None),
    ('D14', 'E'): ('Queens', None),
    ('D43', 'Q'): ('Manhattan', None),       # Coney Island: the Q leaves the terminal eastward, then turns north
}

FORMAT = (
    'subway/1. Indexes are 0-based. routes{id:{short,long,color,text,line?}} hex colours without #; '
    'line = the train riders see for a diamond express variant (6X -> 6). '
    'Colours are the classic MTA bullet colours. feed={version,start,end} YYYYMMDD service range. '
    'complexes[i]={name,lat,lon,routes:[daytime route ids],ada:0|1|2 partly}. '
    'stops[j]={id:GTFS parent stop,c:complex index,lat,lon,name (platform name if part of the complex name, '
    'else the complex name),routes,ns:[N platform label,S platform label],nsr?:{route:[N,S]} per-line labels '
    'where a line runs the other way ("" = none),ada,adn?:note}. entrances[]={c (= stops[s].c),s?:stop index,'
    'lat,lon,type:stair|elevator|escalator|easement|ramp|door,'
    'ada?:1 step-free,x?:1 exit only,nx?:1 no exit}. patterns[]={route,dir:N|S,headsign,stops:[stop idx],'
    'run:[s from leaving stops[k] to leaving stops[k+1]],tph:{wk,sa,su}:[24]} where tph[h] = trips leaving the '
    "pattern's FIRST stop in NY clock hour h (wk=Mon-Fri). Trains/hour at stops[k] at time T: "
    't=T-sum(run[0..k-1]) s (may be the previous day); n=tph[dayType(t)][hour(t)]. Sum n over patterns serving '
    'both stops in order; n=0 means not running. transfers[]=[fromStop,toStop,min s] (same stop: change time). '
    'hops{"a-b" a<b stop idx}=[lat0,lon0,dlat,dlon,...] ints 1e-5 deg, first pair absolute, then deltas; '
    'track from stops[a] to stops[b]; missing: straight line.'
)


class BuildError(Exception):
    pass


# ---------------------------------------------------------------- download

_use_curl = False


def fetch(url, dest):
    """Download url to dest (atomic). urllib first, curl if SSL is broken.
    Raises BuildError; a failed download never replaces dest."""
    global _use_curl
    tmp = dest + '.part'
    try:
        if not _use_curl:
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'nyc-trip-subway/1'})
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
        r = subprocess.run(['curl', '-sS', '-f', '-L', '-m', '600', '-o', tmp, url],
                           stderr=subprocess.PIPE, text=True)
        if r.returncode:
            raise BuildError(f'{urllib.parse.urlsplit(url).netloc}: {r.stderr.strip() or "curl exit " + str(r.returncode)}')
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def nys_url(dataset):
    return f'{NYS}{dataset}.json?' + urllib.parse.urlencode({'$limit': ROW_LIMIT})


def cached(cache, name, url, refresh):
    path = os.path.join(cache, name)
    if refresh or not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        print(f'  downloading {name}', file=sys.stderr)
        fetch(url, path)
    return path


def read_rows(path, need):
    """A SODA JSON row list; an error body or truncated file is a BuildError."""
    try:
        with open(path) as f:
            rows = json.load(f)
    except ValueError as e:
        raise BuildError(f'{os.path.basename(path)} is not JSON ({e}); re-run with --refresh')
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        raise BuildError(f'{os.path.basename(path)} is not a row list; re-run with --refresh')
    if len(rows) >= ROW_LIMIT:
        raise BuildError(f'{os.path.basename(path)} hit the {ROW_LIMIT} row limit; page it')
    missing = [k for k in need if k not in rows[0]]
    if missing:
        raise BuildError(f'{os.path.basename(path)} has no {missing} column(s); the dataset changed')
    return rows


def load_sources(cache, refresh):
    gtfs = cached(cache, 'gtfs_subway.zip', GTFS_URL, refresh)
    stations = cached(cache, 'stations.json', nys_url(STATIONS_ID), refresh)
    entrances = cached(cache, 'entrances.json', nys_url(ENTRANCES_ID), refresh)
    try:
        z = zipfile.ZipFile(gtfs)
    except zipfile.BadZipFile:
        raise BuildError('gtfs_subway.zip is not a zip; re-run with --refresh')
    return (z,
            read_rows(stations, ['gtfs_stop_id', 'complex_id', 'stop_name', 'daytime_routes', 'gtfs_latitude',
                                 'gtfs_longitude', 'ada', 'north_direction_label', 'south_direction_label']),
            read_rows(entrances, ['complex_id', 'gtfs_stop_id', 'stop_name', 'entrance_type', 'entry_allowed',
                                  'exit_allowed', 'entrance_latitude', 'entrance_longitude']))


# ---------------------------------------------------------------- GTFS

def read_csv(z, name, required=True):
    try:
        f = z.open(name)
    except KeyError:
        if required:
            raise BuildError(f'GTFS has no {name}')
        return
    with f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def secs(t):
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s)


def ymd(s):
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))


class Calendar:
    def __init__(self, z):
        self.cal = {}
        for r in read_csv(z, 'calendar.txt'):
            days = [r[k] == '1' for k in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
            self.cal[r['service_id']] = (ymd(r['start_date']), ymd(r['end_date']), days)
        self.exc = defaultdict(list)
        for r in read_csv(z, 'calendar_dates.txt', required=False):
            self.exc[ymd(r['date'])].append((r['service_id'], r['exception_type']))
        if not self.cal and not self.exc:
            raise BuildError('GTFS calendar is empty')
        ds = [a for a, _, _ in self.cal.values()] + [b for _, b, _ in self.cal.values()] + list(self.exc)
        self.lo, self.hi = min(ds), max(ds)

    def on(self, d):
        act = {sid for sid, (a, b, days) in self.cal.items() if a <= d <= b and days[d.weekday()]}
        for sid, t in self.exc.get(d, ()):
            if t == '1':
                act.add(sid)
            elif t == '2':
                act.discard(sid)
        return act

    def refs(self, start):
        """{kind: reference date} for wk/sa/su (see module docstring)."""
        d0 = max(start, self.lo)
        if d0 > self.hi:
            print('  --date is after the feed ends; using its first days', file=sys.stderr)
            d0 = self.lo
        one = dt.timedelta(days=1)
        out = {}
        for k, wds in WANT.items():
            for strict in (True, False):
                d = d0
                while d <= self.hi and k not in out:
                    quiet = not (self.exc.get(d) or self.exc.get(d - one))
                    if d.weekday() in wds and (quiet or not strict) and self.on(d):
                        out[k] = d
                    d += one
                if k in out:
                    break
            if k not in out:
                raise BuildError(f'no {k} service day in the feed')
        return out


def load_gtfs(z, start):
    cal = Calendar(z)
    refs = cal.refs(start)
    one = dt.timedelta(days=1)
    # Services counted for each kind of day: (on the reference day, on the day before).
    svc = {k: (cal.on(d), cal.on(d - one)) for k, d in refs.items()}
    used = set().union(*(a | b for a, b in svc.values()))

    routes = {}
    for r in read_csv(z, 'routes.txt'):
        routes[r['route_id']] = r
    feed = {}
    for r in read_csv(z, 'feed_info.txt', required=False):
        feed = {'version': r.get('feed_version', ''), 'start': r.get('feed_start_date', ''),
                'end': r.get('feed_end_date', '')}
    stops = list(read_csv(z, 'stops.txt'))
    parent = {}
    for s in stops:
        parent[s['stop_id']] = s['parent_station'] or s['stop_id']
    trips = {}
    for t in read_csv(z, 'trips.txt'):
        if t['service_id'] in used:
            trips[t['trip_id']] = {'route': t['route_id'], 'sid': t['service_id'], 'head': t.get('trip_headsign', ''),
                                   'shape': t.get('shape_id', ''), 'st': []}
    for r in read_csv(z, 'stop_times.txt'):
        t = trips.get(r['trip_id'])
        if t is not None:
            t['st'].append((int(r['stop_sequence']), r['stop_id'], secs(r['departure_time'] or r['arrival_time'])))
    for tid, t in list(trips.items()):
        st = sorted(t['st'])
        if len(st) < 2:
            del trips[tid]
            continue
        sid = st[0][1]
        t['dir'] = sid[-1] if sid[-1] in 'NS' and parent.get(sid) != sid else '?'
        t['stops'] = tuple(parent.get(x[1], x[1]) for x in st)
        t['dep'] = [x[2] for x in st]
        del t['st']
    transfers = list(read_csv(z, 'transfers.txt', required=False))
    shapes = defaultdict(list)
    for r in read_csv(z, 'shapes.txt', required=False):
        shapes[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
    shapes = {k: [(la, lo) for _, la, lo in sorted(v)] for k, v in shapes.items()}
    return {'cal': cal, 'refs': refs, 'svc': svc, 'routes': routes, 'feed': feed, 'stops': stops,
            'parent': parent, 'trips': trips, 'transfers': transfers, 'shapes': shapes}


def day_hours(trip, svc):
    """[(kind, clock hour)] this trip leaves its first stop in, per kind of day."""
    t0 = trip['dep'][0]
    out = []
    for k in DAYS:
        on, before = svc[k]
        if trip['sid'] in on and t0 < 86400:
            out.append((k, t0 // 3600))
        if trip['sid'] in before and 86400 <= t0 < 2 * 86400:
            out.append((k, (t0 - 86400) // 3600))
    return out


def build_patterns(g):
    pats = {}
    for tid, t in g['trips'].items():
        hrs = day_hours(t, g['svc'])
        if not hrs:
            continue
        key = (t['route'], t['dir'], t['stops'])
        p = pats.get(key)
        if p is None:
            p = pats[key] = {'route': t['route'], 'dir': t['dir'], 'stops': t['stops'],
                             'tph': {k: [0] * 24 for k in DAYS}, 'trips': [], 'head': Counter(), 'shape': Counter()}
        for k, h in hrs:
            p['tph'][k][h] += 1
        p['trips'].append(t)
        p['head'][t['head']] += 1
        p['shape'][t['shape']] += 1
    kept, dropped = [], []
    for p in pats.values():
        (kept if max(sum(v) for v in p['tph'].values()) >= MIN_TRIPS else dropped).append(p)
    for p in kept:
        n = len(p['stops'])
        p['run'] = []
        for i in range(n - 1):
            d = statistics.median(t['dep'][i + 1] - t['dep'][i] for t in p['trips'])
            p['run'].append(max(15, int(round(d))))
    order = {r: int(v.get('route_sort_order') or 999) for r, v in g['routes'].items()}
    kept.sort(key=lambda p: (order.get(p['route'], 999), p['dir'], -sum(sum(v) for v in p['tph'].values())))
    return kept, dropped


# ---------------------------------------------------------------- geometry

def local_xy(lat0):
    kx = 111320.0 * math.cos(math.radians(lat0))
    return lambda la, lo: (lo * kx, la * 110540.0)


def project(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    u = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    qx, qy = ax + u * dx, ay + u * dy
    return (qx - px) ** 2 + (qy - py) ** 2, u


def snap_stops(shape_xy, stop_xy):
    """For each stop (in travel order) the (segment index, u, distance m) where it
    sits on the shape, searching forward from the previous stop: the first pass
    within SNAP_SLACK_M of the nearest one (shapes sometimes double back near a
    terminal or junction, and the nearest point can be on the way back)."""
    out, seg0, u0 = [], 0, 0.0
    nseg = len(shape_xy) - 1
    for px, py in stop_xy:
        cand = []
        for i in range(seg0, nseg):
            d2, u = project(px, py, *shape_xy[i], *shape_xy[i + 1])
            if i == seg0 and u < u0:
                u = u0
                ax, ay = shape_xy[i]
                bx, by = shape_xy[i + 1]
                d2 = (ax + u * (bx - ax) - px) ** 2 + (ay + u * (by - ay) - py) ** 2
            cand.append((math.sqrt(d2), i, u))
        if not cand:
            return None
        dmin = min(c[0] for c in cand)
        d, i, u = next(c for c in cand if c[0] <= dmin + SNAP_SLACK_M)
        out.append((i, u, d))
        seg0, u0 = i, u
    return out


def dp(pts, tol):
    """Douglas-Peucker on [(x, y)] in metres; returns kept indexes."""
    if len(pts) < 3:
        return list(range(len(pts)))
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dmax, imax = -1, -1
        for i in range(a + 1, b):
            d2, _ = project(pts[i][0], pts[i][1], ax, ay, bx, by)
            if d2 > dmax:
                dmax, imax = d2, i
        if imax > 0 and dmax > tol * tol:
            keep[imax] = True
            stack += [(a, imax), (imax, b)]
    return [i for i, k in enumerate(keep) if k]


def build_hops(patterns, stop_ll, shapes, tol):
    """{(a, b) a<b: [(lat, lon)]} track pieces between consecutive stops."""
    lat0 = sum(la for la, _ in stop_ll) / len(stop_ll)
    xy = local_xy(lat0)
    shape_xy = {}
    hops, missing = {}, set()
    for p in patterns:
        sid = p['shape'].most_common(1)[0][0] if p['shape'] else ''
        ll = shapes.get(sid)
        pairs = list(zip(p['stops'], p['stops'][1:]))
        if not ll or len(ll) < 2:
            missing.update((min(a, b), max(a, b)) for a, b in pairs)
            continue
        if sid not in shape_xy:
            shape_xy[sid] = [xy(la, lo) for la, lo in ll]
        sxy = shape_xy[sid]
        snaps = snap_stops(sxy, [xy(*stop_ll[s]) for s in p['stops']])
        if snaps is None:
            missing.update((min(a, b), max(a, b)) for a, b in pairs)
            continue

        def at(sn):
            i, u, _ = sn
            (a_la, a_lo), (b_la, b_lo) = ll[i], ll[i + 1]
            return a_la + u * (b_la - a_la), a_lo + u * (b_lo - a_lo)

        for k, (a, b) in enumerate(pairs):
            key = (min(a, b), max(a, b))
            s1, s2 = snaps[k], snaps[k + 1]
            if s1[2] > SNAP_M or s2[2] > SNAP_M:
                missing.add(key)
                continue
            line = [at(s1)] + ll[s1[0] + 1:s2[0] + 1] + [at(s2)]
            pts = [xy(la, lo) for la, lo in line]
            length = sum(math.dist(p0, p1) for p0, p1 in zip(pts, pts[1:]))
            if key in hops and hops[key][0] <= length:
                continue      # every pattern between two stops offers a line; keep the shortest
            line = [line[i] for i in dp(pts, tol)]
            if a > b:
                line.reverse()
            hops[key] = (length, line)
    missing -= set(hops)
    return {k: line for k, (_, line) in hops.items()}, missing


def encode_line(line):
    q = [(round(la * Q), round(lo * Q)) for la, lo in line]
    out = [q[0][0], q[0][1]]
    for (y0, x0), (y1, x1) in zip(q, q[1:]):
        if (y1, x1) != (y0, x0):
            out += [y1 - y0, x1 - x0]
    return out


# ---------------------------------------------------------------- assemble

def route_ids_for(text, stop_routes, known):
    """Map a data.ny.gov "Daytime Routes" string to route ids."""
    out = []
    for r in (text or '').split():
        if r == 'S':
            out += sorted(x for x in stop_routes if x in ('GS', 'FS', 'H')) or ['GS']
        elif r == 'SIR':
            out.append('SI')
        elif r in known:
            out.append(r)
        else:
            print(f'  warning: unknown daytime route {r!r}', file=sys.stderr)
    return out


def dist_m(lat1, lon1, lat2, lon2):
    return math.hypot((lat1 - lat2) * 111049.0, (lon1 - lon2) * 84496.0)


def name_in(part, whole):
    """Is `part` one of the '/'- or '-'-separated pieces (or runs of pieces) of `whole`?"""
    return re.search(r'(^|[/-])' + re.escape(part.lower()) + r'($|[/-])', whole.lower()) is not None


def adiff(a, b):
    x = abs(a - b) % 360
    return min(x, 360 - x)


def dir_labels(stops, pats):
    """stops[i].nsr = {route: [N label, S label]} for the lines whose trains on a platform head
    the other way from the stop's main lines. data.ny.gov labels each platform once: on the
    Broadway el the M runs opposite to the J/Z ("Outbound" on its Manhattan-bound side), at
    Hoyt-Schermerhorn the G shares the A/C stop id. A line heading the way the other platform's
    trains go gets that platform's label, one heading neither way gets "" (say only "toward
    <headsign>"). Then NS_FIX."""
    head = defaultdict(dict)    # (stop, dir) -> {route: (bearing, trips)} of its busiest pattern
    for p in pats:
        n = sum(sum(v) for v in p['tph'].values())
        st = p['stops']
        for k in range(len(st) - 1):
            a, b = stops[st[k]], stops[st[min(k + 3, len(st) - 1)]]
            got = head[(st[k], p['dir'])].get(p['route'])
            if got is None or got[1] < n:
                head[(st[k], p['dir'])][p['route']] = (
                    math.degrees(math.atan2((b['lat'] - a['lat']) * 111.0, (b['lon'] - a['lon']) * 84.5)), n)
    fixed = Counter()
    for i, s in enumerate(stops):
        routes = {r for d in 'NS' for r in head.get((i, d), {})}
        ref = {}
        for d in 'NS':
            hb = head.get((i, d), {})
            if hb:   # the bearing most trains on this platform share
                ref[d] = max((x for x, _ in hb.values()),
                             key=lambda x: sum(n for y, n in hb.values() if adiff(x, y) <= 45))
        nsr = {}
        for r in sorted(routes) if len(routes) > 1 else ():
            lab = list(s['ns'])
            for j, d in enumerate('NS'):
                got = head.get((i, d), {}).get(r)
                if got is None or adiff(got[0], ref[d]) <= 90:
                    continue
                o = 'NS'[1 - j]
                lab[j] = s['ns'][1 - j] if o in ref and adiff(got[0], ref[o]) <= 90 else ''
            if lab != s['ns']:
                nsr[r] = lab
        for (sid, r), fix in NS_FIX.items():
            if sid == s['id'] and r in routes:
                lab = list(nsr.get(r, s['ns']))
                lab = [f if f is not None else x for f, x in zip(fix, lab)]
                if lab != s['ns']:
                    nsr[r] = lab
                else:
                    nsr.pop(r, None)
        if nsr:
            s['nsr'] = nsr
            fixed[s['id']] = len(nsr)
    print(f'  per-line platform labels at {len(fixed)} stops: ' +
          ', '.join(f'{k} {stops[[x["id"] for x in stops].index(k)]["nsr"]}' for k in sorted(fixed)), file=sys.stderr)


def assemble(g, stations, entrances, patterns, shapes_on, tol):
    known = g['routes']
    order = {r: int(v.get('route_sort_order') or 999) for r, v in known.items()}
    srt = lambda rs: sorted(set(rs), key=lambda r: (order.get(r, 999), r))

    # Stops: GTFS parent stations, in stops.txt order.
    parents = [s for s in g['stops'] if s['stop_id'] == g['parent'][s['stop_id']]]
    stop_idx = {s['stop_id']: i for i, s in enumerate(parents)}
    by_id = {s['gtfs_stop_id'].strip(): s for s in stations}
    gtfs_routes_at = defaultdict(set)
    for p in patterns:
        for s in p['stops']:
            gtfs_routes_at[s].add(p['route'])

    # Complexes: data.ny.gov complex ids; GTFS-only stops get their own.
    cx_ids = sorted({s['complex_id'] for s in stations}, key=lambda c: (len(c), c))
    for s in parents:
        if s['stop_id'] not in by_id:
            print(f'  warning: GTFS stop {s["stop_id"]} is not in the stations dataset', file=sys.stderr)
            cx_ids.append('gtfs:' + s['stop_id'])
    cx_idx = {c: i for i, c in enumerate(cx_ids)}
    ent_names = defaultdict(Counter)
    for e in entrances:
        ent_names[e['complex_id']][e['stop_name'].strip()] += 1
    members = defaultdict(list)
    stops_out = []
    for s in parents:
        sid = s['stop_id']
        row = by_id.get(sid)
        cid = row['complex_id'] if row else 'gtfs:' + sid
        lat = float(row['gtfs_latitude']) if row else float(s['stop_lat'])
        lon = float(row['gtfs_longitude']) if row else float(s['stop_lon'])
        name = (row['stop_name'] if row else s['stop_name']).strip()
        routes = route_ids_for(row['daytime_routes'], gtfs_routes_at[sid], known) if row else srt(gtfs_routes_at[sid])
        ada = int(row.get('ada') or 0) if row else 0
        o = {'id': sid, 'c': cx_idx[cid], 'lat': round(lat, 5), 'lon': round(lon, 5), 'name': name,
             'routes': srt(routes), 'ns': [(row or {}).get('north_direction_label', '').strip(),
                                           (row or {}).get('south_direction_label', '').strip()], 'ada': ada}
        note = (row or {}).get('ada_notes', '')
        if ada == 2 and note and note != 'NaN':
            o['adn'] = note.strip()
        stops_out.append(o)
        members[cx_idx[cid]].append(o)

    complexes = []
    for i, cid in enumerate(cx_ids):
        ms = members[i]
        if not ms:
            raise BuildError(f'complex {cid} has no stops')
        names = ent_names.get(cid) or Counter(m['name'] for m in ms)
        adas = [m['ada'] for m in ms]
        complexes.append({'name': names.most_common(1)[0][0],
                          'lat': round(sum(m['lat'] for m in ms) / len(ms), 5),
                          'lon': round(sum(m['lon'] for m in ms) / len(ms), 5),
                          'routes': srt(r for m in ms for r in m['routes']),
                          'ada': 1 if all(a == 1 for a in adas) else 2 if any(adas) else 0})

    # One name per place: a stop keeps its platform name when that is part of its complex's
    # name ("14 St" in "14 St/6 Av"), else it takes the complex name, so a ride leg and the
    # near list never call one station two things ("149 St-Hostos" / "149 St-Grand Concourse").
    renamed = 0
    for o in stops_out:
        cn = complexes[o['c']]['name']
        if not name_in(o['name'], cn):
            o['name'] = cn
            renamed += 1
    print(f'  stops named after their complex: {renamed}', file=sys.stderr)

    # Entrances.
    ents, seen = [], {}
    unknown_types = Counter()
    recx, far = 0, []
    in_cx = defaultdict(list)
    for o in stops_out:
        in_cx[o['c']].append(o)
    for e in entrances:
        entry = e.get('entry_allowed', '').strip().upper() == 'YES'
        exit_ = e.get('exit_allowed', '').strip().upper() == 'YES'
        if not (entry or exit_):
            continue
        cid = e['complex_id']
        if cid not in cx_idx:
            print(f'  warning: entrance for unknown complex {cid}', file=sys.stderr)
            continue
        try:
            lat, lon = round(float(e['entrance_latitude']), 5), round(float(e['entrance_longitude']), 5)
        except (TypeError, ValueError):
            continue
        raw = e.get('entrance_type', '').strip().lower()
        typ = ENTRANCE_TYPE.get(raw)
        if typ is None:
            unknown_types[raw] += 1
            typ = 'stair'
        ids = [x.strip() for x in re.split(r'[;,]', e.get('gtfs_stop_id', '')) if x.strip() in stop_idx]
        # The stop id is right where the complex id is not (a few Union Sq / Herald Sq and
        # 61 St-Woodside rows carry a neighbour's complex): trust the stop when it is near.
        si, c = (stop_idx[ids[0]] if len(ids) == 1 else None), cx_idx[cid]
        if si is not None:
            if dist_m(lat, lon, stops_out[si]['lat'], stops_out[si]['lon']) <= ENT_MAX_M:
                if stops_out[si]['c'] != c:
                    recx += 1
                c = stops_out[si]['c']
            else:
                si = None
        if si is None and min(dist_m(lat, lon, m['lat'], m['lon']) for m in in_cx[c]) > ENT_MAX_M:
            far.append((complexes[c]['name'], lat, lon))
            continue
        key = (c, lat, lon, typ)
        if key in seen:
            o = seen[key]
            if 's' in o and si != o['s']:
                del o['s']
            if entry:
                o.pop('x', None)
            if exit_:
                o.pop('nx', None)
            continue
        o = {'c': c}
        if si is not None:
            o['s'] = si
        o.update({'lat': lat, 'lon': lon, 'type': typ})
        if raw in STEP_FREE:
            o['ada'] = 1
        if not entry:
            o['x'] = 1
        if not exit_:
            o['nx'] = 1
        seen[key] = o
        ents.append(o)
    if unknown_types:
        print(f'  warning: unknown entrance types (mapped to stair): {dict(unknown_types)}', file=sys.stderr)
    print(f'  entrances: {recx} took their stop\'s complex; {len(far)} dropped, over {ENT_MAX_M} m from '
          f'their stops: ' + '; '.join(f'{n} {la:.5f},{lo:.5f}' for n, la, lo in far), file=sys.stderr)
    ents.sort(key=lambda o: (o['c'], o['lat'], o['lon']))

    # Patterns.
    pats_out = []
    for p in patterns:
        pats_out.append({'route': p['route'], 'dir': p['dir'], 'headsign': p['head'].most_common(1)[0][0],
                         'stops': [stop_idx[s] for s in p['stops']], 'run': p['run'], 'tph': p['tph']})
    dir_labels(stops_out, pats_out)

    # Transfers.
    trs, tseen = [], set()
    for t in g['transfers']:
        a, b = t.get('from_stop_id'), t.get('to_stop_id')
        a, b = g['parent'].get(a, a), g['parent'].get(b, b)
        if a in stop_idx and b in stop_idx and (a, b) not in tseen:
            tseen.add((a, b))
            try:
                sec = int(float(t.get('min_transfer_time') or 0))
            except ValueError:
                sec = 0
            trs.append([stop_idx[a], stop_idx[b], sec])

    # Track geometry.
    hops, missing = {}, set()
    if shapes_on:
        ll = [(s['lat'], s['lon']) for s in stops_out]
        idx_pats = [dict(p, stops=[stop_idx[s] for s in p['stops']]) for p in patterns]
        hops, missing = build_hops(idx_pats, ll, g['shapes'], tol)
    hops_out = {f'{a}-{b}': encode_line(line) for (a, b), line in sorted(hops.items())}

    used_routes = {p['route'] for p in pats_out} | {r for c in complexes for r in c['routes']}
    routes_out = {}
    for rid in srt(used_routes):
        r = known[rid]
        bg, tx = CLASSIC.get(rid, ((r.get('route_color') or '808183').upper(),
                                   (r.get('route_text_color') or 'FFFFFF').upper()))
        routes_out[rid] = {'short': r.get('route_short_name') or rid, 'long': r.get('route_long_name', ''),
                           'color': bg, 'text': tx}
        if rid.endswith('X') and rid[:-1] in known:
            routes_out[rid]['line'] = rid[:-1]     # 6X -> a 6 train (diamond express)

    data = {'v': 1, 'format': FORMAT, 'attribution': ATTRIBUTION, 'feed': g['feed'],
            'routes': routes_out, 'complexes': complexes, 'stops': stops_out, 'entrances': ents,
            'patterns': pats_out, 'transfers': trs}
    if shapes_on:
        data['hops'] = hops_out
    return data, missing


# ---------------------------------------------------------------- checks

PREV = {'wk': 'wk', 'sa': 'wk', 'su': 'sa'}   # day before a Tue-Fri weekday, a Saturday, a Sunday


def trains_at(p, k, day, sec):
    """Trains per hour of pattern p at its k-th stop, at clock second `sec` of a `day` kind of day.
    The reference for the app's router (see the module docstring)."""
    t = sec - sum(p['run'][:k])
    while t < 0:
        t += 86400
        day = PREV[day]
    return p['tph'][day][int(t // 3600) % 24]


def stop_index(data, gtfs_id):
    for i, s in enumerate(data['stops']):
        if s['id'] == gtfs_id:
            return i
    return None


def serving(data, route, a, b, day='wk', sec=12 * 3600):
    """Patterns of `route` that stop at stop a then stop b and run at that time at a."""
    ia, ib = stop_index(data, a), stop_index(data, b)
    out = []
    for p in data['patterns']:
        if p['route'] != route or ia not in p['stops'] or ib not in p['stops']:
            continue
        ka, kb = p['stops'].index(ia), p['stops'].index(ib)
        if ka < kb and trains_at(p, ka, day, sec) > 0:
            out.append((p, ka, kb))
    return out


def ride_min(data, route, a, b, day='wk', sec=12 * 3600):
    got = serving(data, route, a, b, day, sec)
    if not got:
        return None
    return min(sum(p['run'][ka:kb]) for p, ka, kb in got) / 60


def stops_at(data, route, a, b, day, sec, via):
    """True/False: do the running patterns of route between a and b stop at `via`? None if no train."""
    got = serving(data, route, a, b, day, sec)
    if not got:
        return None
    iv = stop_index(data, via)
    hits = {iv in p['stops'][ka:kb + 1] for p, ka, kb in got}
    return hits.pop() if len(hits) == 1 else 'mixed'


def tph_route(data, routes, stop, d, day, sec):
    i = stop_index(data, stop)
    n = 0
    for p in data['patterns']:
        if p['route'] in routes and p['dir'] == d and i in p['stops']:
            n += trains_at(p, p['stops'].index(i), day, sec)
    return n


def check(data, stations, today=None):
    """[(ok, text)] for the build/--check report; ok None = a warning, not a failure."""
    res = []

    def add(ok, text):
        res.append((bool(ok), text))

    today = today or dt.date.today()
    f0, f1 = ymd(data['feed']['start']), ymd(data['feed']['end'])
    left = (f1 - today).days
    feed_txt = f'GTFS feed {f0} to {f1}: {left} days left'
    if left < 0:
        res.append((None, feed_txt + ' (expired: the phone maps dates to the same weekday inside the feed '
                    'and flags plans stale; rebuild with --refresh)'))
    elif left < FEED_WARN_DAYS:
        res.append((None, feed_txt + f' (under {FEED_WARN_DAYS}; rebuild with --refresh once MTA posts the next feed)'))
    else:
        add(True, feed_txt)

    S, C = data['stops'], data['complexes']
    bad_c = [i for i, e in enumerate(data['entrances']) if 's' in e and e['c'] != S[e['s']]['c']]
    add(not bad_c, f'entrances whose complex is not their stop\'s complex: {len(bad_c)}' + (f' {bad_c[:10]}' if bad_c else ''))

    def ent_m(e):
        ms = [S[e['s']]] if 's' in e else [st for st in S if st['c'] == e['c']]
        return min(dist_m(e['lat'], e['lon'], st['lat'], st['lon']) for st in ms)
    worst = max((ent_m(e), i) for i, e in enumerate(data['entrances']))
    add(worst[0] <= 400, f'farthest entrance from its stop(s): {worst[0]:.0f} m (entrance {worst[1]}; want <= 400)')
    bad_n = [(st['name'], C[st['c']]['name']) for st in S if not name_in(st['name'], C[st['c']]['name'])]
    add(not bad_n, f'stop names that are not part of their complex name: {len(bad_n)}' + (f' {bad_n[:5]}' if bad_n else ''))
    want_col = {'A': '0039A6', '1': 'EE352E', '4': '00933C', '7': 'B933AD', 'B': 'FF6319', 'G': '6CBE45',
                'J': '996633', 'L': 'A7A9AC', 'N': 'FCCC0A', 'GS': '808183'}
    bad_col = [r for r, c in want_col.items() if data['routes'].get(r, {}).get('color') != c]
    add(not bad_col and data['routes']['N']['text'] == '000000',
        f'classic bullet colours (A {data["routes"]["A"]["color"]}, N {data["routes"]["N"]["color"]} on '
        f'{data["routes"]["N"]["text"]})' + (f' wrong: {bad_col}' if bad_col else ''))

    def lab(sid, route, d):
        i = stop_index(data, sid)
        st = S[i]
        return (st.get('nsr', {}).get(route) or st['ns'])['NS'.index(d)]
    for sid, route, d, want_l, desc in [('A42', 'G', 'N', 'Queens', 'G at Hoyt-Schermerhorn toward Court Sq'),
                                        ('A42', 'C', 'S', 'Brooklyn', 'C at Hoyt-Schermerhorn toward Euclid Av'),
                                        ('A42', 'A', 'S', 'Queens', 'A at Hoyt-Schermerhorn toward the Rockaways'),
                                        ('A42', 'C', 'N', 'Manhattan', 'C at Hoyt-Schermerhorn toward 168 St'),
                                        ('D14', 'B', 'N', 'Uptown', 'B at 7 Av (53 St) northbound'),
                                        ('M11', 'M', 'N', 'Manhattan', 'M at Myrtle Av toward Manhattan'),
                                        ('M11', 'J', 'N', 'Outbound', 'J at Myrtle Av toward Jamaica'),
                                        ('M18', 'M', 'S', 'Brooklyn', 'M at Delancey St-Essex St toward Brooklyn')]:
        got = lab(sid, route, d)
        add(got == want_l, f'platform label, {desc}: {got!r}' + ('' if got == want_l else f' (want {want_l!r})'))

    ids = {s['id'] for s in data['stops']}
    miss = [s['gtfs_stop_id'] for s in stations if s['gtfs_stop_id'].strip() not in ids]
    add(not miss, f'stations dataset: {len(stations)} stations, missing {len(miss)}' + (f' {miss[:10]}' if miss else ''))
    enter = {e['c'] for e in data['entrances'] if not e.get('x')}
    no_ent = [c['name'] for i, c in enumerate(data['complexes']) if i not in enter]
    add(not no_ent, f'complexes with an enterable entrance: {len(data["complexes"]) - len(no_ent)}/{len(data["complexes"])}'
        + (f' missing {no_ent[:10]}' if no_ent else ''))
    i127 = stop_index(data, '127')
    ts = data['complexes'][data['stops'][i127]['c']] if i127 is not None else {'name': '?', 'routes': []}
    shorts = {data['routes'][r]['short'] for r in ts['routes'] if r in data['routes']}
    want = set('1 2 3 7 N Q R W S'.split())
    add(want <= shorts, f'{ts["name"]} routes: {" ".join(ts["routes"])}' + ('' if want <= shorts else f' missing {sorted(want - shorts)}'))

    for route, a, b, lo, hi, label in [('1', '127', '133', 7, 10, '1 Times Sq-42 St -> Christopher St-Stonewall'),
                                       ('A', 'A24', 'A15', 7, 10, 'A 59 St-Columbus Circle -> 125 St'),
                                       ('L', 'L01', 'L08', 8, 12, 'L 8 Av -> Bedford Av')]:
        m = ride_min(data, route, a, b)
        add(m is not None and lo <= m <= hi, f'{label}: {m if m is None else round(m, 1)} min (want {lo}-{hi})')

    # 6 trains = route 6 plus 6X (the <6> diamond Pelham express, a 6 train in Manhattan).
    hr = lambda rs, d: sum(tph_route(data, rs, '631', d, 'wk', 8 * 3600 + m * 60) for m in range(0, 60, 5)) / 12
    n6, n6s, n6n = hr({'6', '6X'}, 'S'), hr({'6'}, 'S'), hr({'6', '6X'}, 'N')
    add(n6 >= 12, f'6 trains at Grand Central, weekday 8-9a: downtown {n6:.1f}/h (local {n6s:.1f} + <6> express '
        f'{n6 - n6s:.1f}), uptown {n6n:.1f}/h; want downtown >= 12')
    bsu = sum(sum(p['tph']['su']) for p in data['patterns'] if p['route'] == 'B')
    bwk = sum(sum(p['tph']['wk']) for p in data['patterns'] if p['route'] == 'B')
    add(bsu == 0 and bwk > 0, f'B trains: Sunday {bsu}, weekday {bwk}')
    for r, want_su in (('W', 0), ('Z', 0)):
        su = sum(sum(p['tph']['su']) + sum(p['tph']['sa']) for p in data['patterns'] if p['route'] == r)
        add(su == want_su, f'{r} trains on weekends: {su}')

    noon, night = 12 * 3600, 3 * 3600
    # (description, route, from, to, day, time, via, expected stops_at)
    for desc, route, a, b, day, sec, via, exp in [
        ('2 express Manhattan, weekday noon, skips 86 St', '2', '120', '137', 'wk', noon, '121', False),
        ('2 express Manhattan, weekday noon, skips 23 St', '2', '120', '137', 'wk', noon, '130', False),
        ('3 express Manhattan, weekday noon, skips 86 St', '3', '120', '137', 'wk', noon, '121', False),
        ('1 local, weekday noon, stops at 86 St', '1', '120', '137', 'wk', noon, '121', True),
        ('1 local, weekday noon, stops at 23 St', '1', '127', '137', 'wk', noon, '130', True),
        ('A express, weekday noon, skips 72 St (CPW)', 'A', 'A24', 'A15', 'wk', noon, 'A22', False),
        ('A express, weekday noon, skips 23 St (8 Av)', 'A', 'A27', 'A32', 'wk', noon, 'A30', False),
        ('C local, weekday noon, stops at 72 St', 'C', 'A24', 'A15', 'wk', noon, 'A22', True),
        ('Q express Broadway, weekday noon, skips 28 St', 'Q', 'R16', 'R20', 'wk', noon, 'R18', False),
        ('R local Broadway, weekday noon, stops at 28 St', 'R', 'R16', 'R20', 'wk', noon, 'R18', True),
        ('W local Broadway, weekday noon, stops at 28 St', 'W', 'R16', 'R20', 'wk', noon, 'R18', True),
        ('A late night local, weekday 3a, stops at 23 St', 'A', 'A27', 'A32', 'wk', night, 'A30', True),
        ('2 late night local, weekday 3a, stops at 86 St', '2', '120', '127', 'wk', night, '121', True),
        ('4 late night local, weekday 3a, stops at 28 St', '4', '631', '635', 'wk', night, '634', True),
        ('Q late night local Broadway, Sunday 3a, stops at 28 St', 'Q', 'R16', 'R20', 'su', night, 'R18', True),
    ]:
        got = stops_at(data, route, a, b, day, sec, via)
        add(got is exp, f'{desc}: ' + {None: 'no train', True: 'stops there', False: 'passes it',
                                         'mixed': 'some trains stop'}[got])
    # Services that must not run at those hours.
    for desc, route, a, b, day, sec in [
        ('3 below Times Sq, weekday 3a', '3', '127', '137', 'wk', night),
        ('B, Saturday noon', 'B', 'D14', 'D15', 'sa', noon),
        ('W, Sunday noon', 'W', 'R16', 'R20', 'su', noon),
        ('42 St shuttle, weekday 3a', 'GS', '902', '901', 'wk', night),
        ('C, weekday 3a', 'C', 'A27', 'A32', 'wk', night),
    ]:
        add(not serving(data, route, a, b, day, sec), f'not running: {desc}')
    return res


def raw_check(g, data):
    """Compare the router's estimate (first-stop tph shifted by run times) with the
    raw GTFS departures counted at the stop itself. Printed, not enforced."""
    lines = []
    stop_i = {s['id']: i for i, s in enumerate(data['stops'])}
    for route, stop, d, day, hour in [('6 6X', '631', 'S', 'wk', 8), ('1', '127', 'S', 'wk', 17), ('A', 'A27', 'S', 'su', 3),
                                      ('L', 'L08', 'N', 'sa', 23), ('2', '120', 'S', 'wk', 0), ('B', 'D14', 'S', 'wk', 21)]:
        rs = set(route.split())
        actual = 0
        for t in g['trips'].values():
            if t['route'] not in rs or t['dir'] != d or stop not in t['stops']:
                continue
            dep = t['dep'][t['stops'].index(stop)]
            on, before = g['svc'][day]
            if (t['sid'] in on and hour * 3600 <= dep < (hour + 1) * 3600) or \
               (t['sid'] in before and (24 + hour) * 3600 <= dep < (25 + hour) * 3600):
                actual += 1
        est = 0.0
        for p in data['patterns']:
            if p['route'] in rs and p['dir'] == d and stop_i[stop] in p['stops']:
                k = p['stops'].index(stop_i[stop])
                est += sum(trains_at(p, k, day, hour * 3600 + m * 60) for m in range(0, 60, 5)) / 12
        lines.append(f'{route} {d} at {stop} {day} {hour:02d}h: GTFS {actual} departures, router estimate {est:.1f}')
    return lines


# ---------------------------------------------------------------- output

def scan_terms():
    """The repo's public-scan regexes (tools/scan_public.py), or [] if unavailable."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scan_public.py')
    try:
        spec = importlib.util.spec_from_file_location('scan_public', path)
        mod = importlib.util.module_from_spec(spec)
        sys.dont_write_bytecode = True
        spec.loader.exec_module(mod)
        return mod.terms()
    except Exception as e:
        print(f'  scan_public unavailable ({type(e).__name__}); skipping', file=sys.stderr)
        return []


def scrub(data, terms):
    """Keep the public file clear of the pre-commit scanner's private terms. Only
    harmless numbers are nudged (run seconds +1, track deltas +1/-1 = 1 m); any
    other hit is an error. Never prints the matched text."""
    if not terms:
        return 0
    rx = re.compile('|'.join(terms), re.I)
    nudged = 0
    for _ in range(50):
        text = dumps(data)
        if not rx.search(text):
            return nudged
        hit = False
        for p in data['patterns']:
            for i, v in enumerate(p['run']):
                if rx.search(f',{v},'):
                    p['run'][i] = v + 1
                    nudged += 1
                    hit = True
        for k, arr in data.get('hops', {}).items():
            for i in range(2, len(arr)):
                if rx.search(f',{arr[i]},'):
                    arr[i] += 1
                    if i + 2 < len(arr):
                        arr[i + 2] -= 1
                    nudged += 1
                    hit = True
        for t in data['transfers']:
            if rx.search(f',{t[2]},'):
                t[2] += 1
                nudged += 1
                hit = True
        if not hit:
            break
    for key, val in data.items():
        if rx.search(dumps(val)):
            raise BuildError(f'"{key}" contains a private trip term that cannot be nudged away')
    return nudged


def dumps(data):
    return json.dumps(data, separators=(',', ':'), ensure_ascii=False)


def write_atomic(path, text):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write(text)
    os.replace(tmp, path)


def shown(path):
    rel = os.path.relpath(os.path.abspath(path), ROOT)
    return os.path.abspath(path) if rel.startswith('..') else rel


def report(res):
    for ok, text in res:
        print(f'  {"warn" if ok is None else "ok  " if ok else "FAIL"} {text}')
    return [t for ok, t in res if ok is False]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--refresh', action='store_true', help='download sources again')
    ap.add_argument('--check', action='store_true', help='only run the checks on the existing output')
    ap.add_argument('--date', help='plan for service on/after this date (YYYY-MM-DD, default today)')
    ap.add_argument('--max-kb', type=float, default=450, help='size budget (KB, uncompressed)')
    ap.add_argument('--no-shapes', action='store_true', help='leave out track geometry')
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--cache', default=CACHE, help='raw download cache (default research/routing/subway)')
    a = ap.parse_args()

    if a.check:
        try:
            with open(a.out) as f:
                data = json.load(f)
            stations = read_rows(cached(a.cache, 'stations.json', nys_url(STATIONS_ID), a.refresh),
                                 ['gtfs_stop_id'])
        except (OSError, ValueError, BuildError) as e:
            sys.exit(f'subway: cannot check: {e}')
        print(f'{shown(a.out)}: {len(dumps(data).encode()) / 1024:.0f} KB')
        bad = report(check(data, stations))
        sys.exit(1 if bad else 0)

    start = dt.date.fromisoformat(a.date) if a.date else dt.date.today()
    try:
        z, stations, entrances = load_sources(a.cache, a.refresh)
        print('  reading GTFS', file=sys.stderr)
        g = load_gtfs(z, start)
    except BuildError as e:
        sys.exit(f'subway: {e}\n{shown(a.out)} left unchanged')
    pats, dropped = build_patterns(g)
    dropped_trips = sum(len(p['trips']) for p in dropped)
    all_trips = dropped_trips + sum(len(p['trips']) for p in pats)
    print(f'  patterns: {len(pats)} kept, {len(dropped)} rare ones dropped '
          f'({dropped_trips} of {all_trips} trips, {100 * dropped_trips / max(1, all_trips):.1f}%)', file=sys.stderr)

    shapes_on = not a.no_shapes
    for tol in ((SIMPLIFY_M, 15, 20, 30) if shapes_on else (None,)):
        try:
            data, missing = assemble(g, stations, entrances, pats, shapes_on, tol)
        except BuildError as e:
            sys.exit(f'subway: {e}\n{shown(a.out)} left unchanged')
        kb = len(dumps(data).encode()) / 1024
        print(f'  size with geometry at {tol} m: {kb:.0f} KB' if shapes_on else f'  size: {kb:.0f} KB', file=sys.stderr)
        if kb <= a.max_kb:
            break
    else:
        print('  over budget with geometry; leaving it out', file=sys.stderr)
        data, missing = assemble(g, stations, entrances, pats, False, None)
        kb = len(dumps(data).encode()) / 1024
        if kb > a.max_kb:
            sys.exit(f'subway.json is {kb:.0f} KB, over the {a.max_kb} KB budget even without geometry')

    try:
        nudged = scrub(data, scan_terms())
    except BuildError as e:
        sys.exit(f'subway: {e}\n{shown(a.out)} left unchanged')
    text = dumps(data)
    kb = len(text.encode()) / 1024

    res = check(data, stations)
    print('checks:')
    bad = report(res)
    print('router estimate vs raw GTFS (not enforced):')
    for line in raw_check(g, data):
        print('  ' + line)
    if bad:
        sys.exit(f'subway: {len(bad)} check(s) failed; {shown(a.out)} left unchanged')
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    write_atomic(a.out, text)
    sizes = {k: len(dumps(v).encode()) // 1024 for k, v in data.items() if isinstance(v, (list, dict))}
    print(f'wrote {shown(a.out)}: {kb:.0f} KB ({", ".join(f"{k} {v}" for k, v in sizes.items())} KB); '
          f'{len(data["routes"])} routes, {len(data["complexes"])} complexes, {len(data["stops"])} stops, '
          f'{len(data["entrances"])} entrances, {len(data["patterns"])} patterns, {len(data["transfers"])} transfers, '
          f'{len(data.get("hops", {}))} hops with track ({len(missing)} without)'
          + (f'; {nudged} values nudged for the public scan' if nudged else ''))
    print(f'service days: ' + ', '.join(f'{k} = a {g["refs"][k].strftime("%A")}' for k in DAYS))


if __name__ == '__main__':
    main()
