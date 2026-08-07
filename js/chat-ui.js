/**
 * chat-ui.js — v0.17.0 (REVISED chat spec: one room + gameTag)
 * =============================================================
 * Renders every chat surface from the chat.js engine:
 *   A. Main chat page — single stream, filter pills (Room / 🏛 Records /
 *      @ Mentions / per-game views with unread + LIVE pulse), date separators,
 *      NEW divider, jump-to-latest, ambient gamereact coalescing
 *   B. Composer — removable game-tag chip (the cross-talk rule made visible),
 *      @mention autocomplete, quick emoji, 1000-char counter
 *   C. Game-card bubble + pre-tagged bottom sheet (+ first-use helper text)
 *   D. Dashboard sticky bar — unread, preview, inline quick-reply
 *   E. In-app notifications (TRIAL, no push): toast queue, title badge,
 *      navigator.setAppBadge, mention inbox, optional per-player sound
 *   F. Identity: per-player nickname + accent color (prefs popover)
 *   G. System emitters — pick reveal ritual, kickoff, game final (+ one-tap
 *      callout + SCRIBE unprompted callout), Extra Point, week final (+ Hall
 *      of Records auto-promotion), all with the pre-lock no-leak HARD RULE
 *   H. SCRIBE — an active member of the league, not a summonable bot: it
 *      documents on its own schedule, appears in presence, and answers when
 *      addressed. Live-game observations ride the existing score poll.
 *
 * All state lives in chat.js; this module renders and forwards intents.
 */

import {
  initChat, onChat, chatStatus, getMessages, getMessage, resolveTag,
  sendMessage, sendEvent, editMessage, deleteMessage, toggleReact, pinMessage,
  sendGameReact, retryFailed, isFailed, isPending,
  unreadCount, mentionUnreadCount, markSeen, getLastSeen, latestNotifying,
  presenceList, seenByCount, backfill, chatDigest as _digest, setViewOpen,
} from './chat.js';
import { scribeInspectMessage, scribeTrigger } from './scribeLines.js';
import {
  getSession, getPlayers, getPlayer, getCurrentWeek, getGames, getWeeks,
  getPicks, getEffectiveWeekStatus,
  getAccent, setAccent, getAccentFor, getChatNick, setChatNick, getChatNickFor,
  getNotifPrefs, setNotifPrefs,
} from './storage.js';
import { formatSpread, formatWeekLabel, GAME_STATUS } from './data-model.js';
import { calculateAtsWinner } from './scoring.js';

export const chatDigest = _digest;

const QUICK_EMOJI = ['💀', '😂', '🔥', '🍺', '🤡', '👀'];
const EDIT_WINDOW_MS = 5 * 60 * 1000;
const ACCENTS = ['#B91C1C', '#C2410C', '#A16207', '#15803D', '#0E7490', '#1D4ED8', '#7C3AED', '#BE185D'];

