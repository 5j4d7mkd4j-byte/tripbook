#!/usr/bin/env python3
"""Check the trip's flight legs against public flight trackers.

run.py calls update_legs(); this file also runs on its own for testing:
  python3 updater/flight_status.py --legs legs.json [--prev status.json] [--out out.json] [--now ISO]

legs.json is a list (or {"legs": [...]}) of planned legs:
  {"id": "out1", "flight": "AA1234", "date": "2026-01-31", "from": "PHX", "to": "CLT"}

Sources, in order:
  1. FlightStats flight-tracker JSON. It only serves today +/- 3 days, so a leg
     further out is not queried at all and its last reading is copied forward.
  2. FlightView/OAG JSON filtered by departure airport. Fills gaps and names the
     inbound aircraft's previous flight.

Rules from app/CONTRACT.md implemented here:
  - route_ok:false when the number flies a different route that day. The other
    route's values never replace the planned leg's.
  - fetch_failed:true when every source errored and the last good reading
    (which is kept) is FETCH_GRACE old; a shorter gap only adds a run note.
  - canceled is only true once two consecutive checks report it (cancel_seen).
  - A field a source leaves empty keeps its previous value.
  - events: plain-language changes between runs, newest first, last 30 kept.
Only the standard library and the system curl are used.
"""
import argparse
import copy
import json
import os
import re
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0 Safari/537.36")
# Base URLs can be overridden to exercise the failure paths in tests.
FS_BASE = os.environ.get("FS_BASE", "https://www.flightstats.com/v2/api-next/flight-tracker")
FV_BASE = os.environ.get("FV_BASE", "https://app-api.flightview.com/api/v2/flight")
FV_HEADERS = {"Origin": "https://www.flightview.com", "Referer": "https://www.flightview.com/"}

FS_DAYS = 3                           # FlightStats serves today +/- 3 days
MAX_EVENTS = 30
MOVE_MIN = 5                          # smaller time moves are not worth an event
FINAL_AFTER = timedelta(hours=2)      # stop checking a leg this long after it reached the gate
INBOUND_AHEAD = timedelta(hours=8)    # look up the inbound aircraft only this close to departure
# A failed lookup only sets fetch_failed once the leg's last good check is this
# old. The app drops every live value of a fetch_failed leg, so one blocked
# request (or an Actions run between two good Mac runs) must not blank the gate.
FETCH_GRACE = timedelta(minutes=20)

# FlightStats names winglet/sharklet sub-types (32B = A321 with sharklets);
# FlightView, the trip plan and the guide use the base type. Same cabin, so
# they compare equal; a real swap (321 -> 32Q A321neo) still shows.
EQUIP_BASE = {"32A": "320", "32B": "321", "73H": "738", "73W": "73G", "73J": "739",
              "75W": "752", "76W": "763", "E7W": "E75"}
# FlightStats notes that tell the traveler nothing ("Status Last Updated 44
# Minutes Ago" also goes stale the moment it is stored).
BOILERPLATE = re.compile(r"^(tracking will begin after departure|status last updated\b)", re.I)

# Airport time zones. FlightStats answers add to this at runtime.
TZ = {
    "PHX": "America/Phoenix", "CLT": "America/New_York", "LGA": "America/New_York",
    "JFK": "America/New_York", "EWR": "America/New_York", "BOS": "America/New_York",
    "DCA": "America/New_York", "IAD": "America/New_York", "BWI": "America/New_York",
    "PHL": "America/New_York", "PIT": "America/New_York", "RDU": "America/New_York",
    "RIC": "America/New_York", "CHS": "America/New_York", "ATL": "America/New_York",
    "MIA": "America/New_York", "FLL": "America/New_York", "TPA": "America/New_York",
    "MCO": "America/New_York", "RSW": "America/New_York", "DTW": "America/Detroit",
    "ORD": "America/Chicago", "DFW": "America/Chicago", "IAH": "America/Chicago",
    "AUS": "America/Chicago", "BNA": "America/Chicago", "MSP": "America/Chicago",
    "OMA": "America/Chicago", "STL": "America/Chicago", "DEN": "America/Denver",
    "SLC": "America/Denver", "LAS": "America/Los_Angeles", "LAX": "America/Los_Angeles",
    "SFO": "America/Los_Angeles", "SAN": "America/Los_Angeles", "SEA": "America/Los_Angeles",
    "PDX": "America/Los_Angeles", "HNL": "Pacific/Honolulu",
}


