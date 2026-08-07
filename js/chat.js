/**
 * chat.js — v0.17.0 league chat engine (REVISED spec: one room + gameTag)
 * =======================================================================
 * ONE chronological message log. Every message may carry an optional gameTag
 * (a gameId). "Game threads" are filtered views of the one room — there is no
 * room you can fail to check.
 *
 *  - Append-only events: message / edit / delete / react / gamereact /
 *    unreact / system / pin / unpin
 *  - Client fold is ORDER-INDEPENDENT + IDEMPOTENT (AD-10). Events referencing
 *    unknown targets buffer until the target arrives. react/unreact resolve
 *    latest-wins per (emoji, author) — the naive toggle was RG-06.
 *  - Tag resolution (the cross-talk rule): reply inherits the parent's tag
 *    (even null); otherwise the current view's tag; otherwise null.
 *  - Notification classes: every event carries notify. Messages/replies/
 *    mention-responses notify; reactions, gamereacts, system events, and
 *    unprompted SCRIBE are ambient (render, never badge).
 *  - Transport lives ENTIRELY in chatTransport.js (AD-16). This module never
 *    sees a URL. Polling cadence is supplied to the transport via roomMode().
 *  - Outbox: optimistic send, 750ms coalescing window, retries with backoff,
 *    FAILED state after 3 attempts (never silently dropped), survives reload.
 *  - Loud-fail: transport reports offline after 3 consecutive failures; a
 *    stale-deployment error (the v0.16 outage root cause) is surfaced
 *    distinctly so the fix is actionable from the banner itself.
 */

import {
  appendEvents, subscribe, fetchBefore, StaleDeploymentError,
} from './chatTransport.js';
import { isBackendConfigured } from './backend.js';
// v0.17.3 — chat retention (UN-8x) reads settings.chatRetentionDays through
// the storage seam. Safe: storage.js imports only data-model.js + backend.js,
// neither of which imports chat.js, so this cannot cycle.
import { getSettings } from './storage.js';

// ── Device-local persistence keys (AD-12) ─────────────────────────────────────
const K_LASTSEEN = 'cfbp_chat_lastseen2';   // { seq, byTag: { gameId: seq } }
const K_OUTBOX   = 'cfbp_chat_outbox2';

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  items: new Map(),          // id -> folded item
  buffered: new Map(),       // targetId -> [events waiting for target]
  head: 0,
  outbox: [],                // [{ev, attempts}]
  failed: new Map(),         // id -> ev
  flushTimer: null,
  offline: false,
  staleDeployment: false,
  lastError: '',
  viewOpen: false,
  selfId: null,
  unsub: null,
  subs: new Set(),
  backfillLow: null,
};

function notify(kind, detail) { S.subs.forEach(fn => { try { fn(kind, detail); } catch {} }); }
export function onChat(fn) { S.subs.add(fn); return () => S.subs.delete(fn); }
export function chatStatus() {
  return { head: S.head, offline: S.offline, staleDeployment: S.staleDeployment,
           lastError: S.lastError, outbox: S.outbox.length, failed: S.failed.size,
           mode: roomMode() };
}

// ── Commissioner chat on/off toggle (batch 3+4 item A) ────────────────────────
// A synced setting (settings.chatEnabled, storage seam, AD-02) — NOT
// device-local, because every player must see the same on/off state. Default
// TRUE: chat is on today, and a missing value (every settings blob written
// before this field existed) must never silently disable it. `!== false`
// rather than a truthy check so any non-boolean garbage in an old blob still
// reads as enabled, not disabled (CONVENTIONS #7 — defensive coercion at a
// data boundary).
export function isChatEnabled() {
  return getSettings().chatEnabled !== false;
}

