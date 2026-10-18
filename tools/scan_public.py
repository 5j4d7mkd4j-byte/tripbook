#!/usr/bin/env python3
"""Refuse to commit anything that names the real trip in plain text.

The repo is public (GitHub Pages), so flight numbers, travel dates and the
hotel only ever reach it inside the sealed .bin files (extra private terms,
like the Yelp collection id, go in .secrets/scan_terms.txt). The terms to look for
come from the private trip/flights.json, so this file names nothing itself.
Run by the git pre-commit hook over staged files; exits 1 and names the file
and line (never the matched text) when something slips through.

  python3 tools/scan_public.py FILE...
"""
import json, os, re, sys
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def terms():
    try:
        trip = json.load(open(os.path.join(ROOT, 'trip', 'flights.json')))
    except Exception:
        print('scan_public: trip/flights.json not found; nothing to check against', file=sys.stderr)
        return []
    out, days = [], set()
    for leg in trip.get('legs') or []:
        num = re.sub(r'\D', '', str(leg.get('flight') or ''))
        if num:
            out.append(rf'(?<![\d.]){num}(?!\d)')
        try:
            d = date.fromisoformat(str(leg.get('date'))[:10])
        except ValueError:
            continue
        days.update(d + timedelta(days=k) for k in (-1, 0, 1))
    for d in days:
        mon = MONTHS[d.month - 1]
        out += [d.isoformat(), rf'\b{d.month}/{d.day}\b', rf'\b{mon}[a-z]*\.?\s+{d.day}\b', rf'\b{d.day}\s+{mon}\b']
    # Anything else private (e.g. the Yelp collection id), one term per line.
    try:
        out += [re.escape(x.strip()) for x in open(os.path.join(ROOT, '.secrets', 'scan_terms.txt')) if len(x.strip()) > 3]
    except OSError:
        pass
    h = trip.get('hotel') or {}
    out += [re.escape(v) for v in (h.get('name'), h.get('address')) if isinstance(v, str) and len(v) > 5]
    return out


def main(files):
    t = terms()
    if not t:
        return 0
    rx = re.compile('|'.join(t), re.I)
    bad = 0
    for f in files:
        if f.endswith('.bin') or not os.path.isfile(f):
            continue
        try:
            text = open(f, encoding='utf-8').read()
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                print(f'scan_public: {f}:{n} names the trip in plain text', file=sys.stderr)
                bad += 1
                break
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