def tz_of(ap):
    return ZoneInfo(TZ.get(ap or "", "America/New_York"))


# ---------- small helpers ----------

def iso_utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_iso(s):
    """Parse the ISO timestamps this file writes (or any with an offset)."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_fs_utc(s):
    """FlightStats UTC fields look like 2026-10-18T18:39:00.000Z."""
    if not s:
        return None
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def split_flight(f):
    m = re.fullmatch(r"\s*([A-Z0-9]{2})\s*0*(\d{1,4})\s*", str(f).upper())
    if not m:
        raise ValueError(f"bad flight number: {f}")
    return m.group(1), m.group(2)


def norm_flight(f):
    c, n = split_flight(f)
    return c + n


def blank(v):
    return v is None or v == ""


def base_code(code):
    """Aircraft type code as the plan and guide spell it (32B -> 321)."""
    code = (str(code).strip().upper() if code else "") or None
    return EQUIP_BASE.get(code, code) if code else None


def useful_note(msg):
    msg = (msg or "").strip()
    return msg if msg and not BOILERPLATE.match(msg) else None


def mins_between(a, b):
    """Whole minutes from ISO a to ISO b."""
    da, db = parse_iso(a), parse_iso(b)
    return round((db - da).total_seconds() / 60) if da and db else None


def clock(iso, airport):
    """5:25a in the airport's local time."""
    dt = parse_iso(iso)
    if not dt:
        return "?"
    loc = dt.astimezone(tz_of(airport))
    return loc.strftime("%I:%M%p").lstrip("0").lower().replace("m", "")


def signed(m):
    """+25m, −1h 5m (true minus sign, matching the app)."""
    sign = "+" if m >= 0 else "−"
    m = abs(m)
    return f"{sign}{m // 60}h {m % 60}m" if m >= 60 else f"{sign}{m}m"


def path_of(segments):
    """Join (from, to) hops into MIA-TPA-MIA; a gap between hops becomes ', '."""
    out = ""
    for a, b in segments:
        if not out:
            out = f"{a}-{b}"
        elif out.endswith(f"-{a}"):
            out += f"-{b}"
        else:
            out += f", {a}-{b}"
    return out or None


# ---------- http ----------

def curl_json(url, headers=None, timeout=15):
    """GET a JSON document with the system curl. Returns (doc, None) or (None, error)."""
    cmd = ["curl", "-s", "--compressed", "-m", str(timeout), "-A", UA, "-w", "\n%{http_code}"]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10).stdout
    except Exception as e:  # curl missing or hung past its own timeout
        return None, f"curl failed: {type(e).__name__}"
    body, _, code = out.rpartition("\n")
    if code == "000":
        return None, "no connection"
    if code != "200":
        return None, f"HTTP {code}"
    try:
        return json.loads(body), None
    except ValueError:
        return None, "bad JSON"


# ---------- FlightStats ----------

def fs_fetch(carrier, num, day, flight_id=None):
    """One FlightStats tracker document: (data, None), (None, None) when no flight, or (None, err)."""
    url = f"{FS_BASE}/{carrier}/{num}/{day.year}/{day.month}/{day.day}"
    if flight_id:
        url += f"/{flight_id}"
    js, err = curl_json(url)
    if err:
        return None, err
    data = js.get("data") if isinstance(js, dict) else None
    return (data if isinstance(data, dict) and data else None), None


def fs_segments(carrier, num, day):
    """Every hop the number flies on that day: [(from, to, flightId, sortTime)], or (None, err)."""
    js, err = curl_json(f"{FS_BASE}/other-days/{carrier}/{num}")
    if err:
        return None, err
    hops = []
    for d in (js.get("data") if isinstance(js, dict) else None) or []:
        try:
            when = datetime.strptime(f"{d.get('date1')}-{d.get('year')}", "%d-%b-%Y").date()
        except (TypeError, ValueError):
            continue
        if when != day:
            continue
        for f in d.get("flights") or []:
            m = re.search(r"flightId=(\d+)", f.get("url") or "")
            hops.append(((f.get("departureAirport") or {}).get("fs"),
                         (f.get("arrivalAirport") or {}).get("fs"),
                         m.group(1) if m else None, f.get("sortTime") or ""))
    return sorted(hops, key=lambda h: h[3]), None


