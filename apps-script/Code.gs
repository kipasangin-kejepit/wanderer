/**
 * Wanderer classification database: a Google Sheet that receives every finished
 * "Spot the Wanderer" field directly from the website (no form to fill in).
 *
 * Two tabs are filled automatically:
 *   Classifications : one row per finished field (who = anonymous session id)
 *   Marks           : one row per mark, with RA/Dec and what it matched
 *                     (sim = practice mover, known = catalogued fast star,
 *                      computer = Find movers, none = NOTHING KNOWN: review these!)
 */
const MAX_MARKS = 50;

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const d = JSON.parse(e.postData.contents);
    // light validation so junk can't fill the sheet
    if (d.app !== 'wanderer' || typeof d.field !== 'string' || !Array.isArray(d.marks) || d.marks.length > MAX_MARKS) {
      return reply({ ok: false, error: 'bad payload' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const now = new Date();
    const session = String(d.session || '').slice(0, 40);
    const field = d.field.slice(0, 80);

    const credit = String(d.credit || '').replace(/^[=+\-@\s]+/, '').trim().slice(0, 40); // optional name for discovery credit; no formula injection
    const cls = sheet(ss, 'Classifications', ['received', 'session', 'field', 'marks', 'hidden_found', 'hidden_total', 'known_found', 'unmatched_marks', 'browser', 'credit_name']);
    cls.appendRow([now, session, field, d.marks.length, num(d.foundSims), num(d.sims), num(d.foundKnown), num(d.extra), String(d.ua || '').slice(0, 120), credit]);

    const mk = sheet(ss, 'Marks', ['received', 'session', 'field', 'x_px', 'y_px', 'ra_deg', 'dec_deg', 'matched', 'open_in_wanderer', 'credit_name']);
    const rows = d.marks.filter(validMark).map((m) => [now, session, field, num(m.x), num(m.y), num(m.ra), num(m.dec), String(m.match || 'none').slice(0, 12),
      `explore.html?target=${encodeURIComponent(String(d.slug || '').slice(0, 80))}&mode=diff&band=0&px=${Math.round(m.x)}&py=${Math.round(m.y)}`, credit]);
    if (rows.length) mk.getRange(mk.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() { return reply({ ok: true, service: 'wanderer-classifications' }); }

function sheet(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  // sheets made by an older version: add any missing header cells (e.g. credit_name)
  const have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  if (have.length < header.length) sh.getRange(1, 1, 1, header.length).setValues([header]);
  return sh;
}
function num(v) { const n = Number(v); return isFinite(n) ? n : ''; }
function validMark(m) { return m && isFinite(m.x) && isFinite(m.y) && isFinite(m.ra) && isFinite(m.dec) && m.ra >= 0 && m.ra < 360 && Math.abs(m.dec) <= 90; }
function reply(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
