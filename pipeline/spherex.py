"""
SPHEREx data pipeline.

Given a sky position, this module:
  1. finds every SPHEREx Quick Release 2 (QR2) spectral image that covers it (IRSA SIA),
  2. downloads a small cutout of each image (IRSA cutout service),
  3. removes the zodiacal-light model and masks bad pixels using the FLAGS plane,
  4. resamples every cutout onto one shared sky grid centered on the target,
  5. records the time, detector (1-6) and wavelength of each frame,
  6. groups frames into survey epochs (SPHEREx maps the whole sky every ~6 months),
  7. writes a compact "target pack" the web viewer reads:
        <out>/manifest.json   - metadata for every frame, epoch and detector
        <out>/frames.bin      - float32 cube [n_frames, npix, npix], NaN = masked

All the heavy lifting the browser can do instantly (co-adding, differencing,
stretching, spectra, light curves) is left to the viewer, so this script only
has to run once per target.
"""
from __future__ import annotations

import io
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

# astropy / astroquery are imported lazily so the pure-numpy helpers below can
# be unit-tested without them.

# IRSA dropped QR2 from searches when DR1 came out (Nov 2026). DR1 (Aug 2025 – May 2026)
# plus the weekly Quick Release 3 (Sep 2026 →) give one uniformly processed, growing set.
SPHEREX_COLLECTIONS = ("spherex_dr1", "spherex_qr3")
SPHEREX_COLLECTION = "+".join(SPHEREX_COLLECTIONS)
PIXSCALE_ARCSEC = 6.15  # native SPHEREx pixel scale
EPOCH_GAP_DAYS = 60.0   # frames further apart than this belong to different survey passes

# FLAGS bits we treat as "bad pixel". SOURCE is deliberately NOT here: it marks
# pixels that contain real astronomical sources, which are exactly what we want to see.
BAD_FLAG_NAMES = {
    "TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA",
    "HOT", "COLD", "PHANTOM", "PHANMISS",
}  # NONLINEAR pixels are corrected by the pipeline and kept: masking them hides bright star cores
# Flags we only report (shown as metadata in the viewer).
REPORT_FLAG_NAMES = BAD_FLAG_NAMES | {"NONLINEAR", "SATURATED", "PERSIST", "DICHROIC", "OUTLIER"}


@dataclass
class FrameMeta:
    index: int
    obs_id: str
    mjd: float
    detector: int
    wavelength_um: float      # wavelength at the target position
    bandwidth_um: float | None
    lam_min_um: float         # detector-wide range from the archive
    lam_max_um: float
    flagged_frac: float       # fraction of the cutout masked as bad
    flag_counts: dict
    epoch: int = -1
    url: str = ""


# --------------------------------------------------------------------------- #
# Pure numpy helpers (testable without astropy)
# --------------------------------------------------------------------------- #

