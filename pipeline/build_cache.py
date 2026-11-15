"""
Pre-build target packs for the web viewer.

    python pipeline/build_cache.py                 # the 5 challenge test targets
    python pipeline/build_cache.py --only wise0855 # one of them
    python pipeline/build_cache.py --ra 133.78 --dec -7.24 --slug mytarget --fov 6
    python pipeline/build_cache.py --name "Proxima Cen" --slug proxima

Output goes to web/data/<slug>/ and web/data/index.json lists every pack, so
the static site (GitHub Pages) can show them without any server.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spherex  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"

# Positions are ICRS at epoch J2000 with proper motions in mas/yr (pmra includes cos dec).
# They are propagated to the SPHEREx survey epoch before querying. If SIMBAD is
# reachable its values are used instead; these are the fallback.
TARGETS = {
    "barnard": {
        "name": "Barnard's Star", "simbad": "Barnard's star", "kind": "fast-moving red dwarf",
        "ra": 269.452083, "dec": 4.693364, "pmra": -801.551, "pmdec": 10362.394, "fov": 6.0,
        "blurb": "The fastest-moving star in our sky: about 10 arcseconds per year, roughly "
                 "1.7 SPHEREx pixels between surveys six months apart.",
    },
    "epsindib": {
        "name": "Epsilon Indi B", "simbad": "eps Ind B", "kind": "pair of brown dwarfs",
        "ra": 331.043833, "dec": -56.782694, "pmra": 3982.0, "pmdec": -2479.0, "fov": 5.0,
        "blurb": "Two brown dwarfs orbiting each other, together orbiting the star Epsilon Indi A. "
                 "They move about 4.7 arcseconds per year.",
    },
    "wise0855": {
        "name": "WISE 0855-0714", "simbad": "WISE J085510.83-071442.5", "kind": "coldest known brown dwarf",
        # The challenge coordinates (08h55m10.83s -07d14m42.5s) are the WISE discovery position,
        # measured around 2010.5, not J2000. Found by locating the red source in SPHEREx data.
        "ra": 133.795129, "dec": -7.245147, "pmra": -8123.7, "pmdec": 673.1, "ref_epoch": 2010.5, "fov": 6.0,
        "blurb": "The coldest brown dwarf known (about -25 C), only 7.4 light years away. Very faint "
                 "and very red: look at the longest-wavelength detector.",
    },
    "rwaur": {
        "name": "RW Aurigae", "simbad": "RW Aur", "kind": "variable young star",
        "ra": 76.956417, "dec": 30.401417, "pmra": 0.0, "pmdec": 0.0, "fov": 3.0,
        "blurb": "A young star still surrounded by its planet-forming disk, which periodically "
                 "dims it. Watch its brightness, not its position.",
    },
    "rdra": {
        "name": "R Draconis", "simbad": "R Dra", "kind": "Mira variable",
        "ra": 248.167375, "dec": 66.754944, "pmra": 0.0, "pmdec": 0.0, "fov": 3.0,
        "blurb": "A pulsating red giant whose brightness swings by a large factor over about "
                 "8 months. Compare its brightness between epochs.",
    },
}

SURVEY_EPOCH = 2026.0

# Solar-system objects: SPHEREx frames are tracked on the object (via IRSA MOST).
MOVING = {
    "3iatlas": {
        "name": "3I/ATLAS", "most": "3I", "type": "Comet", "begin": "2025-08-05", "end": "2025-08-14", "max": 140, "fov": 5.0,
        "kind": "interstellar comet",
        "blurb": "Only the third object ever seen passing through our Solar System from another star. "
                 "The frame follows the comet, so it stays still while the background stars slide past.",
    },
    "hygiea": {
        "name": "10 Hygiea", "most": "20000010:NID", "type": "Asteroid", "begin": "2025-09-21", "end": "2025-10-01", "max": 120, "fov": 4.0,
        "kind": "asteroid",
        "blurb": "The fourth-largest asteroid in the main belt, about 430 km across. The frame follows it over several days.",
    },
}  # mid-point of the first SPHEREx all-sky surveys


def update_index():
    packs = []
    for d in sorted(DATA.iterdir()):
        mf = d / "manifest.json"
        if d.is_dir() and mf.exists():
            m = json.loads(mf.read_text())
            packs.append({
                "slug": d.name, "name": m.get("name") or d.name, "ra": m["ra"], "dec": m["dec"],
                "fov_arcmin": m["fov_arcmin"], "n_frames": len(m["frames"]),
                "n_epochs": len(m["epochs"]), "kind": m.get("target", {}).get("kind", ""),
                "blurb": m.get("target", {}).get("blurb", ""), "tracking": bool(m.get("tracking")),
            })
    (DATA / "index.json").write_text(json.dumps({"packs": packs}, indent=1))
    print(f"index.json lists {len(packs)} packs")


def build_named(slug: str, t: dict, use_simbad: bool, **kw):
    info = {"kind": t.get("kind", ""), "blurb": t.get("blurb", "")}
    ra = dec = None
    if use_simbad and t.get("simbad") and "ref_epoch" not in t:
        try:
            ra, dec, si = spherex.resolve_with_motion(t["simbad"], SURVEY_EPOCH)
            info.update(si, source="SIMBAD")
        except Exception as e:  # noqa: BLE001
            print(f"  SIMBAD lookup failed ({e}); using built-in coordinates")
    if ra is None:
        ra, dec = spherex.propagate(t["ra"], t["dec"], t["pmra"], t["pmdec"], t.get("ref_epoch", 2000.0), SURVEY_EPOCH)
        info.update(ref_epoch=t.get("ref_epoch", 2000.0), ra_ref=t["ra"], dec_ref=t["dec"], pmra_mas_yr=t["pmra"],
                    pmdec_mas_yr=t["pmdec"], epoch=SURVEY_EPOCH, source="built-in")
    print(f"== {t['name']}: RA {ra:.5f}  Dec {dec:.5f}")
    spherex.build_target(ra, dec, DATA / slug, fov_arcmin=kw.get("fov") or t["fov"],
                         name=t["name"], max_frames=kw.get("max_frames"), extra=info)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--only", help="comma-separated slugs from: " + ", ".join(TARGETS))
    p.add_argument("--ra", type=float)
    p.add_argument("--dec", type=float)
    p.add_argument("--name", help="object name to resolve (with proper motion) via SIMBAD")
    p.add_argument("--slug")
    p.add_argument("--fov", type=float, help="field of view in arcmin")
    p.add_argument("--max-frames", type=int, help="limit frames (quick tests)")
    p.add_argument("--no-simbad", action="store_true")
    p.add_argument("--catalogs", action="store_true", help="(re)fetch Gaia + CatWISE for every existing pack")
    p.add_argument("--moving", help="comma-separated slugs from: " + ", ".join(MOVING))
    a = p.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)

    if a.catalogs:
        for d in sorted(DATA.iterdir()):
            if (d / "manifest.json").exists() and not d.name.startswith("_"):
                print("==", d.name)
                try:
                    spherex.add_catalogs(d)
                except Exception as e:  # noqa: BLE001
                    print(f"!! {d.name}: {e}")
    elif a.moving:
        for s_ in a.moving.split(","):
            t = MOVING[s_]
            try:
                spherex.build_moving(t["most"], DATA / s_, t["begin"], t["end"], obj_type=t["type"], label=t["name"],
                                     fov_arcmin=t["fov"], max_frames=a.max_frames or t["max"],
                                     extra={"kind": t["kind"], "blurb": t["blurb"], "source": "IRSA MOST (JPL Horizons orbit)"})
            except Exception as e:  # noqa: BLE001
                print(f"!! {s_} failed: {e}")
    elif a.ra is not None or a.name:
        slug = a.slug or (a.name or f"{a.ra:.3f}_{a.dec:.3f}").lower().replace(" ", "")
        if a.name:
            ra, dec, info = spherex.resolve_with_motion(a.name, SURVEY_EPOCH)
            info["source"] = "SIMBAD"
        else:
            ra, dec, info = a.ra, a.dec, {}
        spherex.build_target(ra, dec, DATA / slug, fov_arcmin=a.fov or 4.0,
                             name=a.name or slug, max_frames=a.max_frames, extra=info)
    else:
        slugs = a.only.split(",") if a.only else list(TARGETS)
        for s in slugs:
            try:
                build_named(s, TARGETS[s], not a.no_simbad, fov=a.fov, max_frames=a.max_frames)
            except Exception as e:  # noqa: BLE001
                print(f"!! {s} failed: {e}")
    update_index()


if __name__ == "__main__":
    main()