def fs_reading(d):
    """Normalise one FlightStats tracker document."""
    dep, arr = d.get("departureAirport") or {}, d.get("arrivalAirport") or {}
    div = d.get("divertedAirport") or {}
    for a in (dep, arr, div):
        if a.get("fs") and a.get("timeZoneRegionName"):
            TZ.setdefault(a["fs"], a["timeZoneRegionName"])
    st, sch = d.get("status") or {}, d.get("schedule") or {}
    note = d.get("flightNote") or {}
    eq = (d.get("additionalFlightInfo") or {}).get("equipment") or {}
    delay = st.get("delay") or {}
    diverted = bool(st.get("diverted"))
    return {
        "source": "flightstats",
        "from": dep.get("fs"), "to": arr.get("fs"),
        "status": st.get("status"),
        "status_detail": st.get("statusDescription"),
        "canceled": bool(note.get("canceled")) or st.get("statusCode") == "C",
        "diverted_to": (div.get("fs") or (d.get("positional") or {}).get("divertedAirportCode"))
                       if diverted else None,
        "phase": note.get("phase"),
        "departed": bool(note.get("hasDepartedGate") or note.get("hasDepartedRunway")),
        "landed": bool(note.get("landed")),
        "dep": {
            "terminal": dep.get("terminal"), "gate": dep.get("gate"),
            "sched": iso_utc(parse_fs_utc(sch.get("scheduledDepartureUTC"))),
            "est": iso_utc(parse_fs_utc(sch.get("estimatedActualDepartureUTC"))),
            "actual": (sch.get("estimatedActualDepartureTitle") or "").lower() == "actual",
        },
        "arr": {
            "terminal": arr.get("terminal"), "gate": arr.get("gate"),
            "baggage": arr.get("baggage"),
            "sched": iso_utc(parse_fs_utc(sch.get("scheduledArrivalUTC"))),
            "est": iso_utc(parse_fs_utc(sch.get("estimatedActualArrivalUTC"))),
            "actual": (sch.get("estimatedActualArrivalTitle") or "").lower() == "actual",
        },
        "delay_dep_min": (delay.get("departure") or {}).get("minutes"),
        "delay_arr_min": (delay.get("arrival") or {}).get("minutes"),
        "aircraft": eq.get("name"), "aircraft_code": base_code(eq.get("iata")),
        "source_note": useful_note(note.get("message")),
        "inbound": None,
    }


def fs_check(leg):
    """FlightStats for the planned route.

    Returns ('ok', reading) | ('other', route seen) | ('none', None) | ('fail', error).
    """
    carrier, num = split_flight(leg["flight"])
    day = date.fromisoformat(leg["date"])
    route = (leg["from"], leg["to"])
    data, err = fs_fetch(carrier, num, day)
    if err:
        return "fail", f"flightstats: {err}"
    first = fs_reading(data) if data else None
    if first and (first["from"], first["to"]) == route:
        return "ok", first
    # A multi-hop number answers with one hop; the other-days list names each hop and its id.
    hops, err = fs_segments(carrier, num, day)
    if err:
        return "fail", f"flightstats other-days: {err}"
    for a, b, fid, _ in hops:
        if (a, b) == route and fid:
            data, err = fs_fetch(carrier, num, day, fid)
            if err:
                return "fail", f"flightstats by id: {err}"
            r = fs_reading(data) if data else None
            if r and (r["from"], r["to"]) == route:
                return "ok", r
    if hops:
        return "other", path_of([(a, b) for a, b, _, _ in hops])
    if first:
        return "other", f"{first['from']}-{first['to']}"
    return "none", None


def fs_inbound(inb, leg):
    """Add status and arrival estimate to the inbound aircraft's flight, when FlightStats has it."""
    try:
        carrier, num = split_flight(inb.get("flight") or "")
        day = date.fromisoformat(inb.get("date") or "")
    except ValueError:
        return inb
    data, err = fs_fetch(carrier, num, day)
    r = fs_reading(data) if data and not err else None
    if not r or r["to"] != leg["from"]:
        return inb  # wrong hop of a multi-hop number; not worth more requests
    out = dict(inb, status=r["status"])
    est = r["arr"]["est"] or r["arr"]["sched"]
    if est:
        out["est"] = est
    return out


# ---------- FlightView ----------

def fv_time(s, airport, year):
    """FlightView times look like '16:28, Oct 18' in the airport's local time."""
    if not s:
        return None
    try:
        local = datetime.strptime(f"{s} {year}", "%H:%M, %b %d %Y")
    except ValueError:
        return None
    return local.replace(tzinfo=tz_of(airport))


