"""Weekly "fresh sky" for Spot the Wanderer (run by .github/workflows/weekly.yml).

NASA/IRSA publish new SPHEREx Quick Release 3 images every week. Each run:
  1. picks random sky positions away from the Milky Way plane,
  2. keeps the ones with QR3 images newer than anything we used before AND
     DR1 images at least ~5 months older (so things have time to move),
  3. builds a 20' wide pack for each (pipeline/spherex.py),
  4. runs the site's own Find movers on them in headless Chromium,
  5. makes the blink pictures + planted practice movers (make_fields.make_one),
  6. adds them to web/data/fields/fields.json marked as new, keeping the last KEEP weekly fields.

    python pipeline/weekly_update.py            # default: 2 new fields
    WEEKLY_N=1 python pipeline/weekly_update.py
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import spherex  # noqa: E402
import make_fields as mf  # noqa: E402

DATA = ROOT / "web" / "data"
FIELDS = DATA / "fields" / "fields.json"
STATE = DATA / "fields" / "weekly_state.json"
N_NEW = int(os.environ.get("WEEKLY_N", "2"))
KEEP = int(os.environ.get("WEEKLY_KEEP", "8"))       # weekly fields kept on the site
MAX_TRIES = int(os.environ.get("WEEKLY_TRIES", "100"))  # random positions tried per run
MIN_GAP_DAYS = 150                                    # first vs newest picture
MIN_GALACTIC_LAT = 20                                 # stay out of the crowded Milky Way plane


def log(*a):
    print(*a, flush=True)


def random_position(rng):
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    while True:
        ra = rng.uniform(0, 360)
        dec = math.degrees(math.asin(rng.uniform(-1, 1)))  # uniform on the sphere
        if abs(SkyCoord(ra * u.deg, dec * u.deg).galactic.b.deg) >= MIN_GALACTIC_LAT:
            return round(ra, 5), round(dec, 5)


def sep_deg(ra1, dec1, ra2, dec2):
    r = math.radians
    c = math.sin(r(dec1)) * math.sin(r(dec2)) + math.cos(r(dec1)) * math.cos(r(dec2)) * math.cos(r(ra1 - ra2))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def check(ra, dec):
    """Newest QR3 MJD here if the spot is usable (QR3 + an old enough earlier epoch), else None."""
    rows = spherex.query_frames(ra, dec)
    qr3 = [r["t_min"] for r in rows if r.get("release") == "QR3" and r["t_min"] == r["t_min"]]
    if not qr3:
        return None
    mjds = [r["t_min"] for r in rows if r["t_min"] == r["t_min"]]
    if max(mjds) - min(mjds) < MIN_GAP_DAYS:
        return None
    ep = spherex.assign_epochs(mjds)
    if len(set(ep)) < 2:
        return None
    # every detector should appear in both the first and last epoch (needed for a fair blink)
    first, last = min(ep), max(ep)
    for e in (first, last):
        dets = {spherex._detector_from(r, {}) for r, k in zip(rows, ep) if k == e}
        if len(dets - {0}) < 3:
            return None
    return max(qr3)


def main():
    state = json.loads(STATE.read_text()) if STATE.exists() else {"last_qr3_mjd": 0, "runs": []}
    fields = json.loads(FIELDS.read_text())
    taken = [(f["ra"], f["dec"]) for f in fields["fields"]]
    week = dt.date.today().isocalendar()
    tag = f"wk{week[0]}{week[1]:02d}"
    seed = int(hashlib.sha256(tag.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    after = state.get("last_qr3_mjd", 0)

    # "fresh" = QR3 images newer than what we used last time (a little overlap allowed,
    # IRSA releases arrive out of order). If a week turns up too few, we fall back to the
    # spots with the newest QR3 we saw, so every week still brings new sky.
    picked, usable, newest = [], [], after
    for i in range(MAX_TRIES):
        if len(picked) >= N_NEW:
            break
        ra, dec = random_position(rng)
        if any(sep_deg(ra, dec, a, d) < 1.0 for a, d in taken + [(p[0], p[1]) for p in picked]):
            continue
        try:
            got = check(ra, dec)
        except Exception as e:  # noqa: BLE001
            log("query failed", ra, dec, e)
            time.sleep(2)
            continue
        fresh = got is not None and got > after - 14
        log(f"try {i + 1}: RA {ra} Dec {dec} ->", "fresh" if fresh else ("older QR3" if got else "not usable"))
        if fresh:
            picked.append((ra, dec, got))
        elif got:
            usable.append((ra, dec, got))
    if len(picked) < N_NEW and usable:
        usable.sort(key=lambda p: -p[2])
        log(f"only {len(picked)} fresh; adding {min(N_NEW - len(picked), len(usable))} with the newest QR3 we found")
        picked += usable[:N_NEW - len(picked)]
    newest = max([newest] + [p[2] for p in picked])

    if not picked:
        log("No fresh QR3 coverage found this week; nothing to add.")
        return 0

    built = []
    # number on from any field already made this ISO week (manual re-runs must not overwrite)
    used = {f["slug"] for f in fields["fields"]} | {p.name for p in DATA.glob(f"wide_{tag}_*")}
    k0 = 1 + max([int(s.rsplit("_", 1)[1]) for s in used if s.startswith(f"wide_{tag}_")] or [0])
    for k, (ra, dec, _) in enumerate(picked, k0):
        slug = f"wide_{tag}_{k}"
        name = f"New sky {week[0]}-W{week[1]:02d} #{k} (RA {ra:.2f}, Dec {dec:+.2f})"
        t = time.time()
        try:
            spherex.build_target(ra, dec, DATA / slug, fov_arcmin=20, name=name, max_frames=120, workers=8,
                                 progress=lambda m: None, extra={"wide": True, "weekly": tag})
            built.append(slug)
            log(slug, "built in", round(time.time() - t), "s")
        except Exception as e:  # noqa: BLE001
            log(slug, "FAILED", e)
            shutil.rmtree(DATA / slug, ignore_errors=True)
    if not built:
        return 1

    # the computer's answers, from the site's own JavaScript
    dump_path = ROOT / "pipeline" / f"dump_{tag}.json"
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", str(ROOT / "web")],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(2)
        subprocess.run(["node", str(ROOT / "pipeline" / "find_movers_dump.js"), "http://localhost:8765", str(dump_path), *built],
                       check=True, timeout=1200)
        dump = json.loads(dump_path.read_text())
    except Exception as e:  # noqa: BLE001
        log("Find movers dump failed, fields will have no computer answers:", e)
        dump = {}
    finally:
        srv.terminate()
        dump_path.unlink(missing_ok=True)

    today = dt.date.today().isoformat()
    added = []
    for slug in built:
        frng = np.random.default_rng(int(hashlib.sha256(slug.encode()).hexdigest()[:8], 16))
        e = mf.make_one(slug, frng, dump)
        e.update({"weekly": True, "added": today})
        added.append(e)

    # newest first; drop the oldest weekly fields beyond KEEP
    new_ids = {f["id"] for f in added}
    weekly = added + [f for f in fields["fields"] if f.get("weekly") and f["id"] not in new_ids]
    keep, drop = weekly[:KEEP], weekly[KEEP:]
    for f in drop:
        shutil.rmtree(DATA / f["slug"], ignore_errors=True)
        for t in "abd":
            (DATA / "fields" / f"{f['id']}_{t}.png").unlink(missing_ok=True)
    fields["fields"] = keep + [f for f in fields["fields"] if not f.get("weekly") and f["id"] not in new_ids]
    fields["updated"] = today
    FIELDS.write_text(json.dumps(fields, indent=1, allow_nan=False))

    state["last_qr3_mjd"] = newest
    state["runs"] = (state.get("runs", []) + [{"date": today, "added": [f["id"] for f in added], "dropped": [f["id"] for f in drop],
                                                 "newest_qr3": spherex.mjd_to_iso(newest)}])[-30:]
    STATE.write_text(json.dumps(state, indent=1))
    log("Added", [f["id"] for f in added], "dropped", [f["id"] for f in drop])
    return 0


if __name__ == "__main__":
    sys.exit(main())
