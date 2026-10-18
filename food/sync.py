#!/usr/bin/env python3
"""Keep the app's food bundle in step with the Yelp collection (the source of truth).

  python3 -I food/sync.py [sync] [--dry-run] [--current FILE] [--no-details] ...
  python3 -I food/sync.py pending      # aliases that still need a browser read (Mac path)
  python3 -I food/sync.py finalize     # after assemble.mjs: keep membership, re-seal (Mac path)
  python3 -I food/sync.py ai-needed    # list places without food/ai/<alias>.json in food/ai_needed.json

sync (default):
  1. reads the collection with yelp_fetch.py's own code (curl, no browser);
  2. opens the current docs/data/food.bin with tools/tripcrypt.mjs (falls back to
     food/food.json, food/base.json, food/raw/collection.json when there is no bundle yet);
  3. diffs aliases: new places get a provisional record (collection + map + menu data,
     heuristic categories, "pending_details": true); removed places are dropped and
     remembered in the bundle's "tombstones" list and in food/sync_report.json;
  4. writes food/food.json and re-seals docs/data/food.bin, or prints "no changes".

Exit codes: 0 ok (changed or not), 1 error, 2 usage, 75 Yelp blocked or unreachable
(soft: the CI job turns it into a warning). Under GitHub Actions place names are kept
out of the log (the repo may be public); counts only.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse

sys.dont_write_bytecode = True  # no food/__pycache__ next to the data
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TRIPCRYPT = os.path.join(ROOT, "tools", "tripcrypt.mjs")
ASSEMBLE = os.path.join(HERE, "assemble.mjs")
AI_NEEDED = os.path.join(HERE, "ai_needed.json")  # gitignored (food/*.json)
EX_BLOCKED = 75
IN_CI = os.environ.get("GITHUB_ACTIONS") == "true"

# Removal guards: a short or broken listing must never empty the app.
MAX_UNVERIFIED_REMOVALS = 3     # removals allowed when Yelp's "N Places" count can't be read
MASS_REMOVAL_SHARE = 0.5        # refuse to drop more than this share of places in one run
TOMBSTONE_CAP = 50


class Blocked(Exception):
    """Yelp refused us (403/429/challenge), had a 5xx, or the network failed; retry later."""


class Fail(Exception):
    """Anything that needs a person to look (bad key, markup change, ...)."""


def load_yelp_fetch():
    # Loaded by path: under `python3 -I` the script's directory is not on sys.path.
    spec = importlib.util.spec_from_file_location("yelp_fetch", os.path.join(HERE, "yelp_fetch.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # The collection id is a private term (tools/scan_public.py refuses it in committed
    # files), so CI passes it as the YELP_COLLECTION secret; on the Mac it comes from
    # .secrets/yelp_collection.txt (yelp_fetch.py reads either).
    mod.COLLECTION = os.environ.get("YELP_COLLECTION", "").strip() or getattr(mod, "COLLECTION", "")
    return mod


yf = load_yelp_fetch()


def now_iso():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today(now=None):
    """Calendar date in New York for added_at/removed_at, whatever the machine's zone
    (the Mac may be on Phoenix time, UTC−7 all year; the runner is on UTC)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return now.astimezone(ZoneInfo("America/New_York")).date().isoformat()
    except Exception:  # no tz database: US Eastern rule, DST 2nd Sun Mar 07:00Z to 1st Sun Nov 06:00Z
        def sunday(month, nth):
            first = dt.datetime(now.year, month, 1, tzinfo=dt.timezone.utc)
            return first + dt.timedelta(days=(6 - first.weekday()) % 7 + 7 * (nth - 1))
        dst = sunday(3, 2) + dt.timedelta(hours=7) <= now < sunday(11, 1) + dt.timedelta(hours=6)
        return (now + dt.timedelta(hours=-4 if dst else -5)).date().isoformat()


def name_key(p):
    """Sort key close to assemble.mjs's localeCompare(..., {sensitivity: 'base'}); ties
    keep their input order (stable sort), as in assemble.mjs."""
    s = unicodedata.normalize("NFKD", p.get("name") or p["id"])
    return "".join(c for c in s if not unicodedata.combining(c)).casefold()


def rel(path):
    """Project-relative path for messages; absolute when outside the project."""
    r = os.path.relpath(path, ROOT)
    return path if r.startswith("..") else r


