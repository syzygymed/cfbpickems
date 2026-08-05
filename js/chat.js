/**
 * CFB Pickems — Chat Core (v0.16.0, Part B)
 * ==========================================
 * One append-only event log, many views.
 *
 * ARCHITECTURE (locked — see DEVELOPMENT_LEDGER.md AD-09..AD-12):
 *  - Every chat datum is an EVENT: message / edit / delete / react / unreact / system.
 *  - Events are never mutated. Edits/deletes/reactions reference targetId and are
 *    FOLDED client-side into a rendered message map.
 *  - The fold is ORDER-INDEPENDENT and IDEMPOTENT: events may arrive out of order
 *    or duplicated. Events referencing an unknown targetId are buffered, not
 *    dropped, and applied when the target arrives.
 *  - Transport is append + incremental fetch (backend.js chat* functions), NOT
 *    the debounced blob push — append-only sidesteps last-write-wins clobbering
 *    between six concurrent authors.
 *  - Loud-fail: 3 consecutive poll failures → offline banner (via subscriber
 *    status). Outbox persists to localStorage (send queue, not a storage
 *    fallback); a send that fails 3 times renders FAILED with retry.
 *
 * This module owns ALL chat state. UI (chat-ui.js) subscribes and renders.
 * Nothing else touches the log directly.
 */

import { chatAppendRemote, chatSinceRemote, chatBeforeRemote, isBackendConfigured } from './backend.js';

const OUTBOX_KEY = 'cfbp_chat_outbox';
const LASTSEEN_KEY = 'cfbp_chat_lastseen';   // per-device map { playerId: { channel: seq } }
const MAX_BODY = 1000;
const SEND_MAX_ATTEMPTS = 3;
const POLL_FAIL_BANNER_AT = 3;

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  events: new Map(),        // id -> event (raw log, deduped)
  bySeq: [],                // sorted seq index of confirmed events
  head: 0,                  // highest server seq we've seen
  backfillLow: null,        // lowest seq loaded (for scroll-back)
  messages: new Map(),      // id -> folded message view
  pendingByTarget: new Map(), // targetId -> [events waiting for their target]
  outbox: [],               // [{event, attempts, status:'pending'|'failed'}]
  pollFails: 0,
  offline: false,
  timer: null,
  mode: 'idle',             // 'active' (chat open) | 'passive' (app open) | 'idle'
  subscribers: new Set(),
};

// ── Subscriptions ─────────────────────────────────────────────────────────────
export function onChat(fn) { S.subscribers.add(fn); return () => S.subscribers.delete(fn); }
function notify(kind, detail) { S.subscribers.forEach(fn => { try { fn(kind, detail); } catch {} }); }

export function chatStatus() {
  return { head: S.head, offline: S.offline, pollFails: S.pollFails,
           outboxPending: S.outbox.filter(o => o.status === 'pending').length,
           outboxFailed: S.outbox.filter(o => o.status === 'failed').length };
}

// ── Fold ──────────────────────────────────────────────────────────────────────
// A folded message: { id, seq, ts, author, channel, body, replyTo, meta,
//                     edited, deleted, reactions: {emoji:[author,…]}, local }

function blankMsg(ev) {
  return { id: ev.id, seq: ev.seq ?? null, ts: ev.ts ?? null, author: ev.author,
           channel: ev.channel, body: ev.body || '', replyTo: ev.replyTo || '',
           meta: ev.meta || null, type: ev.type, edited: false, deleted: false,
           reactions: {}, local: !!ev.local,
           _editTs: 0, _reactOps: new Map() };
}