def fv_fetch(leg, airport=None):
    carrier, num = split_flight(leg["flight"])
    url = f"{FV_BASE}/{carrier}/{num}?departureDate={leg['date']}"
    if airport:
        url += f"&departureAirport={airport}"
    js, err = curl_json(url, FV_HEADERS)
    if err:
        return None, err
    return (js if isinstance(js, dict) else {}), None


def fv_reading(f, year):
    """Normalise one FlightView flight."""
    d, a = f.get("departure") or {}, f.get("arrival") or {}
    dc, ac = d.get("airportCode"), a.get("airportCode")
    status = f.get("flightStatus") or None
    s_dep, e_dep = fv_time(d.get("scheduledTime"), dc, year), fv_time(d.get("estimatedTime"), dc, year)
    out_gate = fv_time(d.get("outGateTime"), dc, year)
    off = fv_time(d.get("offGroundTime"), dc, year)
    s_arr, e_arr = fv_time(a.get("scheduledTime"), ac, year), fv_time(a.get("estimatedTime"), ac, year)
    in_gate = fv_time(a.get("inGateTime"), ac, year)
    on = fv_time(a.get("onGroundTime"), ac, year)
    dep_est = out_gate or off or e_dep
    arr_est = in_gate or on or e_arr
    prev = f.get("previousFlight") or None
    craft = f.get("aircraft") or {}
    low = (status or "").lower()
    return {
        "source": "flightview",
        "from": dc, "to": ac,
        "status": status,
        "status_detail": None,
        "canceled": low.startswith("cancel"),
        "diverted_to": None,
        "phase": None,
        "departed": bool(out_gate or off) or low in ("in air", "departed", "landed", "arrived"),
        "landed": bool(in_gate or on) or low in ("landed", "arrived"),
        "dep": {"terminal": d.get("terminal") or None, "gate": d.get("gate") or None,
                "sched": iso_utc(s_dep), "est": iso_utc(dep_est), "actual": bool(out_gate or off)},
        "arr": {"terminal": a.get("terminal") or None, "gate": a.get("gate") or None,
                "baggage": a.get("baggage") or None,
                "sched": iso_utc(s_arr), "est": iso_utc(arr_est), "actual": bool(in_gate)},
        "delay_dep_min": late(s_dep, dep_est),
        "delay_arr_min": late(s_arr, arr_est),
        "aircraft": craft.get("name"), "aircraft_code": base_code(craft.get("code")),
        "source_note": None,
        "inbound": ({"flight": f"{prev.get('airlineCode') or ''}{prev.get('flightNumber') or ''}",
                     "from": prev.get("departureAirport"), "date": prev.get("departureDate")}
                    if prev and prev.get("flightNumber") else None),
    }


def late(sched, est):
    if not sched or not est:
        return None
    return max(0, round((est - sched).total_seconds() / 60))


def fv_route_seen(leg):
    """What the number flies that day without the airport filter: (route, err)."""
    js, err = fv_fetch(leg)
    if err:
        return None, err
    if js.get("flight"):
        r = fv_reading(js["flight"], int(leg["date"][:4]))
        return f"{r['from']}-{r['to']}", None
    hops = [(h.get("departureAirportCode"), h.get("arrivalAirportCode")) for h in js.get("flights") or []]
    return path_of(hops), None


def fv_check(leg):
    """FlightView for the planned route; same return shape as fs_check."""
    js, err = fv_fetch(leg, leg["from"])
    if err:
        return "fail", f"flightview: {err}"
    f = js.get("flight")
    if f and not js.get("emptyResults"):
        r = fv_reading(f, int(leg["date"][:4]))
        if (r["from"], r["to"]) == (leg["from"], leg["to"]):
            return "ok", r
        seen, _ = fv_route_seen(leg)
        return "other", seen or f"{r['from']}-{r['to']}"
    seen, err = fv_route_seen(leg)
    if err:
        return "fail", f"flightview: {err}"
    return ("other", seen) if seen else ("none", None)


# ---------- one leg ----------

# Filled from the second source read in the same run.
KEEP_FIELDS = ("status", "status_detail", "phase", "aircraft", "aircraft_code",
               "source_note", "inbound", "diverted_to")
