/* "Red-source survey" panel: what Wanderer found when it read the SPHEREx spectra of
 * very red CatWISE sources. Data: data/survey.json (written by survey/summarise.py). */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let data = null;
  async function load() {
    try { const r = await fetch("data/survey.json", { cache: "no-cache" }); if (r.ok) data = await r.json(); } catch (_) { /* no survey shipped */ }
    if (!data || !data.rows || !data.rows.length) return;
    const chips = $("chips"), b = document.createElement("button");
    b.type = "button"; b.className = "survey-chip"; b.innerHTML = `★ Survey<small>${data.rows.length} red sources</small>`;
    b.addEventListener("click", toggle);
    const keep = () => { if (!chips.contains(b)) chips.prepend(b); };
    keep(); new MutationObserver(keep).observe(chips, { childList: true });
  }
  function toggle() {
    const p = $("surveyPanel");
    if (!p.hidden) { p.hidden = true; return; }
    const s = data.summary || {};
    p.innerHTML = `<button type="button" class="close" aria-label="Close">×</button>
      <h3>RED-SOURCE SURVEY</h3>
      <p class="small">${esc(data.intro || "")}</p>
      ${s.lines ? `<ul class="survey-sum">${s.lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : ""}
      <div class="survey-table"><table><thead><tr><th>Source</th><th>W1−W2</th><th>Motion</th><th>SPHEREx says</th><th></th></tr></thead><tbody>
      ${data.rows.map((r) => `<tr class="${r.family === "brown-dwarf" ? "hit" : ""}"><td>${esc(r.name.replace("CWISE ", ""))}</td><td>${(+r.w1w2).toFixed(2)}</td>
        <td>${r.pm != null ? `${(+r.pm).toFixed(2)}″/yr` : "–"}</td><td>${esc(r.short)} <small>${esc(r.conf)}</small></td>
        <td><button type="button" class="mini" data-open="${esc(r.slug)}">Open</button></td></tr>`).join("")}
      </tbody></table></div>
      <p class="muted small">${esc(data.method || "")}</p>`;
    p.hidden = false;
    p.querySelector(".close").onclick = () => (p.hidden = true);
    p.querySelectorAll("[data-open]").forEach((x) => x.addEventListener("click", () => {
      p.hidden = true;
      const u = new URL(location.href); u.search = `?target=${x.dataset.open}&band=0`; location.href = u.toString();
    }));
  }
  addEventListener("DOMContentLoaded", load);
})();
