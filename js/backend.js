/**
 * CFB Pickems — Backend Adapter (Phase II)
 * =========================================
 * Talks to the Google Apps Script web app and keeps an in-memory mirror of all
 * storage keys so the rest of the app can keep using SYNCHRONOUS load()/save().
 *
 * Why a mirror?
 *   The whole app was built around synchronous localStorage. Rewriting every
 *   call site to be async would be a huge, risky change. Instead:
 *     - At startup we pull the full snapshot ONCE (async) into `_cache`.
 *     - storage.js reads/writes `_cache` synchronously (instant, like before).
 *     - Writes are also queued and pushed to the Sheet (debounced) in the
 *       background. Last-write-wins, which is fine for a small league.
 *
 * Modes (storage.js decides which to use based on settings.storageMode):
 *   - 'local'         : pure localStorage (default; offline; per-device)
 *   - 'googleSheets'  : this adapter (shared across devices)
 *
 * Config lives in localStorage (so it survives reloads and never ships in source):
 *   cfbp_backend_config = { url, token }
 */

const CFG_KEY = 'cfbp_backend_config';

/**
 * v0.16.0 — SNAPSHOT MIRROR (boot-performance fix).
 * After every successful hydrate/push, the full key/value snapshot is persisted
 * to localStorage under MIRROR_KEY. On the NEXT boot, primeFromMirror() loads
 * it synchronously so the app renders league data in <1s instead of blocking
 * on a Google Apps Script cold start (measured 10–20s).
 *
 * This is NOT a silent storage fallback (loud-fail decision still holds):
 *  - the UI shows a visible "Syncing…" badge until the background hydrate lands;
 *  - if that hydrate FAILS, the persistent red banner appears exactly as before;
 *  - pushes are HELD while stale (see flushPush) so a stale mirror can never
 *    overwrite fresher remote data — local edits are rebased onto the fresh
 *    snapshot when hydrate completes, then pushed.
 */
const MIRROR_KEY = 'cfbp_sheet_mirror';
let _stale = false;            // true = serving mirror data, hydrate not yet landed

const _cache = new Map();      // key -> parsed value (the synchronous mirror)
let _ready = false;            // true once hydrated from the Sheet
let _config = null;            // { url, token }
let _pushTimer = null;
const _dirty = new Set();      // keys changed since last push
const _listeners = new Set();  // status change subscribers

// Sync observability — exposed via getSyncStatus() so the UI can render a
// human-readable "synced 12s ago" / "3 pending writes" / "last error: …" panel.
let _lastSyncAt = null;        // ISO timestamp of last successful push or pull
let _lastError = null;         // last error message or null

export function getSyncStatus() {
  return {
    ready: _ready,
    configured: !!(getBackendConfig() && getBackendConfig().url),
    lastSyncAt: _lastSyncAt,
    lastError: _lastError,
    pendingWrites: _dirty.size,
  };
}

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Load deployed config from `config.json` next to the published site.
 * This is the "Option A" auto-connect path — the commissioner sets the URL +
 * token ONCE in config.json before deploying, and every device that opens
 * the site picks it up automatically. No per-device setup, no Commissioner
 * panel visit, no token sharing.
 *
 * Returns:
 *   { ok: true,  url, token }              — config.json exists, has values
 *   { ok: false, reason: 'missing' }       — file 404 or fetch failed
 *   { ok: false, reason: 'empty' }         — file exists but values blank
 *   { ok: false, reason: 'malformed', error } — file exists but invalid JSON
 *
 * The caller (boot in app.js) decides what to do with each outcome — typically
 * 'empty' or 'missing' → silent fall back to local mode (a fork-friendly
 * default), while real connection errors get surfaced loudly to the user.
 */
export async function loadDeployedConfig() {
  try {
    // Cache-bust on every load so a fresh deploy is picked up immediately
    const res = await fetch('config.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: 'missing' };
    const data = await res.json();
    const url = (data?.backendUrl || '').trim();
    const token = (data?.backendToken || '').trim();
    if (!url || !token) return { ok: false, reason: 'empty' };
    return { ok: true, url, token };
  } catch (err) {
    return { ok: false, reason: 'malformed', error: String(err.message || err) };
  }
}

export function getBackendConfig() {
  if (_config) return _config;
  try { _config = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); }
  catch { _config = null; }
  return _config;
}
export function setBackendConfig(url, token) {
  _config = { url: (url || '').trim().replace(/\/$/, ''), token: (token || '').trim() };
  localStorage.setItem(CFG_KEY, JSON.stringify(_config));
  return _config;
}
export function clearBackendConfig() {
  _config = null;
  localStorage.removeItem(CFG_KEY);
}
export function isBackendConfigured() {
  const c = getBackendConfig();
  return !!(c && c.url && c.token);
}
export function isBackendReady() { return _ready; }

export function isMirrorStale() { return _stale; }

/**
 * Synchronously load the last-known snapshot into the in-memory cache.
 * Returns the number of keys primed (0 = no mirror; caller must await hydrate
 * before rendering league data). Marks the backend "ready but stale".
 */
export function primeFromMirror() {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return 0;
    const snap = JSON.parse(raw);
    if (!snap || typeof snap.data !== 'object') return 0;
    _cache.clear();
    Object.entries(snap.data).forEach(([k, v]) => _cache.set(k, v));
    _ready = true;
    _stale = true;
    _lastSyncAt = snap.at || null;
    return _cache.size;
  } catch (e) {
    console.warn('[backend] mirror unreadable, ignoring', e);
    return 0;
  }
}

