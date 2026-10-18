#!/usr/bin/env python3
"""Airport, road and transit conditions for the status bundle.

run.py calls build(prev, legs, now); this file also runs on its own for testing:
  python3 updater/conditions.py [--legs trip/flights.json] [--prev status.json]
      [--now ISO] [--only faa,wx,traffic,transit] [--traffic-max-age MIN] [--out FILE]

build() returns the "conditions" keys of the status bundle (app/CONTRACT.md):
  airports: {PHX|CLT|LGA: {faa, wx, tsa}, NYC: {name, wx}}
  traffic:  {to_hotel, to_lga, updated}
  transit:  {alerts, updated}
  notes:    [str]  -- not a bundle key; the caller moves these into run.notes.
Any other airport a leg names (a rebooking or diversion) is added too: FAA status
always, weather only for the American hubs in PLACES; elsewhere wx is {}.
All times out are ISO UTC; local times appear only inside display text.

Each source is independent. When one fails, its previous values are kept (prev
may be the whole last status bundle or a previous build() result) and a note
says why; an odd item inside a reply is skipped, not the whole source. Every
request has its own timeout and the whole build stops waiting after BUDGET_S,
so a slow source cannot hold up the run.

Sources (no keys; the system curl is used because urllib's SSL store fails on
this Mac):
  FAA     nasstatus.faa.gov airport status XML: delays, ground stops, closures.
  NWS     api.weather.gov: hourly forecast, latest observation, active alerts.
  NYC DOT Socrata i4gi-tjb9 link speeds, turned into drive minutes (see
          TRAFFIC MODEL below).
  MTA     camsys all-alerts GTFS-realtime JSON, filtered to the trip's routes.
  TSA     none. The free sources need keys, are retired or block scripts, so
          tsa is always {} rather than an invented number.
Only the standard library and the system curl are used.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from functools import partial
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

UA = "nyc-trip-app (personal)"
# Base URLs can be overridden to exercise the failure paths in tests.
FAA_URL = os.environ.get("FAA_URL", "https://nasstatus.faa.gov/api/airport-status-information")
NWS_BASE = os.environ.get("NWS_BASE", "https://api.weather.gov")
DOT_URL = os.environ.get("DOT_URL", "https://data.cityofnewyork.us/resource/i4gi-tjb9.json")
MTA_URL = os.environ.get(
    "MTA_URL", "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts.json")
NWS_HEADERS = {"Accept": "application/geo+json"}

BUDGET_S = 50          # whole build; leaves run.py room inside a 60 s run
REQ_TIMEOUT_S = 15     # one request
NY = ZoneInfo("America/New_York")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LEGS = os.path.join(HERE, "..", "trip", "flights.json")

CORE = ("PHX", "CLT", "LGA")
# NWS forecast grid and observing station per place, resolved from /points on
# 2026-10-18. If a grid stops answering, /points is asked again at run time.
PLACES = {
    "PHX": {"lat": 33.4342, "lon": -112.0116, "grid": "PSR/161,57", "tz": "America/Phoenix", "station": "KPHX"},
    "CLT": {"lat": 35.2140, "lon": -80.9431, "grid": "GSP/115,64", "tz": "America/New_York", "station": "KCLT"},
    "LGA": {"lat": 40.7769, "lon": -73.8740, "grid": "OKX/37,46", "tz": "America/New_York", "station": "KLGA"},
    # Hotel unknown, so the city entry is generic Midtown (Central Park station).
    "NYC": {"lat": 40.7549, "lon": -73.9840, "grid": "OKX/34,44", "tz": "America/New_York", "station": "KNYC",
            "name": "Midtown Manhattan"},
    # American hubs a rebooked leg could use; only fetched when a leg names one.
    "DFW": {"lat": 32.8998, "lon": -97.0403, "grid": "FWD/80,109", "tz": "America/Chicago", "station": "KDFW"},
    "ORD": {"lat": 41.9786, "lon": -87.9048, "grid": "LOT/66,77", "tz": "America/Chicago", "station": "KORD"},
    "MIA": {"lat": 25.7959, "lon": -80.2870, "grid": "MFL/106,51", "tz": "America/New_York", "station": "KMIA"},
    "PHL": {"lat": 39.8719, "lon": -75.2411, "grid": "PHI/48,75", "tz": "America/New_York", "station": "KPHL"},
    "DCA": {"lat": 38.8512, "lon": -77.0402, "grid": "LWX/97,69", "tz": "America/New_York", "station": "KDCA"},
    "JFK": {"lat": 40.6413, "lon": -73.7781, "grid": "OKX/42,40", "tz": "America/New_York", "station": "KJFK"},
}


# ---------- small helpers ----------

def iso_utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_iso(s):
    """ISO string with Z or an offset -> aware datetime; naive is taken as UTC."""
    if not s or not isinstance(s, str):
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def as_now(now):
    if now is None:
        return datetime.now(timezone.utc)
    if isinstance(now, str):
        dt = parse_iso(now)
        if not dt:
            raise ValueError(f"bad time: {now}")
        return dt
    return now if now.tzinfo else now.replace(tzinfo=timezone.utc)


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


# Upstream JSON is untrusted in shape: these keep one odd value from sinking a source.
def dig(d, *keys):
    """d[k1][k2]... or None when a step is missing or not an object."""
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def arr(v):
    return v if isinstance(v, list) else []


def num(v):
    """A real number (not a bool), else None."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def text_of(v):
    return v.strip() if isinstance(v, str) else ""


def kept(prev):
    """Note suffix for a failed source: what the output fell back to."""
    return "kept previous" if prev else "nothing to keep yet"


def hhmm(dt, tz=NY):
    """'4:12p' style local time, for notes."""
    t = dt.astimezone(tz)
    return f"{t.hour % 12 or 12}:{t.minute:02d}{'a' if t.hour < 12 else 'p'}"


