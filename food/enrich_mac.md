# Food list: keeping it in step with Yelp

The trip's Yelp collection is the source of truth. Places added there show up
in the app; places removed there disappear from it. Three pieces share the work:

| Piece | Runs | Does |
|---|---|---|
| `.github/workflows/food-sync.yml` | GitHub Actions, daily 13:17 UTC + manual | `food/sync.py`: diff the collection, add new places as **provisional** records, drop removed ones, re-seal `docs/data/food.bin`, commit `food: sync collection (+N/−M)` |
| `food/enrich_mac.sh` | your Mac, by hand (or from a scheduled task) | sync again, read pending places in Chrome, run `assemble.mjs`, seal, commit, push |
| Claude scheduled task | your Mac | writes AI notes `food/ai/<alias>.json` for places listed in `food/ai_needed.json` |

Only `docs/data/food.bin` (encrypted) is ever committed. Everything else these tools
write is plaintext in gitignored paths: `food/*.json`, `food/raw/`, `food/ai/`.

## One-time setup

1. **Repository secret `TRIP_KEY`**: the base64 key in `.secrets/trip_key.b64`.
   Copy it without displaying it (`pbcopy < .secrets/trip_key.b64`) and paste it under
   *Settings > Secrets and variables > Actions > New repository secret*.
   Add a second secret **`YELP_COLLECTION`** holding the collection id (the
   `COLLECTION` value in `food/yelp_fetch.py`). The id counts as private:
   `tools/scan_public.py` refuses committed files that contain it, so `yelp_fetch.py`
   cannot be committed with the id written in it, and CI reads it from this secret.
   Locally `sync.py` uses `$YELP_COLLECTION` when set, else the constant.
2. **First bundle**: the cloud job only updates an existing `docs/data/food.bin` (it
   warns and does nothing otherwise). Run `food/enrich_mac.sh` once (or `node app/build.mjs`)
   and commit the result.
3. **Workflow permissions**: the workflow asks for `contents: write` (to push the bundle)
   and `pages: write` (to request a Pages rebuild after a push, in case a push made with the
   job's token does not start one). If the repo or org restricts the default token, allow
   read/write under *Settings > Actions > General*. After the first automated push, check
   that the site picked up the new `food.bin`.

## What "provisional" means

A new place first arrives with what a plain `curl` can get: the collection entry
(name, rating, price, categories, location, cover photo), the map page (address,
neighborhood) and the public menu (sections, popular items). `sync.py` runs a copy of
`assemble.mjs` on just those places in a temp dir, so cuisine, style, types and meals
use the same rules as every other place. Hours, phone, website, attributes and most photos
need the browser read, and the summary needs AI notes. Until then "Per person" is an
estimate: about the median popular-item price for counter, casual, bar and market places,
and Yelp's own band (`$` under $10 ... `$$$$` $61+) for sit-down ones. The record has:

```json
"pending_details": true,
"added_at": "2026-10-18",
"hours": [], "hours_note": "Hours not loaded yet; check Yelp"
```

`added_at` and `removed_at` are New York calendar dates, whatever zone the machine is in.
Removed places are listed under the bundle's top-level `"tombstones"`
(`{id, name, removed_at}`, newest first, at most 50). If a place is added back, it is
taken off that list.

Safety checks: if Yelp blocks a page partway through the listing, the job stops and
changes nothing. Removals are skipped when the listing count does not match the
collection's own "N Places" header. They are also skipped when more than 3 removals
can't be verified, or when more than half the list would go (override that last one
with `--allow-mass-removal`).

## Running the Mac path

