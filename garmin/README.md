# Garmin → training.html

Pulls Garmin Connect data, analyses it, and writes `../data/training.enc.json`, an
AES-256-GCM encrypted file that `training.html` decrypts in the browser with the page passcode.

Raw data, FIT files (which contain GPS) and login tokens stay local: `data/` and `.venv/` are git-ignored.

## Update the page

```sh
garmin/update.sh                 # sync new days + rebuild the encrypted payload
git add data/training.enc.json && git commit -m "Update training data" && git push
```

## One-time setup (already done on this machine)

```sh
python3 -m venv garmin/.venv
garmin/.venv/bin/pip install garminconnect fitparse cryptography
garmin/.venv/bin/python garmin/login.py      # saves tokens to ~/.garminconnect
```

## Passcode

Stored in `~/.garminconnect/site_passcode` (outside the repo). Change it with:

```sh
garmin/.venv/bin/python garmin/build.py --set-passcode
```

then commit the rebuilt `data/training.enc.json`.

## Files

- `login.py` — interactive Garmin login, run once (or when tokens expire).
- `sync.py` — incremental download: daily health, activities + FIT files, athlete profile, calendar races.
- `build.py` — metrics, per-run FIT analysis (splits, threshold zones, decoupling), insights, encryption.
- `update.sh` — `sync.py` then `build.py`.
- `auto_update.sh` — `update.sh` plus commit/push; run daily by launchd.

## Race goal / outlook

The page's goal, countdown, readiness, race-week plan and the race-specific advice all follow the
**next race on your Garmin Connect calendar** (add races there as events). `sync.py` reads the calendar
into `data/raw/events.json`; `build.py` picks the nearest upcoming event with a run distance (from the
event's distance target, or guessed from the title: marathon / half / 10K / 5K), skipping obvious
non-run events. When a race passes, the next daily build moves on to the next one; with none planned it
keeps showing the most recent race, and `DEFAULT_GOAL` in `build.py` is only a last resort.

Advice text is generated for the race distance and weekday (carb-loading and taper only for longer
races, nothing on-course for a 5K/10K, etc.). Editing the goal on the page overrides it for that
browser only, and only until the synced goal moves on to a different race.

## Daily automatic update

`auto_update.sh` runs `update.sh`, then commits and pushes only `data/training.enc.json`. It is
scheduled by `~/Library/LaunchAgents/com.enoch.garmin-sync.plist` (every day at 08:00; runs on wake if
the Mac was asleep). Log: `~/Library/Logs/garmin-sync.log`. It needs Full Disk Access granted to
`/bin/sh` (the repo is in ~/Desktop) and valid Garmin tokens; re-run `login.py` if they expire.

```sh
launchctl kickstart -k gui/$(id -u)/com.enoch.garmin-sync   # run it now
launchctl bootout gui/$(id -u)/com.enoch.garmin-sync        # turn it off
```