def local_when(dt, tz, now):
    """'2:00p' if that is today in tz, else '2:00p Fri 3 Jan' (the app's date style),
    with the year added when it is not this one."""
    t, today = dt.astimezone(tz), now.astimezone(tz)
    if t.date() == today.date():
        return hhmm(dt, tz)
    return f"{hhmm(dt, tz)} {t:%a} {t.day} {t:%b}" + (f" {t.year}" if t.year != today.year else "")


class Clock:
    """Shared deadline so no request starts without time to finish."""

    def __init__(self, budget):
        self.end = time.monotonic() + budget

    def left(self):
        return self.end - time.monotonic()


# curl exit codes -> short words for run notes (curl's own stderr is long and gets cut mid-word).
CURL_ERRORS = {6: "DNS lookup failed", 7: "could not connect", 28: "timed out", 35: "TLS error",
               52: "empty reply", 56: "connection reset", 60: "TLS certificate error"}


def fetch(url, clock, headers=None, timeout=REQ_TIMEOUT_S):
    """GET with curl. Returns (text, None) or (None, short error)."""
    t = min(timeout, clock.left() - 1)
    if t < 2:
        return None, "out of time"
    # No --compressed: the MTA endpoint's gzip replies break curl's decoder (exit 23).
    cmd = ["curl", "-sS", "-L", "--connect-timeout", "8", "-m", str(int(t)),
           "-A", UA, "-w", "\n%{http_code}"]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=t + 5)
    except subprocess.TimeoutExpired:
        return None, "timed out"
    except OSError as e:
        return None, f"curl failed: {e}"
    if p.returncode:  # DNS, connect, TLS or timeout errors
        return None, CURL_ERRORS.get(p.returncode, f"curl error {p.returncode}")
    body, _, code = p.stdout.rpartition("\n")
    if code != "200":
        return None, f"HTTP {code}"
    return body, None


def get_json(url, clock, headers=None, timeout=REQ_TIMEOUT_S):
    body, err = fetch(url, clock, headers, timeout)
    if err:
        return None, err
    try:
        return json.loads(body), None
    except ValueError:
        return None, "bad JSON"


def run_all(jobs, clock):
    """Run {key: fn() -> (value, err)} in parallel; unfinished jobs report 'out of time'."""
    if not jobs:
        return {}
    ex = ThreadPoolExecutor(max_workers=min(16, len(jobs)))
    futs = {ex.submit(fn): key for key, fn in jobs.items()}
    done, _ = wait(futs, timeout=max(0.0, clock.left()))
    out = {}
    for f, key in futs.items():
        if f not in done:
            out[key] = (None, "out of time")
            continue
        try:
            out[key] = f.result()
        except Exception as e:  # a bug in one job never stops the rest
            out[key] = (None, f"{type(e).__name__}: {e}")
    ex.shutdown(wait=False, cancel_futures=True)
    return out


# ---------- legs ----------

def norm_legs(legs):
    """Accept a list, {"legs": [...]}, or a status bundle's {legId: leg} map."""
    if isinstance(legs, dict):
        legs = legs.get("legs", legs)
    if isinstance(legs, dict):
        legs = [dict(v, id=v.get("id") or k) for k, v in legs.items() if isinstance(v, dict)]
    return [l for l in (legs or []) if isinstance(l, dict)]


def leg_time(leg, end):
    """Best known UTC time for a leg's 'dep' or 'arr': estimate, then schedule."""
    v = leg.get(end)
    if isinstance(v, dict):
        v = v.get("actual") or v.get("est") or v.get("sched")
    return parse_iso(v)


def airport_codes(legs):
    """CORE plus every airport a leg names (a rebooking or diversion). All get FAA
    status; weather only for those in PLACES (the others have no grid to ask)."""
    codes = list(CORE)
    for leg in legs:
        for k in ("from", "to", "diverted_to"):
            c = leg.get(k)
            c = c.strip().upper() if isinstance(c, str) else ""
            if re.fullmatch(r"[A-Z]{3}", c) and c != "NYC" and c not in codes:
                codes.append(c)
    return codes


def tz_of(code):
    z = (PLACES.get(code) or {}).get("tz")
    return ZoneInfo(z) if z else None


# ---------- FAA ----------

def faa_minutes(s):
    """'1 hour and 10 minutes' -> 70; None when there is no number."""
    if not s:
        return None
    h = re.search(r"(\d+)\s*hour", s)
    m = re.search(r"(\d+)\s*min", s)
    if not h and not m:
        return None
    return (int(h.group(1)) * 60 if h else 0) + (int(m.group(1)) if m else 0)


def fmt_min(n):
    if n is None:
        return "?"
    return f"{n} min" if n < 60 else f"{n // 60} hr" + (f" {n % 60} min" if n % 60 else "")


REASON_CODES = {"WX": "weather", "RWY": "runway", "VOL": "high traffic volume", "EQ": "equipment",
                "STAFF": "staffing", "TM": "traffic management", "OTHER": "other"}


def soften(s):
    """Lower-case words but keep short all-caps ones (ILS, OTS, 4R, MIT) as written."""
    return re.sub(r"[A-Za-z0-9]+", lambda m: m.group(0) if m.group(0).isupper() and len(m.group(0)) <= 4
                  else m.group(0).lower(), s)


def faa_reason(raw):
    """'ZBW / RWY:Construction' -> 'Runway: construction'; 'EQ:RWY 4R ILS OTS' -> 'Equipment: RWY 4R ILS OTS';
    'weather / thunderstorms' -> 'Weather: thunderstorms'."""
    if not raw or not raw.strip():
        return None
    r = re.sub(r"^[A-Z]{3}\s*/\s*", "", raw.strip())  # leading ARTCC id
    m = re.match(r"^([A-Z]{2,})(?: [A-Za-z ]+)?:\s*(.+)$", r)  # 'RWY:...', 'TM Initiatives:...'
    if m:
        label, detail = REASON_CODES.get(m.group(1), m.group(1).lower()), soften(m.group(2))
        r = label if detail.lower() in label.lower() else f"{label}: {detail}"  # not 'volume: volume'
    r = r.replace(" / ", ": ")
    return r[:1].upper() + r[1:]