const U = {
  filter: 'all',            // 'all' | 'records' | 'mentions' | <gameId>
  replyTo: null,
  composerTag: '',          // resolved tag chip (removable)
  tagStripped: false,       // user explicitly removed the chip this compose
  sheetGameId: null,
  markTimer: null,
  toastQueue: [],
  toastShowing: false,
  prefsOpen: false,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function me() { const s = getSession(); return (s?.playerId && s?.playerVerified) ? s.playerId : null; }
function nameOf(id) {
  if (id === 'scribe') return 'S.C.R.I.B.E.';
  if (id === 'system') return 'League';
  return getChatNickFor(id) || getPlayer(id)?.displayName || id;
}
function initialsOf(id) {
  if (id === 'scribe') return '📋';
  if (id === 'system') return '⚙';
  const n = nameOf(id);
  return (getPlayer(id)?.initials || n.slice(0, 2)).toUpperCase();
}
function accentOf(id) {
  if (id === 'scribe' || id === 'system') return '';
  return getAccentFor(id) || '';
}
function relTime(ts) {
  if (!ts) return 'sending…';
  const d = Date.now() - ts;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function gameById(id) {
  for (const w of getWeeks()) {
    const g = getGames(w.weekId).find(x => x.gameId === id);
    if (g) return { game: g, week: w };
  }
  return null;
}
function gameShort(g) {
  const abbr = t => (t || '').split(' ').pop().slice(0, 12);
  return `${abbr(g.awayTeam)}/${abbr(g.homeTeam)}`;
}
function chatPageActive() {
  return typeof document !== 'undefined' && !!document.querySelector('#page-chat.active');
}

// ── Pick indicator (Drew: visual context in game threads) ─────────────────────
// BLIND RULE: only shown once the week is locked/live/final — never leaks a
// selection while picks are open.
function pickChip(authorId, gameTag) {
  if (!gameTag || authorId === 'scribe' || authorId === 'system') return '';
  const found = gameById(gameTag);
  if (!found) return '';
  const eff = getEffectiveWeekStatus(found.week);
  if (!['locked', 'live', 'final'].includes(eff) && found.week.status !== 'final') return '';
  const pick = getPicks(found.week.weekId, authorId).find(p => p.gameId === gameTag);
  if (!pick) return '';
  let cls = 'pick-chip';
  if (found.game.status === GAME_STATUS.FINAL) {
    const ats = found.game.atsWinner ?? calculateAtsWinner(found.game);
    if (ats && ats !== 'no_decision') cls += pick.selectedTeam === ats ? ' pick-chip-win' : ' pick-chip-loss';
  }
  return `<span class="${cls}" title="${esc(nameOf(authorId))} picked ${esc(pick.selectedTeam)}">⚡ ${esc(pick.selectedTeam.split(' ').pop())}</span>`;
}

// ── Notifications (TRIAL — no push) ───────────────────────────────────────────
function playBlip() {
  try {
    if (!getNotifPrefs().sound) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 740; o.type = 'sine';
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.2);
  } catch {}
}

function showToast(msg, { force = false } = {}) {
  if (!force && !getNotifPrefs().toasts) return;
  if (chatPageActive() && !force) return;            // suppress while chat focused
  U.toastQueue.push(msg);
  if (!U.toastShowing) drainToast();
}
function drainToast() {
  const msg = U.toastQueue.shift();
  if (!msg) { U.toastShowing = false; return; }
  U.toastShowing = true;
  document.getElementById('chat-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'chat-toast';
  el.className = 'chat-toast';
  el.innerHTML = `<span class="chat-toast-avatar" style="${accentOf(msg.author) ? `background:${accentOf(msg.author)};color:#fff` : ''}">${esc(initialsOf(msg.author))}</span>
    <span class="chat-toast-body"><strong>${esc(nameOf(msg.author))}</strong> ${esc((msg.body || '').slice(0, 80))}</span>`;
  el.addEventListener('click', () => { el.remove(); U.toastShowing = false; navToChat(); });
  document.body.appendChild(el);
  setTimeout(() => { el.remove(); setTimeout(drainToast, 250); }, 6000);
}
function navToChat() {
  document.querySelector('.nav-item[data-tab="chat"]')?.click();
}

export function updateChatBadges() {
  const self = me();
  const n = self ? unreadCount(self, 'all') : 0;
  // nav badge
  document.querySelectorAll('.nav-item[data-tab="chat"]').forEach(btn => {
    let b = btn.querySelector('.nav-unread');
    if (n > 0) {
      if (!b) { b = document.createElement('span'); b.className = 'nav-unread'; btn.appendChild(b); }
      b.textContent = n > 99 ? '99+' : String(n);
    } else b?.remove();
  });
  // title badge
  try {
    const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
  } catch {}
  // installed-PWA icon badge (not push — no permissions, degrades silently)
  try {
    if ('setAppBadge' in navigator) n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge();
  } catch {}
}

// ── Filter pills ──────────────────────────────────────────────────────────────
function activeGameTags() {
  // Games worth a pill: any tagged traffic, or live games on the current slate.
  const tags = new Map();   // gameId -> lastTs
  getMessages({ tag: 'all' }).forEach(m => {
    if (m.gameTag) tags.set(m.gameTag, Math.max(tags.get(m.gameTag) || 0, m.ts || 0));
  });
  const wk = getCurrentWeek();
  if (wk) getGames(wk.weekId).forEach(g => {
    if (g.status === GAME_STATUS.LIVE && !tags.has(g.gameId)) tags.set(g.gameId, Date.now());
  });
  return [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 10);
}

function pillsHTML() {
  const self = me();
  const mainUnread = self ? unreadCount(self, 'all') : 0;
  const dot = n => n > 0 ? `<span class="chat-unread-dot">${n > 99 ? '99+' : n}</span>` : '';
  // v0.17.1: mention inbox removed per commissioner. @mentions still highlight
  // and still count as notifying events for unread purposes — there's just no
  // separate filter view for them. The "Locker Room" pill covers all messages.
  let html = `
    <button class="chat-pill${U.filter === 'all' ? ' active' : ''}" data-chat-filter="all">Locker Room ${dot(mainUnread)}</button>
    <button class="chat-pill${U.filter === 'records' ? ' active' : ''}" data-chat-filter="records" title="Hall of Records">🏛</button>`;
  activeGameTags().forEach(tag => {
    const found = gameById(tag);
    if (!found) return;
    const live = found.game.status === GAME_STATUS.LIVE;
    const n = self ? unreadCount(self, tag) : 0;
    html += `<button class="chat-pill${U.filter === tag ? ' active' : ''}${live ? ' chat-pill-live' : ''}" data-chat-filter="${esc(tag)}">
      ${live ? '<span class="live-pulse"></span>' : ''}${esc(gameShort(found.game))} ${dot(n)}</button>`;
  });
  return `<div class="chat-pills-scroll">${html}</div>`;
}

// ── Message rendering ─────────────────────────────────────────────────────────
function bodyHTML(m) {
  let t = esc(m.body);
  t = t.replace(/@([A-Za-z][\w.']*)/g, '<span class="chat-mention">@$1</span>');
  return t;
}

function quoteHTML(m) {
  const q = m.meta?.quote;
  if (q) {
    return `<div class="chat-reply-quote chat-quote-static">↩ <strong>${esc(nameOf(q.author))}</strong>: ${esc((q.body || '').slice(0, 120))}</div>`;
  }
  if (!m.replyTo) return '';
  const parent = getMessage(m.replyTo);
  if (!parent) return '';
  return `<button class="chat-reply-quote" data-jump="${esc(parent.id)}">↩ <strong>${esc(nameOf(parent.author))}</strong>: ${esc((parent.deleted ? 'message withdrawn' : parent.body).slice(0, 90))}</button>`;
}

function reactionsHTML(m, self) {
  const entries = Object.entries(m.reactions || {});
  if (!entries.length) return '';
  return `<div class="chat-reactions">${entries.map(([emoji, who]) =>
    `<button class="chat-react-pill${who.includes(self) ? ' me' : ''}" data-react="${esc(emoji)}" data-target="${esc(m.id)}"
       title="${esc(who.map(nameOf).join(', '))}">${emoji} ${who.length}</button>`).join('')}</div>`;
}

function tagChipHTML(m) {
  if (!m.gameTag || U.filter === m.gameTag) return '';
  const found = gameById(m.gameTag);
  if (!found) return '';
  const spr = formatSpread(found.game.lockedSpread ?? found.game.spread, found.game.favorite, found.game) || '';
  return `<button class="chat-game-chip" data-chat-filter="${esc(m.gameTag)}">${esc(gameShort(found.game))}${spr ? ' ' + esc(spr) : ''}</button>`;
}

function calloutEligible(m) {
  // One-tap callout: tagged message, game final, posted pre-kick, author lost it ATS
  if (!m.gameTag || m.type !== 'message' || m.deleted) return false;
  const found = gameById(m.gameTag);
  if (!found || found.game.status !== GAME_STATUS.FINAL) return false;
  const ats = found.game.atsWinner ?? calculateAtsWinner(found.game);
  if (!ats || ats === 'no_decision') return false;
  const pick = getPicks(found.week.weekId, m.author).find(p => p.gameId === m.gameTag);
  if (!pick || pick.selectedTeam === ats) return false;
  return found.game.kickoff && (m.ts || 0) < new Date(found.game.kickoff).getTime();
}

function messageHTML(m, self, showNewDivider) {
  if (m.type === 'system') {
    const reveal = m.meta?.kind === 'reveal';
    return `${showNewDivider ? '<div class="chat-new-divider"><span>NEW</span></div>' : ''}
      <div class="chat-msg chat-system${reveal ? ' chat-reveal' : ''}" data-mid="${esc(m.id)}">
        <div class="chat-system-body">${reveal ? `<div class="chat-reveal-title">🔓 ${esc(m.meta?.title || 'Picks are in')}</div>` : ''}${bodyHTML(m).replace(/\n/g, '<br>')}</div>
        <span class="chat-time">${relTime(m.ts)}</span>
      </div>`;
  }
  if (m.type === 'gamereact') return '';   // rendered via coalescing pass

  const mine = m.author === self;
  const scribe = m.author === 'scribe';
  const failed = isFailed(m.id);
  const pending = isPending(m.id);
  const canEdit = mine && !m.deleted && Date.now() - (m.ts || 0) < EDIT_WINDOW_MS;
  const accent = accentOf(m.author);
  const seen = mine && m.seq ? seenByCount(m.seq, self) : 0;

  return `${showNewDivider ? '<div class="chat-new-divider"><span>NEW</span></div>' : ''}
  <div class="chat-msg${mine ? ' chat-mine' : ''}${scribe ? ' chat-scribe' : ''}${pending ? ' is-pending' : ''}${failed ? ' is-failed' : ''}" data-mid="${esc(m.id)}">
    <div class="chat-avatar${scribe ? ' chat-avatar-scribe' : ''}${mine ? ' chat-avatar-mine' : ''}" ${accent ? `style="background:${accent};color:#fff"` : ''}>${initialsOf(m.author)}</div>
    <div class="chat-bubble-col">
      <div class="chat-meta">
        <span class="chat-author">${esc(nameOf(m.author))}</span>
        ${pickChip(m.author, m.gameTag)}
        ${tagChipHTML(m)}
        <span class="chat-time">${relTime(m.ts)}</span>
        ${m.edited ? '<span class="chat-edited">edited</span>' : ''}
        ${m.pinned ? '<span class="chat-pinned">📌</span>' : ''}
        ${pending ? '<span class="chat-pending">🕐</span>' : ''}
        ${failed ? `<span class="chat-failed">FAILED</span><button class="chat-retry" data-retry="${esc(m.id)}">retry</button>` : ''}
      </div>
      ${quoteHTML(m)}
      <div class="chat-bubble">${m.deleted ? '<span class="chat-tombstone">🪦 message withdrawn</span>' : bodyHTML(m).replace(/\n/g, '<br>')}</div>
      ${reactionsHTML(m, self)}
      ${mine && seen > 0 ? `<div class="chat-seen">seen by ${seen}</div>` : ''}
      ${m.deleted ? '' : `<div class="chat-actions">
        ${QUICK_EMOJI.slice(0, 3).map(e => `<button class="chat-act" data-react="${e}" data-target="${esc(m.id)}">${e}</button>`).join('')}
        <button class="chat-act" data-reply="${esc(m.id)}" title="Reply">↩</button>
        ${calloutEligible(m) ? `<button class="chat-act" data-callout="${esc(m.id)}" title="Quote this next to the result">📎</button>` : ''}
        <button class="chat-act" data-pin="${esc(m.id)}" title="${m.pinned ? 'Unpin from' : 'Pin to'} the Hall of Records">${m.pinned ? '📌' : '🏛'}</button>
        ${canEdit ? `<button class="chat-act" data-edit="${esc(m.id)}" title="Edit (5 min)">✏️</button>` : ''}
        ${mine ? `<button class="chat-act" data-del="${esc(m.id)}" title="Withdraw">🗑</button>` : ''}
      </div>`}
    </div>
  </div>`;
}

/** Ambient coalescing: consecutive gamereacts by one author within 5 min render
 *  as a single attributed line (attribution is the whole point in a 6-man room). */
function coalesceStream(list) {
  const out = [];
  let run = null;
  const flush = () => { if (run) { out.push(run); run = null; } };
  for (const m of list) {
    if (m.type === 'gamereact') {
      if (run && run.author === m.author && (m.ts - run.lastTs) < 5 * 60000) {
        run.items.push(m); run.lastTs = m.ts;
      } else {
        flush();
        run = { kind: 'gamereact-run', author: m.author, ts: m.ts, lastTs: m.ts, items: [m] };
      }
    } else { flush(); out.push(m); }
  }
  flush();
  return out;
}

function gamereactRunHTML(run) {
  const parts = run.items.map(m => {
    const found = gameById(m.gameTag);
    return `${esc(m.meta?.emoji || '👀')} ${found ? esc(gameShort(found.game)) : ''}`;
  }).join(' · ');
  return `<div class="chat-msg chat-system chat-gamereact" data-ts="${run.ts}">
    <div class="chat-system-body">${esc(nameOf(run.author))} reacted &nbsp;${parts}</div>
    <span class="chat-time">${relTime(run.ts)}</span>
  </div>`;
}

// ── Main chat page ────────────────────────────────────────────────────────────
export function renderChatPage() {
  const c = document.getElementById('page-chat'); if (!c) return;
  const self = me();
  const st = chatStatus();
  setViewOpen(true);

  let list;
  if (U.filter === 'records') list = getMessages({ tag: 'all', pinned: true });
  else if (U.filter === 'mentions') {
    // v0.17.1 — mention inbox removed. If a device has stale state pointing at
    // 'mentions', treat it as 'all' and fix the filter forward.
    U.filter = 'all';
    list = getMessages({ tag: 'all' });
  }
  else if (U.filter === 'all') list = getMessages({ tag: 'all' });
  else list = getMessages({ tag: U.filter });

  const showSys = getNotifPrefs().systemEvents;
  if (!showSys) list = list.filter(m => m.type !== 'system');

  const ls = getLastSeen();
  const boundary = U.filter === 'all' ? ls.seq : (ls.byTag[U.filter] ?? ls.seq);
  let dividerPlaced = false;

  const stream = coalesceStream(list);
  let lastDay = '';
  let msgsHTML = '';
  for (const item of stream) {
    const ts = item.ts || Date.now();
    const day = new Date(ts).toDateString();
    if (day !== lastDay) { msgsHTML += `<div class="chat-day-sep">${esc(day)}</div>`; lastDay = day; }
    if (item.kind === 'gamereact-run') { msgsHTML += gamereactRunHTML(item); continue; }
    const isNew = !dividerPlaced && self && item.type === 'message' && item.notify &&
                  typeof item.seq === 'number' && item.seq > boundary && item.author !== self;
    if (isNew) dividerPlaced = true;
    msgsHTML += messageHTML(item, self, isNew);
  }
  if (!stream.length) {
    msgsHTML = `<div class="chat-empty">${U.filter === 'records'
      ? 'The Hall of Records awaits its first entry. Pin a message with 🏛.'
      : 'The Locker Room is open. SCRIBE is on duty.'}</div>`;
  }

  // Header context for game views
  let viewHeader = '';
  if (!['all', 'records'].includes(U.filter)) {
    const found = gameById(U.filter);
    if (found) {
      const g = found.game;
      const score = g.homeScore != null ? `${g.awayScore}–${g.homeScore}` : '';
      viewHeader = `<div class="chat-view-header">
        <div><strong>${esc(g.awayTeam)} @ ${esc(g.homeTeam)}</strong>
          <span class="text-muted text-xs">${esc(formatSpread(g.lockedSpread ?? g.spread, g.favorite, g) || '')}</span></div>
        <div>${g.status === GAME_STATUS.LIVE ? `<span class="live-pulse"></span> LIVE ${score}` : score}</div>
      </div>`;
    }
  }

  const here = presenceList().filter(p => p.playerId !== self);
  const presenceLine = `${here.length ? `${here.length + (self ? 1 : 0)} here now · ` : ''}📋 SCRIBE on duty`;

  const banner = st.offline ? `<div class="chat-offline-banner">⚠️ CHAT OFFLINE — ${st.staleDeployment
    ? 'the backend deployment is out of date. Commissioner: open Apps Script → Deploy → Manage deployments → Edit → <b>New version</b>, then reload.'
    : `messages are not syncing. Retrying… <span class="text-xs">(${esc(st.lastError || '')})</span>`}</div>` : '';

  c.innerHTML = `
    <div class="section-header chat-header-row">
      <div><h2>Locker Room</h2><div class="subtitle">${esc(presenceLine)}</div></div>
      <button class="btn btn-ghost btn-sm" id="chat-prefs-btn" title="Chat preferences">⚙️</button>
    </div>
    ${U.prefsOpen ? prefsPanelHTML() : ''}
    ${banner}
    ${pillsHTML()}
    ${viewHeader}
    <div class="chat-scroll" id="chat-scroll">
      <button class="chat-load-older" id="chat-load-older">↑ load earlier</button>
      ${msgsHTML}
    </div>
    <button class="chat-jump-latest" id="chat-jump" style="display:none">↓ latest</button>
    ${self ? composerHTML() : `<div class="chat-login-note">Log in on the Picks tab to join the conversation. Reading is open to the league.</div>`}
  `;

  bindChatPage();
  const scroll = document.getElementById('chat-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  // Mark read after the view has been visibly open for 1s (spec)
  clearTimeout(U.markTimer);
  U.markTimer = setTimeout(() => {
    if (!chatPageActive()) return;
    markSeen(U.filter === 'all' || U.filter === 'records' || U.filter === 'mentions' ? 'all' : U.filter);
    updateChatBadges();
    renderPillsOnly();
  }, 1000);
}

function renderPillsOnly() {
  const host = document.querySelector('#page-chat .chat-pills-scroll');
  if (host) host.outerHTML = pillsHTML();
  bindFilterButtons(document.getElementById('page-chat'));
}

// ── Composer ──────────────────────────────────────────────────────────────────
function composerHTML() {
  const replyMsg = U.replyTo ? getMessage(U.replyTo) : null;
  const tag = currentComposerTag();
  const found = tag ? gameById(tag) : null;
  return `
  <div class="chat-composer">
    ${replyMsg ? `<div class="chat-replying">↩ replying to <strong>${esc(nameOf(replyMsg.author))}</strong>: ${esc(replyMsg.body.slice(0, 60))}
      <button id="chat-cancel-reply">✕</button></div>` : ''}
    ${found ? `<div class="chat-tag-chip-row"><span class="chat-tag-chip">🏈 ${esc(gameShort(found.game))}
      <button id="chat-strip-tag" title="Remove game tag — post to the main room only">✕</button></span>
      <span class="text-muted text-xs">tagged — shows in this game's thread and the Locker Room</span></div>` : ''}
    <div class="chat-composer-row">
      <textarea class="chat-input" id="chat-input" rows="1" maxlength="1000"
        placeholder="Message the league…"></textarea>
      <button class="chat-send-btn" id="chat-send">➤</button>
    </div>
    <div class="chat-composer-foot">
      <div class="chat-emoji-row">${QUICK_EMOJI.map(e => `<button class="chat-emoji-insert" data-emoji="${e}">${e}</button>`).join('')}</div>
      <span class="chat-char-count" id="chat-count" style="display:none"></span>
    </div>
    <div class="chat-mention-menu" id="chat-mention-menu" style="display:none"></div>
  </div>`;
}

function currentComposerTag() {
  // The cross-talk rule, made visible: reply inherits parent tag; else the view.
  if (U.tagStripped) return '';
  const viewTag = ['all', 'records', 'mentions'].includes(U.filter) ? '' : U.filter;
  return resolveTag({ replyTo: U.replyTo, viewTag });
}

function mentionCandidates(prefix) {
  const names = [...getPlayers().filter(p => p.active).map(p => ({ id: p.playerId, name: nameOf(p.playerId) })),
                 { id: 'scribe', name: 'SCRIBE' }];
  const low = prefix.toLowerCase();
  return names.filter(n => n.name.toLowerCase().startsWith(low)).slice(0, 6);
}

function extractMentions(body) {
  const ids = new Set();
  const names = [...getPlayers().map(p => ({ id: p.playerId, name: nameOf(p.playerId) })), { id: 'scribe', name: 'scribe' }];
  (body.match(/@([\w.']+)/g) || []).forEach(tok => {
    const t = tok.slice(1).toLowerCase();
    const hit = names.find(n => n.name.toLowerCase().startsWith(t));
    if (hit) ids.add(hit.id);
  });
  return [...ids];
}

function doSend() {
  const input = document.getElementById('chat-input');
  const body = (input?.value || '').trim();
  if (!body) return;
  const self = me(); if (!self) return;
  const gameTag = currentComposerTag();
  const mentions = extractMentions(body);
  sendMessage({ body, gameTag, replyTo: U.replyTo || '', author: self, mentions });
  // SCRIBE participates as a member — it reads the Locker Room, it isn't summoned.
  try {
    scribeInspectMessage({ author: self, authorName: nameOf(self), body, gameTag, standings: standingsCtx() });
  } catch {}
  U.replyTo = null; U.tagStripped = false;
  if (input) input.value = '';
  renderChatPage();
}

function standingsCtx() {
  try {
    const players = getPlayers().filter(p => p.active);
    // light context: derive first/last from stored season results if available
    return null;   // full standings ctx wired in app layer when needed
  } catch { return null; }
}

// ── Bindings ──────────────────────────────────────────────────────────────────
function bindFilterButtons(root) {
  root?.querySelectorAll('[data-chat-filter]').forEach(b => b.addEventListener('click', () => {
    U.filter = b.dataset.chatFilter;
    U.replyTo = null; U.tagStripped = false;
    renderChatPage();
  }));
}

function bindChatPage() {
  const c = document.getElementById('page-chat'); if (!c) return;
  bindFilterButtons(c);

  document.getElementById('chat-prefs-btn')?.addEventListener('click', () => {
    U.prefsOpen = !U.prefsOpen; renderChatPage();
  });
  bindPrefsPanel();

  document.getElementById('chat-load-older')?.addEventListener('click', async e => {
    e.target.textContent = '…';
    await backfill(100);
    renderChatPage();
  });

  const scroll = document.getElementById('chat-scroll');
  const jump = document.getElementById('chat-jump');
  scroll?.addEventListener('scroll', () => {
    if (!jump) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    jump.style.display = nearBottom ? 'none' : 'block';
  });
  jump?.addEventListener('click', () => { if (scroll) scroll.scrollTop = scroll.scrollHeight; });

  c.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => {
    const el = c.querySelector(`[data-mid="${b.dataset.jump}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('chat-flash'); setTimeout(() => el.classList.remove('chat-flash'), 1200); }
  }));

  c.querySelectorAll('[data-react]').forEach(b => b.addEventListener('click', () => {
    const self = me(); if (!self) return;
    toggleReact(b.dataset.target, b.dataset.react, self);
    renderChatPage();
  }));
  c.querySelectorAll('[data-reply]').forEach(b => b.addEventListener('click', () => {
    U.replyTo = b.dataset.reply; U.tagStripped = false;
    renderChatPage();
    document.getElementById('chat-input')?.focus();
  }));
  c.querySelectorAll('[data-pin]').forEach(b => b.addEventListener('click', () => {
    const self = me(); if (!self) return;
    const msg = getMessage(b.dataset.pin);
    pinMessage(b.dataset.pin, self, !msg?.pinned);
    renderChatPage();
  }));
  c.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const self = me(); if (!self) return;
    const msg = getMessage(b.dataset.edit); if (!msg) return;
    const next = prompt('Edit message (5-minute window):', msg.body);
    if (next !== null && next.trim() && next !== msg.body) { editMessage(msg.id, next.trim(), self); renderChatPage(); }
  }));
  c.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const self = me(); if (!self) return;
    if (confirm('Withdraw this message? A tombstone will remain — SCRIBE keeps the receipts.')) {
      deleteMessage(b.dataset.del, self); renderChatPage();
    }
  }));
  c.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', () => { retryFailed(b.dataset.retry); renderChatPage(); }));
  c.querySelectorAll('[data-callout]').forEach(b => b.addEventListener('click', () => {
    const self = me(); if (!self) return;
    const msg = getMessage(b.dataset.callout); if (!msg) return;
    sendEvent({
      type: 'message', author: self, gameTag: msg.gameTag, notify: true,
      body: 'Prior statement, for the record:',
      meta: { mentions: [msg.author], quote: { id: msg.id, author: msg.author, body: msg.body.slice(0, 160) } },
    });
    renderChatPage();
  }));

  // composer
  const input = document.getElementById('chat-input');
  const count = document.getElementById('chat-count');
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    const len = input.value.length;
    if (count) { count.style.display = len >= 900 ? 'inline' : 'none'; count.textContent = `${len}/1000`; }
    maybeMentionMenu(input);
  });
  input?.addEventListener('keydown', e => {
    const desktop = matchMedia('(min-width: 700px)').matches;
    if (e.key === 'Enter' && !e.shiftKey && desktop) { e.preventDefault(); doSend(); }
  });
  document.getElementById('chat-send')?.addEventListener('click', doSend);
  document.getElementById('chat-cancel-reply')?.addEventListener('click', () => { U.replyTo = null; renderChatPage(); });
  document.getElementById('chat-strip-tag')?.addEventListener('click', () => { U.tagStripped = true; renderChatPage(); });
  c.querySelectorAll('.chat-emoji-insert').forEach(b => b.addEventListener('click', () => {
    const inp = document.getElementById('chat-input');
    if (inp) { inp.value += b.dataset.emoji; inp.focus(); }
  }));
}

