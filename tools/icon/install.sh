#!/bin/bash
# Puts one icon variant into the app.
#
#   tools/icon/install.sh        installs B (the pick)
#   tools/icon/install.sh C      installs C instead
#
# Draws each size straight from icon.html with headless Chrome (sharper than shrinking the 1024):
#   app/src/static/icons/apple-touch-icon.png   180x180  (iOS home screen)
#   app/src/static/icons/icon-192.png           192x192
#   app/src/static/icons/icon-512.png           512x512
#   app/src/static/icons/icon-maskable-512.png  512x512  wordmark inside the central circle (Android/Chrome)
# Then records the choice in out/pick.js and re-renders out/<v>-1024.png and out/compare.png.
# Stops with an error if the font didn't load or any PNG has the wrong size or any transparency.
set -euo pipefail

V="$(echo "${1:-B}" | tr '[:lower:]' '[:upper:]')"
case "$V" in A|B|C|D) ;; *) echo "usage: $0 [A|B|C|D]" >&2; exit 2 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
ICONS="$(cd "$HERE/../../app/src/static/icons" && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PAGE="file://$HERE/icon.html?v=$V"
# The maskable wordmark fits a circle 70% of the icon wide: inside the spec's 80% safe zone,
# with room to spare when a launcher crops right down to it.
SAFE=.70

PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/nyc-icon-chrome.XXXXXX")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nyc-icon-out.XXXXXX")"
trap 'rm -rf "$PROFILE" "$WORK"' EXIT

chrome() {
  "$CHROME" --headless=new --hide-scrollbars --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --allow-file-access-from-files --force-device-scale-factor=1 \
    --virtual-time-budget=4000 "$@" 2>/dev/null
}

# The page marks <html data-error="font"> if Figtree didn't load; never install a fallback-font icon.
dom="$(chrome --dump-dom "$PAGE")"
if ! grep -q 'data-ready="1"' <<<"$dom" || grep -q 'data-error' <<<"$dom"; then
  echo "error: icon.html?v=$V did not draw (font missing?)" >&2; exit 1
fi

check() { # file size
  local d a
  d="$(sips -g pixelWidth -g pixelHeight "$1" | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
  a="$(sips -g hasAlpha "$1" | awk '/hasAlpha/{print $2}')"
  if [ "$d" != "$2x$2" ] || [ "$a" != "no" ]; then
    echo "error: $1 is $d (alpha: $a), expected $2x$2 with no alpha" >&2; exit 1
  fi
}

shoot() { # name size [extra query]
  chrome --window-size="$2,$2" --screenshot="$WORK/$1" "$PAGE&size=$2${3:-}" >/dev/null
  check "$WORK/$1" "$2"
}

shoot apple-touch-icon.png 180
shoot icon-192.png 192
shoot icon-512.png 512
shoot icon-maskable-512.png 512 "&safe=$SAFE"

# Only replace the app's icons once every size rendered cleanly.
for f in apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png; do
  cp "$WORK/$f" "$ICONS/$f"
  echo "$ICONS/$f  $(sips -g pixelWidth "$ICONS/$f" | awk '/pixelWidth/{print $2"x"$2}')"
done

printf "window.NYC_ICON_PICK = '%s';\n" "$V" > "$HERE/out/pick.js"
"$HERE/render.sh" "$V"
echo "installed $V"
