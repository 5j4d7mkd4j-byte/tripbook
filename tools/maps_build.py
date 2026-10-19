#!/usr/bin/env python3
"""Schematic airport maps for the trip guide: PHX Terminal 4, CLT, LGA Terminal B.

Output: guide/maps.json = {CODE: {viewBox, svg, points, notes, source}}, the `map`
object of guide.airports.<CODE> in app/CONTRACT.md (`source` names the official data
and its date for the app's caption), plus guide/maps_preview.html (light and dark
preview with a demo gate pulse; add #points to the URL to see points).

The maps are hand-laid schematics, north up, 360 units wide for a 350px card.
Every concourse is drawn as a straight pier, so the app can place any gate by
linear interpolation along points.<id>_line (or use the drawn dot,
circle[data-g="A22"]; carousels are rect[data-bag="6"]). Which gates exist,
their walking order, the compass direction of each pier and which side the odd
gates sit on all come from the airports' official map data, and every layout is
checked against it:
  PHX  maps.skyharbor.aero         Atrius/LocusLabs venue POIs
  LGA  maps.laguardiaairport.com   Atrius/LocusLabs venue POIs
  CLT  cltairport.com/shop-dine-and-relax/   POI list embedded in the page
Downloads are cached in research/airportmaps/ (gitignored); --refresh fetches
again, and a download that fails or no longer holds the terminal's gates is
reported and skipped, so the build carries on from the cached copy. Any failed
check exits 1 and leaves the existing outputs untouched (--draft still writes the
preview, to look at the problem).

  python3 -I tools/maps_build.py [--refresh] [--no-preview] [--draft] [--cache DIR] [--out DIR]

Standard library only. HTTPS goes through urllib, falling back to curl when the
local Python has no usable CA bundle (common on macOS framework builds).
"""
import argparse
import html
import json
import math
import os
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'research', 'airportmaps')
OUT = os.path.join(ROOT, 'guide', 'maps.json')
PREVIEW = os.path.join(ROOT, 'guide', 'maps_preview.html')
UA = 'Mozilla/5.0 (Macintosh) trip-guide-maps/1.0'

# Per airport: where the official data lives, the floor-id prefix that holds the
# terminal's gates, and the origin (lat, lon, metres per degree of latitude) of a
# local metric projection.
SRC = {
    'PHX': {'atrius': 'https://maps.skyharbor.aero', 'floor': 'phx-terminal4',
            'origin': (33.4345, -111.9990, 110900)},
    'CLT': {'page': 'https://www.cltairport.com/shop-dine-and-relax/', 'floor': 'clt-',
            'origin': (35.2144, -80.9431, 110540)},
    'LGA': {'atrius': 'https://maps.laguardiaairport.com', 'floor': 'lga-tb',
            'origin': (40.7736, -73.8715, 111050)},
}
CLASSES = {'m-bg', 'm-wall', 'm-area', 'm-water', 'm-gate', 'm-route', 'm-label', 'm-you', 'm-sec', 'm-food'}
KINDS = {'gate', 'security', 'food', 'exit', 'bag', 'ride', 'bus', 'train', 'taxi', 'info', 'line'}
GATE_RE = re.compile(r'^Gates?\s+([A-Z]?)(\d+)(.?)')
CLAIM_RE = re.compile(r'^Baggage Claim\s+()(\d+)()$')
ORDER_TOL = 5.0     # metres a gate may sit "behind" its predecessor along a pier
SIDE_MIN = 6.0      # metres between the odd and even means needed to call a side
MAX_TURN = 70.0     # degrees a drawn pier may deviate from its real compass direction
FAR = 150.0         # metres apart before two piers' relative position must match
MIN_TEXT = 9        # smallest font size in viewBox units
MIN_GATES = 20      # a download with fewer gates on the terminal's floors is not trusted
# How app/src/screens/airports.js shows map words: it hides the SVG text and redraws
# each word as an HTML label, 14px when font-size >= 10 and 13px otherwise, bold or
# large ones from zoom 1 and the rest from zoom 1.4, never cut by the frame. The map
# box is the card width (335px on the narrowest iPhone, 350px usually) and at most
# 460px tall; the view can pan 24px past the map's edge.
APP_W = (335, 350)
APP_MAX_H = 460
APP_PAN = 24


# ---------------------------------------------------------------- data

