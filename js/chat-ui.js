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
 *      documents on its own schedule, is always on duty, and answers when
 *      addressed. Live-game observations ride the existing score poll.
 *
 * v0.17.2 — player presence ("N here now") and read receipts ("seen by k") were
 * removed; see the note in chat.js and the amended AD-19. The header subtitle
 * keeps SCRIBE's standing "on duty" framing (UN-67), which was never presence-
 * derived — it was static copy concatenated onto the presence line.
 *
 * All state lives in chat.js; this module renders and forwards intents.
 */

import {
  initChat, onChat, chatStatus, getMessages, getMessage, resolveTag,
  sendMessage, sendEvent, editMessage, deleteMessage, toggleReact, pinMessage,
  sendGameReact, retryFailed, isFailed, isPending,
  unreadCount, unreadAuthors, mentionUnreadCount, markSeen, getLastSeen, latestNotifying,
  backfill, chatDigest as _digest, setViewOpen,
  getRetentionDays, isChatEnabled,
} from './chat.js';
import { scribeInspectMessage, scribeTrigger } from './scribeLines.js';
import {
  getSession, getPlayers, getPlayer, getCurrentWeek, getGames, getWeeks,
  getPicks, getEffectiveWeekStatus,
  getAccent, setAccent, getAccentFor, getChatNick, setChatNick, getChatNickFor,
  getNotifPrefs, setNotifPrefs,
} from './storage.js';
import { formatSpread, formatWeekLabel, GAME_STATUS, buildAbbrMap, REACTION_PALETTE } from './data-model.js';
import { calculateAtsWinner } from './scoring.js';

export const chatDigest = _digest;

// AD-20 extended to emoji (item G): QUICK_EMOJI is a DERIVED subset of the
// one shared palette in data-model.js, never an independent literal. The full
// REACTION_PALETTE is reachable from the composer's "more emoji" picker.
const QUICK_EMOJI = REACTION_PALETTE.slice(0, 6);
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
  returnToChat: false,      // set when a signed-out reader taps "Log in" in chat
  returnFilter: null,       // the filter they were reading, restored after login
  returnAt: 0,              // when it was set — the intent expires (see RETURN_WINDOW_MS)
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Guarded localStorage. These are device-local UI hints (AD-12) — never seam
 * keys — so failure is always safe to swallow.
 *
 * v0.17.2 (iOS fix): iOS Safari in Private Browsing throws on localStorage
 * access. chat.js already wrapped its calls; chat-ui.js did not. The unguarded
 * getItem on the game-sheet open path meant tapping a dashboard chat bubble
 * threw before the sheet rendered — the reported "nothing happens on mobile".
 */
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private browsing */ } }
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
/**
 * Per-render memo of slate → abbreviation map, keyed by weekId.
 *
 * buildAbbrMap walks the whole slate and runs a dedup pass, so it is far too
 * expensive to call once per rendered row. gameShort() is invoked from four
 * render-loop sites and renderChatPage() re-runs on every inbound chat event,
 * so the uncached version re-derived the same map dozens of times per pass.
 *
 * Cleared at the top of ALL THREE render entry points that can reach gameShort:
 * renderChatPage(), renderPillsOnly(), and renderSheetMessages(). The map is only
 * ever a within-pass cache, so a mid-session slate edit can never be served
 * stale. If you add a fourth render path, clear it there too — loadtest section
 * [8g] asserts the count is exactly 3 and will fail until you update it.
 */
const _abbrMemo = new Map();
function abbrMapFor(weekId, fallbackGames) {
  if (weekId && _abbrMemo.has(weekId)) return _abbrMemo.get(weekId);
  const slate = weekId ? getGames(weekId) : [];
  // Only a real slate gets memoized. A map built from the single-game fallback
  // describes that game, not the week, so caching it under the weekId would
  // hand the wrong map to the next game in the same week.
  if (!slate.length) return buildAbbrMap(fallbackGames || []);
  const map = buildAbbrMap(slate);
  _abbrMemo.set(weekId, map);
  return map;
}

