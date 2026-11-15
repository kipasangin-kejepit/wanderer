"""Wide 20′ fields for "Spot the Wanderer" (people scan the whole field, like a TESS sector)."""
import json, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import spherex  # noqa: E402
DATA = ROOT / "web" / "data"
idx = {p["slug"]: p for p in json.loads((DATA / "index.json").read_text())["packs"]}
fields = [(f"wide_{s}", idx[s]["ra"], idx[s]["dec"], idx[s]["name"]) for s in ("barnard", "epsindib", "wise0855", "rwaur", "rdra") if s in idx]
for p in sorted(DATA.glob("survey_*"))[::5][:7]:
    m = json.loads((p / "manifest.json").read_text())
    fields.append((f"wide_{p.name[7:]}", m["ra"], m["dec"], f"Field around {m['name']}"))
for slug, ra, dec, name in fields:
    if (DATA / slug / "manifest.json").exists():
        continue
    t = time.time()
    try:
        spherex.build_target(ra, dec, DATA / slug, fov_arcmin=20, name=name, max_frames=120, workers=8, progress=lambda m: None, extra={"wide": True})
        print(slug, "ok", round(time.time() - t), "s", flush=True)
    except Exception as e:  # noqa: BLE001
        print(slug, "FAILED", e, flush=True)
print("WIDE DONE", flush=True)