# Carried from the previous good reading when this one leaves them empty.
# status_detail, phase, source_note and the delays describe one moment, so a
# stale copy would contradict the new times; delays are worked out again instead.
CARRY_FIELDS = ("status", "aircraft", "aircraft_code", "inbound", "diverted_to")


def fill(dst, src, keys=KEEP_FIELDS):
    """Fill dst's empty fields from src (dep/arr sub-fields too). Booleans only move forward."""
    for side in ("dep", "arr"):
        a, b = dst.setdefault(side, {}), src.get(side) or {}
        for k, v in b.items():
            if k == "actual":
                a[k] = bool(a.get(k) or v)
            elif blank(a.get(k)) and not blank(v):
                a[k] = v
    for k in keys:
        if blank(dst.get(k)) and not blank(src.get(k)):
            dst[k] = src[k]
    for k in ("departed", "landed"):
        dst[k] = bool(dst.get(k) or src.get(k))


def skeleton(base):
    """A leg nobody has checked yet: every contract field present, nothing known."""
    return dict(base, checked_at=None, source=None, status=None, status_detail=None,
                canceled=False, diverted_to=None, phase=None, departed=False, landed=False,
                dep={"terminal": None, "gate": None, "sched": None, "est": None, "actual": False},
                arr={"terminal": None, "gate": None, "baggage": None, "sched": None, "est": None,
                     "actual": False},
                delay_dep_min=None, delay_arr_min=None, aircraft=None, aircraft_code=None,
                source_note=None, inbound=None, route_ok=None, route_seen=None, fetch_failed=False,
                cancel_seen=0, events=[], updated_at=None)


def mark_failed(doc, now_dt):
    """A lookup failed: keep the values; flag fetch_failed once they are FETCH_GRACE old."""
    last = parse_iso(doc.get("checked_at"))
    doc["fetch_failed"] = bool(doc.get("fetch_failed") or not last or now_dt - last >= FETCH_GRACE)
    return doc


def best(doc, side):
    s = doc.get(side) or {}
    return s.get("est") or s.get("sched")


def diff(old, new, now):
    """Plain-language changes between two good readings of the same leg.

    Time moves are measured from the last time announced (ev_base), so slow
    drift adds up to an event instead of slipping under the threshold.
    """
    ev = []
    f, t = new["from"], new["to"]

    def change(side, key, label, first=True):
        o, n = (old.get(side) or {}).get(key), (new.get(side) or {}).get(key)
        if blank(n) or o == n:
            return
        if blank(o):
            if first:
                ev.append(f"{label} {n}")
        else:
            ev.append(f"{label} {o} → {n}")

    change("dep", "terminal", f"{f} terminal", first=False)
    change("dep", "gate", f"{f} gate")
    change("arr", "terminal", f"{t} terminal", first=False)
    change("arr", "gate", f"{t} gate")
    change("arr", "baggage", f"{t} bag claim")

    base = dict(old.get("ev_base") or {})
    for side, label, ap, flag, verb in (("dep", "Departure", f, "departed", "Departed"),
                                        ("arr", "Arrival", t, "landed", "Landed at")):
        cur, was = best(new, side), base.get(side) or best(old, side)
        if new.get(flag) and not old.get(flag):
            ev.append(f"{verb} {ap} {clock(cur, ap)}" if cur else f"{verb} {ap}")
        elif cur and was and not old.get(flag):
            m = mins_between(was, cur)
            if m is not None and abs(m) >= MOVE_MIN:
                ev.append(f"{label} now {clock(cur, ap)} ({signed(m)})")
            else:
                cur = was  # below the threshold: keep measuring from the old base
        if cur:
            base[side] = cur
    new["ev_base"] = base

    if new.get("canceled") and not old.get("canceled"):
        ev.append("Canceled")
    if old.get("canceled") and not new.get("canceled"):
        ev.append("No longer listed as canceled")
    if new.get("diverted_to") and new.get("diverted_to") != old.get("diverted_to"):
        ev.append(f"Diverted to {new['diverted_to']}")
    oc, nc = base_code(old.get("aircraft_code")), new.get("aircraft_code")
    if oc and nc and oc != nc:
        ev.append(f"Aircraft now {new.get('aircraft') or nc}")
    return [{"at": now, "text": e} for e in ev]


def fingerprint(doc):
    """The values whose change bumps updated_at."""
    keys = ("status", "canceled", "diverted_to", "departed", "landed", "dep", "arr",
            "route_ok", "route_seen", "aircraft_code")
    return json.dumps({k: doc.get(k) for k in keys}, sort_keys=True)


