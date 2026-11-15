"""Build the "Spot the Wanderer" classification subject set (Zooniverse-style).

Each subject = two SPHEREx epoch stacks (first, last) of a 31×31 px stamp + their
noise-normalised difference, as small PNGs, plus what we know about it:
  * real   : candidates that Find movers flagged in our packs (answer unknown to us,
             but VET score and catalogue match are stored for later comparison)
  * gold   : answers known in advance, used for feedback and to measure how good
             volunteers are: real fast stars (Barnard's Star, Epsilon Indi B),
             simulated movers injected into real data, and ordinary non-moving stars.

    python pipeline/make_subjects.py      # needs pipeline/movers_dump.json
Writes web/data/subjects/*.png and web/data/subjects/subjects.json
"""
from __future__ import annotations
import json, random
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web" / "data"
OUT = DATA / "subjects"
HALF = 15  # 31×31 stamps
rng = np.random.default_rng(11)


def load(slug):
    m = json.loads((DATA / slug / "manifest.json").read_text())
    n = m["npix"]
    cube = np.fromfile(DATA / slug / "frames.bin", dtype="<f4").reshape(len(m["frames"]), n, n)
    return m, cube, n


def stacks(m, cube, dets=None):
    last = len(m["epochs"]) - 1
    def st(e):
        idx = [i for i, f in enumerate(m["frames"]) if f["epoch"] == e and (dets is None or f["detector"] in dets)]
        return np.nanmedian(cube[idx], axis=0)
    return st(0), st(last)


def mad(a):
    v = a[np.isfinite(a)]
    med = np.median(v)
    return med, 1.4826 * np.median(np.abs(v - med)) or 1e-9


def stamp(img, cx, cy):
    n = img.shape[0]
    out = np.full((2 * HALF + 1, 2 * HALF + 1), -1e30, dtype=np.float32)  # outside the cut-out
    for j in range(-HALF, HALF + 1):
        for i in range(-HALF, HALF + 1):
            x, y = cx + i, cy + j
            if 0 <= x < n and 0 <= y < n:
                out[j + HALF, i + HALF] = img[y, x]
    return out[::-1]  # north up (array y grows north)


def to_png(arr, path, lo, hi, med, diverging=False):
    pad = arr < -1e29
    arr = np.where(pad, np.nan if not diverging else 0.0, arr)
    if diverging:
        t = np.clip(np.nan_to_num(arr) / 6.0, -1, 1)
        r = np.where(t > 0, 20 + 235 * t, 20).astype(np.uint8)
        g = np.where(t > 0, 20 + 160 * t, 20 - 0 * t + (-t) * 180).astype(np.uint8)
        b = np.where(t > 0, 20 + 30 * t, 20 + (-t) * 225).astype(np.uint8)
        rgb = np.dstack([r, g, b])
    else:
        soft = max((hi - lo) * 0.04, 1e-9)
        # masked (saturated) pixels show as white, like an overexposed photo
        v = np.arcsinh((np.nan_to_num(arr, nan=hi) - med) / soft) / np.arcsinh(max(hi - med, 1e-9) / soft)
        g = (np.clip(v, 0, 1) * 255).astype(np.uint8)
        rgb = np.dstack([g, g, g])
    rgb[pad] = (28, 34, 44)  # beyond the edge of the SPHEREx cut-out
    Image.fromarray(rgb, "RGB").save(path, optimize=True)


def radec(m, x, y):
    import math
    c = (m["npix"] - 1) / 2
    xi, eta = (c - x) * m["pixscale_arcsec"], (y - c) * m["pixscale_arcsec"]  # x grows west, y north
    return round((m["ra"] + xi / 3600 / math.cos(math.radians(m["dec"]))) % 360, 6), round(m["dec"] + eta / 3600, 6)


