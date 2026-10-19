#!/usr/bin/env python3
"""One updater run: check flights and conditions, then write and seal status.bin.

  python3 updater/run.py                 run only inside a travel window
  python3 updater/run.py --slow          ...or on a slow tick (hourly) in the trip fortnight
  python3 updater/run.py --force         run now, whatever the clock says
  python3 updater/run.py --loop          every minute through a hot window, publishing each time
  python3 updater/run.py --plan [--now ISO]   print the windows and the mode, then exit (no network)
  python3 updater/run.py --mode          print hot|travel|slow|idle (the workflow's decide step)
  python3 updater/run.py --check FILE    validate a status .json or .bin against schema v1

Steps:
  1. Planned legs: docs/data/trip.bin (opened with tools/tripcrypt.mjs), else
     trip/flights.json. --legs FILE overrides them for testing.
  2. Is a run due? Travel window per direction: first departure -12 h to last
     arrival +3 h (an unknown time means that whole local day, +3 h), the same
     span the app uses. Outside it nothing touches the network unless --slow
     and the clock is in the first --slow-minutes of a UTC hour between
     3 days before the first leg and 3 days after the last.
     Inside a travel window, each leg's hot window (3 h before departure until
     takeoff; hot_window below) is when --loop checks every minute.
  3. Previous status: updater/state/prev_status.json and the live branch's
     status.bin; the newer checked_at wins. Either may be missing.
  4. Flights (flight_status.update_legs) and, at the same time, conditions
     (updater/conditions.py build(prev, legs, now) -> {airports, traffic,
     transit}, when that module exists). Anything that fails keeps the
     previous values and adds a run note.
  5. Assemble schema v1 with run.cadence_s (60 | 600 | 3600: how often the cloud
     checks now) and run.hot_until, validate it, write updater/out/status.json,
     seal it to updater/out/status.bin and keep a plaintext copy in updater/state.
updater/publish.sh then pushes status.bin to the live branch (--loop runs it
itself after every iteration).

Logs in GitHub Actions are public on a public repo, so there they carry counts
only: no flight numbers, airports, times or notes.
Exit status: 0 when status.bin was written or the run was not due; 1 otherwise.
"""
import argparse
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # no __pycache__ in the repo
import flight_status as fs  # noqa: E402  (needs the path above)

TRIPCRYPT = ROOT / "tools" / "tripcrypt.mjs"
TRIP_BIN = ROOT / "docs" / "data" / "trip.bin"
TRIP_JSON = ROOT / "trip" / "flights.json"
STATE = HERE / "state"
OUT = HERE / "out"
# Same repo and branch the app reads (app/src/core.js N.cfg).
REPO = os.environ.get("TRIPBOOK_REPO") or os.environ.get("GITHUB_REPOSITORY") or "5j4d7mkd4j-byte/tripbook"
BRANCH = os.environ.get("PUBLISH_BRANCH", "live")

PUBLIC = os.environ.get("GITHUB_ACTIONS") == "true"
FLIGHTS_BUDGET = 240        # seconds before no new flight lookups start (job timeout is 8 min)
CONDITIONS_BUDGET = 150     # seconds conditions may run alongside the flights
SLOW_PAD = timedelta(days=3)
DELAY_LOOKAHEAD = timedelta(hours=8)   # after a planned window ends, check the live status for delays
MAX_NOTES = 40
# How often the cloud checks (run.cadence_s): every minute in a hot window (--loop),
# every 10 min in a travel window, hourly on the other days of the trip fortnight.
CADENCE = {"hot": 60, "travel": 600, "slow": 3600, "idle": 3600}
SLOW_TICK_LIMIT = 65        # --skip-if-fresh on a slow tick: an hourly Actions run plus slack

# The minute loop (--loop): one Actions job, so it stays inside the 360 min job limit.
LOOP_MINUTES = 330          # default --max-minutes
LOOP_TAIL = timedelta(minutes=2)       # keep checking this long after a hot window ends
ITER_FLIGHTS_S = 35         # no new flight lookups after this much of an iteration (scaled by --interval)
ITER_COND_WAIT_S = 25       # conditions may hold an iteration this long, then wait for the next
LEG_EVERY = timedelta(minutes=10)      # legs not hot: the travel-window cadence
COND_EVERY = timedelta(minutes=10)
INBOUND_EVERY = timedelta(minutes=5)
REST_AFTER = 2                         # failures in a row before a source rests
REST_FOR = timedelta(minutes=15)
REST_TRY = timedelta(minutes=3)        # one try per this while resting
REMOTE_EVERY = timedelta(minutes=5)    # every lookup failing: read the published status this often
SLACK = timedelta(seconds=5)           # iterations start a little either side of the minute


def say(msg, detail=""):
    """Progress line on stderr. detail (flight specifics) never reaches public CI logs."""
    print(f"{msg} {detail}".rstrip() if detail and not PUBLIC else msg, file=sys.stderr, flush=True)


# ---------- encryption (tools/tripcrypt.mjs does the crypto) ----------

def node():
    return os.environ.get("NODE") or shutil.which("node") or "node"


