"""Turn synced Garmin data into the encrypted payload that training.html reads.

Usage:
    garmin/.venv/bin/python garmin/build.py                 # build ../data/training.enc.json
    garmin/.venv/bin/python garmin/build.py --set-passcode  # choose a new page passcode, then build
    garmin/.venv/bin/python garmin/build.py --plain out.json  # also write unencrypted JSON (local only)

The passcode lives in ~/.garminconnect/site_passcode (outside the repo).
Nothing with GPS coordinates is ever written to the payload.
"""

import argparse
import base64
import getpass
import json
import os
import secrets
import statistics as st
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fitparse import FitFile

HERE = Path(__file__).parent
RAW = HERE / "data" / "raw"
FIT = HERE / "data" / "fit"
OUT = HERE.parent / "data" / "training.enc.json"
PASSFILE = Path("~/.garminconnect/site_passcode").expanduser()
KDF_ITERATIONS = 310_000

DEFAULT_GOAL = {
    "name": "Chicago Marathon",
    "date": "2026-10-11",
    "distance_km": 42.195,
    "target_s": None,  # None = use Garmin's prediction
}

RUN_TYPES = {"running", "treadmill_running", "trail_running", "track_running"}
# Friel-style zones as fractions of lactate threshold HR
LT_ZONE_EDGES = [0.85, 0.90, 0.95, 1.00]
LT_ZONE_NAMES = ["Recovery / easy", "Aerobic", "Tempo", "Sub-threshold", "Threshold +"]


# ---------- helpers ----------

def g(obj, *path, default=None):
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


def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(st.mean(xs), 2) if xs else None


