/* Spot the Wanderer v2: scan a whole 20′ SPHEREx field, mark what moved or changed,
 * then see how you did against planted practice movers, the computer and star catalogues. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("spot2:" + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem("spot2:" + k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
  };
  const reduced = matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BASE = "data/fields/", MATCH = 3.5; // px (≈ 21″)

  let fields = [], queue = [], cur = null, view = "blink", blinkOn = 0, timer = null, marks = [], done = false;
  let answers = store.get("answers", []);
  let z = 1, tx = 0, ty = 0;

  // ---------------- queue ----------------
  function buildQueue() {
    const seen = new Set(answers.map((a) => a.id));
    queue = fields.filter((f) => !seen.has(f.id));
    // first visit: Barnard's Star (a famous real mover to learn from); then the newest sky first
    const first = answers.length === 0;
    const rank = (f) => (first && f.slug === "wide_barnard" ? 2 : 0) + (isNew(f) ? 1 : 0);
    queue.sort((a, b) => rank(b) - rank(a) || (b.added || "").localeCompare(a.added || "") || Math.random() - 0.5);
  }

  // fields added by the weekly GitHub Actions job (fresh SPHEREx Quick Release 3 images)
  const isNew = (f) => f.weekly && f.added && (Date.now() - Date.parse(f.added)) < 9 * 864e5;

  // ---------------- countdown to the next weekly drop ----------------
  // .github/workflows/weekly.yml runs Mondays 20:23 UTC; building + publishing takes ~10 min
  // (GitHub can start scheduled jobs a little late, so this is "about").
  function nextDrop(now = new Date()) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 35));
    d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7));
    if (d <= now) d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  const pad = (n) => String(n).padStart(2, "0");
  function tick() {
    const t = nextDrop(), s = Math.max(0, Math.round((t - Date.now()) / 1000));
    const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const long = `${dd}d ${pad(hh)}:${pad(mm)}:${pad(ss)}`, short = dd ? `${dd}d ${hh}h ${pad(mm)}m` : `${hh}h ${pad(mm)}m ${pad(ss)}s`;
    const when = "about " + t.toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" }) + " your time";
    document.querySelectorAll("[data-cd]").forEach((el) => { el.textContent = el.dataset.cd === "long" ? long : el.dataset.cd === "when" ? when : short; });
    const n = $("nextDrop"); if (n) n.title = `Next batch of fresh SPHEREx sky: ${when}`;
  }
  tick(); setInterval(tick, 1000);

  // ---------------- picture + zoom ----------------
  function show(v) {
    view = v; clearInterval(timer);
    document.querySelectorAll(".view-seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    const put = (t) => {
      $("img").src = `${BASE}${cur.id}_${t}.png`;
      $("which").textContent = t === "a" ? `Picture 1 · ${cur.dates[0]}` : t === "b" ? `Picture 2 · ${cur.dates[1]}` : "Difference · orange = brighter now · blue = fainter now";
    };
    if (v === "blink") { put(blinkOn ? "b" : "a"); timer = setInterval(() => { blinkOn ^= 1; put(blinkOn ? "b" : "a"); }, reduced ? 1400 : 650); }
    else put(v);
  }
  function applyZoom() {
    const W = $("stage").clientWidth;
    const lim = (W * (z - 1));
    tx = Math.min(0, Math.max(-lim, tx)); ty = Math.min(0, Math.max(-lim, ty));
    $("layer").style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    $("marks").style.setProperty("--inv", 1 / z);
  }
  function zoomAt(f, cx, cy) {
    const nz = Math.min(8, Math.max(1, z * f)); if (nz === z) return;
    tx = cx - ((cx - tx) * nz) / z; ty = cy - ((cy - ty) * nz) / z; z = nz; applyZoom();
  }
  // page zoom (CSS `zoom` on laptops, see classify.css): screen px -> layout px
  const kz = () => { const el = $("stage"), r = el.getBoundingClientRect(); return el.offsetWidth ? r.width / el.offsetWidth : 1; };
  function stagePoint(e) { const r = $("stage").getBoundingClientRect(), k = kz(); return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]; }
  function toPix(e) { // screen -> field pixel (x grows west/left as drawn, y grows north = up)
    const [sx, sy] = stagePoint(e), W = $("stage").clientWidth, n = cur.npix;
    const u = (sx - tx) / (W * z), v = (sy - ty) / (W * z);
    return [u * n - 0.5, n - v * n - 0.5];
  }
  const pct = (x, y) => [`${((x + 0.5) / cur.npix) * 100}%`, `${((cur.npix - y - 0.5) / cur.npix) * 100}%`];

  // ---------------- marking ----------------
  function drawMarks(extra = "") {
    $("marks").innerHTML = marks.map((m, i) => { const [l, t] = pct(m.x, m.y); return `<i class="mk user" data-i="${i}" style="left:${l};top:${t}"></i>`; }).join("") + extra;
    $("count").textContent = marks.length ? `${marks.length} mark${marks.length > 1 ? "s" : ""}. Click Done when you've scanned the whole field.` : "No marks yet.";
  }
  let down = null;
  $("stage").addEventListener("pointerdown", (e) => { if (e.target.closest(".zoom")) return; down = { x: e.clientX, y: e.clientY, tx, ty, moved: false }; $("stage").setPointerCapture(e.pointerId); });
  $("stage").addEventListener("pointermove", (e) => {
    if (!down) return;
    const k = kz(), dx = (e.clientX - down.x) / k, dy = (e.clientY - down.y) / k;
    if (Math.hypot(dx, dy) > 5) down.moved = true;
    if (down.moved && z > 1) { tx = down.tx + dx; ty = down.ty + dy; applyZoom(); }
  });
  $("stage").addEventListener("pointerup", (e) => {
    const d = down; down = null; if (!d || d.moved || done || !cur) return;
    const hit = e.target.closest(".mk.user");
    if (hit) { marks.splice(+hit.dataset.i, 1); drawMarks(); return; }
    const [x, y] = toPix(e); if (x < 0 || y < 0 || x >= cur.npix || y >= cur.npix) return;
    marks.push({ x: +x.toFixed(1), y: +y.toFixed(1) }); drawMarks();
  });
  $("stage").addEventListener("wheel", (e) => { e.preventDefault(); const [cx, cy] = stagePoint(e); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, cx, cy); }, { passive: false });
  $("zin").onclick = () => { const W = $("stage").clientWidth; zoomAt(1.5, W / 2, W / 2); };
  $("zout").onclick = () => { const W = $("stage").clientWidth; zoomAt(1 / 1.5, W / 2, W / 2); };
  $("zfit").onclick = () => { z = 1; tx = ty = 0; applyZoom(); };

  // ---------------- load / finish ----------------
  function load() {
    done = false; marks = []; z = 1; tx = ty = 0; applyZoom();
    $("feedback").hidden = true; $("done").textContent = "Done"; $("none").hidden = false; $("done").disabled = false;
    cur = queue.shift();
    if (!cur) { finished(); return; }
    for (const t of "abd") { const im = new Image(); im.src = `${BASE}${cur.id}_${t}.png`; }
    $("num").textContent = `#${answers.length + 1} · ${cur.fov_arcmin}′ × ${cur.fov_arcmin}′`;
    $("newBadge").hidden = !cur.weekly;
    $("newBadge").textContent = isNew(cur) ? "NEW THIS WEEK" : "FRESH SKY";
    $("newBadge").title = cur.weekly ? `Added automatically on ${cur.added} from SPHEREx ${cur.release || "QR3"} images. Nobody has looked at this patch in Wanderer before.` : "";
    $("caption").textContent = cur.weekly
      ? `Brand-new SPHEREx sky: picture 1 from ${cur.dates[0]}, picture 2 from ${cur.dates[1]} (from SPHEREx Quick Release 3, NASA's newest weekly data). ${cur.fov_arcmin}′ across, about two-thirds of a full Moon. North is up. You may be the first person to look for movers here.`
      : `${cur.name}: two SPHEREx pictures of the same ${cur.fov_arcmin}′ patch of sky (about two-thirds of a full Moon), taken months apart. North is up.`;
    drawMarks(); show("blink"); stats();
  }
  function finished() {
    clearInterval(timer);
    $("newBadge").hidden = true; $("num").textContent = "";
    $("feedback").hidden = false; $("feedback").className = "feedback neutral done-all";
    $("feedback").innerHTML = `<h3>Done scanning all pictures available?</h3>
      <p>You've scanned all ${answers.length} fields. Thank you!</p>
      <div class="drop-big" role="timer" aria-live="off"><span>New SPHEREx images will come in</span><b data-cd="long">…</b><small data-cd="when"></small></div>
      <p>Every week NASA releases new SPHEREx pictures (Quick Release 3) and our robot turns the freshest sky into new fields here, automatically. Meanwhile, explore the sky or start over.</p>
      <div class="row"><a class="primary" href="explore.html">Explore the sky ›</a><button type="button" id="again">Start over</button></div>`;
    tick();
    $("again").onclick = () => { answers = []; store.set("answers", answers); buildQueue(); load(); };
    $("done").disabled = true; $("none").hidden = true;
  }

  // ---------------- scoring ----------------
  const near = (a, list) => list.some((b) => Math.hypot(a.x - b.x, a.y - b.y) <= MATCH);
  function submit(nothing) {
    if (done) { load(); return; }
    if (nothing) marks = [];
    done = true;
    const sims = cur.sims, comp = cur.computer, known = cur.known;
    const foundSims = sims.filter((s) => near(s, marks)).length;
    const foundKnown = known.filter((k) => near(k, marks)).length;
    const compReal = comp.filter((c) => (c.vet || 0) >= 45 && !c.known);
    const extra = marks.filter((m) => !near(m, sims) && !near(m, comp) && !near(m, known));
    answers.push({ id: cur.id, t: new Date().toISOString(), marks, sims: sims.length, foundSims, known: known.length, foundKnown, extra: extra.length });
    store.set("answers", answers);
    send(marks.map((m) => ({ ...m, ...radec(cur, m), match: near(m, sims) ? "sim" : near(m, known) ? "known" : near(m, comp) ? "computer" : "none" })),
      { foundSims, sims: sims.length, foundKnown, extra: extra.length });

    // reveal on the picture
    const ring = (o, cls, title) => { const [l, t] = pct(o.x, o.y); return `<i class="mk ${cls}" style="left:${l};top:${t}" title="${esc(title)}"></i>`; };
    drawMarks(sims.map((s) => ring(s, "sim", "Practice mover: a fake moving star we planted")).join("") +
      // only draw computer finds that survived vetting; the rest are explained artefacts
      comp.filter((c) => (c.vet || 0) >= 45).map((c) => ring(c, "comp", `Computer: ${c.kind}${c.known ? ` (known: ${c.known})` : ""} · VET ${c.vet}`)).join("") +
      known.map((k) => ring(k, "known", `Known fast star ${k.id} (${k.pm}″/yr)`)).join(""));

    const lines = [];
    lines.push(`<b>Practice movers</b> (fake moving stars we planted): you found <b>${foundSims}/${sims.length}</b> <span class="key sim"></span>`);
    if (known.length) lines.push(`<b>Known fast stars</b> in this field: ${known.map((k) => `${esc(k.id)} (${k.pm}″/yr)`).join(", ")}. You marked <b>${foundKnown}/${known.length}</b> <span class="key known"></span>`);
    const kept = comp.filter((c) => (c.vet || 0) >= 45), dropped = comp.length - kept.length;
    const kn = kept.filter((c) => c.known).length;
    lines.push(`<b>Our computer also searched this field.</b> ${kept.length
      ? `It found <b>${kept.length}</b> real-looking change${kept.length === 1 ? "" : "s"} <span class="key comp"></span>${kn ? `: ${kn} on stars already known to move` : ""}${compReal.length ? `${kn ? "," : ":"} <b>${compReal.length} nobody has explained yet</b>` : ""}.`
      : "It found nothing real here."}${dropped ? ` It also caught ${dropped} blip${dropped === 1 ? "" : "s"} that turned out to be camera glitches (the two pictures not lining up perfectly, or glare around bright stars), so ${dropped === 1 ? "it isn't" : "they aren't"} shown.` : ""}`);
    const score = sims.length ? foundSims / sims.length : 1;
    $("feedback").hidden = false;
    $("feedback").className = `feedback ${score >= 0.99 ? "right" : score > 0 ? "neutral" : "wrong"}`;
    $("feedback").innerHTML = `<h3>${score >= 0.99 ? "SHARP EYES" : score > 0 ? "NICE SCANNING" : "TRICKY ONE"}</h3><ul class="res">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>
      ${extra.length ? `<p><b>${extra.length} of your marks</b> match nothing the computer or catalogues know about. Most will be noise, but this is where human eyes find things computers miss. <b>Look closer</b> to vet one with the full tools (and report it from there if it holds up):</p>
        <div class="row">${extra.slice(0, 4).map((m, i) => `<a href="${esc(deep(m))}" target="_blank" rel="noopener">Look closer #${i + 1} ›</a>`).join("")}</div>
        <p>Think one is real? <b>Tell the team</b>: we get the exact positions and check them.</p>
        <div class="row"><a class="primary" href="${esc(reportMail(extra))}">✉ Tell the team</a></div>` : ""}
      <p class="muted">Zoom in to see the circles: <span class="key sim"></span> practice mover (planted by us) · <span class="key comp"></span> computer · <span class="key known"></span> known fast star · <span class="key user"></span> you.</p>`;
    requestAnimationFrame(() => $("feedback").scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }));
    $("done").textContent = "Next field ›"; $("none").hidden = true; $("done").focus();
    stats();
  }

  function deep(m) {
    const u = new URL("explore.html", location.href);
    u.search = new URLSearchParams({ target: cur.slug, mode: "diff", band: "0", px: String(Math.round(m.x)), py: String(Math.round(m.y)) }).toString();
    return u.toString();
  }

  // ---------------- straight to the team database (Google Apps Script → Sheet) ----------------
  const session = (() => { let id = store.get("session", null); if (!id) { id = Math.random().toString(36).slice(2, 10); store.set("session", id); } return id; })();
  let lastSend = 0;
  function send(marks, score) {
    const url = window.WANDERER_SUBMIT; if (!url) return;
    if (Date.now() - lastSend < 4000) return; // nobody scans a field in under 4 s
    lastSend = Date.now();
    const credit = String(store.get("creditName", "") || "").trim().slice(0, 40);
    const body = JSON.stringify({ app: "wanderer", v: 2, session, field: cur.id, slug: cur.slug, marks: marks.slice(0, 50), ...score, credit, ua: navigator.userAgent.slice(0, 120) });
    // text/plain + no-cors: Apps Script accepts it without a CORS pre-flight (the reply is unreadable, that's fine)
    fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body }).catch(() => { /* offline: still saved locally */ });
  }

  // ---------------- talk to the team (e-mail) ----------------
  const TEAM = "astro3club@gmail.com";
  const radec = (f, m) => { const c = (f.npix - 1) / 2; return { ra: +(f.ra + ((c - m.x) * f.pixscale) / 3600 / Math.cos((f.dec * Math.PI) / 180)).toFixed(6), dec: +(f.dec + ((m.y - c) * f.pixscale) / 3600).toFixed(6) }; };
  function mailto(subject, body) { return `mailto:${TEAM}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; }
  function reportMail(extra) {
    const lines = extra.slice(0, 10).map((m, i) => { const c = radec(cur, m); return `#${i + 1}  RA ${c.ra}  Dec ${c.dec}\n    ${deep(m)}`; });
    return mailto(`Spot the Wanderer: something in field ${cur.id}`,
      `Hi astro3club team,\n\nIn field "${cur.id}" (${cur.name || cur.slug}) I marked ${extra.length} spot(s) that match nothing known:\n\n${lines.join("\n")}\n\nWhat I saw (moved / got brighter / got fainter / not sure):\n\n`);
  }

  // ---------------- stats + export ----------------
  function stats() {
    const sims = answers.reduce((a, r) => a + r.sims, 0), found = answers.reduce((a, r) => a + r.foundSims, 0);
    $("stats").innerHTML = `Fields scanned <b>${answers.length}</b>` + (sims ? ` · practice movers found <b>${found}/${sims}</b>` : "");
  }
  function csv() {
    const rows = ["field,t,mark_x_px,mark_y_px,ra_deg,dec_deg"];
    for (const a of answers) {
      const f = fields.find((g) => g.id === a.id); if (!f) continue;
      for (const m of a.marks) {
        const c = (f.npix - 1) / 2, dec = f.dec + ((m.y - c) * f.pixscale) / 3600, ra = f.ra + ((c - m.x) * f.pixscale) / 3600 / Math.cos((f.dec * Math.PI) / 180);
        rows.push(`${a.id},${a.t},${m.x},${m.y},${ra.toFixed(6)},${dec.toFixed(6)}`);
      }
    }
    const el = document.createElement("a"); el.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" })); el.download = "spot-the-wanderer-marks.csv"; el.click();
  }

  // ---------------- tutorial (uses close-up examples from data/subjects) ----------------
  async function tour() {
    let ex = [];
    try { ex = (await (await fetch("data/subjects/subjects.json")).json()).subjects; } catch (_) { /* no examples */ }
    const pick = (f) => ex.find(f), S = "data/subjects/";
    const pics = (s) => s ? `<div class="pics">${["a", "b", "d"].map((t, i) => `<figure><img src="${S}${s.id}_${t}.png" alt=""><figcaption>${["Picture 1", "Picture 2", "Difference"][i]}</figcaption></figure>`).join("")}</div>` : "";
    const cards = [
      { t: "Scan the sky for wanderers", h: `<p>NASA's <b>SPHEREx</b> telescope photographs the whole sky again and again. You'll see <b>one patch of sky at two dates, flashing back and forth</b>. Hundreds of stars stay put, but a few things <b>move</b> (nearby stars, cold brown dwarfs) or <b>change brightness</b>.</p><p>Your job: <b>click on every one you spot</b>. No astronomy needed.</p>` },
      { t: "What a mover looks like (close-up)", h: `${pics(pick((s) => s.slug === "barnard" && s.type === "gold"))}<p>Barnard's Star, the fastest star in our sky: when the pictures flash, it <b>jumps a little</b>. In <b>Difference</b> view, a mover is an <b style="color:var(--amber)">orange</b> + <b style="color:#5cc8e8">blue</b> pair. Click on it.</p>` },
      { t: "What to ignore", h: `${pics(pick((s) => s.slug === "rdra"))}<p>Very bright stars blind the camera: <b>white blobs, rings and halos</b> that shift around. Those are glitches, so don't mark them. Speckly noise in the Difference view is normal too.</p>` },
      { t: "Practice movers", h: `${pics(pick((s) => s.example) || pick((s) => s.target === "Simulated object"))}<p>Real movers are rare, so to help you practise (and to measure how good human eyes are), <b>every field has 1–3 fake moving stars that we planted</b> in the real SPHEREx picture. They look exactly like a real mover: a dot that jumps a little between the two pictures, like the one above.</p><p>Find them like any other mover. After <b>Done</b> we circle them in <b style="color:#ff4fd8">dashed pink</b> so you can see how you did.</p>` },
      { t: "How to mark", h: `<p><b>Click</b> to drop a mark; click it again to remove it. <b>Scroll</b> or <b>+</b> to zoom, <b>drag</b> to look around, <b>⤢</b> to see the whole field.</p><p>When you press <b>Done</b>, we show the practice movers you caught or missed, what the computer found, and any real fast stars, so you learn as you go. Marks that match <b>nothing known</b> are the interesting ones: possible discoveries.</p>` },
    ];
    let i = 0; const el = $("tour");
    const close = () => { el.hidden = true; store.set("toured", true); };
    const render = () => {
      const c = cards[i];
      el.innerHTML = `<div class="card"><div class="kicker">HOW IT WORKS · ${i + 1}/${cards.length}</div><h2 id="tourTitle">${c.t}</h2>${c.h}
        <div class="nav"><button type="button" class="skip">Skip</button><span class="dots">${cards.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</span>
        ${i ? '<button type="button" class="back">Back</button>' : ""}<button type="button" class="primary next">${i === cards.length - 1 ? "Start scanning" : "Next"}</button></div></div>`;
      el.querySelector(".skip").onclick = close;
      const b = el.querySelector(".back"); if (b) b.onclick = () => { i--; render(); };
      el.querySelector(".next").onclick = () => { if (i < cards.length - 1) { i++; render(); } else close(); };
      el.querySelector(".next").focus();
    };
    el.hidden = false; render(); el.onkeydown = (e) => { if (e.key === "Escape") close(); };
  }

  // ---------------- wiring ----------------
  document.querySelectorAll(".view-seg button").forEach((b) => b.addEventListener("click", () => show(b.dataset.v)));
  $("done").addEventListener("click", () => submit(false));
  $("none").addEventListener("click", () => submit(true));
  $("howBtn").addEventListener("click", tour);
  if (window.WANDERER_SUBMIT) {
    $("privacy").textContent = "Your marks go to the astro3club database: anonymous unless you add a name for credit";
    // optional name so volunteers can be credited for discoveries (stays in this browser + goes with each field)
    $("creditBox").hidden = false;
    $("creditName").value = store.get("creditName", "") || "";
    $("creditName").addEventListener("input", (e) => store.set("creditName", e.target.value.slice(0, 40)));
  }
  $("csv").addEventListener("click", (e) => { e.preventDefault(); csv(); });
  addEventListener("resize", applyZoom);
  document.addEventListener("keydown", (e) => {
    if (!$("tour").hidden) return;
    if (e.key === "d") show(view === "d" ? "blink" : "d");
    if (e.key === "+" || e.key === "=") $("zin").click();
    if (e.key === "-") $("zout").click();
    if (e.key === "0") $("zfit").click();
  });
  fetch(`${BASE}fields.json`, { cache: "no-cache" }).then((r) => r.json()).then((d) => {
    fields = d.fields; buildQueue(); load();
    if (!store.get("toured", false)) tour();
  }).catch(() => { $("feedback").hidden = false; $("feedback").textContent = "Could not load the sky fields. Please reload the page."; });
})();