function maybeMentionMenu(input) {
  const menu = document.getElementById('chat-mention-menu');
  if (!menu) return;
  const m = /@([\w.']*)$/.exec(input.value.slice(0, input.selectionStart ?? input.value.length));
  if (!m) { menu.style.display = 'none'; return; }
  const cands = mentionCandidates(m[1]);
  if (!cands.length) { menu.style.display = 'none'; return; }
  menu.innerHTML = cands.map(cd => `<button class="chat-mention-opt" data-mention="${esc(cd.name)}">@${esc(cd.name)}</button>`).join('');
  menu.style.display = 'flex';
  menu.querySelectorAll('[data-mention]').forEach(b => b.addEventListener('click', () => {
    input.value = input.value.replace(/@[\w.']*$/, '@' + b.dataset.mention + ' ');
    menu.style.display = 'none';
    input.focus();
  }));
}

// ── Prefs panel (identity + notifications) ────────────────────────────────────
function prefsPanelHTML() {
  const self = me();
  if (!self) return '';
  const prefs = getNotifPrefs();
  const accent = getAccent();
  return `
  <div class="card mb-md chat-prefs">
    <div class="chat-prefs-row"><label>Display name</label>
      <input class="form-input" id="pref-nick" maxlength="16" value="${esc(getChatNick() || '')}" placeholder="${esc(getPlayer(self)?.displayName || '')}" /></div>
    <div class="chat-prefs-row"><label>Accent</label>
      <div class="chat-accent-row">${ACCENTS.map(a =>
        `<button class="chat-accent-swatch${a === accent ? ' active' : ''}" data-accent="${a}" style="background:${a}"></button>`).join('')}
        <button class="chat-accent-swatch chat-accent-none${!accent ? ' active' : ''}" data-accent="" title="Default">∅</button></div></div>
    <div class="chat-prefs-row"><label>Toasts</label><input type="checkbox" id="pref-toasts" ${prefs.toasts ? 'checked' : ''}></div>
    <div class="chat-prefs-row"><label>Sound</label><input type="checkbox" id="pref-sound" ${prefs.sound ? 'checked' : ''}></div>
    <div class="chat-prefs-row"><label>League events</label><input type="checkbox" id="pref-sys" ${prefs.systemEvents ? 'checked' : ''}></div>
  </div>`;
}
function bindPrefsPanel() {
  document.getElementById('pref-nick')?.addEventListener('change', e => { setChatNick(e.target.value); renderChatPage(); });
  document.querySelectorAll('[data-accent]').forEach(b => b.addEventListener('click', () => { setAccent(b.dataset.accent || null); renderChatPage(); }));
  document.getElementById('pref-toasts')?.addEventListener('change', e => setNotifPrefs({ toasts: e.target.checked }));
  document.getElementById('pref-sound')?.addEventListener('change', e => setNotifPrefs({ sound: e.target.checked }));
  document.getElementById('pref-sys')?.addEventListener('change', e => { setNotifPrefs({ systemEvents: e.target.checked }); renderChatPage(); });
}

// ── Game-card bubble + bottom sheet ───────────────────────────────────────────
export function gameChatBubbleHTML(gameId) {
  const self = me();
  const n = getMessages({ tag: gameId, types: ['message'] }).filter(m => !m.deleted).length;
  const unread = self ? unreadCount(self, gameId) : 0;
  return `<button class="chat-bubble-btn${unread ? ' has-unread' : ''}" data-chat-game="${esc(gameId)}" title="Game thread">
    💬${n ? ` <span class="chat-bubble-count">${n}</span>` : ''}</button>`;
}

export function openGameChatSheet(gameId) {
  U.sheetGameId = gameId;
  document.getElementById('chat-sheet-wrap')?.remove();
  const found = gameById(gameId);
  const wrap = document.createElement('div');
  wrap.id = 'chat-sheet-wrap';
  const g = found?.game;
  const score = g && g.homeScore != null ? `${g.awayScore}–${g.homeScore}` : '';
  const firstUse = !localStorage.getItem('cfbp_chat_sheet_hint');
  wrap.innerHTML = `
    <div class="chat-sheet-backdrop"></div>
    <div class="chat-sheet">
      <div class="chat-sheet-header">
        <div><div class="chat-sheet-title">${g ? esc(g.awayTeam) + ' @ ' + esc(g.homeTeam) : 'Game thread'}</div>
          <div class="chat-sheet-sub">${g ? esc(formatSpread(g.lockedSpread ?? g.spread, g.favorite, g) || '') : ''}
            ${g?.status === GAME_STATUS.LIVE ? ` · <span class="live-pulse"></span> LIVE ${score}` : score ? ' · ' + score : ''}</div></div>
        <div class="chat-sheet-header-actions">
          <button class="btn btn-ghost btn-sm" id="chat-sheet-open-main">Open in chat</button>
          <button class="chat-sheet-close" id="chat-sheet-close">✕</button>
        </div>
      </div>
      ${firstUse ? '<div class="chat-sheet-hint" id="chat-sheet-hint">Posts here also appear in the main room, tagged to this game. <button id="chat-sheet-hint-ok">Got it</button></div>' : ''}
      <div class="chat-scroll chat-sheet-scroll" id="chat-sheet-scroll"></div>
      ${me() ? `<div class="chat-composer">
        <div class="chat-composer-row">
          <textarea class="chat-input" id="chat-sheet-input" rows="1" maxlength="1000" placeholder="Message this game's thread…"></textarea>
          <button class="chat-send-btn" id="chat-sheet-send">➤</button>
        </div></div>` : ''}
    </div>`;
  document.body.appendChild(wrap);
  renderSheetMessages();
  wrap.querySelector('.chat-sheet-backdrop')?.addEventListener('click', closeSheet);
  document.getElementById('chat-sheet-close')?.addEventListener('click', closeSheet);
  document.getElementById('chat-sheet-hint-ok')?.addEventListener('click', () => {
    localStorage.setItem('cfbp_chat_sheet_hint', '1');
    document.getElementById('chat-sheet-hint')?.remove();
  });
  document.getElementById('chat-sheet-open-main')?.addEventListener('click', () => { closeSheet(); U.filter = gameId; navToChat(); });
  const send = () => {
    const inp = document.getElementById('chat-sheet-input');
    const body = (inp?.value || '').trim();
    const self = me();
    if (!body || !self) return;
    sendMessage({ body, gameTag: gameId, author: self, mentions: extractMentions(body) });
    try { scribeInspectMessage({ author: self, authorName: nameOf(self), body, gameTag: gameId }); } catch {}
    if (inp) inp.value = '';
    renderSheetMessages();
  };
  document.getElementById('chat-sheet-send')?.addEventListener('click', send);
  document.getElementById('chat-sheet-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(min-width:700px)').matches) { e.preventDefault(); send(); }
  });
  markSeen(gameId);
  updateChatBadges();
}
function closeSheet() { U.sheetGameId = null; document.getElementById('chat-sheet-wrap')?.remove(); }
function renderSheetMessages() {
  const host = document.getElementById('chat-sheet-scroll');
  if (!host || !U.sheetGameId) return;
  const self = me();
  const list = coalesceStream(getMessages({ tag: U.sheetGameId }));
  host.innerHTML = list.length
    ? list.map(item => item.kind === 'gamereact-run' ? gamereactRunHTML(item) : messageHTML(item, self, false)).join('')
    : '<div class="chat-empty">No entries for this game yet.</div>';
  host.scrollTop = host.scrollHeight;
  host.querySelectorAll('[data-react]').forEach(b => b.addEventListener('click', () => {
    if (!self) return; toggleReact(b.dataset.target, b.dataset.react, self); renderSheetMessages();
  }));
  host.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', () => { retryFailed(b.dataset.retry); renderSheetMessages(); }));
}

// ── Dashboard sticky bar ──────────────────────────────────────────────────────
export function dashboardChatTeaserHTML() {
  const self = me();
  const n = self ? unreadCount(self, 'all') : 0;
  const latest = latestNotifying(self);
  const preview = latest ? `<strong>${esc(nameOf(latest.author))}</strong>: ${esc(latest.body.slice(0, 64))}` : 'The Locker Room is open.';
  return `
  <div class="card mb-md dash-chat-teaser" id="dash-chat-teaser">
    <div class="dash-chat-left" data-open-chat>
      <span class="dash-chat-icon">💬</span>
      <div>
        <div class="dash-chat-title">Locker Room ${n ? `<span class="chat-unread-dot">${n > 99 ? '99+' : n}</span>` : ''}</div>
        <div class="dash-chat-preview">${preview}</div>
      </div>
    </div>
    ${self ? `<div class="dash-chat-quick">
      <input class="form-input dash-chat-input" id="dash-quick-input" maxlength="1000" placeholder="Quick reply…" />
      <button class="btn btn-primary btn-sm" id="dash-quick-send">➤</button>
    </div>` : ''}
  </div>`;
}

function bindDashboardTeaser() {
  const send = () => {
    const inp = document.getElementById('dash-quick-input');
    const body = (inp?.value || '').trim();
    const self = me();
    if (!body || !self) return;
    sendMessage({ body, gameTag: '', author: self, mentions: extractMentions(body) });
    if (inp) { inp.value = ''; inp.placeholder = 'Sent ✓'; setTimeout(() => { inp.placeholder = 'Quick reply…'; }, 1500); }
    updateChatBadges();
  };
  document.getElementById('dash-quick-send')?.addEventListener('click', e => { e.stopPropagation(); send(); });
  document.getElementById('dash-quick-input')?.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });
  document.getElementById('dash-quick-input')?.addEventListener('click', e => e.stopPropagation());
}