def log(msg):
    print(msg, flush=True)


def warn(msg):
    # GitHub turns "::warning::" lines into annotations; locally it is just a prefix.
    print(("::warning::" if IN_CI else "warning: ") + msg, flush=True)


# ---------------------------------------------------------------- Yelp collection

def looks_blocked(status, body):
    # 0 = curl failed (DNS, timeout); 5xx = Yelp having a bad minute. All worth a retry later.
    if status in (0, 403, 429) or 500 <= status <= 599:
        return True
    head = body[:4000].lower()
    return any(k in head for k in ("captcha", "datadome", "verify you are", "unusual activity",
                                   "access denied", "enable js and disable"))


def fetch_collection():
    """Run yelp_fetch.read_collection() but watch every request it makes, so a page
    that failed half-way (which read_collection quietly treats as the end) is caught."""
    if not yf.COLLECTION:
        raise Fail("no Yelp collection id: set YELP_COLLECTION (a repository secret in CI)")
    calls = []
    real_get = yf.get

    def watched(url, xhr=False):
        st, body = real_get(url, xhr)
        calls.append((st, body.lstrip()[:1] == "{", body))
        return st, body

    yf.get = watched
    try:
        places = yf.read_collection()
    except SystemExit:
        st, _, body = calls[-1] if calls else (0, False, "")
        if looks_blocked(st, body):
            raise Blocked("collection: HTTP %s%s" % (st, " (challenge page)" if st == 200 else ""))
        raise Fail("collection: unexpected reply (HTTP %s)" % st)
    finally:
        yf.get = real_get
    st, is_json, body = calls[-1]
    if st != 200 or not is_json:
        # read_collection stopped on a failed page, not on the empty page after the last item
        if looks_blocked(st, body):
            raise Blocked("collection page %d: HTTP %s" % (len(calls), st))
        raise Fail("collection page %d failed: HTTP %s" % (len(calls), st))
    if not places:
        raise Fail("collection parsed to 0 places: Yelp markup may have changed")
    return places


def collection_count():
    """Yelp's own "80 Places" header, used to verify the listing before removing places."""
    st, body = yf.get("https://www.yelp.com/collection/%s" % yf.COLLECTION)
    if st != 200:
        return None
    m = re.search(r">\s*(\d+)\s+Places?\s*<", body)
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------- crypto (tripcrypt.mjs only)

def open_bin(path):
    r = subprocess.run(["node", TRIPCRYPT, "open", path], capture_output=True)
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", "replace")
        line = next((x for x in err.splitlines() if "Error" in x), err.strip()[-200:])
        raise Fail("could not open %s: %s" % (rel(path), line.strip()))
    return json.loads(r.stdout)


def seal(json_path, bin_path):
    """Seal to a temp file, prove it opens to the same places, then swap it in.
    Returns False (and writes nothing) when the bin already holds exactly this content:
    a fresh IV changes every byte, so phones would re-download an unchanged list and
    git would see a change (same rule as app/build.mjs sealIfChanged). collected_at is
    left out of the comparison: assemble.mjs takes it from raw/collection.json's fetch
    time, which every sync refreshes even when nothing in the list changed."""
    doc = read_json(json_path)
    stable = lambda d: {k: v for k, v in d.items() if k != "collected_at"}
    if os.path.exists(bin_path):
        try:
            held = open_bin(bin_path)
            if stable(held) == stable(doc):
                if json.dumps(held) != json.dumps(doc):
                    write_json(json_path, held)  # mirror the bin, so app/build.mjs sees no change either
                return False
        except Fail:
            pass  # unreadable with this key: replace it
    os.makedirs(os.path.dirname(bin_path) or ".", exist_ok=True)
    tmp = bin_path + ".tmp"
    r = subprocess.run(["node", TRIPCRYPT, "seal", json_path, tmp], capture_output=True)
    if r.returncode != 0:
        raise Fail("seal failed: " + r.stderr.decode("utf-8", "replace").strip()[-200:])
    if open_bin(tmp) != doc:
        os.remove(tmp)
        raise Fail("sealed bundle did not round-trip")
    os.replace(tmp, bin_path)
    return True


# ---------------------------------------------------------------- files