// ── Chat retention (UN-8x) — CLIENT-SIDE HIDE ONLY ────────────────────────────
// Drew's call, not the destructive variant: the backend (backend/Code.gs)
// exposes only chatAppend/chatSince/chatBefore/chatHead/chatMetrics — no
// row-removal endpoint — so a real "delete" would need a new endpoint and a
// redeploy (RG-09's exact failure mechanism) for a cosmetic gain at 6-player
// scale. Instead: messages older than the window stop RENDERING. Rows stay in
// the Sheet forever; flipping the setting back off restores the full history
// with zero data loss. A synced setting (goes through the storage seam via
// getSettings/saveSetting, AD-02) so every player sees the same window —
// never a device-local key. Default-when-missing: 0/absent = OFF.
export function getRetentionDays() {
  return Number(getSettings().chatRetentionDays) || 0;
}

/** Pinned (Hall of Records) messages are ALWAYS visible regardless of age —
 *  that is the entire point of pinning something. Never hidden by retention. */
export function isHiddenByRetention(m) {
  return _hiddenBy(retentionCutoff(), m);
}

/**
 * Resolve the retention cutoff ONCE, for callers that then test many messages.
 *
 * v0.17.2 perf: getRetentionDays() reads getSettings(), which spreads
 * DEFAULT_SETTINGS over a load() — and in local mode that is a JSON.parse per
 * call. isUnreadFor() runs per message, unreadCount() runs per pill (up to 11),
 * and updateChatBadges() runs on the poll loop, so calling it per-message cost
 * ~1.9ms per 800 messages even with retention OFF. Hoist it.
 *
 * Returns 0 when retention is disabled — callers treat 0 as "hide nothing".
 */
export function retentionCutoff() {
  const days = getRetentionDays();
  return days > 0 ? Date.now() - days * 86400000 : 0;
}

/** Pure predicate against a pre-resolved cutoff. Pinned is always visible. */
function _hiddenBy(cutoff, m) {
  if (!cutoff) return false;
  if (m?.pinned) return false;
  return (m?.ts || 0) < cutoff;
}

/** Commissioner Data-tab card stats: how many messages the current window
 *  WOULD hide/protect, and the date range they span. Purely informational —
 *  computing this never mutates anything. */
export function retentionStats() {
  const days = getRetentionDays();
  if (days <= 0) return { enabled: false, days: 0, hiddenCount: 0, protectedCount: 0, oldestTs: null, newestTs: null };
  const cutoff = Date.now() - days * 86400000;
  let hiddenCount = 0, protectedCount = 0, oldestTs = null, newestTs = null;
  S.items.forEach(m => {
    if (m.type !== 'message' || m.deleted) return;
    if ((m.ts || 0) >= cutoff) return;                 // not old enough to be affected either way
    if (m.pinned) { protectedCount++; return; }
    hiddenCount++;
    if (oldestTs === null || m.ts < oldestTs) oldestTs = m.ts;
    if (newestTs === null || m.ts > newestTs) newestTs = m.ts;
  });
  return { enabled: true, days, hiddenCount, protectedCount, oldestTs, newestTs };
}

// ── Fold ──────────────────────────────────────────────────────────────────────
function newItem(ev) {
  return { id: ev.id, seq: ev.seq ?? null, ts: ev.ts ?? ev._localTs ?? null,
           author: ev.author, gameTag: ev.gameTag || '', body: ev.body || '',
           replyTo: ev.replyTo || '', notify: !!ev.notify, meta: ev.meta || null,
           type: ev.type, edited: false, deleted: false, pinned: false,
           reactions: {}, local: !!ev.local,
           _editTs: 0, _reactOps: new Map(), _pinOps: new Map() };
}

