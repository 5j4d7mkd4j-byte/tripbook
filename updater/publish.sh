#!/usr/bin/env bash
# Publish updater/out/status.bin as the only file on the orphan branch "live".
#
# Every publish is one parentless commit force-pushed over the last, so the
# branch never grows a history. It is built with git plumbing (hash-object,
# mktree, commit-tree), so the working tree, the index and the checked-out
# branch are never touched. Works in GitHub Actions (actions/checkout leaves
# GITHUB_TOKEN credentials for origin) and on a Mac clone (your git credentials).
#
#   bash updater/publish.sh            # no-op when run.py wrote nothing
# Env: PUBLISH_REMOTE (default origin), PUBLISH_BRANCH (default live).
set -euo pipefail

cd "$(dirname "$0")/.."
BIN=updater/out/status.bin
REMOTE=${PUBLISH_REMOTE:-origin}
BRANCH=${PUBLISH_BRANCH:-live}

if [ ! -s "$BIN" ]; then
  echo "publish: nothing to publish (run.py skipped or failed)"
  exit 0
fi
# Only ever publish a sealed file: plaintext must never reach the branch.
if [ "$(head -c 4 "$BIN")" != "NYC1" ]; then
  echo "publish: $BIN is not a sealed trip file; refusing" >&2
  exit 1
fi
# Act only on this folder's own repository, never on a parent one.
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "publish: not a git checkout" >&2; exit 1; }
if [ "$(cd "$top" && pwd -P)" != "$(pwd -P)" ]; then
  echo "publish: $(pwd) is not the top of its git repository" >&2
  exit 1
fi

blob=$(git hash-object -w "$BIN")
tree=$(printf '100644 blob %s\tstatus.bin\n' "$blob" | git mktree)
# A fixed, neutral identity and message: the branch says nothing about the trip.
commit=$(GIT_AUTHOR_NAME="tripbook updater" GIT_AUTHOR_EMAIL="updater@tripbook.invalid" \
         GIT_COMMITTER_NAME="tripbook updater" GIT_COMMITTER_EMAIL="updater@tripbook.invalid" \
         git commit-tree "$tree" -m "status")

# Retry briefly: a push can fail on a network blip. --force replaces the old commit.
for attempt in 1 2 3; do
  if git push --force --quiet "$REMOTE" "$commit:refs/heads/$BRANCH"; then
    echo "publish: pushed status.bin to $BRANCH"
    exit 0
  fi
  [ "$attempt" -lt 3 ] && sleep $((attempt * 5))
done
echo "publish: push failed" >&2
exit 1