def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    # keep the .json suffix so a crash leaves the temp file under the food/*.json ignore rule
    tmp = path[:-5] + ".tmp.json" if path.endswith(".json") else path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def load_current(args):
    """Return (bundle, source_label, is_bundle). A collection.json is not an app bundle:
    its records are converted to provisional ones only if we end up writing."""
    if args.current:
        cands = [args.current]
    elif getattr(args, "require_bin", False):
        cands = [args.bin]
    else:
        cands = [args.bin, args.out_json, os.path.join(HERE, "base.json"),
                 os.path.join(args.raw, "collection.json")]
    for path in cands:
        if not path or not os.path.exists(path):
            continue
        data = open_bin(path) if path.endswith(".bin") else read_json(path)
        if not isinstance(data, dict) or not isinstance(data.get("places"), list):
            raise Fail("%s has no places list" % path)
        first = data["places"][0] if data["places"] else {"style": None}
        is_bundle = any(k in first for k in ("style", "types", "cuisine"))
        return data, rel(path), is_bundle
    if args.current:
        raise Fail("--current %s not found" % args.current)
    return None, None, True


# ---------------------------------------------------------------- provisional records
# Heuristics only: enough to file a new place under the right chips until the Mac
# path (browser read + assemble + AI notes) replaces the record.

BAR = {"bars", "cocktailbars", "wine_bars", "beerbar", "pubs", "divebars", "sportsbars",
       "speakeasies", "lounges", "tikibars", "whiskeybars", "beergardens", "champagne_bars",
       "hotel_bar", "irish_pubs", "gaybars", "brewpubs", "sakebars"}
MARKET = {"food_court", "publicmarkets", "farmersmarket", "markets", "grocery", "gourmet",
          "intlgrocery", "foodhalls"}
SWEET = {"desserts", "icecream", "gelato", "cupcakes", "chocolate", "donuts", "macarons",
         "shavedice", "frozenyogurt", "candy", "cakeshop", "customcakes", "creperies"}
COFFEE = {"coffee", "coffeeroasteries", "tea", "bubbletea", "cafes", "juicebars"}
BAKERY = {"bakeries", "bagels", "patisserie"}
# Places where you order at a counter and usually walk off with it.
COUNTER = COFFEE - {"cafes"} | SWEET | BAKERY | {
    "delis", "sandwiches", "streetvendors", "foodtrucks", "falafel", "hotdogs", "foodstands",
    "empanadas", "pretzels", "halal", "kebab", "acaibowls", "poke", "salad"}
BRUNCH = {"breakfast_brunch", "pancakes", "waffles", "diners"}
SITDOWN_HINT = {"newamerican", "french", "italian", "tuscan", "steak", "seafood", "spanish",
                "tapasmallplates", "sushi", "brasseries", "bistros", "wine_bars", "peruvian"}
NOT_CUISINE = {"restaurants", "venues", "food_court", "streetvendors", "foodtrucks",
               "eventservices", "hotels"} | BAR
PRICE_TIER = {"$": "under $10", "$$": "$11–30", "$$$": "$31–60", "$$$$": "$61+"}  # Yelp's own bands


def zip_borough(address, city):
    z = re.search(r"\b(1\d{4})\b", address or "")
    if z:
        p = z.group(1)[:3]
        if p in ("100", "101", "102"):
            return "Manhattan"
        if p == "103":
            return "Staten Island"
        if p == "104":
            return "Bronx"
        if p == "112":
            return "Brooklyn"
        if p in ("110", "111", "113", "114", "116"):
            return "Queens"
    c = (city or "").split(",")[0].strip()
    return {"New York": "Manhattan", "Brooklyn": "Brooklyn", "Staten Island": "Staten Island",
            "Bronx": "Bronx"}.get(c, c or None)