# NOTAM effective times in a closure Reason: '... 2610211800-2610212200' (yymmddHHMM, UTC).
NOTAM_RANGE = re.compile(r"\b(\d{10})-(\d{10}|PERM)\b")


def notam_range(reason):
    """(start, end) from the NOTAM text; end None for PERM. These carry the year, unlike Start/Reopen."""
    m = NOTAM_RANGE.search(reason or "")
    if not m:
        return None

    def at(s):
        try:
            return datetime.strptime(s, "%y%m%d%H%M").replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return at(m.group(1)), (at(m.group(2)) if m.group(2) != "PERM" else None)


def faa_date(s, now):
    """'May 28 at 16:00 UTC.' (no year) -> the nearest such datetime to now."""
    m = re.match(r"\s*([A-Z][a-z]{2}) (\d{1,2}) at (\d{1,2}):(\d{2})", s or "")
    if not m:
        return None
    best = None
    for y in (now.year - 1, now.year, now.year + 1):
        try:
            dt = datetime.strptime(f"{y} {m.group(1)} {m.group(2)} {m.group(3)}:{m.group(4)}",
                                   "%Y %b %d %H:%M").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if best is None or abs(dt - now) < abs(best - now):
            best = dt
    return best


# NOTAM closures that only bar private (GA) flights; airline service is unaffected.
GA_ONLY = re.compile(r"NON SKED|TRANSIENT|\bGA\b|\bPPR\b")
FAA_RANK = {"normal": 0, "delay": 1, "ground_stop": 2, "closed": 3}


def parse_faa(xml_text, now):
    """FAA XML -> ({code: [event]}, updated ISO). Airspace flow programs are ignored."""
    root = ET.fromstring(xml_text)
    # An error page that happens to be well-formed must not read as "no delays anywhere".
    if root.tag != "AIRPORT_STATUS_INFORMATION":
        raise ValueError(f"unexpected reply <{root.tag[:20]}>")
    updated = None
    try:
        updated = iso_utc(datetime.strptime(root.findtext("Update_Time", "").strip(),
                                            "%a %b %d %H:%M:%S %Y GMT").replace(tzinfo=timezone.utc))
    except ValueError:
        pass
    found = {}

    def add(el, status, avg, text):
        code = (el.findtext("ARPT") or "").strip().upper()
        if code:
            found.setdefault(code, []).append(
                {"status": status, "avg_min": avg, "reason": faa_reason(el.findtext("Reason")), "text": text})

    for g in root.iter("Ground_Delay"):
        avg, mx = faa_minutes(g.findtext("Avg")), faa_minutes(g.findtext("Max"))
        add(g, "delay", avg, "Ground delay program: flights to here are held at their origin"
            + (f", avg {fmt_min(avg)}" if avg is not None else "") + (f", up to {fmt_min(mx)}" if mx else ""))
    for p in root.iter("Ground_Stop_List"):
        for g in p.iter("Program"):
            end = (g.findtext("End_Time") or "").strip()
            add(g, "ground_stop", None, "Ground stop: flights to here are held at their origin"
                + (f" until {end}" if end else ""))
    for d in root.iter("Delay"):
        for ad in d.findall("Arrival_Departure"):
            lo, hi = faa_minutes(ad.findtext("Min")), faa_minutes(ad.findtext("Max"))
            avg = round((lo + hi) / 2) if lo is not None and hi is not None else (lo if lo is not None else hi)
            trend = (ad.findtext("Trend") or "").strip().lower()
            rng = f" {fmt_min(lo)} to {fmt_min(hi)}" if lo is not None and hi is not None \
                else f" about {fmt_min(avg)}" if avg is not None else ""
            add(d, "delay", avg, f"{ad.get('Type') or 'Flight'} delays{rng}" + (f", {trend}" if trend else ""))
    for a in root.iter("Airport"):
        reason = a.findtext("Reason") or ""
        if GA_ONLY.search(reason):
            continue
        # Prefer the NOTAM's own dated range; Start/Reopen have no year.
        rng = notam_range(reason)
        start, reopen = rng if rng else (faa_date(a.findtext("Start"), now), faa_date(a.findtext("Reopen"), now))
        if (start and start > now) or (reopen and reopen <= now):
            continue
        tz = tz_of((a.findtext("ARPT") or "").strip().upper())
        if reopen:  # in the airport's own time, as the traveler reads clocks there
            until = f" until {local_when(reopen, tz, now)}" if tz \
                else f" until {reopen:%b} {reopen.day} {reopen:%H:%M} UTC"
        else:
            raw = (a.findtext("Reopen") or "").strip().rstrip(".")
            until = f" until {raw}" if raw else ""
        add(a, "closed", None, "Closed" + until)
    return found, updated


def faa_for(code, events, updated):
    """One airport's faa object: the worst event leads, others are appended to the text."""
    if not events:
        return {"status": "normal", "text": "No FAA delays reported", "avg_min": None,
                "reason": None, "updated": updated}
    events = sorted(events, key=lambda e: (FAA_RANK[e["status"]], e["avg_min"] or 0), reverse=True)
    top = events[0]
    avgs = [e["avg_min"] for e in events if e["avg_min"] is not None]
    text = "; ".join([top["text"]] + [e["text"] for e in events[1:3]])
    return {"status": top["status"], "text": text.replace("flights to here", f"flights to {code}"),
            "avg_min": max(avgs) if avgs else None, "reason": top["reason"], "updated": updated}


# ---------- weather (api.weather.gov) ----------

def icon_for(text, day=True):
    """Map NWS wording to one of the app's icons (app/src/icons)."""
    t = (text or "").lower()
    if "thunder" in t or "t-storm" in t:
        return "cloud-storm"
    if re.search(r"snow|sleet|ice|freezing|flurr|blizzard|wintry", t):
        return "snowflake"
    if re.search(r"rain|shower|drizzle", t):
        return "cloud" if "slight chance" in t else "cloud-rain"
    if re.search(r"fog|haze|smoke|mist|dust", t):
        return "cloud-fog"
    if re.search(r"wind|breezy|blustery", t):
        return "wind"
    clear = "sun" if day else "moon"
    if re.search(r"partly cloudy|mostly clear|mostly sunny|few clouds", t):
        return clear
    if re.search(r"cloud|overcast|partly sunny", t):
        return "cloud"
    if re.search(r"sunny|clear|fair", t):
        return clear
    return "cloud"


