/* First-visit walkthrough: six plain-language steps that point at the real controls
 * and do the clicking for you, so anyone can make a first "discovery" in a minute.
 * Opens after the boot screen on the first visit; the ? button replays it. */
(() => {
  "use strict";
  const KEY = "wanderer.tutorial.done";
  const $ = (s) => document.querySelector(s);
  const store = {
    get() { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } },
    set() { try { localStorage.setItem(KEY, "1"); } catch (_) { /* private mode */ } },
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(150); } return false; }
  const packOpen = (slug) => () => { const c = document.querySelector(`#chips button[data-slug="${slug}"]`); return c && c.classList.contains("on") && !$("#dock").classList.contains("disabled"); };

  const STEPS = [
    { title: "Welcome, explorer",
      text: "Wanderer shows you <b>real pictures from NASA's SPHEREx space telescope</b>, taken months apart. Your mission: <b>spot things in the sky that move or change</b>. No astronomy needed. This tour takes about a minute. Want the simplest version? Try <a href='./'>★ Spot the Wanderer</a>: one picture, one question.",
      next: "Let's go" },
    { title: "Our neighbourhood", target: "#mapStage", view: "map",
      text: "These are the stars within 15 light years of the Sun. <b>Drag</b> to spin, <b>scroll</b> to zoom. Stars marked <b>◇</b> have SPHEREx pictures you can open.",
      next: "Fly to Barnard's Star",
      async go() { const c = document.querySelector('#chips button[data-slug="barnard"]'); if (c) c.click(); await until(packOpen("barnard")); await wait(2600); } },
    { title: "Pictures through time", target: "#dock .row:first-child",
      text: "This is Barnard's Star, the fastest-moving star in our sky. The buttons <b>Epoch 1, Epoch 2</b> are the dates SPHEREx took its pictures. Press <b>▶</b> and watch them flip like a flipbook. Can you see the star shift a little?",
      next: "Show me what changed" },
    { title: "Only what changed", target: '[data-mode="diff"]',
      text: "<b>Difference</b> subtracts the old picture from the new one. Everything that stayed the same goes dark. <b style='color:#ffb547'>Orange</b> = brighter now, <b style='color:#5cc8e8'>blue</b> = fainter now. A <b>moving</b> object leaves an orange-and-blue pair.",
      async enter() { const b = $('[data-mode="diff"]'); if (b) b.click(); },
      next: "Let the computer hunt" },
    { title: "Find movers", target: "#moversCard",
      text: "<b>Find movers</b> hunts for those pairs automatically. Each find is checked against star catalogues: <b>✓ KNOWN</b> means astronomers already have it; <b>★</b> means no catalogue has it. <b>VET</b> is a 0–100 score for how likely it's real and not a camera glitch.",
      async enter() { const b = $("#movers"); if (b) b.click(); await wait(400); },
      next: "And then?" },
    { title: "Your discovery log", target: "#logBtn",
      text: "<b>Report</b> writes a full science report: pictures, the object's colours (is it a star? a cold brown dwarf? a comet?) and next steps. <b>Log</b> saves it in your notebook here, and good finds (VET 45+) can be sent to the astro3club team.",
      next: "Last thing" },
    { title: "Into the unknown", target: "#uncharted",
      text: "Ready for the real thing? <b>✦ Uncharted</b> scans a random patch of sky that nobody here has looked at yet, straight from NASA's archive. Most of the sky is quiet, so if something pops up, look closely. Psst: there are a few <span style='color:#ff4fd8'>alien secrets</span> hidden too.",
      next: "Start exploring" },
  ];

  let i = 0, box, ring, active = false;
  function build() {
    ring = document.createElement("div"); ring.className = "tut-ring"; ring.hidden = true;
    box = document.createElement("section"); box.className = "tut panel"; box.setAttribute("role", "dialog"); box.setAttribute("aria-live", "polite");
    document.body.append(ring, box);
    addEventListener("resize", place);
    addEventListener("keydown", (e) => { if (active && e.key === "Escape") end(); });
  }
  function place() {
    if (!active) return;
    const s = STEPS[i], el = s.target && document.querySelector(s.target);
    if (el && s.target !== "#mapStage" && !place.scrolled) { place.scrolled = true; const sc = el.closest(".drawer-body"); if (sc) sc.scrollTop = Math.max(0, el.offsetTop - 40); window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    const narrow = innerWidth < 760;
    if (r && r.width && s.target !== "#mapStage") {
      Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      ring.hidden = false;
    } else ring.hidden = true;
    box.classList.toggle("bottom", narrow);
    if (narrow || !r || s.target === "#mapStage") { box.style.left = narrow ? "12px" : "50%"; box.style.top = ""; box.style.bottom = narrow ? "12px" : "8vh"; box.style.transform = narrow ? "" : "translateX(-50%)"; return; }
    const W = Math.min(400, innerWidth - 24), H = box.offsetHeight || 220;
    let left = Math.min(Math.max(12, r.left + r.width / 2 - W / 2), innerWidth - W - 12);
    let top = r.top - H - 18; if (top < 70) top = r.bottom + 18;
    top = Math.max(70, Math.min(top, innerHeight - H - 12));
    // never cover the thing we point at: if it would, slide sideways instead
    if (top < r.bottom && top + H > r.top) left = r.right + 18 + W < innerWidth ? r.right + 18 : Math.max(12, r.left - W - 18);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, bottom: "", transform: "" });
  }
  async function show(k) {
    i = k; const s = STEPS[i]; place.scrolled = false;
    if (s.view) { const v = document.querySelector(`[data-view="${s.view}"]`); if (v && !v.classList.contains("on")) v.click(); }
    box.innerHTML = `<div class="tut-kick">MISSION BRIEFING · ${i + 1}/${STEPS.length}</div><h3>${s.title}</h3><p>${s.text}</p>
      <div class="tut-row"><button type="button" class="tut-skip">${i === STEPS.length - 1 ? "" : "Skip tour"}</button>
      <span class="tut-dots">${STEPS.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</span>
      <button type="button" class="primary tut-next">${s.next}</button></div>`;
    box.hidden = false;
    box.querySelector(".tut-skip").onclick = end;
    box.querySelector(".tut-next").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "…";
      try { if (s.go) await s.go(); } catch (_) { /* keep going */ }
      if (i + 1 < STEPS.length) { await show(i + 1); } else end();
    };
    try { if (s.enter) await s.enter(); } catch (_) { /* keep going */ }
    requestAnimationFrame(place); setTimeout(place, 450);
    box.querySelector(".tut-next").focus({ preventScroll: true });
  }
  function start() { if (!box) build(); active = true; document.body.classList.add("touring"); show(0); }
  function end() { active = false; store.set(); if (box) box.hidden = true; if (ring) ring.hidden = true; document.body.classList.remove("touring"); }

  // replay button
  addEventListener("DOMContentLoaded", () => {
    const help = $("#helpBtn"); if (help) help.addEventListener("click", start);
    const deepLink = /[?&](target|ra)=/.test(location.search);
    if (store.get() || deepLink || document.documentElement.classList.contains("research")) return;
    // first visit: wait until the boot screen is gone and the starmap is up
    const t0 = Date.now();
    const iv = setInterval(() => {
      const booting = document.body.classList.contains("mode-boot");
      if (!booting && (window.Starmap || Date.now() - t0 > 20000)) { clearInterval(iv); setTimeout(start, 900); }
      if (Date.now() - t0 > 60000) clearInterval(iv);
    }, 300);
  });
  window.Tutorial = { start, end };
})();