def pearson(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 6:
        return None
    a, b = zip(*pairs)
    try:
        return round(st.correlation(a, b), 2)
    except st.StatisticsError:
        return None


def lt_zone(hr, lthr):
    frac = hr / lthr
    for i, edge in enumerate(LT_ZONE_EDGES):
        if frac < edge:
            return i
    return 4


# ---------- loading ----------

def load_daily():
    rows = []
    for f in sorted((RAW / "daily").glob("*.json")):
        d = json.loads(f.read_text())
        s, sl, hrv = d.get("summary") or {}, d.get("sleep") or {}, d.get("hrv") or {}
        if not s.get("restingHeartRate") and not sl.get("dailySleepDTO", {}).get("sleepTimeSeconds"):
            continue  # no watch data that day
        dto = sl.get("dailySleepDTO") or {}
        tr = d.get("training_readiness")
        ts = d.get("training_status") or {}
        latest = g(ts, "mostRecentTrainingStatus", "latestTrainingStatusData") or {}
        entry = next(iter(latest.values()), {}) if isinstance(latest, dict) else {}
        load = entry.get("acuteTrainingLoadDTO") or {}
        bal_map = g(ts, "mostRecentTrainingLoadBalance", "metricsTrainingLoadBalanceDTOMap") or {}
        bal = next(iter(bal_map.values()), {}) if isinstance(bal_map, dict) else {}
        sec = lambda k: round(dto[k] / 60) if dto.get(k) else None
        rows.append({
            "date": f.stem,
            "rhr": s.get("restingHeartRate"),
            "steps": s.get("totalSteps"),
            "active_kcal": s.get("activeKilocalories"),
            "im_moderate": s.get("moderateIntensityMinutes"),
            "im_vigorous": s.get("vigorousIntensityMinutes"),
            "stress": s.get("averageStressLevel") if (s.get("averageStressLevel") or -1) >= 0 else None,
            "bb_high": s.get("bodyBatteryHighestValue"),
            "bb_low": s.get("bodyBatteryLowestValue"),
            "bb_charged": s.get("bodyBatteryChargedValue"),
            "bb_drained": s.get("bodyBatteryDrainedValue"),
            "sleep_min": sec("sleepTimeSeconds"),
            "deep_min": sec("deepSleepSeconds"),
            "light_min": sec("lightSleepSeconds"),
            "rem_min": sec("remSleepSeconds"),
            "awake_min": sec("awakeSleepSeconds"),
            "sleep_score": g(dto, "sleepScores", "overall", "value"),
            "bedtime": datetime.fromtimestamp(dto["sleepStartTimestampLocal"] / 1000, timezone.utc).strftime("%H:%M") if dto.get("sleepStartTimestampLocal") else None,
            "waketime": datetime.fromtimestamp(dto["sleepEndTimestampLocal"] / 1000, timezone.utc).strftime("%H:%M") if dto.get("sleepEndTimestampLocal") else None,
            "sleep_respiration": dto.get("averageRespirationValue"),
            "hrv": g(hrv, "hrvSummary", "lastNightAvg"),
            "hrv_weekly": g(hrv, "hrvSummary", "weeklyAvg"),
            "hrv_status": g(hrv, "hrvSummary", "status"),
            "hrv_base_low": g(hrv, "hrvSummary", "baseline", "balancedLow"),
            "hrv_base_high": g(hrv, "hrvSummary", "baseline", "balancedUpper"),
            "readiness": g(tr, 0, "score"),
            "readiness_level": g(tr, 0, "level"),
            "readiness_feedback": g(tr, 0, "feedbackShort"),
            "vo2max": g(d, "max_metrics", 0, "generic", "vo2MaxPreciseValue"),
            "status": (entry.get("trainingStatusFeedbackPhrase") or "").rsplit("_", 1)[0] or None,
            "acute": load.get("dailyTrainingLoadAcute"),
            "chronic": load.get("dailyTrainingLoadChronic"),
            "acwr": load.get("dailyAcuteChronicWorkloadRatio"),
            "acwr_status": load.get("acwrStatus"),
            "load_low": bal.get("monthlyLoadAerobicLow"),
            "load_high": bal.get("monthlyLoadAerobicHigh"),
            "load_anaerobic": bal.get("monthlyLoadAnaerobic"),
            "load_low_target": [bal.get("monthlyLoadAerobicLowTargetMin"), bal.get("monthlyLoadAerobicLowTargetMax")],
            "load_high_target": [bal.get("monthlyLoadAerobicHighTargetMin"), bal.get("monthlyLoadAerobicHighTargetMax")],
            "load_anaerobic_target": [bal.get("monthlyLoadAnaerobicTargetMin"), bal.get("monthlyLoadAnaerobicTargetMax")],
            "load_feedback": bal.get("trainingBalanceFeedbackPhrase"),
        })
    return rows


def analyse_fit(path, lthr):
    """Per-run detail from the FIT file. GPS fields are read but never emitted."""
    ff = FitFile(str(path))
    recs = []
    for m in ff.get_messages("record"):
        v = m.get_values()
        recs.append((v.get("timestamp"), v.get("distance"), v.get("heart_rate"),
                     v.get("enhanced_speed") or v.get("speed"), v.get("power"),
                     v.get("cadence"), v.get("enhanced_altitude") or v.get("altitude")))
    recs = [r for r in recs if r[0] is not None]
    if len(recs) < 30:
        return {}
    sess = next((m.get_values() for m in ff.get_messages("session")), {})

    zones = [0.0] * 5
    moving = []  # (elapsed_moving_s, dist, hr, speed, power, cad, alt)
    t_moving = 0.0
    for prev, cur in zip(recs, recs[1:]):
        dt = (cur[0] - prev[0]).total_seconds()
        if dt <= 0 or dt > 10:
            continue  # pause or gap
        if cur[2]:
            zones[lt_zone(cur[2], lthr)] += dt
        if (cur[3] or 0) > 1.0:
            t_moving += dt
            moving.append((t_moving, cur[1], cur[2], cur[3], cur[4], cur[5], cur[6]))

    out = {"lt_zones_s": [round(z) for z in zones]}

    def splits(unit_m):
        res, start_i, mark = [], 0, unit_m
        for i, r in enumerate(moving):
            if r[1] is not None and r[1] >= mark:
                seg = moving[start_i:i + 1]
                dur = seg[-1][0] - (moving[start_i - 1][0] if start_i else 0)
                res.append({
                    "pace": round(dur / (unit_m / 1000)),
                    "hr": round(mean([s[2] for s in seg]) or 0) or None,
                    "pwr": round(mean([s[4] for s in seg]) or 0) or None,
                    "cad": round((mean([s[5] for s in seg]) or 0) * 2) or None,
                    "elev": round((seg[-1][6] or 0) - (seg[0][6] or 0), 1) if seg[0][6] is not None else None,
                })
                start_i, mark = i + 1, mark + unit_m
        return res

    out["splits_km"] = splits(1000)
    out["splits_mi"] = splits(1609.344)

    # aerobic decoupling (Pa:HR) for steady runs >= 40 min
    if t_moving >= 2400:
        half = t_moving / 2
        a = [r for r in moving if r[0] <= half and r[2] and r[3]]
        b = [r for r in moving if r[0] > half and r[2] and r[3]]
        if a and b:
            ef1 = mean([r[3] for r in a]) / mean([r[2] for r in a])
            ef2 = mean([r[3] for r in b]) / mean([r[2] for r in b])
            out["decoupling_pct"] = round((ef1 - ef2) / ef1 * 100, 1)
            out["efficiency"] = round(ef1 * 60, 3)  # metres per heartbeat-minute

    # downsampled series for the run chart (~180 points), no coordinates
    n = max(1, len(moving) // 180)
    series = {"t": [], "d": [], "hr": [], "pace": [], "pwr": [], "alt": []}
    for i in range(0, len(moving), n):
        chunk = moving[i:i + n]
        spd = mean([c[3] for c in chunk])
        series["t"].append(round(chunk[-1][0]))
        series["d"].append(round((chunk[-1][1] or 0) / 1000, 3))
        series["hr"].append(round(mean([c[2] for c in chunk]) or 0) or None)
        series["pace"].append(round(1000 / spd) if spd else None)
        series["pwr"].append(round(mean([c[4] for c in chunk]) or 0) or None)
        series["alt"].append(round(mean([c[6] for c in chunk]) or 0, 1) if chunk[0][6] is not None else None)
    out["series"] = series

    out["dynamics"] = {
        "cadence_spm": round((sess.get("avg_running_cadence") or 0) * 2 + (sess.get("avg_fractional_cadence") or 0) * 2) or None,
        "stance_ms": sess.get("avg_stance_time"),
        "vert_osc_mm": sess.get("avg_vertical_oscillation"),
        "vert_ratio": sess.get("avg_vertical_ratio"),
        "step_m": round(sess["avg_step_length"] / 1000, 2) if sess.get("avg_step_length") else None,
        "power": sess.get("avg_power"),
        "np": sess.get("normalized_power"),
        "ascent": sess.get("total_ascent"),
        "descent": sess.get("total_descent"),
    }
    return out


def load_activities(lthr):
    acts = []
    for f in (RAW / "activities").glob("*.json"):
        a = json.loads(f.read_text())
        aid = a["activityId"]
        typ = g(a, "activityType", "typeKey")
        dist = a.get("distance") or 0
        mov = a.get("movingDuration") or a.get("duration")
        item = {
            "id": aid,
            "start": a.get("startTimeLocal"),
            "date": (a.get("startTimeLocal") or "")[:10],
            "type": typ,
            "is_run": typ in RUN_TYPES,
            "name": a.get("activityName"),
            "dist_km": round(dist / 1000, 2) if dist else None,
            "dur_s": round(a.get("duration") or 0),
            "moving_s": round(mov or 0),
            "pace_s_km": round(mov / (dist / 1000)) if dist and mov and typ in RUN_TYPES else None,
            "avg_hr": a.get("averageHR"),
            "max_hr": a.get("maxHR"),
            "elev_gain": a.get("elevationGain"),
            "kcal": a.get("calories"),
            "aerobic_te": a.get("aerobicTrainingEffect"),
            "anaerobic_te": a.get("anaerobicTrainingEffect"),
            "te_label": a.get("trainingEffectLabel"),
            "load": round(a["activityTrainingLoad"]) if a.get("activityTrainingLoad") else None,
            "vo2max": a.get("vO2MaxValue"),
            "garmin_zones_s": [round(a.get(f"hrTimeInZone_{z}") or 0) for z in range(1, 6)],
        }
        fit = FIT / f"{aid}.fit"
        if item["is_run"] and fit.exists():
            try:
                item.update(analyse_fit(fit, lthr))
            except Exception as e:
                print(f"  FIT parse failed for {aid}: {e}")
        acts.append(item)
    acts.sort(key=lambda x: x["start"] or "")
    return acts


def weekly(acts, daily):
    weeks = {}
    for a in acts:
        d = date.fromisoformat(a["date"])
        wk = (d - timedelta(days=d.weekday())).isoformat()
        w = weeks.setdefault(wk, {"week": wk, "run_km": 0, "run_s": 0, "runs": 0, "long_km": 0,
                                  "load": 0, "other_s": 0, "lt_zones_s": [0] * 5})
        w["load"] += a["load"] or 0
        if a["is_run"]:
            w["run_km"] += a["dist_km"] or 0
            w["run_s"] += a["moving_s"]
            w["runs"] += 1
            w["long_km"] = max(w["long_km"], a["dist_km"] or 0)
            for i, z in enumerate(a.get("lt_zones_s") or []):
                w["lt_zones_s"][i] += z
        else:
            w["other_s"] += a["dur_s"]
    for w in weeks.values():
        w["run_km"] = round(w["run_km"], 1)
        w["long_km"] = round(w["long_km"], 1)
        days = [r for r in daily if w["week"] <= r["date"] < (date.fromisoformat(w["week"]) + timedelta(days=7)).isoformat()]
        w["sleep_avg_min"] = mean([r["sleep_min"] for r in days])
        w["hrv_avg"] = mean([r["hrv"] for r in days])
        w["rhr_avg"] = mean([r["rhr"] for r in days])
    return sorted(weeks.values(), key=lambda w: w["week"])


# ---------- insights ----------

def fmt_hm(minutes):
    return f"{int(minutes // 60)}h {int(minutes % 60):02d}m"


def fmt_time(s):
    s = int(s)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def insights(daily, acts, wk, athlete, preds):
    out = []
    sleep = [r["sleep_min"] for r in daily if r["sleep_min"]]
    last7 = [r for r in daily[-7:]]
    s7 = mean([r["sleep_min"] for r in last7])
    short = sum(1 for m in sleep if m < 360)
    out.append({
        "level": "bad" if s7 and s7 < 390 else "warn" if s7 and s7 < 450 else "good",
        "area": "Sleep",
        "title": f"Sleeping {fmt_hm(s7)} a night this week" if s7 else "Sleep",
        "text": f"{short} of {len(sleep)} tracked nights were under 6 hours (average {fmt_hm(mean(sleep))}). "
                "Sleep is the single biggest lever left before race day — aim for 8+ hours in bed every night this week, "
                "especially the two nights before the race (Friday matters more than Saturday).",
    })

    # readiness after short vs long nights
    pairs = [(r["sleep_min"], r["readiness"]) for r in daily if r["sleep_min"] and r["readiness"] is not None]
    lo = [rd for sm, rd in pairs if sm < 300]
    hi = [rd for sm, rd in pairs if sm >= 420]
    corr = pearson([p[0] for p in pairs], [p[1] for p in pairs])
    if lo and hi:
        out.append({
            "level": "warn", "area": "Readiness",
            "title": f"Readiness averages {round(st.mean(lo))} after <5h nights vs {round(st.mean(hi))} after 7h+",
            "text": f"Across your data, sleep duration and next-morning Training Readiness correlate at r = {corr}. "
                    "Your lowest readiness scores (1–14) all followed nights under about 4¾ hours.",
        })

    hrv = [(r["date"], r["hrv"]) for r in daily if r["hrv"]]
    if len(hrv) >= 14:
        early = st.mean([h for _, h in hrv[:14]])
        late = st.mean([h for _, h in hrv[-7:]])
        change = (late - early) / early * 100
        out.append({
            "level": "bad" if change < -15 else "warn" if change < -5 else "good",
            "area": "HRV",
            "title": f"Overnight HRV {'down' if change < 0 else 'up'} {abs(change):.0f}% vs your first two weeks",
            "text": f"7-night average {late:.0f} ms vs {early:.0f} ms early on; Garmin status is "
                    f"{(daily[-1]['hrv_status'] or 'n/a').lower()}. A falling HRV with stable training load usually means "
                    "accumulated fatigue or under-recovery — the taper plus more sleep should bring it back up before Sunday.",
        })

    rhr = [r["rhr"] for r in daily if r["rhr"]]
    if len(rhr) >= 10:
        base = st.median(rhr)
        spikes = [r["date"] for r in daily[-14:] if r["rhr"] and r["rhr"] >= base + 4]
        out.append({
            "level": "warn" if len(spikes) >= 2 else "good",
            "area": "Resting HR",
            "title": f"Resting HR baseline {base:.0f} bpm",
            "text": (f"Elevated (+4 bpm or more) on {len(spikes)} of the last 14 days ({', '.join(spikes)}), each after a short night. "
                     if spikes else "Stable — no warning signs of illness or overreaching. ")
                    + "On race week, a morning RHR 5+ bpm above baseline is a cue to skip a session, not push through.",
        })

    runs = [a for a in acts if a["is_run"] and a.get("lt_zones_s")]
    if runs:
        z = [sum(a["lt_zones_s"][i] for a in runs) for i in range(5)]
        tot = sum(z) or 1
        easy = (z[0] + z[1]) / tot * 100
        out.append({
            "level": "good" if easy >= 70 else "warn",
            "area": "Intensity",
            "title": f"{easy:.0f}% of running time below tempo (threshold-based zones)",
            "text": f"Using your lactate-threshold HR of {athlete['lthr']} bpm rather than Garmin's max-HR zones: "
                    f"{z[0]/tot*100:.0f}% easy, {z[1]/tot*100:.0f}% aerobic, {z[2]/tot*100:.0f}% tempo, "
                    f"{z[3]/tot*100:.0f}% sub-threshold, {z[4]/tot*100:.0f}% at/above threshold. "
                    "Your watch's default zones overstate how hard you run — set threshold-based zones in Garmin Connect.",
        })

    long_runs = [a for a in runs if (a["dist_km"] or 0) >= 20 and a.get("decoupling_pct") is not None]
    if long_runs:
        txt = "; ".join(f"{a['date']} {a['dist_km']:.0f} km: {a['decoupling_pct']:+.1f}%" for a in long_runs)
        worst = max(a["decoupling_pct"] for a in long_runs)
        out.append({
            "level": "good" if worst < 5 else "warn",
            "area": "Durability",
            "title": "Aerobic decoupling on long runs",
            "text": f"{txt}. Under 5% means pace held steady for the heart-rate cost through the second half. "
                    "Higher numbers on hard long runs are expected; on the race, start conservatively so drift stays small until 30 km.",
        })

    if len(wk) >= 3:
        peak = max(wk, key=lambda w: w["run_km"])
        last = wk[-1]
        out.append({
            "level": "info", "area": "Taper",
            "title": f"Peak week {peak['run_km']:.0f} km ({peak['week']}); last week {last['run_km']:.0f} km",
            "text": f"Acute load is {daily[-1]['acute']} vs chronic {daily[-1]['chronic']} (ratio {daily[-1]['acwr']}). "
                    "For race week, cut volume to roughly 30–40% of peak but keep a little marathon-pace running so your legs stay sharp.",
        })

    vo2 = [(r["date"], r["vo2max"]) for r in daily if r["vo2max"]]
    if len(vo2) >= 2:
        out.append({
            "level": "good" if vo2[-1][1] >= vo2[0][1] else "warn", "area": "Fitness",
            "title": f"VO₂ max {vo2[0][1]:.1f} → {vo2[-1][1]:.1f}",
            "text": f"Fitness kept improving through the block. Garmin's marathon prediction is {fmt_time(preds['marathon'])} "
                    f"(half {fmt_time(preds['half'])}, 10K {fmt_time(preds['10k'])}). Fitness age {athlete.get('fitness_age')} "
                    f"vs actual age {athlete.get('age')}.",
        })

    w = athlete.get("weight_kg") or 75
    out.append({
        "level": "info", "area": "Fuel",
        "title": f"Carb-load target: {round(w * 8)}–{round(w * 10)} g/day Fri–Sat",
        "text": f"At {w:.0f} kg: 8–10 g carbohydrate per kg for the 36–48 h before the start. On course, plan 60–90 g carbs per hour "
                f"(a gel every 25–30 min) and 400–800 ml fluid/hour depending on temperature. Practice nothing new on race day.",
    })
    return out


# ---------- encryption ----------

def get_passcode(reset: bool) -> str:
    if reset or not PASSFILE.exists():
        if reset:
            code = getpass.getpass("New page passcode: ")
            if code != getpass.getpass("Repeat passcode: "):
                raise SystemExit("Passcodes did not match.")
        else:
            words = ["pace", "tempo", "stride", "lake", "loop", "grant", "river", "miles", "taper", "split"]
            code = "-".join(secrets.choice(words) for _ in range(3)) + str(secrets.randbelow(90) + 10)
            print(f"Generated a page passcode and saved it to {PASSFILE}")
        PASSFILE.parent.mkdir(mode=0o700, exist_ok=True)
        PASSFILE.write_text(code)
        os.chmod(PASSFILE, 0o600)
    return PASSFILE.read_text().strip()


def encrypt(payload: dict, passcode: str) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=KDF_ITERATIONS).derive(passcode.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(payload, separators=(",", ":")).encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": KDF_ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


# ---------- main ----------

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--set-passcode", action="store_true")
    p.add_argument("--plain", type=Path, help="also write unencrypted JSON here (keep it out of git)")
    args = p.parse_args()

    prof = json.loads((RAW / "profile.json").read_text())
    ud = prof.get("user_profile") or {}
    lt = g(prof, "lactate_threshold", "speed_and_heart_rate") or {}
    lthr = lt.get("heartRate") or ud.get("lactateThresholdHeartRate") or 175
    lt_speed = (lt.get("speed") or ud.get("lactateThresholdSpeed") or 0) * 10  # Garmin stores m/s ÷ 10
    birth = ud.get("birthDate")
    age = None
    if birth:
        b = date.fromisoformat(birth)
        t = date.today()
        age = t.year - b.year - ((t.month, t.day) < (b.month, b.day))
    athlete = {
        "age": age,
        "sex": ud.get("gender"),
        "weight_kg": round(ud["weight"] / 1000, 1) if ud.get("weight") else None,
        "height_cm": round(ud["height"]) if ud.get("height") else None,
        "units": "mi" if ud.get("measurementSystem") == "statute_us" else "km",
        "lthr": lthr,
        "lt_pace_s_km": round(1000 / lt_speed) if lt_speed else None,
        "ftp_w": g(prof, "lactate_threshold", "power", "functionalThresholdPower"),
        "fitness_age": g(prof, "fitness_age", "fitnessAge"),
        "lt_zone_bounds": [round(lthr * e) for e in LT_ZONE_EDGES],
        "lt_zone_names": LT_ZONE_NAMES,
        "garmin_zone_bounds": [z.get("zoneLowBoundary") for z in prof.get("hr_zones") or [] if isinstance(z, dict)],
    }
    rp = prof.get("race_predictions") or {}
    preds = {"5k": rp.get("time5K"), "10k": rp.get("time10K"), "half": rp.get("timeHalfMarathon"), "marathon": rp.get("timeMarathon")}

    pr_labels = {1: "1 km", 2: "1 mile", 3: "5 km", 4: "10 km", 5: "Half marathon", 6: "Marathon", 7: "Longest run"}
    prs = [{"label": pr_labels[r["typeId"]], "value": r["value"], "date": (r.get("activityStartDateTimeLocalFormatted") or "")[:10],
            "activity_id": r.get("activityId"), "is_distance": r["typeId"] == 7}
           for r in prof.get("personal_records") or [] if isinstance(r, dict) and r.get("activityType") == "running" and r.get("typeId") in pr_labels]

    daily = load_daily()
    acts = load_activities(lthr)
    wk = weekly(acts, daily)
    payload = {
        "generated": datetime.now().isoformat(timespec="minutes"),
        "athlete": athlete,
        "predictions": preds,
        "prs": sorted(prs, key=lambda r: list(pr_labels.values()).index(r["label"])),
        "goal": DEFAULT_GOAL,
        "daily": daily,
        "activities": acts,
        "weekly": wk,
        "insights": insights(daily, acts, wk, athlete, preds),
    }

    if args.plain:
        args.plain.write_text(json.dumps(payload, indent=1))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(encrypt(payload, get_passcode(args.set_passcode))))
    print(f"wrote {OUT.relative_to(HERE.parent)} ({OUT.stat().st_size // 1024} KB, {len(daily)} days, {len(acts)} activities)")


if __name__ == "__main__":
    main()
