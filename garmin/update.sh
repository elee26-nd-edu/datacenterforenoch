#!/bin/sh
# Pull new Garmin data and rebuild the encrypted payload for training.html.
# Run from anywhere: garmin/update.sh   (then commit data/training.enc.json and push)
set -e
cd "$(dirname "$0")"
.venv/bin/python sync.py
.venv/bin/python build.py "$@"