// ── Legacy alias (app.js compatibility) ───────────────────────────────────────
export function setChatChannel(ch) {
  if (!ch || ch === 'general' || ch === 'all') U.filter = 'all';
  else if (ch.startsWith('game:')) U.filter = ch.slice(5);
  else U.filter = ch;
}

// ── System event emitters (deterministic ids — AD-11) ─────────────────────────
// HARD RULE: nothing may reveal a player's selections before that week locks.

export function emitPicksLockedEvent(weekId, playerId, count, total) {
  sendEvent({
    id: `sys_lock_${weekId}_${playerId}`, type: 'system', author: 'system', notify: false,
    body: `${nameOf(playerId)} locked ${count}/${total}`,
    meta: { kind: 'picksLocked', weekId, playerId },
  });
}

/** THE PICK REVEAL RITUAL — at lock, one system event posts everyone's full
 *  picks simultaneously. The one guaranteed weekly all-hands moment. */
export function emitPickRevealEvent(week) {
  if (!week) return;
  const eff = getEffectiveWeekStatus(week);
  if (!['locked', 'live', 'final'].includes(eff) && week.status !== 'final') return;   // never pre-lock
  const games = getGames(week.weekId).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  if (!games.length) return;
  const players = getPlayers().filter(p => p.active);
  const lines = players.map(p => {
    const picks = getPicks(week.weekId, p.playerId);
    if (!picks.length) return `${nameOf(p.playerId)} — no orders on file`;
    const parts = games.map(g => {
      const pk = picks.find(x => x.gameId === g.gameId);
      return pk ? pk.selectedTeam.split(' ').pop() : '—';
    });
    return `${nameOf(p.playerId)}: ${parts.join(' · ')}`;
  });
  sendEvent({
    id: `sys_reveal_${week.weekId}`, type: 'system', author: 'system', notify: true,
    body: lines.join('\n'),
    meta: { kind: 'reveal', weekId: week.weekId, title: `${formatWeekLabel(week)} — the orders are in` },
  });
  showToast({ author: 'system', body: `🔓 ${formatWeekLabel(week)} picks revealed` }, { force: true });
}