function applyTo(target, ev) {
  const stamp = (ev.ts || 0) * 1e7 + (ev.seq || 0);
  if (ev.type === 'edit') {
    if (stamp >= target._editTs) { target.body = ev.body || ''; target.edited = true; target._editTs = stamp; }
  } else if (ev.type === 'delete') {
    target.deleted = true;
  } else if (ev.type === 'pin' || ev.type === 'unpin') {
    const cur = target._pinOps.get('pin');
    if (!cur || stamp >= cur.stamp) { target._pinOps.set('pin', { stamp }); target.pinned = ev.type === 'pin'; }
  } else if (ev.type === 'react' || ev.type === 'unreact') {
    // Latest-wins per (emoji, author) — order-independent (RG-06 guard).
    const emoji = ev.meta?.emoji; if (!emoji) return;
    const key = `${emoji}|${ev.author}`;
    const cur = target._reactOps.get(key);
    if (cur && cur.id === ev.id) return;
    if (cur && cur.stamp >= stamp) return;
    target._reactOps.set(key, { stamp, on: ev.type === 'react', id: ev.id });
    const next = {};
    target._reactOps.forEach((op, k) => {
      if (!op.on) return;
      const [em, author] = k.split('|');
      (next[em] = next[em] || []).push(author);
    });
    target.reactions = next;
  }
}

/** Ingest raw events from any source (poll, backfill, optimistic local). */
export function ingest(events, head) {
  if (typeof head === 'number' && head > S.head) S.head = head;
  let n = 0;
  for (const ev of events || []) {
    if (!ev || !ev.id) continue;
    if (typeof ev.seq === 'number' && ev.seq > S.head) S.head = ev.seq;
    if (typeof ev.seq === 'number') {
      S.backfillLow = S.backfillLow === null ? ev.seq : Math.min(S.backfillLow, ev.seq);
    }

    if (['message', 'system', 'gamereact'].includes(ev.type)) {
      const existing = S.items.get(ev.id);
      if (existing) {
        // Reconcile optimistic → server-assigned
        if (existing.seq === null && typeof ev.seq === 'number') {
          existing.seq = ev.seq; existing.ts = ev.ts ?? existing.ts; existing.local = false;
        }
      } else {
        const item = newItem(ev);
        S.items.set(ev.id, item);
        const waiting = S.buffered.get(ev.id);
        if (waiting) { waiting.forEach(w => applyTo(item, w)); S.buffered.delete(ev.id); }
        n++;
      }
    } else if (['edit', 'delete', 'react', 'unreact', 'pin', 'unpin'].includes(ev.type)) {
      const target = S.items.get(ev.targetId);
      if (target) applyTo(target, ev);
      else {
        if (!S.buffered.has(ev.targetId)) S.buffered.set(ev.targetId, []);
        // buffer idempotently by event id
        const buf = S.buffered.get(ev.targetId);
        if (!buf.some(b => b.id === ev.id)) buf.push(ev);
      }
    }
  }
  if (n || (events && events.length)) notify('events', { added: n });
  return n;
}

function orderKey(m) { return (m.ts || 0) * 1e7 + (m.seq || 0); }

/** Chronological list. filter: {tag:'all'|''|gameId, pinned, mentionsOf, types,
 *  respectRetention}. `respectRetention` is opt-in and defaults to false so
 *  existing non-display callers (the weekly digest, SCRIBE's pre-kick lookup)
 *  keep reading the full history unless they explicitly ask to be filtered —
 *  retention is a rendering preference, not a data-availability change. Chat
 *  page render paths pass `respectRetention: true`. */
export function getMessages(filter = {}) {
  const tag = filter.tag ?? 'all';
  const out = [];
  S.items.forEach(m => {
    if (filter.types && !filter.types.includes(m.type)) return;
    if (tag !== 'all' && (m.gameTag || '') !== tag) return;
    if (filter.pinned && !m.pinned) return;
    if (filter.respectRetention && isHiddenByRetention(m)) return;
    if (filter.mentionsOf) {
      const mentioned = (m.meta?.mentions || []).includes(filter.mentionsOf);
      const replyToMe = m.replyTo && S.items.get(m.replyTo)?.author === filter.mentionsOf;
      if (!(mentioned || replyToMe) || m.author === filter.mentionsOf) return;
    }
    out.push(m);
  });
  return out.sort((a, b) => orderKey(a) - orderKey(b));
}

