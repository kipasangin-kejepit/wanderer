# Classification database (Google Sheet + Apps Script)

"Spot the Wanderer" sends each finished field straight to a Google Sheet, like Zooniverse saves classifications to its database. There's no form to fill in, and it's free. The sheet lives in the team Google account.

## Setup (about 10 minutes)

1. Open sheets.google.com with the team account and create a sheet called **Wanderer classifications**.
2. Go to **Extensions → Apps Script**. Delete what's there, paste in all of `Code.gs`, and **Save**.
3. Click **Deploy → New deployment**. At the gear icon, pick **Web app**, then set:
   - Execute as: **Me**
   - Who has access: **Anyone**
   Click **Deploy**, allow the permissions (Google warns because it's your own unverified script; choose *Advanced → Go to …*), then **copy the Web app URL** (`https://script.google.com/macros/s/…/exec`).
4. Paste that URL into `web/config.js`:
   ```js
   window.WANDERER_SUBMIT = window.WANDERER_SUBMIT || "https://script.google.com/macros/s/…/exec";
   ```
5. Test: open the URL in a browser. It should say `{"ok":true,...}`. Then scan one field on the site, and two tabs appear in the sheet: **Classifications** and **Marks**.

After editing `Code.gs`, keep the same URL by redeploying with **Deploy → Manage deployments → ✏️ → Version: New version**.

## Reading the results

- **Marks → filter `matched` = `none`**: marks that match no practice mover, no catalogued fast star and no computer detection. These are what the team reviews; open them with the `open_in_wanderer` link (put the site URL in front, e.g. `https://<you>.github.io/wanderer/` + the link).
- **Classifications**: `hidden_found / hidden_total` tells you how good volunteers are at spotting practice movers.
- Several sessions marking the same RA/Dec = community consensus worth checking.

## Limits (honest)

- Anyone with the URL can post. The script rejects malformed data and more than 50 marks per field, and the site sends at most one field every 4 seconds. A determined spammer could still add rows; for a hackathon that's acceptable, and rows are easy to filter by session.
- Visitors are anonymous: we store a random session id and the browser name, no names, emails or IP addresses.