/** Apply one event to the folded map. Safe to call in any order, any number of times. */
function applyEvent(ev) {
  if (!ev || !ev.id) return;
  if (ev.type === 'message' || ev.type === 'system') {
    const existing = S.messages.get(ev.id);
    if (existing) {
      // Reconciliation: server-confirmed copy of an optimistic local message.
      existing.seq = ev.seq ?? existing.seq;
      existing.ts = ev.ts ?? existing.ts;
      existing.local = existing.local && ev.local === true;
    } else {
      S.messages.set(ev.id, blankMsg(ev));
    }
    // Drain anything that was waiting on this target.
    const waiting = S.pendingByTarget.get(ev.id);
    if (waiting) { S.pendingByTarget.delete(ev.id); waiting.forEach(applyEvent); }
    return;
  }
  // edit / delete / react / unreact all need their target.
  const target = S.messages.get(ev.targetId);
  if (!target) {
    const arr = S.pendingByTarget.get(ev.targetId) || [];
    if (!arr.some(e => e.id === ev.id)) arr.push(ev);
    S.pendingByTarget.set(ev.targetId, arr);
    return;
  }
  if (ev.type === 'edit') {
    // Latest edit wins regardless of arrival order (compare event ts, then seq).
    const stamp = (ev.ts || 0) * 1e7 + (ev.seq || 0);
    if (stamp >= target._editTs) {
      target._editTs = stamp;
      target.body = (ev.body || '').slice(0, MAX_BODY);
      target.edited = true;
    }
  } else if (ev.type === 'delete') {
    target.deleted = true;
  } else if (ev.type === 'react' || ev.type === 'unreact') {
    // ORDER-INDEPENDENT toggle resolution: for each (emoji, author) pair, the
    // op with the LATEST (ts, seq) stamp wins — exactly like edits. Naive
    // set add/delete would make the fold depend on arrival order.
    const emoji = ev.meta?.emoji; if (!emoji) return;
    const key = `${emoji}|${ev.author}`;
    const stamp = (ev.ts || 0) * 1e7 + (ev.seq || 0);
    const cur = target._reactOps.get(key);
    if (cur && cur.stamp >= stamp && cur.id !== ev.id) return;      // older op — ignore
    if (cur && cur.id === ev.id) return;                            // exact duplicate
    target._reactOps.set(key, { stamp, on: ev.type === 'react', id: ev.id });
    // Rebuild the rendered reactions from the resolved op map.
    const next = {};
    target._reactOps.forEach((op, k) => {
      if (!op.on) return;
      const [em, author] = k.split('|');
      (next[em] = next[em] || []).push(author);
    });
    target.reactions = next;
  }
}

/** Ingest a batch of raw events (from poll, backfill, or local optimistic send). */
export function ingest(events, { local = false } = {}) {
  let added = 0;
  for (const raw of events || []) {
    if (!raw?.id) continue;
    const ev = { ...raw, local };
    const known = S.events.get(ev.id);
    if (known) {
      // Duplicate — but a server copy upgrades a local optimistic one.
      if (known.local && !local) {
        S.events.set(ev.id, ev);
        applyEvent(ev);           // reconciles seq/ts on the folded message
        if (ev.seq) trackSeq(ev.seq);
        added++;
      }
      continue;
    }
    S.events.set(ev.id, ev);
    if (ev.seq) trackSeq(ev.seq);
    applyEvent(ev);
    added++;
  }
  if (added) notify('events', { added });
  return added;
}

function trackSeq(seq) {
  if (seq > S.head) S.head = seq;
  if (S.backfillLow === null || seq < S.backfillLow) S.backfillLow = seq;
}

// ── Read APIs (for the UI) ────────────────────────────────────────────────────

function sortStamp(m) {
  // Server ts first (authoritative), seq breaks ties, local pending messages
  // sort by their client ts at the end of the stream.
  return (m.ts || Date.now()) * 1e7 + (m.seq || 9999999);
}

/** Folded, chronologically sorted messages for a channel ('all' = everything). */
export function getChannelMessages(channel = 'all') {
  const out = [];
  S.messages.forEach(m => {
    if (channel === 'all' || m.channel === channel) out.push(m);
  });
  out.sort((a, b) => sortStamp(a) - sortStamp(b));
  return out;
}

/** Channels that have any activity, most-recent-first, with last message. */
export function getActiveChannels() {
  const byChan = new Map();
  S.messages.forEach(m => {
    const cur = byChan.get(m.channel);
    if (!cur || sortStamp(m) > sortStamp(cur)) byChan.set(m.channel, m);
  });
  return [...byChan.entries()]
    .map(([channel, last]) => ({ channel, last }))
    .sort((a, b) => sortStamp(b.last) - sortStamp(a.last));
}

