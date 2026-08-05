/**
 * CFB Pickems — Google Apps Script Backend (Phase II)
 * =====================================================
 * A tiny key/value store backed by a Google Sheet, exposed as a web app.
 * The client (storage.js → backend.js) keeps the SAME key names it uses in
 * localStorage; this script just persists those JSON blobs so every player's
 * device shares one source of truth.
 *
 * DATA MODEL
 *   One Google Sheet named "CFBP_STORE" with a header row:
 *       key | json | updatedAt
 *   Each app storage key (cfbp_players, cfbp_weeks, cfbp_games, …) is one row.
 *   The "json" cell holds the stringified value. That's it — simple and robust.
 *
 *   A second optional tab "CFBP_SNAPSHOTS" stores timestamped full backups
 *   (one row per backup) so you can roll back a season.
 *
 * SECURITY
 *   - A shared SECRET token gates all writes (and reads, if you set
 *     REQUIRE_TOKEN_FOR_READ = true). The token lives in Script Properties,
 *     NOT in the client source. The client sends it in the request body.
 *   - This is "good enough" for a private friends league. It is NOT bank-grade.
 *     Anyone with the token + URL can read/write. Keep the URL private.
 *
 * ENDPOINTS (all POST to the web-app URL; GET supported for quick health check)
 *   action: "ping"      -> { ok:true, time }
 *   action: "getAll"    -> { ok:true, data:{ key: value, ... } }
 *   action: "get"       -> { key }                 -> { ok:true, key, value }
 *   action: "set"       -> { key, value }          -> { ok:true }
 *   action: "setMany"   -> { entries:{k:v,...} }   -> { ok:true, count }
 *   action: "snapshot"  -> { label? }              -> { ok:true, id }
 *   action: "listSnapshots" ->                     -> { ok:true, snapshots:[...] }
 *   action: "restoreSnapshot" -> { id }            -> { ok:true }
 *
 * SETUP — see backend/SETUP.md for the click-by-click. In short:
 *   1. Create a Google Sheet, Extensions → Apps Script, paste this file.
 *   2. Run setup() once (creates tabs + a random token; grant permissions).
 *   3. Deploy → New deployment → Web app → Execute as: Me,
 *      Who has access: Anyone → copy the /exec URL.
 *   4. Read the token: run logToken() and copy it from the execution log,
 *      OR open Project Settings → Script Properties.
 *   5. Paste URL + token into the app's Commissioner → Backend settings.
 */

// ── Config ────────────────────────────────────────────────────────────────────
var STORE_SHEET    = 'CFBP_STORE';
var SNAP_SHEET     = 'CFBP_SNAPSHOTS';
var REQUIRE_TOKEN_FOR_READ = false;   // set true to also gate reads
var TOKEN_PROP     = 'CFBP_TOKEN';

// ── One-time setup ──────────────────────────────────────────────────────────
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var store = ss.getSheetByName(STORE_SHEET);
  if (!store) {
    store = ss.insertSheet(STORE_SHEET);
    store.getRange(1, 1, 1, 3).setValues([['key', 'json', 'updatedAt']]);
    store.setFrozenRows(1);
  }
  var snap = ss.getSheetByName(SNAP_SHEET);
  if (!snap) {
    snap = ss.insertSheet(SNAP_SHEET);
    snap.getRange(1, 1, 1, 4).setValues([['id', 'label', 'json', 'createdAt']]);
    snap.setFrozenRows(1);
  }
  // Generate a token if none exists
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(TOKEN_PROP)) {
    var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty(TOKEN_PROP, token);
  }
  Logger.log('Setup complete. Token: ' + props.getProperty(TOKEN_PROP));
  return 'OK';
}

function logToken() {
  Logger.log('CFBP token: ' + PropertiesService.getScriptProperties().getProperty(TOKEN_PROP));
}

// Optional: rotate the token (invalidates all existing clients)
function rotateToken() {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROP, token);
  Logger.log('New token: ' + token);
  return token;
}

// ── HTTP entry points ─────────────────────────────────────────────────────────
function doGet(e) {
  // Health check / simple read via querystring (?action=ping)
  return handle(e && e.parameter ? e.parameter : {}, true);
}
function doPost(e) {
  var body = {};
  try { body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {}; }
  catch (err) { return json({ ok: false, error: 'Bad JSON body' }); }
  return handle(body, false);
}

