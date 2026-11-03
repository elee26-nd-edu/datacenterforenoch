#!/bin/sh
# Daily unattended update: pull new Garmin data, rebuild the encrypted payload,
# and publish it. Run by launchd (see ~/Library/LaunchAgents/com.enoch.garmin-sync.plist).
#
#   garmin/auto_update.sh              # sync, rebuild, commit, push
#   garmin/auto_update.sh --no-push    # sync + rebuild only (leaves the file uncommitted)
#
# Only data/training.enc.json is ever committed; anything else you have in
# progress in the repo is left alone. Output goes to ~/Library/Logs/garmin-sync.log.
set -eu

PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
export PATH

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PAYLOAD="data/training.enc.json"
PUSH=1
[ "${1:-}" = "--no-push" ] && PUSH=0

echo "=== $(date '+%Y-%m-%d %H:%M:%S') garmin auto-update ==="

# 1. Sync new Garmin days and rebuild the encrypted payload.
"$REPO/garmin/update.sh"

[ "$PUSH" = 1 ] || { echo "--no-push: stopping before commit."; exit 0; }

cd "$REPO"

# 2. Commit just the payload (the file is re-encrypted each build, so it
#    normally differs even when no new data arrived).
if git diff --quiet -- "$PAYLOAD"; then
  echo "No change to $PAYLOAD; nothing to publish."
  exit 0
fi
git add -- "$PAYLOAD"
git commit -q -m "Update training data (auto, $(date +%Y-%m-%d))" -- "$PAYLOAD"

# 3. Push; if the remote moved (e.g. an edit made on GitHub), rebase and retry.
if ! git push -q 2>/dev/null; then
  echo "Push rejected; rebasing onto origin and retrying."
  git pull --rebase --autostash -q
  git push -q
fi
echo "Published $(git rev-parse --short HEAD)."
