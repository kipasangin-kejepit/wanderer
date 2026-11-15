/* Where the Wanderer scan server lives.
 *   ""  = same place as this page (local: uvicorn server:app)
 *   "https://YOUR-SERVICE.onrender.com" = the hosted server, when this page is on GitHub Pages
 * Leave it empty if you only run the static site; built-in targets still work. */
window.WANDERER_API = window.WANDERER_API || "";


/* Where "Spot the Wanderer" sends each finished field (anonymous marks), so the team
 * gets everyone's classifications in one Google Sheet. Paste the Apps Script web-app URL
 * (see apps-script/README.md). Leave "" to keep marks only in the visitor's browser. */
window.WANDERER_SUBMIT = window.WANDERER_SUBMIT || "https://script.google.com/macros/s/AKfycbxqLp-OcI1O5O7RuxsylC19igdxOQo1qm26d__H65aZj_fQe7yvp0dU0-IZvBRw42m_/exec";
