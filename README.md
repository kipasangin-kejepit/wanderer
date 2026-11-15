# Wanderer: watch the SPHEREx sky change

Built by **astro3club** for the 2026 NASA Space Apps Challenge, *Planet X and SPHEREx*.

Wanderer is a sky you can fly around in. Drag to move, scroll to zoom, or type a
name or coordinates and fly there. Wherever there is SPHEREx data, the real SPHEREx
images are painted onto the sky at their true position and play as a short "video"
across survey epochs, so anyone can spot things that move (brown dwarfs, nearby
stars, asteroids) or change brightness (variable stars).

## Features

| Brief asks for | Wanderer |
|---|---|
| Enter RA/Dec, see the patch as a little video | Full-screen pannable sky (Aladin Lite). Search takes names, decimal or sexagesimal coordinates and flies there. Epochs play as a blink animation on the sky |
| Use the 102 infrared bands | Pick any of the 6 detectors (0.75–5.0 µm), or **Color** mode (blue = short, red = long wavelengths) |
| Add per-detector data to boost signal | Every frame from the same detector and epoch is median-stacked in the browser (robust to cosmic rays) |
| Generate spectra on the fly | Click any pixel to get its spectrum (every frame's wavelength) per epoch, plus a light curve |
| Add/subtract images from different times | **Difference** mode: orange = brighter now, blue = fainter now |
| User-chosen field of view | 3′ to 15′ |
| Overlay Gaia / WISE | The sky behind SPHEREx is WISE, 2MASS or DSS; Gaia DR3 stars on demand; an opacity slider blends SPHEREx with it |
| Coordinates in the URL | `?ra=133.795&dec=-7.245&fov=6`, `?target=wise0855&mode=diff&band=6`, `&embed=1` for embedding |
| Show metadata like contamination flags | Masked-pixel fraction and flag counts (HOT, TRANSIENT…) per target |
| Easy to update with new data | One command rebuilds any target with the latest release (DR1 + weekly Quick Release 3; the 7 built-in packs were made from QR2) |
| *Extra* | **Find movers** compares each detector with itself across epochs and flags moved/brightened/faded sources. **Predicted motion** draws where a known star should be at each epoch |

## The experience

1. **Boot:** the terminal powers on and links to SPHEREx.
2. **Starmap:** a 3D map of every star within 15 light years (Three.js). Drag to rotate, click a star to lock on, then **Warp**.
3. **Sky view:** the real sky (Aladin Lite). Click any star and a holographic projection screen shows what it is (SIMBAD), its coordinates, distance and motion, plus a live SPHEREx feed when we have an archive for it.
4. **Time slider:** scrub through the survey epoch by epoch, or switch to **Every frame** to step through each individual SPHEREx exposure in time order.
5. **Solar System visitors:** the interstellar comet **3I/ATLAS** and the asteroid **10 Hygiea**, found with IRSA's Moving Object Search Tool. The SPHEREx frame follows the object across the real sky (dashed path) while background stars slide past. Click the Sun on the starmap to reach them.
6. **Discovery log:** 7 achievements. **Easter eggs:** alien "transmissions" at famous spots (Wow! signal, Tabby's Star, TRAPPIST-1…), search for `aliens` or `planet x`, and a cheat code. Unknown signals pulse magenta on the starmap and in the sky. Transmissions are labelled fiction; the facts inside are real.

Add `?target=wise0855` (or `?ra=…&dec=…`) to skip straight to the sky view.

## What we found in real SPHEREx data

- **Barnard's Star** moves north by about one SPHEREx pixel between surveys, matching its known 10″/yr motion. Find movers flags it and ignores the field stars.
- **Epsilon Indi B** shows a clear moved-object pair at the centre in the 4.4–5.0 µm detector.
- **WISE 0855-0714** appears as a very red source, bright at 4.5 µm and invisible below 2.4 µm. It sits where it should be only if the challenge coordinates are its ~2010.5 WISE discovery position, not J2000; between epochs it shifts west, the direction it is known to move. Turn on **Smooth** and **Color** to see it.
- **RW Aurigae** brightened by 1.5–1.9× at 1.1–2.4 µm between September 2025 and February 2026, while staying flat at 4–5 µm.
- Very bright stars (Barnard's Star, R Draconis) saturate the SPHEREx core; the light curve then uses the flux in the PSF wings.

## Quick start (on your laptop)

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 1. Build the five challenge test targets (downloads cutouts from NASA IRSA)
python pipeline/build_cache.py
#    quick test with a few frames first:
python pipeline/build_cache.py --only wise0855 --max-frames 20

# 2a. Static viewer (only pre-built targets)
python -m http.server 8000 --directory web

# 2b. OR live server (any coordinates, built on demand)
uvicorn server:app --port 8000
```

Open http://localhost:8000.

Asteroids and comets (tracked on the object):
```bash
python pipeline/build_cache.py --moving 3iatlas,hygiea
```

Other targets:
```bash
python pipeline/build_cache.py --name "Proxima Cen" --slug proxima --fov 6
python pipeline/build_cache.py --ra 83.82 --dec -5.39 --slug orion --fov 4
```

To test the viewer without internet, run `python pipeline/make_synthetic.py`
and open `/?target=_synthetic&synthetic=1`. That data is **fake** and labelled so.

## How it works

```
IRSA SIA query (collection spherex_qr2)
  -> cutout of every frame covering the target (IRSA cutout service)
  -> subtract ZODI plane, mask bad pixels via FLAGS bitmap (SOURCE bit kept)
  -> resample onto one north-up grid centred on the target
  -> record time, detector, wavelength at the target (spectral WCS 'W')
  -> group frames into survey epochs (gaps > 60 days)
  -> web/data/<slug>/manifest.json + frames.bin (float32 cube)
Browser: co-add, stretch (one shared stretch across epochs so brightness changes
         are real), difference, spectra, light curves, mover detection.
```

Fast-moving targets are centred on their proper-motion-corrected position for
2026 (SIMBAD, or the built-in table in `build_cache.py`).

## Deploying

**Static (GitHub Pages):** build the packs, commit `web/data/`, then enable
Pages with "GitHub Actions" as the source. The included workflow publishes `web/`.

**Live server:** any host that runs Python (Render, Railway, Hugging Face Spaces):
`uvicorn server:app --host 0.0.0.0 --port $PORT`. To point a static site at a
remote API, add `<script>window.WANDERER_API="https://your-api"</script>` before `app.js`.

## Known limitations

- SPHEREx has only a few all-sky passes so far, so each target has 2–3 epochs.
- Wavelength per frame is taken at the target pixel. Across a small cutout the
  linear-variable filter changes wavelength slightly; spectra are approximate.
- The FLAGS bit names are read from the FITS header (`MP_*` keywords). If a
  release omits them, nothing is masked and the viewer reports no flags.

## Credits

SPHEREx data: NASA / JPL-Caltech, distributed by IPAC/IRSA. Sky context: Aladin Lite
(CDS, Strasbourg). Gaia DR3: ESA. Python: astropy, astroquery.

## Discovery pipeline (analysis.js)

Every candidate goes through the same end-to-end chain, all in the browser:

1. **Fetch**: SPHEREx QR2 cut-outs from IRSA (new scans: DR1 + QR3, since IRSA retired QR2 from searches in Nov 2026), plus Gaia DR3 and CatWISE2020 for the field.
2. **Detect**: per-detector, noise-normalised difference of the first and last epoch; peaks ≥ 6σ are paired into movers or brightness changes.
3. **Is it known?**: each catalogue star is moved to the SPHEREx date with its proper motion before matching.
4. **Vet** (0–100): five artefact tests: multi-detector, frame-by-frame consistency, PSF shape, masked/flagged pixels, bright-star glare.
5. **Classify by spectrum**: aperture photometry of every frame gives a 0.75–5 µm spectrum. Colours are self-calibrated on the field stars in the same pack (a normal star = 0). Rules use the 1.4 µm water band, the 3.3 µm methane band, the 4.26 µm CO₂ band and the 2.2→4.6 µm slope.
6. **Report**: one click writes a printable report (save as PDF) with images, spectrum, light curve, vetting, conclusion and next steps, plus a pre-filled link to the team's Google Form.

Results on the challenge targets:

| Target | Classifier says | Why |
|---|---|---|
| Epsilon Indi B | T-type brown dwarf (high) | 84% water absorption at 1.4 µm, CH₄−M = 1.3 mag |
| WISE 0855 | Y-type / very cold brown dwarf (high) | K−M ≈ 1.5, CH₄−M ≈ 1.7, L−M ≈ 1.3 mag |
| 10 Hygiea | Asteroid (sunlight + heat) | K−M ≈ 1.4 mag thermal excess |
| 3I/ATLAS | Comet, CO₂ gas (tentative) | 4.26 µm band ~90× the continuum |
| RW Aurigae | Strong IR excess (low, saturated) | dusty disk; measured from PSF wings |
| Barnard's Star, R Draconis | Too bright (saturated) | cores masked in most frames |

## Validation and the red-source survey

See `survey/VALIDATION.md`. In short:
- **Find movers** recovers 88–100% of fake movers at W2 ≲ 14 moving ≥ 12″/yr, with 0/80 false movers. The test found and fixed a bug that had been throwing faint movers away.
- **Classifier**: 49/49 field stars come out "normal star". On 38 very red CatWISE sources, v1 wrongly called 6 of 8 galaxies brown dwarfs. v2 (methane trough + motion) gives 0/30 false brown dwarfs, and shows that half the "fast, extremely red" catalogue entries are not seen by SPHEREx at all.
- In the site: **★ Survey** chip.

## Spot the Wanderer (home page, `index.html`)

The site opens on Spot the Wanderer. The full sky explorer (starmap, Aladin, Find movers, vetting, reports) is at `explore.html`.

A Zooniverse-style page for everyone (inspired by Planet Hunters TESS). You scan a **whole 20′ SPHEREx field** flashing between two dates and **click everything that moved or changed**. A 4-card tutorial uses real close-ups. When you press Done, the page reveals:
- the 1–3 simulated movers hidden in that field (your score),
- real catalogued fast stars (e.g. Barnard's Star),
- what the computer's Find movers kept after vetting.

Your marks that match nothing known are the interesting ones, and "Look closer" opens them in the full explorer to vet and report, and "✉ Tell the team" opens an e-mail to astro3club@gmail.com with the exact RA/Dec and links. Every finished field is also sent anonymously (random session id, no names or e-mails) to the team's Google Sheet via `apps-script/Code.gs`. There are 12 fields: the 5 challenge targets plus 7 survey areas.

### Fresh sky every week (automatic)

NASA/IRSA publish new SPHEREx Quick Release 3 images every week. `.github/workflows/weekly.yml` runs every Tuesday (Jakarta time) on GitHub's free runners:

1. tries random positions at |b| > 20° until it finds sky with **QR3 images newer than the last run** and **DR1 images ≥ 150 days older**;
2. builds a 20′ pack (`pipeline/spherex.py`), runs the site's own Find movers + vetting in headless Chromium (`pipeline/find_movers_dump.js`);
3. plants the practice movers and writes the blink pictures (`make_fields.make_one`);
4. commits them; the Pages workflow redeploys. New fields appear first on the home page with a **NEW THIS WEEK** badge. The last 8 weekly fields are kept.

Run it by hand: GitHub → Actions → *Weekly fresh SPHEREx sky* → **Run workflow**, or locally `python pipeline/weekly_update.py` (needs `pip install pillow` and `npm i playwright`).

To rebuild: `python pipeline/build_wide.py` → browser dump of Find-movers results (`pipeline/wide_dump.json`) → `python pipeline/make_fields.py`.
