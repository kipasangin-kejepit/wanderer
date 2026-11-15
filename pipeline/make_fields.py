"""Whole-field subjects for "Spot the Wanderer" v2 (scan a 20′ field, mark what moves).

For each wide pack (web/data/wide_*): first- and last-epoch stacks of the whole field
plus their difference, as PNGs, with 1–3 simulated movers hidden in them (known
positions, so we can tell volunteers how they did). Also stored: what the computer's
Find movers flagged (pipeline/wide_dump.json, from the browser) and catalogued fast
stars that should visibly move.

    python pipeline/make_fields.py
Writes web/data/fields/*.png and web/data/fields/fields.json
"""
from __future__ import annotations
import json, math
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web" / "data"
OUT = DATA / "fields"
rng = np.random.default_rng(2026)


def load(slug):
    m = json.loads((DATA / slug / "manifest.json").read_text())
    n = m["npix"]
    return m, np.fromfile(DATA / slug / "frames.bin", dtype="<f4").reshape(len(m["frames"]), n, n), n


def stack(m, cube, e):
    idx = [i for i, f in enumerate(m["frames"]) if f["epoch"] == e]
    return np.nanmedian(cube[idx], axis=0)


def mad(a):
    v = a[np.isfinite(a)]
    med = np.median(v)
    return med, 1.4826 * np.median(np.abs(v - med)) or 1e-9


def png(arr, path, lo, hi, med, diverging=False):
    a = arr[::-1]  # north up
    if diverging:
        t = np.clip(np.nan_to_num(a) / 6.0, -1, 1)
        rgb = np.dstack([np.where(t > 0, 20 + 235 * t, 20), np.where(t > 0, 20 + 160 * t, 20 + 180 * -t), np.where(t > 0, 20 + 30 * t, 20 + 225 * -t)]).astype(np.uint8)
    else:
        soft = max((hi - lo) * 0.03, 1e-9)
        v = np.arcsinh((np.nan_to_num(a, nan=hi) - med) / soft) / np.arcsinh(max(hi - med, 1e-9) / soft)
        g = (np.clip(v, 0, 1) * 255).astype(np.uint8)
        rgb = np.dstack([g, g, g])
    Image.fromarray(rgb, "RGB").save(path, optimize=True)


def known_movers(slug, m, n):
    """Catalogued stars predicted to shift >= 0.5 px between the first and last epoch."""
    p = DATA / slug / "catalog.json"
    if not p.exists():
        return []
    cat = json.loads(p.read_text())
    dt = (m["epochs"][-1]["mjd_mean"] - m["epochs"][0]["mjd_mean"]) / 365.25
    yr = 2000 + (m["epochs"][-1]["mjd_mean"] - 51544.5) / 365.25
    c = (n - 1) / 2
    out = []
    for s in cat["sources"]:
        pm = math.hypot(s.get("pmra") or 0, s.get("pmdec") or 0) / 1000
        shift = pm * dt / m["pixscale_arcsec"]
        if shift < 0.5 or (s["cat"] == "catwise" and (s.get("mag") or 99) > 13):
            continue
        ep = cat["gaia_epoch"] if s["cat"] == "gaia" else cat["catwise_epoch"]
        dec = s["dec"] + (s.get("pmdec") or 0) / 3.6e6 * (yr - ep)
        ra = s["ra"] + (s.get("pmra") or 0) / 3.6e6 * (yr - ep) / math.cos(math.radians(s["dec"]))
        xi = (ra - m["ra"]) * math.cos(math.radians(m["dec"])) * 3600
        eta = (dec - m["dec"]) * 3600
        x, y = c - xi / m["pixscale_arcsec"], c + eta / m["pixscale_arcsec"]
        if 2 <= x < n - 2 and 2 <= y < n - 2 and not any(abs(o["x"] - x) < 3 and abs(o["y"] - y) < 3 for o in out):
            out.append({"x": round(x, 1), "y": round(y, 1), "id": s["id"], "pm": round(pm, 2), "shift_px": round(shift, 1)})
    return out


def make_one(slug, rng, dump):
    """PNGs (picture 1, picture 2, difference) for one wide pack + its fields.json entry."""
    m, cube, n = load(slug)
    last = len(m["epochs"]) - 1
    A, B = stack(m, cube, 0), stack(m, cube, last)
    medA, sA = mad(A)
    yy, xx = np.mgrid[0:n, 0:n]
    sims = []
    for _ in range(int(rng.integers(1, 4))):
        for _try in range(300):
            x0, y0 = (int(v) for v in rng.integers(10, n - 10, size=2))
            win = A[y0 - 4:y0 + 5, x0 - 4:x0 + 5]
            if np.all(np.isfinite(win)) and np.nanmax(np.abs(win - medA)) < 3 * sA and all(math.hypot(s["x"] - x0, s["y"] - y0) > 12 for s in sims):
                break
        amp = float(rng.uniform(25, 60)) * sA
        ang, d = rng.uniform(0, 2 * np.pi), rng.uniform(1.6, 3.0)
        dx, dy = d * math.cos(ang), d * math.sin(ang)
        A = A + amp * np.exp(-((xx - (x0 - dx / 2)) ** 2 + (yy - (y0 - dy / 2)) ** 2) / 2.0)
        B = B + amp * np.exp(-((xx - (x0 + dx / 2)) ** 2 + (yy - (y0 + dy / 2)) ** 2) / 2.0)
        sims.append({"x": x0, "y": y0, "shift_px": round(d, 1)})
    both = np.concatenate([A[np.isfinite(A)], B[np.isfinite(B)]])
    med, lo, hi = float(np.median(both)), float(np.percentile(both, 5)), float(np.percentile(both, 99.8))
    _, sa = mad(A); _, sb = mad(B)
    fid = slug[5:]
    png(A, OUT / f"{fid}_a.png", lo, hi, med)
    png(B, OUT / f"{fid}_b.png", lo, hi, med)
    png((B - A) / math.hypot(sa, sb), OUT / f"{fid}_d.png", 0, 0, 0, True)
    comp = [c for c in dump.get(slug, []) if not any(math.hypot(c["x"] - s["x"], c["y"] - s["y"]) < 4 for s in sims)]
    entry = {"id": fid, "slug": slug, "name": m["name"], "npix": n, "pixscale": m["pixscale_arcsec"], "ra": m["ra"], "dec": m["dec"],
             "fov_arcmin": round(n * m["pixscale_arcsec"] / 60, 1), "dates": [m["epochs"][0]["start"], m["epochs"][last]["end"] if m["epochs"][last].get("end") else m["epochs"][last]["start"]],
             "release": m.get("collection", "spherex_qr2").replace("spherex_", "").upper().replace("+", " + "),
             "sims": sims, "computer": comp, "known": known_movers(slug, m, n)}
    print(fid, n, "px,", len(sims), "hidden,", len(comp), "computer,", len(entry["known"]), "known movers", flush=True)
    return entry


def main():
    """Rebuild every field from scratch (the original 12). The weekly job uses make_one instead."""
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*.png"):
        f.unlink()
    dump_p = ROOT / "pipeline" / "wide_dump.json"
    dump = json.loads(dump_p.read_text()) if dump_p.exists() else {}
    fields = []
    for p in sorted(DATA.glob("wide_*")):
        if (p / "manifest.json").exists():
            fields.append(make_one(p.name, rng, dump))
    (OUT / "fields.json").write_text(json.dumps({"fields": fields}, indent=1, allow_nan=False))


if __name__ == "__main__":
    main()
