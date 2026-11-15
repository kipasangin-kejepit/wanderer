/* Wanderer FX: boot sequence, achievements ("discovery log"), easter eggs.
 * Everything here is presentation. Alien transmissions are clearly labelled fiction;
 * the facts inside them are real.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("wanderer:" + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem("wanderer:" + k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
  };
  const sstore = {
    get(k) { try { return sessionStorage.getItem("wanderer:" + k); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem("wanderer:" + k, v); } catch (_) { /* ignore */ } },
  };
  const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Research mode: no boot film, scanlines, aliens, achievement pop-ups or tour. Same data and tools.
  const research = /[?&]research=1/.test(location.search) || (!/[?&]research=0/.test(location.search) && store.get("research", false));
  if (research) document.documentElement.classList.add("research");

  // ---------------- boot ----------------
  const BOOT = [
    ["Initialising deep sky terminal", "ok"],
    ["Linking to NASA SPHEREx (DR1 + Quick Release 3)", "ok"],
    ["102-band infrared archive: 0.75–5.0 µm", "ok"],
    ["Loading star charts: SIMBAD, Gaia DR3, WISE", "ok"],
    ["Calibrating proper-motion predictor", "ok"],
    ["Scanning for anomalies", "warn"],
  ];
  function boot(done) {
    const body = document.body;
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      document.removeEventListener("keydown", onKey);
      sstore.set("booted", "1"); body.classList.remove("mode-boot"); done && done();
    };
    const onKey = (e) => { if (e.key === "Enter" || e.key === "Escape") skip(); };
    if (research || sstore.get("booted")) { finish(); return; }
    const log = $("bootLog"), go = $("bootGo");
    let i = 0, stopped = false;
    const line = () => {
      if (stopped) return;
      if (i >= BOOT.length) {
        log.innerHTML += `\n<span class="ok">ALL SYSTEMS NOMINAL.</span> Ready for launch.`;
        go.hidden = false; go.focus();
        return;
      }
      const [txt, kind] = BOOT[i++];
      const status = kind === "ok" ? `<span class="ok">[ OK ]</span>` : `<span class="warn">[ ?? ]</span>`;
      log.innerHTML += `${i > 1 ? "\n" : ""}&gt; ${txt} ${".".repeat(Math.max(2, 40 - txt.length))} ${status}`;
      setTimeout(line, reduced ? 40 : 280 + Math.random() * 220);
    };
    line();
    const skip = () => { stopped = true; finish(); };
    go.addEventListener("click", skip);
    $("bootSkip").addEventListener("click", skip);
    document.addEventListener("keydown", onKey);
  }

  // ---------------- achievements ----------------
  const ACH = [
    ["first_contact", "FIRST CONTACT", "Open your first SPHEREx archive."],
    ["warp", "WARP DRIVE", "Warp from the starmap to a star."],
    ["stargazer", "STARGAZER", "Identify 10 objects by clicking them."],
    ["cold", "COLD FRONT", "Lock onto WISE 0855, the coldest brown dwarf known."],
    ["mover", "MOVER HUNTER", "Catch something moving with Find movers."],
    ["grand_tour", "GRAND TOUR", "Visit all five challenge targets."],
    ["xfiles", "THE TRUTH IS OUT THERE", "Intercept an alien transmission. (Hint: famous spots.)"],
    ["hailmary", "AMAZE AMAZE AMAZE", "Find a friend around a nearby Sun-like star."],
    ["citizen", "CITIZEN SCIENTIST", "Log your first candidate in the discovery notebook."],
    ["explorer", "INTO THE UNKNOWN", "Scan a patch of sky that wasn't prepared in advance (try ✦ Uncharted)."],
  ];
  let cands = store.get("candidates", []);
  function logCandidate(c) {
    cands.push(Object.assign({ logged_utc: new Date().toISOString().slice(0, 19) + "Z" }, c));
    store.set("candidates", cands);
    unlock("citizen"); renderLog();
  }
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportCsv() {
    const cols = ["logged_utc", "target", "kind", "ra", "dec", "band", "significance", "change_pct", "catalogue_match", "classification", "vet_score", "verdict", "epochs", "link"];
    const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    download("wanderer-candidates.csv", [cols.join(",")].concat(cands.map((c) => cols.map((k) => esc(c[k])).join(","))).join("\n"), "text/csv");
  }
  let unlocked = store.get("ach", {});
  const counters = store.get("counters", { identified: 0, visited: [] });
  function updateCount() { const el = $("logCount"); if (el) el.textContent = `${Object.keys(unlocked).length}/${ACH.length}`; }
  let achTimer = null;
  function unlock(id) {
    if (unlocked[id]) return;
    const a = ACH.find((x) => x[0] === id); if (!a) return;
    unlocked[id] = Date.now(); store.set("ach", unlocked); updateCount();
    if (research) return; // recorded, but no pop-up
    const el = $("achv");
    el.innerHTML = `◆ ACHIEVEMENT UNLOCKED: ${a[1]}<small>${a[2]}</small>`;
    el.hidden = false;
    clearTimeout(achTimer); achTimer = setTimeout(() => (el.hidden = true), 4200);
    renderLog();
  }
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  function renderLog() {
    const p = $("logPanel"); if (!p) return;
    p.innerHTML = `<h3>DISCOVERY LOG · ${Object.keys(unlocked).length}/${ACH.length}</h3><ul>` +
      ACH.map(([id, t, d]) => `<li class="${unlocked[id] ? "done" : "locked"}"><span>${unlocked[id] ? "✔" : "◇"}</span><b>${t}</b><small>${d}</small></li>`).join("") +
      `</ul><p class="muted small" style="margin:10px 0 0">Stars identified: ${counters.identified} · Challenge targets visited: ${counters.visited.length}/5<br>` +
      `Hidden transmissions found: ${Object.keys(seen).length}/${SPOTS.length}. No markers, no map: they sit at famous places in the sky.</p>` +
      `<h3 style="margin-top:16px">CANDIDATE NOTEBOOK · ${cands.length}</h3>` +
      (cands.length ? `<ul class="cands">${cands.slice(-8).reverse().map((c) => `<li><span>${c.catalogue_match === "none" ? "★" : "·"}</span><b>${esc(c.target)} · ${esc(c.kind)}</b><small>${c.ra}, ${c.dec} · ${esc(c.catalogue_match)}${c.classification ? ` · ${esc(c.classification)}` : ""}${c.vet_score != null ? ` · VET ${c.vet_score}` : ""}${window.Analysis ? `<br>${window.Analysis.submitHtml(c, "mini-link")}` : ""}</small></li>`).join("")}</ul>` +
        `<div class="row" style="margin-top:10px"><button type="button" class="primary" id="candCsv">Download CSV</button><button type="button" id="candClear">Clear</button></div>`
        : `<p class="muted small">Use <b>Log</b> next to a Find movers result, or <b>Log candidate</b> on a target lock, to save interesting spots here.</p>`);
    const csv = document.getElementById("candCsv"); if (csv) csv.addEventListener("click", exportCsv);
    const clr = document.getElementById("candClear"); if (clr) clr.addEventListener("click", () => { if (confirmClear()) { cands = []; store.set("candidates", cands); renderLog(); } });
  }
  function event(name, data) {
    if (name === "pack") {
      unlock("first_contact");
      if (data.slug === "wise0855") unlock("cold");
      if (!data.slug.startsWith("_") && !data.slug.startsWith("live_") && !counters.visited.includes(data.slug)) counters.visited.push(data.slug);
      if (counters.visited.length >= 5) unlock("grand_tour");
    }
    if (name === "identify") { counters.identified++; if (counters.identified >= 10) unlock("stargazer"); }
    if (name === "mover") unlock("mover");
    if (name === "warp") unlock("warp");
    if (name === "scan") unlock("explorer");
    store.set("counters", counters); renderLog();
  }

  // ---------------- alien transmissions (easter eggs) ----------------
  const SPOTS = [
    { id: "wow", ra: 291.36, dec: -26.95, r: 1.2, title: "SIGNAL INTERCEPTED: 6EQUJ5",
      text: "On 15 August 1977 the Big Ear radio telescope caught a 72-second burst from this part of Sagittarius. Astronomer Jerry Ehman circled it and wrote \"Wow!\". It has never been heard again." },
    { id: "tabby", ra: 301.5644, dec: 44.4569, r: 0.08, title: "ANOMALY: KIC 8462852 (TABBY'S STAR)",
      text: "This star dimmed by up to 22% at irregular times. For a while people wondered about an alien megastructure. The best explanation now: clumps of dust. Probably." },
    { id: "trappist", ra: 346.6223, dec: -5.0413, r: 0.08, title: "SYSTEM DETECTED: TRAPPIST-1",
      text: "Seven rocky planets orbit this cool red dwarf, 40 light years away. Three are in the zone where liquid water could exist. Leaving a polite message on the log." },
    { id: "zeta", ra: 49.5, dec: -62.5, r: 0.4, title: "ZETA RETICULI",
      text: "Made famous by a 1960s UFO abduction story. Sensors show two ordinary Sun-like stars, 39 light years away. Nobody is home. Or they are very good at hiding." },
    { id: "proxima", ra: 217.429, dec: -62.68, r: 0.15, title: "HAILING: PROXIMA CENTAURI",
      text: "Our nearest neighbour, 4.2 light years away, with at least one planet in its habitable zone. A hello sent today arrives in 2031. Expect a reply in 2035." },
    { id: "tauceti", ra: 26.017, dec: -15.937, r: 0.3, ach: "hailmary", title: "AMAZE AMAZE AMAZE",
      text: "Tau Ceti, 11.9 light years away: a Sun-like star with planet candidates. In Andy Weir's Project Hail Mary, a lone science teacher flies here to save the Sun and finds a friend who says amaze, amaze, amaze. Fist my bump.",
      fiction: "A nod to Andy Weir's novel. Tau Ceti and its planets are real." },
    { id: "m13", ra: 250.42, dec: 36.46, r: 0.3, title: "ARECIBO MESSAGE TARGET: M13",
      text: "In 1974 humans beamed a 1,679-bit picture message at this star cluster. It is 25,000 light years away, so the earliest possible reply lands in the year 51,974." },
  ];
  let seen = store.get("seenSpots", {});
  function angDist(r1, d1, r2, d2) {
    const R = Math.PI / 180;
    return Math.acos(Math.min(1, Math.sin(d1 * R) * Math.sin(d2 * R) + Math.cos(d1 * R) * Math.cos(d2 * R) * Math.cos((r1 - r2) * R))) / R;
  }
  function checkSpot(ra, dec) {
    const s = SPOTS.find((p) => angDist(p.ra, p.dec, ra, dec) < p.r);
    if (!s) return false;
    transmit(s.title, s.text, s.fiction);
    seen[s.id] = 1; store.set("seenSpots", seen); renderLog();
    unlock(s.ach || "xfiles");
    return true;
  }
  let txTimer = null;
  function transmit(title, text, fiction = "Transmission styling is fiction. The facts are real.") {
    if (research) return;
    const el = $("transmission");
    el.innerHTML = `<div class="kicker">◆ INCOMING TRANSMISSION</div><h4>${title}</h4><p></p><p class="fiction">${fiction}</p><button type="button">Close channel</button>`;
    el.hidden = false;
    const p = el.querySelector("p");
    let i = 0;
    clearInterval(txTimer);
    if (reduced) p.textContent = text;
    else txTimer = setInterval(() => { p.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(txTimer); }, 14);
    el.querySelector("button").addEventListener("click", () => { clearInterval(txTimer); el.hidden = true; });
  }

  // Search-box easter eggs
  function searchEgg(q) {
    if (research) return false;
    const k = q.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (["aliens", "alien", "ufo", "ufos"].includes(k)) { ufo(); transmit("WE SEE YOU TOO", "Six famous \"alien\" spots are hidden in this sky. Click around the right places and the terminal will pick up their transmissions. Try the Wow! signal, Tabby's Star or TRAPPIST-1."); unlock("xfiles"); return true; }
    if (k === "planet x" || k === "planet nine" || k === "planet 9") { transmit("PLANET X: STATUS UNKNOWN", "Some astronomers think an unseen planet a few times Earth's mass orbits far beyond Neptune. If it exists, it would show up as a faint dot that shifts between SPHEREx epochs. That is exactly what Find movers looks for. Happy hunting.", "Not fiction: this is an open question in astronomy."); return true; }
    if (["hail mary", "project hail mary", "rocky", "astrophage", "amaze", "amaze amaze amaze"].includes(k)) { checkSpot(26.017, -15.937); return true; }
    if (k === "42") { transmit("ANSWER RECEIVED", "The answer is 42. The question is still being computed. Estimated completion: 7.5 million years."); return true; }
    if (k === "hello" || k === "hi") { transmit("HELLO, EARTHLING", "Your signal was received. Please click a star to continue. We will wait."); return true; }
    return false;
  }

  // ---------------- UFO + Konami code ----------------
  function ufo() {
    const el = $("ufo"); if (!el || reduced || research) return;
    el.hidden = false;
    const y0 = 120 + Math.random() * (innerHeight * 0.4), t0 = performance.now(), dur = 5200;
    const step = (now) => {
      const t = (now - t0) / dur;
      if (t >= 1) { el.hidden = true; return; }
      const x = -140 + (innerWidth + 280) * t;
      const y = y0 + Math.sin(t * 14) * 18 - (t > 0.8 ? (t - 0.8) * 1600 : 0);
      el.style.transform = `translate(${x}px, ${y}px) rotate(${Math.sin(t * 9) * 8}deg)`;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let kpos = 0;
  document.addEventListener("keydown", (e) => {
    kpos = e.key === KONAMI[kpos] ? kpos + 1 : (e.key === KONAMI[0] ? 1 : 0);
    if (kpos === KONAMI.length) {
      kpos = 0; ufo();
      transmit("CLOSE ENCOUNTER", "An unidentified craft just crossed your screen. Sensors say it was a weather balloon. Sensors are lying.");
      unlock("xfiles");
    }
  });

  // ---------------- log panel ----------------
  document.addEventListener("DOMContentLoaded", () => {
    updateCount(); renderLog();
    const btn = $("logBtn"), panel = $("logPanel");
    btn.addEventListener("click", () => { panel.hidden = !panel.hidden; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") panel.hidden = true; });
  });

  let clearArmed = false;
  function confirmClear() { // two-step clear without a browser dialog
    if (clearArmed) { clearArmed = false; return true; }
    clearArmed = true; const b = document.getElementById("candClear"); if (b) b.textContent = "Click again to clear";
    setTimeout(() => { clearArmed = false; }, 3000); return false;
  }
  // The transmissions are now fully hidden (no blips): spots() feeds the markers, so it's empty.
  const spots = () => [].map((p) => ({ id: p.id, ra: p.ra, dec: p.dec, title: p.title, found: !!seen[p.id] }));
  function setResearch(on) { store.set("research", !!on); const u = new URL(location.href); u.searchParams.delete("research"); location.href = u.toString(); }
  document.addEventListener("DOMContentLoaded", () => {
    const b = $("modeBtn"); if (!b) return;
    b.innerHTML = research ? "◑<span class=\"lbl\"> Explore mode</span>" : "◐<span class=\"lbl\"> Research mode</span>";
    b.setAttribute("aria-label", research ? "Switch to explore mode" : "Switch to research mode");
    b.title = research ? "Back to the game look: boot screen, effects and easter eggs" : "Plain, fast interface for research: no boot screen, effects, aliens or pop-ups";
    b.addEventListener("click", () => setResearch(!research));
    // research mode: the search button just goes there, no warp
    const go = document.querySelector('#search button[type="submit"]'); if (research && go) go.textContent = "Go";
  });
  window.FX = { research: () => research, boot, unlock, event, checkSpot, transmit, searchEgg, ufo, spots, logCandidate, candidates: () => cands.slice() };
})();
