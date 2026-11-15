"""
Make a FAKE target pack for testing the viewer without network access.
It is clearly marked "synthetic" in the manifest and the viewer shows a banner.

    python pipeline/make_synthetic.py
"""
import json
import math
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "_synthetic"
rng = np.random.default_rng(7)

NPIX = 59
PIX = 6.15
EPOCH_MJD = [60810.0, 60993.0, 61176.0]  # ~May 2025, Nov 2025, May 2026
DETS = [(1, 0.75, 1.09), (2, 1.10, 1.62), (3, 1.63, 2.41), (4, 2.42, 3.82), (5, 3.83, 4.41), (6, 4.42, 5.00)]
BANDS_PER_DET = 17


def psf(img, x, y, flux, sigma=1.0):
    yy, xx = np.mgrid[0:NPIX, 0:NPIX]
    img += flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2)) / (2 * math.pi * sigma ** 2)


stars = [(rng.uniform(2, NPIX - 2), rng.uniform(2, NPIX - 2), rng.lognormal(1.5, 1.0), rng.uniform(-0.4, 0.4))
         for _ in range(70)]
c = (NPIX - 1) / 2


def bd_spectrum(lam):  # cold brown dwarf: very red, methane hole near 3.3 um, peak ~4.5 um
    s = 0.05 + 3.0 * np.exp(-((lam - 4.5) / 0.45) ** 2)
    s *= 1 - 0.8 * np.exp(-((lam - 3.3) / 0.25) ** 2)
    return 6 * s


frames, metas = [], []
for e, mjd0 in enumerate(EPOCH_MJD):
    for det, lo, hi in DETS:
        for b in range(BANDS_PER_DET):
            lam = lo + (hi - lo) * (b + 0.5) / BANDS_PER_DET
            mjd = mjd0 + rng.uniform(0, 14)
            img = rng.normal(0, 0.05, (NPIX, NPIX))
            for (x, y, f, slope) in stars:
                psf(img, x, y, f * (lam / 2.0) ** slope)
            # brown dwarf moving 1.7 px/epoch to the left and slightly up
            psf(img, c + 1.7 - 1.7 * e, c - 0.4 + 0.4 * e, float(bd_spectrum(lam)))
            # variable star: brightness x1, x3, x0.6
            psf(img, c - 14, c + 11, 8 * [1.0, 3.0, 0.6][e] * (lam / 2) ** -0.2)
            # a few flagged pixels
            bad = rng.random((NPIX, NPIX)) < 0.004
            img[bad] = np.nan
            frames.append(img.astype("<f4"))
            metas.append({"mjd": mjd, "detector": det, "wavelength_um": lam, "bandwidth_um": lam / 60,
                          "lam_min_um": lo, "lam_max_um": hi, "flagged_frac": float(bad.mean()),
                          "flag_counts": {"HOT": int(bad.sum())}, "epoch": e, "obs_id": f"synthetic-{e}-{det}-{b}",
                          "url": ""})

order = sorted(range(len(metas)), key=lambda k: metas[k]["mjd"])
frames = [frames[k] for k in order]
metas = [metas[k] for k in order]
for i, m in enumerate(metas):
    m["index"] = i

OUT.mkdir(parents=True, exist_ok=True)
np.stack(frames).tofile(OUT / "frames.bin")


def iso(mjd):
    import time
    return time.strftime("%Y-%m-%d", time.gmtime((mjd - 40587) * 86400))


manifest = {
    "version": 1, "synthetic": True, "name": "Synthetic test field", "ra": 133.7, "dec": -7.2,
    "fov_arcmin": NPIX * PIX / 60, "npix": NPIX, "pixscale_arcsec": PIX, "units": "fake units",
    "collection": "synthetic", "built_utc": "", "errors": [],
    "epochs": [{"id": e, "mjd_mean": m + 7, "start": iso(m), "end": iso(m + 14), "n_frames": 102}
               for e, m in enumerate(EPOCH_MJD)],
    "detectors": [{"id": d, "lam_min_um": lo, "lam_max_um": hi, "n_frames": 51} for d, lo, hi in DETS],
    "frames": metas,
    "target": {"kind": "test data", "blurb": "Fake sky: a brown dwarf moves near the centre, a star "
               "to the upper left changes brightness.", "pmra_mas_yr": 20900.0, "pmdec_mas_yr": 4900.0,
               "epoch": 2025.888, "source": "synthetic"},
}
(OUT / "manifest.json").write_text(json.dumps(manifest))
print("wrote", OUT)