def bilinear_sample(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Sample img at fractional pixel coords (0-based, x=column, y=row).
    Returns NaN outside the image or where any neighbour is NaN."""
    h, w = img.shape
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = x - x0
    fy = y - y0
    valid = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < w) & (y0 + 1 < h)
    out = np.full(x.shape, np.nan, dtype=np.float32)
    if not valid.any():
        return out
    xv, yv, fxv, fyv = x0[valid], y0[valid], fx[valid], fy[valid]
    v00 = img[yv, xv]
    v01 = img[yv, xv + 1]
    v10 = img[yv + 1, xv]
    v11 = img[yv + 1, xv + 1]
    out[valid] = (v00 * (1 - fxv) * (1 - fyv) + v01 * fxv * (1 - fyv)
                  + v10 * (1 - fxv) * fyv + v11 * fxv * fyv)
    return out


def nearest_sample(img: np.ndarray, x: np.ndarray, y: np.ndarray, fill=0) -> np.ndarray:
    h, w = img.shape
    xi = np.rint(x).astype(np.int64)
    yi = np.rint(y).astype(np.int64)
    valid = (xi >= 0) & (yi >= 0) & (xi < w) & (yi < h)
    out = np.full(x.shape, fill, dtype=img.dtype)
    out[valid] = img[yi[valid], xi[valid]]
    return out


def assign_epochs(mjds: list[float], gap_days: float = EPOCH_GAP_DAYS) -> list[int]:
    """Cluster observation times into survey epochs separated by > gap_days."""
    order = np.argsort(mjds)
    epochs = [0] * len(mjds)
    current, last = 0, None
    for i in order:
        if last is not None and mjds[i] - last > gap_days:
            current += 1
        epochs[i] = current
        last = mjds[i]
    return epochs


def bad_mask_from_flags(flags: np.ndarray, flag_bits: dict[str, int]) -> np.ndarray:
    """flag_bits maps flag NAME -> bit number. Unknown bitmap -> nothing masked."""
    bad = 0
    for name, bit in flag_bits.items():
        if name in BAD_FLAG_NAMES:
            bad |= (1 << bit)
    if bad == 0:
        return np.zeros(flags.shape, dtype=bool)
    return (flags.astype(np.int64) & bad) != 0


def count_flags(flags: np.ndarray, flag_bits: dict[str, int]) -> dict:
    out = {}
    f = flags.astype(np.int64)
    for name, bit in flag_bits.items():
        if name in REPORT_FLAG_NAMES:
            n = int(((f >> bit) & 1).sum())
            if n:
                out[name] = n
    return out


def parse_flag_bits(header) -> dict[str, int]:
    """SPHEREx FLAGS headers carry the bitmap as MP_<NAME> = <bit> keywords."""
    bits = {}
    for key in header.keys():
        if key.startswith("MP_"):
            try:
                bits[key[3:]] = int(header[key])
            except (TypeError, ValueError):
                pass
    return bits


def mjd_to_iso(mjd: float) -> str:
    # MJD 40587 = 1970-01-01
    ts = (mjd - 40587.0) * 86400.0
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


# --------------------------------------------------------------------------- #
# Archive access (needs astropy + astroquery + network)
# --------------------------------------------------------------------------- #

def resolve_name(name: str):
    """Object name -> (ra, dec) in degrees, using CDS Sesame via astropy."""
    from astropy.coordinates import SkyCoord
    c = SkyCoord.from_name(name)
    return float(c.ra.deg), float(c.dec.deg)


def query_frames(ra: float, dec: float, radius_deg: float = 0.01):
    """All DR1 + QR3 spectral images whose footprint contains (ra, dec)."""
    import astropy.units as u
    from astropy.coordinates import SkyCoord
    from astroquery.ipac.irsa import Irsa

    coord = SkyCoord(ra * u.deg, dec * u.deg)
    rows, seen = [], set()
    for col in SPHEREX_COLLECTIONS:
        tab = Irsa.query_sia(pos=(coord, radius_deg * u.deg), collection=col)
        for r in tab:
            subtype = str(r["dataproduct_subtype"]) if "dataproduct_subtype" in tab.colnames else "science"
            if subtype and subtype.lower() not in ("science", "", "--"):
                continue
            url = str(r["access_url"])
            if url in seen:
                continue
            seen.add(url)
            rows.append({
                "url": url,
                "obs_id": str(r["obs_id"]) if "obs_id" in tab.colnames else "",
                "t_min": float(r["t_min"]) if "t_min" in tab.colnames else float("nan"),
                "t_max": float(r["t_max"]) if "t_max" in tab.colnames else float("nan"),
                # SIA em_* are in metres
                "em_min_um": float(r["em_min"]) * 1e6 if "em_min" in tab.colnames else float("nan"),
                "em_max_um": float(r["em_max"]) * 1e6 if "em_max" in tab.colnames else float("nan"),
                "band": str(r["energy_bandpassname"]) if "energy_bandpassname" in tab.colnames else "",
                "release": col.replace("spherex_", "").upper(),
            })
    return rows


def cutout_url(url: str, ra: float, dec: float, size_deg: float) -> str:
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}center={ra:.7f},{dec:.7f}&size={size_deg:.5f}"


def _download(url: str, retries: int = 3, timeout: int = 120) -> bytes:
    import requests
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=timeout)
            r.raise_for_status()
            return r.content
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def _detector_from(row: dict, header) -> int:
    for key in ("DETECTOR", "DETNUM", "DET"):
        if key in header:
            try:
                return int(str(header[key]).strip().lstrip("Dd"))
            except ValueError:
                pass
    for text in (row.get("band", ""), row.get("obs_id", ""), row.get("url", "")):
        import re
        m = re.search(r"D([1-6])", text)
        if m:
            return int(m.group(1))
    return 0


def process_frame(raw: bytes, row: dict, out_wcs, npix: int, ra: float, dec: float):
    """Turn one downloaded cutout into (resampled image, FrameMeta)."""
    from astropy.io import fits
    from astropy.wcs import WCS
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    import warnings

    from astropy import log as _alog
    _alog.setLevel("ERROR")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        hdul = fits.open(io.BytesIO(raw))
        img_hdu = hdul["IMAGE"] if "IMAGE" in hdul else hdul[1]
        img = np.asarray(img_hdu.data, dtype=np.float32)
        hdr = img_hdu.header

        if "ZODI" in hdul:
            zodi = np.asarray(hdul["ZODI"].data, dtype=np.float32)
            if zodi.shape == img.shape:
                img = img - zodi

        flag_bits, flag_counts, bad = {}, {}, np.zeros(img.shape, dtype=bool)
        if "FLAGS" in hdul:
            flags = np.asarray(hdul["FLAGS"].data)
            flag_bits = parse_flag_bits(hdul["FLAGS"].header) or parse_flag_bits(hdr)
            bad = bad_mask_from_flags(flags, flag_bits)
            flag_counts = count_flags(flags, flag_bits)
        img = np.where(bad, np.nan, img)

        in_wcs = WCS(hdr).celestial

        # Wavelength at the target position, from the spectral lookup-table WCS (key 'W').
        wl, bw = float("nan"), None
        try:
            spec_wcs = WCS(hdr, fobj=hdul, key="W")
            spec_wcs.sip = None
            tx, ty = in_wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
            res = spec_wcs.pixel_to_world(float(tx), float(ty))
            if isinstance(res, (list, tuple)):
                wl = float(getattr(res[0], "value", res[0]))
                bw = float(getattr(res[1], "value", res[1])) if len(res) > 1 else None
            else:
                wl = float(getattr(res, "value", res))
        except Exception:  # noqa: BLE001
            pass
        if not np.isfinite(wl):
            wl = 0.5 * (row["em_min_um"] + row["em_max_um"])

        mjd = float("nan")
        for key in ("MJD-AVG", "MJD-MID", "MJD-OBS", "MJD-BEG"):
            if key in hdr:
                mjd = float(hdr[key])
                break
        if not np.isfinite(mjd):
            mjd = 0.5 * (row["t_min"] + row["t_max"])

        detector = _detector_from(row, hdr)

    # Resample onto the shared grid.
    yy, xx = np.mgrid[0:npix, 0:npix]
    world = out_wcs.pixel_to_world(xx.ravel(), yy.ravel())
    sx, sy = in_wcs.world_to_pixel(world)
    sx = np.asarray(sx).reshape(npix, npix)
    sy = np.asarray(sy).reshape(npix, npix)
    out = bilinear_sample(img, sx, sy)

    flagged = float(np.mean(~np.isfinite(out))) if out.size else 1.0
    meta = FrameMeta(
        index=-1, obs_id=row.get("obs_id", ""), mjd=mjd, detector=detector,
        wavelength_um=wl, bandwidth_um=bw,
        lam_min_um=row["em_min_um"], lam_max_um=row["em_max_um"],
        flagged_frac=flagged, flag_counts=flag_counts, url=row["url"],
    )
    return out, meta


def make_output_wcs(ra: float, dec: float, npix: int, pixscale_arcsec: float):
    from astropy.wcs import WCS
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(npix + 1) / 2.0, (npix + 1) / 2.0]
    s = pixscale_arcsec / 3600.0
    w.wcs.cdelt = [-s, s]
    return w


def build_target(ra: float, dec: float, out_dir: str | Path, fov_arcmin: float = 4.0,
                 name: str | None = None, max_frames: int | None = None,
                 workers: int = 8, progress=print, extra: dict | None = None) -> dict:
    """Run the full pipeline and write manifest.json + frames.bin to out_dir."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    npix = int(math.ceil(fov_arcmin * 60.0 / PIXSCALE_ARCSEC))
    npix += (npix + 1) % 2  # odd, so the target sits on the centre pixel
    out_wcs = make_output_wcs(ra, dec, npix, PIXSCALE_ARCSEC)
    # cut a bit wider than the FOV so the resampled square is fully covered
    size_deg = fov_arcmin / 60.0 * 1.5

    progress(f"Querying IRSA for SPHEREx frames at RA={ra:.5f} Dec={dec:.5f} ...")
    rows = query_frames(ra, dec)
    if max_frames and len(rows) > max_frames:
        # keep frames spread evenly in time, so every epoch and detector survives the cut
        rows = sorted(rows, key=lambda r: (r["t_min"] if r["t_min"] == r["t_min"] else 0.0))
        step = len(rows) / max_frames
        rows = [rows[int(i * step)] for i in range(max_frames)]
    progress(f"  found {len(rows)} frames")
    if not rows:
        raise RuntimeError("No SPHEREx DR1/QR3 frames cover this position yet.")

    images, metas, errors = [], [], []

    def job(row):
        raw = _download(cutout_url(row["url"], ra, dec, size_deg))
        return process_frame(raw, row, out_wcs, npix, ra, dec)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(job, r): r for r in rows}
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                img, meta = fut.result()
                images.append(img)
                metas.append(meta)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{futs[fut]['url']}: {e}")
            if i % 10 == 0 or i == len(rows):
                progress(f"  processed {i}/{len(rows)}")

    if not images:
        raise RuntimeError("All downloads failed:\n" + "\n".join(errors[:5]))

    # Sort by time, assign epochs and indices.
    order = sorted(range(len(metas)), key=lambda k: metas[k].mjd)
    images = [images[k] for k in order]
    metas = [metas[k] for k in order]
    epochs = assign_epochs([m.mjd for m in metas])
    for i, m in enumerate(metas):
        m.index, m.epoch = i, epochs[i]

    cube = np.stack(images).astype("<f4")
    cube.tofile(out_dir / "frames.bin")

    epoch_info = []
    for e in sorted(set(epochs)):
        ms = [m for m in metas if m.epoch == e]
        mj = [m.mjd for m in ms]
        epoch_info.append({
            "id": e,
            "mjd_mean": float(np.mean(mj)),
            "start": mjd_to_iso(min(mj)),
            "end": mjd_to_iso(max(mj)),
            "n_frames": len(ms),
        })

    det_info = []
    for d in sorted({m.detector for m in metas}):
        ms = [m for m in metas if m.detector == d]
        det_info.append({
            "id": d,
            "lam_min_um": float(np.nanmin([m.wavelength_um for m in ms])),
            "lam_max_um": float(np.nanmax([m.wavelength_um for m in ms])),
            "n_frames": len(ms),
        })

    manifest = {
        "version": 1,
        "name": name,
        "ra": ra,
        "dec": dec,
        "fov_arcmin": fov_arcmin,
        "npix": npix,
        "pixscale_arcsec": PIXSCALE_ARCSEC,
        "units": "MJy/sr (zodiacal light subtracted)",
        "collection": SPHEREX_COLLECTION,
        "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "epochs": epoch_info,
        "detectors": det_info,
        "frames": [{k: v for k, v in asdict(m).items()} for m in metas],
        "errors": errors[:20],
        "target": extra or {},
    }
    (out_dir / "manifest.json").write_text(json.dumps(_clean(manifest), indent=1, allow_nan=False, default=_json_default))
    try:
        add_catalogs(out_dir, progress)
    except Exception as e:  # noqa: BLE001
        progress(f"  (catalogue check skipped: {e})")
    progress(f"Done: {len(metas)} frames, {len(epoch_info)} epochs -> {out_dir}")
    return manifest


