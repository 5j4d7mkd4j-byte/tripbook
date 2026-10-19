#!/usr/bin/env python3
"""Build the indoor airport maps: guide/indoor/raw/<CODE>/ -> guide/indoor/<CODE>.json (stdlib only).

usage
  python3 tools/indoor_build.py [CODE ...|all]          rebuild, validate and write guide/indoor/<CODE>.json
  python3 tools/indoor_build.py --check [CODE ...|all]  build in memory; print counts and failed checks only

Everything this reads and writes is gitignored venue data; this file holds code only.
  guide/indoor/src/config.json              per-airport settings (structures, levels, labels, airline hints)
  guide/indoor/raw/<CODE>/venueData.json    structures and floors
  guide/indoor/raw/<CODE>/nav.json          walk graph   {nodes:[{id,floorId,lat,lng}], edges:[{s,d,t,l,x,o,p}]}
  guide/indoor/raw/<CODE>/pois.json         points of interest
  guide/indoor/raw/<CODE>/geo/<floor>.json  floor polygons (GeoJSON)
  guide/indoor/raw/<CODE>/osm.json          terminal footprints, jet bridges, stands (imported once from cfg osm_src)

Output (coordinates [lon, lat], level ids are ints; consumed by N.airmap, app/src/screens/airmap.js):
  {v, code, name, levels:[{id,short,name}], defaultLevel, center, bbox, bearing, attribution,
   units:[{k,l,n?,g}], lines:[{k,l,g,ref?}], gates:[{ref,l,p,c,node,of?}], stands:[{ref,p,axis?}],
   pois:[{id,cat,k,l,p,n,node,sec,free?,hours?,near?,airline?,gate?}],
   graph:{nodes:[[id,lon,lat,l]], edges:[[a,b,m,kind,sec?,dir?]],
          lanes:[[a,b,'std'|'pre'|'clear'|'exit'|'customs',placeId|null]]},
   places:[{id,kind,label,level,node,p,poi,airline?,sec?}],
   presets:[{id,label,from,to,via?,when}]}          # endpoints: 'poi:<id>' | '@arr' | '@dep' | '@bag'
Edge kinds: walk outside door moving escalator elevator stairs train security exit. security and exit are
one-way a->b; an escalator with dir 'up'/'down' may only be ridden that way.
"""
import collections, heapq, json, math, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IND = os.path.join(ROOT, 'guide', 'indoor')
RAW = os.path.join(IND, 'raw')
CFG_PATH = os.path.join(IND, 'src', 'config.json')
R6 = lambda v: round(v, 6)

# engine cost model (mirrors N.airmap): m/s per walking kind, fixed seconds per vertical/screening kind
SPEED = {'walk': 1.3, 'outside': 1.3, 'door': 1.3, 'moving': 2.0, 'stairs': 0.6}
FIXED = {'escalator': 35, 'elevator': 75, 'train': 240, 'security': 900}
ONE_WAY = {'security', 'exit'}
VERT = {'escalator', 'elevator', 'stairs'}
WALKISH = {'walk', 'outside', 'door', 'moving'}
# screening edges carry no sec of their own: the engine prices std lanes (900 s) and PreCheck lanes (420 s, tsa=pre
# only) itself and never routes through a CLEAR lane; graph.lanes says which lane each security edge is
SNAP_MAX = 80.0                              # m: POIs farther than this from any walk node are dropped
MERGE_M = 30.0                               # m: same-kind places with the same label merge within this
CAT = {'family_restroom': 'restroom', 'quiet': 'lounge', 'pharmacy': 'shop'}   # curated kind -> filter category
NUMBERED = {'baggage', 'curb_dep', 'curb_arr', 'checkpoint', 'precheck', 'clear', 'exit', 'parking'}
NAMED = {'food', 'coffee', 'bar', 'shop', 'lounge', 'service', 'info', 'checkin', 'bagdrop', 'rental_car', 'bus',
         'shuttle', 'train', 'subway', 'landmark', 'kids', 'chapel', 'baggage_service', 'art'}
CURATED_UNITS = ['garage', 'atrium', 'food_court', 'walkway', 'hall']
PLACE_KINDS = ['curb_dep', 'curb_arr', 'checkin', 'checkpoint', 'precheck', 'clear', 'baggage', 'rideshare',
               'taxi', 'bus', 'shuttle', 'pickup', 'train', 'subway', 'parking', 'rental_car', 'exit']


# ------------------------------------------------------------------------------------------------ geometry
def meters(lon1, lat1, lon2, lat2):
    k = math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon2 - lon1) * k * 111320.0, (lat2 - lat1) * 110540.0)


class Proj:
    """Local equirectangular projection (metres) around a reference latitude."""
    def __init__(self, lat):
        self.kx = math.cos(math.radians(lat)) * 111320.0; self.ky = 110540.0

    def xy(self, p):
        return (p[0] * self.kx, p[1] * self.ky)


def pip(x, y, ring):
    inside = False; j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-30) + xi:
            inside = not inside
        j = i
    return inside


def in_rings(x, y, rings):
    if not rings or not pip(x, y, rings[0]): return False
    return not any(pip(x, y, h) for h in rings[1:])


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def ring_dist(px, py, ring):
    return min(seg_dist(px, py, *ring[i], *ring[i + 1]) for i in range(len(ring) - 1)) if len(ring) > 1 else 1e18


def dp(pts, tol):
    """Douglas-Peucker on [[x,y],...] (same units as tol)."""
    if len(pts) < 3: return list(pts)
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    st = [(0, len(pts) - 1)]
    while st:
        a, b = st.pop()
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            d = seg_dist(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1])
            if d > best: best, bi = d, i
        if best > tol:
            keep[bi] = True; st += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(ring, tol):
    if len(ring) < 5: return ring
    closed = ring[0] == ring[-1]
    r = ring[:-1] if closed else ring
    # split at the vertex farthest from the first so DP keeps a non-degenerate ring
    far = max(range(len(r)), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)
    out = dp(r[:far + 1], tol)[:-1] + dp(r[far:] + [r[0]], tol)
    return out if out[0] == out[-1] else out + [out[0]]


def area(ring):
    return abs(sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1))) / 2


def bezier(seg, n=8):
    """seg = {s,o,i,e} in [lat,lng]; returns [lon,lat] samples after the start."""
    s, o, i, e = seg['s'], seg['o'], seg['i'], seg['e']
    out = []
    for j in range(1, n + 1):
        t = j / n; u = 1 - t
        la = u ** 3 * s[0] + 3 * u * u * t * o[0] + 3 * u * t * t * i[0] + t ** 3 * e[0]
        ln = u ** 3 * s[1] + 3 * u * u * t * o[1] + 3 * u * t * t * i[1] + t ** 3 * e[1]
        out.append([ln, la])
    return out


def pca_axis(ring, prj):
    pts = [prj.xy(p) for p in ring[:-1]]
    cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - cx) ** 2 for p in pts); syy = sum((p[1] - cy) ** 2 for p in pts)
    sxy = sum((p[0] - cx) * (p[1] - cy) for p in pts)
    a = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ux, uy = math.cos(a), math.sin(a)
    ts = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in pts]
    t0, t1 = min(ts), max(ts)
    return [[R6((cx + t * ux) / prj.kx), R6((cy + t * uy) / prj.ky)] for t in (t0, t1)], t1 - t0


def best_bearing(pts):
    """Map bearing (deg) that makes the point cloud fit a ~390x520 portrait viewport best."""
    cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts)
    kx = math.cos(math.radians(cy))
    xy = [((p[0] - cx) * kx, p[1] - cy) for p in pts]
    best = None
    for b in range(-90, 91, 5):
        a = math.radians(b)
        xs = [x * math.cos(a) - y * math.sin(a) for x, y in xy]
        ys = [x * math.sin(a) + y * math.cos(a) for x, y in xy]
        s = min(390 / max(max(xs) - min(xs), 1e-9), 520 / max(max(ys) - min(ys), 1e-9))
        if best is None or s > best[0] + 1e-9: best = (s, b)
    return best[1]


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') or 'x'


def clean(name):
    n = re.sub(r'[®™]', '', name or '')
    return re.sub(r'\s+', ' ', n).strip()


# ------------------------------------------------------------------------------------------------ categories
def atr_kind(cat):
    """Atrius polygon category -> unit kind (None = not drawn)."""
    fixed = {'element.building': 'building', 'element.postsecurity': 'airside', 'element.presecurity': 'landside',
             'basemap.curb': 'curb', 'basemap.pedestriancrossing': 'curb', 'element.nonaccessible': 'void',
             'element.wall': 'wall', 'element.elevatorfootprint': 'vertical', 'element.escalatorfootprint': 'vertical',
             'element.stairsfootprint': 'vertical', 'element.rampfootprint': 'vertical',
             'element.portalfootprint': 'vertical', 'portal.movingwalkway': 'vertical',
             'element.opentobelow': 'opentobelow', 'element.ticketcounter': 'counter', 'element.desk': 'counter',
             'element.securitythreshold': 'security', 'element.door': None, 'element.arrows': None,
             'element': 'room', 'gate': 'gatearea', 'parking': 'garage', 'relax.lounge': 'lounge'}
    if cat in fixed: return fixed[cat]
    top = cat.split('.')[0]
    if top.startswith('label'): return None
    return {'eat': 'food', 'shop': 'shop', 'restroom': 'restroom', 'baggage': 'baggage', 'services': 'service',
            'relax': 'service', 'checkin': 'checkin', 'security': 'security'}.get(top, 'room')


POI_DROP = {'services.soapdispenser', 'services.aed', 'services.directory', 'baggage.cart', 'inactive', 'label',
            'label.section', 'label.floor', 'terminal', 'unoccupied', 'gate', 'portal.movingwalkway', 'portal.ramp',
            'services.bikerack', 'services.mailbox', 'services.lottery', 'security.employee'}


BR = {}     # brand/word regexes from config 'words' (coffee, pharmacy, rideshare, paid_lounge, transit_card)


def rx(key, generic):
    extra = BR.get(key) or []
    return '|'.join([generic] + [re.escape(w) for w in extra])


