/**
 * CFB Pickems — Chat UI (v0.16.0, Part B)
 * ========================================
 * Renders every chat surface from the chat.js core:
 *   A. Full chat page (#page-chat): channel pills → All / General / Week N / game threads
 *   B. Composer: 1000-char cap, @mentions, quick emoji, reply quoting
 *   C. Game-card comment sheet (bottom sheet, scoped to game:<id>)
 *   D. Nav unread badge + dashboard teaser card
 *   E. System-event emitters (with the pre-lock no-leak HARD RULE)
 *
 * All state lives in chat.js; this module only renders + forwards intents.
 */

import {
  initChat, onChat, chatStatus, getChannelMessages, getActiveChannels, getMessage,
  sendEvent, retryFailed, outboxStateOf, unreadCount, markSeen, setPollMode,
  backfill, newId, chatDigest, poll,
} from './chat.js';
import { scribeInspectMessage, scribeTrigger } from './scribeLines.js';
import {
  getSession, getPlayers, getPlayer, getCurrentWeek, getGames, getWeeklyResults,
  getPicks, getWeeks,
} from './storage.js';
import { formatSpread, formatWeekLabel } from './data-model.js';
import { calculateSeasonStandings } from './scoring.js';

const QUICK_EMOJI = ['💀', '😂', '🔥', '🍺', '🤡', '👀'];
const EDIT_WINDOW_MS = 5 * 60 * 1000;