Start Chrome with remote debugging, using its own profile. You don't need to sign in.

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.yelp-chrome" --remote-debugging-port=9333 --no-first-run about:blank
```

Then, from the project root:

```sh
food/enrich_mac.sh                # full run: pull, sync, read, assemble, seal, commit, push
food/enrich_mac.sh --no-browser   # skip Chrome; pending places stay provisional
food/enrich_mac.sh --no-push      # commit locally only (no pull, no push)
food/enrich_mac.sh --port 9444 --tabs 1
```

Steps, in order:

1. `git pull --ff-only` picks up places the cloud job added. This step is skipped when
   the folder is not a git repo yet, or with `--no-push`.
2. `python3 -I food/sync.py` repeats the cloud sync locally. Yelp rarely blocks a home
   IP, so this covers days the cloud job was refused.
3. `python3 -I food/yelp_fetch.py food/raw` fetches map and menu data, but only when
   some place lacks `food/raw/biz/<alias>.json`. Afterwards sync's checked
   `collection.json` is put back.
4. `node food/yelp_browser.mjs 9333 food/raw --only <pending aliases>` reads the pending
   places. If Chrome is not listening, the script prints the command above and exits 3.
   If Yelp shows a challenge page, finish it in that Chrome window and rerun.
5. `node food/assemble.mjs` then `node food/assemble.mjs --merge` build
   `food/base.json` and then `food/food.json`, merging any AI notes.
6. `python3 -I food/sync.py finalize` takes membership from the bundle as it was
   before assemble, keeps `added_at` and `tombstones`, and clears `pending_details` only
   for places that now have a browser read. It writes `food/ai_needed.json` and seals
   `docs/data/food.bin`.
7. Commits only `docs/data/food.bin`, with a message like
   `food: enrich places (P pending, A without AI notes)`, and pushes. Nothing is committed
   when the content did not change: sealing is skipped then, because a new seal changes every
   byte and every phone would download the list again. If the push is rejected (the cloud job
   pushed meanwhile), the local commit is undone so the next run's pull fast-forwards; rerun.

## AI notes (Claude scheduled task)

`food/ai_needed.json` lists the places that have no `food/ai/<alias>.json`:

```json
{"at": "2026-10-18T14:30:00Z", "places": [{"id": "some-place-new-york", "name": "Some Place"}]}
```

`python3 -I food/sync.py ai-needed` refreshes that list from the current bundle.

Each note is one JSON file named after the alias. `assemble.mjs --merge` reads these
keys and ignores any others:

| key | type | notes |
|---|---|---|
| `id` | string | the alias (must match the file name) |
| `summary`, `vibe`, `wait`, `price_per_person` | string | e.g. `"price_per_person": "$10–20"` |
| `loved`, `watch`, `order`, `tips`, `good_for` | string[] | short phrases |
| `style` | string | one of `sit-down`, `casual`, `counter`, `bar`, `market` |
| `meals` | string[] | from `breakfast`, `brunch`, `lunch`, `dinner`, `late` |
| `types` | string[] | e.g. `to-go`, `quick-bite`, `casual`, `coffee`, `sit-down`, `groups`, `dessert`, `reservations`, `late-night`, `brunch`, `date-night`, `bakery`, `outdoor`, `sandwiches`, `pizza`, `bar` |
| `cuisine_add` | string[] | extra cuisines, e.g. `["Donuts", "Italian"]` |
| `popular` | `{name, note}`[] | e.g. `{"name": "Pistachio Croissant", "note": "Most-photographed item, $8.62"}` |

A prompt for the scheduled task (it is not installed for you):

> In the New York trip project, read `food/ai_needed.json`. For each place listed that
> has a `food/raw/page/<id>.json`, read that file (page text, reviews) and
> `food/raw/biz/<id>.json` (menu). Then write `food/ai/<id>.json` in the format in
> `food/enrich_mac.md`, using the existing files in `food/ai/` as examples. Skip places
> with no page file yet. When done, run `food/enrich_mac.sh --no-browser`.

Use `--no-push` in that last command if you would rather review the commit before it
goes out.

## sync.py reference

```sh
python3 -I food/sync.py --dry-run          # fetch + diff, write nothing ("no changes (80 places)")
python3 -I food/sync.py --dry-run --show   # also print the provisional records
python3 -I food/sync.py                    # write food/food.json, seal docs/data/food.bin, report food/sync_report.json
python3 -I food/sync.py --current FILE     # diff against another .bin/.json
python3 -I food/sync.py pending            # comma list of aliases still needing a browser read
python3 -I food/sync.py finalize           # after assemble.mjs (see step 6)
python3 -I food/sync.py ai-needed          # refresh food/ai_needed.json
```

Exit codes:

| code | meaning |
|---|---|
| 0 | ok, whether or not anything changed |
| 1 | error |
| 2 | bad usage |
| 75 | Yelp blocked, unreachable or returning 5xx; nothing changed (the workflow turns this into a warning) |

`enrich_mac.sh` also exits 3 when Chrome is not running.

Without a bundle, `sync.py` diffs against `food/food.json`, then `food/base.json`, then
`food/raw/collection.json`. Under GitHub Actions it logs counts only, never place
names, in case the repo is public.