export function getMessage(id) { return S.messages.get(id) || null; }

// ── Unread tracking ───────────────────────────────────────────────────────────
// lastSeenSeq lives per-device per-player (device-local key — reading position
// is a per-screen concern; it deliberately does NOT ride the shared blob to
// avoid write-amplifying the Sheet on every scroll).

function lastSeenAll() {
  try { return JSON.parse(localStorage.getItem(LASTSEEN_KEY) || '{}'); } catch { return {}; }
}
export function getLastSeen(playerId) { return (lastSeenAll()[playerId]) || {}; }
export function markSeen(playerId, channel) {
  if (!playerId) return;
  const all = lastSeenAll();
  const mine = all[playerId] || {};
  const msgs = getChannelMessages(channel === 'all' ? 'all' : channel);
  let maxSeq = mine[channel] || 0;
  msgs.forEach(m => { if (m.seq && m.seq > maxSeq) maxSeq = m.seq; });
  if (channel === 'all') {
    // Seeing "All" marks every channel read up to head.
    getActiveChannels().forEach(({ channel: ch }) => { mine[ch] = Math.max(mine[ch] || 0, S.head); });
    mine['all'] = S.head;
  } else {
    mine[channel] = maxSeq;
  }
  all[playerId] = mine;
  try { localStorage.setItem(LASTSEEN_KEY, JSON.stringify(all)); } catch {}
  notify('unread');
}

export function unreadCount(playerId, channel = null) {
  if (!playerId) return 0;
  const seen = getLastSeen(playerId);
  let n = 0;
  S.messages.forEach(m => {
    if (m.deleted || !m.seq) return;
    if (m.author === playerId) return;               // own messages never count
    if (channel && m.channel !== channel) return;
    if (m.seq > (seen[m.channel] || 0)) n++;
  });
  return n;
}

// ── Outbox / optimistic send ──────────────────────────────────────────────────

function loadOutbox() {
  try { S.outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { S.outbox = []; }
  S.outbox.forEach(o => { if (o.status === 'pending') o.attempts = o.attempts || 0; });
}
function persistOutbox() {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(S.outbox)); } catch {}
}