def get_hourly(place, clock):
    """Hourly forecast. On failure /points is asked for a fresh URL (grids get
    renumbered, and a second try also covers NWS's frequent brief 500s)."""
    doc, err = get_json(f"{NWS_BASE}/gridpoints/{place['grid']}/forecast/hourly", clock, NWS_HEADERS)
    if arr(dig(doc, "properties", "periods")):
        return doc, None
    pts, err2 = get_json(f"{NWS_BASE}/points/{place['lat']:.4f},{place['lon']:.4f}", clock, NWS_HEADERS)
    url = dig(pts, "properties", "forecastHourly")
    if isinstance(url, str) and url.startswith(NWS_BASE + "/"):  # only follow links back to NWS
        doc, err2 = get_json(url, clock, NWS_HEADERS)
        if arr(dig(doc, "properties", "periods")):
            return doc, None
    if err == err2:
        return None, err or "no periods"
    return None, f"{err or 'no periods'}, then {err2 or 'no periods'}"


def wind_mph_text(s):
    """'5 to 10 mph' -> 10 (the upper figure)."""
    nums = [int(n) for n in re.findall(r"\d+", s if isinstance(s, str) else "")]
    return max(nums) if nums else None


def parse_periods(doc):
    """Hourly periods in time order; a period with a bad time or temperature is skipped."""
    out = []
    for p in arr(dig(doc, "properties", "periods")):
        if not isinstance(p, dict):
            continue
        start, end = parse_iso(p.get("startTime")), parse_iso(p.get("endTime"))
        temp = num(p.get("temperature"))
        if not start or not end or end <= start or temp is None:
            continue
        if p.get("temperatureUnit") == "C":
            temp = temp * 9 / 5 + 32
        pop = num(dig(p, "probabilityOfPrecipitation", "value"))
        out.append({"start": start, "end": end, "temp_f": round(temp), "day": p.get("isDaytime") is not False,
                    "precip_pct": round(clamp(pop, 0, 100)) if pop is not None else 0,
                    "wind_mph": wind_mph_text(p.get("windSpeed")), "text": text_of(p.get("shortForecast"))})
    out.sort(key=lambda p: p["start"])
    return out


def period_out(p):
    return {"t": iso_utc(p["start"]), "temp_f": p["temp_f"], "precip_pct": p["precip_pct"],
            "text": p["text"], "icon": icon_for(p["text"], p["day"])}


OBS_MAX_AGE = timedelta(hours=2)


def parse_obs(doc, now):
    """Latest observation -> {at, temp_f, text, wind_mph, day}; None when missing or stale."""
    p = dig(doc, "properties")
    if not isinstance(p, dict):
        return None
    at = parse_iso(p.get("timestamp"))
    if not at or abs(now - at) > OBS_MAX_AGE:
        return None
    t = num(dig(p, "temperature", "value"))
    wv = num(dig(p, "windSpeed", "value"))
    if wv is not None:
        unit = dig(p, "windSpeed", "unitCode")
        wv = wv * 2.23694 if "m_s" in (unit if isinstance(unit, str) else "") else wv / 1.609344  # m/s or km/h
    icon_url = p.get("icon") if isinstance(p.get("icon"), str) else ""
    return {"at": at, "temp_f": round(t * 9 / 5 + 32) if t is not None else None,
            "text": text_of(p.get("textDescription")) or None,
            "wind_mph": round(wv) if wv is not None else None,
            "day": False if "/night/" in icon_url else True if "/day/" in icon_url else None}


SEV_RANK = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3}


def parse_alerts(doc, now):
    out, seen = [], set()
    for f in arr(dig(doc, "features")):
        p = dig(f, "properties")
        if not isinstance(p, dict):
            continue
        # The active list still carries superseded or finished messages ("has been replaced").
        if (p.get("status", "Actual") != "Actual" or p.get("messageType") == "Cancel"
                or p.get("replacedBy") or p.get("urgency") == "Past"):
            continue
        event, headline = text_of(p.get("event")), text_of(p.get("headline"))
        if not event:  # nothing to show
            continue
        end = parse_iso(p.get("ends")) or parse_iso(p.get("expires"))
        if (end and end <= now) or (event, headline) in seen:
            continue
        seen.add((event, headline))
        sev = p.get("severity") if p.get("severity") in SEV_RANK else None
        out.append({"event": event, "headline": headline or event, "severity": sev, "ends": iso_utc(end)})
    out.sort(key=lambda a: SEV_RANK.get(a["severity"], 4))
    return out[:5]


def leg_forecasts(code, legs, periods):
    """Forecast at each known departure from / arrival at this airport."""
    out = []
    for leg in legs:
        for end, k in (("dep", "from"), ("arr", "to")):
            here = leg.get(k)
            t = leg_time(leg, end) if isinstance(here, str) and here.upper() == code else None
            p = next((p for p in periods if p["start"] <= t < p["end"]), None) if t else None
            if p:
                out.append(dict(period_out(p), leg=leg.get("id"), flight=leg.get("flight"),
                                at=end, t=iso_utc(t)))
    return out


STALE_NOW = timedelta(hours=3)