/**
 * Away/Home shorthand for a game, using the SAME abbreviation source as the
 * compact dashboard (data-model.js). Built from the game's own week so the
 * dedup pass matches what the dashboard renders for that slate.
 *
 * v0.17.2: replaced a local `name.split(' ').pop()` heuristic that produced
 * wrong shorthand for multi-word schools — "Southern California" rendered as
 * "California", "Arkansas State" as "State". Never reintroduce a second
 * mapping here; import from data-model.js.
 */
function gameShort(g, week) {
  if (!g) return '';
  const map = abbrMapFor(week?.weekId, [g]);
  const abbr = t => map.get(t) || t || '';
  return `${abbr(g.awayTeam)}/${abbr(g.homeTeam)}`;
}
function chatPageActive() {
  return typeof document !== 'undefined' && !!document.querySelector('#page-chat.active');
}
function dashboardPageActive() {
  return typeof document !== 'undefined' && !!document.querySelector('#page-dashboard.active');
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
  // Shorthand comes from the shared slate map — never a local heuristic. The
  // full school name stays in the title attribute, so the chip is short and
  // the hover is unambiguous.
  const short = abbrMapFor(found.week?.weekId, [found.game]).get(pick.selectedTeam) || pick.selectedTeam;
  return `<span class="${cls}" title="${esc(nameOf(authorId))} picked ${esc(pick.selectedTeam)}">⚡ ${esc(short)}</span>`;
}

// ── Game thread header colors (item F) ─────────────────────────────────────
/**
 * The four dashboard-mirrored states, computed from the CURRENT VIEWER's own
 * pick — blind-rule-safe by construction, since a player's own pick is
 * always visible to themselves regardless of lock status (only OTHER
 * players' picks are lock-gated, UN-57). No pick, or a game that hasn't
 * gone live/final yet, returns '' (no color, structural header only).
 *
 * Reuses the dashboard's OWN color logic rather than reimplementing it:
 * `livePickStatus(pick, game)` lives in app.js (private, not exported — and
 * app.js already imports chat-ui.js, so chat-ui.js importing app.js back
 * would be a cycle). app.js exposes it on `window.livePickStatus`, the same
 * bridge pattern already used for window.navigateTo/window.showToast. If the
 * bridge isn't up yet (defensive only — by the time a user can tap into a
 * game thread, app.js's module-level code has long since run), this
 * degrades to no color rather than throwing.
 *
 * HARD REQUIREMENT: static only, no pulse. The dashboard's live states
 * deliberately animate; that reads as noisy in a chat header, so these are
 * dedicated `.chat-thread-*` classes with no `animation` property at all —
 * NOT the pulsing `.pick-live-covering` / `.dc-chip-live-covering` classes.
 */
function gameThreadHeaderClass(pick, g) {
  if (!pick || !g) return '';
  if (g.status === GAME_STATUS.LIVE) {
    const fn = (typeof window !== 'undefined') ? window.livePickStatus : null;
    const ls = typeof fn === 'function' ? fn(pick, g) : null;
    if (ls === 'covering') return ' chat-thread-covering';
    if (ls === 'trailing') return ' chat-thread-trailing';
    if (ls === 'even') return ' chat-thread-even';
    return '';
  }
  if (g.status === GAME_STATUS.FINAL) {
    const ats = g.atsWinner ?? calculateAtsWinner(g);
    if (!ats || ats === 'no_decision') return '';
    return pick.selectedTeam === ats ? ' chat-thread-won' : ' chat-thread-lost';
  }
  return '';
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

/**
 * Item A — chat OFF must never leave a player stranded on a dead chat page.
 * Bounces to Dashboard with a toast. Uses the same window.* bridge pattern
 * already established for crossing the app.js/chat-ui.js boundary without a
 * circular import (see bindLoginPrompt's window.navigateTo usage) — app.js
 * exposes both window.navigateTo and window.showToast for exactly this.
 */
function redirectChatDisabled() {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast('Chat has been turned off by the commissioner.', 'warning');
  }
  if (typeof window !== 'undefined' && typeof window.navigateTo === 'function') window.navigateTo('dashboard');
  else document.querySelector('.nav-item[data-tab="dashboard"]')?.click();
}

