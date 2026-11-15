# Putting Wanderer on the internet

Two pieces, both free:

| Piece | Where | What it does |
|---|---|---|
| **Website** (`web/`) | GitHub Pages | Home: Spot the Wanderer (`index.html`). Sky explorer: `explore.html` (starmap, sky view, the 7 built-in targets, all the analysis) |
| **Scan server** (`server.py`) | Render (free web service) | Fetches SPHEREx images for *any* coordinates (✦ Uncharted, "Initiate SPHEREx scan here", typed coordinates) |

The website works on its own, and a weekly GitHub Actions job adds fresh SPHEREx sky to Spot the Wanderer by itself (free, no card). The scan server is optional: it only lets visitors scan *any* coordinates on demand. Render may ask for a card to verify; you can skip section 3–4 entirely.

---

## 1 · Put the code on GitHub

1. Make a GitHub account (use the team Gmail).
2. Click **+ → New repository**, name it `wanderer`, set it to **Public**, and click **Create**.
3. On the new repo page, click **uploading an existing file**. Drag in **everything inside** `spherex-tool/`, including the hidden `.github` folder, then click **Commit changes**.
   - The data folder is ~280 MB, so the browser upload may choke. **GitHub Desktop** is easier, and it also brings the hidden `.github` folder along: **File → Add local repository →** pick `spherex-tool` → **Publish**.

## 2 · Turn on the website (GitHub Pages)

1. In the repo, go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Go to the **Actions** tab. "Deploy viewer to GitHub Pages" runs in about a minute.
3. Your site is at `https://<your-username>.github.io/wanderer/`.

## 3 · Start the scan server (Render)

1. Sign up at render.com with the same GitHub account.
2. Click **New → Blueprint** and pick the `wanderer` repo. Render reads `render.yaml` and creates **wanderer-api** on the free plan.
3. Wait for the first build (about 5 minutes). Then open `https://wanderer-api-XXXX.onrender.com/api/health`. It should show `{"ok":true,...}`.

## 4 · Connect the two

1. Edit `web/config.js` in GitHub (click the file, then the pencil):
   ```js
   window.WANDERER_API = window.WANDERER_API || "https://wanderer-api-XXXX.onrender.com";
   ```
2. Commit. Pages redeploys by itself.
3. Optional, for safety: in Render **Environment**, set `WANDERER_ORIGINS` to `https://<your-username>.github.io`, so only your site can use the server.

## What to expect on the free tier

- **It naps.** After 15 minutes with no visitors, the server sleeps. The first visitor after that sees "Waking up the scan server…" for about a minute.
- **One scan at a time.** A new area takes about 2–5 minutes (up to 120 SPHEREx frames). Other visitors wait in a queue and see their position.
- **3 new scans per visitor per hour.** Areas someone already scanned open instantly and don't count.
- **Scans are temporary.** Render's free disk is wiped when the server restarts or sleeps for long. The 7 built-in targets live on GitHub Pages and never disappear.
- **750 free hours a month.** That's enough for one service running all month.

Knobs (Render → Environment): `WANDERER_MAX_FRAMES`, `WANDERER_MAX_FOV`, `WANDERER_RATE`, `WANDERER_CACHE_MB`, `WANDERER_WORKERS`, `WANDERER_ORIGINS`.

## Running everything on your own laptop instead

```powershell
cd spherex-tool
python -m pip install -r requirements.txt
python -m uvicorn server:app --port 8000
```
Open http://localhost:8000. The site and the scan server run together, and `config.js` stays empty.