def prune_wx(prev_wx, now):
    """Previous wx for when this run's fetches failed: past hours and ended alerts
    dropped. A reading over an hour old is replaced by the saved forecast hour for
    now; with no such hour, one over STALE_NOW old is blanked rather than shown as current."""
    wx = dict(prev_wx) if isinstance(prev_wx, dict) else {}
    if not wx:
        return wx
    hourly = [h for h in arr(wx.get("hourly")) if isinstance(h, dict) and parse_iso(h.get("t"))]
    wx["hourly"] = [h for h in hourly if parse_iso(h["t"]) > now - timedelta(hours=1)]
    wx["alerts"] = [a for a in arr(wx.get("alerts"))
                    if isinstance(a, dict) and (parse_iso(a.get("ends")) or now) >= now]
    this_hour = next((h for h in wx["hourly"]
                      if parse_iso(h["t"]) <= now < parse_iso(h["t"]) + timedelta(hours=1)), None)
    seen = parse_iso(wx.get("updated"))
    if seen and now - seen <= timedelta(hours=1):
        pass  # recent enough to stand as it is
    elif this_hour:
        wx.update(temp_f=this_hour.get("temp_f"), text=this_hour.get("text"),
                  precip_pct=this_hour.get("precip_pct"), icon=this_hour.get("icon") or wx.get("icon"))
    elif not seen or now - seen > STALE_NOW:
        wx.update(temp_f=None, text=None, wind_mph=None, precip_pct=None)
    return wx


def make_wx(code, res, prev_wx, now, legs, notes):
    (hdoc, herr), (odoc, oerr), (adoc, aerr) = res
    prev_wx = prev_wx if isinstance(prev_wx, dict) else {}
    periods = parse_periods(hdoc) if hdoc else None
    if periods == []:  # a reply, but no usable hour in it
        periods, herr = None, "no usable hours"
    obs = parse_obs(odoc, now) if odoc else None
    if periods is None and obs is None:
        notes.append(f"wx {code}: forecast failed ({herr}) and no recent observation ({oerr or 'stale'}); "
                     + kept(prev_wx))
        return prune_wx(prev_wx, now)
    old = prune_wx(prev_wx, now)
    wx = {}
    upcoming = [p for p in periods or [] if p["end"] > now]
    cur = upcoming[0] if upcoming else None
    if periods is None:
        notes.append(f"wx {code}: forecast failed ({herr}); " + ("kept previous hourly" if old.get("hourly")
                                                                    else "no hourly yet"))
    elif not obs:
        notes.append(f"wx {code}: no recent observation ({oerr or 'stale or empty'}); used the forecast hour")

    def pick(field):
        """Observation first, then the current forecast hour, then the last run."""
        for src in (obs, cur):
            if src and src.get(field) is not None:
                return src[field]
        return old.get(field)

    wx["temp_f"] = pick("temp_f")
    wx["text"] = pick("text")
    wx["wind_mph"] = pick("wind_mph")
    wx["precip_pct"] = cur["precip_pct"] if cur else old.get("precip_pct")
    day = obs["day"] if obs and obs["day"] is not None else (cur["day"] if cur else True)
    wx["icon"] = icon_for(wx["text"], day)
    if adoc is not None:
        wx["alerts"] = parse_alerts(adoc, now)
    else:
        notes.append(f"wx {code}: alerts failed ({aerr}); " + kept(old.get("alerts")))
        wx["alerts"] = old.get("alerts") or []
    wx["hourly"] = [period_out(p) for p in upcoming[:12]] if periods is not None else old.get("hourly") or []
    if code != "NYC":
        wx["legs"] = leg_forecasts(code, legs, periods) if periods is not None else arr(old.get("legs"))
    # When the shown reading was taken: the observation, else the forecast's issue time.
    issued = parse_iso(dig(hdoc, "properties", "updateTime")) if periods is not None else None
    wx["obs_at"] = iso_utc(obs["at"]) if obs else None
    wx["updated"] = iso_utc(obs["at"] if obs else issued) or old.get("updated")
    return wx


# ---------- traffic (NYC DOT real-time link speeds) ----------
#
# TRAFFIC MODEL
# NYC DOT publishes speeds for ~125 road links every ~5 min. Only four links on
# the LGA <-> Midtown drives report usable data: the Queens-Midtown Tunnel
# (each way) and the FDR between 25th and 63rd St (each way). The RFK Bridge
# links exist but returned "no data" (status -101) for all of 2026-10-04..18;
# the Grand Central Pkwy, Queens BQE and Queensboro Bridge have no links at all.
#
#   per link   ratio  = typ_mph / max(now_mph, 3), clamped to 0.6..4
#   per route  ratio  = time-weighted: sum(len/typ * ratio) / sum(len/typ)
#              factor = 1 + 0.8 * (ratio - 1)
#   per drive  factor = the lower of the two routes (a driver takes the faster)
#              min    = round(30 * factor), clamped to 20..90
# typ_mph is the median 7a-9p speed over that fortnight, so factor 1.0 means a
# normal daytime drive of TYPICAL_MIN. The 0.8 damping reflects that the links
# cover only ~2 of the ~9 miles: the unseen parts tend to move with them, but
# not fully. Backtest over the fortnight (weekdays): to_lga ~20 min overnight,
# 27-32 midday, 43-45 at 4-5p; to_hotel peaked at 38.
# A drive time comes only from readings at most MAX_AGE_MIN old, and the previous
# run's figure (kept when this run gets nothing usable) obeys the same limit;
# past it min is null so the app falls back to the guide's figure. The feed lands
# late: over 2026-10-13..18 the newest reading was <=15 min old in only ~half of
# daytime minutes, <=30 min in 83-96% and <=40 min in 88-100% (by time of day).
# It also stalls overnight (about 11p-5a), when min is null.

TYPICAL_MIN = 30
MIN_CLAMP = (20, 90)
ALPHA = 0.8
RATIO_CLAMP = (0.6, 4.0)
MAX_AGE_MIN = 35


def seg(link, name, where, len_mi, typ_mph):
    return {"link": link, "name": name, "where": where, "len": len_mi, "typ": typ_mph}


