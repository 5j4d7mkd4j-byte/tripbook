#!/bin/bash
# launchd entry point for the Mac backup updater (see install.md).
# launchd starts it every 10 minutes. run.py decides whether a run is due and
# skips when the cloud published a good status in the last 12 minutes (2 h 5 min
# in slow mode), so the Mac only does real work when GitHub Actions is late or failing.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STATE="$ROOT/updater/state"
LOG="$STATE/launchd.log"
mkdir -p "$STATE"

# Keep the log short: trim to the last 2000 lines once it passes 4000.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 4000 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exec >> "$LOG" 2>&1

# One run at a time. A lock older than 15 minutes is left over from a crash.
LOCK="$STATE/run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "--- $(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 updater/run.py --source mac --slow --skip-if-fresh 12 && bash updater/publish.sh
