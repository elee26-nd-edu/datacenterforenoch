"""Incrementally sync Garmin Connect data to ./data.

Usage:
    garmin/.venv/bin/python garmin/sync.py           # first run backfills 365 days, then incremental
    garmin/.venv/bin/python garmin/sync.py --days 730   # backfill further on first run
    garmin/.venv/bin/python garmin/sync.py --since 2024-01-01

Layout:
    data/raw/daily/YYYY-MM-DD.json   every daily endpoint, untouched
    data/raw/activities/<id>.json    activity summaries
    data/fit/<id>.fit                original per-second activity files
    data/daily.csv, data/activities.csv   flattened tables for analysis
"""

import argparse
import csv
import io
import json
import sys
import time
import zipfile
from datetime import date, timedelta
from pathlib import Path

from garminconnect import Garmin

TOKENSTORE = Path("~/.garminconnect").expanduser()
DATA = Path(__file__).parent / "data"
RAW_DAILY = DATA / "raw" / "daily"
RAW_ACT = DATA / "raw" / "activities"
FIT = DATA / "fit"
STATE = DATA / "state.json"
OVERLAP_DAYS = 3  # re-pull recent days since Garmin backfills sleep/HRV late

DAILY_ENDPOINTS = {
    "summary": "get_user_summary",
    "sleep": "get_sleep_data",
    "hrv": "get_hrv_data",
    "training_readiness": "get_training_readiness",
    "training_status": "get_training_status",
    "max_metrics": "get_max_metrics",
}


def g(obj, *path, default=None):
    """Safe nested get through dicts and lists."""
    for key in path:
        if isinstance(obj, dict):
            obj = obj.get(key)
        elif isinstance(obj, list) and isinstance(key, int) and len(obj) > key:
            obj = obj[key]
        else:
            return default
        if obj is None:
            return default
    return obj


def connect() -> Garmin:
    if not TOKENSTORE.exists():
        sys.exit("No saved login. Run: garmin/.venv/bin/python garmin/login.py")
    client = Garmin()
    client.login(str(TOKENSTORE))
    return client


def sync_daily(client: Garmin, start: date, end: date) -> None:
    RAW_DAILY.mkdir(parents=True, exist_ok=True)
    total = (end - start).days + 1
    for i in range(total):
        day = (start + timedelta(days=i)).isoformat()
        record = {}
        for name, method in DAILY_ENDPOINTS.items():
            try:
                record[name] = getattr(client, method)(day)
            except Exception as e:  # one bad endpoint shouldn't sink the day
                record[name] = {"_error": str(e)}
        (RAW_DAILY / f"{day}.json").write_text(json.dumps(record))
        print(f"\rdaily {i + 1}/{total} {day}", end="", flush=True)
        time.sleep(0.3)
    print()


def sync_activities(client: Garmin, start: date, end: date) -> None:
    RAW_ACT.mkdir(parents=True, exist_ok=True)
    FIT.mkdir(parents=True, exist_ok=True)
    activities = client.get_activities_by_date(start.isoformat(), end.isoformat(), sortorder="asc")
    for i, act in enumerate(activities, 1):
        aid = act["activityId"]
        (RAW_ACT / f"{aid}.json").write_text(json.dumps(act))
        fit_path = FIT / f"{aid}.fit"
        if not fit_path.exists():
            try:
                blob = client.download_activity(aid, dl_fmt=Garmin.ActivityDownloadFormat.ORIGINAL)
                with zipfile.ZipFile(io.BytesIO(blob)) as z:
                    fit_name = next((n for n in z.namelist() if n.lower().endswith(".fit")), None)
                    if fit_name:
                        fit_path.write_bytes(z.read(fit_name))
            except Exception as e:
                print(f"\n  could not download FIT for {aid}: {e}")
            time.sleep(0.3)
        print(f"\ractivities {i}/{len(activities)}", end="", flush=True)
    print()


def sync_profile(client: Garmin) -> None:
    """Athlete-level data: predictions, PRs, thresholds, zones. Overwritten each sync."""
    today = date.today().isoformat()
    calls = {
        "race_predictions": lambda: client.get_race_predictions(),
        "personal_records": lambda: client.get_personal_record(),
        "lactate_threshold": lambda: client.get_lactate_threshold(),
        "fitness_age": lambda: client.get_fitnessage_data(today),
        "user_profile": lambda: client.get_user_profile().get("userData", {}),
    }
    profile = {}
    for name, fn in calls.items():
        try:
            profile[name] = fn()
        except Exception as e:
            profile[name] = {"_error": str(e)}
    latest_run = max(RAW_ACT.glob("*.json"), key=lambda f: f.stat().st_mtime, default=None)
    if latest_run:
        try:
            aid = json.loads(latest_run.read_text())["activityId"]
            profile["hr_zones"] = client.get_activity_hr_in_timezones(aid)
        except Exception as e:
            profile["hr_zones"] = {"_error": str(e)}
    (DATA / "raw" / "profile.json").write_text(json.dumps(profile))
    print("profile synced")


def training_status_fields(ts: dict) -> dict:
    latest = g(ts, "mostRecentTrainingStatus", "latestTrainingStatusData") or {}
    # keyed by device id; take the primary device's entry
    entry = next(iter(latest.values()), {}) if isinstance(latest, dict) else {}
    load = entry.get("acuteTrainingLoadDTO") or {}
    balance = g(ts, "mostRecentTrainingLoadBalance", "metricsTrainingLoadBalanceDTOMap") or {}
    bal = next(iter(balance.values()), {}) if isinstance(balance, dict) else {}
    return {
        "training_status": entry.get("trainingStatusFeedbackPhrase"),
        "acute_load": load.get("dailyTrainingLoadAcute"),
        "chronic_load": load.get("dailyTrainingLoadChronic"),
        "acwr": load.get("dailyAcuteChronicWorkloadRatio"),
        "load_aerobic_low": bal.get("monthlyLoadAerobicLow"),
        "load_aerobic_high": bal.get("monthlyLoadAerobicHigh"),
        "load_anaerobic": bal.get("monthlyLoadAnaerobic"),
        "load_balance_feedback": bal.get("trainingBalanceFeedbackPhrase"),
    }