# len_mi = speed x travel_time; typ_mph from history. RFK figures are estimates.
ROUTES = {
    "to_lga": [
        ("Midtown Tunnel", [seg("4456511", "Midtown Tunnel", "at the Midtown Tunnel", 1.52, 28.6)]),
        ("RFK Bridge", [seg("4616329", "FDR Drive (25th to 63rd St)", "on the FDR", 1.89, 16.8),
                        seg("4456450", "FDR to RFK ramp", "at the RFK ramp", 0.6, 25.0),
                        seg("4456481", "RFK Bridge", "on the RFK Bridge", 1.4, 35.0)]),
    ],
    "to_hotel": [
        ("Midtown Tunnel", [seg("4456510", "Midtown Tunnel", "at the Midtown Tunnel", 1.51, 16.8)]),
        ("RFK Bridge", [seg("4456476", "RFK Bridge", "on the RFK Bridge", 1.4, 35.0),
                        seg("4456452", "RFK to FDR ramp", "at the RFK ramp", 0.6, 25.0),
                        seg("4616332", "FDR Drive (63rd to 25th St)", "on the FDR", 1.90, 30.4)]),
    ],
}
LINK_IDS = sorted({s["link"] for routes in ROUTES.values() for _, segs in routes for s in segs})


def fetch_traffic(now, clock):
    """Newest rows for our links from the last 24 h up to now (so --now can replay history)."""
    fmt = "%Y-%m-%dT%H:%M:%S"  # data_as_of is New York local time without a zone
    since = (now - timedelta(hours=24)).astimezone(NY).strftime(fmt)
    until = (now + timedelta(minutes=1)).astimezone(NY).strftime(fmt)
    ids = ",".join(f"'{i}'" for i in LINK_IDS)
    q = urlencode({"$select": "link_id,speed,status,data_as_of",
                   "$where": f"link_id in({ids}) AND data_as_of > '{since}' AND data_as_of <= '{until}'",
                   "$order": "data_as_of DESC", "$limit": "120"})
    rows, err = get_json(f"{DOT_URL}?{q}", clock, timeout=20)
    if rows is not None and not isinstance(rows, list):  # Socrata errors come back as an object
        return None, "unexpected reply"
    return rows, err


def seg_status(mph, typ):
    r = mph / typ
    return "jam" if mph < 8 or r < 0.45 else "slow" if r < 0.75 else "ok"


def drive(key, readings):
    """One direction from fresh readings, or None when no route has any."""
    best, seen = None, []
    for via, segs in ROUTES[key]:
        t_typ = t_now = 0.0
        obs = []
        for s in segs:
            if s["link"] not in readings:
                continue
            mph = readings[s["link"]][0]
            base = s["len"] / s["typ"]
            t_typ += base
            t_now += base * clamp(s["typ"] / max(mph, 3), *RATIO_CLAMP)
            obs.append((s, mph))
        if not obs:
            continue
        factor = 1 + ALPHA * (t_now / t_typ - 1)
        seen.append((via, obs))
        if best is None or factor < best[0]:
            best = (factor, via, obs)
    if not best:
        return None
    factor, via, obs = best
    mins = int(clamp(round(TYPICAL_MIN * factor), *MIN_CLAMP))
    if mins <= TYPICAL_MIN - 5:
        lead = "Light traffic"
    elif mins <= TYPICAL_MIN + 4:
        lead = "Usual traffic"
    else:
        s, mph = min(obs, key=lambda o: o[1] / o[0]["typ"])
        st = seg_status(mph, s["typ"])
        lead = f"Heavy {s['where']}" if st == "jam" else f"Slow {s['where']}" if st == "slow" \
            else "Busier than usual"
    # The chosen route's links first, then the other route's.
    segs = obs + [o for v, os_ in seen if v != via for o in os_]
    newest = max(readings[s["link"]][1] for s, _ in segs)
    return {"min": mins, "typical_min": TYPICAL_MIN, "text": f"{lead} · {mins} min", "via": via,
            "segments": [{"name": s["name"], "mph": round(mph), "status": seg_status(mph, s["typ"])}
                         for s, mph in segs],
            "updated": iso_utc(newest)}


def make_traffic(rows, err, prev_tr, now, max_age_min, notes):
    max_age = timedelta(minutes=max_age_min)
    readings, newest_seen = {}, None
    latest = {}
    for r in arr(rows):
        try:
            lid = str(r["link_id"])
            at = datetime.fromisoformat(r["data_as_of"][:19]).replace(tzinfo=NY)
            mph = float(r.get("speed") or 0)
        except (KeyError, TypeError, ValueError, AttributeError):  # odd row: skip it, not the feed
            continue
        if not 0 <= mph < 150 or at > now + timedelta(minutes=5):  # NaN/inf, or a future stamp
            continue
        if lid not in latest or at > latest[lid][1]:
            latest[lid] = (r, at, mph)
    for lid, (r, at, mph) in latest.items():
        newest_seen = max(newest_seen or at, at)
        if str(r.get("status")) == "0" and mph > 0 and now - at <= max_age:
            readings[lid] = (mph, at)
    if err:
        why = f"NYC DOT failed ({err})"
    elif newest_seen and now - newest_seen > max_age:
        why = f"newest NYC DOT reading is {int((now - newest_seen).total_seconds() // 60)} min old"
    elif newest_seen:
        why = "NYC DOT links report no usable speed"
    else:
        why = "NYC DOT returned no usable readings for the last 24 h"
    prev_tr = prev_tr if isinstance(prev_tr, dict) else {}
    prev_at = parse_iso(prev_tr.get("updated"))
    out = {}
    for key in ("to_hotel", "to_lga"):
        d = drive(key, readings)
        if d is None:
            p = prev_tr.get(key) if isinstance(prev_tr.get(key), dict) else {}
            p_at = parse_iso(p.get("updated")) or prev_at
            if num(p.get("min")) and p_at and now - p_at <= max_age:  # same freshness rule as a new reading
                d = p
                notes.append(f"traffic {key}: {why}; kept the {hhmm(p_at)} reading")
            else:
                d = {"min": None, "typical_min": TYPICAL_MIN,
                     "text": f"No recent traffic reading · usually about {TYPICAL_MIN} min",
                     "via": None, "segments": [], "updated": None}
                notes.append(f"traffic {key}: {why}; no drive time shown")
        if key == "to_hotel":
            d = dict(d, dest="Midtown Manhattan")  # hotel not known yet
        out[key] = d
    stamps = [parse_iso(out[k].get("updated")) for k in ("to_hotel", "to_lga")]
    out["updated"] = iso_utc(max([s for s in stamps if s], default=None))
    return out