def categorize(cats, price):
    """Yelp category aliases (primary first) + price -> style, types, meals, cuisine-ish flags."""
    s = set(cats)
    food = s - BAR - COFFEE - SWEET - BAKERY - {"restaurants", "venues"}
    if s & MARKET:
        style = "market"
    elif s & BAR and not food - BAR:
        style = "bar"
    elif s <= COUNTER or (price == "$" and s & (COUNTER | {"pizza"})) or (cats and cats[0] in SWEET | BAKERY):
        style = "counter"
    elif price in ("$$$", "$$$$") or (price == "$$" and s & SITDOWN_HINT):
        style = "sit-down"
    else:
        style = "casual"

    types = {"sit-down": ["sit-down"], "casual": ["casual"], "counter": ["to-go", "quick-bite"],
             "bar": ["bar"], "market": ["casual", "to-go", "groups"]}[style][:]
    tag = lambda t: t not in types and types.append(t)
    if s & (COFFEE - {"juicebars"}):
        tag("coffee")
    if s & BAKERY:
        tag("bakery")
    if s & SWEET:
        tag("dessert")
    if s & BAR:
        tag("bar")
    if s & BRUNCH:
        tag("brunch")
    if "pizza" in s:
        tag("pizza")
    if s & {"sandwiches", "delis"}:
        tag("sandwiches")

    meals = []
    morning = s & (COFFEE | BAKERY | BRUNCH | {"delis"})
    if morning:
        meals.append("breakfast")
    if s & BRUNCH:
        meals.append("brunch")
    if food or s & (BAKERY | COFFEE | SWEET) or style == "market":
        meals.append("lunch")
    if (food and not food <= BRUNCH | {"sandwiches", "delis"}) or s & (BAR | SWEET):
        meals.append("dinner")
    if s & BAR:
        meals.append("late")
    return style, types, meals or ["lunch", "dinner"]


def dollars(p):
    """Menu price ("14", "14.5", "$14.00") -> "$14" / "$14.50"; None when not a number."""
    try:
        v = float(str(p).lstrip("$").replace(",", ""))
    except (TypeError, ValueError):
        return None
    return "$%d" % v if v == int(v) else "$%.2f" % v


def popular_from_menu(menu):
    """Most-reviewed menu items (yelp_fetch keeps [reviews, photos] per item)."""
    seen, items = set(), []
    for sec in menu or []:
        for it in sec.get("items") or []:
            n = it.get("n")
            if not n or n in seen:
                continue
            seen.add(n)
            pop = it.get("pop") or [0, 0]
            items.append((pop[0] + pop[1], n, it.get("p")))
    items.sort(key=lambda x: -x[0])
    out = []
    for score, n, p in items[:5]:
        if score <= 0:
            break
        rec = {"name": n}
        if dollars(p):
            rec["note"] = dollars(p)
        out.append(rec)
    return out


def ascii_url(u):
    """Percent-encode a non-ASCII URL (menu/bāng-bar-...), like assembled records have."""
    return urllib.parse.quote(u, safe=":/?#[]@!$&'()*+,;=%~") if u and not u.isascii() else u


def price_band(popular, price, style):
    """Per-person estimate until AI notes arrive. Where one item is the meal (counter,
    casual, bar, market), the median popular item beats Yelp's dated "$" band ("under
    $10" for a $15 bowl); the median ignores the odd party tray or whole pie. For
    sit-down places (several items each) the band is the safer guess."""
    vals = [float(x["note"][1:]) for x in popular if re.fullmatch(r"\$\d+(\.\d+)?", x.get("note") or "")]
    if style != "sit-down" and len(vals) >= 3:
        return "about $%d" % max(1, round(statistics.median(vals)))
    return PRICE_TIER.get(price)


def provisional(raw, added_at):
    """App-shaped record (CONTRACT food bundle) from collection + map + menu data."""
    cats = [c["alias"] for c in raw.get("yelp_categories") or []]
    titles = [c["title"] for c in raw.get("yelp_categories") or []]
    style, types, meals = categorize(cats, raw.get("price"))
    cuisine = [t for c, t in zip(cats, titles) if c not in NOT_CUISINE] or titles
    cover = raw.get("cover_photo")
    popular = popular_from_menu(raw.get("menu"))
    return {
        "id": raw["id"], "name": raw.get("name") or raw["id"], "yelp": raw.get("yelp"),
        "rating": raw.get("rating"), "reviews": raw.get("reviews"), "price": raw.get("price"),
        "cuisine": cuisine, "style": style, "types": types, "meals": meals,
        "neighborhood": raw.get("neighborhood"),
        "borough": zip_borough(raw.get("address"), raw.get("city")),
        "address": raw.get("address"), "lat": raw.get("lat"), "lon": raw.get("lon"),
        "phone": None, "website": None, "menu": ascii_url(raw.get("menu_url")),
        "hours": [], "hours_note": "Hours not loaded yet; check Yelp",
        "attrs": {},
        "photos": {"food": [{"id": cover, "cap": raw.get("name") or ""}] if cover else [], "inside": []},
        "summary": None, "loved": [], "watch": [], "order": [], "tips": [],
        "vibe": None, "wait": None, "good_for": [],
        "price_per_person": price_band(popular, raw.get("price"), style),
        "popular": popular,
        "menu_sections": [s["name"] for s in raw.get("menu") or [] if s.get("name")],
        "pending_details": True, "added_at": added_at,
    }