def flatten_daily() -> None:
    rows = []
    for f in sorted(RAW_DAILY.glob("*.json")):
        d = json.loads(f.read_text())
        s, sl, hrv = d.get("summary") or {}, d.get("sleep") or {}, d.get("hrv") or {}
        dto = sl.get("dailySleepDTO") or {}
        tr = d.get("training_readiness")
        rows.append({
            "date": f.stem,
            "resting_hr": s.get("restingHeartRate"),
            "steps": s.get("totalSteps"),
            "active_kcal": s.get("activeKilocalories"),
            "intensity_min_moderate": s.get("moderateIntensityMinutes"),
            "intensity_min_vigorous": s.get("vigorousIntensityMinutes"),
            "stress_avg": s.get("averageStressLevel"),
            "body_battery_high": s.get("bodyBatteryHighestValue"),
            "body_battery_low": s.get("bodyBatteryLowestValue"),
            "body_battery_charged": s.get("bodyBatteryChargedValue"),
            "body_battery_drained": s.get("bodyBatteryDrainedValue"),
            "sleep_hours": round(dto["sleepTimeSeconds"] / 3600, 2) if dto.get("sleepTimeSeconds") else None,
            "sleep_deep_min": (dto.get("deepSleepSeconds") or 0) / 60 or None,
            "sleep_rem_min": (dto.get("remSleepSeconds") or 0) / 60 or None,
            "sleep_awake_min": (dto.get("awakeSleepSeconds") or 0) / 60 or None,
            "sleep_score": g(dto, "sleepScores", "overall", "value"),
            "sleep_start_local": dto.get("sleepStartTimestampLocal"),
            "hrv_last_night": g(hrv, "hrvSummary", "lastNightAvg"),
            "hrv_weekly_avg": g(hrv, "hrvSummary", "weeklyAvg"),
            "hrv_status": g(hrv, "hrvSummary", "status"),
            "hrv_baseline_low": g(hrv, "hrvSummary", "baseline", "balancedLow"),
            "hrv_baseline_high": g(hrv, "hrvSummary", "baseline", "balancedUpper"),
            "readiness_score": g(tr, 0, "score"),
            "readiness_level": g(tr, 0, "level"),
            "vo2max_run": g(d, "max_metrics", 0, "generic", "vo2MaxPreciseValue"),
            "vo2max_cycle": g(d, "max_metrics", 0, "cycling", "vo2MaxPreciseValue"),
            **training_status_fields(d.get("training_status") or {}),
        })
    write_csv(DATA / "daily.csv", rows)


def flatten_activities() -> None:
    rows = []
    for f in RAW_ACT.glob("*.json"):
        a = json.loads(f.read_text())
        rows.append({
            "activity_id": a.get("activityId"),
            "start_local": a.get("startTimeLocal"),
            "type": g(a, "activityType", "typeKey"),
            "name": a.get("activityName"),
            "distance_km": round(a["distance"] / 1000, 3) if a.get("distance") else None,
            "duration_min": round(a["duration"] / 60, 2) if a.get("duration") else None,
            "moving_min": round(a["movingDuration"] / 60, 2) if a.get("movingDuration") else None,
            "elev_gain_m": a.get("elevationGain"),
            "avg_hr": a.get("averageHR"),
            "max_hr": a.get("maxHR"),
            "avg_speed_mps": a.get("averageSpeed"),
            "avg_power": a.get("avgPower"),
            "norm_power": a.get("normPower"),
            "avg_cadence": a.get("averageRunningCadenceInStepsPerMinute") or a.get("averageBikingCadenceInRevPerMinute"),
            "calories": a.get("calories"),
            "aerobic_te": a.get("aerobicTrainingEffect"),
            "anaerobic_te": a.get("anaerobicTrainingEffect"),
            "te_label": a.get("trainingEffectLabel"),
            "training_load": a.get("activityTrainingLoad"),
            "vo2max": a.get("vO2MaxValue"),
            **{f"hr_z{z}_min": round(a[k] / 60, 1) if a.get(k) else None
               for z in range(1, 6) for k in [f"hrTimeInZone_{z}"]},
            "has_fit": (FIT / f"{a.get('activityId')}.fit").exists(),
        })
    rows.sort(key=lambda r: r["start_local"] or "")
    write_csv(DATA / "activities.csv", rows)


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {path.relative_to(DATA.parent)} ({len(rows)} rows)")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=365, help="backfill window on first sync")
    p.add_argument("--since", type=date.fromisoformat, help="force sync from this date")
    p.add_argument("--flatten-only", action="store_true", help="rebuild CSVs without fetching")
    args = p.parse_args()

    DATA.mkdir(exist_ok=True)
    if not args.flatten_only:
        today = date.today()
        if args.since:
            start = args.since
        elif STATE.exists():
            last = date.fromisoformat(json.loads(STATE.read_text())["last_synced"])
            start = last - timedelta(days=OVERLAP_DAYS)
        else:
            start = today - timedelta(days=args.days)

        client = connect()
        print(f"Syncing {start} → {today} for {client.get_full_name()}")
        sync_activities(client, start, today)
        sync_daily(client, start, today)
        sync_profile(client)
        STATE.write_text(json.dumps({"last_synced": today.isoformat()}))

    flatten_daily()
    flatten_activities()


if __name__ == "__main__":
    main()