# ---------- MTA alerts ----------

SUBWAY = ["E", "F", "7", "N", "W", "M", "R", "4", "5", "6", "1", "2", "3", "A", "C", "B", "D", "Q"]
BUSES = {"Q70": "Q70", "M60": "M60-SBS", "Q47": "Q47", "Q72": "Q72"}  # feed id (minus "+") -> label
PRIORITY = ["Q70", "M60-SBS", "E", "F", "7", "N", "W"]
ORDER = PRIORITY + [r for r in SUBWAY + list(BUSES.values()) if r not in PRIORITY]
BUS_AGENCIES = {"MTA NYCT", "MTABC"}
MAX_ALERTS = 12
INFO_TYPES = ("boarding change", "station notice", "special schedule", "special notice", "extra service")
OFF_TRIP = {"Brooklyn", "Bronx", "Staten Island"}


def mta_route(agency, rid):
    """Feed route -> our label, or None. Express variants (6X, 7X, FX) fold into the base line."""
    rid = (rid or "").strip().upper()
    if agency == "MTASBWY":  # other agencies reuse ids like "1" (LIRR)
        rid = rid[:-1] if len(rid) == 2 and rid.endswith("X") else rid
        return rid if rid in SUBWAY else None
    if agency in BUS_AGENCIES:
        return BUSES.get(rid.rstrip("+"))  # SBS routes carry a "+": M60+
    return None


def mta_severity(atype):
    t = (atype or "").lower()
    if any(k in t for k in INFO_TYPES):
        return "info"
    if "suspend" in t or "no service" in t or t in ("delays", "planned - delays"):
        return "severe"
    return "warning"  # reroutes, skipped stops, detours, reduced service, some/expect delays


def mta_text(s, limit=220):
    s = s if isinstance(s, str) else ""
    s = re.sub(r"<br\s*/?>|</p>", "\n", s, flags=re.I)  # only if an HTML variant was the one picked
    s = re.sub(r"<[^>]+>", "", s).replace("&nbsp;", " ").replace("&amp;", "&")
    s = re.sub(r"\[[a-z][a-z ]*? icon\]\s*", "", s, flags=re.I)  # "[shuttle bus icon]" glyph markers
    s = re.sub(r"(?<![.!?:;,])[ \t]*\n\s*", ". ", s.strip())  # line breaks separate sentences
    s = re.sub(r"\s+", " ", s).replace(" ,", ",")
    if len(s) > limit:
        s = s[:limit - 1].rsplit(" ", 1)[0].rstrip(",;:-") + "…"
    return s


def epoch(v):
    """Unix seconds as a number; the feed sends some as digit strings ("1792355335")."""
    if isinstance(v, str) and v.strip().isdigit():
        return float(v)
    return num(v)


def is_active(periods, ts):
    periods = [p for p in arr(periods) if isinstance(p, dict)]
    if not periods:
        return True
    return any((epoch(p.get("start")) or 0) <= ts < (epoch(p.get("end")) or float("inf")) for p in periods)


def en_text(translations):
    """English plain text, else any plain variant, else an HTML one (mta_text strips tags)."""
    tr = [t for t in arr(translations)
          if isinstance(t, dict) and isinstance(t.get("text"), str) and t["text"].strip()]
    for want in (lambda l: l == "en", lambda l: "html" not in l, lambda l: True):
        hit = next((t["text"] for t in tr if want(str(t.get("language") or ""))), None)
        if hit:
            return hit
    return ""


def make_transit(doc, now):
    if not isinstance(doc, dict):
        raise ValueError("unexpected reply")
    ts = now.timestamp()
    merged = {}
    for ent in arr(doc.get("entity")):
        a = dig(ent, "alert")
        if not isinstance(a, dict) or not is_active(a.get("active_period"), ts):
            continue
        routes = {mta_route(ie.get("agency_id"), ie.get("route_id"))
                  for ie in arr(a.get("informed_entity")) if isinstance(ie, dict)}
        routes.discard(None)
        text = mta_text(en_text(dig(a, "header_text", "translation")))
        if not routes or not text:
            continue
        m = a.get("transit_realtime.mercury_alert")
        m = m if isinstance(m, dict) else {}
        atype = text_of(m.get("alert_type"))
        upd = epoch(m.get("updated_at")) or epoch(m.get("created_at")) or 0
        sev = mta_severity(atype)
        cur = merged.get(text)
        if cur:  # one notice is often split per route; merge it back
            cur["routes"] |= routes
            cur["ts"] = max(cur["ts"], upd)
            if SEV_ORDER.index(sev) < SEV_ORDER.index(cur["severity"]):
                cur["severity"] = sev
        else:
            merged[text] = {"routes": routes, "text": text, "ts": upd, "severity": sev,
                            "planned": atype.lower().startswith("planned")}
    out = []
    for a in merged.values():
        routes = sorted(a["routes"], key=ORDER.index)
        # "Manhattan-bound" is a direction, not a place.
        boroughs = set(re.findall(r"\b(Manhattan|Queens|Brooklyn|Bronx|Staten Island)\b(?!-bound)", a["text"]))
        off = bool(boroughs) and boroughs <= OFF_TRIP
        if off:
            tier = 3
        elif a["severity"] == "info":
            tier = 2
        else:
            tier = 0 if any(r in PRIORITY for r in routes) else 1
        out.append((tier, SEV_ORDER.index(a["severity"]), a["planned"], -a["ts"], {
            "route": routes[0], "routes": routes, "mode": "bus" if routes[0] in BUSES.values() else "subway",
            "text": a["text"], "updated": stamp(a["ts"]), "severity": a["severity"], "planned": a["planned"]}))
    out.sort(key=lambda x: x[:4])
    return {"alerts": [x[4] for x in out[:MAX_ALERTS]], "updated": stamp(epoch(dig(doc, "header", "timestamp")))}


