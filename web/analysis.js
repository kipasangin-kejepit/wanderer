/* Wanderer analysis layer: vetting, spectral classification and candidate reports.
 *
 * Runs entirely in the browser on the SPHEREx pack that app.js has loaded
 * (window.WandererCore). Three jobs:
 *   1. classify(x, y): read the 0.75–5 µm SPHEREx spectrum at a pixel and say what kind
 *      of object it most likely is (normal star, T/Y brown dwarf, dusty star, asteroid,
 *      comet...). Colours are calibrated against the field stars in the same pack, so a
 *      normal star sits at 0 in every colour no matter how the aperture or units behave.
 *   2. vet(candidate): score a Find-movers detection 0–100 on how likely it is to be a
 *      real astrophysical change rather than an artefact.
 *   3. report(candidate): write a self-contained scientific report page (print to PDF),
 *      with a pre-filled link to the Wanderer team's Google Form.
 */
(() => {
  "use strict";
  const core = () => window.WandererCore;
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "–" : Number(v).toFixed(d));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Wavelength windows (µm). J/H/K/L/M are classic infrared bands; W14 sits in the
  // 1.4 µm water band, CH4 on the 3.3 µm methane band, CO2 on the 4.26 µm CO2 band.
  const WIN = { J: [1.2, 1.3], W14: [1.36, 1.46], H: [1.55, 1.75], K: [2.1, 2.35], CH4: [3.2, 3.5], L: [3.8, 4.1], CO2: [4.2, 4.32], M: [4.4, 4.8] };
  const mid = (k) => 0.5 * (WIN[k][0] + WIN[k][1]);
  const COLOURS = [["JK", "J", "K"], ["KL", "K", "L"], ["KM", "K", "M"], ["CM", "CH4", "M"], ["LM", "L", "M"]];

  // ---------------- photometry ----------------
  // Sum inside r ≤ 2 px minus the median sky in a 5–8 px ring. Needs 75% of the core
  // unmasked; saturated stars (masked cores) return NaN and are handled separately.
  function apSum(arr, n, x, y) {
    const xi = Math.round(x), yi = Math.round(y); let s = 0, ok = 0, tot = 0; const ring = [];
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      const xx = xi + dx, yy = yi + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const r = Math.hypot(xx - x, yy - y), v = arr[yy * n + xx];
      if (r <= 2) { tot++; if (v === v) { s += v; ok++; } } else if (r >= 5 && r <= 8 && v === v) ring.push(v);
    }
    if (ok < 0.75 * tot || ring.length < 5) return NaN;
    ring.sort((a, b) => a - b); const bg = ring[ring.length >> 1];
    return (s - bg * ok) * (tot / ok);
  }
  // PSF-wing flux (2.2–4.5 px) for saturated stars. Less reliable: the PSF changes with wavelength.
  function apWing(arr, n, x, y) {
    const xi = Math.round(x), yi = Math.round(y); let s = 0, ok = 0, tot = 0; const ring = [];
    for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
      const xx = xi + dx, yy = yi + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const r = Math.hypot(xx - x, yy - y), v = arr[yy * n + xx];
      if (r > 2.2 && r <= 4.5) { tot++; if (v === v) { s += v; ok++; } } else if (r >= 6 && r <= 9 && v === v) ring.push(v);
    }
    if (ok < 0.6 * tot || ring.length < 5) return NaN;
    ring.sort((a, b) => a - b); return s / ok - ring[ring.length >> 1];
  }
  const median = (a) => { const v = a.filter((x) => x === x).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : NaN; };
  const madSig = (a, med) => 1.4826 * median(a.map((x) => Math.abs(x - med)));

  // Fluxes of every frame at a position. pos(epoch) lets a moving source be followed.
  function frameFluxes(pos, wing) {
    const { S } = core(), { m, cube, n } = S.pack, N = n * n, out = [];
    m.frames.forEach((f, k) => {
      const [x, y] = pos(f.epoch), a = cube.subarray(k * N, (k + 1) * N);
      out.push({ lam: f.wavelength_um, mjd: f.mjd, epoch: f.epoch, det: f.detector, f: wing ? apWing(a, n, x, y) : apSum(a, n, x, y) });
    });
    return out;
  }
  function windows(fl) {
    const F = {};
    for (const [k, [lo, hi]] of Object.entries(WIN)) {
      const v = fl.filter((p) => p.lam >= lo && p.lam < hi && p.f === p.f).map((p) => p.f);
      if (v.length < 2) { F[k] = [NaN, NaN, v.length]; continue; }
      const med = median(v); F[k] = [med, (1.25 * madSig(v, med)) / Math.sqrt(v.length) || Math.abs(med) * 0.05, v.length];
    }
    return F;
  }
  // Colour a−b in magnitudes, normalised so a Rayleigh–Jeans (hot star) spectrum gives 0.
  // Positive = redder (relatively brighter at the longer wavelength).
  function colours(F) {
    const out = {};
    for (const [name, a, b] of COLOURS) {
      const [fa, ea] = F[a], [fb, eb] = F[b];
      out[name] = fa > 0 && fb > 0 ? [2.5 * Math.log10((fb / fa) * (mid(b) / mid(a)) ** 2), 1.086 * Math.hypot(ea / fa, eb / fb)] : [NaN, NaN];
    }
    const [j, ej] = F.J, [h, eh] = F.H, [w, ew] = F.W14;
    out.h2o = j > 0 && h > 0 && w === w ? [1 - w / Math.sqrt(j * h), Math.hypot(ew / Math.sqrt(j * h), 0.5 * (w / Math.sqrt(j * h)) * Math.hypot(ej / j, eh / h))] : [NaN, NaN];
    const cont = 0.5 * (F.L[0] + F.M[0]);
    out.co2 = F.CO2[0] === F.CO2[0] && cont === cont ? [F.CO2[0] - cont, Math.hypot(F.CO2[1], 0.5 * Math.hypot(F.L[1], F.M[1]))] : [NaN, NaN];
    return out;
  }

  // ---------------- self-calibration against field stars ----------------
  // Find the brightest unsaturated point sources in the pack and take their median
  // colours as the "normal star" zero point. Cached per pack.
  const zpCache = new Map();
  function zeroPoint() {
    const { S, epochCoaddRaw } = core(), slug = S.slug;
    if (zpCache.has(slug)) return zpCache.get(slug);
    const DEFAULT = { JK: 1.0, KL: 0.12, KM: 0, CM: 0, LM: -0.1, h2o: 0, nStars: 0 };
    let zp = DEFAULT;
    if (!S.pack.m.tracking) {
      const n = S.pack.n, img = epochCoaddRaw(0, 0), pk = [];
      for (let y = 8; y < n - 8; y++) for (let x = 8; x < n - 8; x++) {
        const v = img[y * n + x]; if (!(v === v)) continue;
        let top = true;
        for (let dy = -3; dy <= 3 && top; dy++) for (let dx = -3; dx <= 3; dx++) { const w = img[(y + dy) * n + x + dx]; if ((dx || dy) && w > v) { top = false; break; } }
        if (top) pk.push([v, x, y]);
      }
      pk.sort((a, b) => b[0] - a[0]);
      const sets = {}; let used = 0;
      for (const [, x, y] of pk.slice(0, 25)) {
        const fl = frameFluxes(() => [x, y]);
        if (fl.filter((p) => p.f === p.f).length < 0.8 * fl.length) continue; // saturated or edge
        const c = colours(windows(fl));
        if (!(c.KM[1] < 0.15 && c.JK[1] < 0.15)) continue;
        for (const k of ["JK", "KL", "KM", "CM", "LM", "h2o"]) (sets[k] = sets[k] || []).push(c[k][0]);
        if (++used >= 10) break;
      }
      if (used >= 3) { zp = { nStars: used }; for (const k of Object.keys(sets)) zp[k] = median(sets[k]); }
    }
    zpCache.set(slug, zp);
    return zp;
  }

  // ---------------- classification ----------------
  function methaneDepth(F) {
    const [k, ek] = F.K, [l, el] = F.L, [ch, ech] = F.CH4;
    if (!(k > 0 && l > 0) || !(ch === ch)) return [NaN, NaN];
    const w = Math.log(mid("CH4") / mid("K")) / Math.log(mid("L") / mid("K")), interp = k ** (1 - w) * l ** w;
    return [1 - ch / interp, Math.hypot(ech / interp, (ch / interp) * Math.hypot((1 - w) * ek / k, w * el / l))];
  }
  function motionHere(x, y) {
    const K = core(); if (!K.S.cat) return null;
    const [ra, dec] = K.pixToWorld(x, y), k = K.knownNear(ra, dec, K.yearNow(), 9);
    if (!k) return null;
    return { id: k.src.id, cat: k.src.cat, pm: Math.hypot(k.src.pmra || 0, k.src.pmdec || 0) };
  }
  function classify(x, y, opts = {}) {
    const { S } = core(), m = S.pack.m;
    const pos = opts.pos || (() => [x, y]);
    let mode = "core", fl = frameFluxes(pos);
    const valid = fl.filter((p) => p.f === p.f).length;
    if (valid < 0.4 * fl.length) { mode = "wing"; fl = frameFluxes(pos, true); }
    const F = windows(fl), raw = colours(F), zp = zeroPoint(), c = {};
    for (const k of ["JK", "KL", "KM", "CM", "LM", "h2o"]) c[k] = [raw[k][0] - (zp[k] || 0), raw[k][1]];
    c.co2 = raw.co2;
    const good = (k, maxErr = 0.35) => c[k][0] === c[k][0] && c[k][1] <= maxErr;
    const snrM = F.M[0] / F.M[1], snrK = F.K[0] / F.K[1];
    const r = { mode, F, c, zp, fl, label: "", short: "", family: "", evidence: [], confidence: mode === "wing" ? "low" : "medium" };
    const ev = (t) => r.evidence.push(t);

    if (m.tracking) {
      r.family = "solar-system";
      const co2snr = c.co2[0] / c.co2[1], co2ratio = c.co2[0] / Math.max(1e-9, 0.5 * Math.abs(F.L[0] + F.M[0]));
      // a very strong, narrow bump can be trusted at lower formal S/N (few frames hit 4.26 µm)
      if ((co2snr > 3 && co2ratio > 3) || (co2snr > 1.5 && co2ratio > 10 && F.CO2[2] >= 3)) {
        r.short = "Comet (CO₂ gas)"; r.label = `Comet: carbon-dioxide gas glowing at 4.26 µm${co2snr < 3 ? " (tentative)" : ""}`;
        ev(`Flux in the 4.2–4.32 µm CO₂ band is ${fmt(c.co2[0] / Math.max(1e-9, 0.5 * (F.L[0] + F.M[0])), 0)}× the neighbouring continuum (${fmt(c.co2[0] / c.co2[1], 1)}σ excess).`);
        ev("A narrow emission bump there is the signature of CO₂ released from an icy nucleus. Rocks don't do this.");
      } else if (good("KM") && c.KM[0] > 0.7) {
        r.short = "Asteroid (sunlight + heat)"; r.label = "Asteroid: reflected sunlight plus its own thermal glow";
        ev(`K−M colour is ${fmt(c.KM[0])} mag redder than a star: extra light at 4–5 µm from the sun-warmed surface.`);
        ev("At short wavelengths the spectrum follows reflected sunlight; past ~3.5 µm the object's own heat takes over.");
      } else {
        r.short = "Solar-system body"; r.label = "Solar-system body: reflected sunlight";
        ev("Colours follow reflected sunlight with no clear thermal or gas signature at this signal-to-noise.");
      }
      r.confidence = "medium";
      return r;
    }
    if (mode === "wing" && !(F.K[0] === F.K[0])) {
      r.short = "Too bright (saturated)"; r.label = "Too bright for SPHEREx photometry";
      r.family = "unknown"; r.confidence = "none";
      ev("The star's core is saturated in most frames, so its spectrum cannot be measured reliably.");
      return r;
    }
    if (mode === "wing") {
      // PSF wings change shape with wavelength, so only a very large excess means anything
      r.confidence = "low"; r.family = good("KM", 0.5) && c.KM[0] > 1.5 ? "dusty" : "unknown";
      if (r.family === "dusty") { r.short = "Strong IR excess (saturated star)"; r.label = "Strong infrared excess: lots of warm dust (rough, from a saturated star's PSF wings)"; ev(`K−M ≈ ${fmt(c.KM[0], 1)} mag redder than field stars even in the PSF wings; typical of a young star with a disk or a dusty giant.`); }
      else { r.short = "Too bright (saturated)"; r.label = "Too bright for SPHEREx photometry"; r.confidence = "none"; ev("The core is saturated and the PSF wings show no unusual colour."); }
      ev("Core saturated: measured from the PSF wings, which change shape with wavelength. Treat as rough.");
      return r;
    }
    if (!(snrK > 3 || snrM > 3)) {
      r.short = "Not detected"; r.label = "Not detected by SPHEREx here (too faint, or nothing is there)"; r.family = "unknown"; r.confidence = "none";
      ev(`Signal-to-noise is only ${fmt(Math.max(snrK, snrM, 0), 1)} in the best band.`);
      return r;
    }
    // Methane = a TROUGH at 3.3 µm below the line joining 2.2 µm and 3.95 µm (log-log).
    // A plain red power law (a dusty active galaxy) sits on that line; our first version
    // used the CH4−M colour instead and the red-source survey showed galaxies fooled it.
    const md = methaneDepth(F), water = good("h2o", 0.15) && c.h2o[0] > 0.35;
    r.c.ch4depth = md;
    const methane = md[0] === md[0] && md[0] > 0.35 && md[0] > 3 * md[1];
    // "red" if even the pessimistic (2σ) colour is red, so faint sources with big error bars still count
    const redM = c.KM[0] === c.KM[0] && c.KM[0] - 2 * c.KM[1] > 1.0, veryRedLM = c.LM[0] === c.LM[0] && c.LM[0] - 2 * c.LM[1] > 0.8;
    // Motion from the catalogue match: nearby things move, distant galaxies don't.
    // CatWISE motions of faint sources are noisy (~0.1–0.2″/yr), so its thresholds are wider than Gaia's.
    const mot = motionHere(x, y), gaiaM = mot && mot.cat === "gaia";
    const moving = mot && mot.pm > (gaiaM ? 100 : 250), still = mot && mot.pm < (gaiaM ? 20 : 100);
    if (mot) ev(`Catalogue match ${mot.id}: proper motion ${fmt(mot.pm / 1000, 2)}″/yr${moving ? " (nearby: it moves)" : still ? " (no measurable motion)" : ""}.`);
    if (methane && water) {
      r.family = "brown-dwarf"; r.short = "T-type brown dwarf"; r.label = "T-type brown dwarf: water and methane absorption";
      ev(`Water: ${fmt(100 * c.h2o[0], 0)}% of the light is missing at 1.4 µm (field stars: ~0%).`);
      ev(`Methane: the 3.3 µm band dips ${fmt(100 * md[0], 0)}% below the continuum (field stars: 0 ± 8%).`);
      ev("Both together only happen below ~1,300 K. That's too cold to be a star.");
      r.confidence = mode === "wing" ? "low" : "high";
    } else if (redM && moving) {
      const yType = veryRedLM;
      r.family = "brown-dwarf"; r.short = yType ? "Y-type / very cold brown dwarf" : "Cold brown dwarf";
      r.label = yType ? "Very cold (Y-type) brown dwarf: very red, and close enough to move" : "Cold brown dwarf: very red at 4–5 µm, and close enough to move";
      ev(`K−M = ${fmt(c.KM[0])}${good("LM") ? `, L−M = ${fmt(c.LM[0])}` : ""} mag redder than normal stars${methane ? `, with a ${fmt(100 * md[0], 0)}% methane dip` : ""}.`);
      ev("Red AND moving rules out a distant galaxy: this is a nearby object colder than any star.");
      r.confidence = methane || yType ? "high" : "medium";
    } else if (redM && still) {
      r.family = "galaxy"; r.short = "Dusty active galaxy (likely)"; r.label = "Probably a dusty active galaxy: very red but not moving, so far away";
      ev(`K−M = ${fmt(c.KM[0])} mag: a steep red slope${methane ? "" : " with no methane trough"}, typical of hot dust around a feeding black hole.`);
      ev("No motion in the catalogue: brown dwarfs that red are close by and would move.");
      r.confidence = methane ? "low" : "medium";
    } else if (redM) {
      r.family = methane ? "brown-dwarf" : "red"; r.short = methane ? "Brown dwarf candidate (methane)" : "Very red: brown dwarf or galaxy?";
      r.label = methane ? "Brown dwarf candidate: methane trough at 3.3 µm" : "Very red source: a cold brown dwarf or a dusty galaxy. Motion would tell";
      ev(`K−M = ${fmt(c.KM[0])} mag redder than normal stars${methane ? `; methane dip ${fmt(100 * md[0], 0)}%` : ""}.`);
      ev("No reliable motion measurement here. Check WISE/CatWISE proper motion to decide.");
      r.confidence = methane ? "medium" : "low";
    } else if (water) {
      r.family = "cool-star"; r.short = "Very cool star (water bands)"; r.label = "Very cool star (late M, L dwarf or Mira giant): strong water absorption";
      ev(`${fmt(100 * c.h2o[0], 0)}% of the light is missing in the 1.4 µm water band, but no methane.`);
    } else if (good("KM") && c.KM[0] - 2 * c.KM[1] > 0.5) {
      r.family = "dusty"; r.short = "Infrared excess (warm dust)"; r.label = "Infrared excess: warm dust around a star (young-star disk or dusty shell)";
      ev(`K−M = ${fmt(c.KM[0])} mag redder than normal stars, without methane or water bands: extra 4–5 µm light from dust at a few hundred kelvin.`);
    } else if (!good("KM") || !good("JK")) {
      r.family = "unknown"; r.short = "Unclear (noisy colours)"; r.label = "Detected, but the colours are too noisy to say what it is";
      r.confidence = "none";
      ev(`K−M = ${fmt(c.KM[0])} ± ${fmt(c.KM[1])} mag: the error bar is too big for a verdict.`);
    } else {
      r.family = "star"; r.short = "Normal star"; r.label = "Normal star: colours match the field stars";
      ev(`All colours within ${fmt(Math.max(...["JK", "KM"].map((k) => Math.abs(c[k][0] || 0))), 2)} mag of the field-star average.`);
    }
    if (r.family === "brown-dwarf" && r.confidence !== "high") ev("Confirm with WISE colours (W1−W2) or a spectrum before calling it.");
    return r;
  }

  // ---------------- vetting ----------------
  const diffCache = new Map();
  function diffFor(band) {
    const { S, diffSigma } = core(), last = S.pack.m.epochs.length - 1, key = `${S.slug}|${band}|${S.smooth ? 1 : 0}`;
    if (!diffCache.has(key)) diffCache.set(key, diffSigma(0, last, band));
    return diffCache.get(key);
  }
  const mfCache = new Map();
  function maskFrac() {
    const { S } = core(), { m, cube, n } = S.pack, N = n * n;
    if (mfCache.has(S.slug)) return mfCache.get(S.slug);
    const bad = new Float32Array(N);
    for (let k = 0; k < m.frames.length; k++) for (let p = 0; p < N; p++) if (!(cube[k * N + p] === cube[k * N + p])) bad[p]++;
    for (let p = 0; p < N; p++) bad[p] /= m.frames.length;
    mfCache.set(S.slug, bad); return bad;
  }
  function peakNear(D, n, x, y, sign, r = 1) {
    let best = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const v = D[yy * n + xx] * sign; if (v > best) best = v;
    }
    return best;
  }
  function vet(mv) {
    const { S, epochCoaddRaw } = core(), { m, cube, n } = S.pack, N = n * n, last = m.epochs.length - 1;
    const sign = mv.kind === "fainter" ? -1 : 1, tests = [];
    const add = (name, status, detail, weight) => tests.push({ name, status, detail, weight });

    // 1. Seen in several detectors (real objects shine in more than one colour)
    const dets = m.detectors.map((d) => d.id);
    let nSeen = 0; const seenIn = [];
    for (const d of dets) { if (peakNear(diffFor(d), n, mv.x, mv.y, sign) >= 3) { nSeen++; seenIn.push(`D${d}`); } }
    add("Multi-detector", nSeen >= 3 ? "pass" : nSeen === 2 ? "warn" : "fail",
      nSeen ? `Change above 3σ in ${nSeen}/${dets.length} detectors (${seenIn.join(", ")}).${nSeen === 1 ? " Could still be real if the object is extremely red." : ""}` : "Not above 3σ in any single detector.", 25);

    // 2. Consistent across individual frames (cosmic rays and persistence hit one or two)
    const refAp = {}, sel = m.frames.map((f, k) => [f, k]).filter(([f]) => f.epoch === last && (S.band === 0 || f.detector === S.band));
    let agree = 0, tot = 0;
    for (const [f, k] of sel) {
      if (!(f.detector in refAp)) refAp[f.detector] = apSum(epochCoaddRaw(0, f.detector), n, mv.x, mv.y);
      const v = apSum(cube.subarray(k * N, (k + 1) * N), n, mv.x, mv.y), ref = refAp[f.detector];
      if (v === v && ref === ref) { tot++; if (Math.sign(v - ref) === sign) agree++; }
    }
    const frac = tot ? agree / tot : 0;
    add("Frame consistency", tot < 5 ? "warn" : frac >= 0.65 ? "pass" : frac >= 0.5 ? "warn" : "fail",
      tot ? `${agree}/${tot} individual frames in the last epoch agree on the direction of the change (${fmt(100 * frac, 0)}%).` : "Too few unmasked frames to check.", 25);

    // 3. Shape: a single hot pixel or cosmic ray is sharper than the SPHEREx PSF
    const D = diffFor(S.band), at = (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? NaN : D[y * n + x] * sign);
    const pk = at(mv.x, mv.y), nb = [at(mv.x + 1, mv.y), at(mv.x - 1, mv.y), at(mv.x, mv.y + 1), at(mv.x, mv.y - 1)].filter((v) => v === v);
    const ratio = nb.length && pk > 0 ? nb.reduce((a, b) => a + b, 0) / nb.length / pk : NaN;
    add("PSF shape", !(ratio === ratio) ? "warn" : ratio < 0.05 ? "fail" : ratio < 0.1 || ratio > 0.95 ? "warn" : "pass",
      ratio === ratio ? `Neighbouring pixels carry ${fmt(100 * ratio, 0)}% of the peak signal${ratio < 0.05 ? ": too sharp for a star (hot pixel or cosmic ray?)" : ratio < 0.1 ? ": sharper than usual, borderline" : ratio > 0.95 ? ": flatter than a point source (extended or blended?)" : ", like a real point source"}.` : "Could not measure.", 20);

    // 4. Masked / flagged pixels at that spot
    let bad = 0, all = 0;
    for (let k = 0; k < m.frames.length; k++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = mv.x + dx, yy = mv.y + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      all++; const v = cube[k * N + yy * n + xx]; if (!(v === v)) bad++;
    }
    const bf = all ? bad / all : 1;
    add("Data quality flags", bf > 0.4 ? "fail" : bf > 0.15 ? "warn" : "pass", `${fmt(100 * bf, 0)}% of pixels around it were flagged bad (saturation, persistence, cosmic rays…) and masked.`, 15);

    // 5. Glare: a much brighter star right next to it makes fake changes
    const img = epochCoaddRaw(0, 0), here = Math.max(1e-9, Math.abs(apSum(img, n, mv.x, mv.y)) || 1e-9);
    let glare = 0, gd = 0;
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      const d = Math.hypot(dx, dy); if (d <= 3 || d > 8) continue;
      const xx = mv.x + dx, yy = mv.y + dy; if (xx < 2 || yy < 2 || xx >= n - 2 || yy >= n - 2) continue;
      const v = img[yy * n + xx]; if (v === v && v > glare) { glare = v; gd = d; }
    }
    const peakHere = Math.max(1e-9, img[mv.y * n + mv.x] || 1e-9), gr = glare / peakHere;
    // a saturated star shows up as a hole of masked pixels in the stack
    // Saturated stars are masked in most frames. Their huge PSF wings and ghosts reach far,
    // and a variable one (like the Mira R Dra) fakes "changes" all around it.
    const mf = maskFrac();
    let selfHole = 0, satD = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = mv.x + dx, yy = mv.y + dy; if (xx >= 0 && yy >= 0 && xx < n && yy < n && mf[yy * n + xx] > 0.5) selfHole++; }
    const self = selfHole >= 2 || bf > 0.4;
    if (!self) for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
      const xx = mv.x + dx, yy = mv.y + dy, d = Math.hypot(dx, dy); if (d > 16 || xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      if (mf[yy * n + xx] > 0.5 && d < satD) satD = d;
    }
    const satNear = satD <= 7, satFar = satD > 7 && satD <= 16;
    const halo = self && !mv.known; // masked area but no catalogued star here: the halo of a saturated star
    add("Bright-star glare", halo ? "fail" : self ? "warn" : satNear || gr > 20 ? "fail" : satFar || gr > 5 ? "warn" : "pass",
      halo ? "Inside the masked halo of a saturated star, with no catalogued source here: almost certainly glare or ghosting."
        : self ? "The candidate is itself a saturated bright star: its motion is measured from the PSF wings, which is less precise."
        : satNear ? `Only ${fmt(satD * m.pixscale_arcsec, 0)}″ from a saturated star; its wings and ghosts easily fake changes.`
        : satFar ? `A saturated star sits ${fmt(satD * m.pixscale_arcsec, 0)}″ away; its far wings and ghosts can fake changes.`
        : gr > 5 ? `A source ${fmt(gr, 0)}× brighter sits ${fmt(gd * m.pixscale_arcsec, 0)}″ away; its PSF can fake changes.` : "No much brighter star close enough to cause glare.", 15);
    void here;

    let score0 = Math.round(tests.reduce((a, t) => a + t.weight * (t.status === "pass" ? 1 : t.status === "warn" ? 0.5 : 0), 0));
    // 6. For a catalogued star: does the measured jump match its known proper motion?
    //    Bright stars in wide fields can show 1 px "moves" from imperfect image alignment.
    if (mv.kind === "moved" && mv.known && mv.from) {
      const dtYr = (m.epochs[last].mjd_mean - m.epochs[0].mjd_mean) / 365.25;
      const pred = (Math.hypot(mv.known.src.pmra || 0, mv.known.src.pmdec || 0) / 1000) * dtYr / m.pixscale_arcsec;
      // (the +/- lobes of a shifted PSF sit further apart than the shift itself, so only ask:
      //  should this star have moved visibly at all?)
      const ok = pred >= 0.25;
      add("Catalogue motion", ok ? "pass" : "fail",
        ok ? `The catalogue proper motion predicts a ${fmt(pred, 1)} px shift between the epochs: a real move is expected.`
          : `The catalogue proper motion predicts only ${fmt(pred, 2)} px: this star shouldn't visibly move, so the "move" is an image-alignment or PSF artefact.`, 0);
      if (!ok) mv.motionMismatch = true;
    }
    // Vetoes: glare from a saturated star or mostly-masked pixels can fake any signal,
    // so a fail there caps the score however good the rest looks.
    const veto = mv.motionMismatch || !mv.known && tests.some((t) => (t.name === "Bright-star glare" || t.name === "Data quality flags") && t.status === "fail");
    const score = veto ? Math.min(score0, 40) : score0;
    if (veto) tests.push({ name: "Veto", status: "fail", detail: mv.motionMismatch ? "A catalogued star that shouldn't visibly move: the change is an artefact, so the score is capped at 40." : "Glare or masked data can fake any change, so the score is capped at 40.", weight: 0 });
    const verdict = score >= 70 ? "likely real" : score >= 45 ? "uncertain" : "likely artefact";
    return { score, verdict, tests };
  }

  // ---------------- Google Form ----------------
  const FORM = "https://docs.google.com/forms/d/e/1FAIpQLSeIj3vvKkqssCfGBZ-f6lYWns3xYncz4e_Gt7WW-pwQKlckLA/viewform";
  const ENTRY = { target: 1049466868, kind: 538986567, ra: 116105241, dec: 437490171, band: 559465889, significance: 1069933614,
    change_pct: 745289100, catalogue_match: 1004446247, epochs: 721887917, link: 412569952, notes: 1702346368,
    // dedicated columns, so the team's sheet can filter on the score. Fill in the entry
    // ids from the form's pre-filled link (left null = the value still goes into notes).
    vet_score: 48578539, verdict: 1421522174, classification: 431734652 };
  // Only send what is worth a human look: changes found by Find movers that pass vetting
  // (VET >= 45), or tracked solar-system objects. Anything else stays in the notebook.
  const MIN_VET = 45;
  function canSubmit(c) {
    if (c.kind === "tracked") return { ok: true };
    if (c.vet_score == null) return { ok: false, why: "Only changes found by Find movers (with a VET score) can be sent to the team." };
    if (c.vet_score < MIN_VET) return { ok: false, why: `VET ${c.vet_score}/100 is below ${MIN_VET}: most likely an artefact, so it is not sent.` };
    return { ok: true };
  }
  function submitHtml(c, cls) {
    const g = canSubmit(c);
    return g.ok ? `<a class="${cls}" href="${esc(formUrl(c))}" target="_blank" rel="noopener">Submit to Wanderer team ↗</a>`
      : `<span class="${cls} disabled" title="${esc(g.why)}" aria-disabled="true">Submit locked · ${esc(g.why)}</span>`;
  }
  function formUrl(c) {
    const p = new URLSearchParams({ usp: "pp_url" });
    const notes = c.notes || [c.classification && `Auto class: ${c.classification}`, c.vet_score != null && `Vetting: ${c.vet_score}/100 (${c.verdict})`].filter(Boolean).join(" · ");
    // required in the form; tracked solar-system objects have no VET score
    const vals = Object.assign({}, c, { notes: c.notes || "", vet_score: c.vet_score != null ? c.vet_score : "n/a",
      verdict: c.verdict || (c.kind === "tracked" ? "n/a (tracked solar-system object)" : "not vetted"), classification: c.classification || "n/a" });
    for (const [k, id] of Object.entries(ENTRY)) if (id && vals[k] != null && vals[k] !== "") p.set(`entry.${id}`, String(vals[k]).slice(0, 900));
    return `${FORM}?${p}`;
  }
  // which SPHEREx release a pack came from ("QR2" for the built-in packs, "DR1 + QR3" for new scans)
  const rel = (m) => String((m && m.collection) || "spherex_qr2").replace(/spherex_/g, "").toUpperCase().split("+").join(" + ");
  function deepLink(slug, band, x, y) {
    const u = new URL(location.href);
    u.search = new URLSearchParams({ target: slug, mode: "diff", band: String(band), px: String(x), py: String(y) }).toString();
    u.hash = ""; return u.toString();
  }

  // ---------------- report ----------------
  function cropPng(arr, n, cx, cy, half, diverging, scale = 8) {
    const size = 2 * half + 1, cv = document.createElement("canvas"); cv.width = cv.height = size * scale;
    const ctx = cv.getContext("2d"), vals = [];
    for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) { const v = x >= 0 && y >= 0 && x < n && y < n ? arr[y * n + x] : NaN; if (v === v) vals.push(v); }
    vals.sort((a, b) => a - b);
    const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0);
    const lo = q(0.05), hi = q(0.995), md = q(0.5), soft = Math.max((hi - lo) * 0.05, 1e-9);
    for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) {
      const v = x >= 0 && y >= 0 && x < n && y < n ? arr[y * n + x] : NaN;
      let col = "#3a2030";
      if (v === v) {
        if (diverging) { const t = Math.max(-1, Math.min(1, v / 8)); col = t >= 0 ? `rgb(${Math.round(20 + 235 * t)},${Math.round(20 + 150 * t)},${Math.round(20 + 30 * t)})` : `rgb(${Math.round(20 - 0 * t)},${Math.round(20 - 180 * t)},${Math.round(20 - 220 * t)})`; }
        else { const t = Math.max(0, Math.min(1, Math.asinh((v - md) / soft) / Math.asinh((hi - md) / soft || 1))); const g = Math.round(255 * t); col = `rgb(${g},${g},${g})`; }
      }
      ctx.fillStyle = col;
      // array y grows north, so draw it upside down to put north up
      ctx.fillRect((x - cx + half) * scale, (cy + half - y) * scale, scale, scale);
    }
    ctx.strokeStyle = "#5ef2ff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc((half + 0.5) * scale, (half + 0.5) * scale, 3 * scale, 0, 2 * Math.PI); ctx.stroke();
    return cv.toDataURL("image/png");
  }
  function specSvg(cls) {
    const pts = cls.fl.filter((p) => p.f === p.f && p.lam >= 0.7 && p.lam <= 5.05);
    const W = 680, H = 260, L = 56, R = 14, T = 16, B = 38;
    if (pts.length < 5) return `<p class="muted">Not enough unmasked frames to draw a spectrum.</p>`;
    // bin at R ≈ 40 for readability
    const bins = []; for (let l = 0.72; l < 5.0; l *= 1.025) bins.push([l, l * 1.025]);
    const binned = bins.map(([a, b]) => { const v = pts.filter((p) => p.lam >= a && p.lam < b).map((p) => p.f); return v.length ? [Math.sqrt(a * b), median(v), v.length] : null; }).filter(Boolean);
    const ys = binned.map((p) => p[1]); let y0 = Math.min(0, ...ys), y1 = Math.max(...ys); if (y1 <= y0) y1 = y0 + 1; const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
    const X = (l) => L + ((l - 0.7) / (5.05 - 0.7)) * (W - L - R), Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="fig" role="img" aria-label="SPHEREx spectrum">`;
    const bands = [["W14", "H₂O"], ["CH4", "CH₄"], ["CO2", "CO₂"]];
    for (const [k, lab] of bands) { const [a, b] = WIN[k]; s += `<rect x="${X(a)}" y="${T}" width="${X(b) - X(a)}" height="${H - T - B}" fill="#5ef2ff" fill-opacity=".12"/><text x="${X(0.5 * (a + b))}" y="${T + 12}" text-anchor="middle" class="ann">${lab}</text>`; }
    for (let i = 0; i <= 4; i++) { const v = y0 + ((y1 - y0) * i) / 4; s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(2)}</text>`; }
    for (let l = 1; l <= 5; l++) s += `<text x="${X(l)}" y="${H - B + 16}" text-anchor="middle">${l}</text>`;
    s += `<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">Wavelength (µm)</text><text x="12" y="${(T + H - B) / 2}" transform="rotate(-90 12 ${(T + H - B) / 2})" text-anchor="middle">Flux (aperture sum)</text>`;
    s += pts.map((p) => `<circle cx="${X(p.lam)}" cy="${Y(Math.max(y0, Math.min(y1, p.f)))}" r="1.6" fill="#8aa0b8" fill-opacity=".45"/>`).join("");
    s += `<polyline fill="none" stroke="#0b7fa8" stroke-width="2.2" points="${binned.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}"/>`;
    return s + "</svg>";
  }
  function lcSvg(pos, band) {
    const { S, epochCoaddRaw, mjdToYear } = core(), { m, n } = S.pack;
    const pts = m.epochs.map((ep, e) => { const [x, y] = pos(e); return [mjdToYear(ep.mjd_mean), apSum(epochCoaddRaw(e, band), n, x, y), ep.start]; }).filter((p) => p[1] === p[1]);
    if (pts.length < 2) return "";
    const W = 680, H = 170, L = 56, R = 14, T = 12, B = 34;
    let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(0, ...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
    if (x1 === x0) x1 += 0.1; if (y1 === y0) y1 += 1; const pad = (y1 - y0) * 0.12; y0 -= pad; y1 += pad; const px = (x1 - x0) * 0.08; x0 -= px; x1 += px;
    const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="fig" role="img" aria-label="Light curve">`;
    for (let i = 0; i <= 3; i++) { const v = y0 + ((y1 - y0) * i) / 3; s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(2)}</text>`; }
    pts.forEach((p) => { s += `<text x="${X(p[0])}" y="${H - B + 16}" text-anchor="middle">${p[2]}</text>`; });
    s += `<polyline fill="none" stroke="#c77b00" stroke-width="2" points="${pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}"/>` + pts.map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="4.5" fill="#f5a524"/>`).join("");
    return s + `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Epoch (start date)</text></svg>`;
  }

  function csvOf(cls, ra, dec, m) {
    const head = `# Wanderer export · ${m.name} · RA ${ra.toFixed(6)} Dec ${dec.toFixed(6)} (ICRS, deg)\n# SPHEREx ${rel(m)} via NASA IRSA. flux = aperture sum (r <= 2 px, sky from 5-8 px ring) in MJy/sr x pixels${cls.mode === "wing" ? "; PSF-wing mode (saturated core)" : ""}\n`;
    return head + "mjd,epoch,detector,wavelength_um,flux,obs_id,full_image_url\n" + cls.fl.map((p, k) => `${p.mjd},${p.epoch + 1},${p.det},${p.lam},${p.f === p.f ? p.f.toPrecision(6) : ""},${m.frames[k].obs_id || ""},${m.frames[k].url || ""}`).join("\n");
  }
  function nextSteps(c, cls, ra, dec, tracking) {
    const radec = `${fmt(ra, 5)} ${dec >= 0 ? "+" : ""}${fmt(dec, 5)}`;
    const simbad = `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${encodeURIComponent(radec)}&Radius=30&Radius.unit=arcsec`;
    const legacy = `https://www.legacysurvey.org/viewer?ra=${fmt(ra, 5)}&dec=${fmt(dec, 5)}&zoom=15`;
    const steps = [
      `Look it up in <a href="${simbad}">SIMBAD</a> (30″ radius) and the <a href="${legacy}">Legacy Survey sky viewer</a> to see if anything is already known there.`,
    ];
    if (tracking) steps.push(`Solar-system positions are reported to the <a href="https://minorplanetcenter.net/">Minor Planet Center</a>, the official clearing house for asteroids and comets.`);
    else if (cls.family === "brown-dwarf" || (c.kind === "moved" && !c.known)) steps.push(`Moving red objects not in Gaia or CatWISE are exactly what <a href="https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9">Backyard Worlds: Planet 9</a> hunts for. Compare against their WISE flipbooks.`);
    else if (c.kind === "brighter" || c.kind === "fainter") steps.push(`Check the <a href="https://www.aavso.org/vsx/">AAVSO Variable Star Index</a>. If it is not a known variable and the change is real, it may be a new transient.`);
    steps.push("Submit it to the Wanderer team with the button below. A human checks every report before anything goes further.");
    return steps;
  }

  function report(c) {
    const K = core(), { S } = K, { m, n } = S.pack, last = m.epochs.length - 1, band = S.band;
    const x = Math.round(c.x), y = Math.round(c.y);
    const pos = c.from && c.kind === "moved"
      ? (e) => { const t = last ? e / last : 1; return [c.from[0] + (c.x - c.from[0]) * t, c.from[1] + (c.y - c.from[1]) * t]; }
      : () => [c.x, c.y];
    const [ra, dec] = c.ra != null ? [c.ra, c.dec] : K.pixToWorld(x, y);
    const cls = c.cls || classify(c.x, c.y, { pos });
    const vt = c.vet || (c.kind && c.kind !== "manual" && !m.tracking ? vet(c) : null);
    const known = c.known !== undefined ? c.known : (S.cat && !m.tracking ? K.knownNear(ra, dec, K.yearNow(), 12) : null);
    const dtYr = K.mjdToYear(m.epochs[last].mjd_mean) - K.mjdToYear(m.epochs[0].mjd_mean);
    const id = `WND-${S.slug.toUpperCase()}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const bandTxt = band ? `D${band} (${fmt(m.detectors.find((d) => d.id === band).lam_min_um, 2)}–${fmt(m.detectors.find((d) => d.id === band).lam_max_um, 2)} µm)` : "all detectors (0.75–5.0 µm)";
    const imgs = [
      [`Epoch 1 · ${m.epochs[0].start}`, cropPng(K.epochCoaddRaw(0, band), n, x, y, 12, false)],
      [`Epoch ${last + 1} · ${m.epochs[last].start}`, cropPng(K.epochCoaddRaw(last, band), n, x, y, 12, false)],
      ...(last > 0 && !m.tracking ? [["Difference (σ) · orange brighter, blue fainter", cropPng(diffFor(band), n, x, y, 12, true)]] : []),
    ];
    if (m.tracking && (!c.kind || c.kind === "manual")) c = Object.assign({}, c, { kind: "tracked" });
    const kindTxt = { tracked: "Tracked solar-system object", moved: "Moved between epochs", brighter: "Got brighter", fainter: "Got fainter", manual: "Selected by hand" }[c.kind] || (m.tracking ? "Tracked solar-system object" : "Selected by hand");
    const motion = c.kind === "moved" && c.dist ? `${fmt(c.dist * m.pixscale_arcsec, 1)}″ in ${fmt(dtYr, 2)} yr ≈ ${fmt((c.dist * m.pixscale_arcsec) / Math.max(dtYr, 1e-3), 1)}″/yr` : "–";
    const knownTxt = m.tracking ? "Not applicable (moving solar-system object)" : !S.cat ? "No catalogue for this field" : known ? `${esc(known.src.id)} · ${known.src.cat === "gaia" ? "Gaia DR3" : "CatWISE2020"} · ${fmt(known.sep, 1)}″ away · proper motion ${fmt(Math.hypot(known.src.pmra || 0, known.src.pmdec || 0) / 1000, 2)}″/yr` : "<b>No match</b> in Gaia DR3 or CatWISE2020 within 15″ after correcting for proper motion";

    // Conclusion paragraph, written from the measurements
    const parts = [];
    if (m.tracking) parts.push(`This is ${esc(m.name)}, tracked across ${m.epochs.length} SPHEREx visits.`);
    else if (c.kind && c.kind !== "manual") parts.push(`SPHEREx shows a source that ${c.kind === "moved" ? `moved ${motion.split(" ≈")[0]}` : c.kind === "brighter" ? (Math.abs(c.frac || 0) >= 0.005 ? `brightened by ${fmt(100 * Math.abs(c.frac), 0)}%` : "got brighter") : (Math.abs(c.frac || 0) >= 0.005 ? `faded by ${fmt(100 * Math.abs(c.frac), 0)}%` : "got fainter")} between ${m.epochs[0].start} and ${m.epochs[last].start} (${fmt(c.snr, 0)}σ).`);
    else parts.push(`Pixel selected by hand in the ${esc(m.name)} field.`);
    if (!m.tracking) parts.push(known ? `It matches a catalogued source (${known.src.cat === "gaia" ? "Gaia DR3" : "CatWISE2020"}), so it is a known object.` : S.cat ? "It has no counterpart in Gaia DR3 or CatWISE2020." : "");
    if (vt) parts.push(`Artefact vetting scores it ${vt.score}/100 (${vt.verdict}).`);
    if (cls.confidence !== "none") parts.push(`Its SPHEREx spectrum points to: ${cls.label.toLowerCase()} (${cls.confidence} confidence).`);
    else parts.push(cls.label + ".");
    const isNew = !m.tracking && S.cat && !known && vt && vt.score >= 70;
    parts.push(isNew ? "Status: <b>possible new object</b>. Worth a human follow-up." : known ? "Status: known object; the change is explained." : vt && vt.score < 45 ? "Status: most likely an instrumental artefact." : "Status: needs a human look.");

    const cand = {
      target: m.name, kind: c.kind || (m.tracking ? "tracked" : "manual"), ra: +fmt(ra, 6), dec: +fmt(dec, 6), band: band ? `D${band}` : "all",
      significance: c.snr != null ? +fmt(c.snr, 1) : "", change_pct: c.frac != null ? Math.round(100 * c.frac) : "",
      catalogue_match: m.tracking ? "n/a (moving object)" : known ? `${known.src.id} (${fmt(known.sep, 1)}")` : S.cat ? "none" : "not checked",
      epochs: m.epochs.map((e) => e.start).join(" / "), link: deepLink(S.slug, band, x, y),
      classification: cls.short, vet_score: vt ? vt.score : null, verdict: vt ? vt.verdict : null,
    };
    const colourRows = [["JK", "J − K (1.25 vs 2.2 µm)", "overall redness"], ["KM", "K − M (2.2 vs 4.6 µm)", "dust, heat, cold brown dwarfs"], ["CM", "CH₄ − M (3.35 vs 4.6 µm)", "methane absorption"], ["LM", "L − M (3.95 vs 4.6 µm)", "very cold (Y) dwarfs"], ["h2o", "1.4 µm water depth", "cool stars, brown dwarfs"]];
    const css = `
      :root{--ink:#0d1b2a;--mut:#52606d;--acc:#0b7fa8;--line:#d5dde5;--ok:#1b8a4b;--warn:#b7791f;--bad:#c53030}
      *{box-sizing:border-box} body{margin:0;background:#eef2f6;color:var(--ink);font:15px/1.55 "Rajdhani","Segoe UI",system-ui,sans-serif}
      .page{max-width:820px;margin:24px auto;background:#fff;padding:36px 44px;box-shadow:0 2px 18px rgba(0,0,0,.08)}
      header{border-bottom:3px solid var(--acc);padding-bottom:12px;margin-bottom:18px}
      .kick{font:600 12px/1 "Share Tech Mono",monospace;letter-spacing:.14em;color:var(--acc)}
      h1{font:700 26px/1.15 "Orbitron","Segoe UI",sans-serif;margin:8px 0 4px;letter-spacing:.02em} h2{font:700 15px/1.2 "Orbitron",sans-serif;letter-spacing:.06em;color:var(--acc);margin:26px 0 10px;text-transform:uppercase}
      .muted{color:var(--mut)} .mono{font-family:"Share Tech Mono",monospace}
      .summary{background:#f0f8fb;border-left:4px solid var(--acc);padding:12px 16px;font-size:16px}
      table{border-collapse:collapse;width:100%;font-size:14px} td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top} th{color:var(--mut);font-weight:600;width:34%}
      .imgs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px} .imgs figure{margin:0} .imgs img{width:100%;image-rendering:pixelated;border:1px solid var(--line)} figcaption{font-size:12px;color:var(--mut)}
      .fig{width:100%;height:auto;font:11px "Share Tech Mono",monospace;fill:#52606d} .fig .grid{stroke:#e3e8ee} .fig .ann{fill:#0b7fa8;font-weight:600}
      .pass{color:var(--ok);font-weight:700}.warn{color:var(--warn);font-weight:700}.fail{color:var(--bad);font-weight:700}
      .score{font:700 30px "Orbitron",sans-serif} .tag{display:inline-block;padding:2px 10px;border-radius:2px;background:#0d1b2a;color:#5ef2ff;font:600 12px "Share Tech Mono",monospace;letter-spacing:.08em}
      .actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 0} .btn{font:700 13px "Orbitron",sans-serif;letter-spacing:.06em;padding:10px 16px;border:2px solid var(--acc);background:#fff;color:var(--acc);text-decoration:none;cursor:pointer} .btn.primary{background:var(--acc);color:#fff} .btn.disabled{border-color:#c3ccd5;background:#f3f5f7;color:#7b8794;cursor:not-allowed;font:600 12px "Rajdhani",sans-serif;letter-spacing:0}
      ol li{margin-bottom:6px} footer{margin-top:28px;border-top:1px solid var(--line);padding-top:10px;font-size:12px;color:var(--mut)}
      @media (max-width:700px){.page{padding:22px 18px;margin:0}.imgs{grid-template-columns:1fr 1fr}}
      @media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}.actions{display:none}h2{break-after:avoid}.imgs,svg{break-inside:avoid}}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${id} · Wanderer candidate report</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;700&family=Rajdhani:wght@500;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet"><style>${css}</style></head><body><div class="page">
<header><div class="kick">WANDERER · SPHEREx CANDIDATE REPORT · ${id}</div><h1>${esc(m.name)}: ${esc(kindTxt.toLowerCase())}</h1>
<div class="muted mono">${K.sexa(ra, true)} ${K.sexa(dec, false)} · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</div></header>
<div class="summary">${parts.filter(Boolean).join(" ")}</div>
<div class="actions"><button class="btn primary" onclick="print()">Print / save as PDF</button><a class="btn" download="${id}_spectrum.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(csvOf(cls, ra, dec, m))}">Download data (CSV)</a>${submitHtml(cand, "btn")}</div>

<h2>1 · Images</h2>
<div class="imgs">${imgs.map(([cap, src]) => `<figure><img src="${src}" alt="${esc(cap)}"><figcaption>${esc(cap)}</figcaption></figure>`).join("")}</div>
<p class="muted" style="font-size:13px">25×25 px (${fmt(25 * m.pixscale_arcsec / 60, 1)}′) cut-outs, ${esc(bandTxt)}. North up, east left. Median stack of all frames in each epoch. Circle: candidate position.</p>

<h2>2 · Detection</h2>
<table><tr><th>Position (ICRS)</th><td class="mono">${K.sexa(ra, true)} ${K.sexa(dec, false)}<br>${fmt(ra, 6)}°, ${fmt(dec, 6)}°</td></tr>
<tr><th>Type</th><td>${esc(kindTxt)}</td></tr>
<tr><th>Significance</th><td>${c.snr != null ? `${fmt(c.snr, 1)}σ (combined difference image)` : "–"}</td></tr>
<tr><th>Brightness change</th><td>${c.frac != null ? `${fmt(100 * c.frac, 0)}% of the source's own flux` : "–"}</td></tr>
<tr><th>Motion</th><td>${motion}</td></tr>
<tr><th>Epochs</th><td>${m.epochs.map((e, i) => `${i + 1}: ${e.start}${e.end !== e.start ? ` → ${e.end}` : ""} (${e.n_frames} frames)`).join("<br>")}</td></tr>
<tr><th>Data</th><td>${m.frames.length} SPHEREx ${rel(m)} frames, ${m.detectors.length} detectors, ${m.pixscale_arcsec}″/px, from NASA IRSA</td></tr></table>

<h2>3 · Is it already known?</h2>
<table><tr><th>Gaia DR3 + CatWISE2020</th><td>${knownTxt}</td></tr></table>
${m.tracking ? "" : `<p class="muted" style="font-size:13px">Every catalogued star within the field is moved from its catalogue epoch (Gaia 2016.0, CatWISE 2015.4) to the SPHEREx date using its proper motion before matching.</p>`}

${vt ? `<h2>4 · Artefact vetting</h2>
<p><span class="score">${vt.score}</span><span class="muted">/100</span> &nbsp;<span class="tag">${vt.verdict.toUpperCase()}</span></p>
<table>${vt.tests.map((t) => `<tr><th>${t.name} <span class="muted">(${t.weight} pts)</span></th><td><span class="${t.status}">${t.status.toUpperCase()}</span> · ${esc(t.detail)}</td></tr>`).join("")}</table>` : ""}

<h2>${vt ? 5 : 4} · What is it? SPHEREx spectrum</h2>
${specSvg(cls)}
<p><span class="tag">${esc(cls.short.toUpperCase())}</span> &nbsp;<b>${esc(cls.label)}</b> <span class="muted">· confidence: ${cls.confidence}</span></p>
<ul>${cls.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
${m.tracking ? "" : `<table><tr><th>Colour (vs field stars)</th><td><b>Value</b> · what it traces</td></tr>${colourRows.map(([k, lab, why]) => `<tr><th>${lab}</th><td class="mono">${k === "h2o" ? `${fmt(100 * cls.c[k][0], 0)}% ± ${fmt(100 * cls.c[k][1], 0)}` : `${fmt(cls.c[k][0])} ± ${fmt(cls.c[k][1])} mag`} <span class="muted">· ${why}</span></td></tr>`).join("")}</table>
<p class="muted" style="font-size:13px">Colours are self-calibrated: a normal star scores 0 in every colour (zero point from the median of ${cls.zp.nStars || "default"} unsaturated field stars in this same pack). Grey dots are single frames; the blue line is the binned spectrum. Shaded: water, methane and CO₂ bands.</p>`}

<h2>${vt ? 6 : 5} · Light curve</h2>
${lcSvg(pos, band) || `<p class="muted">Only one epoch.</p>`}

<h2>${vt ? 7 : 6} · Next steps</h2>
<ol>${nextSteps(c, cls, ra, dec, m.tracking).map((s) => `<li>${s}</li>`).join("")}</ol>
<div class="actions">${submitHtml(cand, "btn primary")}<a class="btn" href="${esc(cand.link)}" target="_blank" rel="noopener">Open in Wanderer</a></div>

<h2>Method</h2>
<p class="muted" style="font-size:13px">Pipeline: SPHEREx ${rel(m)} spectral images (IRSA) → cut-outs resampled to a common north-up grid → bad pixels masked using the SPHEREx flag bits → median stacks per epoch and detector → per-detector noise-normalised difference → peaks ≥ 6σ paired into movers or brightness changes → proper-motion-corrected cross-match to Gaia DR3 and CatWISE2020 → five artefact tests → aperture photometry of every frame for the spectrum. Automatic and not peer reviewed: treat it as a lead, not a discovery.</p>
<footer>SPHEREx: NASA/JPL-Caltech, data via NASA/IPAC Infrared Science Archive. Gaia DR3: ESA/Gaia/DPAC. CatWISE2020: Marocco et al. 2021. Report generated by Wanderer (astro3club, NASA Space Apps 2026).</footer>
</div></body></html>`;
    const w = window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
    if (!w) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([html], { type: "text/html" })); a.download = `${id}.html`; a.click(); }
    return { id, cand, cls, vt };
  }

  window.Analysis = { classify, vet, report, formUrl, canSubmit, submitHtml, deepLink, csvOf, reset: () => { diffCache.clear(); mfCache.clear(); } };
})();
