/* Wanderer: fly around the sky and watch SPHEREx images of any patch change over time.
 *
 * The whole window is an Aladin Lite sky you can drag and zoom. SPHEREx "target packs"
 * (made by pipeline/build_cache.py or the live API) are painted on top of it at their
 * true position, and animate through the survey epochs.
 *   data/<slug>/manifest.json  frame metadata (time, detector, wavelength, epoch, flags)
 *   data/<slug>/frames.bin     float32 cube [nFrames, npix, npix], NaN = masked
 * Co-adding, differencing, stretching, spectra, light curves and mover detection all
 * happen here in the browser.
 */
(() => {
  "use strict";

  const DATA_ROOT = "data";
  const API = (window.WANDERER_API || "").replace(/\/$/, "");
  const EPOCH_COLORS = ["#f5a524", "#5cc8e8", "#ff7ab6", "#9be15d", "#b39dff", "#ffd166"];
  const RGB_GROUPS = { r: [5, 6], g: [3, 4], b: [1, 2] };
  const SURVEY_YEAR_REF = 2026.0;
  const D2R = Math.PI / 180;

  const S = {
    index: [], pack: null, slug: null, mode: "blink", band: 0, epoch: 0, playing: false, timer: null,
    coadds: new Map(), stretch: new Map(), movers: [], pick: null, apiOk: false,
    aladin: null, gaiaCat: null, survey: "https://alasky.cds.unistra.fr/DSS/DSSColor/", xf: null, flying: false, sel: null, simbadLayer: null,
  };

  const $ = (id) => document.getElementById(id);
  const ov = $("overlay");
  const octx = ov.getContext("2d");
  const off = document.createElement("canvas");
  const offCtx = off.getContext("2d");
  const fbCanvas = $("view");
  const fbCtx = fbCanvas.getContext("2d");

  // ---------------- small helpers ----------------
  const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "–" : Number(v).toFixed(d));
  function sexa(deg, hours) {
    let v = hours ? (((deg % 360) + 360) % 360) / 15 : Math.abs(deg);
    const sign = !hours && deg < 0 ? "-" : hours ? "" : "+";
    const a = Math.floor(v); v = (v - a) * 60;
    const b = Math.floor(v); const c = (v - b) * 60;
    return `${sign}${String(a).padStart(2, "0")}:${String(b).padStart(2, "0")}:${c.toFixed(hours ? 2 : 1).padStart(hours ? 5 : 4, "0")}`;
  }
  function banner(text) { const b = $("banner"); b.textContent = text || ""; b.hidden = !text; }
  function toast(text) { const t = $("toast"); t.textContent = text || ""; t.hidden = !text; }
  const isNarrow = () => window.matchMedia("(max-width: 860px)").matches;

  // Gnomonic (TAN) projection around the pack centre.
  // Array pixel x grows to the WEST (RA decreases), y grows to the NORTH.
  // Where on the sky the SPHEREx frame is centred right now. Normal packs are fixed;
  // tracked packs (asteroids, comets) follow the object frame by frame.
  function packCentre() {
    const m = S.pack.m;
    if (!m.tracking) return [m.ra, m.dec];
    if (S.mode === "frames") { const f = m.frames[currentFrameIndex()]; if (f) return [f.obj_ra, f.obj_dec]; }
    const ep = m.epochs[S.mode === "diff" ? (S.epoch === 0 ? m.epochs.length - 1 : S.epoch) : S.epoch];
    return ep && ep.obj_ra != null ? [ep.obj_ra, ep.obj_dec] : [m.ra, m.dec];
  }
  function pixToWorld(x, y) {
    const m = S.pack.m, c = (S.pack.n - 1) / 2, ps = (m.pixscale_arcsec / 3600) * D2R;
    const [cra, cdec] = packCentre();
    const xi = -(x - c) * ps, eta = (y - c) * ps, ra0 = cra * D2R, d0 = cdec * D2R;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return [cra, cdec];
    const cc = Math.atan(rho);
    const dec = Math.asin(Math.cos(cc) * Math.sin(d0) + (eta * Math.sin(cc) * Math.cos(d0)) / rho);
    const ra = ra0 + Math.atan2(xi * Math.sin(cc), rho * Math.cos(d0) * Math.cos(cc) - eta * Math.sin(d0) * Math.sin(cc));
    return [(((ra / D2R) % 360) + 360) % 360, dec / D2R];
  }

  // Inverse of pixToWorld: sky position -> array pixel (fixed packs only).
  function worldToPix(ra, dec) {
    const m = S.pack.m, c = (S.pack.n - 1) / 2, ps = (m.pixscale_arcsec / 3600) * D2R;
    const [cra, cdec] = packCentre(), a = ra * D2R, d = dec * D2R, a0 = cra * D2R, d0 = cdec * D2R;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc;
    const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
    return [c - xi / ps, c + eta / ps];
  }
  // Known-source catalogue (Gaia DR3 + CatWISE2020), moved to a given year with each source's proper motion.
  function catAt(src, year) {
    const ref = src.cat === "gaia" ? S.cat.gaia_epoch : S.cat.catwise_epoch, dt = year - ref;
    const pmra = src.pmra || 0, pmdec = src.pmdec || 0;
    const dec = src.dec + (pmdec * dt) / 3.6e6;
    return [src.ra + (pmra * dt) / 3.6e6 / Math.cos(src.dec * D2R), dec];
  }
  // Busy fields (Barnard's Star sits in the Milky Way) hold thousands of catalogue
  // entries. Draw only what SPHEREx can plausibly see: the 80 brightest per
  // catalogue plus every genuinely fast mover. CatWISE motions of faint sources
  // are noisy, so only trust them when the source is bright (W1 < 13).
  function isFast(src) {
    const pm = Math.hypot(src.pmra || 0, src.pmdec || 0);
    return src.cat === "gaia" ? pm > 300 : pm > 300 && src.mag != null && src.mag < 13;
  }
  function shownCatalog() {
    if (!S.cat) return [];
    if (S.cat._shown) return S.cat._shown;
    const pick = (cat) => S.cat.sources.filter((s) => s.cat === cat && s.mag != null).sort((a, b) => a.mag - b.mag).slice(0, 80);
    const set = new Set([...pick("gaia"), ...pick("catwise"), ...S.cat.sources.filter(isFast)]);
    return (S.cat._shown = [...set]);
  }
  function knownNear(ra, dec, year, rArcsec = 15) {
    if (!S.cat) return null;
    let best = null;
    for (const src of S.cat.sources) {
      const [r, d] = catAt(src, year), sep = angDist(r, d, ra, dec) * 3600;
      if (sep > rArcsec) continue;
      const pm = Math.hypot(src.pmra || 0, src.pmdec || 0);
      // prefer the closest; among similar distances prefer fast movers and Gaia
      const score = sep - (pm > 300 ? 6 : 0) - (src.cat === "gaia" ? 1 : 0);
      if (!best || score < best.score) best = { src, sep, pm, score };
    }
    return best;
  }
  const yearNow = () => {
    const m = S.pack.m;
    if (S.mode === "frames") return mjdToYear(m.frames[currentFrameIndex()].mjd);
    return mjdToYear(m.epochs[S.mode === "diff" ? (S.epoch === 0 ? m.epochs.length - 1 : S.epoch) : S.epoch].mjd_mean);
  };
  function describeKnown(k) {
    if (!k) return `<span class="badge new">★ NOT IN GAIA OR CatWISE: possible new object</span>`;
    const s = k.src, pm = k.pm > 0 ? ` · moves ${fmt(k.pm / 1000, 2)}″/yr` : "";
    return `<span class="badge known">✓ KNOWN: ${escapeHtml(s.id)} (${s.band} ${fmt(s.mag, 1)})${pm}</span>`;
  }

  // ---------------- coordinates & names ----------------
  function parseCoords(q) {
    const s = q.trim().replace(/,/g, " ");
    const d = s.match(/^([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)$/);
    if (d) { const ra = +d[1], dec = +d[2]; if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec }; }
    const t = s.replace(/[hdms:'"°]/gi, " ").trim().split(/\s+/);
    if (t.length === 6 && t.every((x) => /^[+-]?\d+(\.\d+)?$/.test(x))) {
      const ra = 15 * (+t[0] + t[1] / 60 + t[2] / 3600);
      const sg = t[3].startsWith("-") ? -1 : 1;
      const dec = sg * (Math.abs(+t[3]) + t[4] / 60 + t[5] / 3600);
      if (ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
    }
    return null;
  }
  async function resolveName(name) {
    if (S.apiOk) {
      try { const r = await fetch(`${API}/api/resolve?name=${encodeURIComponent(name)}`); if (r.ok) return r.json(); } catch (_) { /* fall through */ }
    }
    const url = `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/~SNV?${encodeURIComponent(name)}`;
    const doc = new DOMParser().parseFromString(await (await fetch(url)).text(), "text/xml");
    const g = (tag) => { const n = doc.getElementsByTagName(tag)[0]; return n ? parseFloat(n.textContent) : NaN; };
    let ra = g("jradeg"), dec = g("jdedeg");
    if (!isFinite(ra)) throw new Error(`Could not find "${name}"`);
    const pmra = g("pmRA"), pmde = g("pmDE");
    if (isFinite(pmra) && isFinite(pmde)) {
      const dt = SURVEY_YEAR_REF - 2000;
      dec += (pmde * dt) / 3.6e6;
      ra += (pmra * dt) / 3.6e6 / Math.cos(dec * D2R);
    }
    return { ra, dec, name };
  }

  // ---------------- sky (Aladin) ----------------
  async function initSky() {
    if (!window.A && window.aladinReady) { try { await window.aladinReady; } catch (_) { /* ignore */ } }
    if (!window.A) return false;
    try {
      if (A.init && A.init.then) await A.init;
      S.aladin = A.aladin("#sky", {
        survey: S.survey, fov: 60, target: "0 0", projection: "SIN", cooFrame: "ICRSd",
        showReticle: false, showLayersControl: false, showGotoControl: false, showFullscreenControl: false,
        showFrame: false, showCooGridControl: false, showSimbadPointerControl: false, showShareControl: false,
        showProjectionControl: false, showZoomControl: false, showSettingsControl: false, showContextMenu: false,
        showCooLocation: false, showStatusBar: false, realFullscreen: false, showFov: false,
      });
      const a = S.aladin;
      setLabels();
      const sky = $("sky");
      let down = null;
      sky.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
      sky.addEventListener("pointerup", (e) => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) onSkyClick(e.clientX, e.clientY);
        down = null;
      }, true);
      sky.addEventListener("pointermove", (e) => {
        try {
          const r = sky.getBoundingClientRect();
          const w = a.pix2world(e.clientX - r.left, e.clientY - r.top);
          $("coord").textContent = w && isFinite(w[0]) ? `${sexa(w[0], true)} ${sexa(w[1], false)}` : "";
        } catch (_) { /* ignore */ }
      });
      return true;
    } catch (e) {
      console.warn("Aladin failed, using flat viewer", e);
      S.aladin = null;
      return false;
    }
  }

  function skyFov() { try { const f = S.aladin.getFov(); return Array.isArray(f) ? f[0] : f; } catch (_) { return 1; } }

  // Smooth "fly" between two places: zoom out, pan, zoom in.
  const researchMode = () => document.documentElement.classList.contains("research");
  function flyTo(ra, dec, fovDeg, ms = 2600) {
    if (!S.aladin) return Promise.resolve();
    if (researchMode()) { S.aladin.gotoRaDec(ra, dec); S.aladin.setFoV(fovDeg); return Promise.resolve(); } // no fly-through
    const a = S.aladin;
    const [ra0, dec0] = a.getRaDec();
    const f0 = skyFov();
    const dist = Math.acos(Math.min(1, Math.sin(dec0 * D2R) * Math.sin(dec * D2R) +
      Math.cos(dec0 * D2R) * Math.cos(dec * D2R) * Math.cos((ra - ra0) * D2R))) / D2R;
    const peak = Math.min(180, Math.max(f0, fovDeg, dist * 1.6));
    let dra = ((ra - ra0 + 540) % 360) - 180;
    const t0 = performance.now();
    S.flying = true;
    return new Promise((resolve) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out
        // log-space zoom: up to peak in first half, down to target in second
        const lf = t < 0.5 ? Math.log(f0) + (Math.log(peak) - Math.log(f0)) * (e * 2)
          : Math.log(peak) + (Math.log(fovDeg) - Math.log(peak)) * ((e - 0.5) * 2);
        try { a.gotoRaDec(ra0 + dra * e, dec0 + (dec - dec0) * e); a.setFoV(Math.exp(lf)); } catch (_) { /* ignore */ }
        if (t < 1) requestAnimationFrame(step); else { S.flying = false; resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  // The part of the screen not covered by the top bar, drawer and dock.
  function freeArea() {
    const top = (document.querySelector(".top").getBoundingClientRect().bottom || 70) + 50;
    const dock = $("dock").getBoundingClientRect();
    const dr = $("drawer").getBoundingClientRect();
    const left = isNarrow() || $("drawer").classList.contains("closed") ? 12 : dr.right + 12;
    const bottom = (dock.top || innerHeight) - 30;
    const card = $("starCard");
    const right = !card.hidden && !isNarrow() ? card.getBoundingClientRect().left - 16 : innerWidth - 12;
    return { x: (left + right) / 2, y: (top + bottom) / 2, w: right - left, h: Math.max(120, bottom - top) };
  }
  // Pan so (ra, dec) sits in the middle of the free area instead of under the dock.
  function centreInFreeArea(ra, dec, quick) {
    try {
      const f = freeArea(), p = S.aladin.world2pix(ra, dec);
      if (!p) return;
      const w = S.aladin.pix2world(innerWidth / 2 + (p[0] - f.x), innerHeight / 2 + (p[1] - f.y));
      if (w && isFinite(w[0])) S.aladin.gotoRaDec(w[0], w[1]);
    } catch (_) { /* ignore */ }
  }

  function setGaia() {
    if (!S.aladin || S.cat) { if (S.gaiaCat) { try { S.aladin.removeLayer(S.gaiaCat); } catch (_) { /* ignore */ } S.gaiaCat = null; } return; }
    try {
      if (S.gaiaCat) { S.aladin.removeLayer ? S.aladin.removeLayer(S.gaiaCat) : S.gaiaCat.hide(); S.gaiaCat = null; }
      if ($("gaia").checked && S.pack) {
        const m = S.pack.m;
        S.gaiaCat = A.catalogFromVizieR("I/355/gaiadr3", `${m.ra} ${m.dec}`, m.fov_arcmin / 100,
          { onClick: "showTable", color: "#5cc8e8", sourceSize: 9, name: "Gaia DR3" });
        S.aladin.addCatalog(S.gaiaCat);
      }
    } catch (e) { console.warn("Gaia overlay failed", e); }
  }

  // ---------------- data loading ----------------
  // Scanned areas live on the scan server; the built-in targets ship with the site.
  const packBase = (slug) => (slug.startsWith("live_") && API ? `${API}/data/${slug}` : `${DATA_ROOT}/${slug}`);
  async function pingApi(ms = 4000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(`${API}/api/health`, { signal: ctl.signal, cache: "no-store" }); S.apiOk = r.ok; } catch (_) { S.apiOk = false; }
    clearTimeout(t); return S.apiOk;
  }
  // A free host sleeps when idle and takes about a minute to wake up.
  async function wakeApi() {
    if (S.apiOk || (await pingApi(4000))) return true;
    if (!API) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      toast(`Waking up the scan server… ${Math.round((Date.now() - t0) / 1000)} s (free servers nap when nobody is using them, about a minute)`);
      if (await pingApi(15000)) { toast(""); return true; }
      await new Promise((res) => setTimeout(res, 3000));
    }
    toast(""); return false;
  }
  async function loadIndex() {
    try { const r = await fetch(`${DATA_ROOT}/index.json`, { cache: "no-cache" }); if (r.ok) S.index = (await r.json()).packs || []; } catch (_) { /* none */ }
    renderChips();
    // don't hold up the page while a sleeping server wakes; check in the background
    pingApi(API ? 8000 : 3000).then(async (ok) => {
      if (!ok || !API) return;
      try {
        const r = await fetch(`${API}/api/packs`); if (!r.ok) return;
        const have = new Set(S.index.map((p) => p.slug));
        for (const p of (await r.json()).packs) if (!have.has(p.slug)) S.index.push(Object.assign({ live: true, kind: "Scanned area" }, p));
      } catch (_) { /* optional */ }
    });
  }
  const visiblePacks = () => S.index.filter((p) => !p.slug.startsWith("live_") && !p.slug.startsWith("survey_") && (!p.slug.startsWith("_") || location.search.includes("synthetic")));

  function renderChips() {
    const el = $("chips"); el.innerHTML = "";
    for (const p of visiblePacks()) {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.slug = p.slug;
      b.innerHTML = `${p.name}<small>${p.kind || ""}</small>`;
      b.addEventListener("click", () => { setView("sky"); openPack(p.slug, { fly: true }); });
      el.appendChild(b);
    }
  }

  async function openPack(slug, opts = {}) {
    stop();
    toast("Loading SPHEREx images…");
    try {
      const base = packBase(slug);
      const m = await (await fetch(`${base}/manifest.json`, { cache: "no-cache" })).json();
      const cube = new Float32Array(await (await fetch(`${base}/frames.bin`)).arrayBuffer());
      if (cube.length !== m.frames.length * m.npix * m.npix) throw new Error("frames.bin does not match manifest");
      S.pack = { m, cube, n: m.npix };
      S.cat = null;
      if (!m.tracking) { try { const r = await fetch(`${base}/catalog.json`, { cache: "no-cache" }); if (r.ok) S.cat = await r.json(); } catch (_) { /* no catalogue */ } }
    } catch (e) { toast(""); banner(`Could not load ${slug}: ${e.message}`); return; }
    const m = S.pack.m;
    S.slug = slug;
    S.coadds.clear(); S.stretch.clear(); S.movers = []; S.pick = null; S.frame = 0;
    if (window.Analysis) Analysis.reset();
    S.band = opts.band != null ? +opts.band : 0;
    S.mode = opts.mode || (S.pack.m.tracking ? "frames" : "blink");
    // faint moving objects: smooth by default so they stand out from the noise
    S.smooth = !!S.pack.m.tracking; $("smooth").checked = S.smooth;
    S.epoch = Math.min(+opts.epoch || 0, m.epochs.length - 1);
    off.width = off.height = S.pack.n;
    document.querySelectorAll("#chips button").forEach((b) => b.classList.toggle("on", b.dataset.slug === slug));
    banner(m.synthetic ? "Test mode: FAKE sky data generated for testing, not SPHEREx images." : "");
    $("dock").classList.remove("disabled");
    buildEpochButtons(); buildBandButtons(); syncModeButtons(); fillInfo();
    $("moversCard").hidden = true;
    toast("");
    render(); drawCharts(); setGaia(); updateUrl();
    const free = freeArea();
    // Aladin's FoV is the horizontal span; size it so the SPHEREx frame fills ~80% of the free area.
    const viewFov = Math.max((m.fov_arcmin / 60) * innerWidth / (0.8 * Math.min(free.w, free.h)), 0.03);
    if (S.aladin) {
      if (opts.fly !== false) await flyTo(m.ra, m.dec, viewFov);
      else { S.aladin.gotoRaDec(m.ra, m.dec); S.aladin.setFoV(viewFov); }
      centreInFreeArea(m.ra, m.dec);
    }
    if (m.epochs.length > 1 && opts.autoplay !== false) play();
    if (window.FX && !m.synthetic) FX.event("pack", { slug });
  }

  // ---------------- image maths ----------------
  function framesWhere(fn) { const out = []; S.pack.m.frames.forEach((f, i) => { if (fn(f)) out.push(i); }); return out; }
  const bandMatch = (f, band) => band === 0 || f.detector === band;
  // Median stack (robust to cosmic rays, persistence and other one-frame glitches).
  function coadd(key, idxs) {
    if (S.coadds.has(key)) return S.coadds.get(key);
    const { cube, n } = S.pack, N = n * n, k = idxs.length;
    const out = new Float32Array(N), buf = new Float32Array(k);
    for (let p = 0; p < N; p++) {
      let c = 0;
      for (let j = 0; j < k; j++) { const v = cube[idxs[j] * N + p]; if (v === v) buf[c++] = v; }
      if (!c) { out[p] = NaN; continue; }
      const sub = buf.subarray(0, c).sort();
      out[p] = c % 2 ? sub[c >> 1] : 0.5 * (sub[(c >> 1) - 1] + sub[c >> 1]);
    }
    S.coadds.set(key, out);
    return out;
  }
  // Optional 3x3 smoothing to bring out faint sources (like WISE 0855) at the cost of sharpness.
  function smooth(arr) {
    const n = S.pack.n, out = new Float32Array(arr.length);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const v = arr[yy * n + xx]; if (v === v) { const w = dx || dy ? (dx && dy ? 1 : 2) : 4; s += w * v; c += w; }
      }
      out[y * n + x] = c ? s / c : NaN;
    }
    return out;
  }
  const maybeSmooth = (key, arr) => {
    if (!S.smooth) return arr;
    const k = `s:${key}`; if (!S.coadds.has(k)) S.coadds.set(k, smooth(arr)); return S.coadds.get(k);
  };
  const epochCoaddRaw = (e, band) => coadd(`e${e}b${band}`, framesWhere((f) => f.epoch === e && bandMatch(f, band)));
  const epochCoadd = (e, band) => maybeSmooth(`e${e}b${band}`, epochCoaddRaw(e, band));
  const groupCoadd = (e, g) => maybeSmooth(`e${e}g${g}`, coadd(`e${e}g${g}`, framesWhere((f) => f.epoch === e && RGB_GROUPS[g].includes(f.detector))));

  function percentiles(arrays, ps) {
    const vals = [];
    for (const a of arrays) for (let i = 0; i < a.length; i++) if (a[i] === a[i]) vals.push(a[i]);
    if (!vals.length) return ps.map(() => 0);
    vals.sort((x, y) => x - y);
    return ps.map((p) => vals[Math.min(vals.length - 1, Math.floor((p / 100) * vals.length))]);
  }
  // One stretch per band across ALL epochs, so real brightness changes stay visible.
  function stretchFor(key, arrays, skyZero) {
    key += S.smooth ? ":s" : "";
    if (!S.stretch.has(key)) { const [lo, mid, hi] = percentiles(arrays, [1, 50, 99.7]); S.stretch.set(key, { lo, mid, hi }); }
    const s = S.stretch.get(key);
    const c = +$("contrast").value / 100, b = +$("bright").value / 100;
    const span = Math.max(s.hi - s.lo, 1e-12);
    const lo = skyZero ? s.mid + (s.hi - s.mid) * (0.06 - b * 0.1) : s.mid - (s.mid - s.lo) * (1.6 - b * 1.2);
    const soft = span * Math.pow(10, -3 * c);
    const norm = Math.asinh((s.hi - lo) / soft) || 1;
    return (v) => (v === v ? Math.max(0, Math.min(1, Math.asinh((v - lo) / soft) / norm)) : -1);
  }
  function mad(a) {
    const v = []; for (const x of a) if (x === x) v.push(x);
    if (!v.length) return { med: 0, sigma: 1 };
    v.sort((x, y) => x - y); const med = v[v.length >> 1];
    const d = v.map((x) => Math.abs(x - med)).sort((x, y) => x - y);
    return { med, sigma: 1.4826 * d[d.length >> 1] || 1e-9 };
  }
  // Difference between two epochs in units of noise (sigma).
  // For "All", each detector is differenced against itself first, so stars that just
  // look different at different wavelengths do not show up as fake changes.
  function diffSigma(from, to, band) {
    const dets = band === 0 ? S.pack.m.detectors.map((d) => d.id) : [band];
    const N = S.pack.n * S.pack.n, sum = new Float32Array(N), cnt = new Uint8Array(N);
    for (const d of dets) {
      const A = epochCoadd(from, d), B = epochCoadd(to, d), D = new Float32Array(N);
      for (let i = 0; i < N; i++) D[i] = B[i] - A[i];
      const { med, sigma } = mad(D);
      if (!(sigma > 0)) continue;
      for (let i = 0; i < N; i++) { const v = (D[i] - med) / sigma; if (v === v) { sum[i] += v; cnt[i]++; } }
    }
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = cnt[i] ? sum[i] / Math.sqrt(cnt[i]) : NaN;
    return out;
  }
  function diffArrays() {
    const ne = S.pack.m.epochs.length, to = S.epoch === 0 ? ne - 1 : S.epoch;
    const key = `d0-${to}-${S.band}-${S.smooth ? 1 : 0}`;
    if (!S.coadds.has(key)) S.coadds.set(key, diffSigma(0, to, S.band));
    return { D: S.coadds.get(key), from: 0, to };
  }

  // Paint the current SPHEREx view into the small offscreen canvas (north up, east left).
  function render() {
    if (!S.pack) return;
    const { n, m } = S.pack;
    const img = offCtx.createImageData(n, n), px = img.data;
    const put = (x, y, r, g, b, a = 255) => { const o = ((n - 1 - y) * n + x) * 4; px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a; };
    let hud;
    if (S.mode === "frames") {
      const list = frameList(), k = list[Math.min(S.frame, list.length - 1)];
      const sample = list.filter((_, i) => i % Math.max(1, Math.floor(list.length / 30)) === 0).map((j) => maybeSmooth(`f${j}`, frameView(j)));
      const f = stretchFor(`f${S.band}`, sample), arr = maybeSmooth(`f${k}`, frameView(k)), fr = m.frames[k];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const v = f(arr[y * n + x]);
        if (v < 0) { put(x, y, 0, 0, 0, 0); continue; }
        const g = 255 * v; put(x, y, g, g, g);
      }
      hud = `Frame ${S.frame + 1}/${list.length} · ${mjdToStamp(fr.mjd)} UTC\nDetector ${fr.detector} · ${fmt(fr.wavelength_um, 2)} µm`;
    } else if (S.mode === "diff" && m.epochs.length > 1) {
      const { D, from, to } = diffArrays(); const med = 0, lim = 7;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const v = D[y * n + x];
        if (v !== v) { put(x, y, 0, 0, 0, 0); continue; }
        const t = Math.max(-1, Math.min(1, (v - med) / lim)), k = Math.abs(t);
        if (t >= 0) put(x, y, 255 * k, 179 * k, 71 * k); else put(x, y, 92 * k, 200 * k, 232 * k);
      }
      hud = `Epoch ${to + 1} − Epoch ${from + 1}\n${bandLabel(S.band)}\norange = brighter now · blue = fainter now`;
    } else if (S.mode === "rgb") {
      const ch = ["r", "g", "b"].map((g) => { const all = m.epochs.map((_, e) => groupCoadd(e, g)); return { arr: all[S.epoch], f: stretchFor(`rgb${g}`, all, true) }; });
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x, v = ch.map((c) => c.f(c.arr[i]));
        if (v.every((q) => q < 0)) { put(x, y, 0, 0, 0, 0); continue; }
        put(x, y, 255 * Math.max(0, v[0]), 255 * Math.max(0, v[1]), 255 * Math.max(0, v[2]));
      }
      hud = `${epochLabel(S.epoch)}\nR 3.8–5.0 µm · G 1.6–3.8 µm · B 0.75–1.6 µm`;
    } else {
      const all = m.epochs.map((_, e) => epochCoadd(e, S.band)), f = stretchFor(`b${S.band}`, all), arr = all[S.epoch];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const v = f(arr[y * n + x]);
        if (v < 0) { put(x, y, 0, 0, 0, 0); continue; }
        const g = 255 * v; put(x, y, g, g, g);
      }
      hud = `${epochLabel(S.epoch)}\n${bandLabel(S.band)}`;
    }
    offCtx.putImageData(img, 0, 0);
    const h = $("hud"); h.hidden = false; h.innerText = hud;
    document.querySelectorAll("#epochs button").forEach((b, i) => b.classList.toggle("on", i === S.epoch && S.mode !== "frames"));
    syncTimeline();
    if (m.tracking && S.aladin && $("follow").checked && !S.flying) { const [ra, dec] = packCentre(); centreInFreeArea(ra, dec, true); }
    if (!S.aladin) drawFallback();
    updateHoloScreen();
  }
  // Frames in time order that match the current band.
  function frameList() {
    const key = `fl${S.band}`;
    if (!S.coadds.has(key)) S.coadds.set(key, framesWhere((f) => bandMatch(f, S.band)));
    return S.coadds.get(key);
  }
  const currentFrameIndex = () => { const l = frameList(); return l[Math.min(S.frame, l.length - 1)]; };
  const mjdToStamp = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 16).replace("T", " ");
  function syncTimeline() {
    const t = $("timeline"), lab = $("tlLabel"), m = S.pack.m;
    if (S.mode === "frames") {
      const l = frameList(); t.max = Math.max(0, l.length - 1); t.value = S.frame;
      const fr = m.frames[l[S.frame]];
      // each cut-out comes from a full 2048×2048 SPHEREx image (3.5° × 3.5°): link to the original
      lab.innerHTML = `${mjdToStamp(fr.mjd)} · frame ${S.frame + 1}/${l.length}` +
        (fr.url ? ` · <a href="${fr.url}" target="_blank" rel="noopener" title="Full SPHEREx image this cut-out comes from: 2048×2048 px, 3.5°×3.5°, ~70 MB FITS from NASA IRSA">full image ↗</a>` : "");
    } else {
      t.max = Math.max(0, m.epochs.length - 1); t.value = S.epoch;
      lab.textContent = `${m.epochs[S.epoch].start} · epoch ${S.epoch + 1}/${m.epochs.length}`;
    }
  }

  // ---------------- overlay (runs every animation frame) ----------------
  function sizeOverlay() {
    const dpr = window.devicePixelRatio || 1;
    ov.width = Math.round(innerWidth * dpr); ov.height = Math.round(innerHeight * dpr);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function w2s(ra, dec) {
    try { const p = S.aladin.world2pix(ra, dec); return p && isFinite(p[0]) && isFinite(p[1]) ? p : null; } catch (_) { return null; }
  }
  function frameLoop() {
    octx.clearRect(0, 0, innerWidth, innerHeight);
    if (S.aladin) {
      drawPackMarkers();
      if (S.pack) drawPackOnSky();
      if (S.sel && !$("starCard").hidden) {
        const s = w2s(S.sel.ra, S.sel.dec);
        if (s) {
          octx.strokeStyle = "#ffffff"; octx.lineWidth = 2;
          octx.beginPath(); octx.arc(s[0], s[1], 14, 0, 2 * Math.PI);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { octx.moveTo(s[0] + dx * 18, s[1] + dy * 18); octx.lineTo(s[0] + dx * 26, s[1] + dy * 26); }
          octx.stroke();
        }
      }
      $("lookHere").hidden = !(skyFov() < 2) || packUnderView();
    }
    requestAnimationFrame(frameLoop);
  }
  function packUnderView() {
    if (!S.aladin) return true;
    if (S.pack && S.xf) {
      const [x, y] = imgToScreen((S.pack.n - 1) / 2, (S.pack.n - 1) / 2);
      if (x > 0 && y > 0 && x < innerWidth && y < innerHeight) return true;
    }
    const [ra, dec] = S.aladin.getRaDec();
    return S.index.some((p) => angDist(p.ra, p.dec, ra, dec) * 60 < p.fov_arcmin / 2);
  }
  function angDist(r1, d1, r2, d2) {
    return Math.acos(Math.min(1, Math.sin(d1 * D2R) * Math.sin(d2 * D2R) + Math.cos(d1 * D2R) * Math.cos(d2 * D2R) * Math.cos((r1 - r2) * D2R))) / D2R;
  }

  function drawPackMarkers() {
    const fov = skyFov();
    // pulsing magenta blips for the unknown signals (easter eggs)
    if (window.FX && fov < 90) {
      const t = performance.now();
      for (const sp of FX.spots()) {
        const s = w2s(sp.ra, sp.dec); if (!s) continue;
        // undiscovered spots are only a faint, unlabelled glint: something to notice, not clutter
        const r = sp.found ? 7 + 3 * Math.sin(t / 250 + sp.ra) : 4 + Math.sin(t / 600 + sp.ra);
        octx.globalAlpha = sp.found ? 1 : 0.45;
        octx.strokeStyle = "#ff4fd8"; octx.lineWidth = sp.found ? 2 : 1.2; octx.shadowColor = "#ff4fd8"; octx.shadowBlur = sp.found ? 10 : 4;
        octx.beginPath(); octx.moveTo(s[0], s[1] - r); octx.lineTo(s[0] + r, s[1]); octx.lineTo(s[0], s[1] + r); octx.lineTo(s[0] - r, s[1]); octx.closePath(); octx.stroke();
        octx.shadowBlur = 0; octx.globalAlpha = 1;
        if (sp.found) { octx.font = "400 12.5px 'Share Tech Mono', monospace"; octx.fillStyle = "#ff4fd8"; octx.fillText(sp.title.split(":").pop().trim(), s[0] + 14, s[1] + 4); }
      }
    }
    for (const p of visiblePacks()) {
      if (S.pack && p.slug === S.slug && S.xf && Math.hypot(S.xf.a, S.xf.b) * S.pack.n >= 40) continue;
      const s = w2s(p.ra, p.dec); if (!s) continue;
      const r = 9;
      octx.strokeStyle = "#5ef2ff"; octx.lineWidth = 2;
      octx.beginPath(); octx.moveTo(s[0], s[1] - r - 2); octx.lineTo(s[0] + r + 2, s[1]); octx.lineTo(s[0], s[1] + r + 2); octx.lineTo(s[0] - r - 2, s[1]); octx.closePath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { octx.moveTo(s[0] + dx * (r + 2), s[1] + dy * (r + 2)); octx.lineTo(s[0] + dx * (r + 8), s[1] + dy * (r + 8)); }
      octx.stroke();
      octx.font = "400 13px 'Share Tech Mono', monospace"; octx.fillStyle = "#5ef2ff";
      octx.shadowColor = "rgba(0,0,0,.8)"; octx.shadowBlur = 4;
      octx.fillText(p.name, s[0] + r + 12, s[1] + 4); octx.shadowBlur = 0;
    }
  }

  // Affine map from offscreen-canvas coords (u right, v down) to screen, via 3 projected corners.
  function computeXf() {
    const n = S.pack.n;
    const P = (x, y) => { const [ra, dec] = pixToWorld(x, y); return w2s(ra, dec); };
    const p00 = P(-0.5, n - 0.5), p10 = P(n - 0.5, n - 0.5), p01 = P(-0.5, -0.5);
    if (!p00 || !p10 || !p01) return null;
    return { a: (p10[0] - p00[0]) / n, b: (p10[1] - p00[1]) / n, c: (p01[0] - p00[0]) / n, d: (p01[1] - p00[1]) / n, e: p00[0], f: p00[1] };
  }
  const imgToScreen = (x, y) => { const X = S.xf, u = x + 0.5, v = S.pack.n - 0.5 - y; return [X.a * u + X.c * v + X.e, X.b * u + X.d * v + X.f]; };
  function screenToImg(sx, sy) {
    const X = S.xf, det = X.a * X.d - X.b * X.c; if (!det) return null;
    const dx = sx - X.e, dy = sy - X.f;
    const u = (X.d * dx - X.c * dy) / det, v = (-X.b * dx + X.a * dy) / det;
    return { x: Math.floor(u), y: S.pack.n - 1 - Math.floor(v), u, v };
  }

  function drawPackOnSky() {
    S.xf = computeXf(); if (!S.xf) return;
    const X = S.xf, n = S.pack.n, m = S.pack.m;
    const pxSize = Math.hypot(X.a, X.b);
    octx.save();
    octx.globalAlpha = +$("opacity").value / 100;
    octx.imageSmoothingEnabled = pxSize < 3;
    octx.setTransform(X.a * devicePixelRatio, X.b * devicePixelRatio, X.c * devicePixelRatio, X.d * devicePixelRatio, X.e * devicePixelRatio, X.f * devicePixelRatio);
    octx.drawImage(off, 0, 0);
    octx.restore();
    octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const c = [imgToScreen(-0.5, n - 0.5), imgToScreen(n - 0.5, n - 0.5), imgToScreen(n - 0.5, -0.5), imgToScreen(-0.5, -0.5)];
    if (Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) < 40) return; // too small: the marker is enough
    // holographic frame: thin outline, bright corner brackets, label
    octx.strokeStyle = "rgba(94,242,255,.35)"; octx.lineWidth = 1;
    octx.beginPath(); c.forEach((p, i) => (i ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1]))); octx.closePath(); octx.stroke();
    octx.strokeStyle = "#5ef2ff"; octx.lineWidth = 2.5; octx.shadowColor = "rgba(94,242,255,.9)"; octx.shadowBlur = 8;
    const L = Math.min(28, Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) / 5);
    c.forEach((p, i) => {
      const a = c[(i + 3) % 4], b = c[(i + 1) % 4];
      const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
      octx.beginPath(); octx.moveTo(p[0] + (a[0] - p[0]) / da * L, p[1] + (a[1] - p[1]) / da * L); octx.lineTo(p[0], p[1]);
      octx.lineTo(p[0] + (b[0] - p[0]) / db * L, p[1] + (b[1] - p[1]) / db * L); octx.stroke();
    });
    octx.shadowBlur = 0;
    octx.font = "400 13px 'Share Tech Mono', monospace"; octx.fillStyle = "#5ef2ff";
    octx.fillText(`SPHEREx FEED // ${(m.name || "").toUpperCase()}`, Math.min(c[0][0], c[3][0]), Math.min(c[0][1], c[1][1]) - 10);
    if (pxSize < 1.2) return; // too small to draw details
    // predicted motion track
    if (m.tracking) {
      // mark the object at the centre of the frame
      const [ox, oy] = imgToScreen((n - 1) / 2, (n - 1) / 2), rr = Math.max(12, pxSize * 3);
      octx.strokeStyle = "#ffb547"; octx.lineWidth = 1.8;
      octx.beginPath(); octx.arc(ox, oy, rr, 0, 2 * Math.PI); octx.stroke();
      octx.font = "400 12.5px 'Share Tech Mono', monospace"; octx.fillStyle = "#ffb547";
      octx.fillText(`${(m.name || "").toUpperCase()} · predicted position`, ox + rr + 6, oy - rr);
      octx.setLineDash([4, 6]); octx.strokeStyle = "rgba(255,181,71,.8)"; octx.lineWidth = 1.5; octx.beginPath();
      let started = false;
      for (const f of m.frames) { const s = w2s(f.obj_ra, f.obj_dec); if (!s) continue; started ? octx.lineTo(s[0], s[1]) : octx.moveTo(s[0], s[1]); started = true; }
      octx.stroke(); octx.setLineDash([]);
    } else if ($("showTrack").checked) {
      const pts = m.epochs.map((e) => predictedPixel(mjdToYear(e.mjd_mean))).filter(Boolean).map((p) => imgToScreen(p[0], p[1]));
      if (pts.length) {
        octx.setLineDash([6, 6]); octx.strokeStyle = "rgba(224,120,92,.85)"; octx.lineWidth = 1.5;
        octx.beginPath(); pts.forEach((p, i) => (i ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1]))); octx.stroke(); octx.setLineDash([]);
        pts.forEach((p, i) => {
          octx.strokeStyle = i === S.epoch && S.mode !== "diff" ? "#e0785c" : "rgba(224,120,92,.45)";
          octx.lineWidth = i === S.epoch ? 2.5 : 1.5;
          octx.beginPath(); octx.arc(p[0], p[1], Math.max(9, pxSize * 2.2), 0, 2 * Math.PI); octx.stroke();
        });
      }
    }
    if ($("gaia").checked && S.cat && !m.tracking && pxSize >= 1.5) {
      const year = yearNow(), half = n / 2 + 1;
      for (const src of shownCatalog()) {
        const [r, d] = catAt(src, year), [x, y] = worldToPix(r, d);
        if (Math.abs(x - (n - 1) / 2) > half || Math.abs(y - (n - 1) / 2) > half) continue;
        const [sx, sy] = imgToScreen(x, y), fast = isFast(src);
        const rr = Math.max(4, pxSize * (fast ? 1.6 : 0.9));
        octx.lineWidth = fast ? 2 : 1;
        octx.strokeStyle = src.cat === "gaia" ? (fast ? "#5ef2ff" : "rgba(94,242,255,.55)") : (fast ? "#ffb547" : "rgba(255,181,71,.45)");
        octx.beginPath();
        if (src.cat === "gaia") octx.arc(sx, sy, rr, 0, 2 * Math.PI); else octx.rect(sx - rr, sy - rr, 2 * rr, 2 * rr);
        octx.stroke();
        if (fast && pxSize >= 4 && Math.hypot(src.pmra, src.pmdec) > 1000) { octx.font = "400 11px 'Share Tech Mono', monospace"; octx.fillStyle = octx.strokeStyle; octx.fillText(`${fmt(Math.hypot(src.pmra, src.pmdec) / 1000, 1)}″/yr`, sx + rr + 3, sy - rr); }
      }
    }
    S.movers.forEach((mv, i) => {
      const [x, y] = imgToScreen(mv.x, mv.y), h = Math.max(8, pxSize * 2.5);
      octx.strokeStyle = mv.kind === "moved" ? "#9be15d" : "#ff7ab6"; octx.lineWidth = 2;
      octx.strokeRect(x - h, y - h, 2 * h, 2 * h);
      octx.fillStyle = octx.strokeStyle; octx.font = "600 13px Inter, sans-serif"; octx.fillText(String(i + 1), x + h + 3, y - h + 4);
    });
    if (S.pick) {
      const [x, y] = imgToScreen(S.pick.x, S.pick.y), h = Math.max(6, pxSize * 1.5);
      octx.strokeStyle = "#ffffff"; octx.lineWidth = 1.5; octx.strokeRect(x - h, y - h, 2 * h, 2 * h);
    }
  }

  function onSkyClick(cx, cy) {
    // Inside the SPHEREx frame: also feed the pixel inspector.
    if (S.pack && S.xf) {
      const p = screenToImg(cx, cy);
      if (p && p.u >= 0 && p.v >= 0 && p.u < S.pack.n && p.v < S.pack.n) {
        S.pick = { x: p.x, y: p.y };
        drawCharts();
      }
    }
    // Anywhere: identify what was clicked.
    try {
      const r = $("sky").getBoundingClientRect();
      const w = S.aladin.pix2world(cx - r.left, cy - r.top);
      if (w && isFinite(w[0])) identify(w[0], w[1]);
    } catch (_) { /* clicked outside the sky */ }
  }

  // ---------------- click a star: "what is this?" ----------------
  const OTYPES = {
    "*": "Star", "PM*": "High proper-motion star", "BD*": "Brown dwarf", "LM*": "Low-mass star", "Mi*": "Mira variable star",
    "V*": "Variable star", "TT*": "Young T Tauri star", "Or*": "Young variable star", "Y*O": "Young stellar object",
    "WD*": "White dwarf", "C*": "Carbon star", "EB*": "Eclipsing binary star", "SB*": "Spectroscopic binary", "**": "Double star",
    "RG*": "Red giant", "AB*": "Asymptotic giant branch star", "s*r": "Red supergiant", "HB*": "Horizontal branch star",
    "G": "Galaxy", "GiG": "Galaxy in a group", "GiC": "Galaxy in a cluster", "QSO": "Quasar", "AGN": "Active galaxy", "Sy1": "Seyfert galaxy",
    "Sy2": "Seyfert galaxy", "BLL": "Blazar", "HII": "Star-forming nebula", "PN": "Planetary nebula", "SNR": "Supernova remnant",
    "Cl*": "Star cluster", "OpC": "Open cluster", "GlC": "Globular cluster", "MoC": "Molecular cloud", "DNe": "Dark nebula",
    "RNe": "Reflection nebula", "IR": "Infrared source", "X": "X-ray source", "Rad": "Radio source", "Pl": "Exoplanet",
    "Ast": "Asteroid", "Com": "Comet", "SN*": "Supernova", "Ce*": "Cepheid variable", "RR*": "RR Lyrae variable", "dS*": "Delta Scuti variable",
    "Em*": "Emission-line star", "Be*": "Be star", "BS*": "Blue straggler", "BY*": "BY Draconis variable", "Er*": "Eruptive variable", "Fl*": "Flare star",
  };
  async function identify(ra, dec) {
    const radius = Math.min(0.5, Math.max(4 / 3600, (skyFov() / innerWidth) * 14));
    S.sel = { ra, dec };
    showCard({ loading: true, ra, dec });
    const q = `SELECT TOP 1 b.main_id, b.ra, b.dec, b.otype, b.plx_value, b.pmra, b.pmdec, f.flux AS vmag,
      DISTANCE(POINT('ICRS', b.ra, b.dec), POINT('ICRS', ${ra}, ${dec})) AS d
      FROM basic AS b LEFT JOIN flux AS f ON f.oidref = b.oid AND f.filter = 'V'
      WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', ${ra}, ${dec}, ${radius})) = 1
      ORDER BY d ASC`;
    try {
      const url = `https://simbad.cds.unistra.fr/simbad/sim-tap/sync?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(q)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
      if (!res.ok) throw new Error(`SIMBAD ${res.status}`);
      const js = await res.json();
      if (!S.sel || S.sel.ra !== ra) return; // a newer click happened
      const row = js.data && js.data[0];
      if (!row) { showCard({ ra, dec }); if (window.FX) FX.checkSpot(ra, dec); return; }
      const col = {}; js.metadata.forEach((m, i) => { col[m.name] = row[i]; });
      S.sel = { ra: col.ra, dec: col.dec };
      showCard({ name: col.main_id, otype: col.otype, ra: col.ra, dec: col.dec, plx: col.plx_value, pmra: col.pmra, pmdec: col.pmdec, vmag: col.vmag });
      if (window.FX) { FX.event("identify"); FX.checkSpot(col.ra, col.dec); }
    } catch (e) {
      console.warn("SIMBAD lookup failed", e);
      if (S.sel && S.sel.ra === ra) { showCard({ ra, dec, offline: true }); if (window.FX) FX.checkSpot(ra, dec); }
    }
  }
  // Which pre-built SPHEREx archive (if any) covers this position?
  const packAt = (ra, dec) => (ra == null ? null : S.index.find((p) => angDist(p.ra, p.dec, ra, dec) * 60 < Math.max(p.fov_arcmin / 2, 0.6)));
  const preview = document.createElement("canvas");
  function showCard(o) {
    const el = $("starCard");
    el.hidden = false;
    document.body.classList.add("card-open");
    // re-trigger the open animation
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    const has = o.ra != null && isFinite(o.ra);
    const coords = has ? `${sexa(o.ra, true)} ${sexa(o.dec, false)}` : "–";
    const dec5 = has ? `${fmt(o.ra, 5)} ${fmt(o.dec, 5)}` : "";
    const archive = o.slug ? S.index.find((p) => p.slug === o.slug) : packAt(o.ra, o.dec);
    const live = archive && S.pack && archive.slug === S.slug && document.body.classList.contains("mode-sky");
    let html = `<button class="close" type="button" aria-label="Close">×</button>
      <div class="kicker"><span>◇ TARGET LOCK</span><span>${has ? fmt(o.ra, 3) + " " + fmt(o.dec, 3) : "ORIGIN"}</span></div>`;
    if (o.loading) {
      html += `<h3>Acquiring…</h3><p class="scanning">QUERYING SIMBAD ARCHIVE ▮▮▮▯▯</p>`;
    } else {
      const type = o.kind || OTYPES[o.otype] || o.otype || (o.name ? "Object" : o.offline ? "Sensor link down" : "Uncharted");
      const rows = [["Coords", coords]];
      if (has) rows.push(["Decimal", dec5]);
      if (o.dist != null && o.dist > 0) rows.push(["Distance", `${fmt(o.dist, 2)} light years`]);
      else if (o.far) rows.push(["Distance", "far beyond this map"]);
      else if (o.plx > 0) { const ly = 3261.56 / o.plx; rows.push(["Distance", ly < 1000 ? `${fmt(ly, 1)} light years` : `${Math.round(ly).toLocaleString()} light years`]); }
      if (o.vmag != null) rows.push(["Brightness", `mag ${fmt(o.vmag, 1)}${o.vmag > 6.5 ? " · too faint for eyes" : ""}`]);
      if (o.pmra != null && o.pmdec != null) { const pm = Math.hypot(o.pmra, o.pmdec) / 1000; if (pm > 0.05) rows.push(["Motion", `${fmt(pm, 2)}″/yr${pm > 1 ? " · FAST MOVER" : ""}`]); }
      rows.push(["SPHEREx", archive ? `<span style="color:var(--ok)">ARCHIVE ONLINE</span> · ${archive.n_frames} frames, ${archive.n_epochs} epochs` : "no archive yet"]);
      html += `<h3>${escapeHtml(o.name || (o.offline ? "Unknown point" : "Empty sky"))}</h3><p class="type">${escapeHtml(type)}</p>` + metaList(rows);
      if (live) html += `<div class="screen"><canvas id="holoScreen" aria-label="Live SPHEREx feed"></canvas><span class="cap" id="holoCap"></span></div>`;
      if (o.sol) {
        const ss = S.index.filter((p) => p.tracking);
        if (ss.length) html += `<p class="type" style="margin-top:12px">Solar System visitors in the archive</p><div class="actions">` +
          ss.map((p) => `<button type="button" class="primary" data-pack="${p.slug}">Track ${escapeHtml(p.name)}</button>`).join("") + `</div>`;
      }
      html += `<div class="actions">`;
      if (o.mapMode && has) html += `<button type="button" class="primary" data-act="warp">Warp ›</button>`;
      if (!o.mapMode || !has) {
        if (archive && !live) html += `<button type="button" class="primary" data-act="engage">Engage archive</button>`;
        else if (!archive && has) html += `<button type="button" class="primary" data-act="spherex">Initiate SPHEREx scan</button>`;
      }
      if (has) html += `<button type="button" data-act="copy">Copy coords</button>`;
      if (has && !o.mapMode && S.pack) html += `<button type="button" data-act="log">Log candidate</button>`;
      if (o.name && !o.sol) html += `<a href="https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(o.name)}" target="_blank" rel="noopener">SIMBAD ↗</a>`;
      html += `</div>`;
    }
    el.innerHTML = html;
    el.querySelector(".close").addEventListener("click", () => { el.hidden = true; S.sel = null; document.body.classList.remove("card-open"); });
    el.querySelectorAll("[data-pack]").forEach((b) => b.addEventListener("click", async () => {
      el.hidden = true; document.body.classList.remove("card-open");
      setView("sky"); await openPack(b.dataset.pack, { fly: true });
    }));
    const on = (act, fn) => { const b = el.querySelector(`[data-act="${act}"]`); if (b) b.addEventListener("click", fn); };
    on("spherex", () => goTo(o.ra, o.dec, +$("fov").value, o.name || null));
    on("engage", () => { setView("sky"); openPack(archive.slug, { fly: true }).then(() => showCard(o)); });
    on("warp", async () => {
      el.hidden = true;
      if (window.Starmap && !researchMode()) await window.Starmap.warpTo(o.name);
      if (window.FX) FX.event("warp");
      setView("sky");
      if (archive) {
        await openPack(archive.slug, { fly: false });
        showCard(Object.assign({}, o, { mapMode: false }));
        const m = S.pack.m, f = freeArea();
        S.aladin.setFoV(Math.max((m.fov_arcmin / 60) * innerWidth / (0.8 * Math.min(f.w, f.h)), 0.03));
        centreInFreeArea(m.ra, m.dec);
      }
      else if (S.aladin) { await flyTo(o.ra, o.dec, 0.5, 1200); S.sel = { ra: o.ra, dec: o.dec }; showCard(Object.assign({}, o, { mapMode: false })); }
      if (window.FX) FX.checkSpot(o.ra, o.dec);
    });
    on("log", () => {
      logCandidate("manual", o.ra, o.dec, { known: S.cat ? knownNear(o.ra, o.dec, yearNow(), 12) : null });
      const b = el.querySelector('[data-act="log"]'); b.textContent = "Logged ✓"; b.disabled = true;
    });
    on("copy", async () => {
      const b = el.querySelector('[data-act="copy"]');
      try { await navigator.clipboard.writeText(dec5); b.textContent = "Copied"; } catch (_) { b.textContent = dec5; }
    });
  }
  // Keep the projection screen's live SPHEREx feed in sync with the main view.
  function updateHoloScreen() {
    const cv = document.getElementById("holoScreen");
    if (!cv || !S.pack) return;
    if (cv.width !== 240) { cv.width = cv.height = 240; }
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000"; g.fillRect(0, 0, 240, 240);
    g.drawImage(off, 0, 0, 240, 240);
    g.strokeStyle = "rgba(94,242,255,.6)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(120, 100); g.lineTo(120, 112); g.moveTo(120, 128); g.lineTo(120, 140); g.moveTo(100, 120); g.lineTo(112, 120); g.moveTo(128, 120); g.lineTo(140, 120); g.stroke();
    const cap = document.getElementById("holoCap");
    if (cap) cap.textContent = S.mode === "diff" ? "DIFFERENCE" : `EPOCH ${S.epoch + 1}/${S.pack.m.epochs.length} · ${S.pack.m.epochs[S.epoch].start}`;
  }
  const metaList = (rows) => `<dl class="meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Markers for every catalogued object (SIMBAD), loaded progressively as you zoom.
  function setLabels() {
    if (!S.aladin) return;
    try {
      if ($("labels").checked && !S.simbadLayer) {
        S.simbadLayer = A.catalogHiPS("https://hipscat.cds.unistra.fr/HiPSCatService/Simbad",
          { name: "SIMBAD", color: "rgba(92,200,232,.75)", sourceSize: 10, shape: "circle", onClick: null });
        S.aladin.addCatalog(S.simbadLayer);
      } else if (S.simbadLayer) {
        $("labels").checked ? S.simbadLayer.show() : S.simbadLayer.hide();
      }
    } catch (e) { console.warn("SIMBAD markers failed", e); }
  }

  // Fallback when Aladin is unavailable: flat canvas in the middle of the screen.
  function drawFallback() {
    $("fallback").hidden = false;
    fbCtx.imageSmoothingEnabled = false;
    fbCtx.fillStyle = "#000"; fbCtx.fillRect(0, 0, fbCanvas.width, fbCanvas.height);
    fbCtx.drawImage(off, 0, 0, fbCanvas.width, fbCanvas.height);
  }

  function predictedPixel(year) {
    const t = S.pack.m.target || {};
    if (!t.pmra_mas_yr && !t.pmdec_mas_yr) return null;
    const ref = t.epoch || SURVEY_YEAR_REF, c = (S.pack.n - 1) / 2, ps = S.pack.m.pixscale_arcsec, dt = year - ref;
    return [c - ((t.pmra_mas_yr / 1000) * dt) / ps, c + ((t.pmdec_mas_yr / 1000) * dt) / ps];
  }
  function epochLabel(e) { const ep = S.pack.m.epochs[e]; return `Epoch ${e + 1}/${S.pack.m.epochs.length} · ${ep.start}${ep.end !== ep.start ? " → " + ep.end : ""}`; }
  function bandLabel(b) {
    if (b === 0) return "All detectors · 0.75–5.0 µm";
    const d = S.pack.m.detectors.find((x) => x.id === b);
    return d ? `Detector ${b} · ${fmt(d.lam_min_um)}–${fmt(d.lam_max_um)} µm` : `Detector ${b}`;
  }

  // ---------------- dock controls ----------------
  function buildEpochButtons() {
    const el = $("epochs"); el.innerHTML = "";
    S.pack.m.epochs.forEach((ep, i) => {
      const b = document.createElement("button"); b.type = "button";
      b.innerHTML = `Epoch ${i + 1}<small>${ep.start.slice(0, 7)}</small>`;
      b.addEventListener("click", () => { stop(); S.epoch = i; render(); updateUrl(); });
      el.appendChild(b);
    });
  }
  function buildBandButtons() {
    const el = $("bands"); el.innerHTML = "";
    const add = (id, label, title) => {
      const b = document.createElement("button"); b.type = "button"; b.dataset.band = id; b.innerHTML = label; b.title = title;
      b.addEventListener("click", () => { S.band = id; S.frame = 0; S.movers = []; $("moversCard").hidden = true; syncBand(); render(); drawCharts(); updateUrl(); });
      el.appendChild(b);
    };
    add(0, "All", "Average of all detectors");
    for (const d of S.pack.m.detectors) add(d.id, `D${d.id}<small>${fmt(d.lam_min_um, 1)}–${fmt(d.lam_max_um, 1)}µm</small>`, bandLabel(d.id));
    syncBand();
  }
  function syncBand() { document.querySelectorAll("#bands button").forEach((b) => b.classList.toggle("on", +b.dataset.band === S.band)); $("bands").style.opacity = S.mode === "rgb" ? 0.45 : 1; }
  function syncModeButtons() { document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode)); syncBand(); }
  function play() {
    if (!S.pack || (S.pack.m.epochs.length < 2 && S.mode !== "frames")) return;
    S.playing = true; $("play").textContent = "❚❚"; $("play").setAttribute("aria-label", "Pause");
    if (S.mode === "diff") { S.mode = "blink"; syncModeButtons(); }
    const tick = () => {
      if (S.mode === "frames") S.frame = (S.frame + 1) % frameList().length;
      else S.epoch = (S.epoch + 1) % S.pack.m.epochs.length;
      render(); S.timer = setTimeout(tick, S.mode === "frames" ? Math.max(80, +$("speed").value / 3) : +$("speed").value);
    };
    S.timer = setTimeout(tick, +$("speed").value);
  }
  function stop() { S.playing = false; clearTimeout(S.timer); $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play"); }

  // ---------------- details drawer ----------------
  function setDrawer(open) { $("drawer").classList.toggle("closed", !open); $("drawerToggle").setAttribute("aria-expanded", String(open)); }
  function fillInfo() {
    const m = S.pack.m, t = m.target || {};
    $("tName").textContent = m.name || S.slug;
    $("tBlurb").textContent = t.blurb || "";
    const flagged = m.frames.reduce((a, f) => a + (f.flagged_frac || 0), 0) / Math.max(1, m.frames.length);
    const flagTotals = {};
    m.frames.forEach((f) => Object.entries(f.flag_counts || {}).forEach(([k, v]) => { flagTotals[k] = (flagTotals[k] || 0) + v; }));
    const rows = [
      ["RA, Dec", `${sexa(m.ra, true)} ${sexa(m.dec, false)}`],
      ["Field", `${fmt(m.fov_arcmin, 1)}′ · ${m.npix}×${m.npix} px @ ${m.pixscale_arcsec}″`],
      ["Epochs", m.epochs.map((e, i) => `${i + 1}: ${e.start} (${e.n_frames} frames)`).join("<br>")],
      ["Frames", `${m.frames.length} SPHEREx images, ${m.detectors.length} detectors`],
      ["Masked", `${fmt(100 * flagged, 1)}% of pixels flagged bad`],
      ["Flags", Object.keys(flagTotals).length ? Object.entries(flagTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") : "none reported"],
    ];
    if (t.pmra_mas_yr || t.pmdec_mas_yr) {
      const tot = Math.hypot(t.pmra_mas_yr, t.pmdec_mas_yr) / 1000;
      rows.push(["Motion", `${fmt(tot, 2)}″/yr ≈ ${fmt(tot / 2 / m.pixscale_arcsec, 2)} px per 6-month survey`]);
    }
    if (m.tracking) {
      const f0 = m.frames[0], f1 = m.frames[m.frames.length - 1];
      rows.splice(1, 0, ["Tracking", `frame follows the object (${m.epochs.length} visits)`]);
      if (f0.geo_dist_au) rows.push(["From Earth", `${fmt(f0.geo_dist_au, 2)} → ${fmt(f1.geo_dist_au, 2)} AU`]);
      if (f0.sun_dist_au) rows.push(["From Sun", `${fmt(f0.sun_dist_au, 2)} → ${fmt(f1.sun_dist_au, 2)} AU`]);
      if (f0.vmag != null) rows.push(["Brightness", `mag ${fmt(f0.vmag, 1)} (predicted)`]);
      rows.push(["Travelled", `${fmt(angDist(f0.obj_ra, f0.obj_dec, f1.obj_ra, f1.obj_dec), 2)}° across the sky in ${fmt(f1.mjd - f0.mjd, 1)} days`]);
    }
    if (t.source) rows.push(["Position", `${t.source}${t.epoch ? `, moved to ${t.epoch}` : ""}`]);
    $("tMeta").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  }

  // ---------------- pixel inspector ----------------
  // 3x3 aperture minus local sky. If the core is masked (a saturated bright star),
  // fall back to the flux in the PSF wings, which still tracks brightness changes.
  function aperture(arr, x, y) {
    const n = S.pack.n; let core = 0, nc = 0, wing = 0, nw = 0; const ring = [];
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const v = arr[yy * n + xx]; if (v !== v) continue;
      const r = Math.hypot(dx, dy);
      if (r <= 1.5) { core += v; nc++; } else if (r <= 3.5) { wing += v; nw++; } else if (r >= 5 && r <= 7) ring.push(v);
    }
    ring.sort((a, b) => a - b);
    const bg = ring.length ? ring[ring.length >> 1] : 0;
    if (nc >= 3) return core / nc - bg;
    return nw ? wing / nw - bg : NaN;
  }
  const frameView = (k) => { const N = S.pack.n * S.pack.n; return S.pack.cube.subarray(k * N, (k + 1) * N); };
  function drawCharts() {
    if (!S.pack) return;
    const m = S.pack.m, c = Math.round((S.pack.n - 1) / 2);
    const p = S.pick || { x: c, y: c, auto: true };
    $("pixLabel").innerHTML = (p.auto ? "Showing the centre pixel. Click inside the SPHEREx frame to pick another." : `Pixel (${p.x}, ${p.y}): 3×3 aperture minus local sky`) +
      (S.cat && !m.tracking ? `<br>${(() => { const [ra, dec] = pixToWorld(p.x, p.y); return describeKnown(knownNear(ra, dec, yearNow(), 12)); })()}` : "");
    const series = m.epochs.map((ep, e) => ({
      name: `Epoch ${e + 1}`, color: EPOCH_COLORS[e % EPOCH_COLORS.length],
      pts: m.frames.map((f, k) => (f.epoch === e && bandMatch(f, S.band) ? [f.wavelength_um, aperture(frameView(k), p.x, p.y)] : null))
        .filter((q) => q && isFinite(q[0]) && isFinite(q[1])).sort((a, b) => a[0] - b[0]),
    }));
    svgChart($("specChart"), series, { xlabel: "Wavelength (µm)", title: "Spectrum (MJy/sr)", line: true });
    if (window.Analysis) {
      try {
        const cls = Analysis.classify(p.x, p.y);
        $("pixClass").innerHTML = `<span class="muted">Spectrum says:</span> <b class="cls">${cls.short}</b> <span class="muted">(${cls.confidence} confidence)</span> <button type="button" class="mini" id="pixReport">Full report</button>`;
        $("pixReport").onclick = () => {
          const D = m.epochs.length > 1 && !m.tracking ? diffSigma(0, m.epochs.length - 1, S.band) : null, v = D ? D[p.y * S.pack.n + p.x] : NaN;
          const kind = v === v && Math.abs(v) >= 5 ? (v > 0 ? "brighter" : "fainter") : "manual";
          Analysis.report({ x: p.x, y: p.y, kind, snr: v === v && kind !== "manual" ? Math.abs(v) : null, cls });
        };
      } catch (e) { console.warn(e); $("pixClass").textContent = ""; }
    }
    const lc = [{ name: "Brightness", color: "#f5a524",
      pts: m.epochs.map((ep, e) => [mjdToYear(ep.mjd_mean), aperture(epochCoaddRaw(e, S.band), p.x, p.y)]).filter((q) => isFinite(q[1])) }];
    svgChart($("lcChart"), lc, { xlabel: "Year", title: `Light curve · ${S.band ? "D" + S.band : "all detectors"}`, line: true, xfmt: (v) => v.toFixed(2) });
  }
  function svgChart(el, series, o) {
    const W = el.clientWidth || 320, H = el.clientHeight || 180, L = 46, R = 22, T = 26, B = 30;
    const all = series.flatMap((s) => s.pts);
    if (!all.length) { el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle">No data at this pixel</text></svg>`; return; }
    let x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
    let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
    if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const py = (y1 - y0) * 0.08; y0 -= py; y1 += py;
    const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B);
    const xf = o.xfmt || ((v) => v.toFixed(1));
    const yf = (v) => (Math.abs(v) >= 100 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(2));
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.title}"><text x="0" y="13" style="font-weight:600;fill:#ece9f4">${o.title}</text>`;
    for (let i = 0; i <= 3; i++) { const yv = y0 + ((y1 - y0) * i) / 3, yy = Y(yv); s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="rgba(140,160,230,.2)"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${yf(yv)}</text>`; }
    const nt = W < 300 ? 2 : 3;
    for (let i = 0; i <= nt; i++) { const xv = x0 + ((x1 - x0) * i) / nt; s += `<text x="${X(xv)}" y="${H - B + 15}" text-anchor="middle">${xf(xv)}</text>`; }
    s += `<text x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle">${o.xlabel}</text>`;
    series.forEach((se, i) => {
      if (o.line && se.pts.length > 1) s += `<polyline fill="none" stroke="${se.color}" stroke-opacity=".55" stroke-width="1.5" points="${se.pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}"/>`;
      s += se.pts.map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3" fill="${se.color}"/>`).join("");
      if (series.length > 1 && series.length <= 4) { const lx = W - R - 64 * (series.length - i); s += `<circle cx="${lx + 6}" cy="${T - 4}" r="4" fill="${se.color}"/><text x="${lx + 13}" y="${T}">${se.name}</text>`; }
    });
    el.innerHTML = s + "</svg>";
  }

  // ---------------- mover finder ----------------
  function findMovers() {
    if (!S.pack || S.pack.m.epochs.length < 2) { banner("Need at least two epochs to look for changes."); return; }
    if (S.pack.m.tracking) { banner("This view follows a moving object, so every background star 'moves'. Use Every frame and watch the stars slide past instead."); setTimeout(() => banner(""), 5000); return; }
    const n = S.pack.n, last = S.pack.m.epochs.length - 1;
    const D = diffSigma(0, last, S.band), med = 0, sigma = 1, peaks = [];
    for (let y = 2; y < n - 2; y++) for (let x = 2; x < n - 2; x++) {
      const v = (D[y * n + x] - med) / sigma;
      if (!(Math.abs(v) >= 6)) continue;
      let isPeak = true;
      for (let dy = -2; dy <= 2 && isPeak; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const w = (D[(y + dy) * n + x + dx] - med) / sigma;
        if (w === w && Math.sign(w) === Math.sign(v) && Math.abs(w) > Math.abs(v)) { isPeak = false; break; }
      }
      if (isPeak) peaks.push({ x, y, snr: v });
    }
    const used = new Set(), found = [];
    const pos = peaks.filter((p) => p.snr > 0).sort((a, b) => b.snr - a.snr), neg = peaks.filter((p) => p.snr < 0).sort((a, b) => a.snr - b.snr);
    for (const p of pos) {
      let best = null, bd = 1e9;
      neg.forEach((q, j) => { if (used.has(j)) return; const d = Math.hypot(p.x - q.x, p.y - q.y); if (d <= 6 && d < bd) { bd = d; best = j; } });
      if (best != null) { used.add(best); const q = neg[best]; found.push({ kind: "moved", x: p.x, y: p.y, from: [q.x, q.y], snr: Math.min(p.snr, -q.snr), dist: bd }); }
      else found.push({ kind: "brighter", x: p.x, y: p.y, snr: p.snr });
    }
    neg.forEach((q, j) => { if (!used.has(j)) found.push({ kind: "fainter", x: q.x, y: q.y, snr: -q.snr }); });
    // Keep only changes that are a big fraction of the source's own brightness. Small
    // fractional changes around bright stars are PSF differences between epochs, not motion.
    const A = epochCoaddRaw(0, S.band), B = epochCoaddRaw(last, S.band), noise = mad(A).sigma;
    for (const f of found) {
      const a = aperture(A, f.x, f.y), b = aperture(B, f.x, f.y), peak = Math.max(Math.abs(a), Math.abs(b));
      // fraction of the source's own brightness that changed; faint blips count as noise
      // (validated by injection tests: a hard "peak > 5 noise" gate threw away real faint movers)
      f.frac = Math.abs(b - a) / Math.max(peak, 1.5 * noise);
    }
    const kept = found.filter((f) => f.frac >= 0.15);
    found.length = 0; found.push(...kept);
    found.sort((a, b) => (b.kind === "moved") - (a.kind === "moved") || b.snr - a.snr);
    S.movers = found.slice(0, 12);
    // "Is this new?" Compare each change with Gaia DR3 + CatWISE at the matching dates.
    const m = S.pack.m, yFirst = mjdToYear(m.epochs[0].mjd_mean), yLast = mjdToYear(m.epochs[last].mjd_mean);
    for (const f of S.movers) {
      const [ra, dec] = pixToWorld(f.x, f.y);
      f.ra = ra; f.dec = dec;
      // a source that faded was where something used to be, so check the first epoch
      f.known = knownNear(ra, dec, f.kind === "fainter" ? yFirst : yLast);
      if (!f.known && f.from) { const [r0, d0] = pixToWorld(f.from[0], f.from[1]); f.known = knownNear(r0, d0, yFirst); }
      f.checked = !!S.cat;
      if (window.Analysis) {
        const pos = f.from && f.kind === "moved" ? (e) => { const t = last ? e / last : 1; return [f.from[0] + (f.x - f.from[0]) * t, f.from[1] + (f.y - f.from[1]) * t]; } : null;
        try { f.vet = Analysis.vet(f); f.cls = Analysis.classify(f.x, f.y, pos ? { pos } : {}); } catch (e) { console.warn("analysis failed", e); }
      }
    }
    if (window.FX && S.movers.some((f) => f.kind === "moved") && !S.pack.m.synthetic) FX.event("mover");
    const list = $("moversList"); list.innerHTML = "";
    if (!S.movers.length) list.innerHTML = "<li>No significant changes in this band.</li>";
    S.movers.forEach((mv) => {
      const li = document.createElement("li"), ps = S.pack.m.pixscale_arcsec;
      const what = mv.kind === "moved" ? `Moved ~${fmt(mv.dist * ps, 0)}″ (${fmt(mv.snr, 0)}σ)` : `Got ${mv.kind} by ${fmt(100 * mv.frac, 0)}% (${fmt(mv.snr, 0)}σ)`;
      li.innerHTML = `<span class="what">${what}</span> <span class="muted small">${sexa(mv.ra, true)} ${sexa(mv.dec, false)}</span><br>` +
        (mv.checked ? describeKnown(mv.known) : `<span class="muted small">no catalogue for this field</span>`) +
        (mv.vet ? `<br><span class="vet ${mv.vet.score >= 70 ? "ok" : mv.vet.score >= 45 ? "mid" : "bad"}" title="${mv.vet.tests.map((t) => `${t.name}: ${t.status}`).join("\n")}">VET ${mv.vet.score}/100 · ${mv.vet.verdict}</span>` : "") +
        (mv.cls ? ` <span class="cls">${mv.cls.short}</span>` : "") +
        `<br><button type="button" class="mini" data-log>Log</button> <button type="button" class="mini" data-report>Report</button>`;
      li.addEventListener("click", (e) => { if (e.target.closest("[data-log],[data-report]")) return; S.pick = { x: mv.x, y: mv.y }; drawCharts(); });
      li.querySelector("[data-report]").addEventListener("click", () => { if (window.Analysis) Analysis.report(mv); });
      li.querySelector("[data-log]").addEventListener("click", (e) => {
        logCandidate(mv.kind, mv.ra, mv.dec, { snr: mv.snr, frac: mv.frac, known: mv.known, vet: mv.vet, cls: mv.cls, x: mv.x, y: mv.y });
        e.target.textContent = "Logged ✓"; e.target.disabled = true;
      });
      list.appendChild(li);
    });
    const nNew = S.movers.filter((f) => f.checked && !f.known).length;
    $("moversNote").textContent = !S.cat || !S.movers.length ? "" : nNew
      ? `${nNew} change${nNew > 1 ? "s" : ""} with no match in Gaia or CatWISE. Most will be artefacts (bright-star glare, cosmic rays), but a real new object would look exactly like this. Log it and check it in every detector.`
      : "Everything that changed matches a catalogued star. Nothing new here, which is what we expect for most of the sky.";
    $("moversCard").hidden = false; setDrawer(true);
  }

  function logCandidate(kind, ra, dec, extra = {}) {
    if (!window.FX) return;
    FX.logCandidate({
      target: S.pack ? S.pack.m.name : "", slug: S.slug, kind, ra: +fmt(ra, 6), dec: +fmt(dec, 6),
      band: S.band ? `D${S.band}` : "all", significance: extra.snr != null ? +fmt(extra.snr, 1) : null,
      change_pct: extra.frac != null ? Math.round(100 * extra.frac) : null,
      catalogue_match: extra.known ? `${extra.known.src.id} (${fmt(extra.known.sep, 1)}")` : (S.cat ? "none" : "not checked"),
      epochs: S.pack ? S.pack.m.epochs.map((e) => e.start).join(" / ") : "",
      classification: extra.cls ? extra.cls.short : "", vet_score: extra.vet ? extra.vet.score : null, verdict: extra.vet ? extra.vet.verdict : "",
      link: window.Analysis && S.pack && extra.x != null ? Analysis.deepLink(S.slug, S.band, extra.x, extra.y) : "",
    });
  }

  // ---------------- navigation ----------------
  function updateUrl() {
    if (!S.pack) return;
    const p = new URLSearchParams(location.search);
    ["ra", "dec", "fov"].forEach((k) => p.delete(k));
    p.set("target", S.slug); p.set("mode", S.mode); p.set("band", S.band); p.set("epoch", S.epoch);
    history.replaceState(null, "", `${location.pathname}?${p}`);
  }
  async function goTo(ra, dec, fovArcmin, label) {
    // reuse an existing scan of the same place, but only if it is at least as big as asked for
    const near = S.index.find((p) => angDist(p.ra, p.dec, ra, dec) * 60 < p.fov_arcmin / 3 && p.fov_arcmin >= fovArcmin * 0.9);
    if (near) return openPack(near.slug, { fly: true });
    if (S.aladin) await flyTo(ra, dec, Math.max(fovArcmin / 60 * 1.9, 0.03));
    if (!(await wakeApi())) {
      banner(`${label || `${fmt(ra, 4)}, ${fmt(dec, 4)}`} hasn't been scanned yet. The sky map, catalogues and SIMBAD work here, ` +
        `but fetching new SPHEREx images needs our scan server, which isn't running on this public site yet. ` +
        `Try a built-in target above, or the fresh fields in Spot the Wanderer.`);
      console.info(`[Wanderer] to scan this spot yourself: python pipeline/build_cache.py --ra ${fmt(ra, 5)} --dec ${fmt(dec, 5)} --fov ${fovArcmin}`);
      return;
    }
    toast("Contacting NASA IRSA for SPHEREx images…");
    let r;
    try { r = await fetch(`${API}/api/build`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ra, dec, fov: fovArcmin, name: label || null }) }); }
    catch (e) { toast(""); banner(`Scan server unreachable: ${e.message}`); return; }
    if (!r.ok) { toast(""); let msg = await r.text(); try { msg = JSON.parse(msg).detail || msg; } catch (_) { /* text */ } banner(r.status === 429 ? msg : `Server error: ${msg}`); return; }
    const { slug } = await r.json();
    const t0 = Date.now();
    for (;;) {
      await new Promise((res) => setTimeout(res, 2500));
      let st;
      try { st = await (await fetch(`${API}/api/status/${slug}`, { cache: "no-store" })).json(); } catch (_) { continue; }
      if (st.state === "done") {
        toast("");
        if (!S.index.some((p) => p.slug === slug)) S.index.push({ slug, name: label || `RA ${fmt(ra, 4)}, Dec ${fmt(dec, 4)}`, ra, dec, fov_arcmin: fovArcmin, live: true });
        if (window.FX) FX.event("scan");
        return openPack(slug, { fly: false });
      }
      if (st.state === "error") { toast(""); banner(`Could not build images: ${st.message}`); return; }
      const secs = Math.round((Date.now() - t0) / 1000);
      toast(st.state === "queued" ? `In the scan queue: you are #${st.position || 1}. Other explorers are scanning right now… ${secs} s`
        : `Scanning with SPHEREx data… ${st.message || ""} · ${secs} s`);
    }
  }
  // Pick a random patch of sky that nobody in this app has looked at yet.
  function unchartedSector() {
    for (let i = 0; i < 50; i++) {
      const ra = Math.random() * 360, dec = (Math.asin(2 * Math.random() - 1) * 180) / Math.PI; // uniform on the sphere
      if (S.index.every((p) => angDist(p.ra, p.dec, ra, dec) > 1)) return [ra, dec];
    }
    return [Math.random() * 360, 0];
  }

  // ---------------- events ----------------
  $("search").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = $("q").value.trim(); if (!q) return;
    const fov = +$("fov").value; banner("");
    if (window.FX && FX.searchEgg(q)) return;
    setView("sky");
    const key = q.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = S.index.find((p) => p.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(key) || p.slug === q.toLowerCase());
    if (hit) return openPack(hit.slug, { fly: true });
    try {
      const c = parseCoords(q);
      if (c) return await goTo(c.ra, c.dec, fov);
      toast(`Looking up "${q}"…`);
      const r = await resolveName(q); toast("");
      await goTo(r.ra, r.dec, fov, q);
    } catch (e) { toast(""); banner(String(e.message || e)); }
  });
  $("uncharted").addEventListener("click", () => {
    const [ra, dec] = unchartedSector(); setView("sky");
    const id = `${String(Math.floor(ra / 15)).padStart(2, "0")}h${dec >= 0 ? "+" : "−"}${String(Math.abs(Math.round(dec))).padStart(2, "0")}`;
    goTo(+ra.toFixed(5), +dec.toFixed(5), +$("fov").value, `Uncharted sector ${id}`);
  });
  // Changing the field size re-scans the current target at the new size (needs the scan server).
  $("fov").addEventListener("change", async () => {
    const want = +$("fov").value;
    if (!S.pack || S.pack.m.tracking) { toast(`Field size set to ${want}′ for your next scan.`); setTimeout(() => toast(""), 3000); return; }
    const m = S.pack.m;
    if (Math.abs(m.fov_arcmin - want) < 0.5) return;
    if (!(await wakeApi())) {
      banner(`Field size ${want}′ applies to new scans. ${m.name} was prepared at ${fmt(m.fov_arcmin, 0)}′; ` +
        `to rescan it bigger, start the live server (python -m uvicorn server:app --port 8000) and pick the size again.`);
      return;
    }
    banner("");
    const c = packCentre();
    goTo(c[0], c[1], want, `${m.name} (${want}′)`);
  });
  $("lookHere").addEventListener("click", () => { const [ra, dec] = S.aladin.getRaDec(); goTo(ra, dec, +$("fov").value); });
  $("play").addEventListener("click", () => (S.playing ? stop() : play()));
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { stop(); S.mode = b.dataset.mode; syncModeButtons(); render(); updateUrl(); }));
  ["contrast", "bright"].forEach((id) => $(id).addEventListener("input", render));
  $("movers").addEventListener("click", findMovers);
  $("timeline").addEventListener("input", () => {
    if (!S.pack) return; stop();
    if (S.mode === "frames") S.frame = +$("timeline").value; else S.epoch = +$("timeline").value;
    render(); updateUrl();
  });
  $("smooth").addEventListener("change", () => { S.smooth = $("smooth").checked; S.movers = []; render(); });
  $("gaia").addEventListener("change", setGaia);
  $("labels").addEventListener("change", setLabels);
  $("drawerToggle").addEventListener("click", () => setDrawer($("drawer").classList.contains("closed")));
  $("share").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); $("share").textContent = "Copied!"; } catch (_) { $("share").textContent = "Copy failed"; }
    setTimeout(() => ($("share").textContent = "Copy link"), 1500);
  });
  document.querySelectorAll("[data-survey]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-survey]").forEach((x) => x.classList.toggle("on", x === b));
    S.survey = b.dataset.survey;
    if (S.aladin) { try { S.aladin.setBaseImageLayer(S.survey); } catch (e) { console.warn(e); } }
  }));
  $("view").addEventListener("click", (ev) => {
    if (!S.pack) return;
    const r = ev.target.getBoundingClientRect(), n = S.pack.n;
    S.pick = { x: Math.floor(((ev.clientX - r.left) / r.width) * n), y: n - 1 - Math.floor(((ev.clientY - r.top) / r.height) * n) };
    drawCharts();
  });
  document.addEventListener("keydown", (ev) => {
    if (!S.pack || ev.target.closest("input, select, textarea")) return;
    if (ev.key === " ") { ev.preventDefault(); S.playing ? stop() : play(); }
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      stop(); const ne = S.pack.m.epochs.length;
      S.epoch = (S.epoch + (ev.key === "ArrowRight" ? 1 : ne - 1)) % ne; render(); updateUrl();
    }
  });
  window.addEventListener("resize", () => { sizeOverlay(); if (S.pack) drawCharts(); });

  // ---------------- views: starmap <-> sky ----------------
  function setView(v) {
    const b = document.body;
    b.classList.remove("mode-map", "mode-sky");
    b.classList.add(v === "map" ? "mode-map" : "mode-sky");
    document.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("on", x.dataset.view === v));
    if (v === "sky") { sizeOverlay(); window.dispatchEvent(new Event("resize")); }
    else stop();
    $("starCard").hidden = true; document.body.classList.remove("card-open");
  }
  document.querySelectorAll("[data-view]").forEach((x) => x.addEventListener("click", () => setView(x.dataset.view)));
  window.addEventListener("wanderer:mapselect", (e) => {
    const d = e.detail;
    showCard(Object.assign({}, d, { mapMode: true, name: d.sol ? "Sol (the Sun)" : d.name, ra: d.sol ? null : d.ra, dec: d.sol ? null : d.dec, dist: d.sol ? null : d.dist }));
    if (!d.sol && window.FX && d.ra != null) FX.checkSpot(d.ra, d.dec);
    if (d.sol && window.FX) FX.transmit("HOME", "You are here. Light from the Sun takes 8 minutes to reach Earth; from the nearest other star, 4.2 years.", "Not fiction.");
  });

  // On phones the header wraps onto several rows; keep the chips and banners just below it.
  const syncTop = () => { const h = document.querySelector("header.top"); if (h) document.documentElement.style.setProperty("--top-h", `${Math.round(h.getBoundingClientRect().bottom)}px`); };
  addEventListener("resize", syncTop); syncTop(); setTimeout(syncTop, 600);

  // Shared with analysis.js (vetting, spectral classification, reports).
  window.WandererCore = { S, epochCoaddRaw, diffSigma, pixToWorld, knownNear, yearNow, mjdToYear, sexa, findMovers, mad };

  // ---------------- boot ----------------
  (async () => {
    const p = new URLSearchParams(location.search);
    const deepLink = p.get("target") || (p.get("ra") && p.get("dec"));
    if (p.get("embed") === "1") document.body.classList.add("embed");
    if (isNarrow()) setDrawer(false);
    $("dock").classList.add("disabled");
    // The sky must have its real size while Aladin initialises, so start in sky mode.
    document.body.classList.add("mode-sky");
    sizeOverlay();
    const skyOk = await initSky();
    requestAnimationFrame(frameLoop);
    await loadIndex();
    const opts = { band: p.get("band"), mode: p.get("mode"), epoch: p.get("epoch") };
    if (deepLink) {
      document.body.classList.remove("mode-boot");
      setView("sky");
      if (p.get("target")) {
        await openPack(p.get("target"), Object.assign(opts, { fly: skyOk }));
        if (S.pack && p.get("px") != null) { S.pick = { x: Math.round(+p.get("px")), y: Math.round(+p.get("py")) }; stop(); drawCharts(); }
      }
      else await goTo(+p.get("ra"), +p.get("dec"), +(p.get("fov") || 4));
      return;
    }
    const startMap = () => {
      if (researchMode()) return setView("sky"); // research mode opens straight on the sky
      if (window.Starmap) return setView("map");
      let done = false;
      const go = (ok) => { if (done) return; done = true; setView(ok && window.Starmap ? "map" : "sky"); };
      window.addEventListener("wanderer:starmap-ready", () => go(true), { once: true });
      setTimeout(() => go(!!window.Starmap), 4000);
    };
    if (window.FX) FX.boot(startMap); else { document.body.classList.remove("mode-boot"); startMap(); }
  })();
})();
