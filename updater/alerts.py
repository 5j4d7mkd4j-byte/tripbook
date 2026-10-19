#!/usr/bin/env python3
"""Lock-screen alerts: which pushes a new status calls for, and the call to push.mjs.

  import alerts
  doc["alerts"] = alerts.step(prev, doc, legs, now)   # once per run.py iteration
  say(alerts.summary())                                # counts only

decide() is pure. It compares the new status with what earlier alerts said
(status.alerts.seen) and returns messages plus the next state. It reads each leg
the way the app does (model.js merge: a reading counts only while it is live;
otherwise the leg holds still) and looks only at legs that depart within 30 h
and have not landed (nor ended 6 h ago: a canceled leg never lands).
  gate        a known departure gate or terminal changes; a first gate within 4 h
              of departure; an arrival gate or terminal change on a leg that feeds
              a connection (held while the next leg is canceled). A blank live
              value is no reading, never a change.
  delay       est - sched first reaches 15 min, then moves 10+ min either way from
              the last alert ("Back on time" when that lands under 5, and it starts
              over); leaving 10+ min early, once
  status      canceled, no longer canceled, diverted
  connection  the level N.connection shows, by spare minutes between reaching the
              next gate and its doors closing (ok 20+, tight 8-19, risk under 8):
              ok -> tight, anything -> risk, or 10 fewer spare minutes while tight
              or at risk; "looks OK again" once it is back to ok with 30+ spare
              minutes, and after that a dip into tight must lose 10 minutes first.
              A blank gate counts as the last one posted. The walk is the app's
              figure (below).
The first reading of a leg sets a quiet baseline, except a delay of 15+, a
cancellation, a diversion or a tight connection. Nothing repeats while the values
hold still, so a 1-3 min wobble in est never alerts twice.

Walking minutes between gates are the ones the app shows. model.js N.walk takes the
airport map's figure (screens/nav.js N.navWalk) when the map knows both gates, and
otherwise guesses from the concourse letters (15 min while a gate is not posted).
walk() does the same; the map's minutes come from node updater/navwalk.mjs, which runs
the app's own nav.js on the sealed guide (docs/data/guide.bin) instead of a copy of it.
step() asks at most once per run, and only for gate pairs status.alerts.walk does not
hold yet; that memory goes whenever navwalk.mjs, nav.js or the map data change. On any
failure (no node, no key, no map data, a 10 s timeout) the walk is the concourse guess,
summary() says so, and the same process (run.py --loop) waits 15 minutes to ask again.

status.alerts (app/CONTRACT.md), kept small; a leg's part goes 12 h after the leg
is done (48 h while its reading is not live), a connection's with the second leg:
  {v: 1, sent: {tag: iso}, seen: {leg id | cx-<leg id>: {...}},
   devices: [{id, ok, at}], last: iso | null,
   walk?: {fp, m: {"CODE|gate|gate": minutes | null}}}   (null: not on the map)

send() and devices() run node updater/push.mjs and never raise; nor does the walk
lookup. With PUBLIC, CI or GITHUB_ACTIONS set (public Actions logs) this module
prints nothing; summary() is the counts-only line run.py prints.
"""
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # no __pycache__ in the repo
import flight_status as fs  # noqa: E402  (needs the path above)

PUSH = HERE / "push.mjs"
SECRETS = ROOT / ".secrets"
NAVWALK = HERE / "navwalk.mjs"                     # the app's N.navWalk, run by node
NAV_JS = ROOT / "app" / "src" / "screens" / "nav.js"
GUIDE_BIN = ROOT / "docs" / "data" / "guide.bin"   # the sealed guide the phones have
NAV_DIR = ROOT / "guide" / "nav"                   # plaintext maps, on the Mac only


def truthy(v):
    return bool(v) and not re.fullmatch(r"0|false|no", v.strip(), re.I)


# Same test push.mjs uses: these logs are public.
PUBLIC = any(truthy(os.environ.get(k, "")) for k in ("CI", "PUBLIC", "GITHUB_ACTIONS"))

AHEAD = timedelta(hours=30)          # legs departing within this get alerts
FIRST_GATE = timedelta(hours=4)      # a first gate assignment alerts this close to departure
DIVERT_GRACE = timedelta(hours=2)    # a diversion reported with the landing still alerts
LINGER = timedelta(hours=6)          # a leg that never reports landing drops out this long after its times
KEEP = timedelta(hours=12)           # a leg's state goes this long after it is done (must outlast LINGER)
SENT_KEEP = timedelta(hours=48)
DELAY_ALERT = 15                     # minutes late that first alert
DELAY_STEP = 10                      # then a move this big from the last alert
ON_TIME = 5                          # "Back on time" under this
EARLY = 10                           # leaving this many minutes early alerts once
CX_STEP = 10                         # spare minutes lost while tight or at risk
CX_CLEAR = 30                        # spare minutes before "looks OK again"
BOARD = 40                           # model.js N.AA.board: boarding starts this long before departure
DOORS = 15                           # model.js N.AA.doors: the doors close this long before departure
TO_DOOR = 10                         # model.js N.connection: touchdown to the door opening
TTL_MIN, TTL_MAX = 300, 3600
SEND_TIMEOUT = 25
PUSH_BUDGET = 18                     # push.mjs --budget: no new request after this, inside SEND_TIMEOUT
LIST_TIMEOUT = 10
MAX_DEVICES = 12
WALK_TIMEOUT = 10                    # seconds for the one navwalk.mjs call a run may make
WALK_RETRY = 15 * 60                 # after a failed call, concourse guesses for this many seconds
WALK_KEEP = 6                        # gate pairs status.alerts.walk remembers (about 25 bytes each)
WALK_ASK = 16                        # gate pairs one call may ask about
# Sent oldest first, so the most important one ends up on top of the lock screen.
ORDER = {"delay": 0, "gate": 1, "arr": 2, "cx": 3, "status": 4}
RANK = {"ok": 0, "tight": 1, "risk": 2}
FIELDS = ("title", "body", "url", "tag", "ttl", "urgency")
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