function handle(req, isGet) {
  var action = req.action || 'ping';

  if (action === 'ping') {
    return json({ ok: true, time: new Date().toISOString(), service: 'cfbp-backend', version: 1 });
  }

  var token = PropertiesService.getScriptProperties().getProperty(TOKEN_PROP);
  var writeActions = { set: 1, setMany: 1, snapshot: 1, restoreSnapshot: 1 };
  var needsToken = writeActions[action] || REQUIRE_TOKEN_FOR_READ;
  if (needsToken && req.token !== token) {
    return json({ ok: false, error: 'Unauthorized' });
  }

  try {
    switch (action) {
      case 'getAll':          return json({ ok: true, data: getAll() });
      case 'get':             return json({ ok: true, key: req.key, value: getOne(req.key) });
      case 'set':             setOne(req.key, req.value); return json({ ok: true });
      case 'setMany':         return json({ ok: true, count: setMany(req.entries || {}) });
      case 'snapshot':        return json({ ok: true, id: makeSnapshot(req.label || '') });
      case 'listSnapshots':   return json({ ok: true, snapshots: listSnapshots() });
      case 'restoreSnapshot': restoreSnapshot(req.id); return json({ ok: true });
      default:                return json({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ── Store helpers ───────────────────────────────────────────────────────────
function storeSheet() {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STORE_SHEET);
  if (!s) throw new Error('Store not initialized — run setup() first.');
  return s;
}

function getAll() {
  var s = storeSheet();
  var values = s.getDataRange().getValues();
  var out = {};
  for (var i = 1; i < values.length; i++) {
    var key = values[i][0];
    if (!key) continue;
    var raw = values[i][1];
    out[key] = raw === '' || raw === null ? null : safeParse(raw);
  }
  return out;
}

function getOne(key) {
  var s = storeSheet();
  var values = s.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === key) {
      var raw = values[i][1];
      return raw === '' || raw === null ? null : safeParse(raw);
    }
  }
  return null;
}

function setOne(key, value) {
  if (!key) throw new Error('Missing key');
  var s = storeSheet();
  var values = s.getDataRange().getValues();
  var str = JSON.stringify(value);
  var now = new Date().toISOString();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === key) {
      s.getRange(i + 1, 2, 1, 2).setValues([[str, now]]);
      return;
    }
  }
  s.appendRow([key, str, now]);
}

function setMany(entries) {
  var s = storeSheet();
  var values = s.getDataRange().getValues();
  var rowByKey = {};
  for (var i = 1; i < values.length; i++) rowByKey[values[i][0]] = i + 1;
  var now = new Date().toISOString();
  var count = 0;
  Object.keys(entries).forEach(function (key) {
    var str = JSON.stringify(entries[key]);
    if (rowByKey[key]) {
      s.getRange(rowByKey[key], 2, 1, 2).setValues([[str, now]]);
    } else {
      s.appendRow([key, str, now]);
    }
    count++;
  });
  return count;
}

// ── Snapshots (season backups / rollback) ─────────────────────────────────────
function snapSheet() {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SNAP_SHEET);
  if (!s) throw new Error('Snapshots not initialized — run setup() first.');
  return s;
}

function makeSnapshot(label) {
  var all = getAll();
  var id = 'snap_' + Date.now();
  snapSheet().appendRow([id, label || '', JSON.stringify(all), new Date().toISOString()]);
  return id;
}

function listSnapshots() {
  var s = snapSheet();
  var values = s.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    out.push({ id: values[i][0], label: values[i][1], createdAt: values[i][3] });
  }
  return out.reverse(); // newest first
}

function restoreSnapshot(id) {
  if (!id) throw new Error('Missing snapshot id');
  var s = snapSheet();
  var values = s.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === id) {
      var data = safeParse(values[i][2]) || {};
      // Take a safety snapshot of current state before overwriting
      makeSnapshot('auto-before-restore-' + id);
      setMany(data);
      return;
    }
  }
  throw new Error('Snapshot not found: ' + id);
}

// ── Utils ──────────────────────────────────────────────────────────────────
function safeParse(raw) {
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