export function getMessage(id) { return S.items.get(id) || null; }

// ── The cross-talk rule ───────────────────────────────────────────────────────
/** resolveTag({replyTo, viewTag}) — reply inherits parent tag (even null);
 *  else the current view's tag; else null. */
export function resolveTag({ replyTo = null, viewTag = '' } = {}) {
  if (replyTo) {
    const parent = S.items.get(replyTo);
    if (parent) return parent.gameTag || '';
  }
  return viewTag || '';
}

// ── Sending ───────────────────────────────────────────────────────────────────
function uuid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Generic event send. Deterministic ids (AD-11) make system/SCRIBE events
 *  exactly-once across six clients — the server dedupes on id. */
export function sendEvent(ev) {
  const full = {
    id: ev.id || uuid(), type: ev.type || 'message', author: ev.author || 'unknown',
    gameTag: ev.gameTag || '', body: (ev.body || '').slice(0, 1000),
    targetId: ev.targetId || '', replyTo: ev.replyTo || '',
    notify: !!ev.notify, meta: ev.meta || null,
    local: true, _localTs: Date.now(),
  };
  ingest([full]);                       // optimistic
  S.outbox.push({ ev: full, attempts: 0 });
  persistOutbox();
  scheduleFlush();
  return full.id;
}

export function sendMessage({ body, gameTag = '', replyTo = '', author, mentions = [], scribeReply = false }) {
  return sendEvent({
    type: 'message', body, gameTag, replyTo, author,
    notify: true,
    meta: mentions.length || scribeReply ? { mentions, ...(scribeReply ? { scribeReply: true } : {}) } : (null),
  });
}

export function editMessage(id, body, author) {
  const t = S.items.get(id); if (!t || t.author !== author) return null;
  return sendEvent({ type: 'edit', targetId: id, body, author, notify: false });
}
export function deleteMessage(id, author) {
  const t = S.items.get(id); if (!t || t.author !== author) return null;
  return sendEvent({ type: 'delete', targetId: id, author, notify: false });
}
export function toggleReact(targetId, emoji, author) {
  const t = S.items.get(targetId); if (!t) return null;
  const on = (t.reactions[emoji] || []).includes(author);
  return sendEvent({ type: on ? 'unreact' : 'react', targetId, author, notify: false, meta: { emoji } });
}
export function pinMessage(targetId, author, on = true) {
  return sendEvent({ type: on ? 'pin' : 'unpin', targetId, author, notify: false });
}
/** Ambient game-card emoji reaction, mirrored into the room (coalesced at render). */
export function sendGameReact(gameId, emoji, author) {
  return sendEvent({ type: 'gamereact', gameTag: gameId, author, notify: false, meta: { emoji } });
}

// ── Outbox ────────────────────────────────────────────────────────────────────
const FLUSH_COALESCE_MS = 750;
const MAX_ATTEMPTS = 3;

function persistOutbox() {
  try { localStorage.setItem(K_OUTBOX, JSON.stringify(S.outbox.map(o => o.ev))); } catch {}
}
function loadOutbox() {
  try {
    const arr = JSON.parse(localStorage.getItem(K_OUTBOX) || '[]');
    S.outbox = arr.map(ev => ({ ev, attempts: 0 }));
    ingest(arr.map(ev => ({ ...ev, local: true })));
  } catch { S.outbox = []; }
}
function scheduleFlush() {
  if (S.flushTimer) return;                       // coalescing window (spec §load 4)
  S.flushTimer = setTimeout(() => { S.flushTimer = null; flushOutbox(); }, FLUSH_COALESCE_MS);
}