_last = {}  # this run's counts, for summary()
_walk_retry = 0.0  # time.monotonic() before which no navwalk.mjs call is made (after a failure)
_fp_memo = {}  # (path, size, mtime) -> sha256, so the minute loop does not rehash the map


def say(msg, detail="", public=None):
    """A line on stderr, for people running it locally. Nothing at all in public logs."""
    if not (PUBLIC if public is None else public):
        print(f"{msg} {detail}".rstrip(), file=sys.stderr, flush=True)


# ---------- small helpers ----------

def js_round(x):
    """Math.round: halves go up (Python's round() goes to the even neighbour)."""
    return math.floor(x + 0.5)


def mins(a, b):
    """N.mins on datetimes: whole minutes from a to b."""
    if not a or not b:
        return None
    return js_round((b - a) // timedelta(milliseconds=1) / 60000)


def clock(dt, ap, ref=None):
    """2:15 PM at airport ap; adds the weekday when that differs from ref's local date."""
    if not dt:
        return "?"
    loc = dt.astimezone(fs.tz_of(ap))
    s = f"{loc.hour % 12 or 12}:{loc.minute:02d} {'AM' if loc.hour < 12 else 'PM'}"
    if ref and ref.astimezone(fs.tz_of(ap)).date() != loc.date():
        s += f" {DAYS[loc.weekday()]}"
    return s


def dur(m):
    """N.dur: 25 min, 1h 5m, 2h."""
    m = abs(int(m))
    if m < 60:
        return f"{m} min"
    return f"{m // 60}h {m % 60}m" if m % 60 else f"{m // 60}h"


def norm(v):
    return str(v).strip().upper() if v not in (None, "") else None


def where(term, gate):
    """Terminal 4, gate B14 (either part may be missing)."""
    return ", ".join(x for x in (term and f"Terminal {term}", gate and f"gate {gate}") if x)


def label(p):
    """AA 1234, as the app writes it (screens/flights.js fno)."""
    carrier, num = p.get("carrier"), p.get("num")
    if not (carrier and num):
        try:
            c, n = fs.split_flight(p.get("flight") or "")
            carrier, num = carrier or c, num or n
        except ValueError:
            return str(p.get("flight") or "Flight")
    return f"{carrier} {num}"


def safe_tag(s):
    """push.mjs sets the Topic header (one notification per tag) only for [A-Za-z0-9_-]{1,32}."""
    return re.sub(r"[^A-Za-z0-9_-]", "", str(s))[:32] or "alert"


def ttl(dep, now):
    secs = int((dep - now).total_seconds()) if dep else 0
    return max(TTL_MIN, min(TTL_MAX, secs))


def node():
    return os.environ.get("NODE") or shutil.which("node") or "node"


def first_line(s):
    # Node prints the stack after the message; the message is enough and holds no secrets.
    for line in (s or "").splitlines():
        if line.strip().startswith("Error:"):
            return line.strip()
    return (s or "").strip().splitlines()[0] if (s or "").strip() else ""


# ---------- legs as the app sees them ----------

def merged(p, s):
    """One planned leg p with its status leg s, as model.js merge() combines them.
    Times are datetimes; anything not live falls back to the plan."""
    s = s if isinstance(s, dict) else {}
    live = s.get("route_ok") is not False and not s.get("fetch_failed") and bool(s.get("status"))
    sd = (s.get("dep") or {}) if live else {}
    sa = (s.get("arr") or {}) if live else {}
    # live_term: the live terminal alone. The plan fills a blank one for display, but a
    # source that leaves it out has not moved the flight.
    dep = {"terminal": sd.get("terminal") or p.get("dep_terminal") or None, "live_term": sd.get("terminal") or None,
           "gate": sd.get("gate") or None,
           "sched": fs.parse_iso(sd.get("sched") or p.get("dep")), "est": fs.parse_iso(sd.get("est")),
           "actual": bool(sd.get("actual"))}
    arr = {"terminal": sa.get("terminal") or p.get("arr_terminal") or None, "live_term": sa.get("terminal") or None,
           "gate": sa.get("gate") or None,
           "sched": fs.parse_iso(sa.get("sched") or p.get("arr")), "est": fs.parse_iso(sa.get("est")),
           "actual": bool(sa.get("actual"))}
    dep["time"], arr["time"] = dep["est"] or dep["sched"], arr["est"] or arr["sched"]
    # Delay = est - sched; the source's own figure only when a time is missing.
    delay = mins(dep["sched"], dep["est"]) if dep["est"] and dep["sched"] else s.get("delay_dep_min") if live else None
    return {
        "id": p.get("id"), "dir": p.get("dir"), "seq": p.get("seq") or 0, "label": label(p),
        "from": p.get("from"), "to": p.get("to"), "dep": dep, "arr": arr, "live": live,
        # A reading that failed (not one that never happened) makes the leg hold still.
        "failed": bool(s) and not live and (bool(s.get("fetch_failed")) or s.get("route_ok") is False),
        "canceled": bool(live and s.get("canceled")), "diverted": (live and s.get("diverted_to")) or None,
        "departed": bool(live and (s.get("departed") or s.get("landed"))) or dep["actual"],
        "landed": bool(live and s.get("landed")) or arr["actual"],
        "delay": delay if isinstance(delay, int) else None,
    }


def done_at(m):
    """The later of the leg's departure and arrival times (None without either)."""
    ts = [t for t in (m["dep"]["time"], m["arr"]["time"]) if t]
    return max(ts) if ts else None


def active(m, now):
    """Departs within 30 h and has not landed. A diversion often arrives with the
    landing, so a diverted leg stays in view for a little while after. A leg that
    never lands (canceled, or a source that stops short) drops out LINGER after its
    times, well before prune() forgets what was said about it."""
    t = m["dep"]["time"]
    if not t or t - now > AHEAD or now > done_at(m) + LINGER:
        return False
    if m["landed"]:
        return bool(m["diverted"]) and now <= (m["arr"]["time"] or t) + DIVERT_GRACE
    return True


def pairs(ms):
    """Connections: consecutive legs of a direction (by seq) where a lands where b leaves."""
    by = {}
    for m in ms:
        by.setdefault(m["dir"], []).append(m)
    out = []
    for legs in by.values():
        legs.sort(key=lambda m: m["seq"])
        out += [(a, b) for a, b in zip(legs, legs[1:]) if a["to"] and a["to"] == b["from"]]
    return out


CONC = "ABCDE"


def concourse(g):
    m = re.match(r"[A-Z]", str(g or "").strip().upper())
    return m.group(0) if m else None


def nav_min(v):
    """A usable map figure: N.walk's Number.isFinite(m) && m > 0."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def walk(g1, g2, code=None, nav=None):
    """N.walk(code, g1, g2): minutes between two gates at airport code. The airport map's
    figure when nav(code, g1, g2) gives one (rounded up, as N.walk does); otherwise a
    guess from the CLT concourse letters, and 15 when a gate is not known yet.
    nav is a Walker (see step()); without one this is the guess alone."""
    a, b = concourse(g1), concourse(g2)
    if g1 and g2 and nav:
        try:
            m = nav(code, g1, g2)
        except Exception:  # the guess below, as N.walk does when navWalk throws
            m = None
        if nav_min(m):
            return {"min": math.ceil(m), "known": True, "same": bool(a) and a == b, "nav": True}
    if not a or not b:
        return {"min": 15, "known": False}
    if a == b:
        return {"min": 5, "known": True, "same": True}
    near = a in CONC and b in CONC and abs(CONC.index(a) - CONC.index(b)) == 1
    return {"min": 10 if near else 20, "known": True}


def connection(a, b, ga=None, gb=None, nav=None):
    """N.connection for merged legs a -> b: {free, spare, level, walk, ga, gb}, or None
    without times. spare = minutes from reaching b's gate to its doors closing (the level:
    ok 20+, tight 8-19, risk under 8); free = minutes before boarding starts (spare - 25).
    ga / gb stand in for a blank arrival / departure gate (the last ones posted),
    so a source that skips a gate for one run does not move the walk 5 -> 15 min.
    The walk is walk(ga, gb, a's arrival airport, nav), as N.connection asks N.walk."""
    if not a["arr"]["time"] or not b["dep"]["time"]:
        return None
    ga, gb = a["arr"]["gate"] or ga, b["dep"]["gate"] or gb
    w = walk(ga, gb, a["to"], nav)
    reach = a["arr"]["time"] + timedelta(minutes=TO_DOOR + w["min"])
    free = mins(reach, b["dep"]["time"] - timedelta(minutes=BOARD))
    spare = mins(reach, b["dep"]["time"] - timedelta(minutes=DOORS))
    level = "risk" if a["canceled"] or b["canceled"] else "ok" if spare >= 20 else "tight" if spare >= 8 else "risk"
    return {"free": free, "spare": spare, "level": level, "walk": w, "ga": ga, "gb": gb}


# ---------- the rules ----------

def msg(kind, m, title, body, dep, now, url=None, key=None):
    return {"kind": kind, "title": f"{m['label']} · {title}" if m else title, "body": body.strip(),
            "url": url or f"#flight/{m['id']}", "tag": safe_tag(f"{kind}-{key or m['id']}"),
            "ttl": ttl(dep, now), "urgency": "high"}


def boards(m, now, said=False, t=None):
    """ Boards 1:35 PM. (or the departure time once boarding has started, unless said already)"""
    t = t or m["dep"]["time"]
    b = t - timedelta(minutes=BOARD)
    if now < b:
        return f" Boards {clock(b, m['from'], t)}."
    return "" if said else f" Departs {clock(t, m['from'])}."


def changed(new, old):
    """(moved, first): a known value became another, or an unknown one became known."""
    return bool(new and old) and norm(new) != norm(old), bool(new) and not old


def check_status(m, rec, now):
    out = []
    c = m["canceled"]
    if "cancel" not in rec or c != rec["cancel"]:
        if c:
            out.append(msg("status", m, "Canceled", "Open the app for rebooking options.", m["dep"]["time"], now))
        elif rec.get("cancel"):
            body = f"Listed as operating again. Departs {clock(m['dep']['time'], m['from'])}." + boards(m, now, True)
            out.append(msg("status", m, "No longer canceled", body, m["dep"]["time"], now))
        rec["cancel"] = c
    d = m["diverted"]
    if "divert" not in rec or norm(d) != norm(rec["divert"]):
        if d:
            out.append(msg("status", m, f"Diverted to {d}", f"Now heading to {d} instead of {m['to']}.",
                           m["dep"]["time"], now))
        rec["divert"] = d
    return out


def check_gate(m, rec, now):
    """Departure gate and terminal (live values; a blank one is no reading)."""
    g, t = m["dep"]["gate"], m["dep"]["live_term"]
    if "gate" not in rec:
        rec["gate"], rec["term"] = g, m["dep"]["terminal"]
        return []
    og, ot = rec["gate"], rec.get("term")
    gate_moved, gate_new = changed(g, og)
    term_moved, term_new = changed(t, ot)
    rec["gate"], rec["term"] = g or og, t or ot  # a blank reading never forgets a known gate
    soon = m["dep"]["time"] - now <= FIRST_GATE
    if not (gate_moved or term_moved or (gate_new or term_new) and soon):
        return []
    if gate_moved or term_moved:
        title = "Terminal change" if term_moved else "Gate change"
        was = ", ".join(x for x in (term_moved and f"Terminal {ot}", gate_moved and og) if x)
        body = f"Now {where(t if term_moved else None, g)} (was {was})."
    else:
        title = f"Gate {g}" if g else f"Terminal {t}"
        body = f"Departs from {where(rec['term'] or m['dep']['terminal'], g)}."
    if not g:
        body += " Gate not posted yet."
    return [msg("gate", m, title, body + boards(m, now), m["dep"]["time"], now)]


def check_arrival(m, rec, nxt, now, nav=None):
    """Arrival gate and terminal of a leg that feeds a connection (changes only).
    The walk it quotes is walk() with nav, the same as the connection alert's."""
    g, t = m["arr"]["gate"], m["arr"]["live_term"]
    if "agate" not in rec:
        rec["agate"], rec["aterm"] = g, m["arr"]["terminal"]
        return []
    og, ot = rec["agate"], rec.get("aterm")
    gate_moved, _ = changed(g, og)
    term_moved, _ = changed(t, ot)
    rec["agate"], rec["aterm"] = g or og, t or ot
    if not (gate_moved or term_moved):
        return []
    was = ", ".join(x for x in (term_moved and f"Terminal {ot}", gate_moved and og) if x)
    body = f"Now arriving at {where(t if term_moved else None, g)} (was {was})."
    ng = nxt["dep"]["gate"]
    if g and ng:
        body += f" Walk to {ng}, about {walk(g, ng, m['to'], nav)['min']} min."
    elif not ng:
        body += f" {nxt['label']} gate not posted yet."
    title = f"Arrival gate {g}" if g else f"Arrival terminal {t}"
    return [msg("arr", m, title, body, nxt["dep"]["time"], now)]


def check_delay(m, rec, now):
    d = m["delay"]
    if d is None:
        return []
    if "delay" not in rec:
        rec["delay"], rec["dep"], rec["early"] = None, None, d <= -EARLY  # leaving early: quiet on first sight
    ap, sched = m["from"], m["dep"]["sched"]
    # A source may state the delay without an estimate: the time it implies, then.
    est = m["dep"]["est"] or (sched + timedelta(minutes=d) if sched else m["dep"]["time"])
    last = rec["delay"]
    if d <= -EARLY and not rec.get("early"):
        rec.update(delay=None, dep=None, early=True)
        body = f"Departs {clock(est, ap, sched)}, {dur(d)} ahead of schedule." + boards(m, now, True, est)
        return [msg("delay", m, "Leaving early", body, est, now)]
    if last is None:
        if d < DELAY_ALERT:
            return []
        title = f"Delayed {dur(d)}"
        body = f"Departs {clock(est, ap, sched)} instead of {clock(sched, ap)}."
    elif abs(d - last) < DELAY_STEP:
        return []  # so "Delay cut to 6 min" and a wobble to 4 never make two alerts
    elif d < ON_TIME:
        rec.update(delay=None, dep=None)
        body = f"Departs {clock(est, ap, sched)}." + boards(m, now, True, est)
        return [msg("delay", m, "Back on time", body, est, now)]
    else:
        # Either way: a delay that shrinks means the gate closes sooner than the last alert said.
        was = fs.parse_iso(rec.get("dep")) or sched
        title = f"Delayed {dur(d)}" if d > last else f"Delay cut to {dur(d)}"
        body = f"Now departs {clock(est, ap, was)} (was {clock(was, ap)})."
    rec.update(delay=d, dep=fs.iso_utc(est))
    return [msg("delay", m, title, body + boards(m, now, True, est), est, now)]


def cx_active(a, b, now):
    """From 30 h before a departs until b departs."""
    ta, tb = a["dep"]["time"], b["dep"]["time"]
    return bool(ta and tb) and ta - now <= AHEAD and now < tb and not b["departed"]


def check_connection(a, b, seen, now, nav=None):
    """Connection a -> b. Holds still until a has a live reading, while either reading
    failed, and while either leg is canceled or diverted (their own alert says it).
    seen[cx-<a>] = {level, spare, again?}: the last alert's (or the quiet baseline's).
    A record from before spare holds free instead; it reads as free + 25.
    nav: the map's walking minutes (walk()); without it the concourse guess."""
    key = f"cx-{a['id']}"
    if not cx_active(a, b, now) or not a["live"] or b["failed"] \
            or a["canceled"] or b["canceled"] or a["diverted"] or b["diverted"]:
        return []
    c = connection(a, b, (seen.get(a["id"]) or {}).get("agate"), (seen.get(b["id"]) or {}).get("gate"), nav)
    if not c:
        return []
    rec, new, spare = seen.get(key), {"level": c["level"], "spare": c["spare"]}, c["spare"]
    if not isinstance(rec, dict) or rec.get("level") not in RANK:
        seen[key] = new
        return [cx_msg(a, b, c, now)] if c["level"] != "ok" else []
    if not isinstance(rec.get("spare"), int) and isinstance(rec.get("free"), int):
        rec["spare"] = rec["free"] + BOARD - DOORS
    rec.pop("free", None)
    r_new, r_old, last = RANK[c["level"]], RANK[rec["level"]], rec.get("spare") or 0
    if r_new > r_old:
        if r_new == 1 and rec.get("again") and spare > last - CX_STEP:
            return []  # after "looks OK again" only a 10+ drop says tight (from 30+, any tight is one)
        seen[key] = new
        return [cx_msg(a, b, c, now)]
    if r_new == r_old > 0 and spare <= last - CX_STEP:
        seen[key] = new
        return [cx_msg(a, b, c, now)]
    if r_new == 0 and r_old > 0:
        if spare < CX_CLEAR:
            return []  # nearly ok; the last alert still stands
        seen[key] = dict(new, again=True)
        return [cx_msg(a, b, c, now, again=True)]
    if r_new == 0 and spare > last:
        rec["spare"] = spare  # still ok: the most spare minutes seen since
    return []  # better but still tight or at risk: the last alert still stands


def cx_msg(a, b, c, now, again=False):
    """Leads with the doors: whether you reach the next gate before they close."""
    at, spare, w = a["to"], c["spare"], c["walk"]
    ga, gb = c["ga"], c["gb"]
    gate = f"gate {gb}" if gb else "the gate"
    if again:
        title = f"{at} connection looks OK again"
        lead = f"About {spare} min at {gate} before the doors close."
    elif c["level"] == "tight":
        title = f"Tight connection at {at}"
        lead = f"You reach {gate} about {spare} min before the doors close. Go straight there."
    else:
        title = f"Connection at risk at {at}"
        lead = f"You may reach {gate} after the doors close. Tell the crew as you land; the AA app shows rebooking."
    if w["known"]:  # the map's minutes when it knows both gates, else the concourse guess
        tail = f"Walk {ga} → {gb}, about {w['min']} min."
    else:
        what = "Next gate" if ga else "Arrival gate" if gb else "Gates"
        tail = f"{what} not posted yet; allow about 15 min to walk."
    return msg("cx", None, title, f"{lead} {tail}", b["dep"]["time"], now,
               url=f"#connect/{a['dir']}", key=a["id"])


# ---------- state ----------

def blank_state():
    return {"v": 1, "sent": {}, "seen": {}, "devices": [], "last": None}


# What a seen entry may hold (anything else is dropped, so a bad doc cannot break decide).
# "free" is only read from records written before "spare" (check_connection converts it).
REC = {"gate": str, "term": str, "agate": str, "aterm": str, "divert": str, "dep": str, "level": str,
       "delay": int, "spare": int, "free": int, "cancel": bool, "early": bool, "again": bool}


def clean(rec):
    out = {}
    for k, v in rec.items():
        t = REC.get(k)
        if t and (type(v) is t or v is None and t is not bool):
            out[k] = v
    return out


def load_state(state):
    """A usable copy of status.alerts (a blank one when it is missing or malformed)."""
    out = blank_state()
    if not isinstance(state, dict) or state.get("v") != 1:
        return out
    if isinstance(state.get("sent"), dict):
        out["sent"] = {k: v for k, v in state["sent"].items()
                       if isinstance(k, str) and isinstance(v, str) and fs.parse_iso(v)}
    if isinstance(state.get("seen"), dict):
        out["seen"] = {k: clean(v) for k, v in state["seen"].items() if isinstance(k, str) and isinstance(v, dict)}
    if isinstance(state.get("devices"), list):
        out["devices"] = [{"id": d["id"], "ok": d.get("ok") if isinstance(d.get("ok"), bool) else None,
                           "at": d.get("at") if fs.parse_iso(d.get("at")) else None}
                          for d in state["devices"] if isinstance(d, dict) and isinstance(d.get("id"), str)]
    last = state.get("last")
    out["last"] = last if isinstance(last, str) and fs.parse_iso(last) else None
    w = state.get("walk")  # only while it holds something, so a state without one stays the same
    if isinstance(w, dict) and isinstance(w.get("fp"), str) and isinstance(w.get("m"), dict):
        m = [(k, v) for k, v in w["m"].items() if isinstance(k, str) and len(k) <= 64 and (v is None or nav_min(v))]
        if m:
            out["walk"] = {"fp": w["fp"][:64], "m": dict(m[:WALK_KEEP])}
    return out


def prune(state, ms, now, feeds=None):
    """Drop what belongs to legs gone from the trip or done more than 12 h ago (48 h
    while the reading is not live: the times it shows are then only the plan's).
    A connection's entries (cx-<a>) last as long as its second leg's."""
    feeds = feeds or {}

    def until(m):
        end = done_at(m)
        return end + (KEEP if m["live"] else SENT_KEEP) if end else None

    def keep(key):
        lid = key if key in ms else key.split("-", 1)[-1]
        if lid not in ms:
            return False
        ends = [until(m) for m in (ms[lid], feeds.get(lid) if key.startswith("cx-") else None) if m]
        return None in ends or now <= max(ends)
    state["seen"] = {k: v for k, v in state["seen"].items() if keep(k)}
    state["sent"] = {k: v for k, v in state["sent"].items()
                     if keep(k) and now - fs.parse_iso(v) <= SENT_KEEP}


def decide(prev_status, status, legs, now, state=None, nav=None):
    """(messages, new_state): what to push for status, given the last alerts state.
    prev_status only seeds gate baselines for legs the state has never seen.
    nav(code, g1, g2) gives the map's walking minutes or None (step() passes a Walker);
    without it every walk is the concourse guess.
    messages: [{title, body, url, tag, ttl, urgency}], least important first."""
    now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    st = (status or {}).get("legs") or {}
    pst = (prev_status or {}).get("legs") or {}
    new = load_state(state)
    seen = new["seen"]
    legs = [p for p in legs or [] if isinstance(p, dict) and p.get("id")]
    ms = {p["id"]: merged(p, st.get(p["id"])) for p in legs}
    feeds = {a["id"]: b for a, b in pairs(list(ms.values()))}

    out = []
    for p in legs:
        m = ms[p["id"]]
        if not m["live"] or not active(m, now):
            continue  # not live: hold, so a failed check never looks like a change
        rec = seen.get(m["id"])
        if rec is None:
            rec = seen[m["id"]] = seed(merged(p, pst.get(p["id"])), m["id"] in feeds)
        out += check_status(m, rec, now)
        if not m["departed"] and not m["canceled"]:
            out += check_gate(m, rec, now)
            out += check_delay(m, rec, now)
        nxt = feeds.get(m["id"])  # quiet while the next leg is canceled: its own alert says it
        if nxt and not (m["landed"] or m["canceled"] or m["diverted"] or nxt["canceled"]):
            out += check_arrival(m, rec, nxt, now, nav)
    for a, b in pairs(list(ms.values())):
        cx = check_connection(a, b, seen, now, nav)
        if cx:  # it already gives the walk, so drop the arrival-gate alert it covers
            out = [x for x in out if x["tag"] != safe_tag(f"arr-{a['id']}")] + cx

    # One message per tag (the last word wins), least important first.
    by = {}
    for x in out:
        by.pop(x["tag"], None)
        by[x["tag"]] = x
    msgs = sorted(by.values(), key=lambda x: ORDER[x["kind"]])
    for x in msgs:
        new["sent"][x["tag"]] = fs.iso_utc(now)
    prune(new, ms, now, feeds)
    return [{k: x[k] for k in FIELDS} for x in msgs], new


def seed(pm, feeds):
    """A new leg's seen entry. Gate baselines come from the previous status when it was
    live there, so a change since then still alerts; everything else starts unseen."""
    if not pm["live"]:
        return {}
    rec = {"gate": pm["dep"]["gate"], "term": pm["dep"]["terminal"]}
    if feeds:
        rec.update(agate=pm["arr"]["gate"], aterm=pm["arr"]["terminal"])
    return rec


# ---------- push.mjs ----------

def not_configured():
    """Why push.mjs cannot send (a fixed phrase, safe for logs), or None. Looks at
    whether the inputs exist; never reads a secret."""
    if not PUSH.is_file():
        return "push.mjs missing"
    exe = node()
    if not (shutil.which(exe) or Path(exe).is_file()):
        return "node not found"
    if not os.environ.get("PUSH_SUBS", "").strip():
        f = Path(os.environ.get("PUSH_SUBS_FILE") or SECRETS / "push_subs.txt")
        try:
            if not f.is_file() or f.stat().st_size == 0:
                return "no subscriptions"
        except OSError:
            return "no subscriptions"
    if not os.environ.get("VAPID_PRIVATE_KEY", "").strip() and not (SECRETS / "vapid.json").is_file():
        return "no VAPID key"
    return None


def last_json(text):
    for line in reversed((text or "").strip().splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            continue
    return None


def send(messages, public=None):
    """Push messages to every phone with node updater/push.mjs send --json.
    Returns counts {sent, failed, gone, devices: [{id, ok, status, gone?}]}, or
    skipped / error (fixed phrases) instead of devices when push.mjs did not answer.
    Never raises."""
    base = {"sent": 0, "failed": 0, "gone": 0}
    public = PUBLIC if public is None else public
    try:
        msgs = [{k: m[k] for k in FIELDS if m.get(k) is not None}
                for m in messages or [] if isinstance(m, dict) and m.get("title")]
        if not msgs:
            return dict(base, skipped="nothing to send")
        why = not_configured()
        if why:
            return dict(base, skipped=why)
        env = dict(os.environ, **({"PUBLIC": "1"} if public else {}))
        r = subprocess.run([node(), str(PUSH), "send", "--json", "--budget", str(PUSH_BUDGET)],
                           input=json.dumps(msgs), capture_output=True, text=True, timeout=SEND_TIMEOUT,
                           env=env, cwd=str(ROOT))
        if r.returncode:
            say(f"alerts: push.mjs exited {r.returncode}", first_line(r.stderr), public)
            return dict(base, error=f"exit {r.returncode}")
        doc = last_json(r.stdout)
        if not isinstance(doc, dict):
            return dict(base, error="no result")
        devs = []
        for d in doc.get("devices") or []:
            if isinstance(d, dict) and d.get("id"):
                e = {"id": str(d["id"]), "ok": bool(d.get("ok")),
                     "status": d.get("status") if isinstance(d.get("status"), int) else None}
                if d.get("gone"):
                    e["gone"] = True
                devs.append(e)
        return dict(base, sent=int(doc.get("sent") or 0), failed=int(doc.get("failed") or 0),
                    gone=len(doc.get("gone") or []), devices=devs)
    except subprocess.TimeoutExpired:
        return dict(base, error="timed out")
    except Exception as e:  # alerts must never stop a status run
        return dict(base, error=type(e).__name__)


def device_ids():
    """Ids push.mjs would send to; [] when nothing is configured, None when listing failed."""
    if not_configured():
        return []
    try:
        r = subprocess.run([node(), str(PUSH), "devices"], capture_output=True, text=True,
                           timeout=LIST_TIMEOUT, cwd=str(ROOT))
        doc = last_json(r.stdout) if r.returncode == 0 else None
        if not isinstance(doc, list):
            return None
        return [str(d["id"]) for d in doc if isinstance(d, dict) and d.get("id")]
    except Exception:
        return None


def devices():
    """Ids from node updater/push.mjs devices, or [] on any failure."""
    return device_ids() or []


# ---------- walking minutes from the airport map (navwalk.mjs) ----------

class WalkError(Exception):
    """navwalk.mjs gave no answer; str() is a fixed phrase, safe for logs."""


def map_fp():
    """A short hash of everything navwalk.mjs reads: its own code, nav.js and the map data
    (the sealed guide, and guide/nav where it exists). Remembered minutes count only
    while it is unchanged. None when there is no helper or no map to ask."""
    try:
        code = [NAVWALK, NAV_JS]
        local = sorted(NAV_DIR.glob("*.json")) if NAV_DIR.is_dir() else []
        data = [f for f in [GUIDE_BIN] + local + ([NAV_DIR.parent / "guide.json"] if local else []) if f.is_file()]
        if not all(f.is_file() for f in code) or not (GUIDE_BIN.is_file() or local):
            return None
        if len(_fp_memo) > 64:
            _fp_memo.clear()
        h = hashlib.sha256()
        for f in code + data:
            st = f.stat()
            sig = (str(f), st.st_size, st.st_mtime_ns)
            if sig not in _fp_memo:
                _fp_memo[sig] = hashlib.sha256(f.read_bytes()).hexdigest()
            h.update(f"{f.name}:{_fp_memo[sig]}\n".encode())
        return h.hexdigest()[:16]
    except Exception:
        return None


def gate_key(code, g1, g2):
    """CODE|g1|g2 with each gate as nav.js normG writes it (b04, Gate B4 and B4 are one),
    the same key N.navWalk keeps its own answers under."""
    def g(s):
        s = re.sub(r"\s+", "", str("" if s is None else s).upper())
        s = s[4:] if s.startswith("GATE") else s
        return re.sub(r"^([A-Z]*)0+(\d)", r"\1\2", s)
    return f"{str(code or '').strip().upper()}|{g(g1)}|{g(g2)}"


def nav_lookup(pairs, args=()):
    """The map's minutes for [(code, g1, g2), ...] from node updater/navwalk.mjs, in the
    same order: a number, None where the map has no answer (a gate it does not know, no
    route), or False where nav.js failed on that pair. Raises WalkError (or a timeout)
    when the helper does not answer. Gates go on stdin; its stderr is never printed in
    public logs. args: extra navwalk.mjs options (tests point it at a made-up map)."""
    exe = node()
    if not NAVWALK.is_file():
        raise WalkError("navwalk.mjs missing")
    if not (shutil.which(exe) or Path(exe).is_file()):
        raise WalkError("node not found")
    env = dict(os.environ, **({"PUBLIC": "1"} if PUBLIC else {}))
    r = subprocess.run([exe, str(NAVWALK), *args], input=json.dumps({"pairs": [list(p) for p in pairs]}),
                       capture_output=True, text=True, timeout=WALK_TIMEOUT, env=env, cwd=str(ROOT))
    if r.returncode:
        say(f"alerts: navwalk.mjs exited {r.returncode}", first_line(r.stderr))
        raise WalkError(f"exit {r.returncode}")
    doc = last_json(r.stdout)
    m = doc.get("m") if isinstance(doc, dict) and doc.get("v") == 1 else None
    if not isinstance(m, list) or len(m) != len(pairs):
        raise WalkError("no result")
    bad = {i for i in doc.get("err") or [] if isinstance(i, int)}
    return [False if i in bad else v for i, v in enumerate(m)]


class Walker:
    """The nav that decide() gets from step(): the map's walking minutes per gate pair.
    It answers from status.alerts.walk (while map_fp() still matches) and notes the
    pairs it lacks; fetch() then asks the lookup about those, once. Until it has an
    answer for a pair it says None, and walk() falls back to the concourse guess."""

    def __init__(self, saved=None, lookup=None):
        self.fp = map_fp()
        ok = isinstance(saved, dict) and self.fp and saved.get("fp") == self.fp
        self.m = dict(saved.get("m") or {}) if ok else {}  # saved: load_state()'s checked copy
        self.lookup = lookup
        self.used, self.miss = [], {}
        self.asked = False
        self.error = None  # why the call failed (a fixed phrase), for summary()

    def __call__(self, code, g1, g2):
        k = gate_key(code, g1, g2)
        if k not in self.used:
            self.used.append(k)
        if k in self.m:
            return self.m[k]
        self.miss.setdefault(k, (str(code or "").strip().upper(), str(g1), str(g2)))
        return None

    def fetch(self):
        """One lookup for the pairs missed so far (not again this run, and not within
        WALK_RETRY of a failure). True when it brought new map minutes."""
        global _walk_retry
        if self.asked or not self.miss or not self.fp or time.monotonic() < _walk_retry:
            return False
        self.asked = True
        keys = list(self.miss)[:WALK_ASK]
        try:
            got = (self.lookup or nav_lookup)([self.miss[k] for k in keys])
            if not isinstance(got, list) or len(got) != len(keys):
                raise WalkError("no result")
        except subprocess.TimeoutExpired:
            self.error = "timed out"
        except WalkError as e:
            self.error = str(e)
        except Exception as e:  # never more than a guessed walk
            self.error = type(e).__name__
        if self.error:
            _walk_retry = time.monotonic() + WALK_RETRY
            return False
        new = False
        for k, v in zip(keys, got):
            if v is None or nav_min(v):
                self.m[k] = v
                new = new or v is not None
            else:  # nav.js failed on this pair: the guess for now, ask again later
                _walk_retry = time.monotonic() + WALK_RETRY
        return new

    def state(self):
        """status.alerts.walk: this run's pairs first, then the latest others, at most
        WALK_KEEP; None when there is nothing worth keeping."""
        keys = self.used + [k for k in self.m if k not in self.used]
        m = [(k, self.m[k]) for k in keys if k in self.m][:WALK_KEEP]
        return {"fp": self.fp, "m": dict(m)} if self.fp and m else None


# ---------- one run ----------

def undelivered(res):
    """Every phone failed for a reason worth retrying (not gone, not a timeout)."""
    devs = res.get("devices") or []
    return bool(devs) and not res.get("sent") and any(not d["ok"] and not d.get("gone") for d in devs)


def record_devices(old, res, ids, now):
    """status.alerts.devices: [{id, ok, at}], at = the last delivery that worked."""
    prev = {d["id"]: d for d in old}
    if "devices" in res:  # push.mjs answered: these are all the phones
        out = []
        for d in res["devices"]:
            e = dict(prev.get(d["id"]) or {"id": d["id"], "ok": None, "at": None})
            e["ok"] = d["ok"]
            if d["ok"]:
                e["at"] = fs.iso_utc(now)
            out.append(e)
    elif ids is not None:
        out = [prev.get(i) or {"id": i, "ok": None, "at": None} for i in ids]
    else:
        out = old
    return out[:MAX_DEVICES]


def step(prev_status, status, legs, now, push=True, walks=None):
    """decide, send and record: the status.alerts to store in the new status.
    run.py calls it once per iteration, with the status the last iteration wrote.
    push=False (test runs with made-up legs or a simulated clock) decides and
    records the same way but sends nothing.
    Walks: decide() runs with the minutes status.alerts.walk remembers; when it met gate
    pairs without them, one navwalk.mjs call (walks(pairs) in tests: nav_lookup's
    contract) asks about those and decide() runs again with the answers. While that
    call fails, the walks are concourse guesses, as before."""
    global _last
    old = load_state((prev_status or {}).get("alerts") if isinstance(prev_status, dict) else None)
    nav = None
    try:
        nav = Walker(old.get("walk"), walks)
        msgs, state = decide(prev_status, status, legs, now, old, nav)
        if nav.fetch():  # decide() is pure, so the second pass starts from the same state
            msgs, state = decide(prev_status, status, legs, now, old, nav)
        state.pop("walk", None)
        if nav.state():
            state["walk"] = nav.state()
    except Exception as e:  # a bug here must never cost a status run
        _last = {"due": 0, "error": type(e).__name__, "walk": nav and nav.error}
        say("alerts: decide failed", repr(e))
        return old
    if not msgs:
        res = {}
    elif push:
        res = send(msgs, PUBLIC)
    else:
        res = {"sent": 0, "failed": 0, "gone": 0, "skipped": "dry run"}
    if undelivered(res):
        # Nobody got them: keep the old baseline so the next run decides them again.
        state["seen"], state["sent"] = old["seen"], old["sent"]
    ids = None if msgs or not push else device_ids()
    state["devices"] = record_devices(old["devices"], res, ids, now)
    if res.get("sent"):
        state["last"] = fs.iso_utc(now)
    _last = {"due": len(msgs), "sent": res.get("sent", 0), "failed": res.get("failed", 0),
             "gone": res.get("gone", 0), "reached": sum(1 for d in res.get("devices") or [] if d["ok"]),
             "devices": len(state["devices"]), "skipped": res.get("skipped"), "error": res.get("error"),
             "retry": undelivered(res), "walk": nav.error}
    return state


def summary():
    """This run's alerts as one counts-only line (safe for public logs)."""
    c = _last
    if not c:
        return "alerts: not run"
    # A failed map lookup (a fixed phrase): this run's walks were concourse guesses.
    tail = f"; walks guessed ({c['walk']})" if c.get("walk") else ""
    n = c.get("devices", 0)
    phones = f"{n} device{'' if n == 1 else 's'}"
    if c.get("error") and not c.get("due"):
        return f"alerts: failed ({c['error']})" + tail
    if not c.get("due"):
        return f"alerts: none due; {phones}" + tail
    s = f"alerts: {c['due']} due"
    if c.get("skipped"):
        return f"{s}, not sent ({c['skipped']})" + tail
    if c.get("error"):
        return f"{s}, push failed ({c['error']})" + tail
    s += f", {c['sent']} delivered to {c['reached']} of {phones}"
    if c.get("failed") or c.get("gone"):
        s += f"; {c['failed']} failed, {c['gone']} gone"
    return s + ("; will retry" if c.get("retry") else "") + tail
