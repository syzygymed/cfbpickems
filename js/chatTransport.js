/**
 * chatTransport.js — v0.17.0
 * ============================
 * THE ONLY module that talks to the chat backend. (AD-16: transport isolation.)
 * Exposes exactly the interface from the revised chat spec:
 *
 *   appendEvents(events)   -> { assigned:[{id,seq,ts}], head }
 *   fetchSince(seq, limit) -> { events, head }
 *   fetchBefore(seq,limit) -> { events }
 *   fetchHead()            -> { head }
 *   subscribe(onEvents)    -> unsubscribe()          (polling impl today; websocket later)
 *   heartbeat(playerId, lastSeenSeq) -> { present:[{playerId,ts,seen}] }
 *
 * No other module may reference Apps Script URLs, sheet names, or polling
 * mechanics. Swapping this file for a Supabase implementation is the entire
 * client-side migration.
 *
 * Transport details (Apps Script implementation):
 *  - Reads (head/since/before/presence/metrics) go over GET with query params —
 *    simple requests, no CORS preflight, and they hit the server-side
 *    CacheService fast paths.
 *  - Writes (append) go over POST with Content-Type text/plain — the same
 *    preflight-free pattern the picks sync has used in production since v0.15.
 *  - STALE-DEPLOYMENT DETECTION (the v0.16 chat-outage root cause): if the
 *    deployed Apps Script predates the chat endpoints, every call returns
 *    `Unknown action: …`. We classify that specific failure so the UI can say
 *    "redeploy Code.gs" instead of a generic offline banner.
 */

import { getBackendConfig, isBackendConfigured } from './backend.js';

export class StaleDeploymentError extends Error {
  constructor(action) {
    super(`Backend deployment is out of date (no '${action}' endpoint). ` +
          `Open Apps Script → Deploy → Manage deployments → Edit → New version.`);
    this.name = 'StaleDeploymentError';
    this.stale = true;
  }
}

function classify(action, err) {
  if (/unknown action/i.test(String(err?.message || err))) return new StaleDeploymentError(action);
  return err;
}

async function get(action, params = {}) {
  const c = getBackendConfig();
  if (!c || !c.url) throw new Error('Backend not configured');
  const u = new URL(c.url);
  u.searchParams.set('action', action);
  u.searchParams.set('token', c.token || '');
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) u.searchParams.set(k, String(v)); });
  const res = await fetch(u.toString(), { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw classify(action, new Error(data.error || 'Backend error'));
  return data;
}

async function post(action, payload = {}) {
  const c = getBackendConfig();
  if (!c || !c.url) throw new Error('Backend not configured');
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: c.token, ...payload }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw classify(action, new Error(data.error || 'Backend error'));
  return data;
}

// ── Interface ────────────────────────────────────────────────────────────────

export async function appendEvents(events) {
  const r = await post('chatAppend', { events });
  return { assigned: r.assigned || [], head: r.head ?? 0 };
}

export async function fetchSince(seq, limit = 300) {
  const r = await get('chatSince', { seq, limit });
  return { events: r.events || [], head: r.head ?? 0 };
}

export async function fetchBefore(seq, limit = 100) {
  const r = await get('chatBefore', { seq, limit });
  return { events: r.events || [] };
}

export async function fetchHead() {
  const r = await get('chatHead');
  return { head: r.head ?? 0 };
}

export async function heartbeat(playerId, lastSeenSeq = 0) {
  const r = await get('presence', { player: playerId, seen: lastSeenSeq });
  return { present: r.present || [] };
}

export async function fetchMetrics(days = 7) {
  const r = await get('chatMetrics', { days });
  return { rows: r.rows || [] };
}

/**
 * subscribe(onEvents, opts) — polling implementation of a push interface.
 * Two-phase: polls the cheap cached head; only calls fetchSince when the head
 * has actually advanced. Adaptive interval + ±20% jitter + hidden-pause live
 * HERE (transport concern), so a websocket swap deletes them wholesale.
 *
 * opts.getMode()      -> 'hot' | 'warm' | 'idle' | 'closed'   (room activity, supplied by chat.js)
 * opts.getKnownHead() -> highest seq already ingested
 * opts.onStatus(s, detail) -> 'online' | 'offline' | 'error'
 */
const INTERVALS = { hot: 5000, warm: 15000, idle: 45000, closed: 60000 };

export function subscribe(onEvents, opts = {}) {
  let timer = null, stopped = false, fails = 0, backoff = 0;

  const jitter = ms => Math.round(ms * (0.8 + Math.random() * 0.4));
  const delay = () => backoff || jitter(INTERVALS[opts.getMode?.() || 'idle'] || 45000);

  async function tick() {
    if (stopped) return;
    if (!isBackendConfigured() || (typeof document !== 'undefined' && document.hidden)) return schedule();
    try {
      const known = opts.getKnownHead?.() || 0;
      const { head } = await fetchHead();
      if (head > known) {
        const { events, head: h2 } = await fetchSince(known, 500);
        onEvents(events, h2);
      }
      if (fails >= 3) opts.onStatus?.('online');
      fails = 0; backoff = 0;
    } catch (err) {
      fails++;
      backoff = Math.min(60000, [0, 2000, 5000, 15000][fails] || 60000);
      if (fails === 3 || err?.stale) opts.onStatus?.('offline', { error: String(err?.message || err), stale: !!err?.stale });
    }
    schedule();
  }

  function schedule() { if (!stopped) timer = setTimeout(tick, delay()); }

  const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) { clearTimeout(timer); tick(); } };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  };
}