export async function flushOutbox() {
  // "Off" means zero network activity, not just zero reads — a queued send
  // (e.g. a SCRIBE post staged from the commissioner panel while chat is
  // hidden) waits in the outbox, persisted, and flushes automatically the
  // moment chat is re-enabled. Nothing is lost (item A: "data is preserved").
  if (!S.outbox.length || !isBackendConfigured() || !isChatEnabled()) return;
  const batch = S.outbox.splice(0, S.outbox.length);
  try {
    const { assigned, head } = await appendEvents(batch.map(o => o.ev));
    const byId = new Map(assigned.map(a => [a.id, a]));
    batch.forEach(o => {
      const a = byId.get(o.ev.id);
      const item = S.items.get(o.ev.id);
      if (a && item) { item.seq = a.seq; if (a.ts) item.ts = a.ts; item.local = false; }
    });
    if (typeof head === 'number' && head > S.head) S.head = head;
    persistOutbox();
    notify('sent', { count: batch.length });
  } catch (err) {
    handleTransportError(err);
    batch.forEach(o => {
      o.attempts++;
      if (o.attempts >= MAX_ATTEMPTS) {
        S.failed.set(o.ev.id, o.ev);
        notify('failed', { id: o.ev.id });
      } else {
        S.outbox.push(o);
      }
    });
    persistOutbox();
    if (S.outbox.length) setTimeout(flushOutbox, 2000 * Math.max(1, batch[0]?.attempts || 1));
  }
}

export function retryFailed(id) {
  const ev = S.failed.get(id);
  if (!ev) return;
  S.failed.delete(id);
  S.outbox.push({ ev, attempts: 0 });
  persistOutbox();
  scheduleFlush();
  notify('events', {});
}
export function isFailed(id) { return S.failed.has(id); }
export function isPending(id) {
  const m = S.items.get(id);
  return !!m && m.local && !S.failed.has(id);
}

function handleTransportError(err) {
  S.lastError = String(err?.message || err);
  if (err instanceof StaleDeploymentError || err?.stale) {
    S.staleDeployment = true;
    if (!S.offline) { S.offline = true; notify('offline', { error: S.lastError, stale: true }); }
  }
}

// ── Subscription (adaptive polling lives in the transport) ────────────────────
export function roomMode() {
  if (!S.viewOpen) return 'closed';
  let latest = 0;
  S.items.forEach(m => { if (m.type !== 'system' && (m.ts || 0) > latest) latest = m.ts || 0; });
  const age = Date.now() - latest;
  if (age < 2 * 60000) return 'hot';
  if (age < 15 * 60000) return 'warm';
  return 'idle';
}

export function setViewOpen(open) { S.viewOpen = !!open; }
/** Back-compat shim for app.js ('active' when the chat tab is showing). */
export function setPollMode(mode) { setViewOpen(mode === 'active'); }

/** Force-(re)subscribes regardless of current subscription state — used by
 *  initChat() (selfId may have changed on re-login) and by the enabled-toggle
 *  when going from OFF to ON. Unconditional: callers gate on isChatEnabled(). */
function _subscribeNow() {
  if (S.unsub) S.unsub();
  S.unsub = subscribe(
    (events, head) => ingest(events, head),
    {
      getMode: roomMode,
      getKnownHead: () => S.head,
      onStatus: (s, detail) => {
        if (s === 'online') { S.offline = false; S.staleDeployment = false; notify('online'); }
        if (s === 'offline') {
          S.offline = true;
          if (detail?.stale) S.staleDeployment = true;
          S.lastError = detail?.error || '';
          notify('offline', detail);
        }
      },
    }
  );
}

export function initChat(selfId) {
  S.selfId = selfId || S.selfId;
  loadOutbox();
  // v0.17.2 — presence was removed; drop its orphaned device-local key so it
  // doesn't linger as a mystery on already-deployed devices.
  try { localStorage.removeItem('cfbp_chat_seenmap'); } catch {}
  // Batch 3+4 item A — chat OFF must mean ZERO network activity, not a slower
  // poll. roomMode()==='closed' still ticks every 60s forever (INTERVALS in
  // chatTransport.js) — that is NOT "stopped", it is "throttled", and it keeps
  // burning Apps Script quota indefinitely. Only NOT subscribing at all (no
  // timer scheduled) satisfies "stop chat polling entirely."
  if (isChatEnabled()) { _subscribeNow(); flushOutbox(); }
  else if (S.unsub) { S.unsub(); S.unsub = null; }
}

