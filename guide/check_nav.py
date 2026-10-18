#!/usr/bin/env python3
"""Check an airport walking-navigation file (guide/nav/<CODE>.json).

  python3 guide/check_nav.py guide/nav/CLT.json [--from g-E12 --to bag-3]

Prints problems and a short summary; exits 1 when anything is wrong. With
--from/--to it also prints the walking route between two POIs (by id or ref)
so a person can sanity-check the distance and time against official maps.

Schema (all coordinates are WGS84 [lat, lon]):
  {schema:1, code, name, updated, source:{text, url}, refs:[{label, url}],
   center:[lat, lon], zoom, bbox:[s, w, n, e],
   levels:[{id:int, name, short}], default_level,
   areas:[{k, name, label?, level, geom:[ring, ...]}]   ring = [[lat, lon], ...], first ring outer
   lines:[{k, name, level, geom:[[lat, lon], ...]}]
   pois:[{id, k, name, ref?, level, lat, lon, node, side:'air'|'land', terminal?, concourse?, near?, note?, hours?}]
   graph:{nodes:[[id, lat, lon, level, name?]], edges:[[a, b, m, kind, note|null, sec|null]]}
   presets?:[{id, label, from, to, via?:[poi ids], when?:'depart'|'connect'|'arrive'}]
   tips?:[str]}
Edge kinds: walk moving escalator elevator stairs train security exit door outside.
'security' and 'exit' are one way (a -> b); everything else goes both ways.
"""
import heapq, json, math, sys

AREA_K = {'terminal', 'concourse', 'airside', 'landside', 'security', 'baggage', 'garage', 'platform', 'building', 'apron', 'walkway', 'curb', 'atrium', 'food_court', 'lounge'}
LINE_K = {'train', 'walkway', 'moving', 'road', 'curb', 'path'}
POI_K = {'gate', 'checkpoint', 'precheck', 'clear', 'restroom', 'family_restroom', 'food', 'coffee', 'bar', 'shop', 'water',
         'charging', 'baggage', 'elevator', 'escalator', 'stairs', 'info', 'lounge', 'bus', 'shuttle', 'taxi', 'rideshare', 'train',
         'parking', 'curb_dep', 'curb_arr', 'exit', 'nursing', 'pet_relief', 'pharmacy', 'atm', 'landmark', 'service', 'medical',
         'baggage_service', 'checkin', 'bagdrop', 'rental_car', 'subway', 'art', 'quiet', 'smoking', 'chapel', 'kids'}
EDGE_K = {'walk', 'moving', 'escalator', 'elevator', 'stairs', 'train', 'security', 'exit', 'door', 'outside'}
ONE_WAY = {'security', 'exit'}
SPEED = {'walk': 1.3, 'moving': 2.0, 'outside': 1.3, 'door': 1.3, 'stairs': 0.6}


def hav(a, b):
    R = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def secs(e):
    a, b, m, kind = e[0], e[1], e[2], e[3]
    sec = e[5] if len(e) > 5 else None
    if sec:
        return sec
    if kind == 'escalator':
        return 35
    if kind == 'elevator':
        return 75
    if kind == 'train':
        return 240
    if kind == 'security':
        return 900
    return m / SPEED.get(kind, 1.3)


def route(nav, a, b):
    adj = {}
    for e in nav['graph']['edges']:
        adj.setdefault(e[0], []).append((e[1], e))
        if e[3] not in ONE_WAY:
            adj.setdefault(e[1], []).append((e[0], e))
    dist, prev, q = {a: 0}, {}, [(0, a)]
    while q:
        d, n = heapq.heappop(q)
        if n == b:
            break
        if d > dist.get(n, 1e18):
            continue
        for m, e in adj.get(n, []):
            nd = d + secs(e)
            if nd < dist.get(m, 1e18):
                dist[m], prev[m] = nd, (n, e)
                heapq.heappush(q, (nd, m))
    if b not in dist:
        return None
    path, n = [], b
    while n != a:
        p, e = prev[n]
        path.append(e)
        n = p
    return dist[b], list(reversed(path))