def _clean(o):
    """Replace NaN/inf with None so the manifest is valid JSON."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (float, np.floating)) and not math.isfinite(float(o)):
        return None
    return o


def propagate(ra: float, dec: float, pmra_mas: float, pmdec_mas: float,
              from_year: float, to_year: float) -> tuple[float, float]:
    """Move a star along its proper motion (pmra includes cos(dec))."""
    dt = to_year - from_year
    ddec = pmdec_mas * dt / 3.6e6
    dra = pmra_mas * dt / 3.6e6 / max(math.cos(math.radians(dec)), 1e-6)
    return (ra + dra) % 360.0, dec + ddec


def resolve_with_motion(name: str, to_year: float = 2026.0):
    """SIMBAD lookup (positions at epoch J2000) propagated to to_year.
    Returns (ra, dec, info dict) or raises."""
    from astroquery.simbad import Simbad
    s = Simbad()
    try:
        s.add_votable_fields("pmra", "pmdec")
    except Exception:  # noqa: BLE001
        s.add_votable_fields("pm")
    t = s.query_object(name)
    if t is None or len(t) == 0:
        raise RuntimeError(f"SIMBAD does not know {name!r}")
    cols = {c.lower(): c for c in t.colnames}
    if "ra" in cols and np.issubdtype(t[cols["ra"]].dtype, np.floating):
        ra, dec = float(t[cols["ra"]][0]), float(t[cols["dec"]][0])
    else:  # older astroquery: sexagesimal strings
        from astropy.coordinates import SkyCoord
        import astropy.units as u
        c = SkyCoord(str(t[cols["ra"]][0]), str(t[cols["dec"]][0]), unit=(u.hourangle, u.deg))
        ra, dec = float(c.ra.deg), float(c.dec.deg)
    def _get(k):
        for cand in (k, k.upper(), k.replace("pm", "pm_")):
            if cand.lower() in cols:
                v = t[cols[cand.lower()]][0]
                try:
                    return float(v) if np.isfinite(float(v)) else 0.0
                except (TypeError, ValueError):
                    return 0.0
        return 0.0
    pmra, pmdec = _get("pmra"), _get("pmdec")
    ra2, dec2 = propagate(ra, dec, pmra, pmdec, 2000.0, to_year)
    return ra2, dec2, {"ra_j2000": ra, "dec_j2000": dec, "pmra_mas_yr": pmra, "pmdec_mas_yr": pmdec,
                       "epoch": to_year}


def _json_default(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    raise TypeError(type(o))


# --------------------------------------------------------------------------- #
# Moving objects (asteroids, comets) via IRSA's Moving Object Search Tool
# --------------------------------------------------------------------------- #

MOST_URL = "https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most"


def query_moving(name: str, begin: str, end: str, obj_type: str = "Asteroid") -> list[dict]:
    """Every SPHEREx image that caught a solar-system object, with the object's
    predicted position in each one (MOST uses JPL Horizons orbits)."""
    import requests
    params = {"catalog": "spherex", "input_type": "name_input", "obj_name": name, "obj_type": obj_type,
              "obs_begin": begin, "obs_end": end, "output_mode": "Brief"}
    txt = requests.get(MOST_URL, params=params, timeout=300).text
    lines = txt.splitlines()
    heads = [l for l in lines if l.startswith("|")]
    if not heads:
        raise RuntimeError("MOST: " + " ".join(l.strip() for l in lines[:8] if l.strip()))
    hl = heads[0]
    pos = [i for i, c in enumerate(hl) if c == "|"]
    names = [hl[pos[i] + 1:pos[i + 1]].strip() for i in range(len(pos) - 1)]
    rows = []
    for l in lines:
        if l.startswith(("\\", "|")) or not l.strip():
            continue
        r = {n: l[pos[i]:pos[i + 1] + 1].strip() for i, n in enumerate(names)}
        uri = r["uri"]
        rows.append({
            "url": uri if uri.startswith("http") else "https://irsa.ipac.caltech.edu/" + uri.lstrip("/"),
            "obs_id": r.get("observationid", ""),
            "obj_ra": float(r["ra_obj"]), "obj_dec": float(r["dec_obj"]),
            "t_min": float(r["mjd_start"]), "t_max": float(r["mjd_end"]),
            "vmag": float(r["vmag"]) if r.get("vmag") not in (None, "", "null") else None,
            "geo_dist_au": float(r["geo_dist"]) if r.get("geo_dist") else None,
            "sun_dist_au": float(r["sun_dist"]) if r.get("sun_dist") else None,
            "em_min_um": float("nan"), "em_max_um": float("nan"), "band": "",
        })
    return rows


def build_moving(name: str, out_dir, begin: str, end: str, obj_type: str = "Asteroid",
                 label: str | None = None, fov_arcmin: float = 4.0, max_frames: int = 140,
                 visit_gap_days: float = 0.5, workers: int = 8, progress=print, extra: dict | None = None) -> dict:
    """Build a *tracked* target pack: every frame is centred on the moving object,
    so it stays still while the background stars slide past."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    npix = int(math.ceil(fov_arcmin * 60.0 / PIXSCALE_ARCSEC)); npix += (npix + 1) % 2
    size_deg = fov_arcmin / 60.0 * 1.5
    progress(f"Asking MOST which SPHEREx images caught {name} ...")
    rows = query_moving(name, begin, end, obj_type)
    rows.sort(key=lambda r: r["t_min"])
    if len(rows) > max_frames:  # keep evenly spaced frames across the window
        step = len(rows) / max_frames
        rows = [rows[int(i * step)] for i in range(max_frames)]
    progress(f"  using {len(rows)} frames")

    def job(r):
        raw = _download(cutout_url(r["url"], r["obj_ra"], r["obj_dec"], size_deg))
        w = make_output_wcs(r["obj_ra"], r["obj_dec"], npix, PIXSCALE_ARCSEC)
        img, meta = process_frame(raw, r, w, npix, r["obj_ra"], r["obj_dec"])
        return img, meta, r

    images, metas, errors = [], [], []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(job, r) for r in rows]
        for i, f in enumerate(as_completed(futs), 1):
            try:
                img, meta, r = f.result()
                d = asdict(meta)
                d.update(obj_ra=r["obj_ra"], obj_dec=r["obj_dec"], vmag=r["vmag"], geo_dist_au=r["geo_dist_au"], sun_dist_au=r["sun_dist_au"])
                images.append(img); metas.append(d)
            except Exception as e:  # noqa: BLE001
                errors.append(str(e)[:300])
            if i % 10 == 0 or i == len(rows):
                progress(f"  processed {i}/{len(rows)}")
    if not images:
        raise RuntimeError("All downloads failed: " + "; ".join(errors[:3]))
    order = sorted(range(len(metas)), key=lambda k: metas[k]["mjd"])
    images = [images[k] for k in order]; metas = [metas[k] for k in order]
    epochs = assign_epochs([m["mjd"] for m in metas], gap_days=visit_gap_days)
    for i, m in enumerate(metas):
        m["index"], m["epoch"] = i, epochs[i]
    np.stack(images).astype("<f4").tofile(out_dir / "frames.bin")
    epoch_info = []
    for e in sorted(set(epochs)):
        ms = [m for m in metas if m["epoch"] == e]
        epoch_info.append({"id": e, "mjd_mean": float(np.mean([m["mjd"] for m in ms])),
                           "start": mjd_to_iso(min(m["mjd"] for m in ms)), "end": mjd_to_iso(max(m["mjd"] for m in ms)),
                           "n_frames": len(ms),
                           "obj_ra": float(np.mean([m["obj_ra"] for m in ms])), "obj_dec": float(np.mean([m["obj_dec"] for m in ms]))})
    dets = []
    for d in sorted({m["detector"] for m in metas}):
        ms = [m for m in metas if m["detector"] == d]
        dets.append({"id": d, "lam_min_um": float(np.nanmin([m["wavelength_um"] for m in ms])),
                     "lam_max_um": float(np.nanmax([m["wavelength_um"] for m in ms])), "n_frames": len(ms)})
    manifest = {
        "version": 1, "tracking": True, "name": label or name,
        "ra": float(np.mean([m["obj_ra"] for m in metas])), "dec": float(np.mean([m["obj_dec"] for m in metas])),
        "fov_arcmin": fov_arcmin, "npix": npix, "pixscale_arcsec": PIXSCALE_ARCSEC,
        "units": "MJy/sr (zodiacal light subtracted)", "collection": SPHEREX_COLLECTION,
        "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "epochs": epoch_info, "detectors": dets, "frames": metas, "errors": errors[:20], "target": extra or {},
    }
    (out_dir / "manifest.json").write_text(json.dumps(_clean(manifest), indent=1, allow_nan=False, default=_json_default))
    progress(f"Done: {len(metas)} frames, {len(epoch_info)} visits -> {out_dir}")
    return manifest