/**
 * Starts or stops the poll loop to match the current settings.chatEnabled
 * value. Idempotent — safe to call on every navigation and on a periodic
 * timer without thrashing an already-correct subscription (unlike initChat(),
 * which always force-resubscribes). This is the function the commissioner's
 * Settings toggle calls for an immediate same-device effect, and the one a
 * periodic UI-sync tick calls to catch a value that changed via hydrate.
 */
export function refreshChatEnabled() {
  const enabled = isChatEnabled();
  if (enabled && !S.unsub) { _subscribeNow(); flushOutbox(); }
  else if (!enabled && S.unsub) { S.unsub(); S.unsub = null; }
}

export async function backfill(limit = 100) {
  // Reachable only from the "load earlier" control, which is hidden while
  // chat is off — guarded anyway so a stray call can never cause traffic.
  if (!isBackendConfigured() || !isChatEnabled() || S.backfillLow === null || S.backfillLow <= 1) return 0;
  try {
    const { events } = await fetchBefore(S.backfillLow, limit);
    return ingest(events);
  } catch (err) { handleTransportError(err); return 0; }
}

// ── Presence + read receipts: REMOVED in v0.17.2 (AD-19 amended) ─────────────
// "N here now" and "seen by k" both rode a 90s CacheService heartbeat, so the
// indicator could be wrong by up to 90 seconds — someone who closed the app a
// minute ago still read as present. Spec §4.5: a wrong presence indicator is
// worse than none, and reliable "actively viewing" detection is not achievable
// on a polling transport. Do not re-add without re-opening AD-19.
//
// `lastSeenSeq` / getLastSeen / markSeen / unreadCount below are a SEPARATE
// feature (device-local unread counts, AD-12). Presence merely piggybacked on
// lastSeenSeq; unread tracking never depended on presence and still works.

// ── Unread (notifying events only — ambient never badges) ─────────────────────
export function getLastSeen() {
  try { return { seq: 0, byTag: {}, ...(JSON.parse(localStorage.getItem(K_LASTSEEN) || '{}')) }; }
  catch { return { seq: 0, byTag: {} }; }
}
function putLastSeen(v) { try { localStorage.setItem(K_LASTSEEN, JSON.stringify(v)); } catch {} }

/**
 * Advance the read position. MONOTONIC — a cursor never moves backward.
 *
 * v0.17.3 (caught in review, pre-deploy): this used to assign S.head
 * unconditionally. S.head is 0 until the first poll returns, and Apps Script
 * cold starts run 10-20s (ledger §5) while the chat mark timer fires at 1s.
 * A player who opened the app, tapped Chat during the cold start, and backed
 * out had their cursor reset to 0 — so every message they had already read
 * counted as unread again, and every game bubble lit up claiming unread they
 * cleared yesterday. Nothing in this app ever legitimately rewinds a cursor.
 *
 * Guarded by loadtest §[17b].
 */
export function markSeen(tag = 'all') {
  const ls = getLastSeen();
  const fwd = (cur) => Math.max(Number(cur) || 0, S.head);
  if (tag === 'all') {
    ls.seq = fwd(ls.seq);
    Object.keys(ls.byTag).forEach(t => { ls.byTag[t] = fwd(ls.byTag[t]); });
  } else {
    ls.byTag[tag] = fwd(ls.byTag[tag]);
  }
  putLastSeen(ls);
  notify('seen', { tag });
}

function isUnreadFor(m, selfId, afterSeq, cutoff = retentionCutoff()) {
  // A message hidden by retention can never count toward unread — a player
  // who can't scroll to it should never see a badge promising it's there.
  if (_hiddenBy(cutoff, m)) return false;
  return m.type === 'message' && !m.deleted && m.notify &&
         typeof m.seq === 'number' && m.seq > afterSeq && m.author !== selfId;
}