def write(sid, A, B, cx, cy, meta, subjects):
    a, b = stamp(A, cx, cy), stamp(B, cx, cy)
    both = np.concatenate([a[np.isfinite(a) & (a > -1e29)], b[np.isfinite(b) & (b > -1e29)]])
    med = float(np.median(both)); lo = float(np.percentile(both, 5)); hi = float(np.percentile(both, 99.7))
    _, sa = mad(A); _, sb = mad(B)
    d = np.where((a < -1e29) | (b < -1e29), -1e30, (b - a) / np.hypot(sa, sb))
    for tag, arr, div in (("a", a, False), ("b", b, False), ("d", d, True)):
        to_png(arr, OUT / f"{sid}_{tag}.png", lo, hi, med, div)
    subjects.append(dict(id=sid, **meta))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*.png"):
        f.unlink()
    dump = json.loads((ROOT / "pipeline" / "movers_dump.json").read_text())
    subjects = []
    k = 0

    # --- real candidates (all of them, answer unknown) ---
    for slug, movers in dump.items():
        if not movers:
            continue
        m, cube, n = load(slug)
        A, B = stacks(m, cube)
        for mv in movers:
            cx, cy = mv["x"], mv["y"]
            if mv["kind"] == "moved" and mv.get("from"):
                cx, cy = round((mv["x"] + mv["from"][0]) / 2), round((mv["y"] + mv["from"][1]) / 2)
            k += 1
            ra, dec = radec(m, mv["x"], mv["y"])
            write(f"r{k:03d}", A, B, cx, cy, dict(type="real", slug=slug, target=m["name"], x=mv["x"], y=mv["y"], ra=ra, dec=dec, auto=mv["kind"],
                  known=mv["known"], vet=mv["vet"], cls=mv["cls"], dates=[m["epochs"][0]["start"], m["epochs"][-1]["start"]]), subjects)

    # --- gold: real fast stars (detector 6, where the dipoles are cleanest) ---
    for slug, label in (("barnard", "Barnard's Star, the fastest-moving star in our sky (10.4″/yr)"),
                        ("epsindib", "Epsilon Indi B, a pair of brown dwarfs moving 4.7″/yr")):
        m, cube, n = load(slug)
        A, B = stacks(m, cube, dets={5, 6})
        c = (n - 1) // 2
        k += 1
        write(f"g{k:03d}", A, B, c, c, dict(type="gold", truth="moved", slug=slug, target=m["name"], x=c, y=c,
              explain=f"This is {label}. It really moves!", dates=[m["epochs"][0]["start"], m["epochs"][-1]["start"]]), subjects)

    # --- gold: simulated movers and ordinary stars, in the survey fields ---
    survey = sorted(p.name for p in DATA.glob("survey_*") if (p / "manifest.json").exists())
    random.Random(5).shuffle(survey)
    for slug in survey[:12]:
        m, cube, n = load(slug)
        A, B = stacks(m, cube)
        mA, sA = mad(A)
        # simulated mover in an empty spot
        for _ in range(100):
            x0, y0 = rng.integers(8, n - 8, size=2)
            if abs(A[y0, x0] - mA) < 2 * sA and abs(B[y0, x0] - mA) < 2 * sA:
                break
        amp = float(rng.uniform(40, 80)) * sA
        ang = rng.uniform(0, 2 * np.pi); d = rng.uniform(1.6, 2.6)
        yy, xx = np.mgrid[0:n, 0:n]
        g = lambda cx, cy: amp * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / 2.0)  # noqa: E731
        A2 = A + g(x0 - d / 2 * np.cos(ang), y0 - d / 2 * np.sin(ang))
        B2 = B + g(x0 + d / 2 * np.cos(ang), y0 + d / 2 * np.sin(ang))
        k += 1
        write(f"g{k:03d}", A2, B2, int(x0), int(y0), dict(type="gold", truth="moved", slug=slug, target="Simulated object", x=int(x0), y=int(y0),
              explain="This was a simulated moving object we hid in real SPHEREx data, to check how well people spot movers. Did you catch it?",
              dates=[m["epochs"][0]["start"], m["epochs"][-1]["start"]]), subjects)
        # an ordinary star that doesn't change: brightest clean peak away from the centre
        best = None
        for y in range(6, n - 6):
            for x in range(6, n - 6):
                v = A[y, x]
                if not np.isfinite(v) or abs(x - n // 2) + abs(y - n // 2) < 5:
                    continue
                win = A[y - 2:y + 3, x - 2:x + 3]
                if v == np.nanmax(win) and 15 * sA < v - mA < 400 * sA and (best is None or v > best[0]):
                    best = (v, x, y)
        if best:
            k += 1
            write(f"g{k:03d}", A, B, best[1], best[2], dict(type="gold", truth="nothing", slug=slug, target="Field star", x=best[1], y=best[2],
                  explain="This is an ordinary distant star. It looks the same in both pictures: nothing moved, nothing changed.",
                  dates=[m["epochs"][0]["start"], m["epochs"][-1]["start"]]), subjects)

    # the cleanest simulated mover becomes the tutorial example (bright dot, quiet surroundings)
    sims = [s for s in subjects if s.get("target") == "Simulated object"]
    def clean(s):
        a = np.asarray(Image.open(OUT / f"{s['id']}_a.png").convert("L"), float)
        edge = np.concatenate([a[:9].ravel(), a[-9:].ravel(), a[:, :9].ravel(), a[:, -9:].ravel()])
        return a[12:19, 12:19].max() - np.percentile(edge, 90)
    if sims:
        max(sims, key=clean)["example"] = True
    (OUT / "subjects.json").write_text(json.dumps({"subjects": subjects}, indent=1, allow_nan=False))
    print(len(subjects), "subjects:", sum(s["type"] == "real" for s in subjects), "real,", sum(s["type"] == "gold" for s in subjects), "gold")


if __name__ == "__main__":
    main()
