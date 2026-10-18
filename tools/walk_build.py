#!/usr/bin/env python3
"""PLACEHOLDER: being written."""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'research', 'routing')
SODA = 'https://data.cityofnewyork.us/resource/'
OVERPASS = 'https://overpass-api.de/api/interpreter'
UA = 'nyc-trip-walkgraph/1 (offline pedestrian graph; one query per park)'


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