export function unreadCount(selfId, tag = 'all') {
  const ls = getLastSeen();
  const after = tag === 'all' ? ls.seq : (ls.byTag[tag] ?? ls.seq);
  const cutoff = retentionCutoff();          // resolved once, not per message
  let n = 0;
  S.items.forEach(m => {
    if (tag !== 'all' && (m.gameTag || '') !== tag) return;
    if (isUnreadFor(m, selfId, after, cutoff)) n++;
  });
  return n;
}

/**
 * Distinct author ids behind a tag's UNREAD count, in first-seen order —
 * same predicate as unreadCount(), just collecting authors instead of a
 * tally. Feeds the game-card bubble's attribution (item B): "who is this
 * unread FROM" rather than just "how many".
 */
export function unreadAuthors(selfId, tag = 'all') {
  const ls = getLastSeen();
  const after = tag === 'all' ? ls.seq : (ls.byTag[tag] ?? ls.seq);
  const cutoff = retentionCutoff();
  const seen = new Set();
  const out = [];
  S.items.forEach(m => {
    if (tag !== 'all' && (m.gameTag || '') !== tag) return;
    if (!isUnreadFor(m, selfId, after, cutoff)) return;
    if (!seen.has(m.author)) { seen.add(m.author); out.push(m.author); }
  });
  return out;
}

export function mentionUnreadCount(selfId) {
  const ls = getLastSeen();
  return getMessages({ tag: 'all', mentionsOf: selfId }).filter(m => isUnreadFor(m, selfId, ls.seq)).length;
}

export function latestNotifying(selfId) {
  let best = null;
  S.items.forEach(m => {
    if (m.type !== 'message' || m.deleted || !m.notify) return;
    if (isHiddenByRetention(m)) return;                // don't preview a message the reader can't open
    if (!best || orderKey(m) > orderKey(best)) best = m;
  });
  return best;
}

