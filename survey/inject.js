// Runs inside the Wanderer page. Injection-recovery test for Find movers.
window.__inject = (opts) => {
  const K = WandererCore, S = K.S, { m, cube, n } = S.pack, N = n * n, last = m.epochs.length - 1;
  const SIG = 1.0, rng = (() => { let s = opts.seed || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const t0 = m.epochs[0].mjd_mean, t1 = m.epochs[last].mjd_mean;
  // single-frame pixel noise per detector
  const noise = {};
  for (const d of m.detectors) { const v = []; m.frames.forEach((f, k) => { if (f.detector === d.id) v.push(K.mad(cube.subarray(k * N, (k + 1) * N)).sigma); }); v.sort((a, b) => a - b); noise[d.id] = v[v.length >> 1]; }
  const ref = K.epochCoaddRaw(0, 0), refMad = K.mad(ref);
  const results = [];
  for (const amp of opts.amps) for (const dpx of opts.moves) for (let trial = 0; trial < opts.trials; trial++) {
    // pick an empty spot: away from edges and from anything bright
    let x0, y0, tries = 0;
    do { x0 = 8 + rng() * (n - 16); y0 = 8 + rng() * (n - 16); tries++; }
    while (tries < 200 && Math.abs(ref[Math.round(y0) * n + Math.round(x0)] - refMad.med) > 3 * refMad.sigma);
    const ang = rng() * 2 * Math.PI, vx = Math.cos(ang) * dpx, vy = Math.sin(ang) * dpx;
    const saved = new Map();
    m.frames.forEach((f, k) => {
      const t = (f.mjd - t0) / Math.max(1e-6, t1 - t0), cx = x0 + vx * t, cy = y0 + vy * t, A = amp * noise[f.detector];
      for (let yy = Math.floor(cy - 4); yy <= Math.ceil(cy + 4); yy++) for (let xx = Math.floor(cx - 4); xx <= Math.ceil(cx + 4); xx++) {
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const i = k * N + yy * n + xx, v = cube[i]; if (!(v === v)) continue;
        if (!saved.has(i)) saved.set(i, v);
        cube[i] = v + A * Math.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * SIG * SIG));
      }
    });
    S.coadds.clear(); S.stretch.clear(); if (window.Analysis) Analysis.reset();
    K.findMovers();
    const ex = x0 + vx, ey = y0 + vy;
    let best = null;
    for (const mv of S.movers) { const d = Math.hypot(mv.x - ex, mv.y - ey), d0 = Math.hypot(mv.x - x0, mv.y - y0); if (Math.min(d, d0) <= 2 && (!best || mv.snr > best.snr)) best = mv; }
    results.push({ amp, dpx, found: !!best, kind: best ? best.kind : null, vet: best && best.vet ? best.vet.score : null, isNew: best ? !best.known : null });
    for (const [i, v] of saved) cube[i] = v;
  }
  S.coadds.clear(); S.stretch.clear(); if (window.Analysis) Analysis.reset();
  return { results, dtYr: (t1 - t0) / 365.25, pixscale: m.pixscale_arcsec, noise };
};