def tc_open(path):
    """Decrypt a sealed file to a dict (plaintext stays in memory)."""
    r = subprocess.run([node(), str(TRIPCRYPT), "open", str(path)], capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise RuntimeError(first_line(r.stderr) or "tripcrypt open failed")
    return json.loads(r.stdout)


def tc_seal(src, dst):
    r = subprocess.run([node(), str(TRIPCRYPT), "seal", str(src), str(dst)], capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise RuntimeError(first_line(r.stderr) or "tripcrypt seal failed")


def first_line(s):
    # Node prints the stack after the message; the message is enough and holds no secrets.
    for line in (s or "").splitlines():
        if line.strip().startswith("Error:"):
            return line.strip()
    return (s or "").strip().splitlines()[0] if (s or "").strip() else ""


# ---------- inputs ----------

def load_legs(override=None):
    """Planned legs in trip order, or raise."""
    if override:
        doc = json.load(open(override))
    elif TRIP_BIN.exists():
        doc = tc_open(TRIP_BIN)
    elif TRIP_JSON.exists():
        doc = json.load(open(TRIP_JSON))
    else:
        raise RuntimeError("no docs/data/trip.bin or trip/flights.json")
    legs = doc.get("legs") if isinstance(doc, dict) else doc
    out = []
    for leg in legs or []:
        if not all(leg.get(k) for k in ("id", "flight", "date", "from", "to")):
            raise RuntimeError("a leg is missing id, flight, date, from or to")
        out.append(dict(leg, dir=leg.get("dir") or "out"))
    if not out:
        raise RuntimeError("no legs")
    return out


def valid_status(doc):
    return isinstance(doc, dict) and doc.get("schema") == 1 and isinstance(doc.get("legs"), dict)


def load_local(path):
    try:
        doc = json.load(open(path))
        return doc if valid_status(doc) else None
    except (OSError, ValueError):
        return None


def in_this_repo():
    """True only when ROOT itself is a git checkout (never act on a parent repo)."""
    try:
        r = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and Path(r.stdout.strip()).resolve() == ROOT
    except (OSError, subprocess.TimeoutExpired):
        return False


def fetch_remote_bin(dst):
    """Copy the published status.bin to dst. Returns how, or None when there is none."""
    # 1. git: works for private repos (Actions checkout leaves credentials) and is never cached.
    if in_this_repo():
        # No terminal under launchd/Actions: fail fast instead of waiting on a credential prompt.
        f = subprocess.run(["git", "-C", str(ROOT), "fetch", "-q", "--depth=1", "origin",
                            f"refs/heads/{BRANCH}"], capture_output=True, timeout=60,
                           env=dict(os.environ, GIT_TERMINAL_PROMPT="0"))
        if f.returncode == 0:
            s = subprocess.run(["git", "-C", str(ROOT), "show", "FETCH_HEAD:status.bin"],
                               capture_output=True, timeout=30)
            if s.returncode == 0 and s.stdout[:4] == b"NYC1":
                dst.write_bytes(s.stdout)
                return "git"
    # 2. The contents API and 3. raw.githubusercontent (cached up to 5 min): public repos.
    owner_repo = REPO
    for url, hdr in ((f"https://api.github.com/repos/{owner_repo}/contents/status.bin?ref={BRANCH}",
                      ["-H", "Accept: application/vnd.github.raw"]),
                     (f"https://raw.githubusercontent.com/{owner_repo}/{BRANCH}/status.bin", [])):
        tmp = dst.with_suffix(".part")
        r = subprocess.run(["curl", "-s", "-f", "-L", "-m", "20", *hdr, "-o", str(tmp), url],
                           capture_output=True, timeout=40)
        if r.returncode == 0 and tmp.exists() and tmp.read_bytes()[:4] == b"NYC1":
            tmp.replace(dst)
            return "api" if "api.github" in url else "raw"
        tmp.unlink(missing_ok=True)
    return None


def load_remote():
    """(status doc or None, note)."""
    STATE.mkdir(parents=True, exist_ok=True)
    dst = STATE / "remote_status.bin"
    try:
        how = fetch_remote_bin(dst)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, f"previous status: {type(e).__name__}"
    if not how:
        return None, "previous status: none published yet"
    try:
        doc = tc_open(dst)
    except Exception as e:
        return None, f"previous status: could not open ({e})"
    return (doc, None) if valid_status(doc) else (None, "previous status: not schema 1")


def actions_age(remote, now):
    """Minutes since a good GitHub Actions run published, else None.

    The Mac backup (--skip-if-fresh) stands down only for Actions. Skipping
    after its own run would halve its rate whenever Actions is down or blocked.
    """
    run_ = (remote or {}).get("run") or {}
    at = fs.parse_iso((remote or {}).get("checked_at"))
    if not (run_.get("ok") and run_.get("source") == "actions" and at):
        return None
    age = (now - at).total_seconds() / 60
    return age if age >= 0 else None


def newer(a, b):
    """The status with the later checked_at."""
    if not a or not b:
        return a or b
    return a if (fs.parse_iso(a.get("checked_at")) or datetime.min.replace(tzinfo=timezone.utc)) >= \
        (fs.parse_iso(b.get("checked_at")) or datetime.min.replace(tzinfo=timezone.utc)) else b


# ---------- when to run ----------

def day_start(d, ap):
    return datetime.combine(date.fromisoformat(d), dtime(0), tzinfo=fs.tz_of(ap)).astimezone(timezone.utc)


def windows(legs, prev):
    """{dir: (start, end)} in UTC. A good live reading can widen a window (delays)."""
    live = (prev or {}).get("legs") or {}
    out = {}
    for d in dict.fromkeys(l["dir"] for l in legs):
        group = [l for l in legs if l["dir"] == d]
        first, last = group[0], group[-1]

        def times(leg, side, planned):
            s = live.get(leg["id"]) or {}
            ok = s.get("route_ok") is True and not s.get("fetch_failed") and \
                s.get("flight") == fs.norm_flight(leg["flight"]) and s.get("date") == leg["date"]
            sd = (s.get(side) or {}) if ok else {}
            return [t for t in (fs.parse_iso(leg.get(planned)), fs.parse_iso(sd.get("sched")),
                                fs.parse_iso(sd.get("est"))) if t]

        day = day_start(first["date"], first["from"])
        deps, arrs = times(first, "dep", "dep"), times(last, "arr", "arr")
        start = min(deps) - timedelta(hours=12) if deps else day
        end = max(arrs) + timedelta(hours=3) if arrs else day + timedelta(hours=27)
        out[d] = (start, end)
    return out


def in_fortnight(now, legs):
    """From 3 days before the first leg to 3 days after the last (UTC dates)."""
    first = min(date.fromisoformat(l["date"]) for l in legs) - SLOW_PAD
    last = max(date.fromisoformat(l["date"]) for l in legs) + SLOW_PAD
    return first <= now.date() <= last


def slow_due(now, legs, slow_minutes):
    """A slow tick: the first slow_minutes of a UTC hour, in the trip fortnight."""
    return in_fortnight(now, legs) and now.minute < slow_minutes


def decide(now, legs, prev, args):
    """(due, reason, wants_live): wants_live means a delay could have moved the window."""
    if args.force:
        return True, "forced", False
    win = windows(legs, prev)
    for d, (a, b) in win.items():
        if a <= now <= b:
            return True, f"{d} travel window", False
    if args.slow and slow_due(now, legs, args.slow_minutes):
        return True, "slow tick", False
    late = any(b < now <= b + DELAY_LOOKAHEAD for a, b in win.values())
    return False, "outside the travel windows", late


# ---------- hot window ----------
# From three hours before a departure until takeoff the cloud checks every minute.
# The same rule as N.hotWindow in app/src/model.js (app/CONTRACT.md), so the two agree:
#   start = earlier of scheduled/estimated departure - 3 h
#   end   = once departed: takeoff + 20 min (dep.est when dep.actual, else the newest
#           "Departed" event, else now); before that: later of scheduled/estimated + 45 min,
#           so a delay that keeps moving keeps it hot. Never past scheduled + 12 h.
# The status leg counts only when the app would show it (live_leg); else the planned
# departure. Canceled legs and legs with no departure time are never hot. Windows that
# overlap or touch merge.
HOT_BEFORE = timedelta(hours=3)
HOT_AFTER_OFF = timedelta(minutes=20)
HOT_AFTER_DEP = timedelta(minutes=45)
HOT_CAP = timedelta(hours=12)
HOT_LEAD = timedelta(minutes=15)    # --mode/--loop: a window this close counts, and the loop waits
AIR = re.compile(r"\b(in air|airborne|climb|cruis|descen|approach|landed|arriv)", re.I)  # model.js AIR


def live_leg(s):
    """The status leg when the app treats it as live (model.js merge), else {}."""
    s = s if isinstance(s, dict) else {}
    return s if s.get("route_ok") is not False and not s.get("fetch_failed") and s.get("status") else {}


def leg_hot_window(leg, s, now):
    """(start, end) of one planned leg's hot window in UTC, or None. s: its status leg."""
    events = (s.get("events") or []) if isinstance(s, dict) else []
    s = live_leg(s)
    sd = s.get("dep") or {}
    sched = fs.parse_iso(sd.get("sched")) or fs.parse_iso(leg.get("dep"))
    est = fs.parse_iso(sd.get("est")) or sched
    if s.get("canceled") or not sched:
        return None
    if s.get("departed") or sd.get("actual") or AIR.search(s.get("phase") or ""):
        # dep.actual is a flag: when set, dep.est holds the actual departure time.
        seen = next((e for e in events if isinstance(e, dict) and re.match(r"Departed\b", str(e.get("text") or ""))),
                    None)
        off = (fs.parse_iso(sd.get("est")) if sd.get("actual") else None) \
            or (fs.parse_iso(seen.get("at")) if seen else None) or now
        end = off + HOT_AFTER_OFF
    else:
        end = max(sched, est) + HOT_AFTER_DEP
    return min(sched, est) - HOT_BEFORE, min(end, sched + HOT_CAP)


def leg_windows(legs, prev, now):
    """{leg id: (start, end) or None}."""
    st = (prev or {}).get("legs") or {}
    return {l["id"]: leg_hot_window(l, st.get(l["id"]), now) for l in legs}


def hot_spans(legs, prev, now):
    """Every leg's window, merged where they overlap: [(start, end)] in time order."""
    out = []
    for a, b in sorted(w for w in leg_windows(legs, prev, now).values() if w):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def hot_window(legs, prev, now, lead=timedelta(0)):
    """The merged hot window holding now (or starting within lead of now), else None."""
    return next(((a, b) for a, b in hot_spans(legs, prev, now) if a - lead <= now <= b), None)


def mode_at(now, legs, prev, lead=timedelta(0)):
    """hot | travel | slow | idle: the cadence the clock calls for."""
    if hot_window(legs, prev, now, lead):
        return "hot"
    if any(a <= now <= b for a, b in windows(legs, prev).values()):
        return "travel"
    return "slow" if in_fortnight(now, legs) else "idle"


def pace(doc, legs, now, looping):
    """run.cadence_s and run.hot_until for a status about to be written, from its own legs.
    Only the loop checks every minute; a single run in a hot window still says 10 min."""
    win = hot_window(legs, doc, now)
    mode = mode_at(now, legs, doc)
    cadence = CADENCE["hot"] if win and looping else CADENCE["travel"] if mode in ("hot", "travel") \
        else CADENCE[mode]
    return cadence, fs.iso_utc(win[1]) if win else None


# ---------- conditions ----------

def legs_for_conditions(legs, prev):
    """Planned legs with the last good estimates as plain ISO strings in dep/arr,
    so forecasts follow a delayed flight. A diversion adds that airport."""
    live = (prev or {}).get("legs") or {}
    out = []
    for leg in legs:
        s = live.get(leg["id"]) or {}
        good = s.get("route_ok") is True and not s.get("fetch_failed")
        leg = dict(leg)
        for side in ("dep", "arr"):
            v = (s.get(side) or {}) if good else {}
            leg[side] = v.get("est") or v.get("sched") or leg.get(side)
        if good and s.get("diverted_to"):
            leg["diverted_to"] = s["diverted_to"]
        out.append(leg)
    return out


def start_conditions(prev, legs, now):
    """Run conditions.build in a thread so a slow source cannot hold up the flights."""
    box = {}
    if not (HERE / "conditions.py").exists():
        box["missing"] = True  # not written yet: a note, not a failed run
        return None, box

    def work():
        try:
            import conditions
            box["doc"] = conditions.build(prev or {}, legs_for_conditions(legs, prev), now)
        except BaseException as e:  # noqa: BLE001  any failure keeps the previous values
            box["err"] = f"{type(e).__name__}: {e}"[:200]

    t = threading.Thread(target=work, name="conditions", daemon=True)
    t.start()
    return t, box


DEFAULTS = {"airports": {}, "traffic": {}, "transit": {"alerts": []}}


def merge_conditions(box, prev):
    """airports, traffic, transit: the new values where good, else the previous ones.
    Returns (keys, kept, notes): conditions' own notes go into run.notes."""
    doc = box.get("doc") if isinstance(box.get("doc"), dict) else {}
    notes = [str(n) for n in doc.get("notes") or []] if isinstance(doc.get("notes"), list) else []
    out, kept = {}, []
    for key, default in DEFAULTS.items():
        val = doc.get(key)
        if isinstance(val, dict):
            out[key] = val
        else:
            p = (prev or {}).get(key)
            out[key] = p if isinstance(p, dict) else json.loads(json.dumps(default))
            kept.append(key)
    return out, kept, notes


def conditions_result(box, prev):
    """(keys, run notes, ok) once the conditions thread is done (or given up on)."""
    cond, kept, cond_notes = merge_conditions(box, prev)
    notes = [f"conditions: {n}" for n in cond_notes]
    if box.get("missing"):
        notes.append("conditions: updater/conditions.py not present; kept the previous values")
    elif box.get("err"):
        notes.append(f"conditions: {box['err']}; kept the previous values")
    elif kept:
        notes.append(f"conditions: no {', '.join(kept)} returned; kept the previous values")
    return cond, notes, not box.get("err")


# ---------- schema ----------

LEG_KEYS = ("flight", "date", "from", "to", "events", "route_ok", "fetch_failed", "canceled", "cancel_seen")


def check_schema(doc):
    """Problems with a status bundle (empty when it matches schema v1 in app/CONTRACT.md)."""
    p = []
    if not isinstance(doc, dict):
        return ["not an object"]
    if doc.get("schema") != 1:
        p.append("schema is not 1")
    if not fs.parse_iso(doc.get("checked_at")):
        p.append("checked_at missing")
    run = doc.get("run")
    if not isinstance(run, dict) or run.get("source") not in ("actions", "mac") \
            or not isinstance(run.get("ok"), bool) or not isinstance(run.get("notes"), list) \
            or not all(isinstance(n, str) for n in run.get("notes") or []):
        p.append("run must be {source: actions|mac, ok: bool, notes: [str]}")
    elif "cadence_s" in run and run["cadence_s"] not in CADENCE.values():
        p.append("run.cadence_s must be 60, 600 or 3600")
    elif run.get("hot_until") is not None and not fs.parse_iso(run["hot_until"]):
        p.append("run.hot_until must be an ISO time or null")
    legs = doc.get("legs")
    if not isinstance(legs, dict) or not legs:
        p.append("legs missing")
        legs = {}
    for lid, s in legs.items():
        if not isinstance(s, dict):
            p.append(f"{lid}: not an object")
            continue
        for k in LEG_KEYS:
            if k not in s:
                p.append(f"{lid}: {k} missing")
        if s.get("route_ok") not in (True, False, None):
            p.append(f"{lid}: route_ok must be true, false or null")
        for k in ("fetch_failed", "canceled"):
            if k in s and not isinstance(s[k], bool):
                p.append(f"{lid}: {k} must be a boolean")
        if not isinstance(s.get("cancel_seen", 0), int):
            p.append(f"{lid}: cancel_seen must be an integer")
        if s.get("canceled") and (s.get("cancel_seen") or 0) < 2:
            p.append(f"{lid}: canceled without two sightings")
        ev = s.get("events")
        if not isinstance(ev, list) or len(ev) > fs.MAX_EVENTS or \
                not all(isinstance(e, dict) and fs.parse_iso(e.get("at")) and isinstance(e.get("text"), str)
                        for e in ev):
            p.append(f"{lid}: events must be at most {fs.MAX_EVENTS} {{at, text}}")
        if s.get("status"):  # a checked leg carries the full reading
            for side, keys in (("dep", ("terminal", "gate", "sched", "est", "actual")),
                               ("arr", ("terminal", "gate", "baggage", "sched", "est", "actual"))):
                v = s.get(side)
                if not isinstance(v, dict) or any(k not in v for k in keys):
                    p.append(f"{lid}: {side} must have {', '.join(keys)}")
            for k in ("checked_at", "updated_at"):
                if not fs.parse_iso(s.get(k)):
                    p.append(f"{lid}: {k} missing")
        inb = s.get("inbound")
        if inb is not None and not (isinstance(inb, dict) and inb.get("flight")):
            p.append(f"{lid}: inbound must be null or {{flight, from, date}}")
    for key in ("airports", "traffic", "transit"):
        if not isinstance(doc.get(key), dict):
            p.append(f"{key} must be an object")
    if isinstance(doc.get("transit"), dict) and not isinstance(doc["transit"].get("alerts"), list):
        p.append("transit.alerts must be a list")
    for code, a in (doc.get("airports") or {}).items():
        if not isinstance(a, dict):
            p.append(f"airports.{code} must be an object")
        elif (a.get("faa") or {}).get("status") not in (None, "normal", "delay", "ground_stop", "closed"):
            p.append(f"airports.{code}.faa.status is not normal|delay|ground_stop|closed")
    return p


# ---------- output ----------

def write_json(path, doc, indent=1):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as fh:
        json.dump(doc, fh, indent=indent, ensure_ascii=False)
    os.replace(tmp, path)


def seal_out(doc, out_dir):
    """status.json, then status.bin, opened again to prove it round-trips."""
    js, binf = out_dir / "status.json", out_dir / "status.bin"
    write_json(js, doc)
    tmp = out_dir / "status.bin.tmp"
    tc_seal(js, tmp)
    if tc_open(tmp).get("checked_at") != doc["checked_at"]:
        raise RuntimeError("sealed status did not round-trip")
    os.replace(tmp, binf)
    return binf


def assemble(prev, now, source, legs_doc, counts, notes, cond, cond_ok, legs, looping):
    """The schema v1 bundle, paced from its own legs (run.cadence_s, run.hot_until)."""
    # checked_at says when flight data was last good. If every lookup failed it
    # stays put, so the app shows the data as old and the Mac backup steps in.
    tried = counts["checked"] + counts["route"] + counts["failed"]
    flights_ok = counts["checked"] + counts["route"] > 0 or tried == 0
    checked_at = fs.iso_utc(now) if flights_ok or not prev.get("checked_at") else prev["checked_at"]
    doc = {
        "schema": 1,
        "checked_at": checked_at,
        "run": {"source": source, "ok": counts["failed"] == 0 and cond_ok,
                "notes": list(dict.fromkeys(notes))[:MAX_NOTES]},
        "legs": legs_doc,
        **cond,
    }
    doc["run"]["cadence_s"], doc["run"]["hot_until"] = pace(doc, legs, now, looping)
    return doc


def write_status(doc, out_dir, state_file):
    """Validate, seal to out_dir/status.bin and keep the plaintext as the next previous
    status. Returns the status.bin path; raises ValueError listing schema problems."""
    problems = check_schema(doc)
    if problems:
        raise ValueError(problems)
    binf = seal_out(doc, out_dir)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    write_json(state_file, doc)
    return binf


def publish():
    """updater/publish.sh pushes updater/out/status.bin to the live branch. True when it did."""
    try:
        r = subprocess.run(["bash", str(HERE / "publish.sh")], capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def check_file(path):
    path = Path(path)
    doc = tc_open(path) if path.suffix == ".bin" else json.load(open(path))
    problems = check_schema(doc)
    for p in problems:
        print("problem:", p)
    legs = doc.get("legs") or {}
    print(f"schema {doc.get('schema')}, checked_at {doc.get('checked_at')}, run {json.dumps(doc.get('run'))}")
    for lid, s in legs.items():
        state = "route mismatch" if s.get("route_ok") is False else (s.get("status") or "not checked yet")
        print(f"  {lid}: {s.get('flight')} {s.get('from')}-{s.get('to')} {state}"
              f"{' fetch_failed' if s.get('fetch_failed') else ''}, {len(s.get('events') or [])} events")
    print(f"  airports {sorted((doc.get('airports') or {}).keys())}, traffic {sorted((doc.get('traffic') or {}).keys())}, "
          f"transit alerts {len((doc.get('transit') or {}).get('alerts') or [])}")
    print("OK" if not problems else f"{len(problems)} problem(s)")
    return 0 if not problems else 1


# ---------- minute loop ----------

class Gate:
    """Paces the minute loop's lookups (flight_status.check_leg's ask hook).

    A source that failed REST_AFTER times in a row (403, 429, 5xx, no connection)
    rests for REST_FOR: one try every REST_TRY, which every leg of that iteration
    may use, and a success ends the rest. The inbound aircraft is looked up at most
    every INBOUND_EVERY per leg, and not while FlightStats rests. A skipped source
    reads as a failure, so the leg keeps its last good values under the usual
    fetch_failed / FETCH_GRACE rules. Set now before each iteration.
    """

    def __init__(self):
        self.now = None
        self.fails, self.rest_until, self.next_try, self.open_at, self.inbound_at = {}, {}, {}, {}, {}

    def resting(self, name):
        return self.now < self.rest_until.get(name, self.now)

    def __call__(self, name, fn, *args):
        now = self.now
        if name == "inbound":
            lid = args[-1].get("id")
            last = self.inbound_at.get(lid)
            if self.resting("flightstats") or (last and now - last < INBOUND_EVERY - SLACK):
                return None
            self.inbound_at[lid] = now
            return fn(*args)
        if self.resting(name) and self.open_at.get(name) != now:
            if now < self.next_try.get(name, now):
                return "fail", f"{name}: resting after repeated errors"
            self.open_at[name], self.next_try[name] = now, now + REST_TRY - SLACK
        kind, val = fn(*args)
        if kind != "fail":
            self.fails[name] = 0
            self.rest_until.pop(name, None)
        else:
            self.fails[name] = self.fails.get(name, 0) + 1
            if self.fails[name] >= REST_AFTER and not self.resting(name):
                self.rest_until[name] = now + REST_FOR
                self.next_try[name] = now + REST_TRY - SLACK
                self.open_at.pop(name, None)
        return kind, val


def loop(a, legs, prev, out_dir, state_file, start, remote=None):
    """Check every minute through the hot window; write, seal and publish each time.

    Legs inside their own hot window (or LOOP_TAIL past it) are checked every
    iteration, the rest every LEG_EVERY with their last reading copied forward in
    between. Conditions run every COND_EVERY on a thread that holds an iteration at
    most ITER_COND_WAIT_S; a slower one is picked up by a later iteration. The window
    is worked out again each minute from the status just written, which is also the
    next iteration's previous status. Before the window opens (it may be up to
    HOT_LEAD away) only legs due on the 10-min cadence are checked. Stops LOOP_TAIL
    after the window ends or after --max-minutes. A slow iteration skips to the next
    minute instead of stacking. While every lookup fails, remote (load_remote) is read
    at most every REMOTE_EVERY so a newer status the Mac backup published is built on
    instead of being replaced by this loop's older one. With --now the clock is
    simulated: each minute lasts --interval seconds (tests). Exit status 0 when at least
    one status was written and, unless --no-publish, published.
    """
    speed = 60 / a.interval if a.now else 1.0
    scale = a.interval / 60       # the iteration budgets shrink with a shorter --interval
    t0 = time.monotonic()

    def clock():
        if a.now:
            return start + timedelta(seconds=(time.monotonic() - t0) * speed)
        return datetime.now(timezone.utc)

    stop = start + timedelta(minutes=a.max_minutes)
    never = datetime.min.replace(tzinfo=timezone.utc)
    gate, tried, leg_notes = Gate(), {}, {}
    cond = merge_conditions({}, prev)[0]
    cond_notes = [n for n in (prev.get("run") or {}).get("notes") or [] if str(n).startswith("conditions:")]
    cond_ok, cond_at, thread, box = True, None, None, {}
    end_seen, n, wrote, published, failed_in_row = None, 0, 0, 0, 0
    blind, remote_at = False, start
    while True:
        now = clock().replace(microsecond=0)
        if blind and remote and now - remote_at >= REMOTE_EVERY - SLACK:
            remote_at = now
            try:
                got_remote = remote()[0]
            except Exception as e:  # never worth ending the loop over
                got_remote = None
                say(f"loop: could not read the published status ({type(e).__name__})")
            if got_remote and newer(prev, got_remote) is got_remote:
                say("loop: building on a newer published status")
                prev = got_remote
            now = clock().replace(microsecond=0)  # the read can take a while
        win = hot_window(legs, prev, now, HOT_LEAD)
        if win:
            end_seen = win[1]
        elif not end_seen or now > end_seen + LOOP_TAIL:
            say("loop: hot window over")
            break
        if now >= stop:
            say("loop: reached --max-minutes")
            break
        it0 = time.monotonic()
        prev_legs = prev.get("legs") or {}
        hot = {lid for lid, w in leg_windows(legs, prev, now).items() if w and w[0] <= now <= w[1] + LOOP_TAIL}
        due = [l for l in legs if l["id"] in hot or l["id"] not in prev_legs
               or now - tried.get(l["id"], never) >= LEG_EVERY - SLACK]
        if thread is None and (not cond_at or now - cond_at >= COND_EVERY - SLACK):
            thread, box = start_conditions(prev, legs, now)
            cond_at = now
            if thread is None:  # conditions.py missing: nothing to wait for
                cond, cond_notes, cond_ok = conditions_result(box, prev)
        try:
            if due:
                n += 1
                gate.now = now
                got, notes, counts = fs.update_legs(due, prev_legs, now, deadline=it0 + ITER_FLIGHTS_S * scale,
                                                    ask=gate)
                blind = counts["failed"] > 0 and counts["checked"] + counts["route"] == 0
                for l in due:
                    tried[l["id"]] = now
                    leg_notes[l["id"]] = [x for x in notes if x.startswith(f"{l['id']}:")]
            if thread is not None:
                thread.join(max(0, ITER_COND_WAIT_S * scale - (time.monotonic() - it0)) if due else 0)
                if not thread.is_alive() or now - cond_at >= COND_EVERY - SLACK:
                    if thread.is_alive():  # stuck past its own budget: give up on this one
                        box["err"] = "timed out"
                    cond, cond_notes, cond_ok = conditions_result(box, prev)
                    thread = None
            if due:
                legs_doc = {l["id"]: got[l["id"]] if l["id"] in got else copy.deepcopy(prev_legs[l["id"]])
                            for l in legs}
                counts["carried"] += len(legs) - len(due)
                notes = [x for l in legs for x in leg_notes.get(l["id"], [])] + cond_notes
                doc = assemble(prev, now, a.source, legs_doc, counts, notes, cond, cond_ok, legs, looping=True)
                write_status(doc, out_dir, state_file)
                wrote += 1
                prev = doc
                sent = None if a.no_publish else publish()
                published += bool(sent)
                say(f"loop {n}: cadence {doc['run']['cadence_s']} s; flights "
                    + ", ".join(f"{k} {v}" for k, v in counts.items())
                    + ("" if sent is None else "; published" if sent else "; publish failed"))
            failed_in_row = 0
        except Exception as e:  # one bad minute must not end the loop; a run of them does
            failed_in_row += 1
            detail = "; ".join(e.args[0][:5]) if isinstance(e, ValueError) and isinstance(e.args[0], list) else str(e)
            say(f"loop {n}: failed ({type(e).__name__})", detail)
            if failed_in_row >= 5:
                say("loop: 5 failures in a row; stopping")
                break
        # Sleep to the top of the next minute; one that has already passed is skipped.
        # time.sleep runs on the monotonic clock, so sleep again while the wall clock is
        # still short of the minute (a clock stepped back would otherwise rerun this one;
        # one stepped back further than that just carries on).
        if a.now:
            time.sleep((60 - clock().timestamp() % 60) / speed)
        else:
            target = (time.time() // a.interval + 1) * a.interval
            while 0 < (left := target - time.time()) <= a.interval:
                time.sleep(left)
    say(f"loop: {n} iterations, {wrote} written" + ("" if a.no_publish else f", {published} published"))
    return 0 if wrote and (a.no_publish or published) else 1


# ---------- main ----------

def print_plan(now, legs, prev, due, why):
    """--plan: the travel windows, each leg's hot window and the mode. Under PUBLIC
    (a public Actions log) counts and mode words only, never times."""
    mode = mode_at(now, legs, prev)
    wins = leg_windows(legs, prev, now)
    spans = hot_spans(legs, prev, now)
    if PUBLIC:
        print(f"{len(legs)} legs, {sum(1 for w in wins.values() if w)} with a hot window "
              f"({len(spans)} after merging); mode {mode}; {'run' if due else 'skip'} ({why})")
        return
    for d, (s, e) in windows(legs, prev).items():
        print(f"{d} window {fs.iso_utc(s)} .. {fs.iso_utc(e)}")
    for lid, w in wins.items():
        print(f"  {lid} hot " + (f"{fs.iso_utc(w[0])} .. {fs.iso_utc(w[1])}{'  <- now' if w[0] <= now <= w[1] else ''}"
                                 if w else "never (canceled or no departure time)"))
    for s, e in spans:
        print(f"hot window {fs.iso_utc(s)} .. {fs.iso_utc(e)}")
    print(f"at {fs.iso_utc(now)}: mode {mode} (cloud checks every {CADENCE[mode]} s); "
          f"{'run' if due else 'skip'} ({why})")


def main():
    ap = argparse.ArgumentParser(description="One updater run (see the module docstring).")
    ap.add_argument("--force", action="store_true", help="run whatever the clock says")
    ap.add_argument("--slow", action="store_true", help="also run on slow ticks during the trip fortnight")
    ap.add_argument("--slow-minutes", type=int, default=10,
                    help="a slow tick is the first N minutes of a UTC hour (60 = any time)")
    ap.add_argument("--source", choices=("actions", "mac"),
                    default="actions" if os.environ.get("GITHUB_ACTIONS") == "true" else "mac")
    ap.add_argument("--skip-if-fresh", type=int, metavar="MIN",
                    help="backup mode: skip when a good GitHub Actions run published less than MIN minutes ago "
                         f"({SLOW_TICK_LIMIT} min on slow ticks)")
    ap.add_argument("--legs", help="planned legs JSON override (testing); implies --no-remote")
    ap.add_argument("--state", help="previous-status file (default updater/state/prev_status.json; "
                                    "prev_status.override.json with --legs)")
    ap.add_argument("--out-dir", help="output folder (default updater/out)")
    ap.add_argument("--no-remote", action="store_true", help="do not read the published status")
    ap.add_argument("--now", help="ISO time override for the window decision and leg ranges")
    ap.add_argument("--plan", action="store_true", help="print the windows and the mode, then exit")
    ap.add_argument("--mode", action="store_true",
                    help="print hot|travel|slow|idle and exit (a hot window starting within 15 min counts)")
    ap.add_argument("--loop", action="store_true",
                    help="check every minute through the hot window, publishing each time; "
                         "outside one, a single run that also publishes")
    ap.add_argument("--max-minutes", type=float, default=LOOP_MINUTES, help="--loop: stop after this long")
    ap.add_argument("--interval", type=float, default=60,
                    help="--loop: seconds per iteration (with --now, each lasts one simulated minute)")
    ap.add_argument("--no-publish", action="store_true", help="--loop: write status.bin but do not publish it")
    ap.add_argument("--check", metavar="FILE", help="validate a status .json or .bin and exit")
    a = ap.parse_args()

    if a.check:
        return check_file(a.check)

    t0 = time.monotonic()
    now = (fs.parse_iso(a.now) if a.now else datetime.now(timezone.utc)).replace(microsecond=0)
    out_dir = Path(a.out_dir) if a.out_dir else OUT
    state_file = Path(a.state) if a.state else STATE / ("prev_status.override.json" if a.legs else "prev_status.json")
    no_remote = a.no_remote or bool(a.legs)
    looking = a.plan or a.mode
    publishing = a.loop and not a.no_publish and not looking
    if publishing and out_dir.resolve() != OUT.resolve():
        say("fatal: publish.sh only publishes updater/out; add --no-publish to use --out-dir")
        return 1
    if a.interval <= 0:
        say("fatal: --interval must be positive")
        return 1

    # Never leave a stale status.bin for publish.sh to push.
    if not looking:
        out_dir.mkdir(parents=True, exist_ok=True)
        for f in ("status.json", "status.bin", "status.bin.tmp", "status.json.tmp"):
            (out_dir / f).unlink(missing_ok=True)

    try:
        legs = load_legs(a.legs)
    except Exception as e:
        say(f"fatal: could not load the planned legs ({type(e).__name__})", str(e))
        return 1

    local = load_local(state_file)
    if a.mode:
        # The return legs' times come only from the published status, so read it in the fortnight.
        prev = local
        if not no_remote and in_fortnight(now, legs):
            remote, _ = load_remote()
            prev = newer(local, remote)
        print(mode_at(now, legs, prev, HOT_LEAD))
        return 0

    remote, remote_note = None, None
    if a.loop and not a.plan:
        if not no_remote:
            remote, remote_note = load_remote()
        prev = newer(local, remote) or {}
        if hot_window(legs, prev, now, HOT_LEAD):
            say(f"loop: start (at most {a.max_minutes:g} min)")
            return loop(a, legs, prev, out_dir, state_file, now, None if no_remote else load_remote)
        say("loop: not hot; a single run instead")
        local = prev

    due, why, late = decide(now, legs, local, a)
    if not due and late and not no_remote and not a.plan and remote is None:
        remote, remote_note = load_remote()  # a delay may have stretched the window
        due, why, _ = decide(now, legs, newer(local, remote), a)
    if a.plan:
        print_plan(now, legs, local, due, why)
        return 0
    if not due:
        say(f"skipped: {why}")
        return 0
    say(f"run: {why}")

    if not no_remote and remote is None and remote_note is None:
        remote, remote_note = load_remote()
    if a.skip_if_fresh:
        limit = a.skip_if_fresh if why != "slow tick" else max(a.skip_if_fresh, SLOW_TICK_LIMIT)
        age = actions_age(remote, now)
        if age is not None and age < limit:
            say(f"skipped: Actions published {round(age)} min ago")
            return 0
    prev = newer(local, remote) or {}

    notes = [remote_note] if remote_note and remote_note != "previous status: none published yet" else []
    thread, box = start_conditions(prev, legs, now)
    legs_doc, flight_notes, counts = fs.update_legs(legs, prev.get("legs") or {}, now,
                                                    deadline=t0 + FLIGHTS_BUDGET)
    notes += flight_notes
    if thread:
        thread.join(max(1, CONDITIONS_BUDGET - (time.monotonic() - t0)))
        if thread.is_alive():
            box["err"] = "timed out"
    cond, cond_notes, cond_ok = conditions_result(box, prev)
    doc = assemble(prev, now, a.source, legs_doc, counts, notes + cond_notes, cond, cond_ok, legs, looping=False)
    try:
        binf = write_status(doc, out_dir, state_file)
    except ValueError as e:
        problems = e.args[0]
        say(f"fatal: status failed the schema check ({len(problems)} problems)", "; ".join(problems[:5]))
        return 1
    except Exception as e:
        say(f"fatal: could not seal status ({type(e).__name__})", str(e))
        return 1

    say("flights: " + ", ".join(f"{k} {v}" for k, v in counts.items())
        + f"; conditions {'kept previous' if box.get('err') or box.get('missing') else 'ok'}"
        + f"; {len(doc['run']['notes'])} notes; cadence {doc['run']['cadence_s']} s")
    if not PUBLIC:
        for n in doc["run"]["notes"]:
            say(f"  note: {n}")
    say(f"wrote {binf.relative_to(ROOT) if binf.is_relative_to(ROOT) else binf} "
        f"({binf.stat().st_size} bytes) in {time.monotonic() - t0:.1f}s")
    if publishing:
        ok = publish()
        say("published" if ok else "publish failed")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # a traceback could quote trip data into a public log
        if not PUBLIC:
            raise
        say(f"fatal: {type(e).__name__}")
        sys.exit(1)
