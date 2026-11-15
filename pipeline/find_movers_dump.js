// Run the site's own "Find movers" (+ vetting + classifier) on wide packs, headless,
// so the computer's answers can be revealed in Spot the Wanderer.
//
//   node pipeline/find_movers_dump.js http://localhost:8765 out.json wide_a wide_b ...
//
// Needs the web/ folder served at the given URL and `npm i playwright` + a Chromium.
const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const [base, outPath, ...slugs] = process.argv.slice(2);
  if (!base || !outPath || !slugs.length) { console.error("usage: base out.json slug..."); process.exit(2); }
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.route(/cds\.unistra\.fr|alasky|simbad/, (r) => r.fulfill({ status: 404, body: "" })); // sky tiles not needed
  const out = {};
  for (const s of slugs) {
    await p.goto(`${base}/explore.html?target=${s}&band=0&research=1`);
    try {
      await p.waitForFunction(() => window.WandererCore && WandererCore.S.pack && WandererCore.S.cat, null, { timeout: 60000 });
    } catch (_) { await p.waitForTimeout(3000); }
    out[s] = await p.evaluate(() => {
      const K = WandererCore; K.findMovers();
      return K.S.movers.map((m) => ({
        kind: m.kind, x: m.x, y: m.y, from: m.from || null, snr: +m.snr.toFixed(1),
        known: m.known ? m.known.src.id : null,
        pm: m.known ? Math.hypot(m.known.src.pmra || 0, m.known.src.pmdec || 0) : null,
        vet: m.vet ? m.vet.score : null, cls: m.cls ? m.cls.short : null,
      }));
    });
    console.log(s, out[s].length, "candidates");
  }
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  await b.close();
})();