SEV_ORDER = ["severe", "warning", "info"]


def stamp(epoch):
    """Unix seconds -> ISO, or None when missing or absurd."""
    try:
        return iso_utc(datetime.fromtimestamp(int(epoch), timezone.utc)) if epoch and epoch > 0 else None
    except (OverflowError, OSError, ValueError, TypeError):
        return None


# ---------- build ----------

SOURCES = ("faa", "wx", "traffic", "transit")


def build(prev, legs, now=None, *, only=None, traffic_max_age=MAX_AGE_MIN, budget=BUDGET_S):
    """Conditions part of the status bundle. See the module docstring."""
    now = as_now(now)
    prev = prev if isinstance(prev, dict) else {}
    legs = norm_legs(legs)
    codes = airport_codes(legs)
    places = [c for c in codes if c in PLACES] + ["NYC"]  # the ones with weather
    want = set(only or SOURCES)
    clock = Clock(budget)
    notes = []
    prev_ap = prev.get("airports") if isinstance(prev.get("airports"), dict) else {}

    def prev_of(code, key):
        v = dig(prev_ap, code, key)
        return v if isinstance(v, dict) else {}

    jobs = {}
    if "faa" in want:
        jobs["faa"] = partial(fetch, FAA_URL, clock)
    if "wx" in want:
        for code in places:
            p = PLACES[code]
            jobs[("hourly", code)] = partial(get_hourly, p, clock)
            jobs[("obs", code)] = partial(get_json, f"{NWS_BASE}/stations/{p['station']}/observations/latest",
                                          clock, NWS_HEADERS)
            jobs[("alerts", code)] = partial(get_json, f"{NWS_BASE}/alerts/active?point={p['lat']},{p['lon']}",
                                             clock, NWS_HEADERS)
    if "traffic" in want:
        jobs["traffic"] = partial(fetch_traffic, now, clock)
    if "transit" in want:
        jobs["transit"] = partial(get_json, MTA_URL, clock, None, 25)
    res = run_all(jobs, clock)

    # FAA: one feed for every airport.
    faa = {c: prev_of(c, "faa") for c in codes}
    if "faa" in want:
        body, err = res["faa"]
        try:
            if err:
                raise RuntimeError(err)
            events, updated = parse_faa(body, now)
            faa = {c: faa_for(c, events.get(c), updated) for c in codes}
        except Exception as e:  # includes XML parse errors
            why = "unreadable reply" if isinstance(e, ET.ParseError) else e
            notes.append(f"faa: {why}; " + kept(any(faa.values())))

    # Weather per place.
    wx = {c: prev_of(c, "wx") for c in places}
    if "wx" in want:
        for c in places:
            try:
                wx[c] = make_wx(c, (res[("hourly", c)], res[("obs", c)], res[("alerts", c)]),
                                wx[c], now, legs, notes)
            except Exception as e:  # a parser bug costs this place only
                notes.append(f"wx {c}: {type(e).__name__}: {e}; " + kept(wx[c]))
                wx[c] = prune_wx(wx[c], now)

    airports = {c: {"faa": faa[c], "wx": wx.get(c, {}), "tsa": {}} for c in codes}
    airports["NYC"] = {"name": PLACES["NYC"]["name"], "wx": wx["NYC"]}

    traffic = prev.get("traffic") if isinstance(prev.get("traffic"), dict) else {}
    if "traffic" in want:
        rows, err = res["traffic"]
        try:
            traffic = make_traffic(rows, err, traffic, now, traffic_max_age, notes)
        except Exception as e:  # a bug here must not leave an old drive time standing
            notes.append(f"traffic: {type(e).__name__}: {e}; drive times cleared")
            blank = {"min": None, "typical_min": TYPICAL_MIN, "text": "No recent traffic reading",
                     "via": None, "segments": [], "updated": None}
            traffic = {"to_hotel": dict(blank, dest="Midtown Manhattan"), "to_lga": dict(blank), "updated": None}

    transit = prev.get("transit") if isinstance(prev.get("transit"), dict) else {"alerts": []}
    if "transit" in want:
        doc, err = res["transit"]
        try:
            if err:
                raise RuntimeError(err)
            transit = make_transit(doc, now)
        except Exception as e:
            notes.append(f"transit: {e}; " + kept(transit.get("alerts")))

    return {"airports": airports, "traffic": traffic, "transit": transit, "notes": notes}


# ---------- CLI ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--legs", default=DEFAULT_LEGS, help="legs JSON (list, {legs:[...]} or a status bundle)")
    ap.add_argument("--prev", help="previous status bundle or conditions JSON")
    ap.add_argument("--now", help="ISO time override (traffic replays history up to it)")
    ap.add_argument("--only", help="comma list of: " + ",".join(SOURCES))
    ap.add_argument("--traffic-max-age", type=float, default=MAX_AGE_MIN,
                    help="minutes a traffic reading stays usable; raise it to try the model while the feed is stalled")
    ap.add_argument("--out", help="also write the JSON here (keep it in a gitignored path)")
    a = ap.parse_args()

    legs = []
    try:
        legs = json.load(open(a.legs))
    except (OSError, ValueError) as e:
        print(f"legs not loaded ({e}); using PHX/CLT/LGA only", file=sys.stderr)
    prev = {}
    if a.prev:
        try:
            prev = json.load(open(a.prev))
        except (OSError, ValueError) as e:
            print(f"prev not loaded: {e}", file=sys.stderr)
    only = [s.strip() for s in a.only.split(",")] if a.only else None
    t0 = time.monotonic()
    doc = build(prev, legs, a.now, only=only, traffic_max_age=a.traffic_max_age)
    text = json.dumps(doc, indent=1, ensure_ascii=False)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(text)
    print(text)
    print(f"built in {time.monotonic() - t0:.1f}s with {len(doc['notes'])} notes", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