def poi_kind(cat, name):
    """raw category + name -> (cat, k) in the output vocabulary, or None to drop."""
    n = name.lower()
    if cat in POI_DROP or cat.startswith('art'): return None
    if cat == 'eat.coffee' or (cat.startswith('eat') and re.search(rx('coffee', r'coffee|espresso|cafe '), n)):
        return 'coffee', 'coffee'
    if cat == 'eat.bar': return 'bar', 'bar'
    if cat == 'eat.vending': return 'vending', 'vending'
    if cat.startswith('eat'): return 'food', 'food'
    if cat in ('restroom.family', 'restroom.unisex', 'restroom.accessible'): return 'restroom', 'family_restroom'
    if cat.startswith('restroom'): return 'restroom', 'restroom'
    if cat in ('services.waterrefill', 'services.drinkingfountain', 'services.water'): return 'water', 'water'
    if cat.startswith('shop'):
        return ('shop', 'pharmacy') if re.search(rx('pharmacy', r'pharm|drug|rx\b'), n) else ('shop', 'shop')
    if cat in ('services.chargingstation', 'services.charging'): return 'charging', 'charging'
    if cat == 'relax.lounge' or (cat == 'relax' and re.search(r'\blounge|\bclub|\buso\b', n)): return 'lounge', 'lounge'
    if cat in ('services.information', 'services.info', 'services.meetingpoint'): return 'info', 'info'
    if cat == 'security.exit': return 'exit', 'exit'
    if re.search(r'passport control|customs|\bcbp\b', n) or cat == 'security.passportcontrol': return 'customs', 'customs'
    if cat.startswith('security'):
        if 'precheck' in n.replace(' ', ''): return 'precheck', 'precheck'
        if re.search(r'\bclear\b', n): return 'clear', 'clear'
        return 'checkpoint', 'checkpoint'
    if cat == 'baggage.drop': return 'bagdrop', 'bagdrop'
    if cat.startswith('checkin') or cat.startswith('ticketing'):
        return ('checkin', 'kiosk') if 'kiosk' in cat or 'kiosk' in n else ('checkin', 'checkin')
    if cat == 'baggage.claim': return 'baggage', 'baggage'
    if cat.startswith('baggage'): return 'baggage_service', 'baggage_service'
    if cat == 'services.rentalcar': return 'rental_car', 'rental_car'
    if BR.get('transit_card') and re.search(rx('transit_card', r'(?!)'), n): return 'service', 'service'
    if cat == 'transport.sharedride': return 'rideshare', 'rideshare'
    if cat == 'transport.taxi': return 'taxi', 'taxi'
    if cat == 'transport.valet': return 'parking', 'valet'
    if cat in ('transport.train', 'portal.train'): return 'train', 'train'
    if cat.startswith('transport') or cat == 'portal.bus':
        if re.search(r'employee|crew', n): return None
        if 'subway' in n: return 'subway', 'subway'
        if re.search(rx('rideshare', r'ride ?share|app ride'), n) and 'shuttle' not in n: return 'rideshare', 'rideshare'
        if 'taxi' in n: return 'taxi', 'taxi'
        if cat == 'transport.passengerpickup' or re.search(r'prearranged|courtesy|pick ?up', n): return 'pickup', 'pickup'
        if 'shuttle' in cat or 'shuttle' in n: return 'shuttle', 'shuttle'
        return 'bus', 'bus'
    if cat.startswith('parking'):
        return None if re.search(r'employee|crew', n) else ('parking', 'parking')
    if cat == 'portal.elevator': return 'elevator', 'elevator'
    if cat == 'portal.escalator': return 'escalator', 'escalator'
    if cat == 'portal.stairs': return 'stairs', 'stairs'
    if cat.startswith('portal'): return None
    if cat == 'element.door': return 'door', 'door'
    if cat == 'services.atm': return 'atm', 'atm'
    if cat == 'services.smokingarea': return 'smoking', 'smoking'
    if 'mothersroom' in cat or 'lactation' in n: return 'nursing', 'nursing'
    if 'animalrelief' in cat or 'pet relief' in n: return 'pet_relief', 'pet_relief'
    if 'prayer' in cat or 'chapel' in n or 'meditation' in n: return 'chapel', 'chapel'
    if cat == 'relax.childrensplayarea': return 'kids', 'kids'
    if cat.startswith('relax'): return 'lounge', 'quiet'
    return 'service', 'service'


PAID_GENERIC = ('lounge', 'club', 'spa', 'priority', 'paid', 'suites')
LOUNGE_UNIT = r'\blounge\b|\bclub\b|\buso\b'


def paid_words(generic=True):
    return tuple(BR.get('paid_lounge') or ()) + (PAID_GENERIC if generic else ('paid',))


def fmt_hours(s):
    def t(x):
        if x.lower() == 'lastflight': return 'last flight'
        h, m = int(x[:2]), int(x[3:5])
        h %= 24
        ap = 'a' if h < 12 else 'p'
        h12 = h % 12 or 12
        return f'{h12}{":%02d" % m if m else ""}{ap}'
    parts = []
    for r in [r.strip() for r in str(s).split(';') if r.strip()]:
        m = re.match(r'^([A-Za-z,\- ]+?)\s+(\d\d:\d\d|lastFlight)\s*-\s*(\d\d:\d\d|lastFlight)$', r)
        if not m: return clean(str(s))[:48]
        d, a, b = m.groups()
        rng = '24 hours' if a == '00:00' and b in ('24:00', '23:59') else f'{t(a)}–{t(b)}'
        parts.append((d.strip(), rng))
    if not parts: return None
    if len(parts) == 1: return parts[0][1] if parts[0][0] == 'Mo-Su' else f'{parts[0][0]} {parts[0][1]}'
    return '; '.join(f'{d} {r}' for d, r in parts)


def gate_ids_from(name, kws):
    ids = [k.split(':', 1)[1].strip().upper() for k in kws if k.lower().startswith('gate:')]
    nm = re.sub(r'^gates?\s+', '', name.strip(), flags=re.I)
    m = re.match(r'^([A-Z]?)(\d+)\s*([A-Z](?:\s*,\s*[A-Z])*)?$', nm.strip(), flags=re.I)
    toks = [t.strip().upper() for t in re.split(r'\s*,\s*', nm) if t.strip()]
    primary = None
    if m and m.group(3) and ',' in m.group(3):
        primary = (m.group(1) + m.group(2)).upper()
        ids += [primary + x.strip().upper() for x in m.group(3).split(',')]
    elif toks:
        primary = toks[0]
        if len(toks) > 1:
            b = re.match(r'^([A-Z]?\d+)', toks[0])
            if b: primary = b.group(1)
            ids += toks
    if not primary or not re.match(r'^[A-Z]?\d+[A-Z]?$', primary): return None, []
    base = re.match(r'^([A-Z]?\d+)', primary).group(1)
    alias = sorted(set(i for i in ids if i and i != primary and i.startswith(base) and re.match(r'^[A-Z]?\d+[A-Z]?$', i)))
    return primary, alias


def gkey(ref):
    m = re.match(r'^([A-Z]?)(\d+)(.*)$', ref)
    return (m.group(1), int(m.group(2)), m.group(3)) if m else (ref, 0, '')


STOP = {'the', 'and', 'bar', 'grill', 'cafe', 'kitchen', 'restaurant', 'airport', 'terminal', 'gate', 'gates', 'shop',
        'store', 'market', 'express', 'check', 'counter', 'level', 'near', 'from', 'air', 'airline', 'airlines', 'lines',
        'airways', 'desk', 'area', 'east', 'west', 'north', 'south', 'center', 'main'}
GROUP = {'bagdrop': 'checkin', 'curb_dep': 'curb', 'curb_arr': 'curb', 'door': 'curb', 'pickup': 'curb'}
NUMBERED_G = {'baggage', 'curb', 'checkpoint', 'precheck', 'clear', 'exit', 'parking'}


def name_toks(s):
    s = clean(s).lower().replace("'", '').replace('\u2019', '')
    return {t for t in re.findall(r'[a-z0-9]+', s) if len(t) >= 3 and t not in STOP and not t.isdigit()}


def ref_of(s):
    m = re.search(r'\b(?:checkpoint|doors?|carousel|claim|zone|exit|lot)\s*#?\s*([a-z]?\d+[a-z]?|[a-z])\b', (s or '').lower())
    return m.group(1) if m else None


def best_match(o, cands):
    """The curated POI that an Atrius POI duplicates (same level, compatible kind, close, same name/number)."""
    g = GROUP.get(o['cat'], o['cat'])
    ro = ref_of(o['n']) or ref_of(o.get('near'))
    to = name_toks(o['n'])
    best = None
    for c in cands:
        if c['l'] != o['l'] or GROUP.get(c['cat'], c['cat']) != g: continue
        d = meters(*o['p'], *c['p'])
        if d > 150: continue
        if g in NUMBERED_G:
            rc = ref_of(c['n']) or ref_of(c.get('near'))
            ok = (ro == rc and d < 80) if ro and rc else d < 25
        elif g in NAMED:
            ok = (d < 80 and bool(to & name_toks(c['n']))) or d < 6
        else:
            ok = d < 25
        if ok and (best is None or d < best[0]): best = (d, c)
    return best[1] if best else None


def short_label(n):
    """<= 28 characters: drop parentheticals (keeping a door number), then cut at a word boundary."""
    n = clean(n)
    if len(n) <= 28: return n
    door = re.search(r'\b(doors?\s+\d+(?:\s*(?:[–-]|and|&)\s*\d+)?)', n, re.I)
    b = re.sub(r'\s*\([^)]*\)', '', n).strip(' ,')
    b = re.split(r'\s+[-–—]\s+|:\s', b)[0].strip(' ,')
    if door and door.group(1).lower() not in b.lower() and len(b) + len(door.group(1)) + 2 <= 28:
        d = door.group(1); b = f'{b}, {d[0].upper()}{d[1:]}'
    if len(b) > 28:
        w = b[:29].rsplit(' ', 1)[0]
        w = re.sub(r'(?:[\s,]+(?:and|or|the|of|to|by|for|with|&))+$', '', w).strip(' ,')
        b = w if len(w) >= 8 else b[:27].rstrip(' ,') + '…'
    return b


# ------------------------------------------------------------------------------------------------ io
def load_json(p):
    with open(p, encoding='utf-8') as f: return json.load(f)


def write_atomic(path, s):
    d, b = os.path.split(path)
    tmp = os.path.join(d, '.' + b + '.tmp')        # never *.json at the top level: build.mjs seals those
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(s); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)


def osm_import(code, C):
    """Copy the terminal footprints, jet bridges and parking positions out of the configured OSM extract."""
    dst = os.path.join(RAW, code, 'osm.json')
    if os.path.exists(dst) or not C.get('osm_src'): return dst
    src = os.path.join(ROOT, C['osm_src'])
    if not os.path.exists(src): return dst
    els = [e for e in load_json(src)['elements']
           if e.get('tags', {}).get('aeroway') in ('terminal', 'jet_bridge', 'parking_position')]
    write_atomic(dst, json.dumps({'elements': els}, separators=(',', ':'), ensure_ascii=False))
    return dst


def curated_import(code, C):
    """Copy the hand-curated map (ids, notes, presets) into raw/<CODE>/curated.json when missing or older."""
    dst = os.path.join(RAW, code, 'curated.json')
    src = os.path.join(ROOT, C.get('curated_src') or os.path.join('guide', 'nav', code + '.json'))
    if os.path.exists(src) and (not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst)):
        with open(src, encoding='utf-8') as f: write_atomic(dst, f.read())
    return load_json(dst) if os.path.exists(dst) else None


def rings_of(geom):
    """curated [lat,lon] ring or list of rings -> [[lon,lat],...] rings."""
    if not geom: return []
    rings = geom if isinstance(geom[0][0], list) else [geom]
    out = []
    for r in rings:
        g = [[R6(p[1]), R6(p[0])] for p in r]
        if g and g[0] != g[-1]: g.append(g[0])
        if len(g) >= 4: out.append(g)
    return out


