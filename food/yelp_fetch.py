#!/usr/bin/env python3
"""Read the Yelp collection (the source of truth) and, for each place, the
public map and menu pages that Yelp serves without a browser.

Writes <out>/collection.json and <out>/biz/<alias>.json. Places already present
in <out>/biz are skipped unless --refresh is given, so a rerun only does the
work for places newly added to the collection.

  python3 -I yelp_fetch.py OUT_DIR [--refresh] [--list-only]
"""
import html, json, os, re, subprocess, sys, time, urllib.parse



def _collection_id():
    """The collection id is private (the repo is public): it comes from the
    YELP_COLLECTION environment variable (a repository secret in CI) or, on the
    Mac, from .secrets/yelp_collection.txt, which is never committed."""
    v = os.environ.get("YELP_COLLECTION", "").strip()
    if v:
        return v
    try:
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".secrets", "yelp_collection.txt")) as f:
            return f.read().strip()
    except OSError:
        return ""


COLLECTION = _collection_id()
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")


def get(url, xhr=False):
    """Fetch with curl (system certificates, same client Yelp served in testing)."""
    cmd = ["curl", "-sL", "--max-time", "30", "-A", UA,
           "-H", "Accept-Language: en-US,en;q=0.9",
           "-H", "Accept: " + ("application/json" if xhr else "text/html,application/xhtml+xml"),
           "-w", "\n%{http_code}", url]
    if xhr:
        cmd[1:1] = ["-H", "X-Requested-With: XMLHttpRequest"]
    r = subprocess.run(cmd, capture_output=True)
    body, _, code = r.stdout.decode("utf-8", "replace").rpartition("\n")
    try:
        return int(code), body
    except ValueError:
        return 0, ""