def skip_reason(leg, old, now):
    """Why this leg is not queried this run (its last reading is copied forward)."""
    today = now.astimezone(tz_of(leg["from"])).date()
    if abs((date.fromisoformat(leg["date"]) - today).days) > FS_DAYS:
        return "outside the 3-day tracker range"
    arr = old.get("arr") or {}
    reached = parse_iso(arr.get("est") or arr.get("sched"))
    if old.get("route_ok") and old.get("landed") and arr.get("actual") and reached \
            and now - reached > FINAL_AFTER:
        return "finished"
    return None


def direct(name, fn, *args):
    """The default ask hook: every lookup goes straight to its source."""
    return fn(*args)


def check_leg(leg, old, now_dt, fetch=True, ask=None):
    """One leg's status doc. old is that leg's doc from the previous run (or {}).

    ask(name, fn, *args) makes each lookup (name: flightstats|flightview|inbound),
    so a caller can pace them (run.py's minute loop backs off a failing source).
    A skipped source answers ('fail', why); a skipped inbound lookup answers None.
    Returns (doc, notes, outcome) with outcome in checked|carried|failed|route.
    """
    ask = ask or direct
    now = iso_utc(now_dt)
    base = {"flight": norm_flight(leg["flight"]), "date": leg["date"],
            "from": leg["from"], "to": leg["to"]}
    # A previous doc only counts if it describes this same planned flight.
    old = copy.deepcopy(old) if old and all(old.get(k) == v for k, v in base.items()) else {}
    carried = dict(skeleton(base), **old)  # older docs may lack fields the contract lists
    carried["events"] = carried.get("events") or []

    # A leg not due for a lookup is never "failed": its last reading is all there is.
    if skip_reason(leg, old, now_dt):
        carried["fetch_failed"] = False
        return carried, [], "carried"
    if not fetch:
        return mark_failed(carried, now_dt), [f"{leg['id']}: not checked (time budget used up)"], "failed"

    fs_kind, fs_val = ask("flightstats", fs_check, leg)
    fv_kind, fv_val = ask("flightview", fv_check, leg)
    notes = [f"{leg['id']}: {v}" for k, v in ((fs_kind, fs_val), (fv_kind, fv_val)) if k == "fail"]

    if "ok" not in (fs_kind, fv_kind):
        kinds = {fs_kind, fv_kind}
        if "other" in kinds or kinds == {"none"}:
            # The number flies another route (or not at all) that day: flag it and
            # keep the planned values. Last good values stay for the record only.
            seen = fs_val if fs_kind == "other" else fv_val if fv_kind == "other" else None
            doc = carried
            ev = []
            if old.get("route_ok") is not False:
                ev.append({"at": now, "text": f"Flight number now listed as {seen}" if seen
                           else "Flight number not listed on this date"})
            if doc.get("route_ok") is not False or doc.get("route_seen") != seen:
                doc["updated_at"] = now
            doc.update(route_ok=False, route_seen=seen, fetch_failed=False, checked_at=now)
            doc["events"] = (ev + doc["events"])[:MAX_EVENTS]
            notes.append(f"{leg['id']}: route mismatch, seen {seen or 'nothing'}")
            return doc, notes, "route"
        # Every source failed, or one failed and the other found nothing: unknown.
        return mark_failed(carried, now_dt), notes, "failed"

    reading = fs_val if fs_kind == "ok" else fv_val
    if fs_kind == "ok" and fv_kind == "ok":
        fill(reading, fv_val)          # FlightView fills what FlightStats left empty
    reading.pop("from", None)
    reading.pop("to", None)
    doc = dict(base, **reading)
    good_old = old if old.get("route_ok") else {}
    if good_old:
        fill(doc, good_old, CARRY_FIELDS)  # carry forward what this source omitted
    # Delays the source did not state come from the times this doc now holds.
    for side, key in (("dep", "delay_dep_min"), ("arr", "delay_arr_min")):
        if doc.get(key) is None:
            doc[key] = late(parse_iso(doc[side].get("sched")), parse_iso(doc[side].get("est")))

    # Canceled only counts once two consecutive checks agree.
    raw_cancel = doc.pop("canceled")
    seen = (old.get("cancel_seen") or 0) + 1 if raw_cancel else 0
    doc["cancel_seen"] = seen
    doc["canceled"] = seen >= 2
    if raw_cancel and seen < 2:
        doc["status"] = good_old.get("status")
        doc["source_note"] = "Listed as canceled; confirming on the next check"

    # The inbound aircraft matters only in the hours before departure.
    dep_at = parse_iso(best(doc, "dep"))
    inb = doc.get("inbound")
    if inb and not doc.get("departed") and dep_at and now_dt < dep_at <= now_dt + INBOUND_AHEAD:
        got = ask("inbound", fs_inbound, inb, leg)
        if got is None:  # not looked up this time: keep what the last lookup added
            was = good_old.get("inbound") or {}
            got = dict(was, **inb) if was.get("flight") == inb.get("flight") else inb
        doc["inbound"] = got

    doc.update(route_ok=True, route_seen=None, fetch_failed=False, checked_at=now)
    if good_old:
        ev = diff(good_old, doc, now)
    else:
        ev = [{"at": now, "text": f"Route confirmed {leg['from']}→{leg['to']}"}] \
            if old.get("route_ok") is False else []
        doc["ev_base"] = {s: best(doc, s) for s in ("dep", "arr") if best(doc, s)}
    doc["events"] = (ev + (old.get("events") or []))[:MAX_EVENTS]
    doc["updated_at"] = now if fingerprint(doc) != fingerprint(old) else old.get("updated_at") or now
    return doc, notes, "checked"