def osm_extras(path, C, gate_level):
    units, lines, stands = [], [], []
    if not os.path.exists(path): return units, lines, stands
    fp = C.get('osm_footprints')
    for e in load_json(path)['elements']:
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('aeroway') == 'terminal' and 'geometry' in e and t.get('building') != 'bridge':
            g = [[R6(p['lon']), R6(p['lat'])] for p in e['geometry']]
            if g[0] == g[-1] and len(g) > 3 and (fp is None or t.get('name') in fp):
                units.append({'k': 'footprint', 'l': None, 'n': t.get('name'), 'g': [g]})
        if e['type'] == 'way' and t.get('aeroway') == 'jet_bridge' and 'geometry' in e and C.get('osm_jetbridges'):
            ref = t.get('ref')
            lines.append({'k': 'jetbridge', 'l': gate_level.get(ref), 'ref': ref,
                          'g': [[R6(p['lon']), R6(p['lat'])] for p in e['geometry']]})
        if t.get('aeroway') == 'parking_position' and t.get('ref'):
            if e['type'] == 'node':
                stands.append({'ref': t['ref'], 'p': [R6(e['lon']), R6(e['lat'])]})
            elif 'geometry' in e:
                g = e['geometry']
                stands.append({'ref': t['ref'], 'p': [R6(g[-1]['lon']), R6(g[-1]['lat'])],
                               'axis': [[R6(g[0]['lon']), R6(g[0]['lat'])], [R6(g[-1]['lon']), R6(g[-1]['lat'])]]})
    if C.get('stands_gates_only'):
        stands = [s for s in stands if s['ref'] in gate_level]
    return units, lines, stands


# ------------------------------------------------------------------------------------------------ graph
class Graph:
    def __init__(self):
        self.pos = []; self.lvl = []; self.E = []      # E: dict(a,b,m,k,sec,dir,one,lane)

    def add_node(self, p, l):
        self.pos.append(p); self.lvl.append(l); return len(self.pos) - 1

    def adj(self, alive=None, skip=()):
        A = collections.defaultdict(list)
        for i, e in enumerate(self.E):
            if e is None or e['k'] in skip: continue
            A[e['a']].append((e['b'], i))
            if not e['one']: A[e['b']].append((e['a'], i))
        return A

    def radj(self):
        A = collections.defaultdict(list)
        for i, e in enumerate(self.E):
            if e is None: continue
            A[e['b']].append((e['a'], i))
            if not e['one']: A[e['a']].append((e['b'], i))
        return A


def cost(G, e, frm):
    if e['k'] == 'escalator' and e['dir']:
        to = e['b'] if frm == e['a'] else e['a']
        up = G.lvl[to] > G.lvl[frm]
        if (e['dir'] == 'up') != up: return math.inf
    if e['k'] == 'security': return e['sec'] or FIXED['security']
    if e['k'] in FIXED: return e['sec'] or FIXED[e['k']]
    if e['sec']: return e['sec']
    return e['m'] / SPEED.get(e['k'], 1.3)


def dijkstra(G, A, srcs, skip=()):
    dist = {}; prev = {}
    pq = [(0.0, s, -1) for s in srcs]
    heapq.heapify(pq)
    while pq:
        d, u, pe = heapq.heappop(pq)
        if u in dist: continue
        dist[u] = d; prev[u] = pe
        for v, ei in A[u]:
            e = G.E[ei]
            if v in dist or e['k'] in skip: continue
            c = cost(G, e, u)
            if c < math.inf: heapq.heappush(pq, (d + c, v, ei))
    return dist, prev


def path_edges(G, prev, t):
    out = []; u = t
    while prev.get(u, -1) != -1:
        ei = prev[u]; out.append(ei)
        e = G.E[ei]; u = e['a'] if e['b'] == u else e['b']
    return out[::-1]


def reach(A, starts, G=None, skip=()):
    seen = set(starts); st = list(starts)
    while st:
        u = st.pop()
        for v, ei in A[u]:
            if G is not None and G.E[ei]['k'] in skip: continue
            if v not in seen: seen.add(v); st.append(v)
    return seen