export function emitKickoffEvent(game) {
  sendEvent({
    id: `sys_kick_${game.gameId}`, type: 'system', author: 'system', notify: false,
    gameTag: game.gameId,
    body: `🏈 Kickoff — ${game.awayTeam} @ ${game.homeTeam} ${formatSpread(game.lockedSpread ?? game.spread, game.favorite, game) || ''}`,
    meta: { kind: 'kickoff', gameId: game.gameId },
  });
}

export function emitGameFinalEvent(game, atsWinner, winnerIds = [], loserIds = []) {
  const cover = atsWinner === 'no_decision' ? 'Push — no decision'
    : `${atsWinner} covers ✅`;
  const who = atsWinner === 'no_decision' ? ''
    : ` — right: ${winnerIds.length ? winnerIds.map(nameOf).join(', ') : 'nobody'}; wrong: ${loserIds.length ? loserIds.map(nameOf).join(', ') : 'nobody'}`;
  sendEvent({
    id: `sys_final_${game.gameId}`, type: 'system', author: 'system', notify: false,
    gameTag: game.gameId,
    body: `FINAL: ${game.awayTeam} ${game.awayScore}–${game.homeScore} ${game.homeTeam}. ${cover}${who}`,
    meta: { kind: 'gameFinal', gameId: game.gameId },
  });
  // SCRIBE's unprompted callout: one pre-kick statement from a player who lost
  // this game ATS, quoted next to the result. Rate limits apply.
  try {
    const kicked = game.kickoff ? new Date(game.kickoff).getTime() : 0;
    const candidates = getMessages({ tag: game.gameId, types: ['message'] })
      .filter(m => !m.deleted && loserIds.includes(m.author) && kicked && (m.ts || 0) < kicked);
    if (candidates.length) {
      const pick = candidates.sort((a, b) => (b.body?.length || 0) - (a.body?.length || 0))[0];
      scribeTrigger('callout', {
        gameTag: game.gameId, subject: game.gameId,
        quote: { id: pick.id, author: pick.author, body: pick.body.slice(0, 160) },
      });
    }
  } catch {}
}

