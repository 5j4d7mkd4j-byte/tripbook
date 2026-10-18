#!/usr/bin/env python3
"""One updater run: check flights and conditions, then write and seal status.bin.

  python3 updater/run.py                 run only inside a travel window
  python3 updater/run.py --slow          ...or on a slow tick (every 2 h) in the trip fortnight
  python3 updater/run.py --force         run now, whatever the clock says
  python3 updater/run.py --plan [--now ISO]   print the window decision and exit (no network)
  python3 updater/run.py --check FILE    validate a status .json or .bin against schema v1

Steps:
  1. Planned legs: docs/data/trip.bin (opened with tools/tripcrypt.mjs), else
     trip/flights.json. --legs FILE overrides them for testing.
  2. Is a run due? Travel window per direction: first departure -12 h to last
     arrival +3 h (an unknown time means that whole local day, +3 h), the same
     span the app uses. Outside it nothing touches the network unless --slow
     and the clock is in the first --slow-minutes of an even UTC hour between
     3 days before the first leg and 3 days after the last.
  3. Previous status: updater/state/prev_status.json and the live branch's
     status.bin; the newer checked_at wins. Either may be missing.
  4. Flights (flight_status.update_legs) and, at the same time, conditions
     (updater/conditions.py build(prev, legs, now) -> {airports, traffic,
     transit}, when that module exists). Anything that fails keeps the
     previous values and adds a run note.
  5. Assemble schema v1, validate it, write updater/out/status.json, seal it to
     updater/out/status.bin and keep a plaintext copy in updater/state.
updater/publish.sh then pushes status.bin to the live branch.

Logs in GitHub Actions are public on a public repo, so there they carry counts
only: no flight numbers, airports, times or notes.
Exit status: 0 when status.bin was written or the run was not due; 1 otherwise.
"""
import argparse
import json
import os
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


def slow_due(now, legs, slow_minutes):
    """A slow tick: the first slow_minutes of an even UTC hour, in the trip fortnight."""
    first = min(date.fromisoformat(l["date"]) for l in legs) - SLOW_PAD
    last = max(date.fromisoformat(l["date"]) for l in legs) + SLOW_PAD
    since_even_hour = (now.hour % 2) * 60 + now.minute
    return first <= now.date() <= last and since_even_hour < slow_minutes


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


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description="One updater run (see the module docstring).")
    ap.add_argument("--force", action="store_true", help="run whatever the clock says")
    ap.add_argument("--slow", action="store_true", help="also run on slow ticks during the trip fortnight")
    ap.add_argument("--slow-minutes", type=int, default=10,
                    help="a slow tick is the first N minutes of an even UTC hour (120 = any time)")
    ap.add_argument("--source", choices=("actions", "mac"),
                    default="actions" if os.environ.get("GITHUB_ACTIONS") == "true" else "mac")
    ap.add_argument("--skip-if-fresh", type=int, metavar="MIN",
                    help="backup mode: skip when a good GitHub Actions run published less than MIN minutes ago "
                         "(2 h 5 min on slow ticks)")
    ap.add_argument("--legs", help="planned legs JSON override (testing); implies --no-remote")
    ap.add_argument("--state", help="previous-status file (default updater/state/prev_status.json; "
                                    "prev_status.override.json with --legs)")
    ap.add_argument("--out-dir", help="output folder (default updater/out)")
    ap.add_argument("--no-remote", action="store_true", help="do not read the published status")
    ap.add_argument("--now", help="ISO time override for the window decision and leg ranges")
    ap.add_argument("--plan", action="store_true", help="print the window decision and exit")
    ap.add_argument("--check", metavar="FILE", help="validate a status .json or .bin and exit")
    a = ap.parse_args()

    if a.check:
        return check_file(a.check)

    t0 = time.monotonic()
    now = (fs.parse_iso(a.now) if a.now else datetime.now(timezone.utc)).replace(microsecond=0)
    out_dir = Path(a.out_dir) if a.out_dir else OUT
    state_file = Path(a.state) if a.state else STATE / ("prev_status.override.json" if a.legs else "prev_status.json")
    no_remote = a.no_remote or bool(a.legs)

    # Never leave a stale status.bin for publish.sh to push.
    if not a.plan:
        out_dir.mkdir(parents=True, exist_ok=True)
        for f in ("status.json", "status.bin", "status.bin.tmp", "status.json.tmp"):
            (out_dir / f).unlink(missing_ok=True)

    try:
        legs = load_legs(a.legs)
    except Exception as e:
        say(f"fatal: could not load the planned legs ({type(e).__name__})", str(e))
        return 1

    local = load_local(state_file)
    due, why, late = decide(now, legs, local, a)
    remote, remote_note = None, None
    if not due and late and not no_remote and not a.plan:
        remote, remote_note = load_remote()  # a delay may have stretched the window
        due, why, _ = decide(now, legs, newer(local, remote), a)
    if a.plan:
        for d, (s, e) in windows(legs, local).items():
            print(f"{d} window {fs.iso_utc(s)} .. {fs.iso_utc(e)}")
        print(f"at {fs.iso_utc(now)}: {'run' if due else 'skip'} ({why})")
        return 0
    if not due:
        say(f"skipped: {why}")
        return 0
    say(f"run: {why}")

    if not no_remote and remote is None and remote_note is None:
        remote, remote_note = load_remote()
    if a.skip_if_fresh:
        limit = a.skip_if_fresh if why != "slow tick" else max(a.skip_if_fresh, 125)
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
    cond, kept, cond_notes = merge_conditions(box, prev)
    notes += [f"conditions: {n}" for n in cond_notes]
    if box.get("missing"):
        notes.append("conditions: updater/conditions.py not present; kept the previous values")
    elif box.get("err"):
        notes.append(f"conditions: {box['err']}; kept the previous values")
    elif kept:
        notes.append(f"conditions: no {', '.join(kept)} returned; kept the previous values")

    # checked_at says when flight data was last good. If every lookup failed it
    # stays put, so the app shows the data as old and the Mac backup steps in.
    tried = counts["checked"] + counts["route"] + counts["failed"]
    flights_ok = counts["checked"] + counts["route"] > 0 or tried == 0
    checked_at = fs.iso_utc(now) if flights_ok or not prev.get("checked_at") else prev["checked_at"]
    doc = {
        "schema": 1,
        "checked_at": checked_at,
        "run": {"source": a.source, "ok": counts["failed"] == 0 and not box.get("err"),
                "notes": list(dict.fromkeys(notes))[:MAX_NOTES]},
        "legs": legs_doc,
        **cond,
    }
    problems = check_schema(doc)
    if problems:
        say(f"fatal: status failed the schema check ({len(problems)} problems)", "; ".join(problems[:5]))
        return 1
    try:
        binf = seal_out(doc, out_dir)
    except Exception as e:
        say(f"fatal: could not seal status ({type(e).__name__})", str(e))
        return 1
    STATE.mkdir(parents=True, exist_ok=True)
    write_json(state_file, doc)

    say("flights: " + ", ".join(f"{k} {v}" for k, v in counts.items())
        + f"; conditions {'kept previous' if box.get('err') or box.get('missing') else 'ok'}"
        + f"; {len(doc['run']['notes'])} notes")
    if not PUBLIC:
        for n in doc["run"]["notes"]:
            say(f"  note: {n}")
    say(f"wrote {binf.relative_to(ROOT) if binf.is_relative_to(ROOT) else binf} "
        f"({binf.stat().st_size} bytes) in {time.monotonic() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # a traceback could quote trip data into a public log
        if not PUBLIC:
            raise
        say(f"fatal: {type(e).__name__}")
        sys.exit(1)