def text(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()


def parse_items(markup, markers):
    out = []
    for it in re.split(r'<li class="collection-item">', markup)[1:]:
        a = re.search(r'href="/biz/([^"?#]+)"', it)
        if not a:
            continue
        alias = urllib.parse.unquote(a.group(1))
        name = re.search(r'class="biz-name[^"]*"[^>]*>\s*<span[^>]*>([^<]+)', it)
        photo = re.search(r'/bphoto/([A-Za-z0-9_-]+)/', it)
        rating = re.search(r'itemprop="ratingValue" content="([\d.]+)"', it)
        reviews = re.search(r'itemprop="reviewCount">(\d+)<', it)
        price = re.search(r'price-range">([^<]+)<', it)
        cats = re.findall(r'href="/search\?cflt=([^"&]+)">([^<]+)</a>', it)
        city = re.search(r'addr-city">([^<]+)<', it)
        p = {"id": alias, "name": html.unescape(name.group(1).strip()) if name else alias,
             "yelp": "https://www.yelp.com/biz/" + a.group(1),
             "rating": float(rating.group(1)) if rating else None,
             "reviews": int(reviews.group(1)) if reviews else None,
             "price": price.group(1).strip() if price else None,
             "yelp_categories": [{"alias": c, "title": html.unescape(t)} for c, t in cats],
             "city": html.unescape(city.group(1).strip()) if city else None,
             "cover_photo": photo.group(1) if photo else None}
        m = markers.get(alias)
        if m:
            p["lat"], p["lon"] = m["location"]["latitude"], m["location"]["longitude"]
        out.append(p)
    return out


def read_collection():
    places, offset = [], 0
    while True:
        st, body = get("https://www.yelp.com/collection/user/rendered_items?collection_id=%s"
                       "&offset=%d&sort_by=date" % (COLLECTION, offset), xhr=True)
        if st != 200 or not body.strip().startswith("{"):
            if offset == 0:
                raise SystemExit("collection fetch failed: HTTP %s" % st)
            break
        j = json.loads(body)
        ms = j.get("map_state") or {}
        ms = json.loads(ms) if isinstance(ms, str) else ms
        markers = {}
        for m in ms.get("markers", []):
            a = re.search(r'href="/biz/([^"?#]+)"', m.get("hovercardMarkup", ""))
            if a:
                markers[urllib.parse.unquote(a.group(1))] = m
        got = parse_items(j.get("list_markup", ""), markers)
        if not got:
            break
        places += got
        offset += len(got)
        time.sleep(1.0)
    seen, uniq = set(), []
    for p in places:
        if p["id"] not in seen:
            seen.add(p["id"]); uniq.append(p)
    return uniq


def read_map(alias):
    st, s = get("https://www.yelp.com/map/" + urllib.parse.quote(alias))
    if st != 200:
        return {"map_status": st}
    t = re.search(r"<title>(.*?)</title>", s, re.S)
    title = text(t.group(1)) if t else ""
    # "Directions - Name - Neighborhood - City, ST - ST"
    parts = [x.strip() for x in title.split(" - ")]
    hood = parts[2] if len(parts) >= 5 else None
    body = text(re.sub(r"<script.*?</script>|<style.*?</style>", "", s, flags=re.S))
    addr = None
    m = re.search(r"Swap start/end points (.+?) Get directions yelp", body)
    if m:
        seg = m.group(1).strip()
        # the segment is "Name 205 E Houston St, New York, NY 10002"
        n = re.search(r"(\d[\w\- ]*.*?, [A-Za-z .]+, [A-Z]{2} \d{5})", seg)
        addr = n.group(1).strip() if n else seg
    return {"neighborhood": hood, "address": addr}


def read_menu(alias):
    st, s = get("https://www.yelp.com/menu/" + urllib.parse.quote(alias))
    if st != 200:
        return {"menu_status": st}
    lds = [json.loads(m) for m in re.findall(
        r'<script type="application/ld\+json">(.*?)</script>', s, re.S) if m.strip()]
    menu = next((x for x in lds if isinstance(x, dict) and x.get("@type") == "Menu"), None)
    if not menu:
        return {"menu_status": "none"}
    # popularity per item ("178 reviews 234 photos") from the rendered list
    pop = {}
    for blk in re.findall(r'<div class="menu-item[^"]*"(.*?)</div>\s*</div>\s*</div>', s, re.S):
        nm = re.search(r"<h4>\s*(?:<a[^>]*>)?([^<]+)", blk)
        rv = re.search(r"(\d+) reviews?", blk)
        ph = re.search(r"(\d+) photos?", blk)
        if nm:
            pop[html.unescape(nm.group(1).strip())] = [int(rv.group(1)) if rv else 0,
                                                       int(ph.group(1)) if ph else 0]
    sections = []
    for sec in menu.get("hasMenuSection", []) or []:
        items = []
        for it in sec.get("hasMenuItem", []) or []:
            off = it.get("offers") or {}
            if isinstance(off, list):
                off = off[0] if off else {}
            nm = html.unescape(it.get("name", "")).strip()
            items.append({"n": nm, "d": html.unescape(it.get("description") or "").strip() or None,
                          "p": off.get("price"), "pop": pop.get(nm)})
        sections.append({"name": html.unescape(sec.get("name", "")), "items": items})
    return {"menu_name": menu.get("name"), "menu": sections,
            "menu_url": "https://www.yelp.com/menu/" + alias}


def main():
    out = sys.argv[1]
    refresh = "--refresh" in sys.argv
    os.makedirs(os.path.join(out, "biz"), exist_ok=True)
    places = read_collection()
    with open(os.path.join(out, "collection.json"), "w") as f:
        json.dump({"collection": COLLECTION, "fetched_at": int(time.time()),
                   "places": places}, f, indent=1)
    print("collection: %d places" % len(places), flush=True)
    if "--list-only" in sys.argv:
        return
    for i, p in enumerate(places):
        fn = os.path.join(out, "biz", p["id"] + ".json")
        if os.path.exists(fn) and not refresh:
            continue
        rec = dict(p)
        rec.update(read_map(p["id"])); time.sleep(1.2)
        rec.update(read_menu(p["id"])); time.sleep(1.2)
        with open(fn, "w") as f:
            json.dump(rec, f, indent=1)
        print("%2d/%d %s | %s | menu=%s" % (i + 1, len(places), p["id"], rec.get("address"),
              len(rec.get("menu") or []) or rec.get("menu_status")), flush=True)


if __name__ == "__main__":
    main()