def assemble_hook():
    """Classify new places with assemble.mjs itself, so they are filed exactly like the
    assembled ones. assemble.mjs reads <its dir>/raw and writes <its dir>/base.json and
    food.json, so a copy runs in a temp dir that holds only the new places; nothing under
    food/ is touched. Returns a callable, or None when there is no assemble.mjs."""
    if not os.path.exists(ASSEMBLE):
        return None

    def run(raws):
        with tempfile.TemporaryDirectory(prefix="food-asm-") as tmp:
            shutil.copy(ASSEMBLE, os.path.join(tmp, "assemble.mjs"))
            write_json(os.path.join(tmp, "raw", "collection.json"),
                       {"collection": yf.COLLECTION, "fetched_at": int(time.time()), "places": raws})
            for r in raws:
                write_json(os.path.join(tmp, "raw", "biz", r["id"] + ".json"), r)
            # --merge builds base.json first, then emits contract-shaped food.json
            r = subprocess.run(["node", os.path.join(tmp, "assemble.mjs"), "--merge"],
                               cwd=tmp, capture_output=True, timeout=120)
            if r.returncode != 0:
                raise RuntimeError(r.stderr.decode("utf-8", "replace").strip()[-300:])
            out = read_json(os.path.join(tmp, "food.json"))
        by_id = {p["id"]: p for p in out.get("places", [])}
        return [by_id.get(r["id"]) for r in raws]
    return run


def build_new(raws, added_at):
    """Provisional records for new places: assemble.mjs's when it runs, with gaps (no page
    capture yet: hours note, cover photo, price band) filled from the built-in fallback."""
    recs = [provisional(r, added_at) for r in raws]
    hook = assemble_hook()
    if not (hook and raws):
        return recs
    try:
        assembled = hook(raws)
    except Exception as e:  # the fallback categories are fine; say why we used them
        # assemble's stderr can name places: keep it out of CI logs
        warn("assemble.mjs failed on new places, using built-in categories%s"
             % ("" if IN_CI else " (%s)" % str(e)[:160]))
        return recs
    out = []
    for rec, asm in zip(recs, assembled):
        if not asm:
            out.append(rec)
            continue
        merged = dict(asm)
        # assemble's menu fallback keeps bare prices ("14"); the app would show "14"
        merged["popular"] = [dict(x, note=dollars(x["note"]) or x["note"]) if x.get("note") else x
                             for x in merged.get("popular") or []]
        if not merged.get("price_per_person"):
            merged["price_per_person"] = price_band(merged["popular"], merged.get("price"), merged.get("style"))
        for k in ("yelp", "menu", "website"):
            merged[k] = ascii_url(merged.get(k))
        for k, v in rec.items():
            if merged.get(k) in (None, "", [], {}) and v not in (None, "", [], {}):
                merged[k] = v
        if not merged.get("photos", {}).get("food") and rec["photos"]["food"]:
            merged["photos"] = dict(merged.get("photos") or {}, food=rec["photos"]["food"])
        # Without a page capture assemble.mjs takes the map-page address and strips a
        # leading "<n> " before a digit, which also eats house numbers ("383 8th Ave").
        # Keep the scraped one unless it really has a doubled number ("2 205 E Houston St").
        if rec["address"] and not re.match(r"\d+ \d+\s", rec["address"]):
            merged["address"] = rec["address"]
        if not merged.get("hours"):  # not "not listed": we have not read the page yet
            merged["hours_note"] = rec["hours_note"]
        merged.update(pending_details=True, added_at=added_at)
        out.append(merged)
    return out