// ── Weekly digest (client-side — AD-13) ───────────────────────────────────────
export function chatDigest(startMs, endMs, ctx = {}) {
  const players = ctx.players || [];
  const nameOf = pid => players.find(p => p.playerId === pid)?.displayName || pid;
  const inRange = m => (m.ts || 0) >= startMs && (m.ts || 0) <= endMs;
  const msgs = getMessages({ tag: 'all', types: ['message'] }).filter(m => inRange(m) && !m.deleted);
  const human = msgs.filter(m => m.author !== 'system' && m.author !== 'scribe');

  const byPlayer = {};
  human.forEach(m => { byPlayer[m.author] = (byPlayer[m.author] || 0) + 1; });

  // Peak hour + longest silence
  const hours = {};
  human.forEach(m => {
    const h = new Date(m.ts).toISOString().slice(0, 13) + ':00Z';
    hours[h] = (hours[h] || 0) + 1;
  });
  const peakHour = Object.entries(hours).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  let longestSilenceHours = null;
  if (human.length > 1) {
    let max = 0;
    for (let i = 1; i < human.length; i++) max = Math.max(max, human[i].ts - human[i - 1].ts);
    longestSilenceHours = Math.round(max / 3600000 * 10) / 10;
  }

  const reactionCount = m => Object.values(m.reactions || {}).reduce((a, v) => a + v.length, 0);
  const topReacted = [...human].map(m => ({ id: m.id, author: m.author, body: m.body.slice(0, 200), reactionCount: reactionCount(m) }))
    .filter(m => m.reactionCount > 0).sort((a, b) => b.reactionCount - a.reactionCount).slice(0, 10);

  const mentions = {};
  human.forEach(m => (m.meta?.mentions || []).forEach(pid => { mentions[pid] = (mentions[pid] || 0) + 1; }));

  // preBustBoast: tagged (or team-named) message pre-kick by a player who lost that game ATS
  const games = ctx.games || [];
  const losses = ctx.atsLossesByPlayer || {};
  const preBustBoast = [];
  human.forEach(m => {
    const lostGames = losses[m.author] || [];
    let g = m.gameTag ? games.find(x => x.gameId === m.gameTag) : null;
    if (!g) {
      g = games.find(x => (losses[m.author] || []).includes(x.gameId) &&
        (m.body.toLowerCase().includes((x.homeTeam || '').toLowerCase()) ||
         m.body.toLowerCase().includes((x.awayTeam || '').toLowerCase())));
    }
    if (g && lostGames.includes(g.gameId) && g.kickoff && m.ts < new Date(g.kickoff).getTime()) {
      preBustBoast.push({ author: m.author, body: m.body.slice(0, 200), gameId: g.gameId, ts: m.ts, id: m.id,
        note: `posted pre-kick on ${g.awayTeam} @ ${g.homeTeam}; lost that game ATS` });
    }
  });

  // beefs: two players naming each other within 5 minutes
  const beefs = [];
  for (let i = 0; i < human.length; i++) {
    for (let j = i + 1; j < human.length && human[j].ts - human[i].ts < 5 * 60000; j++) {
      const a = human[i], b = human[j];
      if (a.author === b.author) continue;
      const aName = nameOf(a.author).toLowerCase(), bName = nameOf(b.author).toLowerCase();
      if (a.body.toLowerCase().includes(bName) && b.body.toLowerCase().includes(aName)) {
        beefs.push({ players: [a.author, b.author], messageIds: [a.id, b.id] });
      }
    }
  }

  // Engagement instrumentation (spec: decides whether push gets pulled forward)
  const days = {};
  human.forEach(m => { const d = new Date(m.ts).toISOString().slice(0, 10); (days[d] = days[d] || new Set()).add(m.author); });
  const dau = Object.entries(days).map(([date, set]) => ({ date, players: set.size }));
  const reacted = human.filter(m => reactionCount(m) > 0).length;
  const replyGaps = [];
  human.forEach(m => {
    if (!m.replyTo) return;
    const parent = S.items.get(m.replyTo);
    if (parent?.ts) replyGaps.push((m.ts - parent.ts) / 60000);
  });
  replyGaps.sort((a, b) => a - b);
  const medianReplyMinutes = replyGaps.length ? Math.round(replyGaps[Math.floor(replyGaps.length / 2)]) : null;

  return {
    week: ctx.week ?? null,
    volume: { byPlayer, peakHour, longestSilenceHours, total: human.length },
    topReacted, mentions, preBustBoast, beefs,
    quotables: topReacted.slice(0, 10).map(t => ({ author: t.author, body: t.body, id: t.id })),
    engagement: {
      dau,
      reactionRate: human.length ? Math.round(reacted / human.length * 100) / 100 : 0,
      medianReplyMinutes,
    },
  };
}

// ── Test hooks ────────────────────────────────────────────────────────────────
export function _resetForTest() {
  if (S.unsub) { S.unsub(); S.unsub = null; }             // no dangling timers across test sections
  S.items.clear(); S.buffered.clear(); S.head = 0; S.outbox = []; S.failed.clear();
  S.offline = false; S.staleDeployment = false;
  S.backfillLow = null; S.viewOpen = false;
}
/** Item A (batch 3+4) — the only way to observe from OUTSIDE this module
 *  whether the poll loop is actually running (S.unsub is intentionally
 *  private). Answers the literal hazard: "prove polling stops." */
export function _isPollingActiveForTest() { return !!S.unsub; }
export function _foldedSnapshot() {
  const list = getMessages({ tag: 'all' }).map(m => ({
    id: m.id, seq: m.seq, ts: m.ts, author: m.author, tag: m.gameTag, body: m.body,
    edited: m.edited, deleted: m.deleted, pinned: m.pinned, notify: m.notify,
    reactions: Object.fromEntries(Object.entries(m.reactions).map(([e, who]) => [e, [...who].sort()])),
  }));
  return JSON.stringify(list);
}