export function emitExtraPointEvent(weekId, graded) {
  const lines = graded.rows.map(r => {
    const label = { blackjack: '🂡 BLACKJACK', win: '✅ win', 'push-win': '✅ shared win', bust: '💥 bust', alive: 'under', 'no-entry': '—' }[r.outcome] || r.outcome;
    return `${r.displayName}: ${r.guess == null ? 'no entry' : r.guess + ' yd'} ${label}`;
  });
  sendEvent({
    id: `sys_ep_${weekId}`, type: 'system', author: 'system', notify: false,
    body: `🎯 Extra Point — actual ${graded.actual} yd\n${lines.join('\n')}${graded.allBusted ? '\nEveryone over. The house (the chart) wins.' : ''}`,
    meta: { kind: 'extraPoint', weekId },
  });
  try {
    const bust = graded.rows.find(r => r.outcome === 'bust');
    const win = graded.rows.find(r => r.outcome === 'blackjack' || r.outcome === 'win' || r.outcome === 'push-win');
    if (graded.allBusted) scribeTrigger('extraPointBust', { subject: weekId, vars: { name: 'the entire cohort' } });
    else if (win) scribeTrigger('extraPointWin', { subject: weekId, vars: { name: win.displayName } });
    else if (bust) scribeTrigger('extraPointBust', { subject: weekId, vars: { name: bust.displayName } });
  } catch {}
}