def check(nav):
    bad = []
    say = bad.append
    for k in ('code', 'name', 'updated', 'source', 'center', 'bbox', 'levels', 'areas', 'pois', 'graph'):
        if k not in nav:
            say(f'missing top-level key {k}')
    if bad:
        return bad
    s, w, n, e = nav['bbox']
    inside = lambda lat, lon: s - 0.002 <= lat <= n + 0.002 and w - 0.002 <= lon <= e + 0.002
    levels = {l['id'] for l in nav['levels']}
    if nav.get('default_level', 0) not in levels:
        say('default_level is not one of levels')
    if 'ODbL' not in json.dumps(nav['source']) and 'OpenStreetMap' not in json.dumps(nav['source']):
        say('source must credit OpenStreetMap contributors (ODbL)')
    for i, a in enumerate(nav['areas']):
        if a.get('k') not in AREA_K:
            say(f"area {i} {a.get('name')}: unknown k {a.get('k')}")
        if a.get('level') not in levels:
            say(f"area {i} {a.get('name')}: level {a.get('level')} not in levels")
        rings = a.get('geom') or []
        if not rings or len(rings[0]) < 4:
            say(f"area {i} {a.get('name')}: polygon needs a closed outer ring")
        for r in rings:
            for p in r:
                if not inside(*p):
                    say(f"area {i} {a.get('name')}: point {p} outside bbox"); break
    for i, l in enumerate(nav.get('lines') or []):
        if l.get('k') not in LINE_K:
            say(f"line {i} {l.get('name')}: unknown k {l.get('k')}")
    nodes = {}
    for nd in nav['graph']['nodes']:
        if len(nd) < 4:
            say(f'node {nd}: needs [id, lat, lon, level]'); continue
        if nd[0] in nodes:
            say(f'duplicate node id {nd[0]}')
        if nd[3] not in levels:
            say(f'node {nd[0]}: level {nd[3]} not in levels')
        if not inside(nd[1], nd[2]):
            say(f'node {nd[0]}: outside bbox')
        nodes[nd[0]] = nd
    for e in nav['graph']['edges']:
        if len(e) < 4 or e[0] not in nodes or e[1] not in nodes:
            say(f'edge {e[:4]}: unknown node'); continue
        if e[3] not in EDGE_K:
            say(f'edge {e[:4]}: unknown kind')
        geo = hav(nodes[e[0]][1:3], nodes[e[1]][1:3])
        if e[3] in ('walk', 'moving', 'outside', 'door') and (abs(e[2] - geo) > max(8, 0.2 * geo)):
            say(f'edge {e[0]}->{e[1]}: says {e[2]} m but the points are {geo:.0f} m apart')
        if e[3] in ('walk', 'moving', 'door') and nodes[e[0]][3] != nodes[e[1]][3]:
            say(f'edge {e[0]}->{e[1]}: {e[3]} edge joins two levels; use escalator/elevator/stairs')
        if e[3] == 'walk' and geo > 400:
            say(f'edge {e[0]}->{e[1]}: {geo:.0f} m walk edge; split it at corners so the line follows the corridor')
    ids = set()
    for p in nav['pois']:
        pid = p.get('id')
        if pid in ids:
            say(f'duplicate poi id {pid}')
        ids.add(pid)
        if p.get('k') not in POI_K:
            say(f"poi {pid}: unknown k {p.get('k')}")
        if p.get('level') not in levels:
            say(f"poi {pid}: level {p.get('level')} not in levels")
        if p.get('side') not in ('air', 'land'):
            say(f"poi {pid}: side must be 'air' or 'land'")
        if p.get('node') not in nodes:
            say(f"poi {pid}: node {p.get('node')} not in graph"); continue
        nd = nodes[p['node']]
        if hav((p['lat'], p['lon']), nd[1:3]) > 60:
            say(f"poi {pid}: its node is {hav((p['lat'], p['lon']), nd[1:3]):.0f} m away")
        if p.get('k') == 'gate' and not p.get('ref'):
            say(f'poi {pid}: gate without ref')
    # Every POI must be reachable from every gate (airside) or from the curb (landside), via one-way security.
    gates = [p for p in nav['pois'] if p['k'] == 'gate' and p.get('node') in nodes]
    if gates:
        hub = gates[0]['node']
        for p in nav['pois']:
            if p.get('node') not in nodes:
                continue
            if p['side'] == 'air' and route(nav, hub, p['node']) is None:
                say(f"poi {p['id']}: can't walk there from gate {gates[0]['ref']}")
        land = [p for p in nav['pois'] if p['side'] == 'land' and p.get('node') in nodes]
        if land and route(nav, land[0]['node'], hub) is None:
            say(f"no route from {land[0]['id']} (landside) through security to the gates")
    for pr in nav.get('presets') or []:
        for k in ('from', 'to'):
            if pr.get(k) not in ids and not str(pr.get(k, '')).startswith('@'):
                say(f"preset {pr.get('id')}: {k} {pr.get(k)} is not a poi id")
    return bad


def find(nav, key):
    for p in nav['pois']:
        if p['id'] == key or (p.get('ref') and p['ref'].upper() == key.upper()):
            return p
    return None


def main(argv):
    if not argv:
        print(__doc__); return 2
    nav = json.load(open(argv[0]))
    bad = check(nav)
    for b in bad:
        print('  ✗', b)
    g = nav.get('graph', {})
    kinds = {}
    for p in nav.get('pois', []):
        kinds[p['k']] = kinds.get(p['k'], 0) + 1
    print(f"{nav.get('code')}: {len(nav.get('areas', []))} areas, {len(nav.get('pois', []))} pois, "
          f"{len(g.get('nodes', []))} nodes, {len(g.get('edges', []))} edges")
    print('  pois by kind:', ', '.join(f'{k} {v}' for k, v in sorted(kinds.items())))
    if '--from' in argv and '--to' in argv:
        a, b = find(nav, argv[argv.index('--from') + 1]), find(nav, argv[argv.index('--to') + 1])
        if not a or not b:
            print('  route: unknown poi'); return 1
        r = route(nav, a['node'], b['node'])
        if not r:
            print(f"  route {a['name']} -> {b['name']}: none"); return 1
        t, path = r
        m = sum(e[2] for e in path)
        print(f"  route {a['name']} -> {b['name']}: {m:.0f} m, {t / 60:.1f} min, {len(path)} edges, "
              f"kinds {sorted({e[3] for e in path})}")
    print('ok' if not bad else f'{len(bad)} problem(s)')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