def update_legs(legs, prev_legs, now_dt, deadline=None, ask=None):
    """Check every planned leg. Returns (legs_doc, notes, counts).

    prev_legs is the previous status's legs map. deadline (time.monotonic())
    stops new lookups so a slow source cannot push the run past its timeout;
    legs not reached keep their last values with fetch_failed. ask: see check_leg.
    """
    out, notes = {}, []
    counts = {"checked": 0, "carried": 0, "failed": 0, "route": 0}
    for leg in legs:
        lid = leg["id"]
        ok_time = deadline is None or time.monotonic() < deadline
        old = (prev_legs or {}).get(lid) or {}
        try:
            doc, n, kind = check_leg(leg, old, now_dt, fetch=ok_time, ask=ask)
        except Exception as e:  # one leg never stops the rest: keep its last doc
            base = {k: leg.get(k) for k in ("flight", "date", "from", "to")}
            try:
                base["flight"] = norm_flight(base["flight"])
            except ValueError:
                pass
            same = old and all(old.get(k) == v for k, v in base.items())
            doc = mark_failed(dict(skeleton(base), **(copy.deepcopy(old) if same else {})), now_dt)
            doc["events"] = doc.get("events") or []
            n, kind = [f"{lid}: error {type(e).__name__}: {e}"], "failed"
        out[lid] = doc
        notes += n
        counts[kind] += 1
    return out, notes, counts


# ---------- CLI ----------

def load_legs(path):
    legs = json.load(open(path))
    return legs.get("legs", []) if isinstance(legs, dict) else legs


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--legs", required=True, help="planned legs JSON")
    ap.add_argument("--prev", "--state", dest="prev", help="previous status JSON, for change events")
    ap.add_argument("--out", help="write the legs map here")
    ap.add_argument("--now", help="ISO time override (decides which legs are in range)")
    a = ap.parse_args()

    prev = {}
    if a.prev:
        try:
            prev = json.load(open(a.prev)).get("legs", {})
        except (OSError, ValueError):
            prev = {}
    now_dt = parse_iso(a.now) if a.now else datetime.now(timezone.utc)
    legs_doc, notes, counts = update_legs(load_legs(a.legs), prev, now_dt)
    doc = {"checked_at": iso_utc(now_dt), "legs": legs_doc, "notes": notes}
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(doc, fh, indent=1, ensure_ascii=False)
    for lid, d in legs_doc.items():
        if d.get("route_ok") is False:
            state = f"ROUTE MISMATCH (seen {d.get('route_seen')})"
        else:
            state = f"{d.get('status')} dep {d.get('dep', {}).get('gate')} arr {d.get('arr', {}).get('gate')}"
        flags = " FETCH_FAILED" if d.get("fetch_failed") else ""
        print(f"{lid}: {d['flight']} {d['date']} {d['from']}-{d['to']} {state}{flags} "
              f"src={d.get('source')} events={len(d.get('events') or [])}")
    for n in notes:
        print("  note:", n)
    print("counts:", counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