export function emitWeekFinalEvent(week, rankedResults) {
  if (!rankedResults?.length) return;
  const lines = rankedResults.map(r => `${r.rank}. ${nameOf(r.playerId)} — ${r.correctPicks}`);
  sendEvent({
    id: `sys_weekfinal_${week.weekId}`, type: 'system', author: 'system', notify: false,
    body: `📊 ${formatWeekLabel(week)} final\n${lines.join('\n')}`,
    meta: { kind: 'weekFinal', weekId: week.weekId },
  });
  // Hall of Records auto-promotion: the week's top-reacted message becomes canon.
  try {
    const start = week.startDate ? new Date(week.startDate + 'T00:00:00').getTime() - 4 * 86400000 : 0;
    const end = Date.now();
    const top = getMessages({ tag: 'all', types: ['message'] })
      .filter(m => !m.deleted && m.author !== 'system' && (m.ts || 0) >= start && (m.ts || 0) <= end)
      .map(m => ({ m, n: Object.values(m.reactions || {}).reduce((a, v) => a + v.length, 0) }))
      .sort((a, b) => b.n - a.n)[0];
    if (top && top.n >= 2 && !top.m.pinned) {
      sendEvent({ id: `pin_wk_${week.weekId}`, type: 'pin', targetId: top.m.id, author: 'scribe', notify: false });
    }
  } catch {}
}