let _uiState = {
  channel: 'all',          // active channel in the full chat page
  replyTo: null,           // message id being replied to
  sheetGameId: null,       // open game bottom-sheet
  markTimer: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function me() { const s = getSession(); return (s?.playerId && s?.playerVerified) ? s.playerId : null; }
function nameOf(id) {
  if (id === 'scribe') return 'S.C.R.I.B.E.';
  if (id === 'system') return 'System';
  return getPlayer(id)?.displayName || id;
}
function initialsOf(id) {
  if (id === 'scribe') return '📋';
  if (id === 'system') return '⚙';
  return getPlayer(id)?.initials || (nameOf(id).slice(0, 2).toUpperCase());
}
function relTime(ts) {
  if (!ts) return 'sending…';
  const d = Date.now() - ts;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Channel helpers ───────────────────────────────────────────────────────────

function channelLabel(channel) {
  if (channel === 'general') return 'General';
  if (channel === 'all') return 'All';
  if (channel.startsWith('week:')) {
    const wk = getWeeks().find(w => w.weekId === channel.slice(5));
    return wk ? formatWeekLabel(wk) : channel.slice(5);
  }
  if (channel.startsWith('game:')) {
    const g = getGames().find(x => x.gameId === channel.slice(5));
    if (!g) return 'Game';
    return `${g.awayTeam} @ ${g.homeTeam}`;
  }
  return channel;
}

function gameChipHTML(channel) {
  if (!channel?.startsWith('game:')) return '';
  const g = getGames().find(x => x.gameId === channel.slice(5));
  if (!g) return '';
  const spread = formatSpread(g.lockedSpread ?? g.spread, g.favorite, g);
  return `<button class="chat-game-chip" data-chan="${esc(channel)}">🏈 ${esc(g.awayTeam)} @ ${esc(g.homeTeam)}${spread ? ' · ' + esc(spread) : ''}</button>`;
}

// ── Message rendering ─────────────────────────────────────────────────────────

function renderMessageHTML(m, { showChip = false } = {}) {
  const my = me();
  const mine = m.author === my;
  const outbox = outboxStateOf(m.id);   // 'pending' | 'failed' | null
  const kind = m.author === 'scribe' ? 'scribe' : (m.type === 'system' || m.author === 'system') ? 'system' : (mine ? 'mine' : 'theirs');

  if (kind === 'system') {
    return `<div class="chat-msg chat-system" data-id="${esc(m.id)}">
      <span class="chat-system-body">${esc(m.body)}</span>
      <span class="chat-time">${relTime(m.ts)}</span>
    </div>`;
  }

  const body = m.deleted
    ? '<em class="chat-tombstone">message withdrawn</em>'
    : esc(m.body).replace(/@(\w[\w.'-]*)/g, '<span class="chat-mention">@$1</span>');

  const replyQuote = m.replyTo ? (() => {
    const parent = getMessage(m.replyTo);
    if (!parent) return '';
    return `<button class="chat-reply-quote" data-target="${esc(parent.id)}">↩ ${esc(nameOf(parent.author))}: ${esc((parent.deleted ? 'message withdrawn' : parent.body).slice(0, 80))}</button>`;
  })() : '';

  const reactions = Object.entries(m.reactions).map(([emoji, who]) =>
    `<button class="chat-react-pill ${who.includes(my) ? 'me' : ''}" data-id="${esc(m.id)}" data-emoji="${esc(emoji)}" title="${esc(who.map(nameOf).join(', '))}">${emoji} ${who.length}</button>`).join('');

  const canEdit = mine && !m.deleted && m.ts && (Date.now() - m.ts) < EDIT_WINDOW_MS;
  const actions = m.deleted ? '' : `
    <div class="chat-actions">
      ${QUICK_EMOJI.slice(0, 3).map(e => `<button class="chat-act" data-act="react" data-id="${esc(m.id)}" data-emoji="${e}">${e}</button>`).join('')}
      <button class="chat-act" data-act="reply" data-id="${esc(m.id)}">↩</button>
      ${canEdit ? `<button class="chat-act" data-act="edit" data-id="${esc(m.id)}">✏️</button>` : ''}
      ${mine ? `<button class="chat-act" data-act="delete" data-id="${esc(m.id)}">🗑</button>` : ''}
    </div>`;

  const status = outbox === 'failed'
    ? `<span class="chat-failed">FAILED <button class="chat-retry" data-id="${esc(m.id)}">retry</button></span>`
    : (outbox === 'pending' ? '<span class="chat-pending">🕓</span>' : '');

  return `
    <div class="chat-msg chat-${kind} ${outbox === 'pending' ? 'is-pending' : ''} ${outbox === 'failed' ? 'is-failed' : ''}" data-id="${esc(m.id)}">
      <div class="chat-avatar chat-avatar-${kind}">${esc(initialsOf(m.author))}</div>
      <div class="chat-bubble-col">
        <div class="chat-meta"><span class="chat-author">${esc(nameOf(m.author))}</span>
          ${showChip ? gameChipHTML(m.channel) : ''}
          <span class="chat-time">${relTime(m.ts)}</span>${m.edited ? '<span class="chat-edited">edited</span>' : ''}${status}</div>
        ${replyQuote}
        <div class="chat-bubble">${body}</div>
        <div class="chat-reactions">${reactions}</div>
        ${actions}
      </div>
    </div>`;
}

function renderMessageListHTML(channel) {
  const msgs = getChannelMessages(channel);
  if (!msgs.length) {
    return `<div class="chat-empty">📋 Nothing on the chart yet.<br><span class="text-muted text-xs">Say something. SCRIBE is listening.</span></div>`;
  }
  const my = me();
  const seen = my ? (unreadCount(my, channel === 'all' ? null : channel) > 0) : false;
  let lastDay = '';
  let html = '';
  msgs.forEach(m => {
    const day = m.ts ? new Date(m.ts).toDateString() : '';
    if (day && day !== lastDay) {
      lastDay = day;
      html += `<div class="chat-day-sep">${new Date(m.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>`;
    }
    html += renderMessageHTML(m, { showChip: channel === 'all' && m.channel !== 'general' });
  });
  return html;
}

// ── Full chat page ────────────────────────────────────────────────────────────

export function renderChatPage() {
  const c = document.getElementById('page-chat'); if (!c) return;
  const my = me();
  const week = getCurrentWeek();
  const chan = _uiState.channel;

  // Channel pills: All · General · Week N · active game threads (most recent first)
  const pills = [
    { id: 'all', label: 'All' },
    { id: 'general', label: 'General' },
  ];
  if (week) pills.push({ id: `week:${week.weekId}`, label: formatWeekLabel(week) });
  getActiveChannels().forEach(({ channel }) => {
    if (channel.startsWith('game:') && !pills.some(p => p.id === channel)) {
      pills.push({ id: channel, label: channelLabel(channel) });
    }
  });

  const pillHTML = pills.map(p => {
    const n = my ? unreadCount(my, p.id === 'all' ? null : p.id) : 0;
    return `<button class="chat-pill ${chan === p.id ? 'active' : ''}" data-chan="${esc(p.id)}">
      ${esc(p.label)}${n ? `<span class="chat-unread-dot">${n > 99 ? '99+' : n}</span>` : ''}</button>`;
  }).join('');

  const status = chatStatus();
  const offlineBanner = status.offline
    ? '<div class="chat-offline-banner">⚠️ CHAT OFFLINE — messages are not syncing. Retrying…</div>' : '';

  const composerTarget = chan === 'all' ? 'general' : chan;
  const composer = my ? `
    <div class="chat-composer">
      ${_uiState.replyTo ? (() => {
        const p = getMessage(_uiState.replyTo);
        return p ? `<div class="chat-replying">↩ Replying to <strong>${esc(nameOf(p.author))}</strong>: ${esc(p.body.slice(0, 60))} <button id="chat-cancel-reply">✕</button></div>` : '';
      })() : ''}
      ${chan === 'all' ? `<div class="chat-target-note">Posting to <strong>${esc(channelLabel(composerTarget))}</strong></div>` : ''}
      <div class="chat-composer-row">
        <textarea id="chat-input" class="chat-input" rows="1" maxlength="1000"
          placeholder="Message ${esc(channelLabel(composerTarget))}… (@scribe to summon the bot)"></textarea>
        <button class="chat-send-btn" id="chat-send-btn">➤</button>
      </div>
      <div class="chat-composer-foot">
        <span class="chat-emoji-row">${QUICK_EMOJI.map(e => `<button class="chat-emoji-insert" data-e="${e}">${e}</button>`).join('')}</span>
        <span class="chat-char-count" id="chat-char-count"></span>
      </div>
    </div>`
    : `<div class="chat-login-note">🔒 Log in on the Picks tab to join the chat. Reading is open to the league.</div>`;

  c.innerHTML = `
    <div class="section-header"><h2>💬 League Chat</h2>
      <div class="subtitle">One thread. Every game. SCRIBE is in the room.</div></div>
    ${offlineBanner}
    <div class="chat-pills-scroll">${pillHTML}</div>
    <div class="chat-scroll" id="chat-scroll">
      <button class="chat-load-older" id="chat-load-older">↑ Load older</button>
      ${renderMessageListHTML(chan)}
    </div>
    ${composer}`;

  bindChatPage(composerTarget);
  const scroll = document.getElementById('chat-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  // Mark-as-read after the channel is visibly open for 1s
  if (_uiState.markTimer) clearTimeout(_uiState.markTimer);
  if (my) _uiState.markTimer = setTimeout(() => { markSeen(my, chan); updateChatBadges(); }, 1000);
}

function bindChatPage(composerTarget) {
  const c = document.getElementById('page-chat');
  c.querySelectorAll('.chat-pill').forEach(b => b.addEventListener('click', () => {
    _uiState.channel = b.dataset.chan; _uiState.replyTo = null; renderChatPage();
  }));
  document.getElementById('chat-load-older')?.addEventListener('click', async (e) => {
    e.target.textContent = 'Loading…';
    await backfill(100);
    renderChatPage();
  });
  bindMessageActions(c, () => renderChatPage());
  bindComposer(c, composerTarget, () => renderChatPage());
}

function bindComposer(root, channel, rerender) {
  const input = root.querySelector('#chat-input');
  const send = root.querySelector('#chat-send-btn');
  const count = root.querySelector('#chat-char-count');
  if (!input) return;

  input.addEventListener('input', () => {
    const len = input.value.length;
    if (count) count.textContent = len >= 900 ? `${len}/1000` : '';
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  const isDesktop = window.matchMedia('(min-width: 700px)').matches;
  input.addEventListener('keydown', e => {
    if (isDesktop && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  root.querySelectorAll('.chat-emoji-insert').forEach(b => b.addEventListener('click', () => {
    input.value += b.dataset.e; input.focus(); input.dispatchEvent(new Event('input'));
  }));
  root.querySelector('#chat-cancel-reply')?.addEventListener('click', () => { _uiState.replyTo = null; rerender(); });
  send?.addEventListener('click', doSend);

  function doSend() {
    const my = me(); if (!my) return;
    const body = input.value.trim();
    if (!body) return;
    sendEvent({ type: 'message', channel, body, author: my, replyTo: _uiState.replyTo || '' });
    _uiState.replyTo = null;
    input.value = ''; input.dispatchEvent(new Event('input'));
    // Deterministic-persona hooks (rate-limited inside)
    try {
      scribeInspectMessage({
        author: my, authorName: nameOf(my), body, channel,
        standings: currentStandingsContext(),
      });
    } catch {}
    rerender();
  }
}

function bindMessageActions(root, rerender) {
  const my = me();
  root.querySelectorAll('.chat-act').forEach(b => b.addEventListener('click', () => {
    const { act, id, emoji } = b.dataset;
    if (!my) return;
    const m = getMessage(id); if (!m) return;
    if (act === 'react') {
      const has = (m.reactions[emoji] || []).includes(my);
      sendEvent({ type: has ? 'unreact' : 'react', channel: m.channel, targetId: id, author: my, meta: { emoji } });
      rerender();
    } else if (act === 'reply') {
      _uiState.replyTo = id; rerender();
      setTimeout(() => root.querySelector('#chat-input')?.focus(), 50);
    } else if (act === 'edit') {
      const next = prompt('Edit message:', m.body);
      if (next !== null && next.trim() && next !== m.body) {
        sendEvent({ type: 'edit', channel: m.channel, targetId: id, body: next.trim(), author: my });
        rerender();
      }
    } else if (act === 'delete') {
      if (confirm('Withdraw this message? A tombstone will remain.')) {
        sendEvent({ type: 'delete', channel: m.channel, targetId: id, author: my });
        rerender();
      }
    }
  }));
  root.querySelectorAll('.chat-react-pill').forEach(b => b.addEventListener('click', () => {
    if (!my) return;
    const m = getMessage(b.dataset.id); if (!m) return;
    const has = (m.reactions[b.dataset.emoji] || []).includes(my);
    sendEvent({ type: has ? 'unreact' : 'react', channel: m.channel, targetId: b.dataset.id, author: my, meta: { emoji: b.dataset.emoji } });
    rerender();
  }));
  root.querySelectorAll('.chat-retry').forEach(b => b.addEventListener('click', () => { retryFailed(b.dataset.id); rerender(); }));
  root.querySelectorAll('.chat-game-chip').forEach(b => b.addEventListener('click', () => {
    _uiState.channel = b.dataset.chan; renderChatPage();
  }));
  root.querySelectorAll('.chat-reply-quote').forEach(b => b.addEventListener('click', () => {
    const el = root.querySelector(`.chat-msg[data-id="${b.dataset.target}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('chat-flash'); setTimeout(() => el?.classList.remove('chat-flash'), 1200);
  }));
}

function currentStandingsContext() {
  try {
    const players = getPlayers().filter(p => p.active !== false);
    const standings = calculateSeasonStandings(players, getWeeklyResults());
    if (!standings?.length) return null;
    return {
      firstPlaceName: players.find(p => p.playerId === standings[0].playerId)?.displayName || null,
      lastPlaceId: standings[standings.length - 1].playerId,
    };
  } catch { return null; }
}

// ── Game-card bottom sheet ────────────────────────────────────────────────────

export function openGameChatSheet(weekId, gameId) {
  const g = getGames().find(x => x.gameId === gameId);
  const channel = `game:${gameId}`;
  closeGameChatSheet();
  const wrap = document.createElement('div');
  wrap.id = 'chat-sheet-wrap';
  wrap.innerHTML = `
    <div class="chat-sheet-backdrop" id="chat-sheet-backdrop"></div>
    <div class="chat-sheet">
      <div class="chat-sheet-header">
        <div>
          <div class="chat-sheet-title">${g ? `${esc(g.awayTeam)} @ ${esc(g.homeTeam)}` : 'Game thread'}</div>
          <div class="chat-sheet-sub">${g ? esc(formatSpread(g.lockedSpread ?? g.spread, g.favorite, g) || '') : ''} ${g?.status ? '· ' + esc(g.status.toUpperCase()) : ''}</div>
        </div>
        <div class="chat-sheet-header-actions">
          <button class="btn btn-ghost btn-sm" id="chat-sheet-open-full">Open in chat</button>
          <button class="chat-sheet-close" id="chat-sheet-close">✕</button>
        </div>
      </div>
      <div class="chat-scroll chat-sheet-scroll" id="chat-sheet-scroll">${renderMessageListHTML(channel)}</div>
      <div id="chat-sheet-composer"></div>
    </div>`;
  document.body.appendChild(wrap);
  _uiState.sheetGameId = gameId;

  const rerender = () => {
    const sc = document.getElementById('chat-sheet-scroll');
    if (sc) { sc.innerHTML = renderMessageListHTML(channel); bindMessageActions(sc, rerender); sc.scrollTop = sc.scrollHeight; }
  };
  renderSheetComposer(channel, rerender);
  bindMessageActions(wrap, rerender);
  document.getElementById('chat-sheet-close')?.addEventListener('click', closeGameChatSheet);
  document.getElementById('chat-sheet-backdrop')?.addEventListener('click', closeGameChatSheet);
  document.getElementById('chat-sheet-open-full')?.addEventListener('click', () => {
    closeGameChatSheet();
    _uiState.channel = channel;
    window.navigateTo?.('chat');
  });
  const sc = document.getElementById('chat-sheet-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
  const my = me();
  if (my) setTimeout(() => { markSeen(my, channel); updateChatBadges(); }, 1000);
  setPollMode('active');
}

function renderSheetComposer(channel, rerender) {
  const host = document.getElementById('chat-sheet-composer'); if (!host) return;
  const my = me();
  host.innerHTML = my ? `
    <div class="chat-composer chat-composer-sheet">
      <div class="chat-composer-row">
        <textarea id="chat-input" class="chat-input" rows="1" maxlength="1000" placeholder="Talk your talk…"></textarea>
        <button class="chat-send-btn" id="chat-send-btn">➤</button>
      </div>
      <div class="chat-composer-foot">
        <span class="chat-emoji-row">${QUICK_EMOJI.map(e => `<button class="chat-emoji-insert" data-e="${e}">${e}</button>`).join('')}</span>
        <span class="chat-char-count" id="chat-char-count"></span>
      </div>
    </div>` : '<div class="chat-login-note">🔒 Log in on the Picks tab to post.</div>';
  bindComposer(host, channel, rerender);
}

export function closeGameChatSheet() {
  document.getElementById('chat-sheet-wrap')?.remove();
  _uiState.sheetGameId = null;
  setPollMode('passive');
}

/** Comment-bubble HTML for a game card (count = non-deleted messages in thread). */
export function gameChatBubbleHTML(gameId) {
  const n = getChannelMessages(`game:${gameId}`).filter(m => !m.deleted && m.type === 'message').length;
  const my = me();
  const unread = my ? unreadCount(my, `game:${gameId}`) : 0;
  return `<button class="chat-bubble-btn ${unread ? 'has-unread' : ''}" data-chat-game="${esc(gameId)}" title="Game thread">
    💬${n ? `<span class="chat-bubble-count">${n}</span>` : ''}</button>`;
}

// ── Nav badge + dashboard teaser ──────────────────────────────────────────────

export function updateChatBadges() {
  const my = me();
  const total = my ? unreadCount(my) : 0;
  const nav = document.querySelector('.nav-item[data-tab="chat"]');
  if (nav) {
    let dot = nav.querySelector('.nav-unread');
    if (total > 0) {
      if (!dot) { dot = document.createElement('span'); dot.className = 'nav-unread'; nav.appendChild(dot); }
      dot.textContent = total > 99 ? '99+' : String(total);
    } else dot?.remove();
  }
  const teaser = document.getElementById('dash-chat-teaser');
  if (teaser) teaser.outerHTML = dashboardChatTeaserHTML();
}

export function dashboardChatTeaserHTML() {
  const my = me();
  const total = my ? unreadCount(my) : 0;
  const latest = getChannelMessages('all').filter(m => !m.deleted && m.type === 'message').slice(-1)[0];
  const preview = latest ? `<strong>${esc(nameOf(latest.author))}:</strong> ${esc(latest.body.slice(0, 70))}` : 'No messages yet — start the season chirping.';
  return `
    <div class="card mb-md dash-chat-teaser" id="dash-chat-teaser">
      <div class="dash-chat-left">
        <span class="dash-chat-icon">💬</span>
        <div><div class="dash-chat-title">League Chat ${total ? `<span class="chat-unread-dot">${total}</span>` : ''}</div>
        <div class="dash-chat-preview">${preview}</div></div>
      </div>
      <button class="btn btn-primary btn-sm" data-open-chat>Open</button>
    </div>`;
}

// ── System events (deterministic ids ⇒ exactly-once across 6 clients) ─────────
// HARD RULE — NO PRE-LOCK PICK LEAKAGE: lock announcements are COUNT ONLY.
// Nothing here may reveal a selection before that game's lock time.

export function emitPicksLockedEvent(weekId, playerId, count, total) {
  sendEvent({
    type: 'system', channel: 'general', author: 'system',
    id: `sys_lock_${weekId}_${playerId}`,
    body: `${nameOf(playerId)} locked ${count}/${total} picks`,   // counts only — never selections
    meta: { kind: 'picksLocked' },
  });
}

export function emitGameFinalEvent(game, atsWinner, winners, losers) {
  if (!game || !atsWinner) return;
  const w = winners.map(nameOf).join(', ') || 'nobody';
  const l = losers.map(nameOf).join(', ') || 'nobody';
  const body = atsWinner === 'no_decision'
    ? `FINAL: ${game.awayTeam} @ ${game.homeTeam} — pushed. No decision.`
    : `FINAL: ${game.awayTeam} @ ${game.homeTeam} — ${atsWinner} covers. ✅ ${w} · ❌ ${l}`;
  sendEvent({
    type: 'system', channel: `game:${game.gameId}`, author: 'system',
    id: `sys_final_${game.gameId}`, body, meta: { kind: 'gameFinal' },
  });
}

export function emitExtraPointEvent(weekId, graded) {
  if (!graded) return;
  const winners = graded.rows.filter(r => ['blackjack', 'win', 'push-win'].includes(r.outcome));
  const busts = graded.rows.filter(r => r.outcome === 'bust');
  const body = graded.allBusted
    ? `Extra Point (longest FG ${graded.actual} yd): the entire table busted.`
    : `Extra Point (longest FG ${graded.actual} yd): ${winners.map(w => w.displayName).join(' & ')} ${winners[0]?.outcome === 'blackjack' ? 'hit BLACKJACK' : 'win'}${busts.length ? ` · busted: ${busts.map(b => b.displayName).join(', ')}` : ''}`;
  sendEvent({
    type: 'system', channel: 'general', author: 'system',
    id: `sys_ep_${weekId}`, body, meta: { kind: 'extraPoint' },
  });
  // SCRIBE follows with commentary (rate-limited internally)
  if (busts.length) scribeTrigger('extraPointBust', { channel: 'general', subject: weekId, vars: { name: busts[0].displayName } });
  else if (winners.length) scribeTrigger('extraPointWin', { channel: 'general', subject: weekId, vars: { name: winners[0].displayName } });
}

export function emitWeekFinalEvent(week, resultsRanked) {
  if (!week || !resultsRanked?.length) return;
  const top = resultsRanked[0];
  sendEvent({
    type: 'system', channel: `week:${week.weekId}`, author: 'system',
    id: `sys_weekfinal_${week.weekId}`,
    body: `${formatWeekLabel(week)} is FINAL. Week winner: ${nameOf(top.playerId)}.`,
    meta: { kind: 'weekFinal' },
  });
}

// ── Boot glue ─────────────────────────────────────────────────────────────────

export function initChatUI() {
  initChat();
  onChat((kind) => {
    // Live-update whichever chat surface is on screen.
    if (kind === 'events' || kind === 'sent' || kind === 'online' || kind === 'offline') {
      if (document.getElementById('page-chat')?.classList.contains('active')) renderChatPage();
      if (_uiState.sheetGameId) {
        const sc = document.getElementById('chat-sheet-scroll');
        if (sc) {
          const channel = `game:${_uiState.sheetGameId}`;
          const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
          sc.innerHTML = renderMessageListHTML(channel);
          bindMessageActions(sc, () => {});
          if (atBottom) sc.scrollTop = sc.scrollHeight;
        }
      }
      updateChatBadges();
    }
  });
  // Delegated: dashboard teaser + game-card bubbles work wherever they render.
  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest?.('[data-open-chat]');
    if (openBtn) { _uiState.channel = 'all'; window.navigateTo?.('chat'); return; }
    const bubble = e.target.closest?.('[data-chat-game]');
    if (bubble) {
      const week = getCurrentWeek();
      openGameChatSheet(week?.weekId, bubble.dataset.chatGame);
    }
  });
}

export function chatChannelForNav() { return _uiState.channel; }
export function setChatChannel(ch) { _uiState.channel = ch; }

// Digest passthrough for the admin panel.
export { chatDigest };