function persistMirror() {
  try {
    const data = {};
    _cache.forEach((v, k) => { data[k] = v; });
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ at: new Date().toISOString(), data }));
  } catch (e) { console.warn('[backend] mirror persist failed', e); }
}

export function clearMirror() { try { localStorage.removeItem(MIRROR_KEY); } catch {} }

// ── Status events (so the UI can show a sync indicator) ────────────────────────
export function onBackendStatus(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function emit(status, detail) { _listeners.forEach(fn => { try { fn(status, detail); } catch {} }); }

// ── Low-level transport ─────────────────────────────────────────────────────
async function call(action, payload = {}) {
  const c = getBackendConfig();
  if (!c || !c.url) throw new Error('Backend not configured');
  const body = JSON.stringify({ action, token: c.token, ...payload });
  // Apps Script web apps accept text/plain without a CORS preflight, which
  // avoids the OPTIONS request that Apps Script does not handle.
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Backend error');
  return data;
}

// ── Connection test ───────────────────────────────────────────────────────────
export async function pingBackend() {
  try {
    const data = await call('ping');
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ── Hydrate the in-memory mirror from the Sheet ────────────────────────────────
export async function hydrate() {
  emit('syncing');
  try {
    const data = await call('getAll');
    // Capture any local edits made while stale (dirty keys) BEFORE clearing,
    // then re-apply them over the fresh snapshot — user intent wins for keys
    // they touched this session; everything else takes the fresh remote value.
    const localEdits = new Map();
    _dirty.forEach(k => { if (_cache.has(k)) localEdits.set(k, _cache.get(k)); });
    _cache.clear();
    Object.entries(data.data || {}).forEach(([k, v]) => _cache.set(k, v));
    localEdits.forEach((v, k) => _cache.set(k, v));
    _ready = true;
    _stale = false;
    _lastSyncAt = new Date().toISOString();
    _lastError = null;
    persistMirror();
    emit('synced', { keys: _cache.size });
    // Any held-back stale writes can now flush safely.
    if (_dirty.size) schedulePush();
    return _cache.size;
  } catch (err) {
    _lastError = String(err.message || err);
    emit('error', { error: _lastError });
    throw err;
  }
}

/**
 * Seed an EMPTY backend from a local snapshot (first-time migration).
 * Only writes keys the backend doesn't already have, unless force=true.
 */
export async function seedFromLocal(localSnapshot, force = false) {
  const remote = (await call('getAll')).data || {};
  const entries = {};
  Object.entries(localSnapshot).forEach(([k, v]) => {
    if (force || !(k in remote)) entries[k] = v;
  });
  if (Object.keys(entries).length) await call('setMany', { entries });
  return Object.keys(entries).length;
}

// ── Synchronous cache accessors (used by storage.js when in sheets mode) ───────
export function cacheGet(key) {
  return _cache.has(key) ? _cache.get(key) : null;
}
export function cacheSet(key, value) {
  _cache.set(key, value);
  _dirty.add(key);
  schedulePush();
}

// ── Debounced background push to the Sheet ─────────────────────────────────────
function schedulePush() {
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(flushPush, 800);
}
export async function flushPush() {
  if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
  if (!_dirty.size) return { pushed: 0 };
  // HOLD writes while serving stale mirror data — pushing a full blob based on
  // a stale snapshot could clobber fresher remote data. Dirty keys stay queued
  // and are rebased + flushed automatically when hydrate() lands.
  if (_stale) return { pushed: 0, held: true };
  // If the backend isn't configured (e.g. user disconnected mid-session), keep
  // the dirty set for later and bail quietly instead of throwing.
  const c = getBackendConfig();
  if (!c || !c.url) return { pushed: 0, skipped: true };
  const entries = {};
  _dirty.forEach(k => { entries[k] = _cache.has(k) ? _cache.get(k) : null; });
  _dirty.clear();
  emit('syncing');
  try {
    await call('setMany', { entries });
    _lastSyncAt = new Date().toISOString();
    _lastError = null;
    persistMirror();
    emit('synced', { pushed: Object.keys(entries).length });
    return { pushed: Object.keys(entries).length };
  } catch (err) {
    // Re-mark dirty so a later push retries
    Object.keys(entries).forEach(k => _dirty.add(k));
    _lastError = String(err.message || err);
    emit('error', { error: _lastError });
    throw err;
  }
}

// ── Manual full refresh (pull) ─────────────────────────────────────────────────
export async function refreshFromBackend() { return hydrate(); }

// ── Season snapshots / backups ─────────────────────────────────────────────────
export async function createSnapshot(label = '') { return call('snapshot', { label }); }
export async function listSnapshots() { return (await call('listSnapshots')).snapshots || []; }
export async function restoreSnapshot(id) { const r = await call('restoreSnapshot', { id }); await hydrate(); return r; }


// ── Chat transport (v0.16.0) ───────────────────────────────────────────────────
// The chat log does NOT ride the debounced blob push — it has its own
// append + incremental-fetch endpoints so six concurrent authors can never
// clobber each other (append-only, server-assigned seq, id-level dedupe).

export async function chatAppendRemote(events) {
  const r = await call('chatAppend', { events });
  return { assigned: r.assigned || [], head: r.head ?? 0 };
}
export async function chatSinceRemote(afterSeq, limit = 500) {
  const r = await call('chatSince', { seq: afterSeq, limit });
  return { events: r.events || [], head: r.head ?? 0 };
}
export async function chatBeforeRemote(beforeSeq, limit = 100) {
  const r = await call('chatBefore', { seq: beforeSeq, limit });
  return { events: r.events || [], head: r.head ?? 0 };
}
