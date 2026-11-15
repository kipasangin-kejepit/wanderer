"""Turn survey_results.json (from the in-browser classifier) into web/data/survey.json
and print the numbers for the write-up."""
import json
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
res = json.loads((ROOT / "survey" / "survey_results.json").read_text())
picked = {f"survey_{t['id']}": t for t in json.loads((ROOT / "survey" / "picked.json").read_text())}
extra = ROOT / "survey" / "extra_targets.json"
if extra.exists():
    picked.update({f"survey_{t['id']}": t for t in json.loads(extra.read_text())})

rows = []
for r in res:
    t = picked.get(r["slug"], {})
    pm = math.hypot(t.get("pmra") or 0, t.get("pmdec") or 0) if t else None
    d = r["col"].get("ch4depth", [None, None])
    rows.append({"ch4depth": d[0] if d and d[0] == d[0] else None, "slug": r["slug"], "name": r["name"], "group": r.get("group") or t.get("group"), "w1w2": r["w1"] - r["w2"], "w2": r["w2"],
                 "pm": pm, "short": r["short"], "family": r["family"], "conf": r["conf"], "KM": r["col"]["KM"][0], "CM": r["col"]["CM"][0], "h2o": r["col"]["h2o"][0]})
rows.sort(key=lambda r: (r["family"] != "brown-dwarf", r["group"] != "moving", -r["w1w2"]))

by = {g: [r for r in rows if r["group"] == g] for g in ("moving", "still")}
lines = []
for g, label in (("moving", "moving (nearby, brown-dwarf-like)"), ("still", "not moving (distant, galaxy-like)")):
    c = Counter(r["short"] for r in by[g])
    if by[g]:
        lines.append(f"<b>{len(by[g])}</b> {label}: " + ", ".join(f"{v}× {k}" for k, v in c.most_common()))
bd_still = sum(r["family"] == "brown-dwarf" for r in by["still"])
bd_moving = sum(r["family"] == "brown-dwarf" for r in by["moving"])
if by["still"]:
    lines.append(f"Brown-dwarf label on non-moving sources (false alarms): <b>{bd_still}/{len(by['still'])}</b>")
if by["moving"]:
    lines.append(f"Brown-dwarf label on moving sources: <b>{bd_moving}/{len(by['moving'])}</b>")

trough = lambda r: r["ch4depth"] is not None and r["ch4depth"] > 0.35
lines.append(f"Methane trough (spectrum only, no motion used) on non-moving sources: <b>{sum(trough(r) for r in by['still'])}/{sum(r['ch4depth'] is not None for r in by['still'])}</b> · Epsilon Indi B for comparison: 74%")
nd = sum(r["short"] == "Not detected" for r in by["moving"])
if nd:
    lines.append(f"<b>{nd}/{len(by['moving'])}</b> 'moving' catalogue sources are not seen by SPHEREx at all, though they should be bright enough: probably spurious CatWISE entries")
clean = lambda v: None if isinstance(v, float) and v != v else v
rows = [{k: clean(v) for k, v in r.items()} for r in rows]
out = {
    "intro": "Very red WISE sources (W1−W2 > 1.5) are either cold brown dwarfs (methane hides them at 3.4 µm) or distant dusty "
             "active galaxies. WISE colours alone can't tell them apart. Proper motion can: brown dwarfs are close, so they move. "
             "We read each source's SPHEREx 0.75–5 µm spectrum and asked Wanderer's classifier what it is. The methane test uses the spectrum alone; "
             "the final label also uses the catalogue motion. Our first classifier failed this test (it called 6 of 8 galaxies brown dwarfs), which is how we found and fixed its flaw.",
    "method": "Targets: CatWISE2020, 8 fields × 6° radius at high galactic latitude, 8 < W2 < 14, clean photometry. "
              "'Moving' = proper motion > 0.15″/yr at > 5σ; 'not moving' = < 2σ. Up to 180 SPHEREx QR2 frames per source, 3′ cut-outs. "
              "Colours self-calibrated on field stars in each cut-out. Each source is measured at the brightest 4.6 µm pixel within 1 px of its predicted position, "
              "so very faint ones (e.g. the single 'cold brown dwarf') can change label when you click a neighbouring pixel: treat them as leads.",
    "summary": {"lines": lines},
    "rows": rows,
}
(ROOT / "web" / "data" / "survey.json").write_text(json.dumps(out, indent=1, allow_nan=False))
print("\n".join(l.replace("<b>", "").replace("</b>", "") for l in lines))
for r in rows:
    print(f"{r['group']:7s} {r['name']:28s} W1-W2 {r['w1w2']:.2f} W2 {r['w2']:.1f} pm {r['pm'] or 0:.2f}  -> {r['short']} ({r['conf']})  KM {r['KM']}  CH4 depth {r['ch4depth']}")
