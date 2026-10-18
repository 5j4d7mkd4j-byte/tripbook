#!/bin/bash
# Renders the nyc. home-screen icon variants and a comparison sheet with headless Chrome.
#
#   tools/icon/render.sh            all variants (A B C D) + out/compare.png
#   tools/icon/render.sh A C        just those variants + the sheet
#
# Writes tools/icon/out/<v>-1024.png (exactly 1024x1024, opaque) and tools/icon/out/compare.png.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
VARIANTS=("$@")
[ ${#VARIANTS[@]} -eq 0 ] && VARIANTS=(A B C D)
mkdir -p "$OUT"

# A throwaway profile so this never touches (or waits on) a running Chrome.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/nyc-icon-chrome.XXXXXX")"
trap 'rm -rf "$PROFILE"' EXIT

shoot() { # url out.png width height
  "$CHROME" --headless=new --hide-scrollbars --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --allow-file-access-from-files --force-device-scale-factor=1 \
    --virtual-time-budget=4000 --window-size="$3,$4" --screenshot="$2" "$1" >/dev/null 2>&1
}

dims() { sips -g pixelWidth -g pixelHeight "$1" | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}'; }

for v in "${VARIANTS[@]}"; do
  f="$OUT/$v-1024.png"
  shoot "file://$HERE/icon.html?v=$v" "$f" 1024 1024
  d="$(dims "$f")"
  if [ "$d" != "1024x1024" ]; then echo "error: $f is $d, expected 1024x1024" >&2; exit 1; fi
  echo "$f  $d"
done

shoot "file://$HERE/compare.html" "$OUT/compare.png" 1600 1040
echo "$OUT/compare.png  $(dims "$OUT/compare.png")"