export function updateChatBadges() {
  const self = me();
  // v0.17.3 (caught in review): this was the FIFTH surface item A missed. With
  // chat off league-wide it still wrote the document title "(7) IRB Pick 'Ems"
  // and called navigator.setAppBadge(7) — which PERSISTS on the installed PWA
  // home-screen icon. A player taps in to clear a "7" and finds no Chat nav
  // entry, no bubbles, nothing to clear. n = 0 already drives the correct
  // clear on all three sub-surfaces below.
  const n = (self && isChatEnabled()) ? unreadCount(self, 'all') : 0;
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
  // v0.17.2: these return Promises. A rejection escapes try/catch and lands as
  // an unhandled rejection (CONVENTIONS #4), which is exactly the class of
  // silent iOS breakage we were hunting. Catch the promise, not just the throw.
  try {
    if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
      const p = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch {}
}

// ── Filter pills ──────────────────────────────────────────────────────────────
function activeGameTags() {
  // Games worth a pill: any tagged traffic, or live games on the current slate.
  const tags = new Map();   // gameId -> lastTs
  // respectRetention: a game whose entire thread is hidden must not get a pill
  // that opens to an empty room.
  getMessages({ tag: 'all', respectRetention: true }).forEach(m => {
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
    <button class="chat-pill${U.filter === 'records' ? ' active' : ''}" data-chat-filter="records" title="Hall of Records">🏛 Records</button>`;
  activeGameTags().forEach(tag => {
    const found = gameById(tag);
    if (!found) return;
    const live = found.game.status === GAME_STATUS.LIVE;
    const n = self ? unreadCount(self, tag) : 0;
    html += `<button class="chat-pill${U.filter === tag ? ' active' : ''}${live ? ' chat-pill-live' : ''}" data-chat-filter="${esc(tag)}">
      ${live ? '<span class="live-pulse"></span>' : ''}${esc(gameShort(found.game, found.week))} ${dot(n)}</button>`;
  });
  return `<div class="chat-pills-scroll">${html}</div>`;
}

/**
 * Player-visible retention notice (UN-8x). A player who scrolls back and hits
 * a wall deserves a calm factual explanation, not a mystery — shown to
 * everyone when the commissioner's retention window is ON, absent entirely
 * when it's OFF. Static copy, no user data, nothing to escape.
 */
/**
 * v0.17.2: with retention on, "↑ load earlier" is a dead control — it fires a
 * real Apps Script round-trip and then renders nothing, because everything it
 * backfills is older than the cutoff. Worse, it sits directly under a notice
 * saying "Showing the last 7 days", so the UI contradicts itself. Hide it.
 */
function retentionOn() {
  try { return getRetentionDays() > 0; } catch { return false; }
}

function retentionNoticeHTML() {
  const days = getRetentionDays();
  if (days <= 0) return '';
  return `<div class="chat-retention-notice text-muted text-xs">Showing the last ${days} days. 🏛 Pinned messages are always kept.</div>`;
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
  // v0.17.2: spread removed from message chips — it's redundant with the game
  // thread header card and the dashboard. Chips show matchup shorthand only.
  return `<button class="chat-game-chip" data-chat-filter="${esc(m.gameTag)}">${esc(gameShort(found.game, found.week))}</button>`;
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
    return `${esc(m.meta?.emoji || '👀')} ${found ? esc(gameShort(found.game, found.week)) : ''}`;
  }).join(' · ');
  return `<div class="chat-msg chat-system chat-gamereact" data-ts="${run.ts}">
    <div class="chat-system-body">${esc(nameOf(run.author))} reacted &nbsp;${parts}</div>
    <span class="chat-time">${relTime(run.ts)}</span>
  </div>`;
}

// ── Main chat page ────────────────────────────────────────────────────────────
export function renderChatPage() {
  const c = document.getElementById('page-chat'); if (!c) return;
  // Item A — chat OFF hides this surface entirely. Guard here (not just at
  // the nav level) so ANY caller of renderChatPage() — navigateTo(), a stray
  // onChat re-render, resumeChatAfterLogin() — bounces rather than rendering
  // a page whose polling has already been stopped.
  if (!isChatEnabled()) { redirectChatDisabled(); return; }
  _abbrMemo.clear();                                 // per-pass cache only (see abbrMapFor)
  const self = me();
  const st = chatStatus();
  setViewOpen(true);

  // respectRetention: true — the rendered stream honors the commissioner's
  // window (UN-8x). Harmless to pass on the 'records' filter too: pinned
  // messages are exempt from retention by construction (isHiddenByRetention),
  // so Hall of Records is unaffected either way — passing it everywhere keeps
  // the intent uniform instead of relying on that exemption silently.
  let list;
  if (U.filter === 'records') list = getMessages({ tag: 'all', pinned: true, respectRetention: true });
  else if (U.filter === 'mentions') {
    // v0.17.1 — mention inbox removed. If a device has stale state pointing at
    // 'mentions', treat it as 'all' and fix the filter forward.
    U.filter = 'all';
    list = getMessages({ tag: 'all', respectRetention: true });
  }
  else if (U.filter === 'all') list = getMessages({ tag: 'all', respectRetention: true });
  else list = getMessages({ tag: U.filter, respectRetention: true });

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

  // Header context for game views — item F: mirrors the dashboard's static
  // covering/trailing/won/lost colors for the CURRENT viewer's own pick
  // (blind-rule-safe: your own pick is always visible to you).
  let viewHeader = '';
  if (!['all', 'records'].includes(U.filter)) {
    const found = gameById(U.filter);
    if (found) {
      const g = found.game;
      const score = g.homeScore != null ? `${g.awayScore}–${g.homeScore}` : '';
      const myViewPick = self ? getPicks(found.week.weekId, self).find(p => p.gameId === g.gameId) : null;
      const headerCls = gameThreadHeaderClass(myViewPick, g);
      viewHeader = `<div class="chat-view-header${headerCls}">
        <div><strong>${esc(g.awayTeam)} @ ${esc(g.homeTeam)}</strong>
          <span class="text-muted text-xs">${esc(formatSpread(g.lockedSpread ?? g.spread, g.favorite, g) || '')}</span></div>
        <div>${g.status === GAME_STATUS.LIVE ? `<span class="live-pulse"></span> LIVE ${score}` : score}</div>
      </div>`;
    }
  }

  // v0.17.2 — the player-presence prefix ("N here now · ") was removed; SCRIBE's
  // standing "on duty" framing (UN-67) is static copy and stays.
  const subtitleLine = '📋 SCRIBE on duty';

  const banner = st.offline ? `<div class="chat-offline-banner">⚠️ CHAT OFFLINE — ${st.staleDeployment
    ? 'the backend deployment is out of date. Commissioner: open Apps Script → Deploy → Manage deployments → Edit → <b>New version</b>, then reload.'
    : `messages are not syncing. Retrying… <span class="text-xs">(${esc(st.lastError || '')})</span>`}</div>` : '';

  c.innerHTML = `
    <div class="section-header chat-header-row">
      <div><h2>Chat</h2><div class="subtitle">${esc(subtitleLine)}</div></div>
      <button class="btn btn-ghost btn-sm" id="chat-prefs-btn" title="Chat preferences">⚙️</button>
    </div>
    ${U.prefsOpen ? prefsPanelHTML() : ''}
    ${banner}
    ${pillsHTML()}
    ${retentionNoticeHTML()}
    ${viewHeader}
    <div class="chat-scroll" id="chat-scroll">
      ${retentionOn() ? '' : '<button class="chat-load-older" id="chat-load-older">↑ load earlier</button>'}
      ${msgsHTML}
    </div>
    <button class="chat-jump-latest" id="chat-jump" style="display:none">↓ latest</button>
    ${self ? composerHTML() : loginPromptHTML()}
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
  _abbrMemo.clear();                                 // per-pass cache only (see abbrMapFor)
  const host = document.querySelector('#page-chat .chat-pills-scroll');
  if (host) host.outerHTML = pillsHTML();
  bindFilterButtons(document.getElementById('page-chat'));
}

// ── Signed-out composer replacement ───────────────────────────────────────────
/**
 * v0.17.2: reading the Locker Room is open to anyone who cleared the site PIN;
 * posting requires a verified player. Previously this was a dead line of text.
 * Now it mirrors the dashboard's "Go to Picks" pattern — a real button that
 * routes to the login screen and comes back here once the player is verified.
 */
function loginPromptHTML() {
  return `
  <div class="chat-login-prompt">
    <div class="chat-login-prompt-text">
      <strong>Log in to post.</strong>
      <span class="text-muted text-xs">Reading is open to the league — posting needs your PIN.</span>
    </div>
    <button class="btn btn-primary btn-sm" id="chat-login-btn">Log in →</button>
  </div>`;
}

function bindLoginPrompt(root) {
  root?.querySelector('#chat-login-btn')?.addEventListener('click', () => {
    // Remember where they were so login can bounce them back (doc 1.2).
    U.returnToChat = true;
    U.returnFilter = U.filter;
    U.returnAt = Date.now();
    if (typeof window !== 'undefined' && typeof window.navigateTo === 'function') window.navigateTo('picks');
    else document.querySelector('.nav-item[data-tab="picks"]')?.click();
  });
}

/**
 * Called after a successful login. If the player was sent to the login screen
 * from chat, put them back in the same filter they were reading.
 *
 * The intent EXPIRES. It used to be cleared only on a successful player-PIN
 * login, so a reader who tapped "Log in →" and then wandered off left the flag
 * set for the rest of the session — and their next login, possibly days later,
 * silently yanked them out of the picks page into chat. "Bounce me back" only
 * means anything within a few minutes of the tap; after that it is stale intent
 * and the login should land wherever it normally lands.
 *
 * The flag is consumed unconditionally, so it can never go sticky again.
 */
const RETURN_WINDOW_MS = 5 * 60 * 1000;

export function resumeChatAfterLogin() {
  if (!U.returnToChat) return false;
  const fresh = Date.now() - U.returnAt < RETURN_WINDOW_MS;
  const filter = U.returnFilter;
  U.returnToChat = false; U.returnFilter = null; U.returnAt = 0;
  if (!fresh) return false;
  if (filter) U.filter = filter;
  navToChat();
  return true;
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
    ${found ? `<div class="chat-tag-chip-row"><span class="chat-tag-chip">🏈 ${esc(gameShort(found.game, found.week))}
      <button id="chat-strip-tag" title="Remove game tag — post to the main room only">✕</button></span>
      <span class="text-muted text-xs">tagged — shows in this game's thread and the Locker Room</span></div>` : ''}
    <div class="chat-composer-row">
      <textarea class="chat-input" id="chat-input" rows="1" maxlength="1000"
        placeholder="Message the league…"></textarea>
      <button class="chat-send-btn" id="chat-send">➤</button>
    </div>
    <div class="chat-composer-foot">
      <div class="chat-emoji-row">${QUICK_EMOJI.map(e => `<button class="chat-emoji-insert" data-emoji="${e}">${e}</button>`).join('')}<button type="button" class="chat-emoji-insert chat-emoji-more" id="chat-emoji-more" title="More emoji" aria-label="More emoji">➕</button></div>
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
  bindLoginPrompt(c);

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
  c.querySelectorAll('.chat-emoji-insert:not(.chat-emoji-more)').forEach(b => b.addEventListener('click', () => {
    const inp = document.getElementById('chat-input');
    if (inp) { inp.value += b.dataset.emoji; inp.focus(); }
  }));
  document.getElementById('chat-emoji-more')?.addEventListener('click', e => {
    e.stopPropagation();
    const foot = e.currentTarget.closest('.chat-composer-foot');
    if (foot) toggleChatEmojiPicker(foot);
  });
}

/**
 * Item G — the full REACTION_PALETTE, reachable from the composer via a
 * "more emoji" button. Reuses `.reaction-picker` / `.reaction-pick-option`
 * verbatim (same CSS grid app.js's dashboard reaction picker already solved:
 * 5×3 desktop / 7×3 mobile, 42-44px targets) rather than inventing a second
 * layout — the v0.15.1 picker shipped at ~22×22px and had to be rebuilt once
 * already; don't repeat that.
 *
 * Built/removed via direct DOM node creation (the SAME pattern as app.js's
 * `bindReactionHandlers` "+" picker), not a `renderChatPage()` re-render —
 * a full re-render would wipe any text the player had already typed into the
 * composer (composerHTML() always starts the textarea empty).
 */
function toggleChatEmojiPicker(anchorEl) {
  const existing = document.getElementById('chat-emoji-picker');
  if (existing) { existing.remove(); return; }
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.id = 'chat-emoji-picker';
  picker.innerHTML = REACTION_PALETTE.map(em => `<button type="button" class="reaction-pick-option" data-emoji="${esc(em)}">${em}</button>`).join('');
  anchorEl.appendChild(picker);
  picker.querySelectorAll('[data-emoji]').forEach(opt => opt.addEventListener('click', ev => {
    ev.stopPropagation();
    const inp = document.getElementById('chat-input');
    if (inp) { inp.value += opt.dataset.emoji; inp.focus(); }
    picker.remove();
  }));
  setTimeout(() => {
    const closer = ev => {
      if (!picker.contains(ev.target) && !ev.target.closest?.('#chat-emoji-more')) {
        picker.remove();
        document.removeEventListener('click', closer);
      }
    };
    document.addEventListener('click', closer);
  }, 0);
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
/**
 * Item B — three visually distinct states (not just a boolean "has
 * unread"), and the bubble shows UNREAD count, not the thread's total
 * message count (the old render used `n`, the total — it lied the moment you
 * had read even one message).
 *
 * Attribution (who the unread is FROM) mirrors the emoji-reaction pattern
 * (`.reaction-chip`'s `title`) — chosen, deliberately, as OPTION 2 of the
 * spec's three acceptable answers, not option 1. That pattern IS a bare
 * `title` attribute, and tooltips do not fire on touch — we hit this exact
 * gap with the Records pill in batch 2. Reusing it verbatim would ship a
 * desktop-only affordance while implying it works on a phone. So: `title`
 * for desktop hover, PLUS the same names in `aria-label` so the information
 * is available on every device via assistive tech (VoiceOver/TalkBack read
 * aria-label on focus/tap). Known, documented gap: a SIGHTED touch-only user
 * still has no *visual* peek at who without opening the thread — tapping the
 * bubble already does that (its primary action), so the practical cost is
 * low, but it is real and is not silently papered over here.
 */
export function gameChatBubbleHTML(gameId) {
  if (!isChatEnabled()) return '';
  const self = me();
  const n = getMessages({ tag: gameId, types: ['message'], respectRetention: true }).filter(m => !m.deleted).length;
  const unread = self ? unreadCount(self, gameId) : 0;
  const state = unread > 0 ? 'unread' : (n > 0 ? 'read' : 'empty');
  const countHTML = unread > 0 ? ` <span class="chat-bubble-count">${unread > 99 ? '99+' : unread}</span>` : '';
  let text;
  if (unread > 0) {
    const names = self ? unreadAuthors(self, gameId).map(nameOf) : [];
    text = names.length
      ? `${unread} unread from ${names.join(', ')}`
      : `${unread} unread`;
  } else if (n > 0) {
    text = 'Game thread — all caught up';
  } else {
    text = 'Game thread — no messages yet';
  }
  return `<button type="button" class="chat-bubble-btn chat-bubble-${state}" data-chat-game="${esc(gameId)}"
    title="${esc(text)}" aria-label="${esc(text)}">💬${countHTML}</button>`;
}

export function openGameChatSheet(gameId) {
  if (!isChatEnabled()) { redirectChatDisabled(); return; }
  U.sheetGameId = gameId;
  document.getElementById('chat-sheet-wrap')?.remove();
  const found = gameById(gameId);
  const wrap = document.createElement('div');
  wrap.id = 'chat-sheet-wrap';
  const g = found?.game;
  const score = g && g.homeScore != null ? `${g.awayScore}–${g.homeScore}` : '';
  const firstUse = !lsGet('cfbp_chat_sheet_hint');
  const selfForHeader = me();
  const myHeaderPick = (selfForHeader && found) ? getPicks(found.week.weekId, selfForHeader).find(p => p.gameId === gameId) : null;
  const headerCls = gameThreadHeaderClass(myHeaderPick, g);
  wrap.innerHTML = `
    <div class="chat-sheet-backdrop"></div>
    <div class="chat-sheet">
      <div class="chat-sheet-header${headerCls}">
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
    lsSet('cfbp_chat_sheet_hint', '1');
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
  _abbrMemo.clear();                                 // per-pass cache only (see abbrMapFor)
  const host = document.getElementById('chat-sheet-scroll');
  if (!host || !U.sheetGameId) return;
  const self = me();
  // Retention applies here too — otherwise a player could dodge the window by
  // opening a game's bottom sheet instead of the main room (UN-8x).
  const list = coalesceStream(getMessages({ tag: U.sheetGameId, respectRetention: true }));
  host.innerHTML = list.length
    ? list.map(item => item.kind === 'gamereact-run' ? gamereactRunHTML(item) : messageHTML(item, self, false)).join('')
    : '<div class="chat-empty">No entries for this game yet.</div>';
  host.scrollTop = host.scrollHeight;
  host.querySelectorAll('[data-react]').forEach(b => b.addEventListener('click', () => {
    if (!self) return; toggleReact(b.dataset.target, b.dataset.react, self); renderSheetMessages();
  }));
  host.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', () => { retryFailed(b.dataset.retry); renderSheetMessages(); }));
}

// ── Dashboard teaser: dismissible + ambient, no quick-reply (items D+E) ──────
/**
 * Device-local dismissal (AD-12, widened v0.17.2 — a per-screen UI hint whose
 * loss costs nothing but a repeat, and whose sync would write-amplify the
 * Sheet for no shared benefit). Stores the SEQ at dismissal time, not a
 * boolean, so "genuinely new activity since dismissal" is a plain number
 * comparison — the teaser reappears once a message with a HIGHER seq than
 * this exists, and stays gone otherwise, including across reloads.
 */
const TEASER_DISMISS_KEY = 'cfbp_chat_teaser_dismiss_seq';
function teaserDismissedSeq() {
  const n = Number(lsGet(TEASER_DISMISS_KEY));
  return Number.isFinite(n) ? n : -1;   // -1 = never dismissed
}
function setTeaserDismissedSeq(seq) {
  lsSet(TEASER_DISMISS_KEY, String(Number(seq) || 0));
}

/**
 * Item D+E — read-only ambient indicator, no quick-reply input (E), and
 * dismissible (D). Tapping the card body opens chat (data-open-chat);
 * tapping the ✕ dismisses it — two DIFFERENT gestures, not the whole card
 * doing double duty as both, which would be ambiguous about what a tap does.
 *
 * States:
 *  - chat disabled (item A): not rendered.
 *  - zero messages ever (no notifying message exists): not rendered — no
 *    empty card taking up dashboard space.
 *  - dismissed, no new activity since (latest notifying seq <= dismissed
 *    seq): not rendered.
 *  - new activity since dismissal: rendered.
 */
export function dashboardChatTeaserHTML() {
  if (!isChatEnabled()) return '';
  const self = me();
  const latest = latestNotifying(self);
  if (!latest) return '';                                    // zero messages ever
  const latestSeq = typeof latest.seq === 'number' ? latest.seq : 0;
  if (latestSeq <= teaserDismissedSeq()) return '';           // dismissed, nothing new since
  const n = self ? unreadCount(self, 'all') : 0;
  const preview = `<strong>${esc(nameOf(latest.author))}</strong>: ${esc(latest.body.slice(0, 64))}`;
  return `
  <div class="card mb-md dash-chat-teaser" id="dash-chat-teaser" data-teaser-seq="${latestSeq}">
    <div class="dash-chat-left" data-open-chat>
      <span class="dash-chat-icon">💬</span>
      <div class="dash-chat-body">
        <div class="dash-chat-title">Chat ${n ? `<span class="chat-unread-dot">${n > 99 ? '99+' : n}</span>` : ''}</div>
        <div class="dash-chat-preview">${preview}</div>
      </div>
    </div>
    <button type="button" class="dash-chat-dismiss" id="dash-chat-dismiss" title="Dismiss" aria-label="Dismiss chat preview">✕</button>
  </div>`;
}

function bindDashboardTeaser() {
  document.getElementById('dash-chat-dismiss')?.addEventListener('click', e => {
    e.stopPropagation();
    const card = document.getElementById('dash-chat-teaser');
    setTeaserDismissedSeq(card?.dataset.teaserSeq);
    card?.remove();
  });
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
  // Shorthand for the reveal grid comes from the shared table, built over THIS
  // slate so the dedup pass guarantees no two teams in the grid collapse to the
  // same cell. This event is written once under a deterministic id into an
  // append-only log — whatever text it carries is permanent, so an ambiguous
  // abbreviation here could never be corrected. The retired
  // `selectedTeam.split(' ').pop()` heuristic rendered both "Arkansas State"
  // and "Ohio State" as "State", making the row unreadable.
  const revealAbbr = buildAbbrMap(games);
  const lines = players.map(p => {
    const picks = getPicks(week.weekId, p.playerId);
    if (!picks.length) return `${nameOf(p.playerId)} — no picks on file`;
    const parts = games.map(g => {
      const pk = picks.find(x => x.gameId === g.gameId);
      return pk ? (revealAbbr.get(pk.selectedTeam) || pk.selectedTeam) : '—';
    });
    return `${nameOf(p.playerId)}: ${parts.join(' · ')}`;
  });
  sendEvent({
    id: `sys_reveal_${week.weekId}`, type: 'system', author: 'system', notify: true,
    body: lines.join('\n'),
    meta: { kind: 'reveal', weekId: week.weekId, title: `${formatWeekLabel(week)} — the picks are in` },
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
    if (lsGet(key) === today) return;
    const target = Date.now() - 365 * 86400000;
    const hit = getMessages({ tag: 'all', types: ['message'] })
      .filter(m => !m.deleted && m.author !== 'system' && Math.abs((m.ts || 0) - target) < 12 * 3600000)
      .sort((a, b) => Object.values(b.reactions || {}).flat().length - Object.values(a.reactions || {}).flat().length)[0];
    lsSet(key, today);
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
      // Live-sync the teaser while the dashboard is on screen: update it if
      // present, insert it if new activity just made it eligible again (e.g.
      // a message arrived with a higher seq than the dismissed one), and
      // remove it if it's no longer eligible (item D — "reappears only for
      // genuinely new activity").
      if (dashboardPageActive()) {
        const teaser = document.getElementById('dash-chat-teaser');
        const freshHTML = dashboardChatTeaserHTML();
        if (teaser) {
          if (freshHTML) { teaser.outerHTML = freshHTML; bindDashboardTeaser(); }
          else teaser.remove();
        } else if (freshHTML) {
          const host = document.getElementById('page-dashboard');
          host?.insertAdjacentHTML('afterbegin', freshHTML);
          bindDashboardTeaser();
        }
      }
    }
    if (kind === 'offline' || kind === 'online') {
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

  // Rebind the teaser's dismiss control whenever the dashboard re-renders it
  // (renderDashboard() replaces #page-dashboard's innerHTML wholesale, which
  // wipes any listeners bound to the previous instance of the card).
  const rebind = new MutationObserver(() => {
    const dismissBtn = document.getElementById('dash-chat-dismiss');
    if (dismissBtn && !dismissBtn._bound) {
      dismissBtn._bound = true;
      bindDashboardTeaser();
    }
  });
  try { rebind.observe(document.body, { childList: true, subtree: true }); } catch {}

  maybeAnniversary();
  updateChatBadges();
}