# ------------------------------------------------------------------------------------------------ build
def build(code, CFG):
    C = CFG[code]
    AL = CFG['airline']
    BR.clear(); BR.update(CFG.get('words') or {})
    raw = os.path.join(RAW, code)
    venue = load_json(os.path.join(raw, 'venueData.json'))[C['venue']]
    nav = load_json(os.path.join(raw, 'nav.json'))
    pois = load_json(os.path.join(raw, 'pois.json'))
    cur = curated_import(code, C)
    rep = collections.OrderedDict()
    fails = []

    floor2lvl = {f: L['id'] for L in C['levels'] for f in L['floors']}
    lvl_ids = [L['id'] for L in C['levels']]
    dep_l, arr_l = C['dep_level'], C['arr_level']

    # clip region: the included structures' bounds (raw [lat,lng]) + 60 m (units) / 250 m (POIs)
    srings = []
    for sid in C['structs']:
        s = venue['structures'].get(sid) or {}
        if s.get('boundsPolygon'):
            r = [[p[1], p[0]] for p in s['boundsPolygon']]
            if r[0] != r[-1]: r.append(r[0])
            srings.append(r)
    lat0 = sum(p[1] for r in srings for p in r) / max(1, sum(len(r) for r in srings))
    prj = Proj(lat0)
    srings_xy = [[prj.xy(p) for p in r] for r in srings]

    def clip_d(lon, lat):
        x, y = prj.xy((lon, lat))
        if any(pip(x, y, r) for r in srings_xy): return 0.0
        return min(ring_dist(x, y, r) for r in srings_xy)

    # ---------------------------------------------------------------- units, moving walkways, building outlines
    units, lines = [], []
    bld = collections.defaultdict(list)     # level -> [ring_xy] building outlines (edge kinds)
    movers = collections.defaultdict(list)  # level -> [ring_xy]
    tol = 1.5e-6
    for L in C['levels']:
        for fid in L['floors']:
            p = os.path.join(raw, 'geo', fid + '.json')
            if not os.path.exists(p): fails.append(f'geo missing for a floor'); continue
            gj = load_json(p)
            names = {}
            for ft in gj['features']:
                pr = ft['properties']
                if ft['geometry']['type'] == 'Point' and pr.get('text'):
                    names[pr.get('id')] = clean(str(pr['text']).replace('\n', ' '))
            for ft in gj['features']:
                gt = ft['geometry']['type']
                if gt not in ('Polygon', 'MultiPolygon'): continue
                pr = ft['properties']; cat = pr.get('category') or ''
                k = atr_kind(cat)
                if not k: continue
                polys = [ft['geometry']['coordinates']] if gt == 'Polygon' else ft['geometry']['coordinates']
                for poly in polys:
                    if not poly or len(poly[0]) < 4: continue
                    outer = [[c[0], c[1]] for c in poly[0]]
                    mx = sum(c[0] for c in outer[:-1]) / (len(outer) - 1); my = sum(c[1] for c in outer[:-1]) / (len(outer) - 1)
                    if clip_d(mx, my) > 60: continue
                    rings = []
                    for r in poly:
                        r2 = [[c[0], c[1]] for c in r]
                        if len(r2) > 12: r2 = simplify_ring(r2, tol)
                        if len(r2) >= 4: rings.append([[R6(x), R6(y)] for x, y in r2])
                    if not rings or area([prj.xy(c) for c in rings[0]]) < 0.05: continue
                    u = {'k': k, 'l': L['id'], 'g': rings}
                    nm = names.get(pr.get('id'))
                    if nm and k not in ('gatearea', 'vertical', 'void', 'wall', 'building', 'airside', 'landside'):
                        u['n'] = nm
                    units.append(u)
                    if cat == 'element.building':
                        bld[L['id']].append([prj.xy(c) for c in poly[0]])
                    if cat == 'portal.movingwalkway':
                        movers[L['id']].append([prj.xy(c) for c in poly[0]])
                        ax, ln = pca_axis(rings[0], prj)
                        if ln > 8: lines.append({'k': 'moving', 'l': L['id'], 'g': ax})

    # ---------------------------------------------------------------- walk graph
    G = Graph()
    rawid = {}
    for n in nav['nodes']:
        if n['floorId'] in floor2lvl:
            rawid[n['id']] = G.add_node((n['lng'], n['lat']), floor2lvl[n['floorId']])
    dedges = {}
    for e in nav['edges']:
        if e['s'] in rawid and e['d'] in rawid and e['s'] != e['d']:
            dedges[(rawid[e['s']], rawid[e['d']])] = e
    MODE = {'': 'walk', 'Ramp': 'walk', 'Elevator': 'elevator', 'Escalator': 'escalator', 'Stairs': 'stairs',
            'Train': 'train', 'Bus': 'train'}
    pre = collections.Counter()
    pre['nodes'] = len(G.pos)
    recs = []          # (a, b, mode, one, x, wait_min, o, pts)
    done = set()
    for (a, b), e in dedges.items():
        if (a, b) in done: continue
        rv = dedges.get((b, a))
        t = e.get('t', '') or ''
        same = rv is not None and (rv.get('t', '') or '') == t and bool(rv.get('x')) == bool(e.get('x')) \
            and (rv.get('l') or 0) == (e.get('l') or 0)
        if rv is None and t in ('Elevator', 'Stairs', 'Ramp', 'Train', 'Bus'): same = True   # these run both ways
        done.add((a, b))
        if same: done.add((b, a))
        pts = None
        if e.get('p'):
            pts = [[e['p'][0]['s'][1], e['p'][0]['s'][0]]]
            for seg in e['p']: pts += bezier(seg)
            pts[0] = list(G.pos[a]); pts[-1] = list(G.pos[b])
        recs.append(dict(a=a, b=b, t=t, one=not same, x=bool(e.get('x')), l=e.get('l') or 0,
                         o=str(e['o']) if e.get('o') else None, pts=pts))
    pre['edges'] = len(recs)
    pre['closed_dropped'] = sum(1 for r in recs if r['l'] >= 900 and not r['x'])
    recs = [r for r in recs if r['l'] < 900 or r['x']]
    if C.get('bus_edges') != 'train':          # a road shuttle hop is not a walking link: drop it unless told
        nb = sum(1 for r in recs if r['t'] == 'Bus')
        if nb: rep['bus_edges_dropped'] = nb
        recs = [r for r in recs if r['t'] != 'Bus']

    def inside_any(level, xy, polys):
        return any(pip(xy[0], xy[1], r) for r in polys.get(level, ()))

    # curated moving-walkway centrelines (used when the floor plans carry no walkway polygons)
    mv_lines = collections.defaultdict(list)
    for L in (cur or {}).get('lines') or []:
        if L.get('k') == 'moving' and len(L.get('geom') or []) >= 2:
            mv_lines[L.get('level')].append([prj.xy((c[1], c[0])) for c in L['geom']])

    def on_mover_line(level, a, b):
        ax, ay = prj.xy(a); bx, by = prj.xy(b)
        ln = math.hypot(bx - ax, by - ay)
        if ln < 20: return False                 # a walkway edge is one long straight hop beside the centreline
        for pl in mv_lines.get(level, ()):
            lx, ly = pl[-1][0] - pl[0][0], pl[-1][1] - pl[0][1]
            ll = math.hypot(lx, ly)
            if ll < 10 or abs(((bx - ax) * lx + (by - ay) * ly) / (ln * ll)) < 0.97: continue
            if all(min(seg_dist(ax + (bx - ax) * f, ay + (by - ay) * f, *pl[i], *pl[i + 1]) for i in range(len(pl) - 1)) <= 6.0
                   for f in (0.25, 0.5, 0.75)):
                return True
        return False

    def walk_kind(level, pts):
        if level in movers and len(pts) >= 2:
            smp = [((pts[0][0] * (1 - f) + pts[-1][0] * f), (pts[0][1] * (1 - f) + pts[-1][1] * f))
                   for f in (0.0, 0.25, 0.5, 0.75, 1.0)]
            if sum(inside_any(level, prj.xy(p), movers) for p in smp) >= 4: return 'moving'
        if level in mv_lines and len(pts) >= 2 and on_mover_line(level, pts[0], pts[-1]):
            return 'moving'
        if level not in bld: return 'walk'
        a_in = inside_any(level, prj.xy(pts[0]), bld); b_in = inside_any(level, prj.xy(pts[-1]), bld)
        mid = pts[len(pts) // 2] if len(pts) > 2 else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
        m_in = inside_any(level, prj.xy(mid), bld)
        if a_in != b_in: return 'door'
        if not a_in and not b_in and not m_in: return 'outside'
        return 'walk'

    # zones before lane collapse: landside = reachable from landside anchors without crossing x edges
    def nearest(lon, lat, level, cand=None, maxd=None):
        best = (None, math.inf)
        for i in (cand if cand is not None else range(len(G.pos))):
            if G.lvl[i] != level: continue
            d = meters(lon, lat, *G.pos[i])
            if d < best[1]: best = (i, d)
        if maxd is not None and best[1] > maxd: return None, best[1]
        return best

    A0 = collections.defaultdict(list)
    for r in recs:
        if r['x']: continue
        A0[r['a']].append(r['b'])
        if not r['one']: A0[r['b']].append(r['a'])
    seeds = set()
    for v in pois.values():
        fl = v['position']['floorId']
        if fl not in floor2lvl or v.get('isAfterSecurity'): continue
        if not re.match(r'(element\.door|checkin|baggage\.claim|transport|ticketing)', v['category']): continue
        n, d = nearest(v['position']['longitude'], v['position']['latitude'], floor2lvl[fl])
        if n is not None and d < 25: seeds.add(n)
    land0 = set(seeds); st = list(seeds)
    while st:
        u = st.pop()
        for v in A0[u]:
            if v not in land0: land0.add(v); st.append(v)

    # screening lanes the source omits (config synth_lanes: source POI ids): a one-way hop from a new node at
    # the POI to the nearest airside node; the new node joins the nearest landside node with a short walk
    synth = []
    xnodes = {r['a'] for r in recs if r['x']} | {r['b'] for r in recs if r['x']}
    used = set()
    for e in recs: used.add(e['a']); used.add(e['b'])
    air_c = [i for i in used if i not in land0 and i not in xnodes]
    land_c = [i for i in land0 if i not in xnodes]
    for pid in C.get('synth_lanes') or []:
        v = pois.get(str(pid))
        if not v or v['position']['floorId'] not in floor2lvl: fails.append('synth lane POI missing'); continue
        lv = floor2lvl[v['position']['floorId']]; lon, lat = v['position']['longitude'], v['position']['latitude']
        ln_, dl = nearest(lon, lat, lv, land_c, 20)
        an_, da = nearest(lon, lat, lv, air_c, 60)
        if an_ is not None: air_c.remove(an_)       # one airside node per lane: lanes sharing a node would merge
        if ln_ is None or an_ is None: fails.append('synth lane without landside/airside node'); continue
        s = G.add_node((lon, lat), lv)
        recs.append(dict(a=s, b=ln_, t='', one=False, x=False, l=0, o=None, pts=None))
        recs.append(dict(a=s, b=an_, t='', one=True, x=True, l=0, o=str(pid), pts=None))
        land0.add(s); synth.append(round(da))
    if synth: rep['lanes_synthesized_m'] = synth

    # x-edge components = screening lanes (landside -> airside) or exit lanes (airside -> landside)
    xr = [r for r in recs if r['x']]
    par = {}

    def fnd(x):
        while par.setdefault(x, x) != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    for r in xr: par[fnd(r['a'])] = fnd(r['b'])
    comps = collections.defaultdict(list)
    for r in xr: comps[fnd(r['a'])].append(r)
    sec_pois = {pid: v for pid, v in pois.items() if v['category'].startswith('security')
                and v['position']['floorId'] in floor2lvl}
    lanes = []         # dict(rep, type, poi)
    for comp in comps.values():
        ins = collections.Counter(r['b'] for r in comp); outs = collections.Counter(r['a'] for r in comp)
        starts = [r['a'] for r in comp if not ins[r['a']]] or [comp[0]['a']]
        ends = [r['b'] for r in comp if not outs[r['b']]] or [comp[-1]['b']]
        s_land = any(s in land0 for s in starts); e_land = any(e in land0 for e in ends)
        rep_r = max(comp, key=lambda r: (r['o'] is not None and r['o'] in sec_pois, r['l'],
                                         meters(*G.pos[r['a']], *G.pos[r['b']])))
        poi = rep_r['o'] if rep_r['o'] in sec_pois else None
        mx = (G.pos[rep_r['a']][0] + G.pos[rep_r['b']][0]) / 2; my = (G.pos[rep_r['a']][1] + G.pos[rep_r['b']][1]) / 2
        if poi is None:   # nearest checkpoint-ish POI on the level (not an exit)
            best = None
            for pid, v in sec_pois.items():
                if v['category'] == 'security.exit' or floor2lvl[v['position']['floorId']] != G.lvl[rep_r['a']]: continue
                d = meters(mx, my, v['position']['longitude'], v['position']['latitude'])
                if d < 120 and (best is None or d < best[0]): best = (d, pid)
            if best and not (not s_land and e_land): poi = best[1]
        pname = clean(sec_pois[poi]['name']).lower() if poi else ''
        customs = bool(re.search(r'passport|customs', pname)) or any(
            v['category'] == 'security.passportcontrol' and floor2lvl[v['position']['floorId']] == G.lvl[rep_r['a']]
            and meters(mx, my, v['position']['longitude'], v['position']['latitude']) < 60 for v in sec_pois.values())
        if customs and not s_land: typ = 'customs'
        elif s_land and not e_land: typ = 'pre' if 'precheck' in pname.replace(' ', '') else 'clear' if re.search(r'\bclear\b', pname) else 'std'
        elif not s_land and e_land: typ = 'exit'
        elif not s_land and not e_land: typ = 'exit'
        else: typ = None                  # landside-only chain: plain corridor
        for r in comp:
            r['x'] = False; r['one'] = False
        if typ:
            rep_r['x'] = True; rep_r['one'] = True
            lanes.append(dict(rec=rep_r, type=typ, poi=poi, wait=rep_r['l']))
    rep['lanes'] = dict(collections.Counter(l['type'] for l in lanes))

    # materialize edges (densify curved walks into straight runs)
    bus_like = 0
    for r in recs:
        a, b = r['a'], r['b']; la, lb = G.lvl[a], G.lvl[b]
        kind = MODE.get(r['t'], 'walk')
        if r['t'] == 'Bus': bus_like += 1
        lane = next((l for l in lanes if l['rec'] is r), None)
        if lane:
            k = 'security' if lane['type'] in ('std', 'pre', 'clear') else 'exit'
            sec = 0
            if lane['type'] == 'customs': sec = int(round(min(lane['wait'], 30) * 60)) or 600
            m = meters(*G.pos[a], *G.pos[b])
            G.E.append(dict(a=a, b=b, m=round(m, 1), k=k, sec=sec, dir='', one=True))
            lane['ei'] = len(G.E) - 1
            continue
        if kind in VERT and la == lb: kind = 'walk'
        if kind == 'walk' and la != lb: kind = 'stairs'
        if kind in VERT or kind == 'train':
            m = meters(*G.pos[a], *G.pos[b])
            if kind == 'stairs': m = max(m, 10.0)
            d = ''
            if kind == 'escalator' and r['one']: d = 'up' if lb > la else 'down'
            G.E.append(dict(a=a, b=b, m=round(m, 1), k=kind, sec=0, dir=d, one=False))
            continue
        pts = r['pts'] or [list(G.pos[a]), list(G.pos[b])]
        if len(pts) > 2:
            xy = [prj.xy(p) for p in pts]
            keep = dp([list(p) for p in xy], 1.5)
            idx = [xy.index(tuple(p)) for p in keep]
            pts = [pts[i] for i in idx]
        k = walk_kind(la, pts)
        chain = [a]
        for p in pts[1:-1]: chain.append(G.add_node((p[0], p[1]), la))
        chain.append(b)
        for i in range(len(chain) - 1):
            m = meters(*G.pos[chain[i]], *G.pos[chain[i + 1]])
            G.E.append(dict(a=chain[i], b=chain[i + 1], m=round(m, 1), k=k, sec=0, dir='', one=r['one']))
    if bus_like: rep['bus_edges_as_train'] = bus_like

    # ---------------------------------------------------------------- components: keep the main one
    def weak_comps():
        U = collections.defaultdict(list)
        for e in G.E:
            if e is None: continue
            U[e['a']].append(e['b']); U[e['b']].append(e['a'])
        comp = {}
        cs = []
        for s in range(len(G.pos)):
            if s in comp or s not in U: continue
            cid = len(cs); cs.append([]); st = [s]; comp[s] = cid
            while st:
                u = st.pop(); cs[cid].append(u)
                for v in U[u]:
                    if v not in comp: comp[v] = cid; st.append(v)
        return comp, cs
    comp, cs = weak_comps()
    pre['components'] = len(cs)
    main = max(range(len(cs)), key=lambda i: len(cs[i]))
    # a gate/place POI whose nearest node sits in a side component: bridge it to the main graph if close
    target_cats = ('gate', 'security', 'baggage.claim', 'checkin', 'transport', 'parking', 'element.door',
                   'services.rentalcar', 'portal.train', 'portal.bus')
    bridged = 0
    mains = set(cs[main])
    for v in pois.values():
        fl = v['position']['floorId']
        if fl not in floor2lvl or not v['category'].startswith(target_cats): continue
        lon, lat = v['position']['longitude'], v['position']['latitude']
        n, d = nearest(lon, lat, floor2lvl[fl], [i for c in cs for i in c])
        if n is None or comp.get(n) == main: continue
        nm, dm = nearest(lon, lat, floor2lvl[fl], mains)
        if nm is not None and dm <= d + 15: continue          # main graph is about as close: snap there instead
        side = cs[comp[n]]
        best = None
        for i in side:
            j, dj = nearest(*G.pos[i], G.lvl[i], mains)
            if j is not None and (best is None or dj < best[2]): best = (i, j, dj)
        if best and best[2] <= 40:
            G.E.append(dict(a=best[0], b=best[1], m=round(best[2], 1), k='walk', sec=0, dir='', one=False))
            bridged += 1
            comp, cs = weak_comps(); main = max(range(len(cs)), key=lambda i: len(cs[i])); mains = set(cs[main])
    pruned_nodes = sum(len(c) for i, c in enumerate(cs) if i != main)
    for i, e in enumerate(G.E):
        if e is not None and e['a'] not in mains: G.E[i] = None
    rep['components_pruned'] = len(cs) - 1
    rep['nodes_pruned'] = pruned_nodes
    if bridged: rep['bridged'] = bridged

    # curated vertical cores the floor plans lack (e.g. garage elevators): a curated POI far from every walk node
    # on its level gets its own node, joined by the curated lift/stair links to the walk graph on the other levels
    cg = (cur or {}).get('graph') or {}
    cnode = {str(n[0]): n for n in cg.get('nodes') or []}
    cvert = collections.defaultdict(list)
    for e in cg.get('edges') or []:
        if e[3] in VERT: cvert[str(e[0])].append(e); cvert[str(e[1])].append(e)
    cores = 0
    for q in (cur or {}).get('pois', []):
        nid_c = str(q.get('node') or '')
        if q.get('k') == 'gate' or q.get('level') not in lvl_ids or not cvert.get(nid_c): continue
        _, d0 = nearest(q['lon'], q['lat'], q['level'], mains)
        if d0 <= 25: continue
        links = []
        for e in cvert[nid_c]:
            other = cnode.get(str(e[1] if str(e[0]) == nid_c else e[0]))
            if not other or other[3] == q['level'] or other[3] not in lvl_ids: continue
            j, dj = nearest(other[2], other[1], other[3], mains, 20)
            if j is not None: links.append((j, e[3], max(float(e[2] or 0), 5.0)))
        if not links: continue
        s = G.add_node((q['lon'], q['lat']), q['level']); mains.add(s)
        for j, k, m in links:
            G.E.append(dict(a=s, b=j, m=round(m, 1), k=k, sec=0, dir='', one=False))
        cores += 1
    if cores: rep['curated_cores_added'] = cores

    # zones on the final graph
    A = G.adj()
    seeds = {s for s in seeds if s in mains} or {i for i in mains if G.lvl[i] == dep_l}
    land = reach(A, seeds, G, skip=ONE_WAY)
    air = mains - land

    def snap(lon, lat, level, zone=None, maxd=SNAP_MAX):
        cand = mains if zone is None else (land if zone == 'pre' else air)
        n, d = nearest(lon, lat, level, cand, maxd)
        if n is None and zone is not None:
            n2, d2 = nearest(lon, lat, level, mains, maxd)
            return n2, d2, True
        return n, d, False

    # ---------------------------------------------------------------- gates (Atrius, plus curated refs it lacks)
    cur_gates = {str(q['ref']).upper(): q for q in (cur or {}).get('pois', [])
                 if q.get('k') == 'gate' and q.get('ref') and q.get('lat') is not None}
    ranges = C.get('concourse_ranges') or {}

    def conc_of(ref, fallback=None):
        q = cur_gates.get(ref)
        if q and q.get('concourse'): return q['concourse']
        m = re.match(r'^([A-Z])', ref)
        if m: return m.group(1)
        num = re.match(r'\d+', ref)
        return next((k for k, (lo, hi) in ranges.items() if num and lo <= int(num.group()) <= hi), fallback)

    gates = []
    for pid, v in pois.items():
        if v['category'] != 'gate': continue
        fl = v['position']['floorId']
        if fl not in floor2lvl: continue
        kws = [k['name'] for k in v.get('keywords', [])]
        ref, alias_refs = gate_ids_from(v.get('name') or '', kws)
        if not ref: continue
        lon, lat = v['position']['longitude'], v['position']['latitude']
        n, d, _ = snap(lon, lat, floor2lvl[fl], 'post', 150)
        c = conc_of(ref, clean(v.get('nearbyLandmark') or '') or None)
        g = {'ref': ref, 'l': floor2lvl[fl], 'p': [R6(lon), R6(lat)], 'c': c, 'node': n}
        gates.append(g)
        for a in alias_refs: gates.append({'ref': a, 'l': g['l'], 'p': g['p'], 'c': c, 'node': n, 'of': ref})
    have = {g['ref'] for g in gates}
    added = 0
    for ref, q in cur_gates.items():
        if ref in have or q.get('level') not in lvl_ids: continue
        n, d, _ = snap(q['lon'], q['lat'], q['level'], 'post', 150)
        gates.append({'ref': ref, 'l': q['level'], 'p': [R6(q['lon']), R6(q['lat'])], 'c': conc_of(ref), 'node': n})
        added += 1
    if added: rep['gates_from_curated'] = added
    seen = set(); g2 = []
    for g in sorted(gates, key=lambda g: (gkey(g['ref']), 'of' in g)):
        if g['ref'] in seen: continue
        seen.add(g['ref']); g2.append(g)
    gates = g2
    gate_level = {g['ref']: g['l'] for g in gates}
    if cur_gates:
        rep['curated_gates_missing'] = sum(1 for r in cur_gates if r not in seen)

    # ---------------------------------------------------------------- POIs: curated first (ids, notes kept), then Atrius extras
    al_words = sorted(AL.get('match') or [], key=len, reverse=True)
    al_rx = re.compile(r'\b(?:' + '|'.join(re.escape(m) for m in al_words) + r')\b', re.I) if al_words else None
    al_id = re.compile(r'(^|[^a-z])' + re.escape(AL['code'].lower()) + r'([^a-z]|$)')
    NO_AIRLINE = {'food', 'coffee', 'bar', 'shop', 'restroom', 'water', 'elevator', 'escalator', 'stairs'}

    def is_airline(cat, pid, *texts):
        if cat in NO_AIRLINE: return False
        return bool(al_rx and any(al_rx.search(t or '') for t in texts)) or bool(al_id.search(pid.lower()))

    out_pois = []
    poi_by_id = {}
    snapped_far = dropped_far = zone_fallback = 0

    def place_poi(o):
        nonlocal snapped_far, dropped_far, zone_fallback
        zone = o['sec'] if o['cat'] not in ('elevator', 'escalator', 'stairs', 'customs') else None
        n, d, fb = snap(o['p'][0], o['p'][1], o['l'], zone)
        if n is None: dropped_far += 1; return False
        if fb: zone_fallback += 1
        if d > 10: snapped_far += 1
        o['node'] = n
        out_pois.append(o); poi_by_id[o['id']] = o
        return True

    n_cur = n_cur_all = 0
    for q in (cur or {}).get('pois', []):
        if q.get('k') == 'gate' or q.get('lat') is None: continue
        n_cur_all += 1
        if q.get('level') not in lvl_ids: continue
        cat = CAT.get(q['k'], q['k'])
        name = q.get('name') or ''
        o = {'id': str(q['id']), 'cat': cat, 'k': q['k'], 'l': q['level'], 'p': [R6(q['lon']), R6(q['lat'])], 'n': name,
             'node': None, 'sec': 'post' if q.get('side') == 'air' else 'pre', '_c': True}
        if cat == 'lounge':
            t = f"{name} {q.get('note') or ''}".lower()
            o['free'] = not any(w in t for w in paid_words(False))
        for k in ('hours', 'near', 'note'):
            if q.get(k): o[k] = q[k]
        if is_airline(cat, o['id'], name, q.get('note')): o['airline'] = AL['code']
        if place_poi(o): n_cur += 1
    curated = list(out_pois)
    if cur: rep['curated_pois_kept'] = f'{n_cur}/{n_cur_all}'

    alias = {}          # Atrius POI id -> curated POI id it duplicates
    n_atr = 0
    for pid, v in pois.items():
        fl = v['position']['floorId']
        if fl not in floor2lvl: continue
        name = clean(v.get('name') or '')
        ck = poi_kind(v['category'], name)
        if ck is None: continue
        cat, k = ck
        li = floor2lvl[fl]
        if cat == 'door':
            cat = k = 'curb_dep' if li == dep_l else 'curb_arr' if li == arr_l else 'door'
        lon, lat = v['position']['longitude'], v['position']['latitude']
        if clip_d(lon, lat) > 250: dropped_far += 1; continue
        o = {'id': str(pid), 'cat': cat, 'k': k, 'l': li, 'p': [R6(lon), R6(lat)], 'n': name, 'node': None,
             'sec': 'post' if v.get('isAfterSecurity') else 'pre'}
        if cat == 'lounge':
            o['free'] = k == 'quiet' or not any(w in name.lower() for w in paid_words())
        if v.get('operationHours'):
            h = fmt_hours(v['operationHours'])
            if h: o['hours'] = h
        near = clean(v.get('nearbyLandmark') or '')
        if near and near.lower() != name.lower(): o['near'] = near
        kws = [x['name'] for x in v.get('keywords', [])]
        airl = sorted({t for x in kws if x.lower().startswith('airline:')
                       for t in re.split(r'[\s,;/]+', x.split(':', 1)[1].strip().upper()) if re.match(r'^[A-Z0-9]{2}$', t)})
        if not airl and is_airline(cat, '', name): airl = [AL['code']]
        if airl: o['airline'] = airl[0] if len(airl) == 1 else ','.join(airl)
        m = best_match(o, curated)
        if m is not None:
            alias[o['id']] = m['id']
            for f in ('hours', 'airline'):
                if o.get(f) and not m.get(f): m[f] = o[f]
            continue
        # a bare "Door" on a curb level says nothing as a route's end: name it for the curb it opens onto
        if o['cat'] in ('curb_dep', 'curb_arr') and re.fullmatch(r'(?:doors?|entrance|exit)?', name.lower()):
            o['n'] = 'Departures curb' if o['cat'] == 'curb_dep' else 'Arrivals curb'
        if place_poi(o): n_atr += 1
    rep['atrius_pois_merged_into_curated'] = len(alias)
    rep['atrius_pois_added'] = n_atr
    rep['pois_snapped_over_10m'] = snapped_far
    rep['pois_dropped_far'] = dropped_far
    rep['pois_zone_fallback'] = zone_fallback

    # nearest gate (airside walking, <= 300 m) for post-security POIs
    AW = G.adj(skip=ONE_WAY | {'train'})
    near_gate = {}
    pq = [(0.0, g['node'], g['ref']) for g in gates if g['node'] is not None and 'of' not in g]
    heapq.heapify(pq)
    while pq:
        d, u, ref = heapq.heappop(pq)
        if u in near_gate or d > 300: continue
        near_gate[u] = ref
        for v2, ei in AW[u]:
            if v2 not in near_gate and v2 in air: heapq.heappush(pq, (d + G.E[ei]['m'], v2, ref))
    for o in out_pois:
        if o['sec'] == 'post' and o['node'] in near_gate and o['cat'] not in ('elevator', 'escalator', 'stairs'):
            o['gate'] = near_gate[o['node']]

    # ---------------------------------------------------------------- screening lanes: their POIs sit on the lane entry
    LCAT = {'std': 'checkpoint', 'pre': 'precheck', 'clear': 'clear'}
    for ln in lanes: ln['pois'] = []
    own = {}
    for ln in lanes:
        if ln['poi']:
            o = poi_by_id.get(alias.get(str(ln['poi']), str(ln['poi'])))
            if o is not None: own.setdefault(o['id'], ln)
    lane_less = 0
    # one POI per lane, nearest first; a lane's own source POI only counts when it is actually beside the lane
    cand = []
    for o in out_pois:
        if o['cat'] in LCAT.values() and o['sec'] == 'pre':
            for x in lanes:
                if LCAT.get(x['type']) != o['cat'] or G.lvl[G.E[x['ei']]['a']] != o['l']: continue
                d = meters(*o['p'], *G.pos[G.E[x['ei']]['a']])
                if d < 60: cand.append((d - (15 if own.get(o['id']) is x and d < 25 else 0), id(o), o, x))
    cand.sort(key=lambda t: (t[0], t[1]))
    got_o, got_l = set(), set()
    for d, _, o, x in cand:
        if id(o) in got_o or id(x) in got_l: continue
        got_o.add(id(o)); got_l.add(id(x))
        o['node'] = G.E[x['ei']]['a']; x['pois'].append(o)
    for o in out_pois:
        if o['cat'] in LCAT.values() and o['sec'] == 'pre':
            if id(o) not in got_o: lane_less += 1
        elif o['cat'] in ('exit', 'customs') and (o['sec'] == 'post' or not o.get('_c')):
            want = [ln for ln in lanes if ln['type'] in ('exit', 'customs') and G.lvl[G.E[ln['ei']]['a']] == o['l']]
            best = min(((meters(*o['p'], *G.pos[G.E[x['ei']]['a']]), x) for x in want), default=None, key=lambda t: t[0])
            if best and best[0] < 120:
                o['node'] = G.E[best[1]['ei']]['a']; best[1]['pois'].append(o)
    rep['checkpoint_pois_without_lane'] = lane_less
    synth = 0
    for ln in lanes:
        if ln['type'] in LCAT and not ln['pois']:
            e = G.E[ln['ei']]
            nm = {'std': 'Security', 'pre': 'PreCheck', 'clear': 'CLEAR'}[ln['type']]
            o = {'id': f'lane-{e["a"]}', 'cat': LCAT[ln['type']], 'k': LCAT[ln['type']], 'l': G.lvl[e['a']],
                 'p': [R6(G.pos[e['a']][0]), R6(G.pos[e['a']][1])], 'n': nm, 'node': e['a'], 'sec': 'pre'}
            out_pois.append(o); poi_by_id[o['id']] = o; ln['pois'].append(o); synth += 1
    if synth: rep['lane_pois_synthesized'] = synth

    # ---------------------------------------------------------------- places
    al = AL['label']
    rules = [(r.get('kind'), re.compile(r['match'], re.I), r['label']) for r in (C.get('place_labels') or [])]

    def airline_label(n):
        b = al_rx.sub('', n) if al_rx else n
        b = re.sub(r'\b(?:airlines?|air lines)\b', '', b, flags=re.I)
        b = re.sub(r'check-?in', 'check-in', b, flags=re.I)
        b = re.sub(r'\s+', ' ', b).strip(' ,-')
        if not re.search(r'check-in|bag drop', b, re.I): b = (b + ' check-in').strip()
        if b[:1].isupper() and not b[1:2].isupper(): b = b[:1].lower() + b[1:]
        return short_label(f'{al} {b}')

    GT = {'rideshare': 'Rideshare pickup', 'taxi': 'Taxi', 'pickup': 'Passenger pickup', 'rental_car': 'Rental cars'}

    def place_label(o):
        kind, n = o['cat'], o['n']
        for k, r, lab in rules:
            if (k is None or k == kind) and r.search(n): return lab
        if kind == 'checkin':
            if o.get('airline') == AL['code']:
                lab = airline_label(n)
                row = re.match(r'^check-?in ([a-z])$', (o.get('near') or '').lower())
                if row and not o.get('_c') and 'row' not in lab: lab = short_label(f'{lab}, row {row.group(1).upper()}')
                return lab
            if o.get('_c'): return short_label(n)
            nl = n.lower()
            if re.match(r'^check-?in [a-z]$', nl) or 'reserve' in nl: return None          # a row sign, not a desk
            parts = re.split(r'\s+(?=(?:economy|premium|first|business|bag drop|ticket(?:ing)?|check-?in|counter|curbside)\b)',
                             n, maxsplit=1, flags=re.I)
            base = parts[0].strip(' ,-')
            if not base or base.lower() == nl and re.match(r'^(check-?in|ticketing|counter)', nl): return None
            return short_label(f'{base} {"bag drop" if "bag drop" in nl else "check-in"}')
        if kind == 'baggage':
            r = ref_of(n)
            return f'Baggage claim {r.upper()}' if r and r[0].isdigit() else short_label(n)
        if o.get('_c'): return short_label(n)
        if kind in ('checkpoint', 'precheck', 'clear'):
            cp = re.search(r'checkpoint\s*([A-Z0-9]+)\b', n, re.I) or re.search(r'checkpoint\s*([A-Z0-9]+)\b', o.get('near') or '', re.I)
            cpl = f'Checkpoint {cp.group(1).upper()}' if cp else 'Checkpoint'
            if kind == 'precheck': return f'PreCheck, {cpl}' if cp else ('PreCheck Touchless ID' if 'touchless' in n.lower() else 'PreCheck')
            if kind == 'clear': return f'CLEAR, {cpl}' if cp else 'CLEAR'
            return cpl
        if kind == 'exit': return 'Passport control' if 'passport' in n.lower() else 'Security exit'
        if kind in ('curb_dep', 'curb_arr'):
            num = re.search(r'(\d+)', n)
            what = 'Departures curb' if kind == 'curb_dep' else 'Arrivals curb'
            return f'{what}, Door {num.group(1)}' if num else what
        lab = GT.get(kind)
        if kind == 'rideshare' and re.search(r'ride ?share', n.lower()): lab = 'Rideshare pickup'
        if lab is None or (kind == 'rideshare' and not re.search(r'ride ?share', n.lower())):
            lab = re.split(r'\s+[-–]\s+', n)[0]
            lab = lab[:1].upper() + lab[1:].lower() if lab.isupper() else lab
        return short_label(lab)

    places = []

    def add_place(kind, label, o, node=None, airline=None):
        pl = {'id': None, 'kind': kind, 'label': label, 'level': o['l'], 'node': node if node is not None else o['node'],
              'p': o['p'], 'poi': o['id'], 'sec': o['sec']}
        if airline: pl['airline'] = airline
        if o.get('_c'): pl['_c'] = True
        places.append(pl); return pl

    PSET = set(PLACE_KINDS)
    exit_pois = {o['id'] for ln in lanes if ln['type'] in ('exit', 'customs') for o in ln['pois']}
    for o in out_pois:
        kind = o['cat']
        if kind not in PSET: continue
        if kind == 'exit':
            if o['sec'] != 'post' and o['id'] not in exit_pois: continue
        elif o['sec'] != 'pre': continue
        if kind == 'checkin' and o['k'] != 'checkin': continue
        lab = place_label(o)
        if not lab: continue
        lab = re.sub(r'\s*\(((?:doors?|level)\s+[\w–-]+)\)$', lambda m: ', ' + m.group(1)[:1].upper() + m.group(1)[1:], lab, flags=re.I)
        if kind == 'pickup': kind = 'curb_arr'            # passenger pickup is an arrivals-curb spot
        add_place(kind, lab, o, airline=o.get('airline') if o.get('airline') == AL['code'] else None)
        if kind in ('shuttle', 'bus') and re.search(r'rental car', o['n'].lower()):
            add_place('rental_car', 'Rental car shuttle', o)
    # curbs: if no door is tagged on the departures / arrivals level, use curb-side dead ends by the building outline
    deg = collections.Counter()
    for e in G.E:
        if e is None: continue
        deg[e['a']] += 1; deg[e['b']] += 1
    for kind, lv in (('curb_dep', dep_l), ('curb_arr', arr_l)):
        if any(p['kind'] == kind for p in places): continue
        cand = []
        for i in land:
            if G.lvl[i] != lv or deg[i] != 1 or lv not in bld: continue
            x, y = prj.xy(G.pos[i])
            if min(ring_dist(x, y, r) for r in bld[lv]) < 10: cand.append(i)
        kept = []
        for i in cand:
            if all(meters(*G.pos[i], *G.pos[j]) >= 12 for j in kept): kept.append(i)
        for i in kept:
            what = 'Departures curb' if kind == 'curb_dep' else 'Arrivals curb'
            o = {'id': f'{kind}-{i}', 'cat': kind, 'k': kind, 'l': lv, 'p': [R6(G.pos[i][0]), R6(G.pos[i][1])],
                 'n': what, 'node': i, 'sec': 'pre'}
            out_pois.append(o); poi_by_id[o['id']] = o
            add_place(kind, what, o)
    # aliases (e.g. a train that serves the rental car centre)
    for a in C.get('place_alias') or []:
        src = [p for p in places if p['kind'] == a['of']]
        if src and not any(p['kind'] == a['kind'] for p in places):
            s = src[0]
            places.append({'id': None, 'kind': a['kind'], 'label': a['label'], 'level': s['level'], 'node': s['node'],
                           'p': s['p'], 'poi': s['poi'], 'sec': s['sec']})
    # one place per spot: curated places win over nearby Atrius ones of the same kind; same labels merge
    n0 = len(places)
    merged = []
    KG = {'bus': 'transit', 'shuttle': 'transit', 'subway': 'transit', 'train': 'transit'}
    cur_kinds = {p['kind'] for p in places if p.get('_c')}

    def toks(lab):
        return {t[:-1] if t.endswith('s') and len(t) > 4 else t for t in name_toks(lab)}
    for p in sorted(places, key=lambda p: not p.get('_c')):
        rp = ref_of(p['label'])
        if not p.get('_c') and p['kind'] in ('curb_dep', 'curb_arr') and p['kind'] in cur_kinds and not rp:
            continue                                   # an unnumbered source curb door adds nothing to curated curbs
        q = None
        tp = toks(p['label'])
        for m in merged:
            if KG.get(m['kind'], m['kind']) != KG.get(p['kind'], p['kind']): continue
            d = meters(*m['p'], *p['p'])
            same = m['label'].lower() == p['label'].lower()
            if same and m['kind'] == p['kind'] and (not p.get('_c') or d < (150 if p['kind'] == 'rental_car' else MERGE_M)):
                q = m; break
            if same and m['node'] == p['node']: q = m; break
            if m.get('_c') and not p.get('_c'):
                rm = ref_of(m['label'])
                if rp and rm and rp != rm: continue
                if p['kind'] == 'checkin' and p.get('airline') != m.get('airline'): continue
                tm = toks(m['label'])
                sim = len(tp & tm) / max(1, len(tp | tm))
                if (d < 60 and m['level'] == p['level'] and m['kind'] == p['kind']) or (sim >= 0.6 and d < 400): q = m; break
        if q is None: merged.append(p)
        elif p.get('airline') and not q.get('airline'): q['airline'] = p['airline']
    places = merged
    rep['places_merged'] = n0 - len(places)
    # labels unique within a kind: a "by ..." phrase from the name, the curated "near", the nearest gate, a number
    groups = collections.defaultdict(list)
    for p in places: groups[(p['kind'], p['label'].lower())].append(p)
    for (kind, _), ps in groups.items():
        if len(ps) < 2: continue
        head = ps[0]['label'].split(' ')[0].split(',')[0]

        def by_phrase(p):
            o = poi_by_id.get(p['poi']) or {}
            m = re.search(r'\((?:[^)]*?,\s*)?(by [^)]+)\)', o.get('n') or '')
            return f'{head} {m.group(1)}' if m else None

        def near_of(p):
            o = poi_by_id.get(p['poi']) or {}
            return f"{p['label']}, {o['near']}" if o.get('near') else None

        def gate_of(p):
            o = poi_by_id.get(p['poi']) or {}
            g = o.get('gate') or near_gate.get(p['node'])
            if g is None:
                e = next((G.E[ln['ei']] for ln in lanes if ln['ei'] is not None and G.E[ln['ei']]['a'] == p['node']), None)
                g = near_gate.get(e['b']) if e else None
            return f"{head} by gate {g}" if g else None
        def near_short(p):
            o = poi_by_id.get(p['poi']) or {}
            nr = o.get('near') or ''
            if not nr: return None
            return f'{head} {nr}' if nr.lower().startswith('by ') else f'{head}, {nr}'

        def ok(labs): return all(labs) and all(len(x) <= 28 for x in labs) and len({x.lower() for x in labs}) == len(labs)
        for fn in (by_phrase, gate_of, near_of, near_short):
            labs = [fn(p) for p in ps]
            if ok(labs):
                for p, x in zip(ps, labs): p['label'] = x
                break
        else:
            # mixed: each place's own landmark, then its nearest gate to split what still collides
            labs = [next((x for x in (near_short(p), gate_of(p)) if x and len(x) <= 28), None) for p in ps]
            cnt = collections.Counter((x or '').lower() for x in labs)
            for i, p in enumerate(ps):
                if labs[i] and cnt[labs[i].lower()] > 1:
                    g = (gate_of(p) or '').rsplit(' ', 1)[-1]
                    labs[i] = f'{labs[i]} ({g})' if g and 'gate' not in labs[i] else None
            if ok(labs):
                for p, x in zip(ps, labs): p['label'] = x
            else:
                for i, p in enumerate(ps[1:], 2): p['label'] = short_label(f"{p['label']} {i}")
    # the airline's carousels
    mark = set()
    bags = [p for p in places if p['kind'] == 'baggage']
    if C.get('aa_carousels') == 'all':
        mark = {id(p) for p in bags}
    elif C.get('aa_carousels') == 'near_office':
        offices = [o for o in out_pois if o['cat'] == 'baggage_service' and o.get('airline') == AL['code']]
        for of in offices:
            near = sorted(bags, key=lambda c: meters(*c['p'], *of['p']))
            mark |= {id(c) for c in near[:1]} | {id(c) for c in bags if meters(*c['p'], *of['p']) < 40}
    for p in bags:
        if id(p) in mark: p['airline'] = AL['code']
    rep['carousels_marked'] = sum(1 for p in bags if p.get('airline') == AL['code'])
    # the departures curb nearest the airline's desks is the airline's curb (unless a curb already says so)
    desks = [p for p in places if p['kind'] == 'checkin' and p.get('airline') == AL['code']]
    curbs = [p for p in places if p['kind'] == 'curb_dep']
    if desks and curbs and not any(c.get('airline') for c in curbs):
        for d in desks:
            min(curbs, key=lambda c: meters(*c['p'], *d['p']))['airline'] = AL['code']
    used_ids = set()
    for p in places:
        b = slug(p['label']); i = b; n = 2
        while i in used_ids: i = f'{b}-{n}'; n += 1
        used_ids.add(i); p['id'] = i
        p.pop('_c', None)
    order = {k: i for i, k in enumerate(PLACE_KINDS)}
    places.sort(key=lambda p: (order.get(p['kind'], 99), p['level']))
    place_of_poi = {}
    for p in places: place_of_poi.setdefault(p['poi'], p['id'])
    for ln in lanes:
        e = G.E[ln['ei']]
        pid = next((place_of_poi[o['id']] for o in ln['pois'] if o['id'] in place_of_poi), None)
        ln['out'] = [e['a'], e['b'], ln['type'], pid]

    # ---------------------------------------------------------------- renumber + emit graph
    alive = sorted({e['a'] for e in G.E if e} | {e['b'] for e in G.E if e})
    nid = {i: f'n{j + 1}' for j, i in enumerate(alive)}
    nodes_out = [[nid[i], R6(G.pos[i][0]), R6(G.pos[i][1]), G.lvl[i]] for i in alive]
    edges_out = []
    for e in G.E:
        if e is None: continue
        row = [nid[e['a']], nid[e['b']], e['m'], e['k']]
        if e['sec'] or e['dir']: row += [e['sec'] or 0, e['dir']]
        edges_out.append(row)
    for g in gates: g['node'] = nid.get(g['node'])
    for o in out_pois: o['node'] = nid.get(o['node'])
    for p in places: p['node'] = nid.get(p['node'])
    lanes_out = [[nid[l['out'][0]], nid[l['out'][1]], l['out'][2], l['out'][3]] for l in lanes]

    # ---------------------------------------------------------------- presets: curated ones verbatim, then generated extras
    ids = {o['id'] for o in out_pois}
    cat_of = {o['id']: o['cat'] for o in out_pois}

    def ok_ep(x):
        if x in ('@arr', '@dep', '@bag') or x.startswith(('gate:', 'node:')): return True
        if x.startswith('place:'): return any(p['kind'] == x[6:] for p in places)
        if x.startswith('poi:'): x = x[4:]
        return x in ids

    def ep_cat(x):
        if x.startswith('@'): return x
        if x.startswith('poi:'): x = x[4:]
        return cat_of.get(x, x)

    def sig(pr):
        return (pr['when'], ep_cat(pr['from']), ep_cat(pr['to']), tuple(ep_cat(v) for v in pr.get('via') or []))
    presets = []
    dropped = 0
    for pr in (cur or {}).get('presets', []):
        if all(ok_ep(x) for x in [pr['from'], pr['to']] + list(pr.get('via') or [])): presets.append(dict(pr))
        else: dropped += 1
    if dropped: fails.append(f'curated presets with unresolved endpoints: {dropped}')

    def first(kind, airline=None):
        c = [p for p in places if p['kind'] == kind and (airline is None or p.get('airline') == airline)]
        return c[0] if c else None

    def near_to(cands, ref):
        return min(cands, key=lambda c: meters(*c['p'], *ref['p'])) if cands and ref else (cands[0] if cands else None)
    gen = []
    curb = first('curb_dep', AL['code']) or first('curb_dep')
    desk = first('checkin', AL['code'])
    cp = near_to([p for p in places if p['kind'] == 'checkpoint'], desk or curb)
    pc = near_to([p for p in places if p['kind'] == 'precheck'], desk or curb)
    ref = lambda p: 'poi:' + p['poi']
    if curb:
        cl = curb['label']
        if desk and cp:
            gen.append({'id': 'curb-gate', 'label': f'{cl} to gate, checking a bag', 'from': ref(curb),
                        'to': '@dep', 'via': [ref(desk), ref(cp)], 'when': 'depart'})
        if cp:
            gen.append({'id': 'curb-gate-nobag', 'label': f'{cl} to gate, carry-on only', 'from': ref(curb),
                        'to': '@dep', 'via': [ref(cp)], 'when': 'depart'})
        if desk and pc:
            gen.append({'id': 'curb-gate-precheck', 'label': f'{cl} to gate with PreCheck, checking a bag',
                        'from': ref(curb), 'to': '@dep', 'via': [ref(desk), ref(pc)], 'when': 'depart'})
    for k in ('parking', 'train'):
        s = first(k)
        if s and cp:
            gen.append({'id': f'{k}-gate', 'label': f'{s["label"]} to gate', 'from': ref(s), 'to': '@dep',
                        'via': [ref(cp)], 'when': 'depart'})
    gen.append({'id': 'connect', 'label': 'Arrival gate to next gate', 'from': '@arr', 'to': '@dep', 'when': 'connect'})
    gen.append({'id': 'gate-bag', 'label': 'Gate to baggage claim', 'from': '@arr', 'to': '@bag', 'when': 'arrive'})
    bag_ref = first('baggage', AL['code']) or first('baggage')
    for k, lab in (('rideshare', 'rideshare pickup'), ('taxi', 'taxi stand'), ('subway', None), ('train', None),
                   ('rental_car', 'rental cars'), ('pickup', 'passenger pickup'), ('parking', None)):
        c = [p for p in places if p['kind'] == k]
        if not c: continue
        t = near_to(c, bag_ref)
        gen.append({'id': f'gate-{k.replace("_", "-")}', 'label': f'Gate to {lab or t["label"]}', 'from': '@arr',
                    'to': ref(t), 'via': ['@bag'], 'when': 'arrive'})
    have_id = {p['id'] for p in presets}; have_sig = {sig(p) for p in presets}
    for pr in gen:
        if pr['id'] in have_id or sig(pr) in have_sig: continue
        presets.append(pr); have_id.add(pr['id']); have_sig.add(sig(pr))

    # ---------------------------------------------------------------- assemble
    for o in out_pois:
        o.pop('_c', None)
        if o['node'] is None: fails.append('poi without node')
    out_pois.sort(key=lambda o: (o['l'], o['cat'], o['n'], o['id']))
    u2, l2, stands = osm_extras(osm_import(code, C), C, gate_level)
    units = u2 + units
    lines += l2
    if cur:
        keep_u = set(C.get('curated_units') or CURATED_UNITS)
        for a in cur.get('areas', []):
            if a.get('k') in keep_u and a.get('level') in lvl_ids:
                for r in rings_of(a.get('geom')):
                    u = {'k': a['k'], 'l': a['level'], 'g': [r]}
                    if a.get('label') or a.get('name'): u['n'] = a.get('label') or a.get('name')
                    units.append(u)
        has_mv = any(L['k'] == 'moving' for L in lines)
        for L in cur.get('lines', []):
            if L.get('level') not in lvl_ids or (L['k'] == 'moving' and has_mv): continue
            lines.append({'k': L['k'], 'l': L['level'], 'g': [[R6(b), R6(a)] for a, b in L['geom']]})
    # a paid lounge mapped as a service room keeps its shape but not its name: the map never labels lounges
    for u in units:
        if u.get('n') and u['k'] in ('service', 'room') and re.search(LOUNGE_UNIT, u['n'].lower()): u['k'] = 'lounge'
    lv_name = {L['id']: L for L in (cur or {}).get('levels', [])}
    gp = [g['p'] for g in gates]
    allp = gp + [n[1:3] for n in nodes_out]
    bbox = [R6(min(p[0] for p in allp)), R6(min(p[1] for p in allp)), R6(max(p[0] for p in allp)), R6(max(p[1] for p in allp))]
    center = [R6((bbox[0] + bbox[2]) / 2), R6((bbox[1] + bbox[3]) / 2)]
    if cur and cur.get('center'): center = [R6(cur['center'][1]), R6(cur['center'][0])]
    out = {
        'v': 1, 'code': code, 'name': C['name'],
        'levels': [{'id': L['id'], 'short': (lv_name.get(L['id']) or L).get('short') or L['short'],
                    'name': (lv_name.get(L['id']) or L).get('name') or L['name']} for L in C['levels']],
        'defaultLevel': C['defaultLevel'],
        'center': center,
        'bbox': bbox, 'bearing': best_bearing(gp), 'attribution': C['attribution'],
        'units': units, 'lines': lines, 'gates': gates, 'stands': stands, 'pois': out_pois,
        'graph': {'nodes': nodes_out, 'edges': edges_out, 'lanes': lanes_out},
        'places': places, 'presets': presets,
    }
    rep['pre'] = dict(pre)
    return out, rep, fails, AL


# ------------------------------------------------------------------------------------------------ validation
class Eng:
    """Minimal re-implementation of the N.airmap graph for checks."""
    def __init__(self, D):
        self.D = D
        self.idx = {n[0]: i for i, n in enumerate(D['graph']['nodes'])}
        self.G = Graph()
        for n in D['graph']['nodes']: self.G.add_node((n[1], n[2]), n[3])
        for r in D['graph']['edges']:
            self.G.E.append(dict(a=self.idx[r[0]], b=self.idx[r[1]], m=r[2], k=r[3],
                                 sec=(r[4] if len(r) > 4 else 0) or 0, dir=(r[5] if len(r) > 5 else '') or '',
                                 one=r[3] in ONE_WAY))
        self.A = self.G.adj()

    def n(self, nid):
        return self.idx.get(nid)


def validate(D, C, AL, rep, fails):
    V = collections.OrderedDict()
    E = Eng(D); G = E.G; A = E.A
    places = D.get('places') or []
    gates = D['gates']
    gnodes = {g['ref']: E.n(g['node']) for g in gates}
    kinds = collections.defaultdict(list)
    for p in places:
        if E.n(p['node']) is not None: kinds[p['kind']].append(E.n(p['node']))
    V['places'] = dict(collections.Counter(p['kind'] for p in places))
    for k in ('curb_dep', 'curb_arr', 'checkin', 'checkpoint', 'baggage', 'rideshare', 'taxi'):
        if not kinds.get(k): fails.append(f'no {k} place')
    if not any(p['kind'] == 'checkin' and p.get('airline') == AL['code'] for p in places): fails.append('no airline check-in place')
    if not any(p['kind'] == 'baggage' and p.get('airline') == AL['code'] for p in places): fails.append('no airline carousel')
    if any(n is None for n in gnodes.values()):
        fails.append(f'gates without node: {sum(1 for n in gnodes.values() if n is None)}')
    # graph sanity
    bad_vert = sum(1 for e in G.E if e['k'] in VERT and G.lvl[e['a']] == G.lvl[e['b']])
    bad_walk = sum(1 for e in G.E if e['k'] in WALKISH | ONE_WAY and G.lvl[e['a']] != G.lvl[e['b']])
    bad_dir = sum(1 for e in G.E if e['dir'] and (e['k'] != 'escalator' or G.lvl[e['a']] == G.lvl[e['b']]))
    pairs = {(e['a'], e['b']) for e in G.E}
    sec_rev = sum(1 for e in G.E if e['k'] in ONE_WAY and ((e['b'], e['a']) in pairs))
    zero = sum(1 for e in G.E if e['k'] in WALKISH and e['m'] > 400)
    if bad_vert: fails.append(f'vertical edges on one level: {bad_vert}')
    if bad_walk: fails.append(f'walk edges across levels: {bad_walk}')
    if bad_dir: fails.append(f'bad escalator dir: {bad_dir}')
    if sec_rev: fails.append(f'security/exit edges with a reverse edge: {sec_rev}')
    if zero: fails.append(f'walk edges > 400 m: {zero}')
    # lane classification exactly as the engine does it (POI cats at the security edge's start node)
    at = collections.defaultdict(set)
    for o in D['pois']:
        if o.get('node'): at[o['node']].add(o['cat'])
    want = {'std': 'std', 'pre': 'pre', 'clear': 'clear'}
    lane_bad = []; lane_n = collections.Counter()
    for a, b, t, pid in D['graph'].get('lanes') or []:
        if t not in want: continue
        cats = at.get(a, set())
        got = 'std' if 'checkpoint' in cats else 'pre' if 'precheck' in cats else 'clear' if 'clear' in cats else 'std'
        lane_n[got] += 1
        if got != want[t]: lane_bad.append(f'{t}->{got}')
    V['engine_lanes'] = dict(lane_n)
    if lane_bad: fails.append(f'lanes the engine would classify differently: {len(lane_bad)} {collections.Counter(lane_bad).most_common(4)}')
    U = collections.defaultdict(set)
    for e in G.E: U[e['a']].add(e['b']); U[e['b']].add(e['a'])
    seen = set(); ncomp = 0
    for s in range(len(G.pos)):
        if s in seen: continue
        ncomp += 1; seen |= reach({k: list(v) for k, v in U.items()} and collections.defaultdict(list, {k: [(x, None) for x in v] for k, v in U.items()}), [s])
    V['components'] = ncomp
    if ncomp != 1: fails.append(f'graph has {ncomp} components')
    # curb -> gates: reachable, only through screening, never without it
    dep = kinds.get('curb_dep', [])
    dist, prev = dijkstra(G, A, dep)
    nosec = reach(A, dep, G, skip=ONE_WAY)
    unreach = [r for r, n in gnodes.items() if n is None or n not in dist]
    leak = [r for r, n in gnodes.items() if n is not None and n in nosec]
    multi = []
    for r, n in gnodes.items():
        if n is None or n not in dist: continue
        k = sum(1 for ei in path_edges(G, prev, n) if G.E[ei]['k'] == 'security')
        if k != 1: multi.append(r)
    if unreach: fails.append(f'gates unreachable from curb: {len(unreach)} {sorted(unreach, key=gkey)[:12]}')
    if leak: fails.append(f'gates reachable without security: {len(leak)} {sorted(leak, key=gkey)[:12]}')
    if multi: fails.append(f'curb->gate paths without exactly one screening: {len(multi)} {sorted(multi, key=gkey)[:12]}')
    aa_c = set(C.get('aa_concourses') or [])
    aa_g = [g for g in gates if g['c'] in aa_c]
    V['airline_gates'] = len(aa_g)
    desk = [E.n(p['node']) for p in places if p['kind'] == 'checkin' and p.get('airline') == AL['code']]
    if desk:
        d2, _ = dijkstra(G, A, desk)
        miss = [g['ref'] for g in aa_g if gnodes[g['ref']] not in d2]
        if miss: fails.append(f'airline gates unreachable from airline check-in: {len(miss)}')
    # every gate -> curb_arr, baggage, rideshare, taxi (and baggage without re-screening)
    RA = G.radj()
    for k in ('curb_arr', 'baggage', 'rideshare', 'taxi'):
        if not kinds.get(k): continue
        can = reach(RA, kinds[k], G)
        miss = [r for r, n in gnodes.items() if n is None or n not in can]
        if miss: fails.append(f'gates that cannot reach {k}: {len(miss)} {sorted(miss, key=gkey)[:12]}')
    bagset = set(kinds.get('baggage', []))
    screened = []
    prim = [g for g in gates if 'of' not in g and gnodes[g['ref']] is not None]
    for g in prim:
        d, pv = dijkstra(G, A, [gnodes[g['ref']]])
        hit = [b for b in bagset if b in d]
        if not hit: continue
        b = min(hit, key=lambda x: d[x])
        if any(G.E[ei]['k'] == 'security' for ei in path_edges(G, pv, b)): screened.append(g['ref'])
    if screened: fails.append(f'gate->baggage paths through screening: {len(screened)}')
    # walking minutes (engine cost model)
    def mins(a, b):
        if a is None or b is None: return None
        d, _ = dijkstra(G, A, [a])
        return round(d[b] / 60, 1) if b in d else None
    if dep and prim:
        far = max((dist.get(gnodes[g['ref']], 0), g['ref']) for g in prim)
        V['curb_to_farthest_gate_min'] = round(far[0] / 60, 1)
    if prim:
        # gate-to-gate spread: from the first gate of each concourse to the farthest gate
        d0, _ = dijkstra(G, A, [gnodes[prim[0]['ref']]], skip=())
        vals = [d0[gnodes[g['ref']]] for g in prim if gnodes[g['ref']] in d0]
        V['gate_to_gate_max_min'] = round(max(vals) / 60, 1) if vals else None
    for a, b in (C.get('walk_samples') or []):
        V[f'walk_{a}_{b}_min'] = mins(gnodes.get(a), gnodes.get(b))
    lens = sorted(e['m'] for e in G.E if e['k'] in WALKISH)
    V['walk_edge_m_median'] = lens[len(lens) // 2] if lens else None
    return V


# ------------------------------------------------------------------------------------------------ main
def counts(D):
    if not D: return None
    ek = collections.Counter(e[3] for e in D['graph']['edges'])
    return {'units': len(D['units']), 'lines': len(D['lines']), 'gates': len(D['gates']), 'stands': len(D['stands']),
            'pois': len(D['pois']), 'places': len(D.get('places') or []), 'nodes': len(D['graph']['nodes']),
            'edges': len(D['graph']['edges']), 'security': ek.get('security', 0), 'exit': ek.get('exit', 0),
            'presets': len(D.get('presets') or [])}


def main(argv):
    check = '--check' in argv
    args = [a.upper() for a in argv if not a.startswith('--')]
    CFG = load_json(CFG_PATH)
    codes = [c for c in CFG if re.match(r'^[A-Z]{3}$', c)] if not args or args == ['ALL'] else args
    bad = 0
    for code in codes:
        if code not in CFG: print(f'{code}: not in config'); bad += 1; continue
        dst = os.path.join(IND, code + '.json')
        before = load_json(dst) if os.path.exists(dst) else None
        D, rep, fails, AL = build(code, CFG)
        V = validate(D, CFG[code], AL, rep, fails)
        s = json.dumps(D, separators=(',', ':'), ensure_ascii=False)
        print(f'== {code}  {len(s) / 1024:.0f} KB')
        print('  before', json.dumps(counts(before)))
        print('  after ', json.dumps(counts(D)))
        for k, v in list(rep.items()) + list(V.items()):
            print(f'  {k}: {json.dumps(v)}')
        if fails:
            bad += len(fails)
            for f in fails: print(f'  FAIL {f}')
        else:
            print('  checks ok')
        if not check:
            write_atomic(dst, s)
            print(f'  wrote guide/indoor/{code}.json')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
