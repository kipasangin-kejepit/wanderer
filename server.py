"""
Wanderer live server: serves the viewer AND builds SPHEREx target packs on demand for
any coordinates, so people can scan sky nobody has looked at yet.

Local:
    pip install -r requirements.txt
    uvicorn server:app --port 8000          # open http://localhost:8000

Hosted (Render free tier, see render.yaml): the static site on GitHub Pages points at
this server with web/config.js. Small machine, so the server is deliberately polite:
  * one scan at a time, everyone else waits in a queue (and sees their position)
  * a per-visitor rate limit on NEW scans (cached areas are always free)
  * fewer frames per scan, spread evenly over time so every epoch is kept
  * old scans are deleted when the cache gets too big
Settings come from environment variables (defaults in brackets):
  WANDERER_MAX_FRAMES [120]   frames per scan
  WANDERER_MAX_FOV [20]       largest field in arcmin
  WANDERER_WORKERS [4]        parallel downloads from IRSA
  WANDERER_RATE [3]           new scans per visitor per hour
  WANDERER_CACHE_MB [400]     disk budget for scanned packs
  WANDERER_ORIGINS [*]        comma-separated sites allowed to call the API (CORS)
"""
from __future__ import annotations

import hashlib
import os
import queue
import shutil
import sys
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "pipeline"))
import spherex  # noqa: E402
import build_cache  # noqa: E402

DATA = ROOT / "web" / "data"
DATA.mkdir(parents=True, exist_ok=True)

MAX_FRAMES = int(os.environ.get("WANDERER_MAX_FRAMES", 120))
MAX_FOV = float(os.environ.get("WANDERER_MAX_FOV", 20))
WORKERS = int(os.environ.get("WANDERER_WORKERS", 4))
RATE = int(os.environ.get("WANDERER_RATE", 3))
CACHE_MB = float(os.environ.get("WANDERER_CACHE_MB", 400))
ORIGINS = [o.strip() for o in os.environ.get("WANDERER_ORIGINS", "*").split(",") if o.strip()]

app = FastAPI(title="Wanderer API")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])

JOBS: dict[str, dict] = {}
LOCK = threading.Lock()
QUEUE: "queue.Queue[tuple[str, BuildReq]]" = queue.Queue()
WAITING: deque[str] = deque()          # slugs in queue order, for "you are #3"
HITS: dict[str, deque] = defaultdict(deque)
STARTED = time.time()


class BuildReq(BaseModel):
    ra: float = Field(ge=0, lt=360)
    dec: float = Field(ge=-90, le=90)
    fov: float = Field(default=4.0, ge=1.0, le=30.0)
    name: str | None = Field(default=None, max_length=80)


def slug_for(ra: float, dec: float, fov: float) -> str:
    h = hashlib.sha1(f"{ra:.5f},{dec:.5f},{fov:.1f}".encode()).hexdigest()[:8]
    return f"live_{ra:.3f}_{dec:+.3f}_{h}".replace("+", "p").replace("-", "m").replace(".", "d")


def client_ip(request: Request) -> str:
    # Render (and most hosts) put the real visitor address first in X-Forwarded-For
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


def rate_ok(ip: str) -> tuple[bool, int]:
    now, q = time.time(), HITS[ip]
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= RATE:
        return False, int(3600 - (now - q[0]))
    q.append(now)
    return True, 0


def trim_cache():
    """Delete the oldest live scans until the cache fits in CACHE_MB."""
    packs = []
    for d in DATA.glob("live_*"):
        if (d / "manifest.json").exists():
            size = sum(f.stat().st_size for f in d.iterdir() if f.is_file())
            packs.append((d.stat().st_mtime, size, d))
    total = sum(p[1] for p in packs)
    for _, size, d in sorted(packs):
        if total <= CACHE_MB * 1e6:
            break
        shutil.rmtree(d, ignore_errors=True)
        total -= size