def fetch_details(p, raw_dir, use_cache=True):
    """Collection entry -> raw biz record with map (address, neighborhood) and menu data.
    Reuses food/raw/biz/<alias>.json when present; saves new ones there (Mac path reads them)."""
    fn = os.path.join(raw_dir, "biz", p["id"] + ".json")
    if use_cache and os.path.exists(fn):
        rec = read_json(fn)
        rec.update({k: v for k, v in p.items() if v is not None})  # collection data is fresher
        return rec, False
    rec = dict(p)
    for step in (yf.read_map, yf.read_menu):
        try:
            rec.update(step(p["id"]))
        except Exception as e:  # one bad page must not sink the sync
            rec[step.__name__ + "_error"] = str(e)[:120]
        time.sleep(1.2)
    return rec, True


# ---------------------------------------------------------------- reporting

def gh_output(**kv):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            for k, v in kv.items():
                f.write("%s=%s\n" % (k, v))


def gh_summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("\n".join(lines) + "\n")


def names(recs, show):
    if not show:
        return ""
    return ", ".join("%s (%s)" % (r.get("name"), r["id"]) for r in recs) or "none"


# ---------------------------------------------------------------- commands

def cmd_sync(args):
    show = args.log_names
    tag = "[dry-run] " if args.dry_run else ""
    cur, cur_src, is_bundle = load_current(args)
    if cur is None and args.require_bin:
        warn("no %s yet: run the Mac path (food/enrich_mac.sh) once first" % rel(args.bin))
        gh_output(changed="false", added=0, removed=0)
        return 0
    cur = cur or {"schema": 1, "source": "yelp collection", "places": []}
    cur_ids = [p["id"] for p in cur["places"]]
    log("current: %d places from %s" % (len(cur_ids), cur_src or "nothing (first run)"))

    listed = fetch_collection()
    by_id = {p["id"]: p for p in listed}
    log("collection: %d places" % len(listed))

    added = [p for p in listed if p["id"] not in set(cur_ids)]
    removed = [p for p in cur["places"] if p["id"] not in by_id]
    skipped = []
    if removed:
        # A removal is only trusted when the listing is provably complete.
        total = collection_count()
        if total is not None and total != len(listed):
            warn("Yelp says %d places but listed %d; keeping %d place(s) for now"
                 % (total, len(listed), len(removed)))
            skipped, removed = removed, []
        elif total is None and len(removed) > MAX_UNVERIFIED_REMOVALS:
            warn("could not verify the collection size; not removing %d places" % len(removed))
            skipped, removed = removed, []
        elif len(removed) > MASS_REMOVAL_SHARE * max(len(cur_ids), 1) and not args.allow_mass_removal:
            warn("%d of %d places would be removed; rerun with --allow-mass-removal if intended"
                 % (len(removed), len(cur_ids)))
            skipped, removed = removed, []

    if not added and not removed:
        log("%sfood sync: no changes (%d places)" % (tag, len(cur_ids)))
        gh_output(changed="false", added=0, removed=0)
        if not args.dry_run and not skipped:
            write_json(os.path.join(args.raw, "collection.json"),
                       {"collection": yf.COLLECTION, "fetched_at": int(time.time()), "places": listed})
        return 0

    # New places: everything curl can get, then a provisional record.
    raws, fetched = [], 0
    for i, p in enumerate(added):
        if args.no_details:
            raws.append(dict(p))
            continue
        rec, net = fetch_details(p, args.raw, use_cache=not args.refresh)
        fetched += net
        raws.append(rec)
        log("  + %s%s" % (p["id"] if show else "place %d" % (i + 1),
                          " | %s | menu=%s" % (rec.get("address"), len(rec.get("menu") or []) or rec.get("menu_status"))
                          if show else ""))
        if net and not args.dry_run:
            write_json(os.path.join(args.raw, "biz", p["id"] + ".json"), rec)
    new_recs = build_new(raws, today())

    # Existing records stay as they are (they may carry assembled details and AI notes).
    if is_bundle:
        keep = {p["id"]: p for p in cur["places"]}
    else:
        # Current was a raw collection (no bundle yet): kept places get provisional
        # records too, from raw/biz when it is on disk; no extra network requests.
        raws_kept = []
        for p in cur["places"]:
            if p["id"] in by_id:
                biz = os.path.join(args.raw, "biz", p["id"] + ".json")
                raws_kept.append(fetch_details(by_id[p["id"]], args.raw)[0] if os.path.exists(biz)
                                 else dict(by_id[p["id"]]))
        keep = {r["id"]: r for r in build_new(raws_kept, None)}
    gone = {p["id"] for p in removed}
    # Name order, like assemble.mjs, so a later finalize does not reshuffle the list.
    places = sorted(new_recs + [keep[i] for i in cur_ids if i in keep and i not in gone], key=name_key)

    tombs = [t for t in cur.get("tombstones") or [] if t.get("id") not in by_id]
    tombs = ([{"id": p["id"], "name": p.get("name"), "removed_at": today()} for p in removed] + tombs)[:TOMBSTONE_CAP]
    bundle = dict(cur) if is_bundle else {}  # a raw collection's own keys don't belong in the bundle
    bundle.update({"schema": 1, "source": bundle.get("source") or "yelp collection",
                   "collected_at": now_iso(), "places": places, "tombstones": tombs})

    report = {"at": now_iso(), "dry_run": args.dry_run, "current_source": cur_src,
              "collection": len(listed), "before": len(cur_ids), "after": len(places),
              "added": [{"id": r["id"], "name": r["name"], "cuisine": r["cuisine"], "style": r["style"],
                         "types": r["types"], "meals": r["meals"], "address": r["address"],
                         "pending_details": True} for r in new_recs],
              "removed": [{"id": p["id"], "name": p.get("name")} for p in removed],
              "kept_unverified": [{"id": p["id"], "name": p.get("name")} for p in skipped],
              "tombstones": tombs, "detail_fetches": fetched}

    line = "%sfood sync: +%d/−%d → %d places" % (tag, len(new_recs), len(removed), len(places))
    if show:
        line += " | added: %s | removed: %s" % (names(new_recs, True), names(removed, True))
    if args.dry_run:
        if args.show:
            print(json.dumps(new_recs, indent=1, ensure_ascii=False))
        log(line)
        gh_output(changed="false", added=len(new_recs), removed=len(removed))
        return 0

    if os.path.exists(args.out_json):  # one step of undo for a hand-assembled file
        os.replace(args.out_json, args.out_json[:-5] + ".prev.json")
    write_json(args.out_json, bundle)
    seal(args.out_json, args.bin)  # always writes here: membership changed
    write_json(os.path.join(args.raw, "collection.json"),
               {"collection": yf.COLLECTION, "fetched_at": int(time.time()), "places": listed})
    write_json(args.report, report)
    log(line)
    log("wrote %s and %s; report %s" % tuple(rel(x) for x in (args.out_json, args.bin, args.report)))
    gh_output(changed="true", added=len(new_recs), removed=len(removed))
    gh_summary(["### Food sync", "", "+%d / −%d → %d places (new ones marked pending details)"
                % (len(new_recs), len(removed), len(places))])
    return 0


