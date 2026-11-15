"""Mini survey: SPHEREx spectra of very red CatWISE2020 sources.

Very red WISE colours (W1-W2 >= 1.5) pick out two kinds of object that look alike to
WISE: cold brown dwarfs (methane eats W1) and dusty / distant active galaxies. SPHEREx
spectra can tell them apart (methane at 3.3 um, water at 1.4 um vs a smooth red slope).

    python survey/run_survey.py            # select targets + build packs (resumable)
Outputs: survey/targets.json, web/data/survey_<id>/ packs.
"""
from __future__ import annotations
import json, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import spherex  # noqa: E402

FIELDS = [(200, 30), (150, 10), (30, -20), (330, -30), (240, 60), (100, 60), (15, 20), (60, -45)]
RADIUS = 6.0
SURVEY_EPOCH = 2025.9          # middle of the SPHEREx QR2 data
CATWISE_EPOCH = 2015.4
OUT = ROOT / "survey" / "targets.json"
DATA = ROOT / "web" / "data"


def select():
    from astroquery.ipac.irsa import Irsa
    seen, rows = set(), []
    for ra0, dec0 in FIELDS:
        q = f"""SELECT source_name, ra, dec, w1mpro, w2mpro, w1sigmpro, w2sigmpro, pmra, pmdec, sigpmra, sigpmdec
        FROM catwise_2020
        WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra0}, {dec0}, {RADIUS})) = 1
        AND w2mpro < 14.0 AND w1mpro - w2mpro > 1.5 AND ab_flags = '00' AND cc_flags = '0000' AND nb = 1"""
        t = time.time()
        try:
            tab = Irsa.query_tap(q).to_table()
        except Exception as e:  # noqa: BLE001
            print("field", ra0, dec0, "failed:", e, flush=True); continue
        print(f"field {ra0},{dec0}: {len(tab)} red sources ({time.time()-t:.0f}s)", flush=True)
        for r in tab:
            name = str(r["source_name"]).strip()
            if name in seen:
                continue
            seen.add(name)
            f = lambda k: float(r[k]) if r[k] is not None and r[k] == r[k] else None  # noqa: E731
            rows.append({"name": f"CWISE {name}", "id": name.replace("+", "p").replace("-", "m").replace(".", "d").lower(),
                         "ra": f("ra"), "dec": f("dec"), "w1": f("w1mpro"), "w2": f("w2mpro"),
                         "pmra": f("pmra"), "pmdec": f("pmdec"), "sigpmra": f("sigpmra"), "sigpmdec": f("sigpmdec")})
    OUT.write_text(json.dumps(rows, indent=1))
    return rows


def propagate(t):
    import math
    dt = SURVEY_EPOCH - CATWISE_EPOCH
    pmra, pmdec = (t["pmra"] or 0.0), (t["pmdec"] or 0.0)  # arcsec/yr, pmra includes cos(dec)
    # only trust motions that are well measured (> 3 sigma); otherwise stay put
    if t["sigpmra"] and t["sigpmdec"] and math.hypot(pmra / t["sigpmra"], pmdec / t["sigpmdec"]) < 3:
        pmra = pmdec = 0.0
    dec = t["dec"] + pmdec * dt / 3600
    ra = t["ra"] + pmra * dt / 3600 / max(math.cos(math.radians(t["dec"])), 1e-6)
    return ra % 360, dec


def build(rows, limit=None):
    done = 0
    for t in rows[:limit]:
        out = DATA / f"survey_{t['id']}"
        if (out / "manifest.json").exists():
            done += 1; continue
        ra, dec = propagate(t)
        t0 = time.time()
        try:
            spherex.build_target(ra, dec, out, fov_arcmin=3.0, name=t["name"], max_frames=180, workers=8,
                                 progress=lambda m: None,
                                 extra={"source": "CatWISE2020 red-source survey", "survey": True, "group": t.get("group"), "w1": t["w1"], "w2": t["w2"],
                                        "kind": "Survey target", "pmra_mas_yr": (t["pmra"] or 0) * 1000, "pmdec_mas_yr": (t["pmdec"] or 0) * 1000})
            done += 1
            print(f"[{done}/{len(rows[:limit])}] {t['name']} W1-W2={t['w1']-t['w2']:.2f} ok ({time.time()-t0:.0f}s)", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"  {t['name']} failed: {e}", flush=True)


def pm_sig(t):
    import math
    if t["pmra"] is None or not t["sigpmra"] or not t["sigpmdec"]:
        return 0.0, 0.0
    return math.hypot(t["pmra"], t["pmdec"]), math.hypot(t["pmra"] / t["sigpmra"], t["pmdec"] / t["sigpmdec"])


def choose(rows, n_still=30):
    """Two groups with physical labels independent of SPHEREx:
    'moving': significant proper motion (> 0.15"/yr at > 5 sigma), so nearby, most likely brown dwarfs;
    'still': no detectable motion (< 2 sigma), so distant, most likely dusty active galaxies.
    Unsaturated only (8 < W2 < 14): brighter than W2 ~ 8 WISE saturates and W1-W2 is junk."""
    good = [t for t in rows if 8 < t["w2"] < 14]
    moving = [dict(t, group="moving") for t in good if pm_sig(t)[0] > 0.15 and pm_sig(t)[1] > 5]
    still = sorted([dict(t, group="still") for t in good if pm_sig(t)[1] < 2], key=lambda t: t["w2"])[:n_still]
    return moving + still


if __name__ == "__main__":
    rows = json.loads(OUT.read_text()) if OUT.exists() else select()
    extra = ROOT / "survey" / "extra_targets.json"   # optional hand-added known objects
    picked = choose(rows) + (json.loads(extra.read_text()) if extra.exists() else [])
    (ROOT / "survey" / "picked.json").write_text(json.dumps(picked, indent=1))
    print(len(rows), "red sources,", len(picked), "picked", flush=True)
    build(picked, limit=int(sys.argv[1]) if len(sys.argv) > 1 else None)