def run_job(slug: str, req: BuildReq):
    def progress(msg: str):
        with LOCK:
            JOBS[slug]["message"] = msg.strip()
    try:
        with LOCK:
            JOBS[slug].update(state="running", message="querying NASA IRSA", started=time.time())
        spherex.build_target(req.ra, req.dec, DATA / slug, fov_arcmin=min(req.fov, MAX_FOV),
                             name=req.name or f"RA {req.ra:.4f}, Dec {req.dec:+.4f}",
                             max_frames=MAX_FRAMES, workers=WORKERS,
                             progress=progress, extra={"source": "user coordinates"})
        build_cache.update_index()
        trim_cache()
        with LOCK:
            JOBS[slug].update(state="done", message="ready")
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(DATA / slug, ignore_errors=True)
        with LOCK:
            JOBS[slug].update(state="error", message=str(e)[:300])


def worker():
    while True:
        slug, req = QUEUE.get()
        with LOCK:
            if slug in WAITING:
                WAITING.remove(slug)
        run_job(slug, req)
        QUEUE.task_done()


threading.Thread(target=worker, daemon=True).start()


@app.get("/api/health")
def health():
    with LOCK:
        running = [s for s, j in JOBS.items() if j.get("state") == "running"]
    return {"ok": True, "queue": len(WAITING), "running": len(running), "uptime_s": int(time.time() - STARTED),
            "limits": {"max_frames": MAX_FRAMES, "max_fov_arcmin": MAX_FOV, "scans_per_hour": RATE}}


@app.get("/api/resolve")
def resolve(name: str):
    if len(name) > 80:
        raise HTTPException(400, "name too long")
    try:
        ra, dec, info = spherex.resolve_with_motion(name, build_cache.SURVEY_EPOCH)
        return {"ra": ra, "dec": dec, "name": name, **info}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"Could not resolve {name!r}: {e}")


def _status(slug: str) -> dict:
    j = dict(JOBS.get(slug, {}))
    if j.get("state") == "queued":
        j["position"] = list(WAITING).index(slug) + 1 if slug in WAITING else 1
    return j


@app.post("/api/build")
def build(req: BuildReq, request: Request):
    req.fov = min(req.fov, MAX_FOV)
    slug = slug_for(req.ra, req.dec, req.fov)
    with LOCK:
        if (DATA / slug / "manifest.json").exists():
            os.utime(DATA / slug)  # keep popular scans in the cache
            JOBS[slug] = {"state": "done", "message": "cached"}
            return {"slug": slug, **JOBS[slug]}
        if JOBS.get(slug, {}).get("state") in ("queued", "running"):
            return {"slug": slug, **_status(slug)}
        ok, wait = rate_ok(client_ip(request))
        if not ok:
            raise HTTPException(429, f"Scan limit reached ({RATE} new scans per hour). Try again in {wait // 60 + 1} min, "
                                     "or open an area someone already scanned.")
        JOBS[slug] = {"state": "queued", "message": "waiting for the scanner", "queued_at": time.time()}
        WAITING.append(slug)
        QUEUE.put((slug, req))
        return {"slug": slug, **_status(slug)}


@app.get("/api/status/{slug}")
def status(slug: str):
    with LOCK:
        if (DATA / slug / "manifest.json").exists() and JOBS.get(slug, {}).get("state") != "running":
            return {"state": "done", "message": "cached"}
        if slug not in JOBS:
            raise HTTPException(404, "unknown job")
        return _status(slug)


@app.get("/api/packs")
def packs():
    """Areas scanned on this server (newest first), so visitors can revisit them."""
    out = []
    for d in DATA.glob("live_*"):
        try:
            import json
            m = json.loads((d / "manifest.json").read_text())
            out.append({"slug": d.name, "name": m.get("name"), "ra": m["ra"], "dec": m["dec"], "fov_arcmin": m["fov_arcmin"],
                        "n_frames": len(m["frames"]), "n_epochs": len(m["epochs"]), "built": d.stat().st_mtime})
        except Exception:  # noqa: BLE001
            continue
    return {"packs": sorted(out, key=lambda p: -p["built"])[:200]}


# The viewer itself (must be mounted last). Scanned packs are served from /data/<slug>/.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
