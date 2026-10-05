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
- `sync.py` — incremental download: daily health, activities + FIT files, athlete profile.
- `build.py` — metrics, per-run FIT analysis (splits, threshold zones, decoupling), insights, encryption.
- `update.sh` — `sync.py` then `build.py`.

The race goal shown on the page defaults to `DEFAULT_GOAL` in `build.py`; editing it on the page
overrides it for that browser only.
