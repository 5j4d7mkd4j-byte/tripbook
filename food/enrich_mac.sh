#!/bin/bash
# Mac path for the food list: completes places that the daily cloud sync (or a local
# sync) could only add provisionally ("pending_details": true), then seals
# docs/data/food.bin and pushes it. Installs nothing. Details: food/enrich_mac.md.
#
#   food/enrich_mac.sh [--no-browser] [--no-push] [--port 9333] [--tabs 2]
#
#   --no-browser  skip the Chrome read (pending places stay provisional)
#   --no-push     commit locally, do not pull or push
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT=9333; TABS=2; BROWSER=1; PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-browser) BROWSER=0 ;;
    --no-push) PUSH=0 ;;
    --port) PORT="$2"; shift ;;
    --tabs) TABS="$2"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

BIN=docs/data/food.bin
RAW=food/raw
OUT=food/food.json   # written by assemble.mjs --merge, then by finalize
TMP="$(mktemp -d "${TMPDIR:-/tmp}/food-enrich.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
say() { printf '\n== %s\n' "$*"; }
count() { [ -z "$1" ] && echo 0 || printf '%s' "$1" | tr ',' '\n' | grep -c .; }

# Git is optional: outside a work tree everything runs and nothing is committed.
GIT=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then GIT=1; fi
if [ "$GIT" = 1 ] && [ "$PUSH" = 1 ]; then
  say "pull"
  git pull --ff-only -q   # picks up places the cloud job added
fi

say "sync with the Yelp collection"
rc=0; python3 -I food/sync.py || rc=$?
case "$rc" in
  0) ;;
  75) echo "plain fetch blocked by Yelp; continuing with what is on disk" ;;
  *) exit "$rc" ;;
esac

# Places added by the cloud job have no food/raw/biz yet on this Mac (raw/ is gitignored).
say "map + menu for places missing food/raw/biz"
missing=0
if [ -f "$RAW/collection.json" ]; then
  missing=$(python3 -I - "$RAW" <<'PY'
import json, os, sys
raw = sys.argv[1]
ids = [p["id"] for p in json.load(open(os.path.join(raw, "collection.json")))["places"]]
print(sum(not os.path.exists(os.path.join(raw, "biz", i + ".json")) for i in ids))
PY
)
fi
if [ "$missing" -gt 0 ]; then
  # yelp_fetch rewrites collection.json without sync.py's completeness checks: keep sync's copy
  cp "$RAW/collection.json" "$TMP/collection.json"
  python3 -I food/yelp_fetch.py "$RAW" || echo "yelp_fetch failed or was blocked; continuing"
  cp "$TMP/collection.json" "$RAW/collection.json"
else
  echo "none missing"
fi

say "browser read for pending places"
PENDING="$(python3 -I food/sync.py pending)"
n=$(count "$PENDING")
if [ "$n" = 0 ]; then
  echo "nothing pending"
elif [ "$BROWSER" = 0 ]; then
  echo "skipped (--no-browser): $n place(s) stay pending"
elif ! curl -sf -m 3 "http://127.0.0.1:$PORT/json/version" >/dev/null; then
  cat <<EOF
$n place(s) need a browser read, but Chrome is not listening on port $PORT.
Start it in another terminal (a separate profile; sign-in not needed), then rerun:

  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
    --user-data-dir="\$HOME/.yelp-chrome" --remote-debugging-port=$PORT --no-first-run about:blank

Or rerun with --no-browser to seal what is there now.
EOF
  exit 3
else
  echo "$n place(s): reading with $TABS tab(s)"
  node food/yelp_browser.mjs "$PORT" "$RAW" --tabs "$TABS" --only "$PENDING" | tee "$TMP/browser.log"
  if grep -q '^STOPPED' "$TMP/browser.log"; then
    echo "Yelp showed a challenge page: finish it in that Chrome window and rerun. Continuing with what was read."
  fi
fi

say "assemble"
if [ ! -f food/assemble.mjs ]; then
  echo "food/assemble.mjs not found: new places stay provisional (sync already sealed them)"
else
  # Snapshot the bundle first: finalize takes membership from it, not from raw/ (may lag).
  BASE=()
  if [ -f "$BIN" ]; then cp "$BIN" "$TMP/before.bin"; BASE=(--current "$TMP/before.bin"); fi
  touch "$TMP/stamp"; sleep 1   # -nt has 1 s resolution
  node food/assemble.mjs           # raw/{collection,biz,page} -> food/base.json
  node food/assemble.mjs --merge   # base.json + food/ai/*.json -> food/food.json
  if [ ! "$OUT" -nt "$TMP/stamp" ]; then
    echo "assemble.mjs did not write $OUT; not finalizing" >&2
    exit 1
  fi
  say "finalize"
  python3 -I food/sync.py finalize --out-json "$OUT" ${BASE[@]+"${BASE[@]}"}
fi

say "AI notes"
python3 -I food/sync.py ai-needed
AI_N=$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["places"]))' food/ai_needed.json)
if [ "$AI_N" -gt 0 ]; then
  echo "the Claude scheduled task writes food/ai/<alias>.json for these; then rerun with --no-browser"
fi

say "commit"
if [ ! -f "$BIN" ]; then
  echo "no $BIN yet (needs assemble.mjs once); nothing to commit"
elif [ "$GIT" = 0 ]; then
  echo "not a git repo yet: nothing committed ($BIN is ready)"
elif [ -z "$(git status --porcelain -- "$BIN")" ]; then
  echo "$BIN unchanged"
else
  P_N=$(count "$(python3 -I food/sync.py pending)")
  # only the sealed bundle is ever committed; plaintext stays in gitignored paths
  git add -- "$BIN"
  git commit -q -m "food: enrich places ($P_N pending, $AI_N without AI notes)" -- "$BIN"
  if [ "$PUSH" = 1 ]; then
    if ! git push -q; then
      # main moved meanwhile (the cloud job pushed): drop this commit so the next run's
      # pull can fast-forward; the plaintext on disk rebuilds the same bundle.
      git reset -q --keep HEAD~1
      echo "push rejected (main moved); local commit undone: rerun this script" >&2
      exit 1
    fi
    echo "pushed $BIN"
  else
    echo "committed $BIN (not pushed: --no-push)"
  fi
fi