def fetch(url):
    """GET url as bytes: urllib first, curl when the Python SSL setup fails."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except Exception as e:  # noqa: BLE001 - any urllib failure falls back to curl
        r = subprocess.run(['curl', '-fsSL', '--max-time', '120', '-A', UA, url], capture_output=True)
        if r.returncode:
            raise RuntimeError(f'download failed: {url} ({e}; curl exit {r.returncode})') from None
        return r.stdout


def save(path, data):
    """Write bytes atomically so an interrupted run never leaves half a file."""
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def usable(code, pois):
    """Raise unless a parsed POI list still holds the terminal's gates, so a changed
    or truncated download never replaces a good cache."""
    if isinstance(pois, dict):
        pois = list(pois.values())
    n = len(real_points(code, pois, 'gate', GATE_RE)) if isinstance(pois, list) else 0
    if n < MIN_GATES:
        raise RuntimeError(f"only {n} numbered gates on floors {SRC[code]['floor']}* (expected {MIN_GATES}+)")


def refresh(code, cache):
    """Download one airport's POI list (plus the Atrius manifest for its version).
    Everything is fetched and checked before anything in the cache is replaced."""
    src, c = SRC[code], code.lower()
    if 'atrius' in src:
        loader = json.loads(fetch(src['atrius'] + '/config.json'))['plugins']['venueDataLoader']
        manifest = fetch(f"https://a.locuslabs.com/accounts/{loader['accountId']}/v5.json")
        pois = fetch(json.loads(manifest)[loader['venueId']]['files']['pois'])
        usable(code, json.loads(pois))
        save(os.path.join(cache, f'manifest_{c}.json'), manifest)
        save(os.path.join(cache, f'{c}_pois.json'), pois)
    else:
        page = fetch(src['page']).decode('utf-8', 'replace')
        m = re.search(r'<script id="__NEXT_DATA__" type="application/json"[^>]*>(.*?)</script>', page, re.S)
        if not m:
            raise RuntimeError('CLT page has no __NEXT_DATA__ block')
        pois = json.loads(m.group(1))['props']['pageProps']['pois']
        usable(code, pois)
        save(os.path.join(cache, f'{c}_pois.json'), json.dumps(pois).encode())


def load(code, cache):
    """(POI list, data version YYYY-MM-DD) from the cache; exits with a hint when
    there is no usable copy."""
    c = code.lower()
    path = os.path.join(cache, f'{c}_pois.json')
    try:
        with open(path) as f:
            pois = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f'{code}: no usable cached data at {path} ({e.__class__.__name__}); run with --refresh')
    if isinstance(pois, dict):
        pois = list(pois.values())
    if not isinstance(pois, list):
        sys.exit(f'{code}: cached data at {path} is not a POI list; run with --refresh')
    # Atrius manifests are keyed by venue id (phx, lga). The CLT page carries no
    # version, and a missing manifest falls back the same way: the download date.
    ver = ''
    if 'atrius' in SRC[code]:
        try:
            with open(os.path.join(cache, f'manifest_{c}.json')) as f:
                ver = str(json.load(f)[c]['assetVersion'])[:10]
        except (OSError, ValueError, KeyError, TypeError):
            pass
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', ver):
        ver = datetime.fromtimestamp(os.path.getmtime(path)).strftime('%Y-%m-%d')
    return pois, ver


def project(code, lat, lon):
    """Metres from the airport origin, x east and y south (the SVG orientation)."""
    lat0, lon0, k = SRC[code]['origin']
    return (lon - lon0) * 111320 * math.cos(math.radians(lat0)), -(lat - lat0) * k


def real_points(code, pois, category, pattern):
    """{(prefix, number): (x, y)} for named, numbered POIs on the terminal's floors.
    Split gates (E14A, "Gates B15A, B15B") fold onto their number; a plain name wins."""
    plain, split = {}, {}
    for p in pois:
        pos = p.get('position') if isinstance(p, dict) else None
        if not isinstance(pos, dict) or p.get('category') != category \
                or not str(pos.get('floorId', '')).startswith(SRC[code]['floor']):
            continue
        m = pattern.match(str(p.get('name') or ''))
        try:
            xy = project(code, float(pos['latitude']), float(pos['longitude']))
        except (KeyError, TypeError, ValueError):
            continue   # no usable position: it cannot be checked against the layout
        if m and all(map(math.isfinite, xy)):
            bucket = split if m.group(3).isalnum() else plain
            bucket.setdefault((m.group(1), int(m.group(2))), []).append(xy)
    out = {}
    for key in set(plain) | set(split):
        pts = plain.get(key) or split[key]
        out[key] = (sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts))
    return out


# ---------------------------------------------------------------- SVG helpers

def num(v):
    """Compact number for SVG and JSON (one decimal at most)."""
    v = round(float(v), 1)
    return int(v) if v == int(v) else v


def el(tag, attrs, text=None):
    """One SVG element; cls -> class, data_g -> data-g, None values dropped."""
    out = [tag]
    for k, v in attrs.items():
        if v is None:
            continue
        k = 'class' if k == 'cls' else k.replace('_', '-')
        out.append(f'{k}="{html.escape(str(num(v) if isinstance(v, float) else v))}"')
    head = '<' + ' '.join(out)
    return head + '/>' if text is None else f'{head}>{html.escape(text, quote=False)}</{tag}>'


def text_width(s, size, weight):
    """Rough ink width of a string in a system sans, for the overlap lint."""
    w = 0.0
    for ch in s:
        w += 0.3 if ch in "il1.,:;'|!·jtfr ()/-" else 0.85 if ch in 'mwMW' else 0.66 if ch.isupper() else 0.56
    return w * size * (1.07 if weight >= 600 else 1.0)


def pts_d(pts, close=False):
    return 'M' + ' L'.join(f'{num(x)},{num(y)}' for x, y in pts) + (' Z' if close else '')


def flip(side):
    return 'right' if side == 'left' else 'left'


class Map:
    """One airport: shapes in paint order, points, concourse lines and notes."""
    LAYERS = ('area', 'wall', 'sec', 'route', 'gate', 'food', 'text', 'top')

    def __init__(self, code, w, h):
        self.code, self.w, self.h = code, w, h
        self.layers = {k: [] for k in self.LAYERS}
        self.texts = []      # (x0, y0, x1, y1, s, cls): estimated text boxes for the lint
        self.words = []      # (x, y, s, size, anchor, weight): words the app redraws as labels
        self.walls = []      # m-wall rect boxes, which gate labels must clear
        self.lines = []      # concourse (and carousel) specs, resolved in build()
        self.later = []      # points placed beside a gate, resolved once sides are known
        self.points, self.notes, self.food_at = {}, [], set()
        self.source = ''     # the official data and its date, for the app's caption

    # shapes
    def rect(self, cls, x, y, w, h, rx=0):
        layer = {'m-area': 'area', 'm-water': 'area', 'm-wall': 'wall', 'm-sec': 'sec'}[cls]
        self.layers[layer].append(el('rect', dict(cls=cls, x=x, y=y, width=w, height=h, rx=rx or None)))
        if cls == 'm-wall':
            self.walls.append((x, y, x + w, y + h))

    def poly(self, cls, pts):
        self.layers['wall' if cls == 'm-wall' else 'area'].append(el('path', dict(cls=cls, d=pts_d(pts, True))))

    def bar(self, cls, p1, p2, width):
        """A rotated rectangle `width` wide around the segment p1-p2."""
        (x1, y1), (x2, y2) = p1, p2
        k = width / 2 / math.hypot(x2 - x1, y2 - y1)
        nx, ny = -(y2 - y1) * k, (x2 - x1) * k
        self.poly(cls, [(x1 + nx, y1 + ny), (x2 + nx, y2 + ny), (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)])

    def text(self, x, y, s, size=9, anchor='middle', weight=400, cls='m-label', app=True):
        """A word on the map. app=False for words the app drops (the legend)."""
        w = text_width(s, size, weight)
        x0 = x - w / 2 if anchor == 'middle' else x - w if anchor == 'end' else x
        self.texts.append((x0, y - 0.72 * size, x0 + w, y + 0.2 * size, s, cls))
        if app and cls != 'm-gate':
            self.words.append((x, y, s, size, anchor, weight))
        self.layers['text'].append(el('text', dict(cls=cls, x=x, y=y, font_size=size, font_weight=weight,
                                                   text_anchor=anchor), s))

    def route(self, name, pts):
        self.layers['route'].append(el('path', dict(cls='m-route', id=f'route-{name}', d=pts_d(pts), fill='none')))

    def you(self, x, y):
        self.layers['top'].append(el('circle', dict(cls='m-you', id='you', cx=x, cy=y, r=4.5)))

    # points
    def point(self, pid, x, y, label, kind):
        self.points[pid] = dict(x=num(x), y=num(y), label=label, kind=kind)

    def sec(self, pid, x, y, w, h, mark, label):
        """A checkpoint box with its letter, plus its point."""
        self.rect('m-sec', x, y, w, h, 2)
        self.text(x + w / 2, y + h / 2 + 3.2, mark, 9, 'middle', 700)
        self.point(pid, x + w / 2, y + h / 2, label, 'security')

    def food(self, pid, x, y, label):
        """A food dot (drawn once per spot) plus its point."""
        if (num(x), num(y)) not in self.food_at:
            self.food_at.add((num(x), num(y)))
            self.layers['food'].append(el('circle', dict(cls='m-food', cx=x, cy=y, r=2.4)))
        self.point(pid, x, y, label, kind='food')

    def at_gate(self, pid, lid, n, label, kind, inset=0.0):
        """A point beside gate n of line lid; inset > 0 moves it toward that gate's
        label side, < 0 away. n may be fractional to sit between two gates."""
        self.later.append((pid, lid, n, label, kind, inset))

    # concourses
    def line(self, lid, prefix, first, last, p1, p2, *, side='parity', fmt='full', show=True, hw=7,
             via=(), header=None, walk=None, label=None, kind='gate'):
        """A pier from gate `first` at p1 to gate `last` at p2.
        side: 'parity' (odd gates on the side the official data says), 'left' or
        'right' of travel for every gate, or 'alt' (alternate, for a tight curve).
        fmt 'full' labels A12, 'num' labels 12 (with a header naming the pier)."""
        self.lines.append(dict(id=lid, prefix=prefix, first=first, last=last, p1=p1, p2=p2, side=side, fmt=fmt,
                               show=show, hw=hw, via=[tuple(p) for p in via], header=header, walk=walk,
                               label=label, kind=kind))

    def legend(self, x, y):
        rows = (('Gate', 'circle', dict(cls='m-gate', cx=x + 4, cy=0, r=2.2)),
                ('Food', 'circle', dict(cls='m-food', cx=x + 4, cy=0, r=2.4)),
                ('Security', 'rect', dict(cls='m-sec', x=x, y=-4, width=8, height=8, rx=1.5)),
                ('You', 'circle', dict(cls='m-you', cx=x + 4, cy=0, r=3.5)),
                ('Route', 'line', dict(cls='m-route', x1=x - 1, x2=x + 10)))
        for i, (s, tag, a) in enumerate(rows):
            cy = y + i * 13
            a = dict(a)
            if 'cy' in a:
                a['cy'] = cy
            elif tag == 'rect':
                a['y'] = cy - 4
            else:
                a['y1'] = a['y2'] = cy
            self.layers['top'].append(el(tag, a))
            self.text(x + 15, cy + 3.2, s, 9, 'start', app=False)
        self.text(x, y + 5 * 13 + 4, '↑ N · schematic', 9, 'start', app=False)

    # geometry
    @staticmethod
    def along(L, n):
        t = 0.0 if L['last'] == L['first'] else (n - L['first']) / (L['last'] - L['first'])
        (x1, y1), (x2, y2) = L['p1'], L['p2']
        return x1 + t * (x2 - x1), y1 + t * (y2 - y1)

    @staticmethod
    def normal(L, side):
        (x1, y1), (x2, y2) = L['p1'], L['p2']
        d = math.hypot(x2 - x1, y2 - y1)
        dx, dy = (x2 - x1) / d, (y2 - y1) / d
        return (dy, -dx) if side == 'left' else (-dy, dx)   # y points down

    def side_of(self, L, n, index):
        if L['side'] == 'parity':
            return L['odd'] if n % 2 else flip(L['odd'])
        if L['side'] == 'alt':
            return 'left' if index % 2 == 0 else 'right'
        return L['side']

    def build(self, real, claims):
        """Draw gates and carousels from the official data; returns (map dict, errors, report lines)."""
        errs, report = [], []
        lines = {L['id']: L for L in self.lines}
        for L in self.lines:
            src = real if L['kind'] == 'gate' else claims
            have = in_range(L, src)
            if L['side'] == 'parity':
                L['odd'], diff = parity_side(have)
                report.append(f"{self.code} {L['id']}: odd gates {L['odd'] or '??'} of travel ({diff:+.0f} m)")
                if not L['odd']:
                    errs.append(f"{self.code} {L['id']}: official data does not show which side odd gates are on")
                    L['odd'] = 'right'
            if L['kind'] == 'gate':
                self.draw_gates(L, have)
            else:
                self.draw_carousels(L, have)
            (x1, y1), (x2, y2) = L['p1'], L['p2']
            p = dict(x=num((x1 + x2) / 2), y=num((y1 + y2) / 2),
                     label=L['label'] or f"Gates {L['prefix']}{L['first']}–{L['last']}", kind='line',
                     x1=num(x1), y1=num(y1), x2=num(x2), y2=num(y2), prefix=L['prefix'],
                     **{'from': L['first'], 'to': L['last'], 'for': L['kind']},
                     via=[[num(a), num(b)] for a, b in L['via']])
            if L['walk']:
                p['walk'] = L['walk']
            self.points[f"{L['id']}_line"] = p
        for pid, lid, n, label, kind, inset in self.later:
            L = lines[lid]
            index = sum(1 for g, _ in in_range(L, real) if g < n)
            (cx, cy), (nx, ny) = self.along(L, n), self.normal(L, self.side_of(L, int(n), index))
            x, y = cx + nx * inset, cy + ny * inset
            if kind == 'food':
                self.food(pid, x, y, label)
            else:
                self.point(pid, x, y, label, kind)
        svg = el('rect', dict(cls='m-bg', x=0, y=0, width=self.w, height=self.h)) + ''.join(
            ''.join(self.layers[k]) for k in self.LAYERS)
        return dict(viewBox=f'0 0 {self.w} {self.h}', svg=svg, points=self.points, notes=self.notes,
                    source=self.source), errs, report

    def draw_gates(self, L, have):
        """A dot per official gate just inside the pier edge, its label just outside."""
        size, hw = 9, L['hw']
        for i, (n, _) in enumerate(have):
            (cx, cy), (nx, ny) = self.along(L, n), self.normal(L, self.side_of(L, n, i))
            g = f"{L['prefix']}{n}"
            self.layers['gate'].append(el('circle', dict(cls='m-gate', cx=cx + nx * (hw - 3.5),
                                                         cy=cy + ny * (hw - 3.5), r=2.2, data_g=g)))
            if L['show'] is True or (L['show'] and n in L['show']):
                off = hw + 4 + abs(ny) * size * 0.4
                anchor = 'start' if nx > 0.5 else 'end' if nx < -0.5 else 'middle'
                self.text(cx + nx * off, cy + ny * off + 0.35 * size, g if L['fmt'] == 'full' else str(n),
                          size, anchor, 400, 'm-gate')
        if L['header']:
            x, y, s, *anchor = L['header']
            self.text(x, y, s, 10, anchor[0] if anchor else 'middle', 700)

    def draw_carousels(self, L, have):
        """Carousel n as a small floor-coloured slab with its number beneath."""
        for n, _ in have:
            cx, cy = self.along(L, n)
            self.layers['gate'].append(el('rect', dict(cls='m-wall', x=cx - 5, y=cy - 4, width=10, height=8, rx=2,
                                                       data_bag=n)))
            self.text(cx, cy + 16, str(n), 9, 'middle', 400)


def in_range(L, src):
    """Sorted [(number, real xy)] of the official points this line covers."""
    return sorted((n, xy) for (pre, n), xy in src.items() if pre == L['prefix'] and L['first'] <= n <= L['last'])


def parity_side(have):
    """Which side of travel (first -> last gate) the odd gates are on, from the
    real positions: ('left'|'right'|None, odd mean minus even mean in metres)."""
    if len(have) < 3:
        return None, 0.0
    (ax, ay), (bx, by) = have[0][1], have[-1][1]
    d = math.hypot(bx - ax, by - ay)
    side = [((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / d for _, (x, y) in have]  # > 0: right (y down)
    odd = [s for (n, _), s in zip(have, side) if n % 2]
    even = [s for (n, _), s in zip(have, side) if not n % 2]
    if not odd or not even:
        return None, 0.0
    diff = sum(odd) / len(odd) - sum(even) / len(even)
    return ('right' if diff > SIDE_MIN else 'left' if diff < -SIDE_MIN else None), diff


# ---------------------------------------------------------------- checks

def check_lines(m, real, claims):
    """Official gates vs the drawn piers: coverage, order, direction, relative position, vias."""
    errs, code = [], m.code
    gate_lines = [L for L in m.lines if L['kind'] == 'gate']
    for pre, n in sorted(real):
        hits = [L['id'] for L in gate_lines if L['prefix'] == pre and L['first'] <= n <= L['last']]
        if len(hits) != 1:
            errs.append(f'{code}: official gate {pre}{n} falls on {len(hits)} lines {hits}')
    hub = m.points.get('hub')
    cents = []
    for L in m.lines:
        src = real if L['kind'] == 'gate' else claims
        have = in_range(L, src)
        if len(have) < 2:
            errs.append(f"{code} {L['id']}: fewer than two official points in {L['first']}-{L['last']}")
            continue
        missing = [n for n in (L['first'], L['last']) if n not in dict(have)]
        if L['kind'] != 'gate' and missing:
            errs.append(f"{code} {L['id']}: ends {missing} not in the official data")
        (ax, ay), (bx, by) = have[0][1], have[-1][1]
        span = math.hypot(bx - ax, by - ay)
        ux, uy = (bx - ax) / span, (by - ay) / span
        # walking order: numbers must advance along the pier (per side when gates alternate)
        groups = [[g for g in have if g[0] % 2], [g for g in have if not g[0] % 2]] if L['side'] == 'parity' else [have]
        for grp in groups:
            proj = [(n, (x - ax) * ux + (y - ay) * uy) for n, (x, y) in grp]
            for (n1, t1), (n2, t2) in zip(proj, proj[1:]):
                if t2 < t1 - ORDER_TOL:
                    errs.append(f"{code} {L['id']}: {L['prefix']}{n2} is {t1 - t2:.0f} m behind {L['prefix']}{n1}")
        # compass direction: drawn pier within MAX_TURN of the real one (north up, no mirroring)
        (x1, y1), (x2, y2) = L['p1'], L['p2']
        if span >= 20:
            cos = ((x2 - x1) * ux + (y2 - y1) * uy) / math.hypot(x2 - x1, y2 - y1)
            turn = math.degrees(math.acos(max(-1.0, min(1.0, cos))))
            if turn > MAX_TURN:
                errs.append(f"{code} {L['id']}: drawn {turn:.0f}° off its real direction")
        # the via must start at the hub and end on the line
        if L['via']:
            if hub and tuple(L['via'][0]) != (hub['x'], hub['y']):
                errs.append(f"{code} {L['id']}: via does not start at the hub")
            if seg_dist(L['via'][-1], L['p1'], L['p2']) > 0.6:
                errs.append(f"{code} {L['id']}: via does not end on the line")
        if L['kind'] == 'gate':
            rx = sum(p[0] for _, p in have) / len(have)
            ry = sum(p[1] for _, p in have) / len(have)
            sx = sum(Map.along(L, n)[0] for n, _ in have) / len(have)
            sy = sum(Map.along(L, n)[1] for n, _ in have) / len(have)
            cents.append((L['id'], rx, ry, sx, sy))
    # relative position: piers far apart in reality keep their east/west and north/south order
    for i, a in enumerate(cents):
        for b in cents[i + 1:]:
            for axis, name in ((1, 'east-west'), (2, 'north-south')):
                dr = b[axis] - a[axis]
                if abs(dr) > FAR and (b[axis + 2] - a[axis + 2]) * dr <= 0:
                    errs.append(f'{code}: {a[0]} and {b[0]} are drawn in the wrong {name} order')
    return errs


def seg_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def overlap(a, b, pad=0.5):
    return min(a[2], b[2]) - max(a[0], b[0]) > pad and min(a[3], b[3]) - max(a[1], b[1]) > pad


def lint(m, out):
    """The SVG contract (classes, no colours, sizes, ids) and label legibility."""
    errs, code = [], m.code
    root = ET.fromstring(f'<svg xmlns="http://www.w3.org/2000/svg">{out["svg"]}</svg>')
    ids = set()
    for e in root.iter():
        if e is root:
            continue
        tag = e.tag.split('}')[-1]
        cls = (e.get('class') or '').split()
        if not cls or any(c not in CLASSES for c in cls):
            errs.append(f'{code}: <{tag}> has class {cls}')
        for a in ('style', 'stroke', 'color', 'font-family', 'opacity', 'fill-opacity', 'stroke-width'):
            if e.get(a) is not None:
                errs.append(f'{code}: <{tag}> sets {a}')
        if e.get('fill') not in (None, 'none'):
            errs.append(f'{code}: <{tag}> sets fill={e.get("fill")}')
        if tag == 'text' and float(e.get('font-size', 0)) < MIN_TEXT:
            errs.append(f'{code}: text {e.text!r} is under {MIN_TEXT}')
        if e.get('id'):
            if e.get('id') in ids:
                errs.append(f'{code}: duplicate id {e.get("id")}')
            ids.add(e.get('id'))
        if 'm-route' in cls and tag == 'path' and not re.fullmatch(r'route-[a-z0-9-]+', e.get('id') or ''):
            errs.append(f'{code}: route path without a route-<name> id')
    if 'you' not in ids:
        errs.append(f'{code}: no #you marker')
    for t in m.texts:
        if t[0] < 1 or t[1] < 1 or t[2] > m.w - 1 or t[3] > m.h - 1:
            errs.append(f'{code}: text {t[4]!r} runs off the map')
    for i, a in enumerate(m.texts):
        for b in m.texts[i + 1:]:
            if overlap(a, b):
                errs.append(f'{code}: text {a[4]!r} overlaps {b[4]!r}')
        if a[5] == 'm-gate':
            for w in m.walls:
                if overlap(a, w):
                    errs.append(f'{code}: gate label {a[4]!r} sits on a wall at {tuple(num(v) for v in w)}')
    for pid, p in out['points'].items():
        if p['kind'] not in KINDS or not p.get('label'):
            errs.append(f'{code}: point {pid} kind {p["kind"]!r} or label missing')
        if not (0 <= p['x'] <= m.w and 0 <= p['y'] <= m.h):
            errs.append(f'{code}: point {pid} outside the map')
    if not m.source:
        errs.append(f'{code}: no source')
    return errs + app_fit(m, out['points'])


def app_fit(m, points):
    """Map words as the app draws them (see APP_W): a bold or large word must fit
    whole in the frame at zoom 1 and clear the other zoom-1 words, or the app hides
    it; a plain word (zoom 1.4 up) must fit inside the map plus the pan margin."""
    errs, zoom1 = [], {}
    icons = [(p['x'], p['y']) for pid, p in points.items() if p['kind'] not in ('gate', 'line') and pid != 'hub']
    for x, y, s, size, anchor, weight in m.words:
        px = 14 if size >= 10 else 13
        wpx, hpx = 0.6 * px * len(s) + 2, 1.15 * px
        first = 1.0 if size >= 10 or weight >= 600 else 1.4
        cy = y - 0.35 * size
        for W in APP_W:
            H = min(W * m.h / m.w, APP_MAX_H)
            k = min(W / m.w, H / m.h) * first
            half = wpx / 2 / k
            mid = x + half if anchor == 'start' else x - half if anchor == 'end' else x
            # The app skips a word that sits on a place's icon (that bubble names it).
            if not s.isdigit() and any(math.hypot(px_ - mid, py_ - cy) < 14 for px_, py_ in icons):
                break
            box = (mid - half, cy - hpx / 2 / k, mid + half, cy + hpx / 2 / k)
            if first == 1.0:
                vw, vh = W / k, H / k
                frame = (m.w / 2 - vw / 2, m.h / 2 - vh / 2, m.w / 2 + vw / 2, m.h / 2 + vh / 2)
                zoom1.setdefault(W, []).append((box, s, 3 / k))
            else:
                pan = APP_PAN / k
                frame = (-pan, -pan, m.w + pan, m.h + pan)
            if box[0] < frame[0] - 2 / k or box[1] < frame[1] - 2 / k or box[2] > frame[2] + 2 / k \
                    or box[3] > frame[3] + 2 / k:
                errs.append(f'{m.code}: app label {s!r} is cut by the frame at {W}px, so the app hides it')
                break
    for W, words in zoom1.items():
        for i, (a, s, pad) in enumerate(words):
            for b, t, _ in words[i + 1:]:
                if overlap(a, b, -pad):
                    errs.append(f'{m.code}: app labels {s!r} and {t!r} collide at {W}px zoom 1; one is hidden')
    return sorted(set(errs), key=errs.index)


# ---------------------------------------------------------------- layouts
# Coordinates are viewBox units (360 wide, y down). Comments give the real layout
# each shape stands for; check_lines() verifies the gate side of every claim.

def phx(ver):
    """Terminal 4: four piers north (A, B) and four south (D, C) of the headhouse,
    joined airside by a moving-walkway ring, so any checkpoint reaches any gate."""
    m = Map('PHX', 360, 520)
    north = {'a2': (46, 'A', 15, 30), 'a1': (134, 'A', 1, 14), 'b1': (226, 'B', 1, 14), 'b2': (314, 'B', 15, 28)}
    south = {'d2': (46, 'D', 11, 18), 'd1': (134, 'D', 1, 8), 'c1': (226, 'C', 1, 9), 'c2': (314, 'C', 11, 19)}
    hub = (134, 205)   # just past Checkpoint A, the 24-hour one
    for c, *_ in north.values():
        m.rect('m-wall', c - 9, 30, 18, 180)
    for c, *_ in south.values():
        m.rect('m-wall', c - 9, 376, 18, 114)
    m.rect('m-wall', 34, 196, 304, 18)     # north airside corridor
    m.rect('m-wall', 34, 366, 304, 16)     # south airside corridor
    m.rect('m-wall', 106, 196, 12, 186)    # west link of the ring
    m.rect('m-wall', 326, 196, 12, 186)    # east link of the ring
    m.rect('m-area', 128, 240, 92, 100, 4)  # headhouse: check-in L2, bag claim L1
    m.rect('m-area', 154, 344, 48, 18, 3)   # Sky Train station (L3)
    m.sec('sec_a', 127, 214, 15, 26, 'A', 'Checkpoint A: open 24 hours, closest to the A gates')
    m.sec('sec_b', 219, 214, 15, 26, 'B', 'Checkpoint B: 4:15 a.m.-8:30 p.m.')
    m.sec('sec_d', 127, 340, 15, 26, 'D', 'Checkpoint D: 3:15 a.m.-7:30 p.m.')
    m.sec('sec_c', 219, 340, 15, 26, 'C', 'Checkpoint C: 3:15 a.m.-12:30 a.m.')

    for lid, (c, pre, a, b) in north.items():
        via = [hub, (134, 186)] if c == 134 else [hub, (c, 205), (c, 186)]
        m.line(lid, pre, a, b, (c, 186), (c, 40), hw=9, via=via, header=(c, 22, f'{pre}{a}–{b}'))
    for lid, (c, pre, a, b) in south.items():
        link = 332 if c == 314 else 112   # C11-19 is nearer the east link
        m.line(lid, pre, a, b, (c, 394), (c, 478), hw=9, via=[hub, (link, 205), (link, 374), (c, 374), (c, 394)],
               header=(c, 504, f'{pre}{a}–{b}'))

    m.text(185, 231, 'Doors 21–27', 9)
    m.text(182, 255, 'AA check-in', 9)
    m.text(174, 282, 'Terminal 4', 11, weight=700)
    m.text(174, 296, 'Check-in L2', 9)
    m.text(174, 308, 'Bag claim L1', 9)
    m.text(174, 334, 'Doors 22–28', 9)
    m.text(178, 356, 'Sky Train', 9)
    m.legend(246, 248)
    m.route('depart', [(150, 227), (150, 258), (134, 258), hub])
    m.you(150, 227)

    m.point('hub', *hub, 'Airside, just past Checkpoint A', 'info')
    m.point('curb', 150, 227, 'Level 2 north curb, Doors 21 and 23 for American (Door 23 for wheelchairs)', 'exit')
    m.point('checkin', 150, 258, 'American check-in, Level 2, inside Doors 21 and 23', 'info')
    m.point('bag', 174, 308, 'Baggage claim, Level 1', 'bag')
    m.point('ride', 150, 334, 'Rideshare pickup, Level 1 outer curb: Door 1 (north, far west) or Doors 2, 6, 8 (south)',
            'ride')
    m.point('taxi', 198, 334, 'Taxis, Level 1: Door 7 (north) or Door 4 (south)', 'taxi')
    m.point('skytrain', 178, 353, 'PHX Sky Train T4 station, Level 3 (free, 24/7)', 'train')
    m.food('dunkin', 208, 266, "Dunkin', Level 3 before security (24 hours)")
    m.at_gate('olive_a4', 'a1', 4, 'Olive & Ivy near A4 (from 4 a.m.)', 'food')
    m.at_gate('blanco_a5', 'a1', 5, 'Blanco Tacos near A5 (from 4 a.m.)', 'food')
    m.at_gate('dillys_a7', 'a1', 7, "Dilly's Deli near A7 (24 hours)", 'food')
    m.at_gate('dillys_a17', 'a2', 17, "Dilly's Deli Express near A17 (24 hours)", 'food')
    m.at_gate('peets_a17', 'a2', 17, "Peet's Coffee near A17 (from 4:30 a.m.)", 'food')
    m.at_gate('cowboy_b1', 'b1', 1, 'Cowboy Ciao kiosk near B1 (24 hours)', 'food')
    m.at_gate('focaccia_b6', 'b1', 6, 'Focaccia Fiorentina near B6 (24 hours)', 'food')
    m.at_gate('mission_b17', 'b2', 17, 'Mission Grab-n-Go near B17 (24 hours)', 'food')
    m.at_gate('starbucks_b17', 'b2', 17, 'Starbucks near B17 (from 4:15 a.m.)', 'food')
    m.at_gate('club_a7', 'a1', 8, 'Admirals Club above A7/A9', 'info')
    m.at_gate('club_a19', 'a2', 20, 'Admirals Club between A19 and A21', 'info')
    m.at_gate('club_b5', 'b1', 6, 'Admirals Club above B5/B7', 'info')
    m.source = f'Sky Harbor official map data ({ver}), drawn north up'
    m.notes = [
        'American checks in on Level 2 at the north curb, Doors 21 and 23 (Door 23 for wheelchairs and mobility devices).',
        'Checkpoint A is open 24 hours and is closest to the A gates. B 4:15 a.m.-8:30 p.m., C 3:15 a.m.-12:30 a.m., '
        'D 3:15 a.m.-7:30 p.m.',
        'All T4 concourses connect airside on a moving-walkway ring, so any checkpoint reaches any gate. The farthest '
        'A gate is up to about 1,400 ft from Checkpoint A.',
        "Open before 5 a.m. past security: Dilly's Deli near A7 and Dilly's Deli Express near A17 (24 hours), Olive & Ivy "
        "near A4 and Blanco near A5 (from 4:00), Peet's near A17 (4:30). Before security: Dunkin' on Level 3 (24 hours).",
        'Coming home: bag claim is on Level 1. Taxis at Door 7 (north) or Door 4 (south); rideshare on the Level 1 outer '
        'curb at Door 1 (north) or Doors 2, 6 and 8 (south).',
        'A15, A16, C5 and C15 are not in the official data; if one is assigned, the line still places it by number.',
    ]
    return m


def clt(ver):
    """Charlotte: concourses A-E around the central Atrium, all connected airside
    (no train, no re-screening). Landside check-in and claim sit north of it."""
    m = Map('CLT', 360, 540)
    hub = (184, 357)   # the Atrium
    m.rect('m-wall', 118, 53, 12, 312)        # Concourse A, north toward A North
    m.rect('m-wall', 22, 53, 108, 12)         # A30-39 (A North)
    m.rect('m-wall', 32, 207, 98, 12)         # A21-29 (A North)
    m.rect('m-wall', 10, 351, 140, 12)        # A1-13 and the A/B connector
    m.rect('m-wall', 146, 343, 76, 28, 4)     # Atrium
    m.rect('m-wall', 148, 365, 14, 152)       # Concourse B, south
    m.bar('m-wall', (214, 371), (237, 515), 14)  # Concourse C, south, drifting east
    m.rect('m-wall', 218, 334, 44, 12)        # D/E connector
    m.rect('m-wall', 236, 306, 26, 28, 3)     # D/E plaza
    m.rect('m-wall', 262, 334, 96, 12)        # Concourse D, east
    m.rect('m-wall', 242, 48, 14, 262)        # Concourse E, north
    m.rect('m-wall', 249, 186, 108, 12)       # E10-19 branch, east
    m.rect('m-wall', 191, 42, 129, 12)        # E36-45 round the far end
    m.rect('m-area', 140, 268, 82, 62, 4)     # landside: ticketing upper, claim lower
    m.sec('sec_1', 151, 330, 14, 13, '1', 'Security Checkpoint 1 (west)')
    m.sec('sec_2', 198, 330, 14, 13, '2', 'Security Checkpoint 2 (centre)')
    m.sec('sec_3', 222, 316, 14, 14, '3', 'Security Checkpoint 3 (east, nearest D and E)')

    def to_e(*rest):
        return [hub, (222, 357), (232, 340), (249, 340), *rest]
    m.line('a1', 'A', 1, 13, (114, 357), (14, 357), fmt='num', hw=6, via=[hub, (114, 357)],
           header=(64, 388, 'A1–13'), walk=[3, 5])
    m.line('a2', 'A', 21, 29, (111, 213), (38, 213), fmt='num', hw=6, via=[hub, (124, 357), (124, 213), (111, 213)],
           header=(76, 242, 'A21–29'), walk=[6, 8])
    m.line('a3', 'A', 30, 39, (111, 59), (28, 59), fmt='num', hw=6, via=[hub, (124, 357), (124, 59), (111, 59)],
           header=(71, 88, 'A30–39'), walk=[11, 13])
    m.line('b', 'B', 1, 16, (155, 379), (155, 511), via=[hub, (155, 357), (155, 379)],
           header=(155, 532, 'B1–16'), walk=[1, 5])
    m.line('c', 'C', 2, 19, (215, 379), (236, 509), via=[hub, (215, 357), (215, 379)],
           header=(237, 532, 'C2–19'), walk=[5, 9])
    m.line('d', 'D', 1, 13, (266, 340), (354, 340), fmt='num', hw=6, via=[hub, (222, 357), (232, 340), (266, 340)],
           header=(310, 316, 'D1–13'), walk=[2, 4])
    m.line('e1', 'E', 1, 9, (249, 298), (249, 218), via=to_e((249, 298)), header=(222, 262, 'E1–9', 'end'),
           walk=[3, 5])
    m.line('e2', 'E', 10, 19, (262, 192), (352, 192), fmt='num', hw=6, via=to_e((249, 192), (262, 192)),
           header=(318, 168, 'E10–19'), walk=[6, 8])
    m.line('e3', 'E', 20, 32, (249, 174), (249, 76), via=to_e((249, 174)), header=(222, 128, 'E20–32', 'end'),
           walk=[6, 9])
    # E36-45 curl round the far end, so odd/even sides are not consistent there:
    # labels alternate above and below, spaced so the E spine falls between 39 and 41.
    m.line('e4', 'E', 36, 45, (199, 48), (311.5, 48), side='alt', fmt='num', hw=6, via=to_e((249, 48)),
           header=(187, 52, 'E36–45', 'end'), walk=[6, 9])

    m.text(184, 368, 'Atrium', 9)
    m.text(181, 284, 'Terminal', 10, weight=700)
    m.text(181, 298, 'Check-in upper', 9)
    m.text(181, 310, 'Bag claim lower', 9)
    m.legend(18, 414)
    m.route('connect', [(124, 357), (222, 357), (232, 340), (249, 340)])
    m.you(*hub)

    m.point('hub', *hub, 'Atrium: every concourse connects here airside, no re-screening', 'info')
    m.point('checkin', 181, 294, 'Ticketing and check-in, upper level', 'info')
    m.point('bag', 181, 306, 'Baggage claim 1-8, lower level', 'bag')
    m.point('ride', 150, 322, 'Rideshare pickup, lower level curb', 'ride')
    m.point('taxi', 160, 322, 'Taxis, lower level curb', 'taxi')
    m.point('bus', 205, 322, 'CATS transit buses, lower level curb', 'bus')
    m.food('atrium_w', 160, 349, "Atrium food court: Chick-fil-A, Brookwood Farms BBQ, Cinnabon, Papa John's, "
           "Salsarita's; 1897 Market by the B entrance")
    m.food('atrium_e', 208, 349, "Atrium food court: Burger King, Jersey Mike's, Dunkin', Hissho Sushi")
    m.food('plaza', 249, 322, "D/E Plaza: Shake Shack, Bojangles, Potbelly, Auntie Anne's, Wicked Weed")
    m.food('starbucks_a', 138, 353, 'Starbucks, A connector')
    m.at_gate('starbucks_b10', 'b', 10.5, 'Starbucks near B10', 'food')
    m.at_gate('starbucks_c13', 'c', 13.5, 'Starbucks near C13', 'food')
    m.at_gate('starbucks_d6', 'd', 6.5, 'Starbucks near D6', 'food')
    m.at_gate('aa_desk_b8', 'b', 8, 'American customer service desk near B8', 'info')
    m.at_gate('aa_desk_c9', 'c', 9, 'American customer service desk near C9', 'info')
    m.at_gate('aa_desk_d5', 'd', 5, 'American customer service desk near D5', 'info')
    m.at_gate('aa_desk_e20', 'e3', 20, 'American customer service desk near E20 (E Rotunda)', 'info')
    m.at_gate('club_b', 'b', 3.5, 'Admirals Club, Concourse B (near B3/B4)', 'info')
    m.at_gate('provisions_a1', 'a1', 1, 'Provisions by Admirals Club near A1', 'info')
    m.point('club_cd', 214, 349, 'Admirals Club, upper level by the C/D entrance', 'info')
    m.source = f'CLT official airport website data (fetched {ver}), drawn north up'
    m.notes = [
        'No train at CLT: every concourse connects airside through the Atrium, so a connection never needs re-screening.',
        'Moving walkways run on Concourse A (toward A North), the A/B connector, the D/E connector and Concourse E. '
        'Concourse B has none.',
        "Atrium food: Chick-fil-A, Brookwood Farms BBQ, Cinnabon, Papa John's, Salsarita's, Burger King, Jersey Mike's, "
        "Dunkin', Hissho Sushi, and 1897 Market by the B entrance. D/E Plaza: Shake Shack, Bojangles, Potbelly, "
        "Auntie Anne's, Wicked Weed.",
        'American customer service desks airside: near B8, C9, D5 and E20.',
        'Walk times from the checkpoints (third-party, Aug 2025): B 1-5 min, C 5-9, A1-13 3-5, A21-29 6-8, A30-39 '
        '11-13, D 2-4, E1-9 3-5, E11-19 6-8, E20-43 6-9.',
        'No C1, A14-A20 or E33-E35 in the official data. E14A/B and E16A are drawn at E14 and E16.',
    ]
    return m


def lga(ver):
    """LaGuardia Terminal B: the Western Concourse island (gates 11-31, American)
    reached by a bridge over the taxiway, the headhouse levels, and the Eastern
    Concourse (40-59). No AirTrain: it was canceled in March 2023."""
    m = Map('LGA', 360, 462)
    hub = (160, 304)   # where the Western Concourse bridge lands, Level 4
    m.poly('m-wall', [(10, 46), (236, 46), (200, 170), (10, 170)])  # Western Concourse, gates round the edge
    m.rect('m-wall', 153, 170, 14, 124)      # pedestrian bridge over the taxiway (opened 2022)
    m.rect('m-wall', 64, 292, 204, 30)       # Level 4 food hall, airside
    m.rect('m-wall', 266, 298, 36, 12)       # bridge to the Eastern Concourse
    m.rect('m-wall', 296, 196, 26, 104)      # Eastern Concourse, north arm
    m.rect('m-wall', 296, 288, 42, 34)       # Eastern Concourse, elbow
    m.rect('m-wall', 320, 300, 18, 152)      # Eastern Concourse, south-east arm
    m.rect('m-area', 64, 325, 204, 28)       # Level 3 departures
    m.rect('m-area', 64, 356, 204, 48)       # Level 2 arrivals and bag claim
    m.rect('m-area', 64, 407, 204, 14)       # Level 2 curb
    m.rect('m-area', 64, 424, 204, 14)       # Level 1 curb
    m.rect('m-area', 8, 330, 50, 108, 3)     # Terminal B garage, west
    m.sec('sec', 141, 329, 28, 16, 'TSA', 'Security checkpoint, Level 3 (TSA PreCheck; no CLEAR in Terminal B)')

    w = dict(side='left', hw=0, walk=[4, 6])
    m.line('w1', '', 11, 17, (146, 170), (18, 170), via=[hub, (160, 170), (146, 170)], **w)
    m.line('w2', '', 18, 23, (20, 46), (128, 46), via=[hub, (160, 170), (128, 46)], **w)
    m.line('w3', '', 24, 27, (166, 46), (226, 46), via=[hub, (160, 170), (166, 46)], **w)
    m.line('w4', '', 28, 31, (231.7, 60.9), (203.6, 157.6), via=[hub, (160, 170), (203.6, 157.6)], **w)
    e = dict(side='left', hw=3, walk=[6, 9])
    m.line('e1', '', 40, 44, (300, 284), (300, 206), via=[hub, (300, 304), (300, 284)], **e)
    m.line('e2', '', 45, 47, (318, 206), (318, 262), via=[hub, (318, 304), (318, 262)], **e)
    m.line('e3', '', 48, 53, (335, 330), (335, 446), via=[hub, (335, 304), (335, 330)], **e)
    m.line('e4', '', 54, 57, (323, 446), (323, 340), via=[hub, (323, 304), (323, 340)], **e)
    m.line('e5', '', 58, 59, (306, 316), (314, 316), show=False, via=[hub, (306, 304), (306, 316)], **e)
    m.text(293, 320, '58–59', 9, 'end', cls='m-gate')
    m.line('claim', '', 1, 9, (104, 375), (259, 375), side='left', kind='baggage', label='Baggage carousels 1–9, Level 2',
           via=[hub, (230, 304), (230, 375)])

    m.text(80, 100, 'Western Concourse', 11, weight=700)
    m.text(80, 114, 'Gates 11–31 · American', 9)
    m.text(174, 236, 'Bridge over taxiway', 9, 'start')
    m.text(354, 180, 'Eastern Concourse', 9, 'end', 700)
    m.text(354, 192, 'Gates 40–59', 9, 'end')
    m.text(68, 314, 'L4 Food hall', 9, 'start')
    m.text(236, 315, 'Exit', 9, 'start')
    m.text(68, 342, 'L3', 9, 'start', 700)
    m.text(82, 342, 'AA check-in', 9, 'start')
    m.text(68, 366, 'L2 Bag claim', 9, 'start')
    m.text(68, 417, 'L2 curb', 9, 'start')
    m.text(240, 417, 'Taxi', 9, 'start')
    m.text(68, 434, 'L1 curb', 9, 'start')
    m.text(146, 434, 'Buses', 9, 'start')
    m.text(182, 434, 'Shuttles', 9, 'start')
    m.text(33, 346, 'Garage', 9, weight=700)
    m.text(33, 362, 'Ride app', 9)
    m.text(33, 373, 'pickup', 9)
    m.text(33, 384, 'Level 2', 9)
    m.legend(16, 198)
    m.route('arrive', [hub, (230, 304), (230, 398)])
    m.route('taxi', [(230, 398), (230, 414)])
    m.route('bus', [(230, 398), (141, 398), (141, 431)])
    m.route('ride', [(230, 398), (33, 398)])
    m.you(*hub)

    m.point('hub', *hub, 'Western Concourse bridge, Level 4 food hall', 'info')
    m.point('exit', 236, 311, 'Exit from the secure area, Level 4 by the food court', 'exit')
    m.point('bag', 181, 375, 'Baggage claim, Level 2, carousels 1-9 (check the AA app for yours)', 'bag')
    m.point('taxi', 235, 414, 'Taxi stand, Level 2 curb', 'taxi')
    m.point('ride', 33, 398, "Rideshare pickup: Terminal B garage, Level 2 ('Ride App Pick Up' signs)", 'ride')
    m.point('bus', 141, 431, "Buses, Level 1 curb ('Buses to Subway', 'Local Buses'): Q70 free to Jackson Heights, "
            'M60-SBS uptown', 'bus')
    m.point('shuttle', 196, 431, 'Hotel, parking, rental-car and Uber shuttles, Level 1 curb', 'bus')
    m.point('checkin', 107, 339, 'American check-in, Level 3 (west end)', 'info')
    m.at_gate('club', 'w4', 30.5, 'Admirals Club near gates 30-31', 'info', inset=-14)
    for pid, x, label in (('starbucks', 130, 'Starbucks, food hall (L4)'),
                          ('wendys', 150, "Wendy's and Dos Toros, food hall (L4)"),
                          ('juniors', 170, "Junior's Restaurant, food hall (L4)"),
                          ('dunkin', 186, "Dunkin', food hall (L4)"),
                          ('hill_country', 208, 'Hill Country Barbecue Market, food hall (L4)')):
        m.food(pid, x, 297, label)
    m.at_gate('hunt_fish', 'w2', 22, 'Hunt & Fish Club near gate 22', 'food', inset=-10)
    m.at_gate('mi_casa', 'w2', 22, 'Mi Casa near gate 22', 'food', inset=-10)
    m.at_gate('melt_shop', 'w2', 23, 'Melt Shop near gate 23', 'food', inset=-10)
    m.at_gate('bar_veloce', 'w3', 24, 'Bar Veloce near gate 24', 'food', inset=-10)
    m.at_gate('beechers', 'w4', 30, "Beecher's near gate 30", 'food', inset=-10)
    m.at_gate('shake_shack', 'e1', 41, 'Shake Shack near gate 41', 'food', inset=-5)
    m.at_gate('la_chula', 'e1', 42, 'La Chula near gate 42', 'food', inset=-5)
    m.at_gate('il_viaggio', 'e2', 47, 'Il Viaggio near gate 47', 'food', inset=-5)
    m.source = f'LaGuardia official map data ({ver}), drawn north up'
    m.notes = [
        'There is no AirTrain (canceled in March 2023). Ground options are taxi, rideshare, buses and shuttles.',
        'American uses the Western Concourse, gates 11-31, a 4-6 min walk from security. The Eastern Concourse '
        '(gates 40-59) is 6-9 min.',
        'Arriving: cross the pedestrian bridge into the Level 4 food hall, leave the secure area at the exit by the food '
        'court, then go down to Level 2 baggage claim (carousels 1-9). The taxi stand is on the Level 2 curb.',
        "Rideshare pickup is on Level 2 of the Terminal B garage ('Ride App Pick Up' signs). The walk is long and the "
        'signal weak, so request the ride as you near the garage.',
        "Buses stop on the Level 1 curb ('Buses to Subway' and 'Local Buses' on the official map). The Q70 LaGuardia Link "
        'is free to Jackson Heights for the E train; the M60-SBS starts here but goes uptown. The exact Q70 stop is not '
        'confirmed, so follow the bus signs.',
        'No gate 13 or 21 in the official data. American check-in is at the west end of Level 3; the Admirals Club is '
        'near gates 30-31.',
    ]
    return m


# ---------------------------------------------------------------- preview

PREVIEW_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Airport maps preview</title>
<style>
/* Preview only: the app styles .m-* itself. Tokens follow app/src/tokens.css. */
body{margin:0;padding:16px;background:#E9E6DF;color:#16191A;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
h2{margin:0 0 8px;font-size:15px}
.row{display:flex;gap:14px;margin-bottom:18px;align-items:flex-start}
.card{width:350px;flex:none;border-radius:14px;overflow:hidden;background:var(--bg)}
.card svg{display:block;width:100%;height:auto}
.notes{width:350px;flex:none;font-size:12px}
.notes ul{margin:0;padding-left:16px}.notes li{margin-bottom:4px}
.light{--bg:#FDFDFD;--floor:#EFE9DA;--area:#E2EAE8;--ink:#16191A;--mu:#4E5654;--gate:#4A706D;--route:#C4686B;--sec:#A4474B;--secbg:#F8E6E6;--food:#B5803F;--you:#C4686B}
.dark{--bg:#1A1E1D;--floor:#2E312C;--area:#22302E;--ink:#EEEBE2;--mu:#B4BCB9;--gate:#9CC0BC;--route:#E3979A;--sec:#E3979A;--secbg:#3A2A2A;--food:#D9A866;--you:#E3979A}
.m-bg{fill:var(--bg)}.m-wall{fill:var(--floor)}.m-area,.m-water{fill:var(--area)}
.m-sec{fill:var(--secbg);stroke:var(--sec);stroke-width:1}
circle.m-gate{fill:var(--gate)}text.m-gate{fill:var(--mu)}.m-label{fill:var(--ink)}
text{paint-order:stroke;stroke:var(--bg);stroke-width:2.2px;stroke-linejoin:round}
.m-food{fill:var(--food)}
.m-route{fill:none;stroke:var(--route);stroke-width:2;stroke-dasharray:4 3;stroke-linecap:round}
.m-you{fill:var(--you);stroke:var(--bg);stroke-width:1.5}
.demo-path{fill:none;stroke:var(--you);stroke-width:2.6;stroke-linejoin:round;stroke-linecap:round}
.demo-dot{fill:var(--you);stroke:var(--bg);stroke-width:1.5}
.demo-ring{fill:none;stroke:var(--you);stroke-width:2;animation:ring 1.6s ease-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes ring{from{opacity:.9;transform:scale(.6)}to{opacity:0;transform:scale(2.2)}}
.dbg circle{fill:none;stroke:#d0f;stroke-width:1}.dbg line{stroke:#d0f;stroke-width:.8}.dbg text{font-size:6px;fill:#d0f;stroke:none}
</style></head><body>
<div id="out"></div>
<!-- #PHX shows one airport; #points (or #PHX,points) overlays the points on the light card. -->
<script>
const MAPS = __DATA__;
// Demo: the gates the app would highlight (PHX departure, CLT B-to-B connection, LGA arrival and carousel).
const DEMO = {PHX: [['gate', 'A22']], CLT: [['gate', 'B14'], ['gate', 'B4']], LGA: [['gate', '24'], ['baggage', '6']]};
const NS = 'http://www.w3.org/2000/svg';

// gatePos: the app's lookup. Prefer the drawn dot; otherwise interpolate on the line.
function locate(map, svg, value, kind) {
  const m = /^([A-Z]?)(\d+)/.exec(String(value).trim().toUpperCase());
  if (!m) return null;
  const n = +m[2];
  const L = Object.values(map.points).find(p => p.kind === 'line' && (p.for || 'gate') === kind &&
    p.prefix === m[1] && n >= p.from && n <= p.to);
  if (!L) return null;
  const t = L.to === L.from ? 0 : (n - L.from) / (L.to - L.from);
  const on = [L.x1 + t * (L.x2 - L.x1), L.y1 + t * (L.y2 - L.y1)];
  const el = svg.querySelector(kind === 'gate' ? `[data-g="${m[1]}${n}"]` : `[data-bag="${n}"]`);
  let at = on;
  if (el && el.tagName === 'circle') at = [+el.getAttribute('cx'), +el.getAttribute('cy')];
  if (el && el.tagName === 'rect') at = [+el.getAttribute('x') + +el.getAttribute('width') / 2, +el.getAttribute('y') + +el.getAttribute('height') / 2];
  return {at, path: [...L.via, on, at]};
}
function add(svg, tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  svg.appendChild(e); return e;
}
function demo(code, map, svg) {
  const found = DEMO[code].map(([k, v]) => locate(map, svg, v, k)).filter(Boolean);
  if (!found.length) return;
  // First stop walks back to the hub, later stops walk out from it.
  let path = found[0].path.slice().reverse();
  for (const f of found.slice(1)) path = path.concat(f.path.slice(1));
  if (found.length === 1) path = found[0].path;
  add(svg, 'polyline', {class: 'demo-path', points: path.map(p => p.join(',')).join(' ')});
  for (const f of found) {
    add(svg, 'circle', {class: 'demo-ring', cx: f.at[0], cy: f.at[1], r: 5});
    add(svg, 'circle', {class: 'demo-dot', cx: f.at[0], cy: f.at[1], r: 3.6});
  }
}
function debug(map, svg) {
  const g = add(svg, 'g', {class: 'dbg'});
  for (const [id, p] of Object.entries(map.points)) {
    if (p.kind === 'line') { add(g, 'line', {x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2}); continue; }
    add(g, 'circle', {cx: p.x, cy: p.y, r: 3});
    add(g, 'text', {x: p.x + 4, y: p.y - 3}).textContent = id;
  }
}
const opts = location.hash.slice(1).split(',');
const only = opts.find(o => MAPS[o]);
const out = document.getElementById('out');
for (const [code, map] of Object.entries(MAPS)) {
  if (only && code !== only) continue;
  const row = document.createElement('div');
  row.innerHTML = `<h2>${code}</h2><div class="row"></div>`;
  const r = row.querySelector('.row');
  for (const theme of ['light', 'dark']) {
    const card = document.createElement('div');
    card.className = 'card ' + theme;
    card.innerHTML = `<svg viewBox="${map.viewBox}" xmlns="${NS}">${map.svg}</svg>`;
    r.appendChild(card);
    const svg = card.querySelector('svg');
    demo(code, map, svg);
    if (theme === 'light' && opts.includes('points')) debug(map, svg);
  }
  const notes = document.createElement('div');
  notes.className = 'notes';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  notes.innerHTML = '<ul>' + map.notes.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>' +
    (map.source ? `<p>Source: ${esc(map.source)}.</p>` : '');
  r.appendChild(notes);
  out.appendChild(row);
}
</script></body></html>
"""


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    save(path, text.encode('utf-8'))


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--refresh', action='store_true', help='download the official map data again')
    ap.add_argument('--no-preview', action='store_true', help='skip guide/maps_preview.html')
    ap.add_argument('--draft', action='store_true', help='write the preview even when checks fail')
    ap.add_argument('--cache', default=CACHE, help='cache directory for the official data')
    ap.add_argument('--out', help='write maps.json and maps_preview.html here instead of guide/ (for tests)')
    args = ap.parse_args()
    out_json = os.path.join(args.out, 'maps.json') if args.out else OUT
    out_preview = os.path.join(args.out, 'maps_preview.html') if args.out else PREVIEW
    os.makedirs(args.cache, exist_ok=True)
    if args.refresh:
        for code in SRC:
            try:
                refresh(code, args.cache)
                print(f'{code}: downloaded the official data')
            except Exception as e:  # noqa: BLE001 - any failure keeps the cached copy
                print(f'WARN {code}: refresh failed, building from the cached data ({e.__class__.__name__}: {e})',
                      file=sys.stderr)

    maps, errors = {}, []
    for code, layout in (('PHX', phx), ('CLT', clt), ('LGA', lga)):
        pois, ver = load(code, args.cache)
        real = real_points(code, pois, 'gate', GATE_RE)
        claims = real_points(code, pois, 'baggage.claim', CLAIM_RE)
        m = layout(ver)
        out, errs, report = m.build(real, claims)
        errors += errs + check_lines(m, real, claims) + lint(m, out)
        maps[code] = out
        print(f'{code}: {len(real)} official gates, data {ver}, {len(out["points"])} points, '
              f'{len(out["svg"]) // 1024} KB svg')
        for line in report:
            print('  ' + line)

    if not args.no_preview and (args.draft or not errors):
        write_atomic(out_preview, PREVIEW_HTML.replace('__DATA__',
                                                       json.dumps(maps, ensure_ascii=False).replace('</', '<\\/')))
        print('wrote', out_preview if args.out else os.path.relpath(PREVIEW, ROOT))
    if errors:
        for e in errors:
            print('FAIL', e, file=sys.stderr)
        sys.exit(1)
    write_atomic(out_json, json.dumps(maps, ensure_ascii=False, indent=1) + '\n')
    print('wrote', out_json if args.out else os.path.relpath(OUT, ROOT), '- all checks passed')


if __name__ == '__main__':
    main()