export function newId() {
  return (crypto?.randomUUID?.() ||
    `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
}

/**
 * Queue an event for sending; renders immediately via ingest(local).
 * Message-type events show pending state until reconciled by the server echo.
 * `id` may be supplied for DETERMINISTIC events (system + SCRIBE) so that six
 * clients firing the same trigger collapse to ONE row via server-side dedupe.
 */
export function sendEvent({ type = 'message', channel = 'general', body = '', targetId = '', replyTo = '', meta = null, author, id = null }) {
  const ev = {
    id: id || newId(), type, channel,
    body: String(body || '').slice(0, MAX_BODY),
    targetId, replyTo, meta, author,
    ts: Date.now(), local: true,
  };
  if (type === 'message' && !ev.body.trim()) return null;
  ingest([ev], { local: true });
  S.outbox.push({ event: strip(ev), attempts: 0, status: 'pending' });
  persistOutbox();
  flushOutbox();       // fire and forget; poll immediately after success
  return ev.id;
}
function strip(ev) { const { local, ...rest } = ev; return rest; }

let _flushing = false;
export async function flushOutbox() {
  if (_flushing) return;
  const batch = S.outbox.filter(o => o.status === 'pending');
  if (!batch.length || !isBackendConfigured()) return;
  _flushing = true;
  try {
    const { assigned } = await chatAppendRemote(batch.map(o => o.event));
    const bySent = new Map(assigned.map(a => [a.id, a]));
    S.outbox = S.outbox.filter(o => {
      const a = bySent.get(o.event.id);
      if (a) {
        // Confirmed (or deduped) — upgrade the folded message in place.
        ingest([{ ...o.event, seq: a.seq, ts: a.ts || o.event.ts }]);
        return false;
      }
      return true;
    });
    persistOutbox();
    notify('sent');
    poll();   // immediate poll after successful send
  } catch (err) {
    batch.forEach(o => {
      o.attempts = (o.attempts || 0) + 1;
      if (o.attempts >= SEND_MAX_ATTEMPTS) o.status = 'failed';
    });
    persistOutbox();
    notify('sendError', { error: String(err?.message || err) });
  } finally {
    _flushing = false;
  }
}

export function retryFailed(eventId = null) {
  S.outbox.forEach(o => {
    if (o.status === 'failed' && (!eventId || o.event.id === eventId)) {
      o.status = 'pending'; o.attempts = 0;
    }
  });
  persistOutbox();
  flushOutbox();
}

export function outboxStateOf(id) {
  const o = S.outbox.find(x => x.event.id === id);
  return o ? o.status : null;   // null = confirmed
}

// ── Polling ───────────────────────────────────────────────────────────────────
const INTERVALS = { active: 8000, passive: 30000 };
let _backoff = 0;

export function setPollMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode;
  schedule(0);
}

function schedule(delay = null) {
  if (S.timer) clearTimeout(S.timer);
  if (S.mode === 'idle') return;
  const base = INTERVALS[S.mode] || 30000;
  S.timer = setTimeout(poll, delay !== null ? delay : (_backoff || base));
}

export async function poll() {
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  if (!isBackendConfigured() || document?.hidden) { schedule(); return; }
  try {
    const { events, head } = await chatSinceRemote(S.head, 500);
    if (head > S.head && !events.length) S.head = head;
    ingest(events);
    if (S.pollFails >= POLL_FAIL_BANNER_AT || S.offline) {
      S.offline = false; notify('online');
    }
    S.pollFails = 0; _backoff = 0;
    flushOutbox();
  } catch (err) {
    S.pollFails++;
    _backoff = Math.min(60000, (INTERVALS[S.mode] || 30000) * Math.pow(2, S.pollFails - 1));
    if (S.pollFails === POLL_FAIL_BANNER_AT) {
      S.offline = true;
      notify('offline', { error: String(err?.message || err) });
    }
  }
  schedule();
}

export async function backfill(limit = 100) {
  if (!isBackendConfigured() || S.backfillLow === null || S.backfillLow <= 1) return 0;
  try {
    const { events } = await chatBeforeRemote(S.backfillLow, limit);
    return ingest(events);
  } catch { return 0; }
}

/** Boot the chat engine: restore outbox, hook visibility, start passive polling. */
export function initChat() {
  loadOutbox();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
  setPollMode('passive');
  // First flush before first poll (outbox survives reload).
  flushOutbox().finally(() => poll());
}

// ── Weekly digest export ──────────────────────────────────────────────────────
/**
 * Structured digest of one week's chat, for recap generation.
 * `ctx` supplies league data the log can't know:
 *   { players:[{playerId,displayName}], games:[{gameId,homeTeam,awayTeam,kickoff}],
 *     atsLossesByPlayer: { playerId: [gameId,…] }, week }
 */
export function chatDigest(startMs, endMs, ctx = {}) {
  const players = ctx.players || [];
  const nameOf = id => players.find(p => p.playerId === id)?.displayName || id;
  const nameList = players.map(p => ({ id: p.playerId, name: (p.displayName || '').toLowerCase() }));
  const inWindow = m => !m.deleted && m.type === 'message' && m.ts >= startMs && m.ts <= endMs;

  const msgs = getChannelMessages('all').filter(inWindow);
  const human = msgs.filter(m => m.author !== 'system' && m.author !== 'scribe');

  // volume
  const byPlayer = {}; const hourBuckets = {};
  human.forEach(m => {
    byPlayer[nameOf(m.author)] = (byPlayer[nameOf(m.author)] || 0) + 1;
    const h = new Date(m.ts); h.setMinutes(0, 0, 0);
    const k = h.toISOString();
    hourBuckets[k] = (hourBuckets[k] || 0) + 1;
  });
  const peakHour = Object.entries(hourBuckets).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  let longestSilenceHours = null;
  if (human.length > 1) {
    let maxGap = 0;
    for (let i = 1; i < human.length; i++) maxGap = Math.max(maxGap, human[i].ts - human[i - 1].ts);
    longestSilenceHours = Math.round(maxGap / 36e5 * 10) / 10;
  }

  // reactions
  const reactionCount = m => Object.values(m.reactions).reduce((n, arr) => n + arr.length, 0);
  const topReacted = [...human].map(m => ({ id: m.id, author: nameOf(m.author), body: m.body.slice(0, 200), reactionCount: reactionCount(m) }))
    .filter(x => x.reactionCount > 0)
    .sort((a, b) => b.reactionCount - a.reactionCount).slice(0, 10);

  // mentions
  const mentions = {};
  human.forEach(m => {
    const low = m.body.toLowerCase();
    nameList.forEach(({ id, name }) => {
      if (id !== m.author && name && low.includes(name)) mentions[nameOf(id)] = (mentions[nameOf(id)] || 0) + 1;
    });
  });

  // preBustBoast — msg by P pre-kick in game:G channel (or naming a G team), P lost G ATS
  const games = ctx.games || [];
  const losses = ctx.atsLossesByPlayer || {};
  const preBustBoast = [];
  human.forEach(m => {
    const lostGames = losses[m.author] || [];
    for (const gid of lostGames) {
      const g = games.find(x => x.gameId === gid); if (!g) continue;
      const kick = g.kickoff ? new Date(g.kickoff).getTime() : null;
      if (!kick || m.ts >= kick) continue;
      const inGameChan = m.channel === `game:${gid}`;
      const namesTeam = [g.homeTeam, g.awayTeam].some(t => t && m.body.toLowerCase().includes(String(t).toLowerCase()));
      if (inGameChan || namesTeam) {
        preBustBoast.push({ author: nameOf(m.author), body: m.body.slice(0, 200), gameId: gid, ts: m.ts,
          note: `posted pre-kick ${inGameChan ? 'in the game thread' : 'naming ' + g.homeTeam + '/' + g.awayTeam}; lost that game ATS` });
        break;
      }
    }
  });

  // beefs — two players naming each other within 5 minutes
  const beefs = [];
  for (let i = 0; i < human.length; i++) {
    for (let j = i + 1; j < human.length && human[j].ts - human[i].ts <= 5 * 60 * 1000; j++) {
      const a = human[i], b = human[j];
      if (a.author === b.author) continue;
      const aName = nameList.find(n => n.id === a.author)?.name;
      const bName = nameList.find(n => n.id === b.author)?.name;
      if (aName && bName && a.body.toLowerCase().includes(bName) && b.body.toLowerCase().includes(aName)) {
        const key = [a.author, b.author].sort().join('|');
        if (!beefs.some(x => x._k === key)) beefs.push({ _k: key, players: [nameOf(a.author), nameOf(b.author)], messageIds: [a.id, b.id] });
      }
    }
  }
  beefs.forEach(b => delete b._k);

  const quotables = [...human]
    .sort((a, b) => reactionCount(b) - reactionCount(a))
    .slice(0, 10)
    .map(m => ({ author: nameOf(m.author), body: m.body.slice(0, 200), ts: m.ts }));

  return {
    week: ctx.week ?? null,
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    volume: { byPlayer, peakHour, longestSilenceHours },
    topReacted, mentions, preBustBoast, beefs, quotables,
  };
}

// ── Test hooks (loadtest.mjs) ─────────────────────────────────────────────────
export function _resetForTest() {
  S.events.clear(); S.messages.clear(); S.pendingByTarget.clear();
  S.bySeq = []; S.head = 0; S.backfillLow = null; S.outbox = [];
  S.pollFails = 0; S.offline = false; S.mode = 'idle';
  if (S.timer) clearTimeout(S.timer);
}
export function _foldedSnapshot() {
  // Deterministic serialization of the folded state for order-independence tests.
  const msgs = getChannelMessages('all').map(m => ({
    id: m.id, seq: m.seq, author: m.author, channel: m.channel, body: m.body,
    edited: m.edited, deleted: m.deleted,
    reactions: Object.fromEntries(Object.entries(m.reactions).map(([e, a]) => [e, [...a].sort()])),
  }));
  msgs.sort((a, b) => (a.seq || 0) - (b.seq || 0) || a.id.localeCompare(b.id));
  return JSON.stringify(msgs);
}