// ── SCRIBE live-game observation (rides the existing score poll) ──────────────
/** Called per game on each score refresh with the pre-update copy. */
export function scribeLiveGameCheck(prevGame, nextGame) {
  try {
    if (!nextGame || nextGame.status !== GAME_STATUS.LIVE) return;
    const found = gameById(nextGame.gameId);
    const week = found?.week || getCurrentWeek();
    const nPicks = week ? getPicks(week.weekId).filter(p => p.gameId === nextGame.gameId).length : 0;
    if (nPicks < 3) return;   // only hotly-contested, widely-picked games
    const spread = nextGame.lockedSpread ?? nextGame.spread;
    if (spread == null || nextGame.homeScore == null || prevGame?.homeScore == null) return;
    const margin = g => (g.homeScore + spread) - g.awayScore;   // >0 home covering
    const before = margin(prevGame), after = margin(nextGame);
    if (Math.sign(before) !== Math.sign(after) && before !== 0 && after !== 0) {
      scribeTrigger('coverageFlip', { gameTag: nextGame.gameId, subject: nextGame.gameId, bucketMin: 30 });
      return;
    }
    // Upset watch: the underdog leading outright by 9+
    const homeIsFav = nextGame.favorite === nextGame.homeTeam;
    const dogLead = homeIsFav ? nextGame.awayScore - nextGame.homeScore : nextGame.homeScore - nextGame.awayScore;
    if (dogLead >= 9) {
      const dog = homeIsFav ? nextGame.awayTeam : nextGame.homeTeam;
      scribeTrigger('upsetWatch', { gameTag: nextGame.gameId, subject: nextGame.gameId, bucketMin: 60, vars: { TEAM: dog } });
    }
  } catch {}
}

// ── "One year ago today" (dormant until CFP 2K27 — data exists from day one) ──
function maybeAnniversary() {
  try {
    const key = 'cfbp_scribe_anniv';
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(key) === today) return;
    const target = Date.now() - 365 * 86400000;
    const hit = getMessages({ tag: 'all', types: ['message'] })
      .filter(m => !m.deleted && m.author !== 'system' && Math.abs((m.ts || 0) - target) < 12 * 3600000)
      .sort((a, b) => Object.values(b.reactions || {}).flat().length - Object.values(a.reactions || {}).flat().length)[0];
    localStorage.setItem(key, today);
    if (hit) scribeTrigger('anniversary', {
      subject: hit.id, quote: { id: hit.id, author: hit.author, body: hit.body.slice(0, 160) },
    });
  } catch {}
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initChatUI() {
  initChat(me());

  onChat((kind, detail) => {
    if (kind === 'events') {
      updateChatBadges();
      const self = me();
      const latest = latestNotifying(self);
      if (latest && latest.author !== self && !latest.local &&
          typeof latest.seq === 'number' && latest.seq > getLastSeen().seq) {
        if (!chatPageActive()) { showToast(latest); playBlip(); }
      }
      if (chatPageActive()) renderChatPage();
      if (U.sheetGameId) renderSheetMessages();
      const teaser = document.getElementById('dash-chat-teaser');
      if (teaser && !document.getElementById('dash-quick-input')?.matches(':focus')) {
        teaser.outerHTML = dashboardChatTeaserHTML();
        bindDashboardTeaser();
      }
    }
    if (kind === 'offline' || kind === 'online' || kind === 'presence') {
      if (chatPageActive()) renderChatPage();
    }
  });

  // Delegated clicks that survive any re-render
  document.addEventListener('click', e => {
    const gameBtn = e.target.closest?.('[data-chat-game]');
    if (gameBtn) { e.preventDefault(); openGameChatSheet(gameBtn.dataset.chatGame); return; }
    const openChat = e.target.closest?.('[data-open-chat]');
    if (openChat) { e.preventDefault(); navToChat(); }
  });

  // Rebind the teaser whenever the dashboard renders it
  const rebind = new MutationObserver(() => {
    if (document.getElementById('dash-quick-input') && !document.getElementById('dash-quick-input')._bound) {
      document.getElementById('dash-quick-input')._bound = true;
      bindDashboardTeaser();
    }
  });
  try { rebind.observe(document.body, { childList: true, subtree: true }); } catch {}

  maybeAnniversary();
  updateChatBadges();
}
