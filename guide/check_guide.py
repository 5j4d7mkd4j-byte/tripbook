#!/usr/bin/env python3
"""Validate guide/guide.json against the "Guide bundle" schema in app/CONTRACT.md.

Usage:
  python3 guide/check_guide.py [path/to/guide.json] [--links] [--allow-map]

  --links      also HEAD-check every https URL with curl (slow; many sites
               block bots, so failures are warnings, not errors)
  --allow-map  accept airports.*.map (use on a merged bundle; the source
               guide.json should leave maps to guide/maps.json)

Exit 0 when there are no errors; 1 otherwise. Stdlib only.
This file is committed, so it holds no trip data: the airports and aircraft
it requires are read from trip/flights.json when that file exists.
"""
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICON_DIR = os.path.join(ROOT, 'app', 'src', 'icons')
FLIGHTS = os.path.join(ROOT, 'trip', 'flights.json')

MODES = {'rideshare', 'taxi', 'bus', 'subway', 'car', 'train'}
TRAFFIC_KEYS = {'to_hotel', 'to_lga'}
# Seat letters per cabin, e.g. 'AB-CD', 'ABC-DEF', 'AC-DF', 'ABC-DEFG-HJK'.
LETTERS_RE = re.compile(r'^[A-K]{1,4}(-[A-K]{1,4}){1,2}$')
SEAT_RE = re.compile(r'^(\d{1,2})([A-K])$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
# Copy rule: the app never claims its data is real-time.
LIVE_RE = re.compile(r'\blive\b', re.I)

# Known keys per object kind; anything else is reported as a contract extension.
KNOWN = {
    'top': {'schema', 'updated', 'plan', 'airports', 'aircraft', 'transit', 'sources'},
    'plans': {'out', 'ret'},
    'plan': {'drive_min', 'arrive_before_min', 'note'},
    'airport': {'code', 'name', 'short', 'city', 'tz', 'summary', 'terminals', 'steps', 'map',
                'security', 'food', 'services', 'facts', 'tips', 'caveats', 'links', 'ground'},
    'terminal': {'id', 'name', 'airlines', 'concourses', 'gates', 'note'},
    'phases': {'depart', 'connect', 'arrive'},
    'step': {'title', 'detail', 'min', 'icon', 'rel'},
    'security': {'name', 'where', 'hours', 'precheck', 'clear', 'note'},
    'food': {'name', 'where', 'near', 'hours', 'kind', 'note'},
    'service': {'icon', 'label', 'where'},
    'fact': {'label', 'value', 'detail'},
    'link': {'label', 'url', 'what'},
    'ground': {'id', 'mode', 'name', 'where', 'min', 'cost', 'steps', 'good', 'bad'},
    'aircraft': {'name', 'config', 'rows', 'seats_per_row', 'map_url', 'power', 'wifi',
                 'notes', 'good', 'avoid', 'layout'},
    'cabin': {'name', 'from', 'to', 'letters', 'exits', 'missing'},
    'transit': {'to_hotel', 'to_lga', 'tips'},
    'route': {'id', 'mode', 'name', 'summary', 'min', 'cost', 'best_when', 'avoid_when',
              'steps', 'book', 'traffic_key'},
    'rstep': {'icon', 'text', 'min', 'where'},
    'source': {'label', 'url'},
}


class Checker:
    def __init__(self, allow_map):
        self.allow_map = allow_map
        self.errors, self.warnings, self.extensions = [], [], set()
        self.icons = self._load_icons()
        self.urls = set()
        # The app links routes as #route/<id>, so ids must be unique across
        # transit.to_hotel, transit.to_lga and every airport's ground list.
        self.route_ids = set()

    # -- reporting
    def err(self, path, msg):
        self.errors.append(f'{path}: {msg}')

    def warn(self, path, msg):
        self.warnings.append(f'{path}: {msg}')

    @staticmethod
    def _load_icons():
        try:
            return {f[:-4] for f in os.listdir(ICON_DIR) if f.endswith('.svg')}
        except OSError:
            return None  # icon check skipped when the app tree is absent

    # -- primitive checks
    def obj(self, path, v, kind, required=()):
        """Dict with the required keys; unknown keys are noted, not failed."""
        if not isinstance(v, dict):
            self.err(path, f'expected object, got {type(v).__name__}')
            return False
        for k in required:
            if k not in v:
                self.err(path, f'missing "{k}"')
        for k in v:
            if k not in KNOWN[kind]:
                self.extensions.add(f'{kind}.{k}')
        return True

    def arr(self, path, v, allow_none=False):
        if v is None and allow_none:
            return []
        if not isinstance(v, list):
            self.err(path, f'expected array, got {type(v).__name__}')
            return []
        return v

    def text(self, path, v, allow_none=True, allow_empty=True):
        if v is None:
            if not allow_none:
                self.err(path, 'is null')
            return
        if not isinstance(v, str):
            self.err(path, f'expected string, got {type(v).__name__}')
            return
        if not allow_empty and not v.strip():
            self.err(path, 'is empty')
        if LIVE_RE.search(v):
            self.err(path, 'uses the word "live"')

    def strs(self, path, v):
        for i, s in enumerate(self.arr(path, v, allow_none=True)):
            self.text(f'{path}[{i}]', s, allow_none=False, allow_empty=False)

    def num(self, path, v, lo=None, hi=None, allow_none=True):
        if v is None:
            if not allow_none:
                self.err(path, 'is null')
            return
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            self.err(path, f'expected number, got {type(v).__name__}')
            return
        if (lo is not None and v < lo) or (hi is not None and v > hi):
            self.err(path, f'{v} outside {lo}..{hi}')

    def int_(self, path, v, lo=None, hi=None, allow_none=True):
        if v is not None and (isinstance(v, bool) or not isinstance(v, int)):
            self.err(path, f'expected integer, got {type(v).__name__}')
            return
        self.num(path, v, lo, hi, allow_none)

    def range_(self, path, v):
        """[lo, hi] whole minutes, lo <= hi."""
        if v is None:
            return
        if (not isinstance(v, list) or len(v) != 2
                or not all(isinstance(x, int) and not isinstance(x, bool) for x in v)):
            self.err(path, f'expected [lo, hi] integers, got {v!r}')
        elif not 0 <= v[0] <= v[1]:
            self.err(path, f'bad range {v}')

    def url(self, path, v, allow_none=True):
        if v is None and allow_none:
            return
        if not isinstance(v, str) or not v.startswith('https://'):
            self.err(path, f'expected https URL, got {v!r}')
            return
        if any(c.isspace() for c in v):
            self.err(path, 'URL contains whitespace')
        self.urls.add(v)

    def icon(self, path, v, allow_none=True):
        if v is None and allow_none:
            return
        if not isinstance(v, str):
            self.err(path, f'expected icon name, got {v!r}')
        elif self.icons is not None and v not in self.icons:
            self.err(path, f'icon "{v}" not in app/src/icons')

    # -- sections
    def check(self, g):
        if not self.obj('$', g, 'top', ('schema', 'updated', 'plan', 'airports', 'aircraft',
                                         'transit', 'sources')):
            return
        if g.get('schema') != 1:
            self.err('schema', f'expected 1, got {g.get("schema")!r}')
        if not isinstance(g.get('updated'), str) or not DATE_RE.match(g['updated'][:10]):
            self.err('updated', f'expected YYYY-MM-DD, got {g.get("updated")!r}')
        self.plan(g.get('plan'))
        airports = g.get('airports')
        if isinstance(airports, dict):
            for code, a in airports.items():
                self.airport(f'airports.{code}', code, a)
        else:
            self.err('airports', 'expected object')
        aircraft = g.get('aircraft')
        if isinstance(aircraft, dict):
            for code, a in aircraft.items():
                self.aircraft(f'aircraft.{code}', a)
        else:
            self.err('aircraft', 'expected object')
        self.transit(g.get('transit'))
        for i, s in enumerate(self.arr('sources', g.get('sources'))):
            p = f'sources[{i}]'
            if self.obj(p, s, 'source', ('label', 'url')):
                self.text(f'{p}.label', s.get('label'), allow_none=False, allow_empty=False)
                self.url(f'{p}.url', s.get('url'), allow_none=False)

    def plan(self, plan):
        if not self.obj('plan', plan, 'plans', ('out', 'ret')):
            return
        for d in ('out', 'ret'):
            p = f'plan.{d}'
            v = plan.get(d)
            if v is None:
                continue  # already reported as missing
            if self.obj(p, v, 'plan', ('drive_min', 'arrive_before_min')):
                self.int_(f'{p}.drive_min', v.get('drive_min'), 1, 240, allow_none=False)
                # AA closes bag drop 45 min out, so anything shorter is a mistake.
                self.int_(f'{p}.arrive_before_min', v.get('arrive_before_min'), 45, 300,
                          allow_none=False)
                self.text(f'{p}.note', v.get('note'))

    def steps(self, path, steps):
        last = {}  # rel.min must not go backwards per anchor within one list
        for i, s in enumerate(self.arr(path, steps, allow_none=True)):
            p = f'{path}[{i}]'
            if not self.obj(p, s, 'step', ('title',)):
                continue
            self.text(f'{p}.title', s.get('title'), allow_none=False, allow_empty=False)
            self.text(f'{p}.detail', s.get('detail'))
            self.num(f'{p}.min', s.get('min'), 0, 600)
            self.icon(f'{p}.icon', s.get('icon'))
            rel = s.get('rel')
            if rel is None:
                continue
            if not isinstance(rel, dict) or rel.get('to') not in ('dep', 'arr'):
                self.err(f'{p}.rel', f'expected {{to: dep|arr, min}}, got {rel!r}')
                continue
            self.int_(f'{p}.rel.min', rel.get('min'), -720, 720, allow_none=False)
            m = rel.get('min')
            if isinstance(m, int):
                if m < last.get(rel['to'], -10**6):
                    self.warn(f'{p}.rel', f'{rel["to"]}{m:+d} comes after a later step')
                last[rel['to']] = m

    def airport(self, path, code, a):
        req = ('code', 'name', 'city', 'tz', 'summary', 'terminals', 'steps', 'security',
               'food', 'services', 'facts', 'tips', 'caveats', 'links')
        if not self.obj(path, a, 'airport', req):
            return
        if a.get('code') != code:
            self.err(f'{path}.code', f'{a.get("code")!r} does not match key {code!r}')
        if 'map' in a and not self.allow_map:
            self.err(f'{path}.map', 'present; maps come from guide/maps.json at build')
        for k in ('name', 'short', 'city', 'summary'):
            self.text(f'{path}.{k}', a.get(k), allow_none=(k == 'short'))
        self.tz(f'{path}.tz', a.get('tz'))

        for i, t in enumerate(self.arr(f'{path}.terminals', a.get('terminals'))):
            p = f'{path}.terminals[{i}]'
            if self.obj(p, t, 'terminal', ('id', 'name')):
                self.text(f'{p}.id', t.get('id'), allow_none=False)
                self.text(f'{p}.name', t.get('name'), allow_none=False)
                self.text(f'{p}.note', t.get('note'))
                for k in ('airlines', 'concourses', 'gates'):
                    v = t.get(k)
                    if isinstance(v, str):
                        self.text(f'{p}.{k}', v)
                    elif v is not None:
                        self.strs(f'{p}.{k}', v)

        st = a.get('steps')
        if self.obj(f'{path}.steps', st, 'phases'):
            for k, v in st.items():
                self.steps(f'{path}.steps.{k}', v)
            if not st:
                self.warn(f'{path}.steps', 'no depart/connect/arrive steps')

        for i, s in enumerate(self.arr(f'{path}.security', a.get('security'))):
            p = f'{path}.security[{i}]'
            if self.obj(p, s, 'security', ('name',)):
                for k in KNOWN['security']:
                    self.text(f'{p}.{k}', s.get(k), allow_none=(k != 'name'))
        for i, f in enumerate(self.arr(f'{path}.food', a.get('food'))):
            p = f'{path}.food[{i}]'
            if self.obj(p, f, 'food', ('name',)):
                for k in KNOWN['food']:
                    self.text(f'{p}.{k}', f.get(k), allow_none=(k != 'name'))
        for i, s in enumerate(self.arr(f'{path}.services', a.get('services'))):
            p = f'{path}.services[{i}]'
            if self.obj(p, s, 'service', ('icon', 'label')):
                self.icon(f'{p}.icon', s.get('icon'), allow_none=False)
                self.text(f'{p}.label', s.get('label'), allow_none=False, allow_empty=False)
                self.text(f'{p}.where', s.get('where'))
        for i, f in enumerate(self.arr(f'{path}.facts', a.get('facts'))):
            p = f'{path}.facts[{i}]'
            if self.obj(p, f, 'fact', ('label', 'value')):
                for k in KNOWN['fact']:
                    self.text(f'{p}.{k}', f.get(k), allow_none=(k == 'detail'))
        self.strs(f'{path}.tips', a.get('tips'))
        self.strs(f'{path}.caveats', a.get('caveats'))
        for i, l in enumerate(self.arr(f'{path}.links', a.get('links'))):
            p = f'{path}.links[{i}]'
            if self.obj(p, l, 'link', ('label', 'url')):
                self.text(f'{p}.label', l.get('label'), allow_none=False, allow_empty=False)
                self.text(f'{p}.what', l.get('what'))
                self.url(f'{p}.url', l.get('url'), allow_none=False)

        for i, r in enumerate(self.arr(f'{path}.ground', a.get('ground'), allow_none=True)):
            p = f'{path}.ground[{i}]'
            if not self.obj(p, r, 'ground', ('id', 'mode', 'name')):
                continue
            self.unique(p, r.get('id'), self.route_ids)
            self.mode(f'{p}.mode', r.get('mode'))
            self.range_(f'{p}.min', r.get('min'))
            for k in ('name', 'where', 'cost', 'good', 'bad'):
                self.text(f'{p}.{k}', r.get(k), allow_none=(k != 'name'))
            self.strs(f'{p}.steps', r.get('steps'))

    def tz(self, path, v):
        if not isinstance(v, str) or '/' not in v:
            self.err(path, f'expected IANA zone, got {v!r}')
            return
        try:
            from zoneinfo import ZoneInfo  # Python 3.9+
            ZoneInfo(v)
        except ImportError:
            pass
        except Exception:
            self.err(path, f'unknown time zone {v!r}')

    def mode(self, path, v):
        if v not in MODES:
            self.err(path, f'{v!r} not one of {sorted(MODES)}')

    def unique(self, path, v, seen):
        if not isinstance(v, str) or not v:
            self.err(f'{path}.id', 'missing or not a string')
        elif v in seen:
            self.err(f'{path}.id', f'duplicate id {v!r}')
        else:
            seen.add(v)

    def aircraft(self, path, a):
        req = ('name', 'rows', 'seats_per_row', 'map_url', 'layout')
        if not self.obj(path, a, 'aircraft', req):
            return
        for k in ('name', 'config', 'power', 'wifi'):
            self.text(f'{path}.{k}', a.get(k), allow_none=(k != 'name'))
        self.int_(f'{path}.rows', a.get('rows'), 1, 99)
        self.int_(f'{path}.seats_per_row', a.get('seats_per_row'), 1, 12)
        self.url(f'{path}.map_url', a.get('map_url'))
        for k in ('notes', 'good', 'avoid'):
            self.strs(f'{path}.{k}', a.get(k))
        lay = a.get('layout')
        if not isinstance(lay, dict):
            self.err(f'{path}.layout', 'expected object with cabins')
            return
        prev_to, widest = 0, 0
        for i, c in enumerate(self.arr(f'{path}.layout.cabins', lay.get('cabins'))):
            p = f'{path}.layout.cabins[{i}]'
            if not self.obj(p, c, 'cabin', ('name', 'from', 'to', 'letters')):
                continue
            self.text(f'{p}.name', c.get('name'), allow_none=False)
            lo, hi, letters = c.get('from'), c.get('to'), c.get('letters')
            if not (isinstance(lo, int) and isinstance(hi, int) and 1 <= lo <= hi):
                self.err(p, f'bad row range from={lo!r} to={hi!r}')
                continue
            if lo <= prev_to:
                self.err(p, f'rows {lo}..{hi} overlap the previous cabin')
            prev_to = hi
            if not isinstance(letters, str) or not LETTERS_RE.match(letters):
                self.err(f'{p}.letters', f'expected e.g. "ABC-DEF", got {letters!r}')
                letters = ''
            seat_letters = letters.replace('-', '')
            if len(seat_letters) != len(set(seat_letters)) or list(seat_letters) != sorted(seat_letters):
                self.err(f'{p}.letters', f'{letters!r} repeats or is out of order')
            widest = max(widest, len(seat_letters))
            for k in ('exits', 'missing'):
                for j, r in enumerate(self.arr(f'{p}.{k}', c.get(k), allow_none=True)):
                    if not isinstance(r, int) or not lo <= r <= hi:
                        self.err(f'{p}.{k}[{j}]', f'row {r!r} outside {lo}..{hi}')
            # Extension: single missing seats such as "10F" (lavatory, galley).
            for j, s in enumerate(self.arr(f'{p}.missing_seats', c.get('missing_seats'),
                                           allow_none=True)):
                m = SEAT_RE.match(s) if isinstance(s, str) else None
                if not m or not lo <= int(m.group(1)) <= hi or m.group(2) not in seat_letters:
                    self.err(f'{p}.missing_seats[{j}]', f'{s!r} not a seat in this cabin')
            self.text(f'{p}.note', c.get('note'))
        if isinstance(a.get('rows'), int) and prev_to and a['rows'] != prev_to:
            self.warn(f'{path}.rows', f'{a["rows"]} != last cabin row {prev_to}')
        if isinstance(a.get('seats_per_row'), int) and widest and a['seats_per_row'] != widest:
            self.warn(f'{path}.seats_per_row', f'{a["seats_per_row"]} != widest cabin {widest}')

    def transit(self, t):
        if not self.obj('transit', t, 'transit', ('to_hotel', 'to_lga')):
            return
        for key in ('to_hotel', 'to_lga'):
            for i, r in enumerate(self.arr(f'transit.{key}', t.get(key))):
                self.route(f'transit.{key}[{i}]', r, self.route_ids)
        self.strs('transit.tips', t.get('tips'))

    def route(self, path, r, ids):
        req = ('id', 'mode', 'name', 'summary', 'min', 'cost', 'steps')
        if not self.obj(path, r, 'route', req):
            return
        self.unique(path, r.get('id'), ids)
        self.mode(f'{path}.mode', r.get('mode'))
        self.range_(f'{path}.min', r.get('min'))
        for k in ('name', 'summary', 'cost', 'best_when', 'avoid_when'):
            self.text(f'{path}.{k}', r.get(k), allow_none=(k not in ('name', 'summary')))
        for i, s in enumerate(self.arr(f'{path}.steps', r.get('steps'))):
            p = f'{path}.steps[{i}]'
            if self.obj(p, s, 'rstep', ('icon', 'text')):
                self.icon(f'{p}.icon', s.get('icon'), allow_none=False)
                self.text(f'{p}.text', s.get('text'), allow_none=False, allow_empty=False)
                self.num(f'{p}.min', s.get('min'), 0, 600)
                self.text(f'{p}.where', s.get('where'))
        book = r.get('book')
        if book is not None and self.obj(f'{path}.book', book, 'source', ('label', 'url')):
            self.text(f'{path}.book.label', book.get('label'), allow_none=False)
            self.url(f'{path}.book.url', book.get('url'), allow_none=False)
        tk = r.get('traffic_key')
        if tk is not None and tk not in TRAFFIC_KEYS:
            self.err(f'{path}.traffic_key', f'{tk!r} not one of {sorted(TRAFFIC_KEYS)}')

    def against_trip(self, g):
        """Cross-check with trip/flights.json (gitignored) when it is present."""
        try:
            with open(FLIGHTS, encoding='utf-8') as f:
                trip = json.load(f)
        except (OSError, ValueError):
            self.warn('trip', 'trip/flights.json not readable; coverage not checked')
            return
        airports = g.get('airports') if isinstance(g.get('airports'), dict) else {}
        aircraft = g.get('aircraft') if isinstance(g.get('aircraft'), dict) else {}
        legs = trip.get('legs') if isinstance(trip, dict) else None
        if not isinstance(legs, list):
            self.warn('trip', 'trip/flights.json has no legs list; coverage not checked')
            return
        for leg in legs:
            if not isinstance(leg, dict):
                continue
            lid = leg.get('id', '?')
            for end in ('from', 'to'):
                code = leg.get(end)
                if code and code not in airports:
                    self.err('airports', f'no entry for {code} ({lid}.{end})')
            ac = leg.get('aircraft_code')
            if ac and ac not in aircraft:
                (self.err if leg.get('confirmed') else self.warn)(
                    'aircraft', f'no entry for {ac} ({lid})')
            elif ac and leg.get('seatmap') and isinstance(aircraft[ac], dict) \
                    and aircraft[ac].get('map_url') != leg['seatmap']:
                self.warn(f'aircraft.{ac}.map_url', f'differs from {lid}.seatmap')


def check_links(urls):
    """HEAD each URL via curl (urllib can hit SSL issues on macOS); GET on 405."""
    def one(u):
        code = '000'
        for extra in ([], ['-X', 'GET', '-r', '0-0']):
            try:
                out = subprocess.run(
                    ['curl', '-sS', '-I', '-L', '--max-time', '20', '-A', 'Mozilla/5.0',
                     '-o', '/dev/null', '-w', '%{http_code}', *extra, u],
                    capture_output=True, text=True, timeout=30)
                code = out.stdout.strip() or '000'
            except (OSError, subprocess.TimeoutExpired):
                code = '000'
            if code not in ('405', '403', '000'):
                break
        return u, code
    with ThreadPoolExecutor(max_workers=8) as ex:
        return sorted(ex.map(one, sorted(urls)))


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    flags = {a for a in argv if a.startswith('--')}
    unknown = flags - {'--links', '--allow-map'}
    if unknown:
        print(f'unknown option(s): {", ".join(sorted(unknown))}', file=sys.stderr)
        return 2
    path = args[0] if args else os.path.join(HERE, 'guide.json')
    try:
        with open(path, encoding='utf-8') as f:
            g = json.load(f)
    except OSError as e:
        print(f'FAIL: cannot read {path}: {e}')
        return 1
    except ValueError as e:
        print(f'FAIL: {path} is not valid JSON: {e}')
        return 1

    c = Checker(allow_map='--allow-map' in flags)
    c.check(g)
    if isinstance(g, dict):
        c.against_trip(g)
    if c.icons is None:
        c.warn('icons', 'app/src/icons not found; icon names not checked')

    if '--links' in flags:
        for u, code in check_links(c.urls):
            if not code.startswith(('2', '3')):
                c.warn('link', f'{code} {u}')

    for w in c.warnings:
        print('warn ', w)
    for e in c.errors:
        print('ERROR', e)
    if c.extensions:
        print('note  fields beyond CONTRACT.md:', ', '.join(sorted(c.extensions)))
    n = lambda k: len(g.get(k) or {}) if isinstance(g, dict) else 0
    routes = sum(len((g.get('transit') or {}).get(k) or []) for k in ('to_hotel', 'to_lga')) \
        if isinstance(g, dict) and isinstance(g.get('transit'), dict) else 0
    status = 'FAIL' if c.errors else 'OK'
    shown = os.path.relpath(path)
    shown = path if shown.startswith('..') else shown
    print(f'{status}: {shown} | {n("airports")} airports, {n("aircraft")} aircraft, '
          f'{routes} routes, {len(c.urls)} urls | {len(c.errors)} errors, {len(c.warnings)} warnings')
    return 1 if c.errors else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