# --------------------------------------------------------------------------- #
# Known-source catalogues, for the "is this new?" check in the viewer
# --------------------------------------------------------------------------- #

GAIA_EPOCH = 2016.0      # Gaia DR3 reference epoch
CATWISE_EPOCH = 2015.4   # CatWISE2020 reference epoch (MJD 57170)


def fetch_catalogs(ra: float, dec: float, radius_arcmin: float, progress=print) -> dict:
    """Gaia DR3 (optical, precise motions) + CatWISE2020 (infrared, finds cold brown
    dwarfs Gaia misses), both from IRSA, within radius of (ra, dec)."""
    import warnings
    import astropy.units as u
    from astropy.coordinates import SkyCoord
    from astroquery.ipac.irsa import Irsa
    c = SkyCoord(ra * u.deg, dec * u.deg)
    out = {"gaia_epoch": GAIA_EPOCH, "catwise_epoch": CATWISE_EPOCH, "sources": []}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            t = Irsa.query_region(c, catalog="gaia_dr3_source", spatial="Cone", radius=radius_arcmin * u.arcmin,
                                  columns="source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag")
            for r in t:
                out["sources"].append({"cat": "gaia", "id": f"Gaia DR3 {r['source_id']}", "ra": float(r["ra"]), "dec": float(r["dec"]),
                                       "pmra": _f(r["pmra"]), "pmdec": _f(r["pmdec"]), "plx": _f(r["parallax"]), "mag": _f(r["phot_g_mean_mag"]), "band": "G"})
        except Exception as e:  # noqa: BLE001
            progress(f"  Gaia query failed: {e}")
        try:
            t = Irsa.query_region(c, catalog="catwise_2020", spatial="Cone", radius=radius_arcmin * u.arcmin,
                                  columns="source_name,ra,dec,pmra,pmdec,w1mpro,w2mpro")
            for r in t:
                out["sources"].append({"cat": "catwise", "id": f"CWISE {r['source_name']}", "ra": float(r["ra"]), "dec": float(r["dec"]),
                                       "pmra": _f(r["pmra"], 1000), "pmdec": _f(r["pmdec"], 1000), "plx": None,
                                       "mag": _f(r["w2mpro"]), "w1": _f(r["w1mpro"]), "band": "W2"})
        except Exception as e:  # noqa: BLE001
            progress(f"  CatWISE query failed: {e}")
    progress(f"  catalogues: {sum(s['cat'] == 'gaia' for s in out['sources'])} Gaia, {sum(s['cat'] == 'catwise' for s in out['sources'])} CatWISE")
    return out


def _f(v, scale=1.0):
    try:
        x = float(v) * scale
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def add_catalogs(pack_dir, progress=print) -> None:
    pack_dir = Path(pack_dir)
    m = json.loads((pack_dir / "manifest.json").read_text())
    if m.get("tracking"):
        return
    cat = fetch_catalogs(m["ra"], m["dec"], m["fov_arcmin"] * 0.75 + 0.5, progress)
    (pack_dir / "catalog.json").write_text(json.dumps(_clean(cat), separators=(",", ":")))