def cmd_pending(args):
    """Aliases without a browser read in food/raw/page (comma list for yelp_browser --only)."""
    cur, _, _ = load_current(args)
    ids = [p["id"] for p in (cur or {}).get("places", [])
           if p.get("pending_details") or not os.path.exists(os.path.join(args.raw, "page", p["id"] + ".json"))]
    print(",".join(ids))
    return 0


def ai_needed(places):
    """Places with no food/ai/<alias>.json yet (the Claude scheduled task writes those)."""
    return [{"id": p["id"], "name": p.get("name")} for p in places
            if not os.path.exists(os.path.join(HERE, "ai", p["id"] + ".json"))]


def cmd_ai_needed(args):
    """Write food/ai_needed.json from the current bundle; works before assemble.mjs exists."""
    cur, src, _ = load_current(args)
    need = ai_needed((cur or {}).get("places", []))
    if not args.dry_run:
        write_json(AI_NEEDED, {"at": now_iso(), "places": need})
    log("%d place(s) need AI notes%s" % (len(need), "" if args.dry_run else " (%s)" % rel(AI_NEEDED)))
    return 0


def cmd_finalize(args):
    """Merge assemble.mjs output (food/food.json) with the bundle's membership and metadata,
    flag places still missing browser data or AI notes, and seal docs/data/food.bin."""
    if not os.path.exists(args.out_json):
        raise Fail("%s not found: run node food/assemble.mjs first" % rel(args.out_json))
    asm = read_json(args.out_json)
    # Membership baseline: --current (enrich_mac.sh passes a pre-assemble snapshot, in case
    # assemble.mjs re-sealed food.bin itself), else the bundle on disk.
    base = args.current or args.bin
    if args.current and not os.path.exists(base):
        raise Fail("--current %s not found" % args.current)
    cur = (open_bin(base) if base.endswith(".bin") else read_json(base)) if os.path.exists(base) else None
    asm_by = {p["id"]: p for p in asm.get("places", [])}
    if cur:
        cur_by = {p["id"]: p for p in cur["places"]}
        tomb = {t["id"] for t in cur.get("tombstones") or []}
        extra = [i for i in asm_by if i not in cur_by]
        if extra:
            warn("%d assembled place(s) are not in the bundle%s; run sync first to add them"
                 % (len(extra), " (removed earlier)" if set(extra) <= tomb else ""))
        # places assemble did not produce keep their current (provisional) record
        missing = {p["id"] for p in cur["places"] if p["id"] not in asm_by}
        places = sorted([p for p in cur["places"] if p["id"] in missing] +
                        [asm_by[i] for i in asm_by if i in cur_by], key=name_key)
        for p in places:
            old = cur_by.get(p["id"], {})
            if old.get("added_at"):
                p["added_at"] = old["added_at"]
    else:
        places, missing = list(asm_by.values()), set()
    for p in places:
        if p["id"] not in missing and os.path.exists(os.path.join(args.raw, "page", p["id"] + ".json")):
            p.pop("pending_details", None)
        else:
            p["pending_details"] = True
    bundle = dict(asm)
    for k, v in (cur or {}).items():  # keep sync metadata (collected_at, ...) assemble lacks
        bundle.setdefault(k, v)
    bundle.update({"places": places, "tombstones": (cur or {}).get("tombstones") or asm.get("tombstones") or []})
    need_ai = ai_needed(places)
    pend = [p["id"] for p in places if p.get("pending_details")]
    if args.dry_run:
        log("[dry-run] finalize: %d places, %d pending details, %d need AI notes" % (len(places), len(pend), len(need_ai)))
        return 0
    write_json(AI_NEEDED, {"at": now_iso(), "places": need_ai})
    write_json(args.out_json, bundle)
    sealed = seal(args.out_json, args.bin)
    log("finalize: %d places, %s %s; %d pending details, %d need AI notes (food/ai_needed.json)"
        % (len(places), "sealed to" if sealed else "unchanged:", rel(args.bin), len(pend), len(need_ai)))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", nargs="?", default="sync", choices=["sync", "pending", "finalize", "ai-needed"])
    ap.add_argument("--dry-run", action="store_true", help="fetch and diff, write nothing")
    ap.add_argument("--current", help="compare against this .bin/.json instead of the usual chain")
    ap.add_argument("--bin", default=os.path.join(ROOT, "docs", "data", "food.bin"))
    ap.add_argument("--out-json", default=os.path.join(HERE, "food.json"))
    ap.add_argument("--raw", default=os.path.join(HERE, "raw"), help="raw dir (collection.json, biz/, page/)")
    ap.add_argument("--report", default=os.path.join(HERE, "sync_report.json"))
    ap.add_argument("--no-details", action="store_true", help="skip map/menu fetches for new places")
    ap.add_argument("--refresh", action="store_true", help="refetch map/menu even if raw/biz has it")
    ap.add_argument("--require-bin", action="store_true", help="CI: only sync onto an existing food.bin")
    ap.add_argument("--allow-mass-removal", action="store_true")
    ap.add_argument("--show", action="store_true", help="dry-run: print the new provisional records")
    ap.add_argument("--log-names", dest="log_names", action="store_true", default=not IN_CI)
    ap.add_argument("--no-log-names", dest="log_names", action="store_false")
    args = ap.parse_args()
    for k in ("bin", "out_json", "raw", "report", "current"):
        if getattr(args, k):
            setattr(args, k, os.path.abspath(getattr(args, k)))
    try:
        return {"sync": cmd_sync, "pending": cmd_pending, "finalize": cmd_finalize,
                "ai-needed": cmd_ai_needed}[args.cmd](args)
    except Blocked as e:
        warn("Yelp blocked or unreachable, nothing changed: %s" % e)
        return EX_BLOCKED
    except Fail as e:
        print("error: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
