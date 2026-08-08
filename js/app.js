/**
 * CFB Pickems — App Controller v15
 *
 * One-stop place to update the user-visible version string + release date.
 * Surfaced in the footer of the Rules tab (Priority 12).
 */
export const APP_VERSION = 'v0.17.4';
export const APP_VERSION_DATE = '2026-08-08';


import {
  WEEK_STATUS, GAME_STATUS, PICK_RESULT, TIME_WINDOW, TIME_ZONES, DEFAULT_TZ,
  ALMA_MATERS, DEFAULT_RULES, DATA_QUALITY, DATA_SOURCE_MODE,
  createPlayer, createGame, createPick, createWeek, formatWeekLabel,
  formatGameTime, formatVenueDisplay, formatSpread, getPlayerInitials,
  sourceModeLabelOf, ALMA_MATER_DISPLAY, getAlmaMaterMatch,
  formatTeamName, getTeamDisplay, gameDataReadiness,
  buildAbbrMap, REACTION_PALETTE,
  THEMES,
  HISTORICAL_DEMO_WEEK, HISTORICAL_DEMO_GAMES, REAL_WEEK_1_2026,
  SITE_PIN,
  getAutoLockOffsetMinutes, getAutoLiveEnabled, getAutoFinalizeEnabled,
  obligationRole, obligationNextStatus, obligationStatusDisplay,
} from './data-model.js';

import {
  initStorage, resetToDemo, ensureSeedData,
  getBackendMode, setBackendMode,
  getSettings, saveSetting,
  getSession, setSession, clearSession,
  getPlayers, getPlayer, savePlayer, addPlayer,
  verifyPlayerPin, setPlayerPin, getPlayerPin,
  getCurrentWeek, getWeek, getWeeks, saveWeek, deleteWeek,
  getActiveWeekId, setActiveWeekId, getEffectiveWeekStatus,
  getGames, getGame, saveGame, deleteGame, saveAllGamesForWeek, clearSlateForWeek,
  getAvailableGames, saveAvailableGames, clearAvailableGames,
  getPicks, getPick, saveAllPicks, hasPlayerSubmitted,
  getWeeklyResults, saveAllWeeklyResults,
  getObligations, saveObligation, saveAllObligations, createObligation,
  getNickname, setNickname, getDisplayNamePlain,
  getGameLockOverrides, setGameLockOverride, clearAllLockOverrides,
  getTiebreakerGuess, setTiebreakerGuess, getTiebreakerGuesses,
  getExtraPointGuess, setExtraPointGuess, getExtraPointGuesses,
  getRejectedSuggestions, rejectSuggestion, unrejectSuggestion,
  clearRejectedSuggestions, isSuggestionRejected, suggestionKeyOf,
  getReactionsForGame, toggleReaction,
  getComments, getGameComments, addComment, deleteComment, addBotPostIfNew,
  getFeedback, appendFeedback,
  countPicksForGame, deletePicksForGame,
  saveFetchProof, getFetchProof,
  getTimezone, setTimezone,
  getTheme, setTheme,
  isSiteUnlocked, setSiteUnlocked, verifySitePin,
  getEffectiveSitePin, setSitePin,
  resetCurrentWeekData,
  exportAllData, exportAllDataRaw,
} from './storage.js';

import {
  buildEspnUrl,
  fetchByDateRange, fetchCurrentCFBGames,
  refreshScoresByEventIds, scoreCandidateGames,
  getProviderState, getLastFetchUrl,
  getTimeWindow,
} from './data-provider.js';

import {
  calculateWeeklyResults, calculateSeasonStandings,
  evaluatePick, getPickStatusLabel, getPickStatusClass,
  calculateAtsWinner, calculateAlmaMaterTotal,
  computeEffectiveLockAt, computeEffectiveLiveAt, computeFirstKickoff, computeLastKickoff,
} from './scoring.js';

import {
  getBackendConfig, setBackendConfig, clearBackendConfig,
  isBackendConfigured, isBackendReady, pingBackend,
  hydrate as hydrateBackend, seedFromLocal, flushPush,
  refreshFromBackend, createSnapshot, listSnapshots, restoreSnapshot,
  onBackendStatus, getSyncStatus, loadDeployedConfig,
  primeFromMirror, isMirrorStale, clearMirror,
} from './backend.js';

// ── v0.16.0 modules ──────────────────────────────────────────────────────────
import {
  initChatUI, renderChatPage, gameChatBubbleHTML, dashboardChatTeaserHTML,
  updateChatBadges, openGameChatSheet, setChatChannel,
  emitPicksLockedEvent, emitGameFinalEvent, emitExtraPointEvent, emitWeekFinalEvent,
  emitPickRevealEvent, emitKickoffEvent, scribeLiveGameCheck,
  resumeChatAfterLogin,
  chatDigest,
  setChatSyncStatus,
} from './chat-ui.js';
import { setPollMode, sendEvent as sendChatEvent, sendGameReact, getRetentionDays, retentionStats, isChatEnabled, refreshChatEnabled } from './chat.js';
import { SEASON_2025, season2025Obligations, season2025Nets, ob2025Status } from './history-2025.js';
import { fetchMetrics as fetchChatMetrics } from './chatTransport.js';
import { renderPicksFooterHTML, renderWeekRecapCardHTML } from './recap.js';
import {
  detectLongestFieldGoal, gradeWeekExtraPoint, gradeExtraPoint,
  renderExtraPointResultsHTML, EP_OUTCOME_LABEL,
} from './extra-point.js';

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  currentTab: 'picks',
  draftPicks: {}, draftTiebreaker: null,
  editingPicks: false, // true while a logged-in player is updating their already-submitted picks
  dashboardWeekId: null,
  picksWeekId: null,      // v0.16.0 — non-null when viewing a previous locked/closed week on the Picks tab
  draftExtraPoint: null,  // v0.16.0 — Ischemic Extra Point guess (longest FG, yards)
  // Active tab within the Commissioner panel (week / games / players / settings / data)
  commTab: 'week',
  lastFetchResult: null,
  // Available-games filter (commissioner panel). Persists within a session.
  availFilter: {
    groupBy: 'date',      // 'date' | 'day' | 'conference' | 'region' | 'rank' | 'none'
    conference: '',       // exact conference name filter, '' = any
    rank: 'any',          // 'any' | 'ranked' | 'unranked'
    almaOnly: false,      // only games involving an alma mater
    search: '',           // free-text team/school search
  },
};

// ─── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => { boot(); });

async function boot() {
  // ── v0.16.0 FAST BOOT ──────────────────────────────────────────────────────
  // Root cause of the old ~20s blank: boot awaited a full Google Apps Script
  // getAll (10–20s cold start) BEFORE anything rendered — even the PIN gate —
  // and the gate then window.location.reload()ed into a SECOND boot + hydrate.
  // New model (AD-08 in DEVELOPMENT_LEDGER.md):
  //   1. Prime the in-memory cache SYNCHRONOUSLY from the last successful
  //      snapshot (localStorage mirror) and paint immediately.
  //   2. The PIN gate is an OVERLAY — no body nuke, no reload, no second boot.
  //   3. hydrate() runs in the background: visible "Syncing…" badge while
  //      stale, one-shot re-render when fresh data lands, LOUD red banner on
  //      failure (unchanged), and pushes are HELD while stale so a stale
  //      mirror can never clobber fresher remote data.
  let backendErrorBanner = null;

  onBackendStatus((status, detail) => {
    updateSyncBadge(status);
    if (status === 'error' && detail?.error) showBackendErrorBanner(detail.error);
    if (status === 'synced') hideBackendErrorBanner();
  });

  const primedKeys = primeFromMirror();
  let rendered = false;

  if (primedKeys > 0) {
    setBackendMode('googleSheets');   // serve last-known data instantly
    updateSyncBadge('syncing');
  }

  setupNav(); setupHeaderIdentity(); refreshHeader(); renderTzToggle(); renderThemeToggle(); applyTheme(getTheme()); setupAutoRefresh();
  // Item A — independent of the score auto-refresh interval (which the
  // commissioner can set to "Off"), so the mid-session chat-off watch always
  // runs regardless of that other setting.
  setupChatEnabledWatch();
  if (!getSettings().dashboardLayout && typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 600) {
    saveSetting('dashboardLayout', 'compact');
  }

  if (primedKeys > 0) { navigateTo('dashboard'); rendered = true; }
  // (No mirror yet: leave the built-in section skeletons up until we know
  //  whether this device is cloud-connected — never flash seeded demo data
  //  over a shared league, and never seed INTO an unhydrated backend.)

  if (!isSiteUnlocked()) showSitePinGate();
  revealApp();   // paint happens NOW — hydration overlaps PIN entry

  // ── Background connect + hydrate ──────────────────────────────────────────
  try {
    const deployed = await loadDeployedConfig();   // same-origin fetch, ~fast
    if (deployed.ok) setBackendConfig(deployed.url, deployed.token);

    if (isBackendConfigured()) {
      await hydrateBackend();          // cold start happens here, off-screen
      setBackendMode('googleSheets');
      ensureSeedData();
      refreshHeader();
      navigateTo(rendered ? (state.currentTab || 'dashboard') : 'dashboard');
      rendered = true;
    } else if (deployed.ok === false && deployed.reason === 'malformed') {
      console.error('[backend] config.json malformed:', deployed.error);
      backendErrorBanner = `config.json is invalid (${deployed.error}). Cross-device sync is OFF.`;
      if (!rendered) { setBackendMode('local'); initStorage(); navigateTo('dashboard'); rendered = true; }
    } else {
      // No config anywhere — fork-friendly local-only mode.
      if (!rendered) { setBackendMode('local'); initStorage(); navigateTo('dashboard'); rendered = true; }
    }
  } catch (err) {
    // LOUD failure (unchanged policy): players + commissioner must KNOW their
    // picks aren't syncing. Persistent red banner; app stays usable.
    const msg = String(err.message || err);
    console.error('[backend] hydrate failed:', err);
    backendErrorBanner = msg;
    if (!rendered) { setBackendMode('local'); initStorage(); navigateTo('dashboard'); rendered = true; }
  }
  if (backendErrorBanner) showBackendErrorBanner(backendErrorBanner);

  // Chat engine + badges (v0.16.0)
  try { initChatUI(); updateChatBadges(); } catch (e) { console.warn('[chat] init failed', e); }

  window.addEventListener('beforeunload', () => { try { flushPush(); } catch {} });
}

/**
 * Persistent red banner shown when the shared-data backend isn't reachable.
 * Sticks to the top of the viewport until either the connection recovers
 * (handled by the onBackendStatus 'synced' event in boot) or the user
 * dismisses it. Idempotent — calling it twice with the same message is a
 * no-op (we update the message in place rather than stacking banners).
 */
function showBackendErrorBanner(message) {
  let el = document.getElementById('backend-error-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'backend-error-banner';
    el.className = 'backend-error-banner';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="beb-inner">
      <span class="beb-icon" aria-hidden="true">⚠️</span>
      <div class="beb-text">
        <strong>Cross-device sync is OFF on this device.</strong>
        <div class="beb-detail">${escHtml(String(message))}</div>
        <div class="beb-hint">Picks made on THIS device may NOT reach other players' devices until this is fixed. Tell the commissioner.</div>
      </div>
      <button type="button" class="beb-retry" id="beb-retry-btn">Retry</button>
      <button type="button" class="beb-close" id="beb-close-btn" aria-label="Dismiss">✕</button>
    </div>`;
  el.style.display = 'block';
  document.getElementById('beb-retry-btn')?.addEventListener('click', async () => {
    if (!isBackendConfigured()) {
      showToast('No backend URL configured on this device','error');
      return;
    }
    showToast('⏳ Retrying connection…','warning');
    try {
      await hydrateBackend();
      setBackendMode('googleSheets');
      hideBackendErrorBanner();
      showToast('✅ Connection restored','success');
    } catch (err) {
      showToast(`❌ Still failing: ${err.message||err}`,'error');
      showBackendErrorBanner(String(err.message || err));
    }
  });
  document.getElementById('beb-close-btn')?.addEventListener('click', () => { el.style.display = 'none'; });
}

function hideBackendErrorBanner() {
  const el = document.getElementById('backend-error-banner');
  if (el) el.style.display = 'none';
}

/** Remove the boot-time visibility lock once the first screen has rendered.
 *  Prevents the maroon header from flashing before the PIN gate appears. */
function revealApp() {
  // Defer one tick so the DOM has actually painted the new layout first.
  requestAnimationFrame(() => document.body.classList.remove('cfbp-booting'));
}

// AD-06 (UN-110 consequence): .app-header — and with it #sync-badge — is
// display:none on the chat tab. One function, two targets, so they cannot
// drift (CONVENTIONS #21): every status update writes both. Chat's own badge
// only surfaces text for 'error' (keeps chat chrome minimal in the normal
// case) but the hard loud-fail rule still holds — sync failures are visible
// on chat too, just quieter than the persistent red page banner.
function updateSyncBadge(status) {
  const map = {
    syncing: '☁️ Syncing…',
    synced:  '☁️ Synced',
    error:   '⚠️ Sync error',
  };
  const el = document.getElementById('sync-badge');
  if (el) {
    el.textContent = map[status] || '';
    el.className = 'sync-badge sync-' + status;
  }
  // Track last-known status so a FRESH renderChatPage() — which replaces
  // #page-chat's entire innerHTML, including any live badge node — reflects
  // it immediately rather than waiting for the next onBackendStatus event.
  setChatSyncStatus(status);
  const chatEl = document.getElementById('chat-sync-badge');
  if (chatEl) {
    const isError = status === 'error';
    chatEl.textContent = isError ? map.error : '';
    chatEl.className = 'sync-badge' + (isError ? ' sync-error' : '');
  }
}

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(i => i.addEventListener('click', () => navigateTo(i.dataset.tab)));
}

/** v0.17.0 — THE PICK REVEAL RITUAL. When the current week's effective status
 *  crosses into locked, one system event posts everyone's picks to the room
 *  simultaneously. Local ledger prevents outbox spam; the deterministic id
 *  (sys_reveal_<weekId>) makes it exactly-once across all six clients. */
function checkPickRevealDue() {
  const week = getCurrentWeek(); if (!week || week.dataSourceMode==='demo') return;
  const eff = getEffectiveWeekStatus(week);
  if (!['locked','live','final'].includes(eff) && week.status!=='final') return;
  const key = 'cfbp_reveal_emitted';
  let done = [];
  try { done = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
  if (done.includes(week.weekId)) return;
  emitPickRevealEvent(week);
  done.push(week.weekId);
  try { localStorage.setItem(key, JSON.stringify(done.slice(-20))); } catch {}
}

// ── Item A: commissioner chat on/off toggle — nav + live watch ───────────────
/** Shows/hides the bottom-nav Chat entry. `.nav-item` is `flex:1` in a `flex`
 *  row (css/styles.css), so `display:none` on one item redistributes the
 *  remaining five evenly — no gap, no misalignment (verified against the
 *  actual CSS rule, not assumed). */
function applyChatNavVisibility() {
  const enabled = isChatEnabled();
  document.querySelectorAll('.nav-item[data-tab="chat"]').forEach(el => { el.style.display = enabled ? '' : 'none'; });
}

/** Periodic mid-session watch (item A hazard #1's second half): a player
 *  sitting ON the chat page when the setting flips off must not be stranded.
 *  Runs independently of the score auto-refresh interval (which the
 *  commissioner can set to "Off") so this check keeps working even then. */
function checkChatEnabledLive() {
  applyChatNavVisibility();
  try { refreshChatEnabled(); } catch {}
  if (!isChatEnabled() && state.currentTab === 'chat') {
    showToast('Chat has been turned off by the commissioner.', 'warning');
    navigateTo('dashboard');
  }
}

let _chatEnabledWatchTimer = null;
function setupChatEnabledWatch() {
  if (_chatEnabledWatchTimer) clearInterval(_chatEnabledWatchTimer);
  _chatEnabledWatchTimer = setInterval(() => { try { checkChatEnabledLive(); } catch {} }, 20000);
}

function navigateTo(tab) {
  // Item A — chat OFF must never be reachable via navigation. Redirect BEFORE
  // touching any page/nav state so the chat page is never even briefly the
  // active section. (renderChatPage() carries the SAME guard as defense in
  // depth for callers that reach it some other way.)
  if (tab === 'chat' && !isChatEnabled()) {
    showToast('Chat has been turned off by the commissioner.', 'warning');
    tab = 'dashboard';
  }
  state.currentTab = tab;
  // UN-110: drives body[data-tab="..."] CSS (chat's own header-hidden layout,
  // UN-111's tz/theme visibility). MUST come after the chat-disabled redirect
  // above — otherwise a bounce to dashboard would leave the attribute reading
  // "chat" and the header would stay hidden on the wrong page.
  document.body.dataset.tab = tab;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.page-section').forEach(el => el.classList.toggle('active', el.id === `page-${tab}`));
  applyChatNavVisibility();
  ({ picks: renderPicksPage, dashboard: renderDashboard, leaderboard: renderLeaderboard, commissioner: renderCommPage, rules: renderRulesPage, chat: renderChatPage })[tab]?.();
  // Chat polls fast only while the chat tab is open
  try { setPollMode(tab === 'chat' ? 'active' : 'passive'); updateChatBadges(); } catch {}
  try { refreshChatEnabled(); } catch {}
  try { checkPickRevealDue(); } catch {}
}

function refreshHeader() {
  const week = getCurrentWeek();
  const el   = document.getElementById('header-meta');
  renderHeaderIdentity();
  if (!el) return;
  el.innerHTML = week
    ? `<strong>${escHtml(formatWeekLabel(week))}</strong><span class="badge badge-${week.status} ml-sm">${week.status.toUpperCase()}</span>`
    : '<strong>CFB Pickems</strong>';
}

// ─── HEADER IDENTITY (UN-106) ─────────────────────────────────────────────────
// One element serves both signed-in and signed-out states: an initials avatar
// + first name when logged in, a "Sign In" pill when logged out. Renders
// identically across every week status — it depends only on session/player
// data, never on `week`. Both states tap through to the Picks tab, where
// renderLoginScreen() and the existing logout control already live (no
// duplicated auth logic in the header).
//
// getSession() is a synchronous device-local read (storage.js), so it never
// itself needs "resolving" — but the PLAYER RECORD it points at can be
// unhydrated for a moment on a fresh device (players route through the
// backend mirror, session does not). If session.playerId is set but that
// player can't be found yet, hold the slot EMPTY rather than guessing —
// flashing "Sign In" for a frame before a real login resolves is worse than
// showing nothing (batch 1 hazard). Call sites: refreshHeader() (boot, and
// every subsequent re-render) and resyncPlayerPreferences() (login/logout/
// player-switch) — the same two functions that already keep the rest of the
// header in sync with session state.
export function renderHeaderIdentity() {
  const el = document.getElementById('header-identity');
  if (!el) return;
  const sess = getSession();
  if (!sess?.playerId) {
    el.hidden = false;
    el.setAttribute('aria-label', 'Sign in');
    el.innerHTML = `<span class="header-identity-pill">Sign In</span>`;
    return;
  }
  const player = getPlayer(sess.playerId);
  if (!player) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.setAttribute('aria-label', `Signed in as ${player.displayName}`);
  el.innerHTML = `<span class="header-identity-avatar">${escHtml(getPlayerInitials(player))}</span><span class="header-identity-name">${escHtml(player.displayName)}</span>`;
}

/** One-time click binding — the header identity chip always routes to Picks,
 *  logged in or out (UN-106). Bound once at boot alongside setupNav(). */
function setupHeaderIdentity() {
  document.getElementById('header-identity')?.addEventListener('click', () => navigateTo('picks'));
}

// ─── TIMEZONE TOGGLE ──────────────────────────────────────────────────────────

function renderTzToggle() {
  const container = document.getElementById('tz-toggle');
  if (!container) return;
  const current = getTimezone();
  container.innerHTML = TIME_ZONES.map(tz =>
    `<button class="tz-btn${tz.key === current ? ' active' : ''}" data-tz="${tz.key}">${tz.key}</button>`
  ).join('');
  container.querySelectorAll('.tz-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTimezone(btn.dataset.tz);
      container.querySelectorAll('.tz-btn').forEach(b => b.classList.toggle('active', b === btn));
      // Re-render whichever page is visible
      navigateTo(state.currentTab);
    });
  });
}

function tz() { return getTimezone(); }
function fmtTime(iso, game=null) { return formatGameTime(iso, tz(), game); }

// ─── THEME ────────────────────────────────────────────────────────────────────
// Applies a theme by replacing the `theme-*` class on <body>. Idempotent.
function applyTheme(themeKey) {
  const key = themeKey || getTheme() || 'neutral';
  const body = document.body;
  [...body.classList].forEach(c => { if (c.startsWith('theme-')) body.classList.remove(c); });
  body.classList.add('theme-' + key);
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const c = getComputedStyle(body).getPropertyValue('--maroon').trim();
      if (c) meta.setAttribute('content', c);
    }
  } catch {}
}

/**
 * Re-apply the player's (or device-fallback) theme + timezone + re-render the
 * toggle pills in the header. Call whenever session changes (login/logout/
 * player switch) so a player's chosen color scheme and TZ follow them across
 * devices and don't get clobbered by whoever logged in last.
 */
function resyncPlayerPreferences() {
  applyTheme(getTheme());
  renderTzToggle();
  renderThemeToggle();
  renderHeaderIdentity();
}

function renderThemeToggle() {
  const container = document.getElementById('theme-toggle');
  if (!container) return;
  const current = getTheme();
  // Compact dropdown so 7+ themes don't bloat the header.
  container.innerHTML = `
    <select id="theme-select" class="theme-select" aria-label="Theme">
      ${THEMES.map(t => `<option value="${t.key}"${t.key===current?' selected':''}>${escHtml(t.label)}</option>`).join('')}
    </select>`;
  container.querySelector('#theme-select')?.addEventListener('change', e => {
    const key = e.target.value;
    setTheme(key);
    applyTheme(key);
  });
}

// ─── PICK PERMISSION ──────────────────────────────────────────────────────────

function canPlayerSubmitPicks(week, playerId) {
  if (!week)     return { allowed:false, reason:'No active week.' };
  if (!playerId) return { allowed:false, reason:'Not logged in.' };
  const eff = getEffectiveWeekStatus(week);
  if (eff==='draft')  return { allowed:false, reason:"Commissioner hasn't opened the week yet." };
  if (eff==='locked') return { allowed:false, reason:'Week is locked — no new picks accepted.' };
  if (eff==='final')  return { allowed:false, reason:'Week is finalized.' };
  if (eff==='live')   return { allowed:false, reason:'Games are in progress — picks closed.' };
  return { allowed:true, reason:'' };
}

function isGamePickable(game) {
  const ov = getGameLockOverrides();
  if (ov[game.gameId] === 'unlocked') return true;
  if (game.status === GAME_STATUS.LIVE || game.status === GAME_STATUS.FINAL) return false;
  if (!game.kickoff) return true;
  return new Date() < new Date(game.kickoff);
}

/**
 * Whether the given viewer is allowed to see OTHER players' picks/tiebreakers
 * for this week. True when (a) the viewer is admin, (b) the week is live/final
 * (everything is public), or (c) the viewer has already submitted their own
 * picks (blind-picks rule is satisfied for them). Used by tiebreaker cells
 * which need to hide other people's guesses with *** until the viewer earns
 * the right to see them.
 */
function canViewOtherPicks(week, viewerPlayerId) {
  if (!week) return false;
  const sess = getSession();
  if (sess.isAdmin) return true;
  const eff = getEffectiveWeekStatus(week);
  if (eff === 'live' || eff === 'final') return true;
  if (!viewerPlayerId) return false;
  return hasPlayerSubmitted(week.weekId, viewerPlayerId);
}

// ─── PICKS PAGE ───────────────────────────────────────────────────────────────

function renderPicksPage() {
  // v0.16.0 dispatcher — supports viewing previous locked/closed weeks
  // (read-only) and appends the week-nav + recap footer around every branch
  // of the current-week renderer.
  const c = document.getElementById('page-picks'); if (!c) return;
  const currentWeek = getCurrentWeek();
  const viewWeek = state.picksWeekId ? getWeek(state.picksWeekId) : null;
  if (viewWeek && currentWeek && viewWeek.weekId !== currentWeek.weekId) {
    renderHistoricalPicksView(c, viewWeek, currentWeek);
    return;
  }
  state.picksWeekId = null;
  renderPicksPageCurrent();
  c.insertAdjacentHTML('afterbegin', renderPicksWeekNav(currentWeek, currentWeek));
  bindPicksWeekNav();
  // Hide the permanent-record / previous-recap footer when a logged-in player
  // is actively engaged with THIS week (picking or reviewing their picks). The
  // permanent record is context for outsiders and the commissioner — a signed-in
  // player's picks tab should stay focused on the games at hand.
  const session = getSession();
  const playerActivelyInPicks = session?.playerVerified && session?.playerId && !session?.isAdmin;
  if (!playerActivelyInPicks) {
    c.insertAdjacentHTML('beforeend', renderPicksFooterHTML(currentWeek));
  }
}

/** Weeks a player may browse on the Picks tab: current week + anything locked/live/final. Demo weeks are commissioner-only. */
function picksNavWeeks() {
  const cur = getCurrentWeek();
  const session = getSession();
  const isCommissioner = !!session?.isAdmin;
  const weeks = getWeeks().filter(w => w.showInHistory !== false && w.status !== WEEK_STATUS.DRAFT &&
    // Demo weeks: commissioner sees always; non-commissioners never see (even if it's the active week).
    (w.dataSourceMode !== 'demo' || isCommissioner));
  return weeks.sort((a, b) => String(a.season).localeCompare(String(b.season)) || a.weekNumber - b.weekNumber);
}

function renderPicksWeekNav(viewWeek, currentWeek) {
  if (!viewWeek) return '';
  const weeks = picksNavWeeks();
  if (weeks.length < 2) return '';
  const idx = weeks.findIndex(w => w.weekId === viewWeek.weekId);
  const prev = idx > 0 ? weeks[idx - 1] : null;
  const next = idx >= 0 && idx < weeks.length - 1 ? weeks[idx + 1] : null;
  const isCurrent = viewWeek.weekId === currentWeek?.weekId;
  return `
    <div class="picks-week-nav">
      <button class="btn btn-ghost btn-sm" data-picks-week="${prev ? escHtml(prev.weekId) : ''}" ${prev ? '' : 'disabled'}>‹</button>
      <div class="picks-week-nav-label">${escHtml(formatWeekLabel(viewWeek))}${isCurrent ? ' <span class="picks-week-current">· current</span>' : ' <span class="picks-week-past">· past week (read-only)</span>'}</div>
      <button class="btn btn-ghost btn-sm" data-picks-week="${next ? escHtml(next.weekId) : ''}" ${next ? '' : 'disabled'}>›</button>
    </div>`;
}

function bindPicksWeekNav() {
  document.querySelectorAll('[data-picks-week]').forEach(b => b.addEventListener('click', () => {
    if (!b.dataset.picksWeek) return;
    const cur = getCurrentWeek();
    state.picksWeekId = (b.dataset.picksWeek === cur?.weekId) ? null : b.dataset.picksWeek;
    renderPicksPage();
    window.scrollTo({ top: 0 });
  }));
}

/** Read-only view of a previous locked/closed week (v0.16.0). Blind-picks rule
 *  preserved: for LOCKED weeks only the viewer's own picks show; live/final
 *  weeks are public just like the dashboard. */
function renderHistoricalPicksView(c, week, currentWeek) {
  const session = getSession();
  const eff = getEffectiveWeekStatus(week);
  const isPublic = eff === 'live' || eff === 'final' || week.status === 'final';
  const games = getGames(week.weekId).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const myId = session.playerId && session.playerVerified ? session.playerId : null;

  let body = '';
  if (!isPublic && !myId) {
    body = `<div class="week-status-card"><div class="week-status-icon">🔒</div>
      <div class="week-status-body"><div class="week-status-title">Locked week</div>
      <div class="week-status-msg">Log in on the current week to view your own picks for this week.</div></div></div>`;
  } else {
    const myPicks = myId ? getPicks(week.weekId, myId) : [];
    const rows = games.map(g => {
      const pick = myPicks.find(p => p.gameId === g.gameId) || null;
      const ats = g.atsWinner ?? calculateAtsWinner(g);
      const showAts = isPublic && ats;
      let pickBadge = '';
      if (pick) {
        const res = evaluatePick(pick, g);
        pickBadge = `<span class="hist-pick ${getResultBadgeClass(res)}">${escHtml(pick.selectedTeam)} ${res === PICK_RESULT.WIN ? '✓' : res === PICK_RESULT.LOSS ? '✗' : ''}</span>`;
      }
      const score = (g.homeScore != null && g.awayScore != null) ? `${g.awayScore}–${g.homeScore}` : '';
      return `<div class="hist-game-row">
        <div class="hist-matchup">${escHtml(getTeamDisplay(g, 'away'))} @ ${escHtml(getTeamDisplay(g, 'home'))}
          <span class="text-muted text-xs">${escHtml(formatSpread(g.lockedSpread ?? g.spread, g.favorite, g) || '')}</span></div>
        <div class="hist-right">${score ? `<span class="hist-score">${score}</span>` : ''}
          ${showAts && ats !== 'no_decision' ? `<span class="hist-ats">ATS: ${escHtml(ats)}</span>` : showAts ? '<span class="hist-ats">Push</span>' : ''}
          ${pickBadge}</div>
      </div>`;
    }).join('');
    body = `<div class="card mb-md">${rows || '<p class="text-muted">No games recorded for this week.</p>'}</div>`;
  }

  c.innerHTML = `
    ${renderPicksWeekNav(week, currentWeek)}
    ${renderWeekBanner(week)}
    ${body}
    ${week.status === 'final' ? renderWeekRecapCardHTML(week) : ''}`;
  bindPicksWeekNav();
}

function renderPicksPageCurrent() {
  const c = document.getElementById('page-picks'); if (!c) return;
  const session = getSession();
  const week    = getCurrentWeek();

  if (!session.playerId || !session.playerVerified) {
    c.innerHTML = renderLoginScreen(week); bindLoginScreen(); return;
  }

  const player = getPlayer(session.playerId);
  if (!player) { clearSession(); resyncPlayerPreferences(); renderPicksPage(); return; }

  const games       = week ? getGames(week.weekId).sort((a,b) => new Date(a.kickoff)-new Date(b.kickoff)) : [];
  const submitted   = week ? hasPlayerSubmitted(week.weekId, session.playerId) : false;
  const displayName = week ? getDisplayNamePlain(week.weekId, session.playerId, getPlayers()) : player.displayName;
  const { allowed, reason } = canPlayerSubmitPicks(week, session.playerId);

  if (submitted && !state.editingPicks) { renderSubmittedView(c, week, games, session, displayName); return; }

  if (!allowed) {
    const ep = week ? getPicks(week.weekId, session.playerId) : [];
    c.innerHTML = `
      ${renderWeekBanner(week)}
      <div class="week-status-card">
        <div class="week-status-icon">🔒</div>
        <div class="week-status-body">
          <div class="week-status-title">Logged in as ${escHtml(displayName)}</div>
          <div class="week-status-msg">${escHtml(reason)}</div>
          ${ep.length ? `<div class="text-muted text-xs mt-sm">${ep.length}/${games.length} picks saved.</div>` : ''}
        </div>
      </div>
      <button class="btn btn-ghost btn-sm mt-md" id="logout-btn">Log Out / Switch Player</button>`;
    document.getElementById('logout-btn')?.addEventListener('click', () => { clearSession(); state.draftPicks={}; resyncPlayerPreferences(); renderPicksPage(); });
    return;
  }

  // When entering edit mode (player came back to update already-submitted
  // picks), pre-fill state.draftPicks from the saved picks so the UI shows
  // their current selections as already chosen. Same for the tiebreaker.
  if (state.editingPicks && Object.keys(state.draftPicks).length === 0) {
    const existing = getPicks(week.weekId, session.playerId);
    existing.forEach(p => { state.draftPicks[p.gameId] = p.selectedTeam; });
    const tb = getTiebreakerGuess(week.weekId, session.playerId);
    if (tb !== null && tb !== undefined) state.draftTiebreaker = tb;
    const ep = getExtraPointGuess(week.weekId, session.playerId);
    if (ep !== null && ep !== undefined) state.draftExtraPoint = ep;
  }

  c.innerHTML = `
    ${renderWeekBanner(week)}
    ${renderPicksTiming(week, games)}
    <div class="flex-between mb-md">
      <div><span class="text-maroon font-display" style="font-size:1.05rem">${escHtml(displayName)}</span>
      <span class="text-muted text-sm"> — ${state.editingPicks?'update your picks':'make your picks'}</span></div>
      <button class="btn btn-ghost btn-sm" id="logout-btn">Log Out</button>
    </div>
    ${state.editingPicks?'<div class="edit-mode-banner">✏️ You\'re updating picks you already submitted. Changes save when you click Submit again.</div>':''}
    ${getSettings().randomizePicksEnabled?`<div class="flex-between mb-sm randomize-row">
      <span class="text-muted text-xs">Need a quick start? Randomize then edit anything you want to change.</span>
      <button class="btn btn-ghost btn-sm" id="randomize-picks-btn" title="Randomly pick a team for each game">🎲 Randomize My Picks</button>
    </div>`:''}
    <div id="games-list"></div>
    ${renderTiebreakerInput(week)}
    ${renderExtraPointInput(week)}
    <div class="submit-bar">
      <div class="submit-progress"><strong id="pick-count">0</strong>/${games.length} + tiebreaker</div>
      <button class="btn btn-primary" id="submit-picks-btn" disabled>${state.editingPicks?'Update Picks':'Submit All Picks'}</button>
    </div>`;

  document.getElementById('logout-btn')?.addEventListener('click', () => { clearSession(); state.draftPicks={}; state.draftTiebreaker=null; resyncPlayerPreferences(); renderPicksPage(); });
  document.getElementById('tb-input')?.addEventListener('input', e => {
    state.draftTiebreaker = e.target.value !== '' ? parseFloat(e.target.value) : null;
    updateSubmitEnabled(games, week);
  });
  document.getElementById('ep-input')?.addEventListener('input', e => {
    state.draftExtraPoint = e.target.value !== '' ? parseInt(e.target.value, 10) : null;
  });
  // Priority 8: Randomize-my-picks button. Operates only on games still
  // pickable (skips locked/live/final), so it can be safely re-clicked late
  // in the week without overwriting already-decided picks the player can't
  // change anyway. Picks are written into `state.draftPicks` (not submitted)
  // so the player can still review/edit before hitting Submit.
  document.getElementById('randomize-picks-btn')?.addEventListener('click', () => {
    const pickable = games.filter(isGamePickable);
    if (!pickable.length) { showToast('No games are still open to pick','warning'); return; }
    // Math.random() is fine here — not seeded by player ID or any deterministic
    // input, so every click produces a fresh selection.
    pickable.forEach(g => {
      const pickHome = Math.random() < 0.5;
      state.draftPicks[g.gameId] = pickHome ? g.homeTeam : g.awayTeam;
    });
    renderGamesList(games, week);
    bindPickButtons(games, week);
    updateSubmitEnabled(games, week);
    showToast(`🎲 Randomized ${pickable.length} pick${pickable.length>1?'s':''} — review and submit when ready`, 'success');
  });
  renderGamesList(games, week);
  bindPickButtons(games, week);
  document.getElementById('submit-picks-btn')?.addEventListener('click', () => submitPicks(week, games));
  updateSubmitEnabled(games, week);
}

/** v0.16.0 — The Ischemic Extra Point guess input (optional side bet). */
function renderExtraPointInput(week) {
  if (!week || week.extraPointEnabled === false) return '';
  const val = state.draftExtraPoint !== null && state.draftExtraPoint !== undefined ? state.draftExtraPoint : '';
  return `
    <div class="card mb-md ep-input-card">
      <label class="form-label" for="ep-input">🎯 The Ischemic Extra Point <span class="text-muted text-xs">(blackjack rules)</span></label>
      <p class="text-muted text-xs mb-sm">Longest MADE field goal on this week's slate, in yards. Closest without going over wins. Over = bust. Exact = blackjack.</p>
      <input class="form-input" id="ep-input" type="number" inputmode="numeric" min="15" max="75" step="1"
        placeholder="e.g. 52" value="${val}" />
    </div>`;
}

function renderTiebreakerInput(week) {
  if (!week?.tiebreakerQuestion) return '';
  return `<div class="tiebreaker-card">
    <div class="tiebreaker-label">🎯 Weekly Tiebreaker (Required)</div>
    <div class="tiebreaker-question">${escHtml(week.tiebreakerQuestion)}</div>
    <input class="form-input" id="tb-input" type="number" min="0" step="1"
      placeholder="Your numeric guess…" style="margin-top:10px"
      value="${state.draftTiebreaker !== null && state.draftTiebreaker !== undefined ? state.draftTiebreaker : ''}" />
    <p class="text-muted text-xs mt-sm">Required. Closest guess wins ties.</p>
  </div>`;
}

function renderLoginScreen(week) {
  const players = getPlayers().filter(p => p.active);
  // v0.17.2: the lock deadline is the single best reason to sign in, so it sits
  // above the player grid rather than behind the PIN.
  const games = week ? getGames(week.weekId) : [];
  return `
    ${renderWeekBanner(week)}
    ${renderLockCountdownHTML(week, games)}
    <div class="card">
      <div class="card-header"><span class="card-title">👤 Who Are You?</span></div>
      <p class="text-secondary text-sm mb-md">Select your name and enter your PIN.</p>
      <div class="player-grid" id="player-grid">
        ${players.map(p => {
          const sub  = week ? hasPlayerSubmitted(week.weekId, p.playerId) : false;
          const nick = week ? getNickname(week.weekId, p.playerId) : null;
          return `<button class="player-tile${sub?' has-submitted':''}" data-player-id="${p.playerId}">
            <div class="player-avatar">${escHtml(getPlayerInitials(p))}</div>
            <div class="player-tile-name">${escHtml(p.displayName)}</div>
            ${nick ? `<div class="player-tile-nick">"${escHtml(nick)}"</div>` : ''}
            ${sub ? '<div class="player-tile-done">✓ Done</div>' : ''}
          </button>`;
        }).join('')}
      </div>
      <div id="pin-area" style="display:none;margin-top:16px">
        <div class="divider"></div>
        <p class="text-sm mb-sm">PIN for <strong id="selected-name"></strong>:</p>
        <div class="flex gap-sm">
          <input class="form-input" id="pin-input" type="password" inputmode="numeric"
            maxlength="8" placeholder="PIN…" style="flex:1;letter-spacing:.2em;font-size:1.2rem"/>
          <button class="btn btn-primary" id="pin-submit-btn">Enter →</button>
        </div>
        <button class="btn btn-ghost btn-sm mt-sm" id="cancel-player-btn">← Back</button>
      </div>
    </div>`;
}

function bindLoginScreen() {
  let selectedId = null;
  document.querySelectorAll('.player-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      selectedId = tile.dataset.playerId;
      const p = getPlayer(selectedId);
      document.querySelectorAll('.player-tile').forEach(t => t.classList.toggle('selected', t === tile));
      const pa = document.getElementById('pin-area'); if (pa) pa.style.display='block';
      const ne = document.getElementById('selected-name'); if (ne&&p) ne.textContent=p.displayName;
      document.getElementById('pin-input')?.focus();
    });
  });
  document.getElementById('cancel-player-btn')?.addEventListener('click', () => {
    selectedId=null;
    const pa=document.getElementById('pin-area'); if(pa)pa.style.display='none';
    document.querySelectorAll('.player-tile').forEach(t=>t.classList.remove('selected'));
  });
  const doLogin = () => {
    if (!selectedId) return;
    const pin = document.getElementById('pin-input')?.value||'';
    if (verifyPlayerPin(selectedId, pin)) {
      setSession(selectedId, false, true); state.draftPicks={}; state.draftTiebreaker=null;
      // Per-player preferences: re-resolve theme + TZ for the newly-logged-in
      // player (they may differ from device default or previous player).
      resyncPlayerPreferences();
      showToast('✅ Logged in!','success'); renderPicksPage();
      // v0.17.2: if they came here from the chat composer's "Log in" button,
      // bounce them back to the thread they were reading (doc 1.2).
      try { resumeChatAfterLogin(); } catch {}
    } else {
      showToast('❌ Incorrect PIN','error');
      const pi=document.getElementById('pin-input'); if(pi){pi.value='';pi.focus();}
    }
  };
  document.getElementById('pin-submit-btn')?.addEventListener('click', doLogin);
  document.getElementById('pin-input')?.addEventListener('keydown', e => { if(e.key==='Enter')doLogin(); });
}

function renderSubmittedView(c, week, games, session, displayName) {
  const picks   = getPicks(week.weekId, session.playerId);
  const tbGuess = getTiebreakerGuess(week.weekId, session.playerId);
  // Can the player still edit? Same gating as initial submission — week must
  // be open. Once locked/live/final, the edit button hides.
  const { allowed: canEdit } = canPlayerSubmitPicks(week, session.playerId);
  c.innerHTML = `
    ${renderWeekBanner(week)}
    ${renderPicksTiming(week, games)}
    <div class="flex-between mb-md">
      <div><span class="text-maroon font-display" style="font-size:1.05rem">${escHtml(displayName)}</span>
      <span class="text-muted text-sm"> — picks submitted ✓</span></div>
      <button class="btn btn-ghost btn-sm" id="logout-btn">Log Out</button>
    </div>
    ${tbGuess!==null?`<div class="tiebreaker-card tiebreaker-submitted">
      <span class="tiebreaker-label">🎯 Your Tiebreaker Guess</span>
      <span class="tiebreaker-value">${tbGuess}</span>
    </div>`:''}
    <div id="submitted-games"></div>
    <div class="card mt-md text-center" style="padding:16px">
      ${canEdit?'<button class="btn btn-secondary mr-sm" id="edit-picks-btn">✏️ Edit My Picks</button>':''}
      <button class="btn btn-primary" id="go-dash-btn">View Dashboard</button>
    </div>`;
  document.getElementById('logout-btn')?.addEventListener('click', () => { clearSession(); resyncPlayerPreferences(); renderPicksPage(); });
  document.getElementById('go-dash-btn')?.addEventListener('click', () => navigateTo('dashboard'));
  document.getElementById('edit-picks-btn')?.addEventListener('click', () => {
    // Enter edit mode. The picks-page render will pre-fill draftPicks from
    // existing picks and show the editable UI with an explanatory banner.
    state.editingPicks = true;
    state.draftPicks = {};      // cleared so the prefill block sees a fresh slate
    state.draftTiebreaker = null;
    renderPicksPage();
  });
  const list = document.getElementById('submitted-games'); if (!list) return;
  list.innerHTML = games.map(game => {
    const pick = picks.find(p=>p.gameId===game.gameId);
    return renderGameCard(game, pick?.selectedTeam, pick?evaluatePick(pick,game):PICK_RESULT.PENDING, true, true);
  }).join('');
}

function renderWeekBanner(week) {
  if (!week?.blurb) return '';
  const isDemoWeek = week.dataSourceMode === 'demo';
  return `<div class="week-banner${isDemoWeek?' week-banner-demo':''} mb-md">
    <div class="week-banner-icon">${isDemoWeek?'📋':'📋'}</div>
    <div class="week-banner-body">
      <div class="week-banner-title">${escHtml(formatWeekLabel(week))}
        ${isDemoWeek?'<span class="demo-label">DEMO DATA</span>':''}</div>
      <div class="week-banner-blurb">${escHtml(week.blurb)}</div>
    </div>
  </div>`;
}

/**
 * Small timing info line shown on the picks page so players know when picks
 * auto-lock and when games go live. Uses the effective (commissioner-set OR
 * derived) times so a bespoke picksLockAt override shows up here too.
 * Hidden entirely if the week has no games yet or is already live/final.
 */
function renderPicksTiming(week, games) {
  if (!week || !games?.length) return '';
  if (week.status === WEEK_STATUS.LIVE || week.status === WEEK_STATUS.FINAL) return '';
  const lockAt = computeEffectiveLockAt(week, games);
  const liveAt = computeEffectiveLiveAt(week, games);
  if (!lockAt && !liveAt) return '';
  const tz = getTimezone();
  const fmt = (d) => d ? formatGameTime(d.toISOString(), tz) : '—';
  const isLocked = week.status === WEEK_STATUS.LOCKED;
  const now = Date.now();
  const lockPassed = lockAt && now >= lockAt.getTime();
  const livePassed = liveAt && now >= liveAt.getTime();
  return `<div class="picks-timing-info mb-md">
    <span class="pt-item ${lockPassed?'pt-passed':''}">🔒 <strong>Picks lock:</strong> ${escHtml(fmt(lockAt))}${isLocked?' <em>(locked)</em>':''}</span>
    <span class="pt-item ${livePassed?'pt-passed':''}">🏈 <strong>Games live:</strong> ${escHtml(fmt(liveAt))}</span>
  </div>`;
}

/**
 * Human "time remaining" for a deadline, e.g. "2d 4h", "3h 12m", "8m".
 * Returns '' once the deadline has passed — callers show a locked state instead.
 */
function timeUntil(target) {
  if (!target) return '';
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return '';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Prominent lock countdown, shown to EVERYONE including signed-out visitors.
 *
 * v0.17.2 (Drew): the auto-lock deadline was only reachable after login, which
 * is backwards — the deadline is the reason to log in. This renders on the
 * picks login screen and on the dashboard's "Go to Picks" prompt.
 *
 * Deliberately contains NO pick data, so it is safe on a signed-out surface
 * and cannot violate the blind rule.
 */
function renderLockCountdownHTML(week, games, { compact = false } = {}) {
  if (!week || !games?.length) return '';
  if (week.status === WEEK_STATUS.LIVE || week.status === WEEK_STATUS.FINAL) return '';
  const lockAt = computeEffectiveLockAt(week, games);
  if (!lockAt) return '';
  const tz = getTimezone();
  const when = formatGameTime(lockAt.toISOString(), tz);
  const left = timeUntil(lockAt);
  const locked = week.status === WEEK_STATUS.LOCKED || !left;

  if (locked) {
    return `<div class="lock-countdown lock-countdown-closed${compact ? ' lock-countdown-compact' : ''}">
      <span class="lock-countdown-icon">🔒</span>
      <div><div class="lock-countdown-main">Picks are locked</div>
      <div class="lock-countdown-sub">Locked ${escHtml(when)}</div></div>
    </div>`;
  }
  const urgent = lockAt.getTime() - Date.now() < 3 * 3600 * 1000;
  return `<div class="lock-countdown${urgent ? ' lock-countdown-urgent' : ''}${compact ? ' lock-countdown-compact' : ''}">
    <span class="lock-countdown-icon">⏳</span>
    <div><div class="lock-countdown-main">Picks lock in ${escHtml(left)}</div>
    <div class="lock-countdown-sub">${escHtml(when)} · ${games.length} game${games.length === 1 ? '' : 's'} on the slate</div></div>
  </div>`;
}

function renderGamesList(games, week) {
  const c = document.getElementById('games-list'); if (!c) return;
  const windows = [
    {key:'morning',label:'🌅 Morning'},{key:'afternoon',label:'☀️ Afternoon'},
    {key:'evening',label:'🌆 Evening'},{key:'late',label:'🌙 Late Night'},
  ];

  // Separate games that aren't ready to be picked (no teams / no date) so players
  // never see filler data. They're surfaced as a small notice instead.
  const ready = [];
  const pending = [];
  for (const g of games) {
    (gameDataReadiness(g).level === 'incomplete' ? pending : ready).push(g);
  }

  let html='';
  for (const{key,label}of windows) {
    const wg=ready.filter(g=>g.timeWindow===key);
    if(!wg.length)continue;
    html+=`<div class="time-window-label">${label}</div>`;
    for(const game of wg) html+=renderGameCard(game,state.draftPicks[game.gameId],PICK_RESULT.PENDING,!isGamePickable(game),false);
  }

  if (pending.length) {
    html += `<div class="pending-games-notice">
      <strong>⏳ ${pending.length} game${pending.length>1?'s':''} pending confirmation</strong>
      <span class="text-muted text-xs">The Commissioner is still finalizing the date/time for ${pending.length>1?'these games':'this game'}. ${pending.length>1?'They':'It'} will appear here once confirmed.</span>
    </div>`;
  }

  c.innerHTML = html || '<p class="text-muted text-center mt-lg">No games on the slate yet.</p>';
}

function renderGameCard(game, pickedTeam, result, isLocked, showResult) {
  const sv = game.lockedSpread!==null ? game.lockedSpread : game.spread;
  // For final games with no spread: show "Final" label; TBD only for future unset games.
  // The provenance ("ESPN · DraftKings" vs "Manual") was confusing players on the
  // picks page so it's been moved to the Commissioner panel only. Players now just
  // see the spread.
  const spreadDisplay = sv !== null
    ? `<span class="spread-badge">${fmtSpread(sv, game.favorite, game)}</span>`
    : game.status === GAME_STATUS.FINAL
      ? `<span class="spread-badge" style="opacity:.55">Final</span>`
      : `<span class="spread-badge" style="opacity:.55;border-style:dashed">TBD</span>`;

  const dqBadge = renderSourceBadge(game);
  const timeStr = fmtTime(game.kickoff, game);  // passes game for TBD detection
  const homeRk  = game.homeRank ? `#${game.homeRank} ` : '';
  const awayRk  = game.awayRank ? `#${game.awayRank} ` : '';
  const dis     = isLocked ? 'disabled' : '';

  // School (Mascot) display
  const homeDisplay = td(game, 'home');
  const awayDisplay = td(game, 'away');
  // Mascot subtitle (only if mascot is set/looked up)
  const homeMasc = homeDisplay !== game.homeTeam ? homeDisplay.match(/\(([^)]+)\)/)?.[1] : '';
  const awayMasc = awayDisplay !== game.awayTeam ? awayDisplay.match(/\(([^)]+)\)/)?.[1] : '';

  // Venue: prefer city/state or city/country over stadium name
  const venueStr = (() => {
    const loc = formatVenueDisplay(game);
    if (!loc) return '';
    return `<span class="game-venue text-muted text-xs">📍 ${escHtml(loc)}${game.neutralSite?' 🌍':''}</span>`;
  })();

  const liveScore = (game.status===GAME_STATUS.LIVE||game.status===GAME_STATUS.FINAL) && game.homeScore!==null
    ? `<div class="live-score">
        <div class="score-num${game.homeScore>game.awayScore?' score-leading':''}">${game.homeScore}</div>
        <div class="score-status">${game.status===GAME_STATUS.LIVE?'🔴 LIVE':'FINAL'}</div>
        <div class="score-num${game.awayScore>game.homeScore?' score-leading':''}">${game.awayScore}</div>
      </div>` : '';

  let atsInfo = '';
  if (showResult && game.status===GAME_STATUS.FINAL) {
    const ats = game.atsWinner??calculateAtsWinner(game);
    const atsLabel = ats==='no_decision'?'No Decision':escHtml(ats||'—');
    atsInfo = `<div class="ats-row">
      <span class="text-xs text-muted">Winner: <strong>${escHtml(game.actualWinner||'—')}</strong></span>
      <span class="text-xs text-muted">ATS: <strong class="${ats==='no_decision'?'result-nd':'text-maroon'}">${atsLabel}</strong></span>
    </div>`;
  }

  // Live tentative ATS badge — shows covering/not covering during live game
  let liveAtsBadge = '';
  if (showResult && game.status===GAME_STATUS.LIVE && game.homeScore!==null && sv!==null && pickedTeam) {
    const adjusted    = game.homeScore + sv;
    const homeCovering = adjusted > game.awayScore;
    const pickedHome   = pickedTeam === game.homeTeam;
    const covering     = pickedHome ? homeCovering : !homeCovering;
    liveAtsBadge = covering
      ? `<span class="badge badge-live-covering">⚡ Covering</span>`
      : `<span class="badge badge-live-trailing">⚡ Trailing</span>`;
  }

  const homeCls = `pick-btn ${getBtnClass(game.homeTeam,pickedTeam,result,showResult,game)}`;
  const awayCls = `pick-btn ${getBtnClass(game.awayTeam,pickedTeam,result,showResult,game)}`;

  return `<div class="game-card${game.isAlmaMaterGame?' alma-mater':''}" data-game-id="${game.gameId}">
    <div class="game-card-header">
      <div class="flex gap-sm flex-center">
        <span class="game-time">${timeStr}</span>
        ${game.isAlmaMaterGame?'<span class="alma-mater-badge">⭐ Alma Mater</span>':''}
        ${renderGameBadges(game)}
        ${dqBadge}
      </div>
      <div class="flex gap-sm flex-center">
        ${isLocked?'<span class="badge badge-locked">🔒</span>':''}
        ${showResult&&pickedTeam&&game.status===GAME_STATUS.FINAL?`<span class="badge ${getResultBadgeClass(result)}">${getPickStatusLabel(result)}</span>`:''}
        ${liveAtsBadge}
      </div>
    </div>
    <div class="game-card-body">
      <div class="matchup">
        <div class="team away">
          ${awayRk?`<div class="team-rank">${awayRk}</div>`:''}
          <div class="team-name">${escHtml(game.awayTeam)}${awayMasc?` <span class="team-mascot">(${escHtml(awayMasc)})</span>`:''}</div>
          <div class="team-conf">${escHtml(game.awayConference||'')}</div>
        </div>
        <div class="vs-divider">@</div>
        <div class="team home">
          ${homeRk?`<div class="team-rank">${homeRk}</div>`:''}
          <div class="team-name">${escHtml(game.homeTeam)}${homeMasc?` <span class="team-mascot">(${escHtml(homeMasc)})</span>`:''}</div>
          <div class="team-conf">${escHtml(game.homeConference||'')}</div>
        </div>
      </div>
      ${liveScore}
      ${atsInfo}
      ${venueStr}
      <div class="spread-row"><span class="text-muted text-xs">Spread:</span>${spreadDisplay}</div>
      ${!showResult?`<div class="pick-buttons">
        <button class="${awayCls}" data-team="${escHtml(game.awayTeam)}" data-game-id="${game.gameId}" ${dis}>${escHtml(awayDisplay)}</button>
        <button class="${homeCls}" data-team="${escHtml(game.homeTeam)}" data-game-id="${game.gameId}" ${dis}>${escHtml(homeDisplay)}</button>
      </div>`:''}
      ${game.espnEventId?`<div class="text-muted text-xs mt-sm text-right">ESPN: ${game.espnEventId}</div>`:''}
    </div>
  </div>`;
}

function renderSourceBadge(game) {
  const ds = game.dataSource || game.dataQuality;
  return {
    espn_live:       '<span class="dq-badge dq-espn-live">📡 ESPN Live</span>',
    espn_historical: '<span class="dq-badge dq-espn-hist">📅 ESPN Hist</span>',
    demo:            '<span class="dq-badge dq-demo">📋 Demo</span>',
    proposed:        '<span class="dq-badge dq-proposed">📌 Proposed</span>',
    partial:         '<span class="dq-badge dq-partial">⚠️ Partial</span>',
  }[ds] || '';
}

function getBtnClass(team, pickedTeam, result, showResult, game=null) {
  if (!showResult || result===PICK_RESULT.PENDING) return team===pickedTeam?'selected':'';
  // Live: tentative coloring
  if (result===PICK_RESULT.LIVE && game && game.homeScore!==null) {
    const sv = game.lockedSpread!==null ? game.lockedSpread : game.spread;
    if (sv!==null && team===pickedTeam) {
      const adj = game.homeScore + sv;
      const homeCovering = adj > game.awayScore;
      const pickedHome   = team === game.homeTeam;
      const covering     = pickedHome ? homeCovering : !homeCovering;
      return covering ? 'live-covering' : 'live-trailing';
    }
    return team===pickedTeam?'selected':'';
  }
  if (result===PICK_RESULT.LIVE) return team===pickedTeam?'selected':'';
  if (team!==pickedTeam) return '';
  return { win:'locked-win', loss:'locked-loss', no_decision:'locked-nd' }[result]||'selected';
}

/**
 * Live ATS status for a player's pick in an in-progress game.
 * Returns one of: 'covering' | 'trailing' | 'even' | null.
 *  - 'covering': the picked team is currently beating the spread
 *  - 'trailing': the picked team is currently losing the spread
 *  - 'even': exactly on the number right now (tentative push)
 *  - null: not live, no score yet, no spread, or pick missing
 * Used by the dashboard matrix to show a soft, scannable live state
 * (distinct from finalized green/red ✓/✗ boxes).
 */
function livePickStatus(pick, game) {
  if (!pick || !game) return null;
  if (game.status !== GAME_STATUS.LIVE) return null;
  if (game.homeScore === null || game.awayScore === null) return null;
  const sv = game.lockedSpread !== null ? game.lockedSpread : game.spread;
  if (sv === null || sv === undefined) return null;
  const adj = game.homeScore + sv;        // home-perspective adjusted score
  const margin = adj - game.awayScore;    // >0 home covering, <0 away covering
  if (Math.abs(margin) < 0.01) return 'even';
  const homeCovering = margin > 0;
  const pickedHome = pick.selectedTeam === game.homeTeam;
  const covering = pickedHome ? homeCovering : !homeCovering;
  return covering ? 'covering' : 'trailing';
}
function getResultBadgeClass(r) { return{win:'badge-win',loss:'badge-loss',no_decision:'badge-nd',live:'badge-live'}[r]||'badge-draft'; }

function bindPickButtons(games, week) {
  document.querySelectorAll('.pick-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const gid=btn.dataset.gameId; const team=btn.dataset.team;
      state.draftPicks[gid]=team;
      document.querySelectorAll(`.pick-btn[data-game-id="${gid}"]`).forEach(b=>b.classList.toggle('selected',b.dataset.team===team));
      updateSubmitEnabled(games, week);
    });
  });
}

function updateSubmitEnabled(games, week) {
  const count = Object.keys(state.draftPicks).filter(gid=>games.some(g=>g.gameId===gid)).length;
  const el=document.getElementById('pick-count'); if(el)el.textContent=count;
  const btn=document.getElementById('submit-picks-btn'); if(!btn)return;
  const tbReq = !!(week?.tiebreakerQuestion);
  const tbOk  = !tbReq||(state.draftTiebreaker!==null&&!isNaN(state.draftTiebreaker));
  btn.disabled = count<games.length||!tbOk;
}

function submitPicks(week, games) {
  const session=getSession();
  if(!session.playerId||!session.playerVerified)return;
  const{allowed,reason}=canPlayerSubmitPicks(week,session.playerId);
  if(!allowed){showToast(`🔒 ${reason}`,'error');return;}
  // If the shared backend is configured but failing, warn loudly BEFORE
  // accepting the submit. We don't block — the player needs to be able to
  // submit even offline — but they must explicitly acknowledge their picks
  // may not reach the league until sync recovers.
  const banner = document.getElementById('backend-error-banner');
  const syncBroken = isBackendConfigured() && banner && banner.style.display !== 'none';
  if (syncBroken) {
    const ok = confirm(
      '⚠️ Cross-device sync is currently OFF.\n\n' +
      'Your picks will be saved on THIS device but may not reach other ' +
      'players or the commissioner until the connection is restored.\n\n' +
      'Submit anyway?'
    );
    if (!ok) return;
  }
  const newPicks=games.map(game=>{
    const sel=state.draftPicks[game.gameId];
    if(!sel||!isGamePickable(game))return null;
    const existing=getPick(week.weekId,game.gameId,session.playerId);
    if(existing)return{...existing,selectedTeam:sel,updatedAt:new Date().toISOString()};
    return createPick(week.weekId,game.gameId,session.playerId,sel);
  }).filter(Boolean);
  saveAllPicks(newPicks);
  if(state.draftTiebreaker!==null&&!isNaN(state.draftTiebreaker))
    setTiebreakerGuess(week.weekId,session.playerId,state.draftTiebreaker);
  if(state.draftExtraPoint!==null&&!isNaN(state.draftExtraPoint))
    setExtraPointGuess(week.weekId,session.playerId,state.draftExtraPoint);
  // v0.16.0 — system chat event. HARD RULE: count only, never the selections.
  try {
    const totalPicks = getPicks(week.weekId, session.playerId).length;
    emitPicksLockedEvent(week.weekId, session.playerId, totalPicks, games.length);
  } catch {}
  const wasEditing = state.editingPicks;
  state.draftPicks={}; state.draftTiebreaker=null; state.draftExtraPoint=null; state.editingPicks=false;
  showToast(syncBroken
    ? '✅ Picks saved locally. ⚠️ Sync still off — picks not yet shared.'
    : (wasEditing ? '✅ Picks updated!' : '✅ Picks submitted! Good luck!'),'success');
  setTimeout(()=>renderPicksPage(),300);
}

// ─── ALMA MATER WATCH ─────────────────────────────────────────────────────────

function renderAlmaMaterWatch(weekId, games) {
  const slateGames = games || getGames(weekId);
  const rows = ALMA_MATERS.map(alma => {
    const game = slateGames.find(g =>
      getAlmaMaterMatch(g.homeTeam) === alma || getAlmaMaterMatch(g.awayTeam) === alma
    );
    if (!game) {
    return `<div class="alma-watch-row">
        <span class="alma-watch-team">${escHtml(alma)}</span>
        <span class="alma-watch-bye">BYE</span>
      </div>`;
    }
    // Use precise matching to decide which side is the alma mater (avoid Arkansas/Arkansas State false positives)
    const isHome  = getAlmaMaterMatch(game.homeTeam) === alma;
    const opp     = isHome ? teamSchool(game,'away') : teamSchool(game,'home');
    const myRank  = isHome ? game.homeRank : game.awayRank;
    const oppRank = isHome ? game.awayRank : game.homeRank;
    const rankStr = myRank ? `#${myRank} ` : '';
    const oppStr  = oppRank ? `#${oppRank} ${opp}` : opp;
    const loc     = isHome ? 'vs' : '@';
    const timeStr = fmtTime(game.kickoff, game);

    let scoreStr = '';
    if (game.status===GAME_STATUS.FINAL&&game.homeScore!==null) {
      const myScore  = isHome?game.homeScore:game.awayScore;
      const oppScore = isHome?game.awayScore:game.homeScore;
      // STRAIGHT-UP win/loss only — the alma mater watch tracks whether your
      // school won the actual game, not whether they covered the spread.
      // (The picks dashboard handles ATS; this section is just "did my team win?")
      const won = myScore > oppScore;
      const tied = myScore === oppScore;
      const wl = tied ? 'T' : (won ? 'W' : 'L');
      const cls = tied ? 'alma-result-tie' : (won ? 'alma-result-win' : 'alma-result-loss');
      scoreStr = ` · <span class="alma-result-pill ${cls}">${wl} ${myScore}–${oppScore}</span>`;
    } else if (game.status===GAME_STATUS.LIVE&&game.homeScore!==null) {
      const myScore  = isHome?game.homeScore:game.awayScore;
      const oppScore = isHome?game.awayScore:game.homeScore;
      // Tentative live indicator — also straight-up (just who's ahead right now).
      const ahead = myScore > oppScore;
      const tied = myScore === oppScore;
      const status = tied ? 'TIED' : (ahead ? 'WINNING' : 'LOSING');
      const cls = tied ? '' : (ahead ? 'alma-live-ahead' : 'alma-live-behind');
      scoreStr = ` · <span class="alma-live-pill ${cls}"><span class="live-dot"></span>${status} ${myScore}–${oppScore}</span>`;
    }

    return `<div class="alma-watch-row">
      <span class="alma-watch-team">${rankStr}${escHtml(alma)}</span>
      <span class="alma-watch-matchup">${loc} ${escHtml(oppStr)}</span>
      <span class="alma-watch-time">${timeStr}${scoreStr}</span>
    </div>`;
  });

  return `<div class="card mb-md">
    <div class="card-header"><span class="card-title">⭐ Alma Mater Watch</span></div>
    ${rows.join('')}
  </div>`;
}

// ─── UN-105a: horizontal-scroll edge-fade cue ──────────────────────────────
// ONE shared binder for every .dashboard-scroll / .batch-grid-scroll wrapper
// in the app. Call initScrollFades(container) after ANY render that produces
// one of those wrappers — see loadtest.mjs's site-count assertion, which
// exists precisely so a future render site added without this call is caught.
/** Test-only export: recompute (not (re)bind) the fade state for one element. */
export function _updateScrollFadeState(el) {
  if (!el) return;
  const hasOverflow = el.scrollWidth > el.clientWidth + 1;
  el.classList.toggle('scroll-fade-active', hasOverflow);
  if (!hasOverflow) {
    // No real overflow — never hint at a scroll that doesn't exist.
    el.classList.remove('scroll-fade-at-end', 'scroll-fade-scrolled');
    return;
  }
  el.classList.toggle('scroll-fade-scrolled', el.scrollLeft > 1);
  el.classList.toggle('scroll-fade-at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
}

let _scrollFadeResizeBound = false;
/**
 * Bind (idempotently) the edge-fade cue to every .dashboard-scroll /
 * .batch-grid-scroll wrapper inside `root` (defaults to the whole document).
 * Safe — and necessary — to call repeatedly against the SAME DOM:
 *  - a commissioner tab switch flips display:none without rebuilding the
 *    DOM, so a wrapper that was hidden (0×0) at initial render needs a
 *    re-measure once it becomes visible;
 *  - a <details> section (the 2025 season record) starts collapsed, which is
 *    also display:none — its two wrapped tables can't be measured until the
 *    user actually opens it, so we bind a 'toggle' listener too.
 * The per-element scroll listener itself is bound only once (dataset flag)
 * so repeat calls never stack duplicate listeners on the same node.
 */
export function initScrollFades(root) {
  const scope = root || document;
  scope.querySelectorAll('.dashboard-scroll, .batch-grid-scroll').forEach(el => {
    el.classList.add('scroll-fade');
    if (!el.dataset.scrollFadeBound) {
      el.dataset.scrollFadeBound = '1';
      el.addEventListener('scroll', () => _updateScrollFadeState(el), { passive: true });
    }
    _updateScrollFadeState(el);
  });
  scope.querySelectorAll('details').forEach(d => {
    if (d.dataset.scrollFadeToggleBound) return;
    d.dataset.scrollFadeToggleBound = '1';
    d.addEventListener('toggle', () => initScrollFades(d));
  });
  if (!_scrollFadeResizeBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    _scrollFadeResizeBound = true;
    window.addEventListener('resize', () => initScrollFades(document));
  }
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function renderDashboard() {
  renderDashboardInner();
  // v0.16.0 — chat teaser card pinned to the top of the dashboard
  const host = document.getElementById('page-dashboard');
  if (host && !document.getElementById('dash-chat-teaser')) {
    host.insertAdjacentHTML('afterbegin', dashboardChatTeaserHTML());
  }
}

function renderDashboardInner() {
  const c=document.getElementById('page-dashboard'); if(!c)return;
  const session=getSession();
  const isCommissioner = !!session?.isAdmin;
  // Demo weeks are commissioner-only. Filter them out of the week list players see.
  const allWeeks=getWeeks().filter(w =>
    w.status!==WEEK_STATUS.DRAFT &&
    (w.dataSourceMode!=='demo' || isCommissioner)
  ).sort((a,b)=>b.weekNumber-a.weekNumber);
  const currentWeek=getCurrentWeek();
  const currentWeekVisible = currentWeek && (currentWeek.dataSourceMode !== 'demo' || isCommissioner);
  if(!currentWeekVisible && !allWeeks.length){c.innerHTML=emptyState('📊','No Weeks Yet','Commissioner needs to open a week.');return;}

  const displayWeekId=state.dashboardWeekId||(currentWeekVisible?currentWeek?.weekId:null)||allWeeks[0]?.weekId;
  const week=getWeek(displayWeekId)||(currentWeekVisible?currentWeek:null)||allWeeks[0];
  if(!week){c.innerHTML=emptyState('📊','No Week','');return;}
  // Safety: if a stale state.dashboardWeekId points at a demo week, snap back.
  if (week.dataSourceMode === 'demo' && !isCommissioner) {
    state.dashboardWeekId = allWeeks[0]?.weekId || null;
    return renderDashboardInner();
  }

  const eff = getEffectiveWeekStatus(week);
  const isPublic = eff === 'live' || eff === 'final';

  // Only gate on submission when the week is still open/locked (blind picks rule).
  // Live and final weeks are always visible — no login or submission required.
  if (!isPublic && session.playerId && session.playerVerified && !session.isAdmin) {
    if (!hasPlayerSubmitted(week.weekId, session.playerId)) {
      c.innerHTML=`<div class="empty-state"><div class="empty-state-icon">🔒</div>
        <h3>Submit Your Picks First</h3>
        <p class="text-secondary text-sm">Dashboard is hidden until you submit — keeps it blind.</p>
        <button class="btn btn-primary mt-md" id="go-picks-btn">Make My Picks</button></div>`;
      document.getElementById('go-picks-btn')?.addEventListener('click',()=>navigateTo('picks'));
      return;
    }
  }

  const players=getPlayers().filter(p=>p.active);
  const games=getGames(week.weekId).sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff));
  const allPicks=getPicks(week.weekId);
  const actualTB=week.actualTiebreakerValue;
  const weeklyResults=calculateWeeklyResults(week.weekId,players,allPicks,games,actualTB);
  const ps=getProviderState();

  const weekSelector=allWeeks.length>1?`<div class="form-group mb-md">
    <label class="form-label">Viewing Week</label>
    <select class="form-select" id="week-selector">
      ${allWeeks.map(w=>`<option value="${w.weekId}"${w.weekId===week.weekId?' selected':''}>${escHtml(formatWeekLabel(w))} — ${w.status}</option>`).join('')}
    </select>
  </div>`:'';

  c.innerHTML=`
    <div class="section-header"><h2>${escHtml(formatWeekLabel(week))}</h2>
      <div class="subtitle">Dashboard · <span class="badge badge-${week.status}">${week.status}</span></div>
    </div>
    ${weekSelector}
    <div class="refresh-bar">
      <span>${ps.lastScoreRefresh?`Scores: ${new Date(ps.lastScoreRefresh).toLocaleTimeString()}`:'Not refreshed'}</span>
      <button class="refresh-btn-mini" id="manual-refresh-btn">↻ Refresh</button>
    </div>

    <!-- 1. ALL PICKS BY GAME — primary section per requirements (DI-22) -->
    <div class="card mb-md">
      <div class="card-header card-header-row">
        <span class="card-title">📋 All Picks by Game</span>
        <div class="layout-toggle" role="group" aria-label="View density">
          <button class="layout-toggle-btn${(getSettings().dashboardLayout||'standard')==='standard'?' active':''}" data-layout="standard" title="Wide matrix">Standard</button>
          <button class="layout-toggle-btn${getSettings().dashboardLayout==='compact'?' active':''}" data-layout="compact" title="Mobile-friendly stacked view">Compact</button>
        </div>
      </div>
      ${(getSettings().dashboardLayout==='compact')
        ? `<div class="dashboard-compact">${renderDashboardCompact(players,games,allPicks,weeklyResults,week.weekId,actualTB)}</div>`
        : `<div class="dashboard-scroll">${renderDashboardTable(players,games,allPicks,weeklyResults,week.weekId,actualTB)}</div>`}
    </div>

    <!-- 2. ALMA MATER WATCH -->
    ${renderAlmaMaterWatch(week.weekId, games)}

    <!-- 3. THIS WEEK SCORE SUMMARY (tiebreaker question card now appears below this) -->
    <div class="card mb-md">
      <div class="card-header"><span class="card-title">This Week Score Summary</span></div>
      <table class="leaderboard-table">
        <thead><tr><th>#</th><th>Player</th><th>✅</th><th>❌</th><th>Tiebreaker</th></tr></thead>
        <tbody>
          ${weeklyResults.map(r=>{
            const name=getDisplayNamePlain(week.weekId,r.playerId,players);
            // Tiebreaker privacy: only reveal another player's guess once the viewer is allowed
            // to see all picks (week is live/final, OR viewer has submitted their own).
            const canSeeOthers = canViewOtherPicks(week, session.playerId);
            const isSelf = session.playerId === r.playerId;
            const submitted = r.tiebreakerGuess !== null && r.tiebreakerGuess !== undefined;
            let tbDisp;
            if (!submitted) {
              tbDisp = '—';                                      // hasn't submitted
            } else if (!canSeeOthers && !isSelf) {
              tbDisp = '<span class="tb-hidden" title="Visible once you submit your picks">***</span>'; // hidden from this viewer
            } else if (actualTB !== null) {
              tbDisp = `${r.tiebreakerGuess} (Δ${r.tiebreakerDelta})`;
            } else {
              tbDisp = String(r.tiebreakerGuess);
            }
            return`<tr class="${r.isWinner?'winner-row':r.isLoser?'loser-row':''}">
              <td class="rank-cell rank-${r.rank}">${r.rank}</td>
              <td class="player-name-cell">${escHtml(name)}${r.isWinner?' 🏆':r.isLoser?' 💀':''}${r.wonByTiebreaker?' <span class="text-xs text-muted">(TB)</span>':''}</td>
              <td class="result-win">${r.correctPicks}</td>
              <td class="result-loss">${r.incorrectPicks}</td>
              <td class="text-muted text-sm">${tbDisp}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <!-- 4. TIEBREAKER QUESTION (moved below summary per Priority 11) -->
    ${week.tiebreakerQuestion?`<div class="tiebreaker-card tiebreaker-dashboard">
      <span class="tiebreaker-label">🎯 Tiebreaker: ${escHtml(week.tiebreakerQuestion)}</span>
      ${actualTB!==null?`<div class="tb-actual">Actual: <strong>${actualTB}</strong></div>`:'<div class="text-muted text-xs">Actual answer not entered yet.</div>'}
    </div>`:''}
`;

  document.getElementById('week-selector')?.addEventListener('change',e=>{state.dashboardWeekId=e.target.value;renderDashboard();});
  // Standard / Compact view toggle for the All-Picks-by-Game card. Persists
  // in settings.dashboardLayout so a user's mobile preference sticks across reloads.
  document.querySelectorAll('.layout-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      saveSetting('dashboardLayout', btn.dataset.layout);
      renderDashboard();
    });
  });
  // Wire up reaction chips + "+" pickers in whichever view is rendered
  bindReactionHandlers(players); bindCommentBubbleHandlers();
  // Priority 7: column reorder (drag-and-drop) for both matrix and compact.
  bindColumnReorderHandlers();
  // UN-105a — edge-fade cue for the standard-layout .dashboard-scroll wrapper
  // (a no-op when compact layout is active, since there's nothing to find).
  initScrollFades(c);
  document.getElementById('manual-refresh-btn')?.addEventListener('click',async()=>{
    showToast('🔄 Refreshing…','warning');
    await doRefreshScores(week,games); renderDashboard();
  });
}

/**
 * Priority 7: drag-to-reorder player columns / chips.
 *
 * Implementation:
 *  - Desktop: native HTML5 drag-and-drop (`dragstart` / `dragover` / `drop`).
 *    The browser's drag image gives clear feedback; touch is unaffected.
 *  - Mobile / touch: HTML5 drag doesn't fire from touch on iOS Safari. We add
 *    a LONG-PRESS gate: 350ms of holding still on a chip enters "reorder mode"
 *    (small haptic-style scale animation), then subsequent finger movement
 *    drags. A simple finger swipe to scroll never crosses the 350ms threshold
 *    and so never triggers reorder. Releasing without crossing the threshold
 *    is a no-op (the chip's normal title-tooltip still fires).
 *
 * Persisted: settings.dashboardColumnOrder = [playerId, …]. Re-renders dashboard
 * after a successful reorder so the chips/cells fall into the new positions
 * everywhere consistently.
 */
function bindColumnReorderHandlers() {
  // Use ANY draggable element with data-player-id as a reorder target. Both
  // matrix headers (.player-col) and compact chips (.dc-chip) qualify.
  const draggables = document.querySelectorAll('[data-player-id][draggable="true"]');
  if (!draggables.length) return;

  // ─ Desktop drag-and-drop ─
  let dragSourceId = null;
  draggables.forEach(el => {
    if (el._dragWired) return; el._dragWired = true;

    el.addEventListener('dragstart', (e) => {
      dragSourceId = el.dataset.playerId;
      el.classList.add('col-dragging');
      // dataTransfer is required for Firefox to start a drag
      try { e.dataTransfer.setData('text/plain', dragSourceId); e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('col-dragging');
      document.querySelectorAll('.col-drop-target').forEach(n => n.classList.remove('col-drop-target'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.classList.add('col-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('col-drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('col-drop-target');
      const targetId = el.dataset.playerId;
      if (!dragSourceId || !targetId || dragSourceId === targetId) return;
      reorderPlayerColumn(dragSourceId, targetId);
    });
  });

  // ─ Touch (mobile) long-press → drag ─
  let touchSrc = null;        // playerId of long-pressed source
  let touchEl  = null;        // element being dragged
  let touchTimer = null;
  let touchStart = null;      // {x, y} screen coords of touchstart
  const LONG_PRESS_MS = 350;
  const SCROLL_THRESHOLD = 8; // pixels of pre-press movement that aborts the press

  draggables.forEach(el => {
    if (el._touchWired) return; el._touchWired = true;

    el.addEventListener('touchstart', (e) => {
      // Only respond to single-finger touches. Pinch-zoom etc. should be ignored.
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY };
      // Start the long-press timer. If the user moves before it fires, the
      // 'touchmove' handler cancels it — preserving normal scroll behaviour.
      touchTimer = setTimeout(() => {
        touchSrc = el.dataset.playerId;
        touchEl = el;
        el.classList.add('col-dragging');
        // Light haptic on supported devices to signal entry into reorder mode
        if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
      }, LONG_PRESS_MS);
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (!t) return;
      // If we haven't entered reorder mode yet, treat any meaningful movement
      // as a scroll intent — cancel the long-press timer so the page scrolls
      // normally.
      if (!touchSrc) {
        if (touchStart) {
          const dx = Math.abs(t.clientX - touchStart.x);
          const dy = Math.abs(t.clientY - touchStart.y);
          if (dx + dy > SCROLL_THRESHOLD) {
            clearTimeout(touchTimer);
            touchTimer = null;
            touchStart = null;
          }
        }
        return;
      }
      // We ARE in reorder mode. Highlight whichever draggable is currently
      // under the finger, and prevent scroll while dragging.
      e.preventDefault();
      const under = document.elementFromPoint(t.clientX, t.clientY);
      document.querySelectorAll('.col-drop-target').forEach(n => n.classList.remove('col-drop-target'));
      const target = under?.closest('[data-player-id]');
      if (target && target !== touchEl) target.classList.add('col-drop-target');
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      clearTimeout(touchTimer);
      touchTimer = null;
      if (!touchSrc) { touchStart = null; return; }
      // Find what we ended on
      const t = e.changedTouches[0];
      const under = t ? document.elementFromPoint(t.clientX, t.clientY) : null;
      const target = under?.closest('[data-player-id]');
      const targetId = target?.dataset.playerId;
      // Reset state
      touchEl?.classList.remove('col-dragging');
      document.querySelectorAll('.col-drop-target').forEach(n => n.classList.remove('col-drop-target'));
      const src = touchSrc;
      touchSrc = null; touchEl = null; touchStart = null;
      // Commit if dropped on a different player's element
      if (src && targetId && src !== targetId) reorderPlayerColumn(src, targetId);
    });

    el.addEventListener('touchcancel', () => {
      clearTimeout(touchTimer);
      touchTimer = null;
      touchEl?.classList.remove('col-dragging');
      document.querySelectorAll('.col-drop-target').forEach(n => n.classList.remove('col-drop-target'));
      touchSrc = null; touchEl = null; touchStart = null;
    });
  });
}

/** Move source player BEFORE target player in the saved column order, then re-render. */
function reorderPlayerColumn(sourceId, targetId) {
  // Build the current effective order (what the user sees) so the new order
  // matches their mental model.
  const session = getSession();
  const players = getPlayers().filter(p => p.active);
  const ordered = getOrderedPlayersForDashboard(players, session.playerId);
  const ids = ordered.map(p => p.playerId);
  const srcIdx = ids.indexOf(sourceId);
  const tgtIdx = ids.indexOf(targetId);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
  ids.splice(srcIdx, 1);
  ids.splice(tgtIdx, 0, sourceId);
  // The "viewer first" rule re-asserts on next render via
  // getOrderedPlayersForDashboard, so we don't need to special-case the viewer
  // here — saving the full ordering preserves the user's intent.
  setDashboardColumnOrder(ids);
  renderDashboard();
}

function renderDashboardTable(players,games,allPicks,weeklyResults,weekId,actualTB) {
  const session = getSession();
  const week    = getWeek(weekId);
  const eff     = getEffectiveWeekStatus(week);
  const isPublic = eff === 'live' || eff === 'final';

  // If not public, not admin, and player hasn't submitted — show prompt not data
  if (!isPublic && !session.isAdmin) {
    // v0.17.2 (Drew): surface the lock deadline here too — this prompt is where
    // a signed-out viewer lands, so it's the highest-leverage place to show what
    // they're about to miss. Contains no pick data; blind rule is unaffected.
    const countdown = renderLockCountdownHTML(week, games, { compact: true });
    if (!session.playerVerified) {
      return `<div class="text-center" style="padding:24px">
        ${countdown}
        <p class="text-muted text-sm mb-md">Log in and submit your picks to view the pick matrix.</p>
        <button class="btn btn-primary btn-sm" onclick="navigateTo('picks')">Go to Picks</button>
      </div>`;
    }
    if (!hasPlayerSubmitted(weekId, session.playerId)) {
      return `<div class="text-center" style="padding:24px">
        ${countdown}
        <p class="text-muted text-sm mb-md">Submit your picks first — keeps it blind until you're in.</p>
        <button class="btn btn-primary btn-sm" onclick="navigateTo('picks')">Submit My Picks</button>
      </div>`;
    }
  }

  const submittedRaw = players.filter(p=>allPicks.some(pk=>pk.playerId===p.playerId));
  if(!submittedRaw.length) return'<p class="text-muted text-center" style="padding:24px">No picks submitted yet.</p>';
  // Priority 7: reorder columns per the viewer's saved layout (their own column first)
  const submitted = getOrderedPlayersForDashboard(submittedRaw, session.playerId);

  const headers=submitted.map(p=>{
    const r=weeklyResults.find(r=>r.playerId===p.playerId);
    const name=getDisplayNamePlain(weekId,p.playerId,players);
    const w=r?.correctPicks??0, l=r?.incorrectPicks??0;
    // Show an explicit win-loss record. Hidden until at least one game decided,
    // so an all-pending week doesn't render a confusing "0-0" under every name.
    const decided=(r?.correctPicks||0)+(r?.incorrectPicks||0)+(r?.noDecisions||0);
    const recordLabel=decided>0?`<span class="pts-label">${w}–${l}</span>`:'';
    // data-player-id + draggable handle for Priority 7 reorder. The header
    // itself is the drag target so users have a clear affordance (the column
    // name). Hidden visual handle (≡) on hover makes it discoverable.
    return`<th class="player-col" data-player-id="${escHtml(p.playerId)}" draggable="true">
      <span class="col-drag-handle" aria-hidden="true">≡</span>
      <span class="player-col-name">${escHtml(name)}</span>${recordLabel}
    </th>`;
  }).join('');

  const rows=games.map(game=>{
    const sv=game.lockedSpread!==null?game.lockedSpread:game.spread;
    const spreadStr=sv!==null?fmtSpread(sv,game.favorite,game):(game.status===GAME_STATUS.FINAL?'Final':'TBD');
    const ats=game.status===GAME_STATUS.FINAL?(game.atsWinner??calculateAtsWinner(game)):null;
    const atsLabel=ats==='no_decision'?'No Decision':ats||'';

    // Priority 4: always show kickoff date+time, with a small state indicator
    // (LIVE pill / FINAL pill) appended when the game has progressed. Old code
    // showed *only* the score when live/final and hid the kickoff entirely —
    // users couldn't tell at a glance when a final game had actually kicked off.
    const kickoffStr = fmtTime(game.kickoff, game);
    let stateIndicator = '';
    if (game.status === GAME_STATUS.FINAL && game.homeScore !== null) {
      stateIndicator = `<span class="status-pill status-pill-final">FINAL ${game.homeScore}–${game.awayScore}</span>`;
    } else if (game.status === GAME_STATUS.LIVE && game.homeScore !== null) {
      stateIndicator = `<span class="live-pill" style="font-size:.66rem"><span class="live-dot"></span>LIVE ${game.homeScore}–${game.awayScore}</span>`;
    }
    const statusInfo = `<span class="kickoff-time">${escHtml(kickoffStr)}</span>${stateIndicator}`;

    const pickCells=submitted.map(player=>{
      const pick=allPicks.find(pk=>pk.gameId===game.gameId&&pk.playerId===player.playerId);
      if(!pick)return'<td class="pick-cell">—</td>';
      const result=evaluatePick(pick,game);
      // Picked team display (school only — matrix is tight, mascot adds noise here)
      const pickedSide = pick.selectedTeam === game.homeTeam ? 'home' : (pick.selectedTeam === game.awayTeam ? 'away' : null);
      const pickedDisplay = pickedSide ? teamSchool(game, pickedSide) : pick.selectedTeam;

      // LIVE: soft, pulsing covering/trailing tint — distinct from finalized boxes.
      if (result===PICK_RESULT.LIVE) {
        const ls = livePickStatus(pick, game);
        if (ls === 'covering')
          return `<td class="pick-cell pick-live pick-live-covering" title="Currently covering the spread"><span class="live-dot"></span>${escHtml(pickedDisplay)}<span class="live-arrow">▲</span></td>`;
        if (ls === 'trailing')
          return `<td class="pick-cell pick-live pick-live-trailing" title="Currently not covering the spread"><span class="live-dot"></span>${escHtml(pickedDisplay)}<span class="live-arrow">▽</span></td>`;
        if (ls === 'even')
          return `<td class="pick-cell pick-live pick-live-even" title="Exactly on the spread right now"><span class="live-dot"></span>${escHtml(pickedDisplay)}</td>`;
        // Live but no spread/score yet — neutral live tint, no direction
        return `<td class="pick-cell pick-live" title="Game in progress"><span class="live-dot"></span>${escHtml(pickedDisplay)}</td>`;
      }

      // FINALIZED / PENDING: solid boxes with ✓ / ✗ (unchanged visual language).
      const cls=getPickStatusClass(result);
      const icon={win:'✓',loss:'✗',no_decision:'—'}[result]||'';
      return`<td class="pick-cell ${cls}">${icon?`<span class="pick-icon">${icon}</span>`:''}${escHtml(pickedDisplay)}</td>`;
    }).join('');

    return`<tr>
      <td class="game-info-cell">
        <div class="game-info-matchup">${escHtml(matchupBare(game))} ${renderGameBadges(game)}</div>
        <div class="game-info-meta">
          <span class="spread-badge-sm">${spreadStr}</span>
          ${statusInfo}
          ${ats?`<span style="font-size:.68rem;color:var(--maroon)">ATS: ${escHtml(atsLabel)}</span>`:''}
          ${game.espnEventId
            ? `<a class="espn-link" href="https://www.espn.com/${game.isManual && game.espnSport ? escHtml(game.espnSport) : 'college-football'}/game/_/gameId/${encodeURIComponent(game.espnEventId)}" target="_blank" rel="noopener noreferrer" title="Open ESPN gamecast in a new tab">ESPN ↗</a>`
            : ''}
        </div>
        ${renderReactionStrip(weekId, game.gameId, players)}
        ${gameChatBubbleHTML(game.gameId)}
      </td>${pickCells}
    </tr>`;
  }).join('');

  return`<table class="dashboard-table">
    <thead><tr><th>Game / Spread</th>${headers}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ─── EMOJI REACTIONS ─────────────────────────────────────────────────────────
// Slack-style reactions on dashboard games. State lives in storage (auto-syncs
// in Sheets mode); UI is a small strip of chips per game with a "+" picker.
// Only logged-in players can react. Tapping the same emoji removes the vote.

// Reaction palette — item G (batch 3+4): moved to data-model.js as the ONE
// shared emoji source for the whole app (AD-20 extended). chat-ui.js's
// composer picker pulls from the SAME list, so the two surfaces can never
// drift apart the way TEAM_ABBR once did (RG-13). Do not reintroduce a local
// literal here — import REACTION_PALETTE from data-model.js instead.

/**
 * Render the reactions strip for one game. Returns a span with chips for each
 * emoji that has at least one vote, plus a "+" button to open the picker.
 * `players` is passed in so tooltips can name who reacted.
 */
function renderReactionStrip(weekId, gameId, players) {
  const reactions = getReactionsForGame(weekId, gameId);
  const session = getSession();
  const myPid = session?.playerId || null;
  const playerById = Object.fromEntries(players.map(p => [p.playerId, p.displayName]));

  const hasAny = Object.values(reactions).some(arr => arr?.length);

  const chips = Object.entries(reactions).map(([emoji, pids]) => {
    if (!pids?.length) return '';
    const names = pids.map(id => playerById[id] || '?').join(', ');
    const mine = myPid && pids.includes(myPid);
    return `<button type="button" class="reaction-chip${mine?' reaction-chip-mine':''}"
      data-week-id="${escHtml(weekId)}" data-game-id="${escHtml(gameId)}" data-emoji="${escHtml(emoji)}"
      title="${escHtml(names)}">
      <span class="reaction-chip-emoji">${emoji}</span>
      <span class="reaction-chip-count">${pids.length}</span>
    </button>`;
  }).join('');

  // Priority 5: when there are NO reactions on a game, the strip should not
  // take up vertical space. But a logged-in player still needs a way to start
  // one — so we render a single tiny "+" with the `reaction-strip-empty`
  // modifier (CSS shrinks it to zero margin-top and just a 16x16 button).
  // Anonymous viewers see nothing at all when empty.
  if (!hasAny) {
    if (!myPid) return ''; // truly empty for anonymous viewers
    return `<span class="reaction-strip reaction-strip-empty" data-reaction-strip="${escHtml(weekId)}::${escHtml(gameId)}">
      <button type="button" class="reaction-add-btn reaction-add-btn-mini" data-week-id="${escHtml(weekId)}" data-game-id="${escHtml(gameId)}" title="Add reaction">+</button>
    </span>`;
  }

  const addBtn = myPid
    ? `<button type="button" class="reaction-add-btn" data-week-id="${escHtml(weekId)}" data-game-id="${escHtml(gameId)}" title="Add reaction">+</button>`
    : '';

  return `<span class="reaction-strip" data-reaction-strip="${escHtml(weekId)}::${escHtml(gameId)}">${chips}${addBtn}</span>`;
}

/**
 * Re-renders just one game's reaction strip after a toggle, so we don't have
 * to redraw the whole dashboard. Looks up the strip by its data-reaction-strip
 * attribute and replaces its innerHTML.
 */
function refreshReactionStrip(weekId, gameId, players) {
  const sel = `[data-reaction-strip="${weekId}::${gameId}"]`;
  document.querySelectorAll(sel).forEach(node => {
    const fresh = renderReactionStrip(weekId, gameId, players);
    // Replace the whole element so its data-* attributes stay current.
    const tmp = document.createElement('div');
    tmp.innerHTML = fresh;
    if (tmp.firstElementChild) node.replaceWith(tmp.firstElementChild);
  });
  // Re-bind handlers for the (re-rendered) strip.
  bindReactionHandlers(players); bindCommentBubbleHandlers();
}

/**
 * Wires click handlers on every reaction chip + "+" picker on the page.
 * Idempotent — safe to call after every re-render. Picker uses a tiny inline
 * popover anchored to the "+" button.
 */
function bindReactionHandlers(players) {
  // Toggle vote on an existing emoji
  document.querySelectorAll('.reaction-chip').forEach(btn => {
    if (btn._wired) return; btn._wired = true;
    btn.addEventListener('click', () => {
      const session = getSession();
      if (!session?.playerId) { showToast('Log in as a player to react','warning'); return; }
      const { weekId, gameId, emoji } = btn.dataset;
      const after = toggleReaction(weekId, gameId, emoji, session.playerId);
      if (after.includes(session.playerId)) { try { sendGameReact(gameId, emoji, session.playerId); } catch {} }
      refreshReactionStrip(weekId, gameId, players);
    });
  });
  // Open the picker
  document.querySelectorAll('.reaction-add-btn').forEach(btn => {
    if (btn._wired) return; btn._wired = true;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close any other open pickers
      document.querySelectorAll('.reaction-picker').forEach(p => p.remove());
      const { weekId, gameId } = btn.dataset;
      const picker = document.createElement('div');
      picker.className = 'reaction-picker';
      picker.innerHTML = REACTION_PALETTE.map(em =>
        `<button type="button" class="reaction-pick-option" data-emoji="${em}" title="${em}">${em}</button>`
      ).join('');
      btn.parentElement.appendChild(picker);
      picker.querySelectorAll('.reaction-pick-option').forEach(opt => {
        opt.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const session = getSession();
          if (!session?.playerId) { showToast('Log in to react','warning'); picker.remove(); return; }
          const after = toggleReaction(weekId, gameId, opt.dataset.emoji, session.playerId);
          if (after.includes(session.playerId)) { try { sendGameReact(gameId, opt.dataset.emoji, session.playerId); } catch {} }
          picker.remove();
          refreshReactionStrip(weekId, gameId, players);
        });
      });
      // Click anywhere else closes the picker
      const closer = (ev) => { if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('click', closer); } };
      setTimeout(() => document.addEventListener('click', closer), 0);
    });
  });
}

// ─── PER-GAME COMMENTS ────────────────────────────────────────────────────────
// A small speech-bubble icon on each game row. Empty by default (outlined
// bubble, faded); when comments exist, filled bubble + count badge. Tap opens
// a lightweight modal thread. Both matrix and compact use the same renderer.

const COMMENT_MAX_LEN = 200; // MUST match storage.js — updating here won't help save

/**
 * Small speech-bubble icon for a game row. Non-obtrusive by default so it
 * doesn't compete with the pick matrix or spread/live colors. Rendered inline
 * so it can slot into existing meta rows without wrapping.
 */
function renderCommentBubble(weekId, game) {
  const count = getGameComments(game.gameId).length;
  const hasAny = count > 0;
  return `<button type="button" class="comment-bubble${hasAny?' has-comments':''}"
    data-comment-week="${escHtml(weekId)}" data-comment-game="${escHtml(game.gameId)}"
    title="${hasAny?`${count} comment${count>1?'s':''} on this game`:'Add a comment'}">
    <span class="cb-icon" aria-hidden="true">💬</span>
    ${hasAny?`<span class="cb-count">${count}</span>`:''}
  </button>`;
}

/**
 * Open the per-game comment thread modal. Renders a lightweight list of
 * existing comments + an input at the bottom for a new comment. Reuses the
 * modal-overlay pattern already in the app for consistency.
 */
function openCommentThreadModal(weekId, gameId) {
  const game = getGame(gameId);
  if (!game) return;
  const session = getSession();
  const players = getPlayers();
  const playerLookup = Object.fromEntries(players.map(p => [p.playerId, p]));

  const ov = document.createElement('div');
  ov.className = 'modal-overlay centered comment-modal-overlay';
  ov.setAttribute('data-comment-modal', gameId);

  const renderThread = () => {
    const comments = getGameComments(gameId);
    if (!comments.length) {
      return `<p class="text-muted text-sm text-center" style="padding:24px 8px">
        No comments yet. Say something ${session?.playerId ? '👇' : '(log in as a player first)'}.
      </p>`;
    }
    return comments.map(c => {
      const isBot = c.authorKind === 'bot';
      const author = isBot ? 'PickEms Bot' : (playerLookup[c.authorId]?.displayName || 'Unknown');
      const initials = isBot ? '🤖' : escHtml(getPlayerInitials(playerLookup[c.authorId] || { displayName: author }));
      const canDelete = !isBot && (session?.isAdmin || session?.playerId === c.authorId);
      const ts = new Date(c.createdAt);
      const timeStr = ts.toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      return `<div class="comment-item${isBot?' comment-item-bot':''}">
        <div class="comment-avatar">${initials}</div>
        <div class="comment-body">
          <div class="comment-head">
            <span class="comment-author">${escHtml(author)}${isBot?' <span class="bot-tag">BOT</span>':''}</span>
            <span class="comment-time">${escHtml(timeStr)}</span>
            ${canDelete?`<button class="comment-delete" data-comment-id="${escHtml(c.commentId)}" title="Delete">✕</button>`:''}
          </div>
          <div class="comment-text">${escHtml(c.body)}</div>
        </div>
      </div>`;
    }).join('');
  };

  ov.innerHTML = `<div class="modal comment-modal">
    <div class="modal-header">
      <h3>💬 ${escHtml(matchupBare(game))}</h3>
      <button class="modal-close" id="cm-close">✕</button>
    </div>
    <div class="comment-thread" id="cm-thread">${renderThread()}</div>
    ${session?.playerId ? `
      <div class="comment-input-row">
        <textarea class="form-input comment-input" id="cm-input" rows="2"
          maxlength="${COMMENT_MAX_LEN}"
          placeholder="Talk your talk (max ${COMMENT_MAX_LEN} chars)"></textarea>
        <button class="btn btn-primary" id="cm-post">Post</button>
      </div>
    ` : `
      <p class="text-muted text-xs text-center" style="padding:8px 0">
        Log in as a player from the Picks tab to comment.
      </p>
    `}
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#cm-close')?.addEventListener('click', () => ov.remove());
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });

  const refreshThread = () => {
    const t = ov.querySelector('#cm-thread');
    if (t) t.innerHTML = renderThread();
    bindThreadDeleteHandlers();
    // Also refresh the underlying bubble count on the dashboard so the caller
    // sees the new count without a full re-render.
    refreshCommentBubbles(gameId);
    // Auto-scroll to bottom
    if (t) t.scrollTop = t.scrollHeight;
  };

  const bindThreadDeleteHandlers = () => {
    ov.querySelectorAll('.comment-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Delete this comment?')) return;
        deleteComment(btn.dataset.commentId);
        refreshThread();
      });
    });
  };
  bindThreadDeleteHandlers();
  refreshThread(); // scroll to bottom on open

  ov.querySelector('#cm-post')?.addEventListener('click', () => {
    const input = ov.querySelector('#cm-input');
    if (!input) return;
    const body = input.value;
    const entry = addComment({
      weekId, gameId, authorId: session.playerId, authorKind: 'player', body,
    });
    if (!entry) { showToast('Enter something to post','warning'); return; }
    input.value = '';
    refreshThread();
  });
  ov.querySelector('#cm-input')?.addEventListener('keydown', e => {
    // Cmd/Ctrl+Enter posts
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      ov.querySelector('#cm-post')?.click();
    }
  });
}

/**
 * Re-render the bubble count for one game on every dashboard row/card without
 * touching the rest of the dashboard. Called after posting/deleting a comment.
 */
function refreshCommentBubbles(gameId) {
  const count = getGameComments(gameId).length;
  document.querySelectorAll(`.comment-bubble[data-comment-game="${gameId}"]`).forEach(el => {
    if (count > 0) {
      el.classList.add('has-comments');
      const existing = el.querySelector('.cb-count');
      if (existing) existing.textContent = count;
      else el.insertAdjacentHTML('beforeend', `<span class="cb-count">${count}</span>`);
      el.title = `${count} comment${count>1?'s':''} on this game`;
    } else {
      el.classList.remove('has-comments');
      el.querySelector('.cb-count')?.remove();
      el.title = 'Add a comment';
    }
  });
}

/** Wire click handlers on every rendered comment bubble. Idempotent. */
function bindCommentBubbleHandlers() {
  document.querySelectorAll('.comment-bubble').forEach(btn => {
    if (btn._commentWired) return; btn._commentWired = true;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const weekId = btn.dataset.commentWeek;
      const gameId = btn.dataset.commentGame;
      openCommentThreadModal(weekId, gameId);
    });
  });
}


/**
 * Compact alternative to the wide matrix above — optimized for narrow phone
 * screens. Each game is one stacked card; player picks are rendered as small
 * initial-chips so a 6-player league fits on one mobile row. Same data, same
 * status semantics (final win/loss boxes, pulsing live tints) — just denser.
 *
 * Decisions:
 *  - Player initials in chips (not full names) — every player fits on one row.
 *  - Game matchup is bare schools (Away @ Home), no mascot, same as matrix.
 *  - Live and final colour languages match the matrix exactly so users learn
 *    one visual system, not two.
 *  - Picked-team text under each chip uses a short form (last word of the
 *    school name) to keep the chip narrow but still readable.
 */
function renderDashboardCompact(players, games, allPicks, weeklyResults, weekId, actualTB) {
  const session = getSession();
  const picks = allPicks;
  const submittedRaw = players.filter(p => picks.some(pk => pk.playerId === p.playerId));
  // Priority 7: same reorder rule as the matrix — viewer's column (here a chip
  // position) is leftmost; rest follows the saved order.
  const submitted = getOrderedPlayersForDashboard(submittedRaw, session.playerId);
  if (!games.length) return '<div class="info-box">No games on the slate yet.</div>';

  // Pre-compute a unique abbreviation for every team appearing this week so
  // no two chips show identical text (Priority 6).
  const abbrMap = buildAbbrMap(games);
  const shortLabel = (name) => abbrMap.get(name) || (name || '').slice(0,4).toUpperCase();

  const sortedGames = [...games].sort((a,b) => new Date(a.kickoff||0) - new Date(b.kickoff||0));

  // Blinding rule (Priority 3): hide other players' chip contents from a viewer
  // who hasn't earned the right to see picks yet. The viewer ALWAYS sees their
  // own chip. Once the week is live/final, everything is visible to everyone.
  const week = getWeeks().find(w => w.weekId === weekId);
  const canSeeOthers = week ? canViewOtherPicks(week, session.playerId) : false;

  const gameCards = sortedGames.map(game => {
    const sv = game.lockedSpread !== null ? game.lockedSpread : game.spread;
    const spreadStr = sv !== null ? fmtSpread(sv, game.favorite, game) : (game.status === GAME_STATUS.FINAL ? 'Final' : 'TBD');
    // Priority 4: kickoff time + state indicator, same pattern as the matrix
    // so users see one consistent format across both views.
    const kickoffStr = fmtTime(game.kickoff, game);
    let stateIndicator = '';
    if (game.status === GAME_STATUS.FINAL && game.homeScore !== null) {
      stateIndicator = `<span class="dc-status dc-final">FINAL ${game.homeScore}–${game.awayScore}</span>`;
    } else if (game.status === GAME_STATUS.LIVE && game.homeScore !== null) {
      stateIndicator = `<span class="dc-status dc-live"><span class="live-dot"></span>${game.homeScore}–${game.awayScore}</span>`;
    }
    const statusInfo = `<span class="dc-status dc-scheduled">${escHtml(kickoffStr)}</span>${stateIndicator}`;

    const chips = submitted.map(player => {
      const pick = picks.find(pk => pk.gameId === game.gameId && pk.playerId === player.playerId);
      const initials = escHtml(getPlayerInitials(player));
      if (!pick) {
        return `<div class="dc-chip dc-chip-none" data-player-id="${escHtml(player.playerId)}" draggable="true" title="${escHtml(player.displayName)}: no pick"><span class="dc-chip-init">${initials}</span><span class="dc-chip-pick">—</span></div>`;
      }
      const isSelf = session.playerId === player.playerId;
      // Blinding: if the viewer can't see others' picks yet AND this isn't
      // their own pick, render an opaque "•••" chip. The chip still shows
      // initials so they can see WHO has submitted, just not WHAT they picked.
      if (!isSelf && !canSeeOthers) {
        return `<div class="dc-chip dc-chip-blind" data-player-id="${escHtml(player.playerId)}" draggable="true" title="${escHtml(player.displayName)}: hidden until you submit"><span class="dc-chip-init">${initials}</span><span class="dc-chip-pick">•••</span></div>`;
      }
      const result = evaluatePick(pick, game);
      const pickedSide = pick.selectedTeam === game.homeTeam ? 'home' : pick.selectedTeam === game.awayTeam ? 'away' : null;
      const pickShort = pickedSide ? shortLabel(teamSchool(game, pickedSide)) : shortLabel(pick.selectedTeam);
      let cls = 'dc-chip-pending';
      let icon = '';
      if (result === PICK_RESULT.LIVE) {
        const ls = livePickStatus(pick, game);
        if (ls === 'covering') { cls = 'dc-chip-live-covering'; icon = '▲'; }
        else if (ls === 'trailing') { cls = 'dc-chip-live-trailing'; icon = '▽'; }
        else { cls = 'dc-chip-live'; }
      } else if (result === PICK_RESULT.WIN) { cls = 'dc-chip-win'; icon = '✓'; }
      else if (result === PICK_RESULT.LOSS) { cls = 'dc-chip-loss'; icon = '✗'; }
      else if (result === PICK_RESULT.NO_DECISION) { cls = 'dc-chip-nd'; icon = '—'; }
      return `<div class="dc-chip ${cls}" data-player-id="${escHtml(player.playerId)}" draggable="true" title="${escHtml(player.displayName)} picked ${escHtml(pick.selectedTeam)}"><span class="dc-chip-init">${initials}</span><span class="dc-chip-pick">${escHtml(pickShort)}${icon?` ${icon}`:''}</span></div>`;
    }).join('');

    const espn = game.espnEventId
      ? ` · <a class="espn-link" href="https://www.espn.com/${game.isManual && game.espnSport ? escHtml(game.espnSport) : 'college-football'}/game/_/gameId/${encodeURIComponent(game.espnEventId)}" target="_blank" rel="noopener noreferrer">ESPN ↗</a>`
      : '';
    return `<div class="dc-game">
      <div class="dc-game-head">
        <div class="dc-matchup">${escHtml(matchupBare(game))} ${renderGameBadges(game)}</div>
        <div class="dc-meta"><span class="spread-badge-sm">${escHtml(spreadStr)}</span>${statusInfo}${espn}</div>
      </div>
      <div class="dc-chips">${chips}</div>
      ${renderReactionStrip(weekId, game.gameId, players)}
      ${gameChatBubbleHTML(game.gameId)}
    </div>`;
  }).join('');

  return gameCards;
}

// ─── LEADERBOARD / STANDINGS ──────────────────────────────────────────────────

function renderLeaderboard() {
  const c=document.getElementById('page-leaderboard'); if(!c)return;
  const players=getPlayers().filter(p=>p.active);
  // v0.17.0 — demo weeks never count toward standings, weekly history, or debts
  const visibleWeekIds=new Set(getWeeks().filter(w=>w.showInHistory!==false&&w.dataSourceMode!=='demo').map(w=>w.weekId));
  const allResults=getWeeklyResults().filter(r=>visibleWeekIds.has(r.weekId));
  const standings=calculateSeasonStandings(players,allResults);
  const weeks=getWeeks().filter(w=>w.status!==WEEK_STATUS.DRAFT&&w.dataSourceMode!=='demo').sort((a,b)=>a.weekNumber-b.weekNumber);
  const settings=getSettings();
  const obligations=getObligations();

  c.innerHTML=`
    <div class="section-header"><h2>Standings</h2><div class="subtitle">Season ${settings.season}</div></div>

    <div class="admin-section-title">Season Summary</div>
    <div class="dashboard-scroll mb-md">
      <table class="dashboard-table">
        <thead><tr><th>#</th><th>Player</th><th>✅ Correct</th><th>❌ Wrong</th><th>Win %</th><th>Wk W</th><th>Wk L</th></tr></thead>
        <tbody>
          ${standings.length?standings.map(s=>{
            return`<tr class="${s.isSeasonLeader?'winner-row':s.isCurrentLastPlace?'loser-row':''}">
              <td class="rank-cell rank-${s.currentRank}">${s.currentRank}</td>
              <td class="player-name-cell">${escHtml(s.displayName)}${s.isSeasonLeader?' 👑':s.isCurrentLastPlace?' 🤡':''}</td>
              <td class="result-win">${s.totalCorrect}</td>
              <td class="result-loss">${s.totalIncorrect}</td>
              <td>${s.winPct}%</td>
              <td>${s.weeklyWins}</td>
              <td>${s.weeklyLosses}</td>
            </tr>`;
          }).join('')
          :'<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">No finalized weeks yet.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="admin-section-title">⭐ Alma Mater Rankings</div>
    <div class="card mb-md">
      <p class="text-muted text-xs mb-sm">Rankings sourced from ESPN when available. Fetch ESPN data in the Commissioner panel to update.</p>
      ${renderAlmaMaterRankings()}
    </div>

    <div class="admin-section-title">Weekly History</div>
    ${weeks.length?`<div class="dashboard-scroll mb-md">
      <table class="dashboard-table">
        <thead><tr><th>Week</th><th>🏆 Winner</th><th>💀 Loser</th><th>Status</th></tr></thead>
        <tbody>
          ${weeks.map(w=>{
            const wRes=allResults.filter(r=>r.weekId===w.weekId).sort((a,b)=>b.correctPicks-a.correctPicks);
            const winner=wRes.find(r=>r.isWinner); const loser=wRes.find(r=>r.isLoser);
            const ob=obligations.find(o=>o.weekId===w.weekId);
            return`<tr>
              <td style="white-space:nowrap;font-size:.82rem">${escHtml(formatWeekLabel(w))}</td>
              <td class="player-name-cell">${winner?escHtml(winner.displayName):'—'}${winner?.wonByTiebreaker?' (TB)':''}</td>
              <td class="player-name-cell">${loser?escHtml(loser.displayName):'—'}</td>
              <td>
                ${ob ? obligationActionsHTML(ob.status, ob, getSession(), {
                    payerName: getPlayer(ob.payerPlayerId)?.displayName || '?',
                    recipientName: getPlayer(ob.recipientPlayerId)?.displayName || '?',
                    obClass: 'ob-action',
                  }) : '<span class="text-muted text-xs">—</span>'}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`:'<p class="text-muted text-sm mb-md">Weekly history appears after weeks are finalized.</p>'}

    ${renderSeason2025OutstandingSection()}
    ${renderSeason2025RecordSection()}
  `;

  bindSeason2025Sections(c);
  // UN-105a — edge-fade cue for both season-summary/weekly-history
  // .dashboard-scroll wrappers above AND the two nested inside the collapsed
  // 2025 season <details> (initScrollFades binds a 'toggle' listener on the
  // <details> itself, so those get measured once actually opened).
  initScrollFades(c);
  c.querySelectorAll('.ob-action-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      handleObligationAction(btn.dataset.obId, btn.dataset.obAction);
      renderLeaderboard();
    });
  });
}

function renderAlmaMaterRankings() {
  // Pull rankings from the most recent fetched games that include alma mater teams
  const allGames = getGames();
  const rows = ALMA_MATERS.map(alma => {
    const game = [...allGames].reverse().find(g =>
      getAlmaMaterMatch(g.homeTeam) === alma || getAlmaMaterMatch(g.awayTeam) === alma
    );
    let rank = null;
    if (game) {
      if (getAlmaMaterMatch(game.homeTeam) === alma) rank = game.homeRank;
      else rank = game.awayRank;
    }
    const rankStr = rank ? `<span class="rank-badge">#${rank} AP</span>` : '<span class="text-muted text-xs">Unranked</span>';
    const player  = getPlayers().find(p => p.almaMater === alma);
    const almaDisplay = ALMA_MATER_DISPLAY[alma] || alma;
    return `<div class="alma-rank-row">
      <span class="alma-rank-school">${escHtml(almaDisplay)}</span>
      <span class="alma-rank-player text-muted text-xs">${player ? escHtml(player.displayName) : ''}</span>
      <span class="alma-rank-value">${rankStr}</span>
    </div>`;
  });
  return rows.join('');
}

// ─── COMMISSIONER PAGE ────────────────────────────────────────────────────────

function renderCommPage() {
  const c=document.getElementById('page-commissioner'); if(!c)return;
  const session=getSession();
  if(!session.isAdmin){renderCommLogin(c);return;}

  // Build page in safe sections — any crash shows which section failed
  try {
    const week       = getCurrentWeek();
    const games      = week ? getGames(week.weekId) : [];
    const availGames = week ? getAvailableGames(week.weekId) : [];
    const players    = getPlayers();
    const settings   = getSettings();
    const allWeeks   = getWeeks().sort((a,b)=>b.weekNumber-a.weekNumber);
    const proof      = getFetchProof();
    const ps         = getProviderState();
    const suggestedRaw = availGames.length>0 ? scoreCandidateGames(availGames,week?.weekId||'',20) : [];
    // Drop any suggestions the Commissioner has dismissed for this week, then cap at 10.
    const suggested = week
      ? suggestedRaw.filter(g => !isSuggestionRejected(week.weekId, g)).slice(0,10)
      : suggestedRaw.slice(0,10);
    const rejectedCount = week ? getRejectedSuggestions(week.weekId).length : 0;

    const sections = [];

    sections.push(`<div class="section-header"><h2>Commissioner Panel</h2></div>`);

    // Tab bar — groups the 18 admin sections into 5 buckets so the panel
    // doesn't require infinite scrolling. The active tab is held in
    // state.commTab; CSS hides any .admin-section whose data-comm-tab
    // doesn't match the body's data-comm-active attribute.
    const tabs = [
      {key:'week',     label:'Week',     icon:'📅'},
      {key:'games',    label:'Games',    icon:'🏈'},
      {key:'players',  label:'Players',  icon:'👥'},
      {key:'settings', label:'Settings', icon:'⚙️'},
      {key:'data',     label:'Data',     icon:'☁️'},
    ];
    sections.push(`
      <div class="comm-tabbar" role="tablist">
        ${tabs.map(t => `
          <button type="button" class="comm-tab${state.commTab===t.key?' active':''}"
            data-comm-tab-btn="${t.key}" role="tab" aria-selected="${state.commTab===t.key}">
            <span class="comm-tab-icon">${t.icon}</span>
            <span class="comm-tab-label">${t.label}</span>
          </button>
        `).join('')}
      </div>`);

    // Week Manager
    sections.push(`
      <div class="admin-section" data-comm-tab="week">
        <div class="admin-section-title">📅 Week Manager</div>
        <div class="card">
          <div class="form-group">
            <label class="form-label">Active Week</label>
            <select class="form-select" id="active-week-selector">
              ${allWeeks.map(w=>`<option value="${w.weekId}"${w.weekId===week?.weekId?' selected':''}>
                ${escHtml(formatWeekLabel(w))} — ${w.status}${w.dataSourceMode==='demo'?' · DEMO':''}
              </option>`).join('')}
            </select>
          </div>
          <div class="flex gap-sm flex-wrap">
            <button class="btn btn-primary btn-sm" id="create-week-btn">➕ New Week</button>
            <button class="btn btn-ghost btn-sm" id="duplicate-week-btn">📋 Duplicate</button>
            ${week?`<button class="btn btn-danger btn-sm" id="delete-week-btn">🗑 Delete</button>`:''}
          </div>
        </div>
      </div>`);

    // Week Settings
    if (week) {
      sections.push(`
        <div class="admin-section" data-comm-tab="week">
          <div class="admin-section-title">Week Settings — ${escHtml(formatWeekLabel(week))}</div>
          <div class="card">
            ${week.dataSourceMode==='demo'?'<div class="warning-box mb-md">📋 This is the Demo Week with fictional games. Do not use for real picks.</div>':''}
            <div class="flex gap-sm flex-wrap mb-sm">${renderWeekStatusButtons(week)}</div>
            <div class="form-group">
              <label class="form-label">Data Source Mode</label>
              <select class="form-select" id="data-source-mode">
                <option value="espn_live"      ${week.dataSourceMode==='espn_live'?'selected':''}>📡 ESPN Live</option>
                <option value="espn_historical" ${week.dataSourceMode==='espn_historical'?'selected':''}>📅 ESPN Historical</option>
                <option value="manual"          ${week.dataSourceMode==='manual'?'selected':''}>✏️ Manual</option>
                <option value="demo"            ${week.dataSourceMode==='demo'?'selected':''}>📋 Demo</option>
              </select>
            </div>
            <div class="flex gap-sm flex-wrap mb-md">
              <div class="form-group" style="flex:1;min-width:120px;margin:0">
                <label class="form-label">Custom Round Label <span class="text-muted text-xs">(e.g. 1.1, 1A)</span></label>
                <input class="form-input" id="week-round-label" placeholder="e.g. 1.1" value="${escHtml(week.roundLabel||'')}" />
              </div>
              <div class="form-group" style="flex:1;min-width:80px;margin:0">
                <label class="form-label">ESPN Week # <span class="text-muted text-xs">(optional)</span></label>
                <input class="form-input" id="week-espn-num" type="number" placeholder="1" value="${escHtml(String(week.espnWeekNumber||''))}" />
              </div>
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" id="week-show-history" ${week.showInHistory!==false?'checked':''} />
                <span class="form-label" style="margin:0">Show in Standings / Weekly History</span>
              </label>
              <p class="text-muted text-xs mt-sm">Uncheck to hide demo/test weeks from standings.</p>
            </div>
            <div class="flex gap-sm flex-wrap mb-md">
              <div class="form-group" style="flex:1;min-width:120px;margin:0">
                <label class="form-label">Start Date</label>
                <input class="form-input" type="date" id="week-start" value="${week.startDate||''}" />
              </div>
              <div class="form-group" style="flex:1;min-width:120px;margin:0">
                <label class="form-label">End Date</label>
                <input class="form-input" type="date" id="week-end" value="${week.endDate||''}" />
              </div>
            </div>
            <div class="flex gap-sm flex-wrap mb-md">
              <div class="form-group" style="flex:1;min-width:180px;margin:0">
                <label class="form-label">Auto-Open At</label>
                <input class="form-input" type="datetime-local" id="picks-open-at"
                  value="${week.picksOpenAt?new Date(week.picksOpenAt).toISOString().slice(0,16):''}" />
              </div>
              <div class="form-group" style="flex:1;min-width:180px;margin:0">
                <label class="form-label">Auto-Lock At (override)
                  <span class="text-muted text-xs">— blank = auto-derive</span>
                </label>
                <input class="form-input" type="datetime-local" id="picks-lock-at"
                  value="${week.picksLockAt?new Date(week.picksLockAt).toISOString().slice(0,16):''}" />
              </div>
            </div>
            <!-- Auto-transition config: how long before first kickoff to lock,
                 and whether to auto-transition to LIVE/pending-FINAL. -->
            <div class="auto-transition-config">
              <div class="card-title mb-sm">🔄 Auto-Transitions</div>
              <div class="flex gap-sm flex-wrap mb-sm">
                <div class="form-group" style="flex:1;min-width:180px;margin:0">
                  <label class="form-label">Lock N minutes before first kickoff
                    <span class="text-muted text-xs">— default 30</span>
                  </label>
                  <input class="form-input" type="number" min="0" max="720"
                    id="auto-lock-offset" value="${getAutoLockOffsetMinutes(week)}" />
                </div>
              </div>
              <div class="form-group">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                  <input type="checkbox" id="auto-live-enabled" ${getAutoLiveEnabled(week)?'checked':''} />
                  <span class="form-label" style="margin:0">Auto-transition LOCKED → LIVE at first kickoff</span>
                </label>
              </div>
              <div class="form-group">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                  <input type="checkbox" id="auto-final-enabled" ${getAutoFinalizeEnabled(week)?'checked':''} />
                  <span class="form-label" style="margin:0">Prompt for finalization when all games are final</span>
                </label>
                <p class="text-muted text-xs mt-sm">Auto-finalize never happens without a commissioner click — it just shows a confirm prompt.</p>
              </div>
              ${(() => {
                const games = getGames(week.weekId);
                const lockAt = computeEffectiveLockAt(week, games);
                const liveAt = computeEffectiveLiveAt(week, games);
                if (!lockAt && !liveAt) return '<p class="text-muted text-xs">Effective times will show once games are on the slate.</p>';
                const tz = getTimezone();
                const fmt = (d) => d ? formatGameTime(d.toISOString(), tz) : '—';
                return `<div class="effective-times-preview">
                  <div><strong>Effective lock:</strong> ${escHtml(fmt(lockAt))}</div>
                  <div><strong>Effective live:</strong> ${escHtml(fmt(liveAt))}</div>
                </div>`;
              })()}
            </div>
            ${week.pendingFinalization ? `
              <div class="pending-final-banner">
                <div><strong>⏰ All games are final.</strong> Ready to close this week and lock standings?</div>
                <div class="flex gap-sm mt-sm">
                  <button class="btn btn-primary btn-sm" id="confirm-finalize-btn">✅ Confirm Finalization</button>
                  <button class="btn btn-ghost btn-sm" id="dismiss-pending-btn">Not yet</button>
                </div>
              </div>
            ` : ''}
            <button class="btn btn-primary btn-sm" id="save-week-settings-btn">Save Week Settings</button>
            <div class="form-group mt-md">
              <label class="form-label">Weekly Blurb</label>
              <textarea class="form-textarea" id="blurb-input">${escHtml(week.blurb||'')}</textarea>
              <button class="btn btn-secondary btn-sm mt-sm" id="save-blurb-btn">Save Blurb</button>
            </div>
          </div>
        </div>`);
    }

    // ESPN Fetch
    sections.push(`
      <div class="admin-section" data-comm-tab="games">
        <div class="admin-section-title">📡 ESPN Data Fetch</div>
        <div class="card">
          <p class="text-muted text-sm mb-md">Uses the Week start/end dates above. Set them first, then fetch.</p>
          <div class="api-url-box mb-md" id="api-url-box">
            <span class="api-url-label">ESPN URL:</span>
            <code class="api-url-code" id="api-url-display">Click Preview to generate</code>
            <div class="flex gap-sm mt-sm flex-wrap">
              <button class="btn btn-ghost btn-sm" id="preview-url-btn">🔍 Preview URL</button>
              <button class="btn btn-ghost btn-sm" id="copy-url-btn">📋 Copy</button>
              <button class="btn btn-ghost btn-sm" id="open-url-btn">🔗 Open in Tab</button>
            </div>
          </div>
          <div class="flex gap-sm flex-wrap">
            <button class="btn btn-primary btn-sm" id="fetch-espn-btn">📥 Fetch ESPN Data</button>
            <button class="btn btn-ghost btn-sm" id="load-hist-demo-btn">📅 Load Historical Demo Week</button>
          </div>
          ${ps.lastFetchTimestamp?`<p class="text-muted text-xs mt-sm">Last fetch: ${new Date(ps.lastFetchTimestamp).toLocaleString()} · ${ps.lastRawEventCount} events</p>`:''}
        </div>
      </div>`);

    // Data Proof
    sections.push(`
      <div class="admin-section" data-comm-tab="games">
        <div class="admin-section-title">🔍 Data Proof</div>
        <div class="card">${renderDataProofPanel(proof,ps,week,games)}</div>
      </div>`);

    // Priority 14: Weekly Summary email helper. Shows up once every game on
    // the slate is FINAL, so the Commissioner has a one-click way to wrap the
    // week. Hidden when there are no games yet, or when any game is still
    // scheduled/live (sending early would be misleading).
    if (week && games.length > 0 && games.every(g => g.status === GAME_STATUS.FINAL)) {
      const recipients = getPlayers().filter(p => p.active && p.email).length;
      const totalActive = getPlayers().filter(p => p.active).length;
      sections.push(`
        <div class="admin-section" data-comm-tab="week">
          <div class="admin-section-title">📤 Weekly Summary Email</div>
          <div class="card">
            <p class="text-secondary text-sm mb-sm">All games are final — you can send the week's recap to players.</p>
            <p class="text-muted text-xs mb-md">
              Email-on-file: <strong>${recipients}</strong> of ${totalActive} active players.
              ${recipients < totalActive ? '<br>Players without an email won\'t receive the recap — add emails in <em>Players, PINs & Contact</em>.' : ''}
            </p>
            <div class="flex gap-sm flex-wrap">
              <button class="btn btn-primary btn-sm" id="weekly-summary-preview-btn">👁 Preview</button>
              <button class="btn btn-secondary btn-sm" id="weekly-summary-send-btn" ${recipients===0?'disabled':''}>📤 Open in Mail Client</button>
            </div>
            <div id="weekly-summary-preview" class="weekly-summary-preview" style="display:none"></div>
          </div>
        </div>`);
    }

    // Available Games Pool
    if (availGames.length) {
      sections.push(`
        <div class="admin-section" data-comm-tab="games">
          <div class="admin-section-title">📋 Available Games (${availGames.length} from ESPN)</div>
          <div class="card mb-sm">
            <div class="flex gap-sm mb-md flex-wrap">
              <button class="btn btn-primary btn-sm" id="apply-suggested-btn">✅ Apply Suggested 10</button>
              <button class="btn btn-ghost btn-sm" id="clear-pool-btn">🗑 Clear Pool</button>
              ${rejectedCount>0?`<button class="btn btn-ghost btn-sm" id="restore-rejected-btn">↩ Restore ${rejectedCount} dismissed</button>`:''}
            </div>
            ${renderSuggestedSlatePreview(suggested,games,week)}
            <div class="card-title mb-sm mt-md">All Available Games</div>
            ${renderAvailFilterBar(availGames)}
            <div id="avail-groups-list">${renderAvailableGroups(availGames, games, week)}</div>
          </div>
        </div>`);
    }

    // Selected Slate
    sections.push(`
      <div class="admin-section" data-comm-tab="games">
        <div class="admin-section-title">🏈 Selected Slate (${games.length}/10 games)</div>
        <div class="flex gap-sm mb-md flex-wrap">
          <button class="btn btn-ghost btn-sm" id="add-manual-game-btn">➕ Add Manually</button>
          <button class="btn btn-ghost btn-sm" id="unlock-all-btn">🔓 Unlock All</button>
          ${games.length?`
            <button class="btn btn-secondary btn-sm" id="refresh-scores-btn">🔄 Refresh Scores</button>
            <button class="btn btn-secondary btn-sm" id="finalize-scoring-btn">✅ Calculate ATS</button>
            <button class="btn btn-danger btn-sm" id="clear-slate-btn">🗑 Clear All Slate Games</button>
          `:''}
        </div>
        <div id="admin-games-list">${renderAdminGamesList(games,week,getGameLockOverrides())}</div>
      </div>`);

    // ── EXPORT (expanded — multiple formats and scopes) ──
    sections.push(`
      <div class="admin-section" data-comm-tab="data">
        <div class="admin-section-title">📤 Export Data</div>
        <div class="card">
          <p class="text-muted text-xs mb-md">CSV format opens in Excel / Google Sheets. JSON format preserves full state for backup/restore.</p>
          <div class="card-title mb-sm">Current Week (${week?escHtml(formatWeekLabel(week)):'no active week'})</div>
          <div class="flex gap-sm mb-md flex-wrap">
            <button class="btn btn-secondary btn-sm" id="export-week-picks-csv-btn" ${week?'':'disabled'}>📋 Week Picks CSV</button>
            <button class="btn btn-secondary btn-sm" id="export-week-slate-csv-btn" ${week?'':'disabled'}>🏈 Week Slate CSV</button>
            <button class="btn btn-secondary btn-sm" id="export-week-results-csv-btn" ${week?'':'disabled'}>🏆 Week Results CSV</button>
            <button class="btn btn-secondary btn-sm" id="export-week-dashboard-csv-btn" ${week?'':'disabled'}>📊 Week Dashboard Matrix CSV</button>
            <button class="btn btn-secondary btn-sm" id="export-week-bundle-btn" ${week?'':'disabled'}>📦 Week Bundle (all of above)</button>
          </div>
          <div class="divider"></div>
          <div class="card-title mb-sm">League-wide</div>
          <div class="flex gap-sm mb-md flex-wrap">
            <button class="btn btn-secondary btn-sm" id="export-players-csv-btn">👥 Players CSV</button>
            <button class="btn btn-secondary btn-sm" id="export-standings-csv-btn">🏆 Season Standings CSV</button>
            <button class="btn btn-secondary btn-sm" id="export-weekly-results-csv-btn">📅 All Weekly Results CSV</button>
            <button class="btn btn-secondary btn-sm" id="export-obligations-csv-btn">💵 Obligations CSV</button>
          </div>
          <div class="divider"></div>
          <div class="card-title mb-sm">Full Backup</div>
          <div class="flex gap-sm flex-wrap">
            <button class="btn btn-primary btn-sm" id="export-full-json-btn">💾 Full Backup (JSON)</button>
            <button class="btn btn-secondary btn-sm" id="export-full-csv-bundle-btn">📦 Full CSV Bundle (all data)</button>
          </div>
          <p class="text-muted text-xs mt-sm">Full backup preserves every week, pick, result, and player. CSV bundle exports each table as its own download.</p>
        </div>
      </div>`);

    // Tiebreaker
    if (week) {
      sections.push(`
        <div class="admin-section" data-comm-tab="week">
          <div class="admin-section-title">🎯 Tiebreaker</div>
          <div class="card">
            <div class="form-group"><label class="form-label">Question</label>
              <input class="form-input" id="tb-question" value="${escHtml(week.tiebreakerQuestion||'')}" /></div>
            <div class="form-group"><label class="form-label">Actual Value</label>
              <div class="flex gap-sm">
                <input class="form-input" id="tb-actual" type="number" style="flex:1"
                  value="${week.actualTiebreakerValue!==null?week.actualTiebreakerValue:''}" placeholder="Enter actual…" />
                <button class="btn btn-secondary btn-sm" id="auto-calc-tb-btn">Auto-Calc</button>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="save-tb-btn">Save Tiebreaker</button>
            ${renderTiebreakerGuessesAdmin(week.weekId,players,week.actualTiebreakerValue)}
          </div>
        </div>`);
    }

    // Demo Simulation
    sections.push(`
      <div class="admin-section" data-comm-tab="week">
        <div class="admin-section-title">🎮 Demo Simulation</div>
        <div class="card">
          <p class="text-secondary text-sm mb-md">Simulate scheduled → live → final without real games.</p>
          ${games.length===0?'<div class="info-box">Add games to the slate first.</div>':`
            <div class="form-group">
              <label class="form-label">Quick edit a single game</label>
              <select class="form-select" id="demo-game-select">
                <option value="">— Choose a game —</option>
                ${games.map(g=>`<option value="${g.gameId}">${escHtml(matchup(g))} [${g.status}]</option>`).join('')}
              </select>
            </div>
            <div id="demo-game-controls" style="display:none">
              <div class="flex gap-sm flex-wrap mb-md">
                <button class="btn btn-secondary btn-sm" id="demo-set-live">▶️ Set Live</button>
                <button class="btn btn-secondary btn-sm" id="demo-set-final">✅ Set Final</button>
                <button class="btn btn-ghost btn-sm" id="demo-set-scheduled">↩ Reset Scheduled</button>
              </div>
              <div class="flex gap-sm mb-md">
                <div class="form-group" style="flex:1;margin:0">
                  <label class="form-label" id="demo-home-label">Home Score</label>
                  <input class="form-input" id="demo-home-score" type="number" min="0" value="0" />
                </div>
                <div class="form-group" style="flex:1;margin:0">
                  <label class="form-label" id="demo-away-label">Away Score</label>
                  <input class="form-input" id="demo-away-score" type="number" min="0" value="0" />
                </div>
                <button class="btn btn-primary btn-sm" style="align-self:flex-end" id="demo-update-score">Update</button>
              </div>
            </div>

            <div class="divider"></div>

            <!-- BATCH GRID — edit every game's score + status at once -->
            <div class="card-title mb-sm">⚡ Batch update all games</div>
            <p class="text-muted text-xs mb-sm">Set scores and statuses for every game, then apply in one click. Useful for setting up a whole-week demo scenario fast.</p>
            ${renderDemoBatchGrid(games)}
            <div class="flex gap-sm flex-wrap mt-md">
              <button class="btn btn-primary btn-sm" id="demo-batch-apply">💾 Apply All Changes</button>
              <button class="btn btn-secondary btn-sm" id="demo-batch-randomize">🎲 Randomize Scores</button>
            </div>

            <div class="divider"></div>
            <div class="flex gap-sm flex-wrap">
              <button class="btn btn-primary btn-sm" id="demo-finalize-all">🏁 Finalize All & Calculate</button>
              <button class="btn btn-ghost btn-sm" id="demo-reset-all-scheduled">↩ Reset All Scheduled</button>
            </div>`}
        </div>
      </div>`);

    // Nicknames
    if (week) {
      sections.push(`
        <div class="admin-section" data-comm-tab="players">
          <div class="admin-section-title">Weekly Nicknames</div>
          <div class="card">
            ${players.filter(p=>p.active).map(p=>{
              const nick=getNickname(week.weekId,p.playerId)||'';
              return`<div class="flex gap-sm mb-sm" style="align-items:center">
                <span class="font-display" style="min-width:80px;font-size:.9rem">${escHtml(p.displayName)}</span>
                <input class="form-input" style="flex:1" type="text" maxlength="40"
                  id="nick-${p.playerId}" placeholder='"the best"' value="${escHtml(nick)}" />
                <button class="btn btn-secondary btn-sm save-nick-btn" data-player-id="${p.playerId}" data-week-id="${week.weekId}">Save</button>
              </div>`;
            }).join('')}
          </div>
        </div>`);
    }

    // Players
    sections.push(`
      <div class="admin-section" data-comm-tab="players">
        <div class="admin-section-title">Players, PINs &amp; Contact</div>
        <div class="card">
          <p class="text-muted text-xs mb-md">PINs are hidden by default. Toggle 🙈 to reveal. Save an email per player to share PINs and league updates. Player PINs never appear anywhere outside this panel.</p>
          ${players.map(p=>{
            const pin = getPlayerPin(p.playerId);
            return `
            <div class="player-admin-row" data-player-row="${p.playerId}">
              <div class="player-admin-info">
                <span class="player-admin-avatar${!p.active?' inactive':''}">${escHtml(getPlayerInitials(p))}</span>
                <div>
                  <div class="font-display" style="font-size:.9rem">${escHtml(p.displayName)}${!p.active?' <em class="text-muted">(inactive)</em>':''}</div>
                  <div class="text-xs text-muted">${escHtml(p.almaMater||'No alma mater set')}</div>
                </div>
              </div>
              <div class="player-admin-controls">
                <div class="player-admin-field">
                  <label class="micro-label">PIN</label>
                  <div class="pin-field">
                    <input class="form-input pin-input" type="password" data-pin="${escHtml(pin)}" value="${escHtml(pin)}" readonly autocomplete="off" />
                    <button class="btn btn-ghost btn-sm pin-toggle-btn" data-player-id="${p.playerId}" title="Show/hide PIN">🙈</button>
                  </div>
                </div>
                <div class="player-admin-field">
                  <label class="micro-label">Email</label>
                  <input class="form-input email-input" type="email" data-player-id="${p.playerId}" value="${escHtml(p.email||'')}" placeholder="player@email.com" />
                </div>
                <div class="player-admin-field player-admin-actions">
                  <button class="btn btn-secondary btn-sm save-email-btn" data-player-id="${p.playerId}" title="Save email">💾</button>
                  <button class="btn btn-secondary btn-sm share-pin-btn" data-player-id="${p.playerId}" title="Share PIN via email" ${p.email?'':'disabled'}>✉ Share PIN</button>
                  <button class="btn btn-ghost btn-sm edit-player-btn" data-player-id="${p.playerId}">Edit</button>
                  <button class="btn btn-ghost btn-sm reset-pin-btn" data-player-id="${p.playerId}" data-name="${escHtml(p.displayName)}">Reset PIN</button>
                  <button class="btn ${p.active?'btn-danger':'btn-secondary'} btn-sm toggle-player-btn" data-player-id="${p.playerId}">${p.active?'Deactivate':'Activate'}</button>
                </div>
              </div>
            </div>`;
          }).join('')}

          <div class="divider"></div>
          <div class="flex gap-sm">
            <input class="form-input" id="admin-new-player" type="text" placeholder="New player name…" style="flex:1" />
            <button class="btn btn-secondary btn-sm" id="admin-add-player-btn">Add</button>
          </div>

          <div class="divider"></div>
          <div class="card-title mb-sm">📣 Broadcast to League</div>
          <p class="text-muted text-xs mb-sm">Sends one email to every active player who has an email on file. Opens your mail client with everyone in BCC (their addresses stay private).</p>
          <div class="form-group">
            <label class="form-label">Subject</label>
            <input class="form-input" id="bcast-subject" type="text" placeholder="Week 5 picks are open" value="CFB Pickems update" />
          </div>
          <div class="form-group">
            <label class="form-label">Message</label>
            <textarea class="form-input" id="bcast-body" rows="4" placeholder="Hey all, picks for this week are open and lock Friday at 6pm. Site: …"></textarea>
          </div>
          <button class="btn btn-primary btn-sm" id="bcast-send-btn">✉ Open in Mail Client</button>
        </div>
      </div>`);

    // Obligations (v0.17.0: manual add/delete + the 2K25 carryover ledger)
    sections.push(`
      <div class="admin-section" data-comm-tab="players">
        <div class="admin-section-title">Obligations</div>
        <div class="card mb-md">${renderObligationsAdmin()}
          <div class="divider"></div>
          <div class="form-group"><label class="form-label" style="font-size:.7rem">Add an obligation manually</label>
            <div class="flex gap-sm flex-wrap" style="align-items:flex-end">
              <select class="form-select" id="ob-add-payer" style="width:auto">${players.map(p=>`<option value="${p.playerId}">${escHtml(p.displayName)}</option>`).join('')}</select>
              <span class="text-muted text-xs">owes</span>
              <select class="form-select" id="ob-add-recipient" style="width:auto">${players.map(p=>`<option value="${p.playerId}">${escHtml(p.displayName)}</option>`).join('')}</select>
              <input class="form-input" id="ob-add-note" placeholder="what & why (e.g. 1 drink — side bet)" style="flex:1;min-width:160px" />
              <button class="btn btn-primary btn-sm" id="ob-add-btn">Add</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="flex" style="justify-content:space-between;align-items:baseline">
            <strong style="font-size:.85rem">🍺 2K25 carryover ledger</strong>
            <span class="text-muted text-xs">14 weekly drinks + 1 bonus, all unpaid — from the audited season report</span>
          </div>
          ${renderSeason2025ObligationsAdmin()}
        </div>
      </div>`);

    // Auto-refresh
    sections.push(`
      <div class="admin-section" data-comm-tab="settings">
        <div class="admin-section-title">⏱ Auto-Refresh</div>
        <div class="card">
          <div class="form-group">
            <label class="form-label">Score Refresh Interval</label>
            <select class="form-select" id="auto-refresh-select">
              <option value="0"   ${(settings.autoRefreshInterval||60)===0?'selected':''}>Off</option>
              <option value="30"  ${settings.autoRefreshInterval===30?'selected':''}>30 seconds</option>
              <option value="60"  ${(settings.autoRefreshInterval||60)===60?'selected':''}>60 seconds</option>
              <option value="300" ${settings.autoRefreshInterval===300?'selected':''}>5 minutes</option>
            </select>
          </div>
          <button class="btn btn-secondary btn-sm" id="save-refresh-btn">Save</button>
        </div>
      </div>`);

    // Randomize Picks shortcut (UN-107) — default OFF (CONVENTIONS #10:
    // existing settings blobs lack this field and must read as false, not
    // truthy-by-accident). Same toggle-card pattern as Chat & S.C.R.I.B.E.
    // above: title, checkbox row, state-dependent copy underneath.
    sections.push(`
      <div class="admin-section" data-comm-tab="settings">
        <div class="card" id="comm-randomize-card">
          <h3 style="color:var(--maroon)">🎲 Randomize Picks Shortcut</h3>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--border)">
            <input type="checkbox" id="randomize-enabled-toggle" ${settings.randomizePicksEnabled ? 'checked' : ''} />
            <span class="form-label" style="margin:0">Allow players to randomize their picks</span>
          </label>
          <p class="text-muted text-xs">${settings.randomizePicksEnabled
            ? 'Players see a 🎲 Randomize My Picks shortcut on the Picks page.'
            : 'The randomize shortcut is hidden. Players make every pick by hand.'}</p>
        </div>
      </div>`);

    // Rules
    sections.push(`
      <div class="admin-section" data-comm-tab="settings">
        <div class="admin-section-title">League Rules</div>
        <div class="card">
          <textarea class="form-textarea" id="rules-editor" style="min-height:180px;font-size:.8rem;font-family:monospace">${getRulesEditorText()}</textarea>
          <div class="flex gap-sm mt-sm">
            <button class="btn btn-primary btn-sm" id="save-rules-btn">Save Rules</button>
            <button class="btn btn-ghost btn-sm" id="reset-rules-btn">Reset Default</button>
          </div>
        </div>
      </div>`);

    // ── Cloud Sync (shared backend) ──
    const beCfg = getBackendConfig() || { url:'', token:'' };
    const beMode = getBackendMode();
    const beReady = isBackendReady();
    const syncStatus = getSyncStatus();
    // Friendly "12 seconds ago" formatter
    const syncAgo = (iso) => {
      if (!iso) return 'never';
      const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 5) return 'just now';
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s/60)}m ago`;
      if (s < 86400) return `${Math.floor(s/3600)}h ago`;
      return new Date(iso).toLocaleString();
    };
    sections.push(`
      <div class="admin-section" data-comm-tab="data">
        <div class="admin-section-title">☁️ Cloud Sync (Google Sheets)</div>
        <div class="card">
          <p class="text-secondary text-sm mb-sm">
            Connect a Google Sheet so all players share the same data across devices.
            Status: <strong>${beMode==='googleSheets'&&beReady?'✅ Connected':beMode==='googleSheets'?'⚠️ Configured, not connected':'⚪ Local only (this device)'}</strong>
          </p>

          ${beMode==='googleSheets'&&beReady ? `
          <div class="sync-status-panel">
            <div class="card-title mb-sm">What syncs &amp; when</div>
            <ul class="sync-explainer">
              <li><strong>Every write auto-syncs.</strong> Player pick submissions, commissioner edits to games/spreads/scores, results calculations, reset operations — all push to the Sheet automatically within ~1 second.</li>
              <li><strong>Reads</strong> use a local in-memory mirror seeded from the Sheet at startup, so the app stays fast and works briefly offline. Pull manually (below) to refresh from a teammate's recent edit.</li>
              <li><strong>Device-local</strong> (does NOT sync, by design): your login session, the site-PIN unlock state, and the Sheet URL/token on this device.</li>
              <li><strong>If a sync fails</strong> (network drop, Sheet quota hit) the change is queued in the local cache and retries on the next write. The status badge at the top shows ⚠️ when this happens.</li>
              <li><strong>Manual exports</strong> (Export Data section) still work and are recommended as periodic offline backups in addition to auto-sync.</li>
            </ul>
            <div class="sync-stats">
              <div><span class="micro-label">Last successful sync</span><strong>${syncAgo(syncStatus.lastSyncAt)}</strong></div>
              <div><span class="micro-label">Pending writes</span><strong>${syncStatus.pendingWrites}</strong></div>
              <div><span class="micro-label">Last error</span><strong>${syncStatus.lastError ? escHtml(syncStatus.lastError) : '—'}</strong></div>
            </div>
            <div class="flex gap-sm mt-sm flex-wrap">
              <button class="btn btn-ghost btn-sm" id="be-flush-now-btn">⚡ Flush pending now</button>
              <button class="btn btn-ghost btn-sm" id="be-pull-now-btn">⬇️ Pull latest from Sheet</button>
            </div>
          </div>
          ` : ''}

          <div class="form-group">
            <label class="form-label">Web App URL <span class="text-muted text-xs">(ends in /exec)</span></label>
            <input class="form-input" id="be-url" placeholder="https://script.google.com/macros/s/…/exec" value="${escHtml(beCfg.url||'')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Access Token</label>
            <input class="form-input" id="be-token" type="password" placeholder="from Apps Script setup" value="${escHtml(beCfg.token||'')}" />
          </div>
          <div class="flex gap-sm flex-wrap mb-md">
            <button class="btn btn-secondary btn-sm" id="be-test-btn">🔌 Test Connection</button>
            <button class="btn btn-primary btn-sm" id="be-save-btn">💾 Save & Connect</button>
            <button class="btn btn-ghost btn-sm" id="be-disconnect-btn">Disconnect</button>
          </div>
          <div class="divider"></div>
          <p class="text-muted text-xs mb-sm">First-time setup: push THIS device's data up to seed an empty Sheet, or pull the Sheet's data down to this device.</p>
          <div class="flex gap-sm flex-wrap mb-md">
            <button class="btn btn-secondary btn-sm" id="be-seed-btn">⬆️ Push local data to Sheet (seed)</button>
            <button class="btn btn-secondary btn-sm" id="be-pull-btn">⬇️ Pull Sheet data to this device</button>
          </div>
          <div class="divider"></div>
          <p class="text-muted text-xs mb-sm">Season backups (snapshots) live in the Sheet and can be restored.</p>
          <div class="flex gap-sm flex-wrap mb-sm">
            <button class="btn btn-secondary btn-sm" id="be-snapshot-btn">📸 Create Snapshot</button>
            <button class="btn btn-ghost btn-sm" id="be-list-snapshots-btn">📜 List Snapshots</button>
          </div>
          <div id="be-snapshots-list" class="text-xs text-muted"></div>
        </div>
      </div>`);

    // ── Security & Settings (password change, site PIN) ──
    sections.push(`
      <div class="admin-section" data-comm-tab="settings">
        <div class="admin-section-title">🔐 Security &amp; Settings</div>
        <div class="card">
          <div class="card-title mb-sm">Commissioner Password</div>
          <p class="text-muted text-xs mb-sm">Used to access this Commissioner panel and authorize full resets.</p>
          <div class="form-group">
            <label class="form-label">Current password</label>
            <input class="form-input" id="sec-pw-current" type="password" autocomplete="current-password" />
          </div>
          <div class="form-group">
            <label class="form-label">New password</label>
            <input class="form-input" id="sec-pw-new" type="password" autocomplete="new-password" />
          </div>
          <div class="form-group">
            <label class="form-label">Confirm new password</label>
            <input class="form-input" id="sec-pw-confirm" type="password" autocomplete="new-password" />
          </div>
          <button class="btn btn-primary btn-sm" id="sec-change-pw-btn">🔑 Change Password</button>

          <div class="divider"></div>
          <div class="card-title mb-sm">Site PIN (front-door gate)</div>
          <p class="text-muted text-xs mb-sm">The PIN required to open the app. Current: <strong class="font-display">${escHtml(getEffectiveSitePin())}</strong>. Players will need the new PIN on their next visit (existing unlocked devices stay unlocked).</p>
          <div class="form-group">
            <label class="form-label">New site PIN</label>
            <input class="form-input" id="sec-site-pin-new" type="text" inputmode="numeric" maxlength="12" placeholder="4–12 characters" />
          </div>
          <div class="form-group">
            <label class="form-label">Confirm new site PIN</label>
            <input class="form-input" id="sec-site-pin-confirm" type="text" inputmode="numeric" maxlength="12" />
          </div>
          <button class="btn btn-primary btn-sm" id="sec-change-site-pin-btn">🚪 Change Site PIN</button>

          <div class="divider"></div>
          <div class="card-title mb-sm">Welcome Screen Text</div>
          <p class="text-muted text-xs mb-sm">Shown above the PIN entry on the front gate. Title renders as two lines (small "welcome to" eyebrow + larger league name).</p>
          <div class="form-group">
            <label class="form-label">Title — top line</label>
            <input class="form-input" id="sec-welcome-title-top" type="text" maxlength="40" placeholder="welcome to" value="${escHtml(settings.welcomeTitleTop||'')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Title — main line</label>
            <input class="form-input" id="sec-welcome-title-main" type="text" maxlength="60" placeholder="irb pick 'ems" value="${escHtml(settings.welcomeTitleMain||'')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Welcome subtitle</label>
            <input class="form-input" id="sec-welcome-subtitle" type="text" maxlength="80" placeholder="enter access pin" value="${escHtml(settings.welcomeSubtitle||'')}" />
          </div>
          <button class="btn btn-primary btn-sm" id="sec-save-welcome-btn">💾 Save Welcome Text</button>

          <div class="divider"></div>
          <div class="card-title mb-sm">Commissioner Contact Email</div>
          <p class="text-muted text-xs mb-sm">Used by the Feedback form on the Rules tab and by the Weekly Summary helper. Leave blank to disable mailto-based features.</p>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" id="sec-comm-email" type="email" placeholder="commissioner@example.com" value="${escHtml(settings.commissionerEmail||'')}" />
          </div>
          <button class="btn btn-primary btn-sm" id="sec-save-comm-email-btn">💾 Save Email</button>
        </div>
      </div>`);

    // Data management
    sections.push(`
      <div class="admin-section" data-comm-tab="data">
        <div class="admin-section-title">⚙️ Data Management</div>
        <div class="card">
          <div class="form-group">
            <p class="text-muted text-xs mb-sm">Clears games, picks, and results for the selected week only.</p>
            <button class="btn btn-secondary btn-sm" id="reset-week-btn">🗑 Clear Current Week Data</button>
          </div>
          <div class="divider"></div>
          <div class="form-group">
            <p class="text-muted text-xs mb-sm">Full reset requires Commissioner password. Deletes ALL data.</p>
            <div class="flex gap-sm flex-wrap">
              <button class="btn btn-danger btn-sm" id="reset-demo-btn">⚠️ Full Factory Reset</button>
              <button class="btn btn-ghost btn-sm" id="logout-comm-btn">🚪 Logout Commissioner</button>
            </div>
          </div>
        </div>
      </div>`);

    // Chat retention (UN-88) — directly below Data Management, same tab (RG-10).
    sections.push(`
      <div class="admin-section" data-comm-tab="data">
        <div class="admin-section-title">🙈 Chat Retention</div>
        <div class="card">${renderChatRetentionAdmin()}</div>
      </div>`);

    c.innerHTML = sections.join('\n');
    // Tab visibility lives on the panel container as a data attribute so a
    // single CSS rule handles show/hide for all 18 sections at once.
    c.setAttribute('data-comm-active', state.commTab);
    c.querySelectorAll('.comm-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        state.commTab = btn.dataset.commTabBtn;
        // Don't re-render the whole panel — just flip the active flag and
        // re-flag the buttons. Cheaper and avoids losing form-field focus.
        c.setAttribute('data-comm-active', state.commTab);
        c.querySelectorAll('.comm-tab').forEach(b => {
          const active = b.dataset.commTabBtn === state.commTab;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', active);
        });
        // UN-105a — the batch-grid-scroll (Demo Simulation, Week tab) was
        // display:none (0×0) if the panel opened on a different tab; a tab
        // switch doesn't rebuild the DOM, so re-measure now that it may have
        // just become visible.
        initScrollFades(c);
        // Scroll the panel to the top so users see the first section of the
        // new tab rather than a mid-scroll fragment.
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    wireCollapsibleSections(c);
    bindCommEventListeners(week, games, availGames, suggested, settings, allWeeks);
    renderCommExtrasV16(week, games);   // v0.16.0 — Extra Point + Chat/SCRIBE admin
    initScrollFades(c);   // UN-105a — batch-grid-scroll wrapper (Demo Simulation)

  } catch(err) {
    console.error('[renderCommPage] crash:', err);
    c.innerHTML = `<div class="card" style="margin-top:20px">
      <h3 style="color:var(--loss)">⚠️ Commissioner Panel Error</h3>
      <p class="text-secondary text-sm mt-sm">${escHtml(err.message)}</p>
      <pre style="font-size:.75rem;margin-top:12px;overflow:auto">${escHtml(err.stack||'')}</pre>
      <button class="btn btn-ghost btn-sm mt-md" onclick="window.location.reload()">Reload App</button>
    </div>`;
  }
}


// ─── SLATE UI COMPONENTS ──────────────────────────────────────────────────────

function renderDemoBatchGrid(games) {
  if (!games.length) return '';
  const sorted = [...games].sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff));
  const rows = sorted.map(g => {
    const hs = g.homeScore ?? '';
    const as_ = g.awayScore ?? '';
    const statusOpts = ['scheduled','live','final'].map(s =>
      `<option value="${s}"${g.status===s?' selected':''}>${s}</option>`).join('');
    return `<tr data-game-id="${g.gameId}">
      <td class="batch-matchup">${escHtml(matchup(g))}</td>
      <td><input class="form-input batch-home-score" type="number" min="0" inputmode="numeric" value="${hs}" placeholder="—" aria-label="Home score" /></td>
      <td><input class="form-input batch-away-score" type="number" min="0" inputmode="numeric" value="${as_}" placeholder="—" aria-label="Away score" /></td>
      <td><select class="form-select batch-status" aria-label="Status">${statusOpts}</select></td>
    </tr>`;
  }).join('');
  return `<div class="batch-grid-scroll">
    <table class="batch-grid">
      <thead><tr><th>Game</th><th>Home</th><th>Away</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderSuggestedSlatePreview(suggested, currentSlate, week) {
  if (!suggested.length) return '';
  return `<div class="suggested-slate-box">
    <div class="card-title mb-sm">⭐ Suggested 10-Game Slate <span class="text-muted text-xs">(✕ to dismiss a suggestion)</span></div>
    ${suggested.map((game, i) => {
      const onSlate = currentSlate.some(g => g.homeTeam===game.homeTeam&&g.awayTeam===game.awayTeam);
      const spreadStr = game.spread!==null ? fmtSpread(game.spread,game.favorite,game) : 'TBD';
      const sKey = suggestionKeyOf(game);
      return `<div class="suggested-game-row${onSlate?' on-slate':''}">
        <span class="suggested-num">${i+1}</span>
        <span class="suggested-matchup">${escHtml(matchup(game))}</span>
        <span class="suggested-spread text-muted text-xs">${spreadStr}</span>
        <span class="suggested-time text-muted text-xs">${fmtTime(game.kickoff,game)}</span>
        <div class="flex gap-sm flex-center">
          ${(game.suggestionReasons||[]).map(r=>`<span class="candidate-reason">${r}</span>`).join('')}
          ${onSlate
            ? `<span class="badge badge-open">✓ On Slate</span>`
            : `<button class="btn btn-primary btn-sm add-suggested-btn" data-idx="${i}">+ Add</button>`}
          ${onSlate
            ? ''
            : `<button class="btn btn-ghost btn-sm reject-suggested-btn" data-key="${escHtml(sKey)}" data-idx="${i}" title="Dismiss this suggestion">✕</button>`}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// ─── AVAILABLE GAMES — filtering + grouping ──────────────────────────────────
// Lets the Commissioner whittle a big ESPN-pulled list down by date, day,
// conference, region, ranking, alma-mater involvement, or free-text search,
// and group what's left into collapsible buckets.

// Conference → region (approximate; legacy + Power 5 + G5). Unknown conferences
// fall into "Other". This is good enough for "show me southern games".
const CONFERENCE_REGION = {
  'SEC':'South','ACC':'South','Sun Belt':'South','Conference USA':'South','American':'South',
  'Big 12':'Central','Big Ten':'Midwest','MAC':'Midwest',
  'Pac-12':'West','Mountain West':'West','Big Sky':'West','MWC':'West',
  'Ivy League':'Northeast','Patriot League':'Northeast','CAA':'Northeast',
};
function conferenceRegion(conf) {
  if (!conf) return 'Other';
  return CONFERENCE_REGION[conf] || 'Other';
}

function dayOfWeekOf(iso) {
  if (!iso) return 'Unknown date';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  } catch { return 'Unknown date'; }
}

function shortDateOf(iso) {
  if (!iso) return 'Date TBD';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  } catch { return 'Date TBD'; }
}

/**
 * Apply state.availFilter to a list of available games, returning a list of
 * { groupLabel, games[] } buckets (single bucket "All" when groupBy === 'none').
 */
function filterAndGroupAvailableGames(availGames) {
  const f = state.availFilter;
  const search = (f.search || '').trim().toLowerCase();

  let list = availGames.filter(g => {
    // Conference (matches either side)
    if (f.conference && g.homeConference !== f.conference && g.awayConference !== f.conference) return false;
    // Rank
    if (f.rank === 'ranked'   && !g.homeRank && !g.awayRank) return false;
    if (f.rank === 'unranked' && (g.homeRank || g.awayRank)) return false;
    // Alma mater only
    if (f.almaOnly && !g.isAlmaMaterGame) return false;
    // Free-text search (school names, mascots, conferences)
    if (search) {
      const hay = [g.homeTeam, g.awayTeam, g.homeMascot, g.awayMascot, g.homeConference, g.awayConference]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // Group
  const groups = new Map();
  const keyOf = (g) => {
    switch (f.groupBy) {
      case 'date':       return shortDateOf(g.kickoff);
      case 'day':        return dayOfWeekOf(g.kickoff);
      case 'conference': {
        // When the API didn't surface a conference, group those games together
        // under an honest label rather than the alarming "Unknown".
        const parts = [g.homeConference, g.awayConference].filter(Boolean);
        return parts.length ? parts.join(' / ') : 'Conference not listed';
      }
      case 'region':     return conferenceRegion(g.homeConference) || 'Other';
      case 'rank':       return (g.homeRank || g.awayRank) ? 'Ranked' : 'Unranked';
      default:           return 'All';
    }
  };
  for (const g of list) {
    const k = keyOf(g);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  }
  // Stable sort within each group by kickoff
  for (const arr of groups.values()) {
    arr.sort((a,b) => new Date(a.kickoff||0) - new Date(b.kickoff||0));
  }
  // Sort groups: by date if grouping by date/day, else alpha with "Other"/"Unknown" last
  const entries = [...groups.entries()];
  if (f.groupBy === 'date') {
    entries.sort((a,b) => new Date(a[1][0]?.kickoff||0) - new Date(b[1][0]?.kickoff||0));
  } else {
    entries.sort((a,b) => {
      const aLast = /other|unknown/i.test(a[0]) ? 1 : 0;
      const bLast = /other|unknown/i.test(b[0]) ? 1 : 0;
      if (aLast !== bLast) return aLast - bLast;
      return a[0].localeCompare(b[0]);
    });
  }
  return { buckets: entries, total: list.length, totalUnfiltered: availGames.length };
}

function renderAvailFilterBar(availGames) {
  const f = state.availFilter;
  // Build conference options from what's actually in the pool — sorted, deduped.
  const confs = [...new Set(
    availGames.flatMap(g => [g.homeConference, g.awayConference]).filter(Boolean)
  )].sort();

  return `<div class="avail-filter-bar">
    <div class="avail-filter-row">
      <input class="form-input avail-search" id="avail-search" type="search" placeholder="🔎 Search team, conference, mascot…" value="${escHtml(f.search)}" />
    </div>
    <div class="avail-filter-row">
      <label class="avail-filter-label">Group by
        <select class="form-select" id="avail-group">
          <option value="date"${f.groupBy==='date'?' selected':''}>Date</option>
          <option value="day"${f.groupBy==='day'?' selected':''}>Day of week</option>
          <option value="conference"${f.groupBy==='conference'?' selected':''}>Conference</option>
          <option value="region"${f.groupBy==='region'?' selected':''}>Region</option>
          <option value="rank"${f.groupBy==='rank'?' selected':''}>Ranking</option>
          <option value="none"${f.groupBy==='none'?' selected':''}>No grouping</option>
        </select>
      </label>
      <label class="avail-filter-label">Conference
        <select class="form-select" id="avail-conf">
          <option value="">Any</option>
          ${confs.map(c => `<option value="${escHtml(c)}"${f.conference===c?' selected':''}>${escHtml(c)}</option>`).join('')}
        </select>
      </label>
      <label class="avail-filter-label">Ranking
        <select class="form-select" id="avail-rank">
          <option value="any"${f.rank==='any'?' selected':''}>Any</option>
          <option value="ranked"${f.rank==='ranked'?' selected':''}>Ranked teams only</option>
          <option value="unranked"${f.rank==='unranked'?' selected':''}>Unranked only</option>
        </select>
      </label>
      <label class="avail-chip-label">
        <input type="checkbox" id="avail-alma-only" ${f.almaOnly?'checked':''} />
        ⭐ Alma mater games only
      </label>
      <button class="btn btn-ghost btn-sm" id="avail-reset-filters">Reset filters</button>
    </div>
  </div>`;
}

function renderAvailableGroups(availGames, currentSlate, week) {
  const { buckets, total, totalUnfiltered } = filterAndGroupAvailableGames(availGames);
  if (!buckets.length) {
    return `<div class="info-box">No games match the current filters. <button class="btn btn-ghost btn-sm" id="avail-reset-filters-inline">Reset filters</button></div>`;
  }
  const countLine = `<div class="text-muted text-xs mb-sm">Showing <strong>${total}</strong> of ${totalUnfiltered} games${total!==totalUnfiltered?' (filtered)':''}.</div>`;
  // When grouping is 'none' just render one flat list (skip the header chrome).
  if (state.availFilter.groupBy === 'none' && buckets.length === 1) {
    return countLine + renderAvailableGamesList(buckets[0][1], currentSlate, week);
  }
  return countLine + buckets.map(([label, games]) =>
    `<details class="avail-group" open>
      <summary class="avail-group-header"><span>${escHtml(label)}</span><span class="text-muted text-xs">${games.length} game${games.length>1?'s':''}</span></summary>
      <div class="avail-group-body">${renderAvailableGamesList(games, currentSlate, week)}</div>
    </details>`
  ).join('');
}

/**
 * (Re-)binds the +Add / ✕Remove buttons inside the available-games groups.
 * Called both on initial render and after any partial re-render triggered by
 * filter changes, so we don't lose handlers when innerHTML is replaced.
 */
function bindAvailGroupHandlers(week, currentSlate) {
  if (!week) return;
  document.querySelectorAll('.add-avail-game-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      try {
        const data = JSON.parse(btn.dataset.game);
        saveGame(createGame(week.weekId, data));
        showToast(`✅ ${formatTeamName(data.homeTeam, data.homeMascot)} vs ${formatTeamName(data.awayTeam, data.awayMascot)} added`, 'success');
        renderCommPage();
      } catch (e) { showToast('❌ Error adding game', 'error'); }
    });
  });
  document.querySelectorAll('.avail-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const gid = btn.dataset.gameId;
      if (!gid) { showToast('Could not match slate game', 'error'); return; }
      const g = getGame(gid);
      const pickCount = countPicksForGame(gid);
      const label = g ? `${td(g,'home')} vs ${td(g,'away')}` : 'this game';
      let msg = `Remove ${label} from the slate?`;
      if (pickCount > 0) msg += `\n\n⚠️ ${pickCount} submitted pick${pickCount>1?'s':''} will be deleted.`;
      if (!confirm(msg)) return;
      deleteGame(gid);
      showToast('Removed from slate', 'warning'); renderCommPage();
    });
  });
}

function renderAvailableGamesList(availGames, currentSlate, week) {
  return availGames.map(game => {
    const onSlate = currentSlate.some(g => g.espnEventId&&g.espnEventId===game.espnEventId || (g.homeTeam===game.homeTeam&&g.awayTeam===game.awayTeam));
    const spreadStr = game.spread!==null ? `${fmtSpread(game.spread,game.favorite,game)} ${game.spreadSource==='espn'?'(ESPN)':'(Manual)'}` : '⚠️ TBD';
    const payload = JSON.stringify({
      homeTeam:game.homeTeam, awayTeam:game.awayTeam,
      homeMascot:game.homeMascot||'', awayMascot:game.awayMascot||'',
      homeRank:game.homeRank, awayRank:game.awayRank,
      homeConference:game.homeConference, awayConference:game.awayConference,
      kickoff:game.kickoff, timeWindow:game.timeWindow,
      spread:game.spread, favorite:game.favorite,
      spreadSource:game.spreadSource||null, oddsProvider:game.oddsProvider||null,
      espnEventId:game.espnEventId, isAlmaMaterGame:game.isAlmaMaterGame,
      homeScore:game.homeScore, awayScore:game.awayScore,
      status:game.status, actualWinner:game.actualWinner,
      dataQuality:game.dataQuality||'partial',
      dataSource:week?.dataSourceMode||'espn_historical',
      venue:game.venue||null, neutralSite:game.neutralSite||false,
      lastUpdated:new Date().toISOString(),
    });
    // If on slate, find the matching slate game so we can offer a one-click remove.
    const slateMatch = currentSlate.find(g => (g.espnEventId&&game.espnEventId&&g.espnEventId===game.espnEventId) || (g.homeTeam===game.homeTeam&&g.awayTeam===game.awayTeam));
    return `<div class="game-admin-card" style="${onSlate?'opacity:.65':''}">
      <div class="game-admin-header">
        <div class="game-admin-matchup">
          ${game.awayRank?`#${game.awayRank} `:''}${escHtml(td(game,'away'))}
          <span class="text-muted"> ${game.neutralSite?'vs':'@'} </span>
          ${game.homeRank?`#${game.homeRank} `:''}${escHtml(td(game,'home'))}${game.neutralSite?'':' <span class="home-badge">H</span>'}
          ${game.isAlmaMaterGame?'<span class="alma-mater-badge ml-sm">⭐</span>':''}
        </div>
        ${onSlate
          ? `<div class="flex gap-sm flex-center">
               <span class="badge badge-open">✓ On Slate</span>
               <button class="btn btn-danger btn-sm avail-remove-btn" data-game-id="${slateMatch?slateMatch.gameId:''}" title="Remove from slate">✕ Remove</button>
             </div>`
          : `<button class="btn btn-primary btn-sm add-avail-game-btn" data-game='${payload.replace(/'/g,"&#39;")}'>+ Add</button>`}
      </div>
      <div class="game-admin-meta">
        <span>${fmtTime(game.kickoff, game)}</span>
        <span style="color:${game.spread!==null?'inherit':'var(--text-muted)'}">${spreadStr}</span>
        ${(() => { const loc = formatVenueDisplay(game); return loc ? `<span class="text-muted text-xs">📍 ${escHtml(loc)}${game.neutralSite?' 🌍':''}</span>` : ''; })()}
        ${game.espnEventId?`<code style="font-size:.65rem;color:var(--text-muted)">ESPN:${game.espnEventId}</code>`:''}
      </div>
    </div>`;
  }).join('');
}

function renderAdminGamesList(games, week, overrides) {
  if (!games.length) return `<div class="info-box">No games on the slate. Fetch ESPN data and add games above, or add manually.</div>`;
  return games.sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff)).map(game => {
    const mu = overrides[game.gameId]==='unlocked';
    const sv = game.lockedSpread!==null?game.lockedSpread:game.spread;
    const spreadStr = sv!==null
      ? fmtSpread(sv,game.favorite,game)
      : (game.status===GAME_STATUS.FINAL ? 'Final' : 'TBD');
    const readiness = gameDataReadiness(game);
    const readyBanner = readiness.level==='ok' ? '' :
      `<div class="game-readiness game-readiness-${readiness.level}">
        ${readiness.level==='incomplete'?'⛔ Incomplete — hidden from players':'⚠️ Pending confirmation'}:
        ${readiness.issues.map(escHtml).join(' · ')}
      </div>`;
    return `<div class="game-admin-card${readiness.level!=='ok'?' game-admin-card-'+readiness.level:''}">
      ${readyBanner}
      <div class="game-admin-header">
        <div class="game-admin-matchup">
          ${game.awayRank?`#${game.awayRank} `:''}${escHtml(td(game,'away'))}
          <span class="text-muted"> ${game.neutralSite?'vs':'@'} </span>
          ${game.homeRank?`#${game.homeRank} `:''}${escHtml(td(game,'home'))}${game.neutralSite?'':' <span class="home-badge">H</span>'}
          ${game.isAlmaMaterGame?'<span class="alma-mater-badge">⭐</span>':''}
          ${renderSourceBadge(game)}
        </div>
        <div class="flex gap-sm">
          <button class="btn btn-ghost btn-sm edit-game-btn" data-game-id="${game.gameId}">Edit</button>
          <button class="btn btn-ghost btn-sm lock-toggle-btn" data-game-id="${game.gameId}" data-unlocked="${mu}">${mu?'🔒 Lock':'🔓 Unlock'}</button>
          <button class="btn btn-danger btn-sm remove-game-btn" data-game-id="${game.gameId}">✕</button>
        </div>
      </div>
      <div class="game-admin-meta">
        <span>${fmtTime(game.kickoff, game)}</span>
        <span>Spread: <strong style="color:${sv!==null?'inherit':'var(--text-muted)'}">${spreadStr}</strong>
          <em class="text-muted text-xs">${game.spreadSource==='espn'?'ESPN':'Manual'}</em></span>
        <span class="badge badge-${game.status}">${game.status}</span>
        ${game.status===GAME_STATUS.FINAL&&game.homeScore!==null?`<span>FINAL ${game.homeScore}–${game.awayScore}</span>`:''}
        ${game.espnEventId?`<code style="font-size:.65rem">ESPN:${game.espnEventId}</code>`:''}
        ${mu?'<span class="badge badge-open">🔓 Unlocked</span>':''}
      </div>
    </div>`;
  }).join('');
}

// ─── COLLAPSIBLE COMMISSIONER SECTIONS ───────────────────────────────────────
// Each .admin-section title becomes a click-to-collapse header; open/closed
// state persists in settings.commPanelSectionsCollapsed keyed by a stable slug
// derived from the title. A "Sections" menu pinned at top of the panel toggles
// visibility of any section (lets the commissioner hide noise entirely).

function sectionSlug(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function wireCollapsibleSections(container) {
  const sections = [...container.querySelectorAll('.admin-section')];
  if (!sections.length) return;
  const settings = getSettings();
  const collapsed = settings.commPanelSectionsCollapsed || {};
  const hidden    = settings.commPanelSectionsHidden    || {};

  // Build a compact "Sections" menu at the BOTTOM of the Commissioner panel
  // (secondary controls — primary workflow stays at the top). Collapsed by
  // default so it's out of the way until needed.
  if (!container.querySelector('.section-menu')) {
    const menuEl = document.createElement('div');
    menuEl.className = 'admin-section section-menu admin-section-collapsed';
    menuEl.dataset.section = '_section_menu';
    menuEl.dataset.sectionTitle = 'Sections';
    menuEl.innerHTML = `
      <div class="admin-section-title admin-section-title-toggle section-menu-title">📚 Sections
        <span class="section-menu-actions">
          <button class="btn btn-ghost btn-sm" id="sec-expand-all">Expand all</button>
          <button class="btn btn-ghost btn-sm" id="sec-collapse-all">Collapse all</button>
          <button class="btn btn-ghost btn-sm" id="sec-show-all">Show all</button>
        </span>
        <span class="section-chevron">▾</span>
      </div>
      <div class="section-menu-grid" id="section-menu-grid"></div>`;
    container.appendChild(menuEl);
    // Click the title (but not the buttons) to expand/collapse the menu itself
    menuEl.querySelector('.admin-section-title-toggle')?.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      menuEl.classList.toggle('admin-section-collapsed');
    });
  }

  // Wrap each section's body so we can collapse it without losing event bindings.
  sections.forEach((sec) => {
    if (sec.classList.contains('section-menu')) return;
    const titleEl = sec.querySelector('.admin-section-title');
    if (!titleEl) return;
    // Use textContent for the slug to avoid HTML/emoji noise variance.
    const title = titleEl.textContent.trim();
    const slug  = sectionSlug(title);
    sec.dataset.section = slug;
    sec.dataset.sectionTitle = title;

    // Hidden takes precedence — fully remove from view.
    if (hidden[slug]) { sec.style.display = 'none'; }

    // Collapse marker
    if (collapsed[slug]) sec.classList.add('admin-section-collapsed');
    titleEl.classList.add('admin-section-title-toggle');
    // A small chevron so it's obviously a toggle
    if (!titleEl.querySelector('.section-chevron')) {
      const chev = document.createElement('span');
      chev.className = 'section-chevron';
      chev.textContent = '▾';
      titleEl.appendChild(chev);
    }
    // Click anywhere on title to toggle collapse
    titleEl.addEventListener('click', (e) => {
      // Don't collapse when clicking the chevron-area buttons inside the menu
      if (e.target.closest('button')) return;
      sec.classList.toggle('admin-section-collapsed');
      const c = getSettings().commPanelSectionsCollapsed || {};
      c[slug] = sec.classList.contains('admin-section-collapsed');
      saveSetting('commPanelSectionsCollapsed', c);
    });
  });

  // Render the menu grid (show/hide checkboxes)
  const grid = container.querySelector('#section-menu-grid');
  if (grid) {
    grid.innerHTML = sections
      .filter(s => !s.classList.contains('section-menu'))
      .map(s => {
        const slug = s.dataset.section;
        const title = s.dataset.sectionTitle;
        const isHidden = !!hidden[slug];
        return `<label class="section-menu-item${isHidden?' is-hidden':''}">
          <input type="checkbox" class="section-toggle" data-slug="${escHtml(slug)}" ${isHidden?'':'checked'} />
          <span>${escHtml(title)}</span>
        </label>`;
      }).join('');
    grid.querySelectorAll('.section-toggle').forEach(cb => {
      cb.addEventListener('change', () => {
        const slug = cb.dataset.slug;
        const sec  = container.querySelector(`.admin-section[data-section="${slug}"]`);
        if (!sec) return;
        const h = getSettings().commPanelSectionsHidden || {};
        if (cb.checked) { sec.style.display = ''; delete h[slug]; }
        else            { sec.style.display = 'none'; h[slug] = true; }
        saveSetting('commPanelSectionsHidden', h);
        cb.parentElement.classList.toggle('is-hidden', !cb.checked);
      });
    });
  }

  // Expand / Collapse / Show-all shortcuts
  container.querySelector('#sec-expand-all')?.addEventListener('click', () => {
    sections.forEach(s => s.classList.remove('admin-section-collapsed'));
    saveSetting('commPanelSectionsCollapsed', {});
  });
  container.querySelector('#sec-collapse-all')?.addEventListener('click', () => {
    const c = {};
    sections.forEach(s => {
      if (s.classList.contains('section-menu')) return;
      s.classList.add('admin-section-collapsed');
      c[s.dataset.section] = true;
    });
    saveSetting('commPanelSectionsCollapsed', c);
  });
  container.querySelector('#sec-show-all')?.addEventListener('click', () => {
    sections.forEach(s => { s.style.display = ''; });
    saveSetting('commPanelSectionsHidden', {});
    grid?.querySelectorAll('.section-toggle').forEach(cb => { cb.checked = true; cb.parentElement.classList.remove('is-hidden'); });
  });
}

// ─── COMMISSIONER EVENT LISTENERS ─────────────────────────────────────────────

function bindCommEventListeners(week, games, availGames, suggested, settings, allWeeks) {

  // Week manager
  document.getElementById('active-week-selector')?.addEventListener('change', e => {
    setActiveWeekId(e.target.value); refreshHeader(); renderCommPage();
  });
  document.getElementById('create-week-btn')?.addEventListener('click', ()=>showCreateWeekModal());
  document.getElementById('duplicate-week-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    const newW={...week,weekId:`w_${Date.now()}`,weekNumber:week.weekNumber+1,
      label:`Week ${week.weekNumber+1}`,status:'draft',lockedAt:null,finalizedAt:null,
      actualTiebreakerValue:null,tiebreakerFinalized:false,blurb:'',recap:'',
      picksOpenAt:null,picksLockAt:null,
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    };
    saveWeek(newW); setActiveWeekId(newW.weekId);
    showToast(`✅ Week ${newW.weekNumber} created`,'success'); renderCommPage();
  });
  document.getElementById('delete-week-btn')?.addEventListener('click', ()=>{
    if(!week||!confirm(`Delete "${formatWeekLabel(week)}"?`))return;
    deleteWeek(week.weekId);
    const remaining=getWeeks();
    if(remaining.length)setActiveWeekId(remaining[0].weekId);
    showToast('Week deleted','warning'); refreshHeader(); renderCommPage();
  });

  // Week status buttons
  document.querySelectorAll('.week-status-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const to=btn.dataset.to; if(!week)return;
      const upd={...week,status:to};
      if(to==='locked'){getGames(week.weekId).forEach(g=>saveGame({...g,lockedSpread:g.spread}));upd.lockedAt=new Date().toISOString();}
      if(to==='final'){upd.finalizedAt=new Date().toISOString();finalizeWeek(week);}
      saveWeek(upd); refreshHeader(); showToast(`Week: ${to}`,'success'); renderCommPage();
    });
  });

  // Week settings save
  document.getElementById('save-week-settings-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    const mode=document.getElementById('data-source-mode')?.value||week.dataSourceMode;
    const startDate=document.getElementById('week-start')?.value||'';
    const endDate=document.getElementById('week-end')?.value||'';
    const openRaw=document.getElementById('picks-open-at')?.value;
    const lockRaw=document.getElementById('picks-lock-at')?.value;
    const roundLabel=document.getElementById('week-round-label')?.value.trim()||'';
    const espnWeekNumber=document.getElementById('week-espn-num')?.value.trim()||'';
    const showInHistory=document.getElementById('week-show-history')?.checked!==false;
    // Auto-transition config
    const autoLockOffsetRaw = parseInt(document.getElementById('auto-lock-offset')?.value);
    const autoLockOffsetMinutes = Number.isFinite(autoLockOffsetRaw) && autoLockOffsetRaw >= 0 ? autoLockOffsetRaw : 30;
    const autoLiveEnabled = document.getElementById('auto-live-enabled')?.checked !== false;
    const autoFinalizeEnabled = document.getElementById('auto-final-enabled')?.checked !== false;
    saveWeek({...week,dataSourceMode:mode,startDate,endDate,roundLabel,espnWeekNumber,showInHistory,
      picksOpenAt:openRaw?new Date(openRaw).toISOString():null,
      picksLockAt:lockRaw?new Date(lockRaw).toISOString():null,
      autoLockOffsetMinutes, autoLiveEnabled, autoFinalizeEnabled,
    });
    refreshHeader(); showToast('Week settings saved ✅','success'); renderCommPage();
  });

  // Pending-finalization prompt handlers (auto-transition ready → commissioner confirms)
  document.getElementById('confirm-finalize-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    const upd = { ...week, status: WEEK_STATUS.FINAL, finalizedAt: new Date().toISOString(), pendingFinalization: false };
    saveWeek(upd);
    finalizeWeek(week);
    refreshHeader();
    showToast('Week finalized — standings locked ✅','success');
    renderCommPage();
  });
  document.getElementById('dismiss-pending-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    saveWeek({ ...week, pendingFinalization: false });
    renderCommPage();
  });
  document.getElementById('save-blurb-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    saveWeek({...week,blurb:document.getElementById('blurb-input')?.value||''});
    showToast('Blurb saved','success');
  });

  // ESPN URL preview
  const getUrlParams = ()=>({
    dates: (week?.startDate||'').replace(/-/g,''),
    season: week?.season||new Date().getFullYear(),
  });
  const buildUrl = ()=>buildEspnUrl(getUrlParams());
  document.getElementById('preview-url-btn')?.addEventListener('click', ()=>{
    const el=document.getElementById('api-url-display'); if(el)el.textContent=buildUrl();
  });
  document.getElementById('copy-url-btn')?.addEventListener('click', ()=>{
    navigator.clipboard.writeText(buildUrl()).then(()=>showToast('URL copied!','success')).catch(()=>showToast('Copy failed','error'));
  });
  document.getElementById('open-url-btn')?.addEventListener('click', ()=>window.open(buildUrl(),'_blank'));

  // ESPN Fetch — uses week start/end date as the source of truth
  document.getElementById('fetch-espn-btn')?.addEventListener('click', async()=>{
    if(!week){showToast('Select a week first','error');return;}
    const startDate=week.startDate||document.getElementById('week-start')?.value||'';
    const endDate=week.endDate||document.getElementById('week-end')?.value||'';
    if(!startDate){showToast('Set a Start Date for the week first, then fetch','error');return;}
    const rangeLabel = endDate && endDate!==startDate ? `${startDate} to ${endDate}` : startDate;
    showToast(`⏳ Fetching ESPN games for ${rangeLabel}…`,'warning');
    // Pass season for context only — dates are source of truth
    const result=await fetchByDateRange({startDate,endDate:endDate||startDate,season:week.season});
    state.lastFetchResult=result;
    if(result.qualityReport)saveFetchProof(result.qualityReport);
    if(result.error||!result.games?.length){
      showToast(`❌ ${result.error||'No games for this date range'}. Adjust the date range or add games manually.`,'error');
      renderCommPage(); return;
    }
    // Clear old pool then save fresh results
    clearAvailableGames(week.weekId);
    saveAvailableGames(week.weekId, result.games);
    showToast(`✅ ${result.games.length} games for ${rangeLabel}. Review and add to slate.`,'success');
    renderCommPage();
  });

  // Load historical demo
  document.getElementById('load-hist-demo-btn')?.addEventListener('click', ()=>{
    const existing=getWeek(HISTORICAL_DEMO_WEEK.weekId);
    if(!existing){
      saveWeek(HISTORICAL_DEMO_WEEK);
      HISTORICAL_DEMO_GAMES.forEach(g=>saveGame(g));
      HISTORICAL_DEMO_GAMES.forEach(g=>setGameLockOverride(g.gameId,true));
    }
    setActiveWeekId(HISTORICAL_DEMO_WEEK.weekId);
    showToast('✅ Historical Demo Week loaded!','success');
    refreshHeader(); renderCommPage();
  });

  // Suggested slate — apply all 10 at once
  document.getElementById('apply-suggested-btn')?.addEventListener('click', ()=>{
    if(!week||!suggested.length)return;
    let added=0;
    for(const game of suggested){
      const alreadyOn=getGames(week.weekId).some(g=>g.homeTeam===game.homeTeam&&g.awayTeam===game.awayTeam);
      if(!alreadyOn){saveGame(createGame(week.weekId,{...game,weekId:week.weekId}));added++;}
    }
    showToast(`✅ ${added} suggested games added to slate`,'success'); renderCommPage();
  });

  // Add suggested game individually
  document.querySelectorAll('.add-suggested-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(!week)return;
      const idx=parseInt(btn.dataset.idx);
      const game=suggested[idx]; if(!game)return;
      saveGame(createGame(week.weekId,{...game,weekId:week.weekId}));
      showToast(`✅ ${td(game,'home')} vs ${td(game,'away')} added`,'success'); renderCommPage();
    });
  });

  // Dismiss (reject) a suggested game so it stops reappearing
  document.querySelectorAll('.reject-suggested-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(!week)return;
      const idx=parseInt(btn.dataset.idx);
      const game=suggested[idx]; if(!game)return;
      rejectSuggestion(week.weekId, game);
      showToast(`Suggestion dismissed — ${td(game,'home')} vs ${td(game,'away')}`,'warning'); renderCommPage();
    });
  });

  // Restore all dismissed suggestions for the week
  document.getElementById('restore-rejected-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    clearRejectedSuggestions(week.weekId);
    showToast('Dismissed suggestions restored','success'); renderCommPage();
  });

  // Add from available pool
  bindAvailGroupHandlers(week, games);

  // Remove an on-slate game directly from the Available Games list
  // (Handled inside bindAvailGroupHandlers — kept here as a no-op stub for safety.)

  // Clear pool
  document.getElementById('clear-pool-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    clearAvailableGames(week.weekId);
    showToast('Available pool cleared','warning'); renderCommPage();
  });

  // ── Available-games filter bar (group/conf/rank/alma/search) ──
  // Re-renders only the groups container (not the whole panel) on each change
  // so the user keeps their focus / scroll position.
  const reRenderAvail = () => {
    const c = document.getElementById('avail-groups-list');
    if (c) c.innerHTML = renderAvailableGroups(getAvailableGames(week?.weekId||''), games, week);
    // Re-bind buttons inside the freshly rendered list
    bindAvailGroupHandlers(week, games);
  };
  document.getElementById('avail-group')?.addEventListener('change', e => {
    state.availFilter.groupBy = e.target.value; reRenderAvail();
  });
  document.getElementById('avail-conf')?.addEventListener('change', e => {
    state.availFilter.conference = e.target.value; reRenderAvail();
  });
  document.getElementById('avail-rank')?.addEventListener('change', e => {
    state.availFilter.rank = e.target.value; reRenderAvail();
  });
  document.getElementById('avail-alma-only')?.addEventListener('change', e => {
    state.availFilter.almaOnly = !!e.target.checked; reRenderAvail();
  });
  // Debounce the search input — re-render after 200 ms of inactivity
  let searchTimer = null;
  const searchEl = document.getElementById('avail-search');
  searchEl?.addEventListener('input', e => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => {
      state.availFilter.search = val;
      reRenderAvail();
      // Restore focus + cursor position after the re-render
      const again = document.getElementById('avail-search');
      if (again) { again.focus(); again.setSelectionRange(val.length, val.length); }
    }, 200);
  });
  const resetFilters = () => {
    state.availFilter = { groupBy: 'date', conference: '', rank: 'any', almaOnly: false, search: '' };
    renderCommPage(); // full re-render to refresh the filter bar inputs
  };
  document.getElementById('avail-reset-filters')?.addEventListener('click', resetFilters);
  document.getElementById('avail-reset-filters-inline')?.addEventListener('click', resetFilters);
  // Wire add/remove buttons inside the initial render of the groups
  bindAvailGroupHandlers(week, games);

  // Slate controls
  document.getElementById('clear-slate-btn')?.addEventListener('click', ()=>{
    if(!week||!confirm('Remove all games from the slate? This does not affect picks already submitted.'))return;
    clearSlateForWeek(week.weekId);
    showToast('Slate cleared','warning'); renderCommPage();
  });
  document.getElementById('add-manual-game-btn')?.addEventListener('click', ()=>{
    if(week)showGameModal(null,week,data=>{saveGame(createGame(week.weekId,data));showToast('Game added','success');renderCommPage();});
  });
  document.getElementById('unlock-all-btn')?.addEventListener('click', ()=>{
    clearAllLockOverrides();
    getGames(week?.weekId).forEach(g=>setGameLockOverride(g.gameId,true));
    showToast('🔓 All games unlocked','warning'); renderCommPage();
  });
  document.getElementById('refresh-scores-btn')?.addEventListener('click', async()=>{
    if(!week)return;
    showToast('⏳ Refreshing scores…','warning');
    await doRefreshScores(week,getGames(week.weekId));
    showToast('✅ Scores updated','success'); renderCommPage();
  });
  document.getElementById('finalize-scoring-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    let count=0;
    getGames(week.weekId).forEach(g=>{
      if(g.status===GAME_STATUS.FINAL&&g.lockedSpread!==null){
        saveGame({...g,atsWinner:calculateAtsWinner(g)});count++;
      }
    });
    finalizeWeek(week);
    showToast(`✅ ATS calculated for ${count} games`,'success'); renderCommPage();
  });

  // ── Export bindings (expanded) ──
  document.getElementById('export-week-picks-csv-btn')?.addEventListener('click', ()=>exportWeekPicksCSV(week));
  document.getElementById('export-week-slate-csv-btn')?.addEventListener('click', ()=>exportWeekSlateCSV(week));
  document.getElementById('export-week-results-csv-btn')?.addEventListener('click', ()=>exportWeekResultsCSV(week));
  document.getElementById('export-week-dashboard-csv-btn')?.addEventListener('click', ()=>exportWeekDashboardCSV(week));
  document.getElementById('export-week-bundle-btn')?.addEventListener('click', ()=>exportWeekBundle(week));
  document.getElementById('export-players-csv-btn')?.addEventListener('click', exportPlayersCSV);
  document.getElementById('export-standings-csv-btn')?.addEventListener('click', exportStandingsCSV);
  document.getElementById('export-weekly-results-csv-btn')?.addEventListener('click', exportAllWeeklyResultsCSV);
  document.getElementById('export-obligations-csv-btn')?.addEventListener('click', exportObligationsCSV);
  document.getElementById('export-full-json-btn')?.addEventListener('click', exportFullBackupJSON);
  document.getElementById('export-full-csv-bundle-btn')?.addEventListener('click', exportFullCsvBundle);

  // ── Demo simulation ──
  const demoGameSel = document.getElementById('demo-game-select');
  const demoCtrls   = document.getElementById('demo-game-controls');
  demoGameSel?.addEventListener('change', ()=>{
    if(demoCtrls)demoCtrls.style.display=demoGameSel.value?'block':'none';
    const g=getGame(demoGameSel.value);
    if(g){
      const hl=document.getElementById('demo-home-label');
      const al=document.getElementById('demo-away-label');
      if(hl)hl.textContent=td(g,'home')+' Score';
      if(al)al.textContent=td(g,'away')+' Score';
      const hs=document.getElementById('demo-home-score');
      const as_=document.getElementById('demo-away-score');
      if(hs)hs.value=g.homeScore||0;
      if(as_)as_.value=g.awayScore||0;
    }
  });
  document.getElementById('demo-set-live')?.addEventListener('click',()=>{
    const gid=demoGameSel?.value; if(!gid)return;
    const g=getGame(gid); if(!g)return;
    const hs=parseInt(document.getElementById('demo-home-score')?.value)||0;
    const as_=parseInt(document.getElementById('demo-away-score')?.value)||0;
    // Mark as manual so the ESPN auto-refresh won't overwrite the simulated score.
    saveGame({...g,status:'live',homeScore:hs,awayScore:as_,dataSource:'manual',lastUpdated:new Date().toISOString()});
    showToast(`${td(g,'home')} vs ${td(g,'away')}: LIVE ${hs}–${as_}`,'success'); renderCommPage();
  });
  document.getElementById('demo-set-final')?.addEventListener('click',()=>{
    const gid=demoGameSel?.value; if(!gid)return;
    const g=getGame(gid); if(!g)return;
    const hs=parseInt(document.getElementById('demo-home-score')?.value)||0;
    const as_=parseInt(document.getElementById('demo-away-score')?.value)||0;
    let actualWinner=null;
    if(hs>as_)actualWinner=g.homeTeam;else if(as_>hs)actualWinner=g.awayTeam;
    const sv=g.lockedSpread!==null?g.lockedSpread:g.spread;
    let atsWinner=null;
    if(sv!==null){const adj=hs+sv;if(Math.abs(adj-as_)<0.01)atsWinner='no_decision';else atsWinner=adj>as_?g.homeTeam:g.awayTeam;}
    saveGame({...g,status:'final',homeScore:hs,awayScore:as_,actualWinner,atsWinner,dataSource:'manual',lastUpdated:new Date().toISOString()});
    showToast(`FINAL: ${td(g,'home')} ${hs} – ${td(g,'away')} ${as_}`,'success'); renderCommPage();
  });
  document.getElementById('demo-set-scheduled')?.addEventListener('click',()=>{
    const gid=demoGameSel?.value; if(!gid)return;
    const g=getGame(gid); if(!g)return;
    saveGame({...g,status:'scheduled',homeScore:null,awayScore:null,actualWinner:null,atsWinner:null,dataSource:'manual'});
    showToast('Reset to scheduled','warning'); renderCommPage();
  });
  document.getElementById('demo-update-score')?.addEventListener('click',()=>{
    const gid=demoGameSel?.value; if(!gid)return;
    const g=getGame(gid); if(!g)return;
    const hs=parseInt(document.getElementById('demo-home-score')?.value)||0;
    const as_=parseInt(document.getElementById('demo-away-score')?.value)||0;
    saveGame({...g,homeScore:hs,awayScore:as_,dataSource:'manual',lastUpdated:new Date().toISOString()});
    showToast(`Score updated: ${hs}–${as_}`,'success');
  });
  document.getElementById('demo-finalize-all')?.addEventListener('click',()=>{
    if(!week)return;
    const wGames=getGames(week.weekId);
    let promoted = 0, atsComputed = 0, skipped = 0;
    wGames.forEach(g=>{
      // Promote anything that has scores but isn't final yet (live OR
      // scheduled-with-scores). A game without scores can't be finalized —
      // skip it and let the commissioner know.
      const hasScores = g.homeScore !== null && g.awayScore !== null;
      let next = { ...g };
      if (g.status !== 'final') {
        if (!hasScores) { skipped++; return; }
        next.status = 'final';
        // Compute straight-up winner from scores
        if (g.homeScore > g.awayScore)       next.actualWinner = g.homeTeam;
        else if (g.awayScore > g.homeScore)  next.actualWinner = g.awayTeam;
        else                                  next.actualWinner = null; // tie
        promoted++;
      }
      // Compute ATS (if we have a spread on file)
      const sv = g.lockedSpread !== null ? g.lockedSpread : g.spread;
      if (sv !== null) {
        const adj = next.homeScore + sv;
        next.atsWinner = Math.abs(adj - next.awayScore) < 0.01
          ? 'no_decision'
          : (adj > next.awayScore ? g.homeTeam : g.awayTeam);
        atsComputed++;
      }
      next.dataSource = 'manual';
      next.lastUpdated = new Date().toISOString();
      saveGame(next);
    });
    finalizeWeek(week);
    const parts = [];
    if (promoted) parts.push(`${promoted} promoted to final`);
    if (atsComputed) parts.push(`${atsComputed} ATS computed`);
    if (skipped) parts.push(`${skipped} skipped (no scores)`);
    showToast(`✅ Week finalized — ${parts.join(' · ') || 'no changes needed'}`,'success');
    renderCommPage();
  });
  document.getElementById('demo-reset-all-scheduled')?.addEventListener('click',()=>{
    if(!week)return;
    getGames(week.weekId).forEach(g=>saveGame({...g,status:'scheduled',homeScore:null,awayScore:null,actualWinner:null,atsWinner:null}));
    showToast('All games reset to scheduled','warning'); renderCommPage();
  });

  // ── Batch grid: apply all rows at once ──
  document.getElementById('demo-batch-apply')?.addEventListener('click',()=>{
    if(!week)return;
    const rows=document.querySelectorAll('.batch-grid tbody tr');
    let applied=0;
    rows.forEach(row=>{
      const gid=row.dataset.gameId;
      const g=getGame(gid); if(!g)return;
      const hsRaw=row.querySelector('.batch-home-score')?.value;
      const asRaw=row.querySelector('.batch-away-score')?.value;
      let status=row.querySelector('.batch-status')?.value||g.status;
      const hs=hsRaw!==''&&hsRaw!=null?parseInt(hsRaw):null;
      const as_=asRaw!==''&&asRaw!=null?parseInt(asRaw):null;

      // Earlier bug: if user filled in scores but left status='scheduled', the
      // scores were silently nulled by the status==='scheduled'?null:hs rule.
      // Now: if scores are present but status is still scheduled, auto-promote
      // to 'live'. The Commissioner explicitly choosing scheduled+blank scores
      // still correctly resets the game.
      if (status === 'scheduled' && (hs !== null || as_ !== null)) status = 'live';

      let actualWinner=null, atsWinner=null;
      if(status==='final'&&hs!==null&&as_!==null){
        if(hs>as_)actualWinner=g.homeTeam;else if(as_>hs)actualWinner=g.awayTeam;
        const sv=g.lockedSpread!==null?g.lockedSpread:g.spread;
        if(sv!==null){const adj=hs+sv;atsWinner=Math.abs(adj-as_)<0.01?'no_decision':adj>as_?g.homeTeam:g.awayTeam;}
      }
      saveGame({...g,
        status,
        homeScore: status==='scheduled'?null:hs,
        awayScore: status==='scheduled'?null:as_,
        actualWinner: status==='final'?actualWinner:null,
        atsWinner: status==='final'?atsWinner:null,
        dataSource:'manual',  // protect simulated state from ESPN auto-refresh
        lastUpdated:new Date().toISOString(),
      });
      applied++;
    });
    showToast(`💾 Applied changes to ${applied} games`,'success'); renderCommPage();
  });

  // ── Batch grid: randomize plausible scores AND bump status to final ──
  // The whole point of randomize is to pressure-test the dashboard's live/final
  // states. If we left status as scheduled, the scores wouldn't visibly change
  // anything (the picks matrix only shows scores for live/final games), which
  // is exactly the "scores disappear" symptom the user reported.
  document.getElementById('demo-batch-randomize')?.addEventListener('click',()=>{
    const rows = document.querySelectorAll('.batch-grid tbody tr');
    rows.forEach(row=>{
      const rand=()=>Math.floor(Math.random()*42); // 0–41, realistic CFB range
      const h=row.querySelector('.batch-home-score');
      const a=row.querySelector('.batch-away-score');
      const s=row.querySelector('.batch-status');
      if(h) h.value=rand();
      if(a) a.value=rand();
      // Bump status to 'final' so the user sees decided wins/losses on Apply.
      // (They can pick 'live' or 'scheduled' afterwards if they want to test
      // those states.)
      if(s) s.value='final';
    });
    showToast('🎲 Randomized — set to FINAL. Click Apply to commit.','warning');
  });



  document.querySelectorAll('.lock-toggle-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const mu=btn.dataset.unlocked==='true';
      setGameLockOverride(btn.dataset.gameId,!mu);
      showToast(mu?'🔒 Locked':'🔓 Unlocked','success'); renderCommPage();
    });
  });
  document.querySelectorAll('.remove-game-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const gid=btn.dataset.gameId;
      const g=getGame(gid);
      const pickCount=countPicksForGame(gid);
      const label=g?`${td(g,'home')} vs ${td(g,'away')}`:'this game';
      let msg=`Remove ${label} from the slate?`;
      if(pickCount>0) msg+=`\n\n⚠️ ${pickCount} player pick${pickCount>1?'s have':' has'} already been submitted for this game. Removing it will permanently delete ${pickCount>1?'those picks':'that pick'} and they will no longer count toward scoring.`;
      if(!confirm(msg))return;
      deleteGame(gid); // cascades: deletes associated picks + lock override
      showToast(pickCount>0?`Removed — ${pickCount} pick${pickCount>1?'s':''} also deleted`:'Game removed','warning');
      renderCommPage();
    });
  });
  document.querySelectorAll('.edit-game-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const g=getGame(btn.dataset.gameId);
      if(g)showGameModal(g,null,data=>{saveGame({...g,...data,updatedAt:new Date().toISOString()});showToast('Updated','success');renderCommPage();});
    });
  });

  // Tiebreaker
  document.getElementById('save-tb-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    const q=document.getElementById('tb-question')?.value||'';
    const aRaw=document.getElementById('tb-actual')?.value;
    const actual=aRaw!==''&&aRaw!==undefined?parseFloat(aRaw):null;
    saveWeek({...week,tiebreakerQuestion:q,actualTiebreakerValue:actual,tiebreakerFinalized:actual!==null});
    showToast('Tiebreaker saved ✅','success'); renderCommPage();
  });
  document.getElementById('auto-calc-tb-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    const total=calculateAlmaMaterTotal(getGames(week.weekId),ALMA_MATERS,week.tiebreakerCalculationMode||'selectedSlateOnly');
    if(total===null){showToast('⚠️ No final alma mater scores yet.','warning');return;}
    const inp=document.getElementById('tb-actual'); if(inp)inp.value=total;
    showToast(`Auto-calculated: ${total} pts`,'success');
  });

  // Nicknames
  document.querySelectorAll('.save-nick-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      setNickname(btn.dataset.weekId,btn.dataset.playerId,document.getElementById(`nick-${btn.dataset.playerId}`)?.value||'');
      showToast('Nickname saved','success');
    });
  });

  // Players + PIN management
  document.getElementById('admin-add-player-btn')?.addEventListener('click', ()=>{
    const n=document.getElementById('admin-new-player')?.value.trim();
    if(!n)return;
    if(getPlayers().find(p=>p.displayName.toLowerCase()===n.toLowerCase())){showToast('Already exists','warning');return;}
    addPlayer(createPlayer(n,'','0000'));
    document.getElementById('admin-new-player').value='';
    showToast(`${n} added`,'success'); renderCommPage();
  });
  document.querySelectorAll('.edit-player-btn').forEach(btn=>btn.addEventListener('click',()=>showEditPlayerModal(btn.dataset.playerId)));
  document.querySelectorAll('.toggle-player-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const p=getPlayer(btn.dataset.playerId); if(!p)return;
      savePlayer({...p,active:!p.active}); showToast(`${p.displayName} ${p.active?'deactivated':'activated'}`,'success'); renderCommPage();
    });
  });
  document.querySelectorAll('.reset-pin-btn').forEach(btn=>{
    btn.addEventListener('click',()=>showResetPinModal(btn.dataset.playerId,btn.dataset.name));
  });

  // ── PIN show/hide toggle ──
  document.querySelectorAll('.pin-toggle-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const row = btn.closest('[data-player-row]');
      const input = row?.querySelector('.pin-input');
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '🙈' : '🙉';
    });
  });

  // ── Save email for a player ──
  document.querySelectorAll('.save-email-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const pid = btn.dataset.playerId;
      const row = btn.closest('[data-player-row]');
      const email = row?.querySelector('.email-input')?.value.trim() || '';
      // Light validation — empty is allowed (clears it), otherwise must look like an email.
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast('That doesn\'t look like a valid email','error'); return;
      }
      const p = getPlayer(pid); if (!p) return;
      savePlayer({...p, email, updatedAt: new Date().toISOString()});
      showToast(`Email saved for ${p.displayName}`,'success');
      // Re-enable / update the share button without a full re-render
      const shareBtn = row.querySelector('.share-pin-btn');
      if (shareBtn) shareBtn.disabled = !email;
    });
  });

  // ── Share PIN via email (opens user's mail client — no server needed) ──
  document.querySelectorAll('.share-pin-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const pid = btn.dataset.playerId;
      const p = getPlayer(pid); if (!p) return;
      if (!p.email) { showToast('Save an email for this player first','error'); return; }
      const pin = getPlayerPin(pid);
      if (!pin) { showToast('No PIN set for this player — Reset PIN first','error'); return; }
      const siteUrl = window.location.origin + window.location.pathname;
      const subject = encodeURIComponent('Your CFB Pickems PIN');
      const body = encodeURIComponent(
        `Hi ${p.displayName},\n\n` +
        `Your CFB Pickems login PIN is: ${pin}\n\n` +
        `Site: ${siteUrl}\n` +
        `Site PIN (front gate): 6969\n\n` +
        `Pick your name from the player list, enter the PIN above, and you're in. ` +
        `Reply to this email if you need it reset.\n`
      );
      window.location.href = `mailto:${encodeURIComponent(p.email)}?subject=${subject}&body=${body}`;
    });
  });

  // ── Broadcast to all players with email on file ──
  document.getElementById('bcast-send-btn')?.addEventListener('click',()=>{
    const subject = (document.getElementById('bcast-subject')?.value || 'CFB Pickems update').trim();
    const body = (document.getElementById('bcast-body')?.value || '').trim();
    if (!body) { showToast('Write a message first','error'); return; }
    const recipients = getPlayers().filter(p=>p.active && p.email).map(p=>p.email);
    if (!recipients.length) { showToast('No players have an email on file','error'); return; }
    // BCC keeps everyone's address private. Some mail clients limit URL length,
    // so we warn rather than fail when the recipient list gets long.
    const siteUrl = window.location.origin + window.location.pathname;
    const fullBody = `${body}\n\n— Sent from CFB Pickems\n${siteUrl}`;
    const mailto = `mailto:?bcc=${encodeURIComponent(recipients.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fullBody)}`;
    if (mailto.length > 1800) {
      showToast(`⚠️ Long recipient list (${recipients.length}). If your mail client only opens a few, copy emails from the player list manually.`,'warning');
    }
    window.location.href = mailto;
    showToast(`✉ Opening mail client for ${recipients.length} recipient${recipients.length>1?'s':''}`,'success');
  });

  // Obligations (v0.17.0: manual add / delete / undo / 2K25 ledger / demo purge)
  document.getElementById('ob-add-btn')?.addEventListener('click',()=>{
    const payer=document.getElementById('ob-add-payer')?.value;
    const recip=document.getElementById('ob-add-recipient')?.value;
    const note=(document.getElementById('ob-add-note')?.value||'').trim();
    if(!payer||!recip||payer===recip){showToast('Pick two different players','error');return;}
    const ob=createObligation(null,payer,recip,note||'1 drink','manual');
    ob.note=note||'manual entry'; ob.weekLabel='manual';
    saveObligation(ob);
    showToast('✅ Obligation added','success'); renderCommPage();
  });
  document.querySelectorAll('.ob-delete-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(!confirm('Delete this obligation from the ledger?'))return;
      saveAllObligations(getObligations().filter(o=>o.obligationId!==btn.dataset.obId));
      showToast('🗑 Obligation deleted','success'); renderCommPage();
    });
  });
  document.getElementById('ob-purge-demo')?.addEventListener('click',()=>{
    const demoIds=new Set(getWeeks().filter(w=>w.dataSourceMode==='demo').map(w=>w.weekId));
    saveAllObligations(getObligations().filter(o=>!demoIds.has(o.weekId)));
    showToast('🧹 Demo obligations purged','success'); renderCommPage();
  });
  // UN-89 debt-payment approval — one delegate per ledger shape, both driving
  // the SAME state-machine helpers the Standings page uses (obligationRole /
  // obligationNextStatus in data-model.js), so the comm panel and Standings
  // can never disagree about a transition.
  document.querySelectorAll('.ob-action-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      handleObligationAction(btn.dataset.obId, btn.dataset.obAction);
      renderCommPage();
    });
  });
  document.querySelectorAll('.ob2025-action-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      handleOb2025Action(btn.dataset.obId, btn.dataset.obAction);
      renderCommPage();
    });
  });

  // Chat retention (UN-88) — synced setting, OFF by default (CONVENTIONS #10).
  document.getElementById('chat-retention-toggle')?.addEventListener('change', e => {
    saveSetting('chatRetentionDays', e.target.checked ? 7 : 0);
    showToast(e.target.checked
      ? '🙈 Chat retention on — messages older than 7 days will stop showing'
      : 'Chat retention off — full history restored', 'success');
    renderCommPage();
  });

  // Auto-refresh
  document.getElementById('save-refresh-btn')?.addEventListener('click', ()=>{
    const val=parseInt(document.getElementById('auto-refresh-select')?.value||'60');
    saveSetting('autoRefreshInterval',val); setupAutoRefresh();
    showToast('Refresh interval saved','success');
  });

  // Randomize Picks shortcut (UN-107) — commissioner-controlled, default OFF.
  document.getElementById('randomize-enabled-toggle')?.addEventListener('change', e => {
    saveSetting('randomizePicksEnabled', e.target.checked);
    showToast(e.target.checked
      ? '🎲 Randomize shortcut enabled — players will see the button'
      : '🎲 Randomize shortcut disabled — players make every pick by hand', 'success');
    renderCommPage();
  });

  // Rules
  document.getElementById('save-rules-btn')?.addEventListener('click', ()=>{
    saveSetting('customRules',parseRulesText(document.getElementById('rules-editor')?.value||''));
    showToast('Rules saved','success');
  });
  document.getElementById('reset-rules-btn')?.addEventListener('click', ()=>{
    saveSetting('customRules',null);
    document.getElementById('rules-editor').value=getRulesEditorText(true);
    showToast('Rules reset','success');
  });

  // Danger zone
  document.getElementById('reset-week-btn')?.addEventListener('click', ()=>{
    if(!week)return;
    if(confirm(`Clear all games, picks, results, and tiebreaker data for "${formatWeekLabel(week)}" only? All other weeks and player data are preserved.`)){
      resetCurrentWeekData(week.weekId);
      showToast(`Week data cleared for ${formatWeekLabel(week)}`,'warning'); renderCommPage();
    }
  });
  document.getElementById('reset-demo-btn')?.addEventListener('click', ()=>{
    // Require Commissioner to re-enter password for full reset
    const pw = prompt('Enter Commissioner password to confirm FULL factory reset. This deletes ALL data including all weeks and players:');
    if (!pw) return;
    if (btoa(pw) !== getSettings().adminPasswordHash) { showToast('❌ Incorrect password — reset cancelled','error'); return; }
    if(!confirm('FINAL WARNING: This will permanently delete ALL weeks, picks, players, results, and standings. Type OK to proceed.'))return;
    resetToDemo(); clearSession(); showToast('Full reset complete','warning'); renderCommPage(); refreshHeader();
  });
  document.getElementById('logout-comm-btn')?.addEventListener('click', ()=>{
    const s=getSession();setSession(s.playerId,false,s.playerVerified);renderCommPage();
  });

  // ── Security & Settings: change Commissioner password ──
  document.getElementById('sec-change-pw-btn')?.addEventListener('click', ()=>{
    const cur = document.getElementById('sec-pw-current')?.value || '';
    const next = document.getElementById('sec-pw-new')?.value || '';
    const confirm2 = document.getElementById('sec-pw-confirm')?.value || '';
    if (!cur || !next || !confirm2) { showToast('Fill in all three password fields','error'); return; }
    if (btoa(cur) !== getSettings().adminPasswordHash) { showToast('Current password is wrong','error'); return; }
    if (next.length < 6) { showToast('New password must be at least 6 characters','error'); return; }
    if (next !== confirm2) { showToast('New passwords don\'t match — re-type both','error'); return; }
    if (next === cur) { showToast('New password matches the old one','error'); return; }
    if (!confirm('Change the Commissioner password? You\'ll stay logged in on this device, but need the new password next time.')) return;
    saveSetting('adminPasswordHash', btoa(next));
    showToast('🔑 Password changed','success');
    renderCommPage();
  });

  // ── Security & Settings: change site PIN ──
  document.getElementById('sec-change-site-pin-btn')?.addEventListener('click', ()=>{
    const next = (document.getElementById('sec-site-pin-new')?.value || '').trim();
    const confirm2 = (document.getElementById('sec-site-pin-confirm')?.value || '').trim();
    if (!next || !confirm2) { showToast('Enter and confirm the new site PIN','error'); return; }
    if (next.length < 4) { showToast('Site PIN must be at least 4 characters','error'); return; }
    if (next !== confirm2) { showToast('PINs don\'t match — re-type both','error'); return; }
    if (next === getEffectiveSitePin()) { showToast('That\'s already the current site PIN','warning'); return; }
    if (!confirm(`Change the site PIN to "${next}"? Players will need this PIN on their next visit. (Already-unlocked devices stay unlocked.)`)) return;
    setSitePin(next);
    showToast('🚪 Site PIN updated','success');
    renderCommPage();
  });

  // ── Security & Settings: save Welcome Screen text ──
  document.getElementById('sec-save-welcome-btn')?.addEventListener('click', ()=>{
    const top = (document.getElementById('sec-welcome-title-top')?.value || '').trim();
    const main = (document.getElementById('sec-welcome-title-main')?.value || '').trim();
    const sub = (document.getElementById('sec-welcome-subtitle')?.value || '').trim();
    saveSetting('welcomeTitleTop', top);
    saveSetting('welcomeTitleMain', main);
    saveSetting('welcomeSubtitle', sub);
    showToast('Welcome text saved','success');
  });

  // ── Security & Settings: save Commissioner contact email ──
  document.getElementById('sec-save-comm-email-btn')?.addEventListener('click', ()=>{
    const email = (document.getElementById('sec-comm-email')?.value || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('That doesn\'t look like a valid email','error'); return;
    }
    saveSetting('commissionerEmail', email);
    showToast(email ? 'Commissioner email saved' : 'Commissioner email cleared', 'success');
  });

  // ── Cloud Sync (backend) handlers ──
  document.getElementById('be-test-btn')?.addEventListener('click', async ()=>{
    const url=document.getElementById('be-url')?.value.trim();
    const token=document.getElementById('be-token')?.value.trim();
    if(!url){showToast('Enter the Web App URL first','error');return;}
    setBackendConfig(url, token);
    showToast('⏳ Testing…','warning');
    const r=await pingBackend();
    showToast(r.ok?`✅ Reached backend (${r.service||'ok'})`:`❌ ${r.error||'No response'}`, r.ok?'success':'error');
  });

  document.getElementById('be-save-btn')?.addEventListener('click', async ()=>{
    const url=document.getElementById('be-url')?.value.trim();
    const token=document.getElementById('be-token')?.value.trim();
    if(!url||!token){showToast('URL and token are both required','error');return;}
    setBackendConfig(url, token);
    showToast('⏳ Connecting…','warning');
    try{
      await hydrateBackend();
      setBackendMode('googleSheets');
      ensureSeedData();
      showToast('✅ Connected — this device now uses shared data','success');
      refreshHeader(); renderCommPage();
    }catch(err){
      showToast(`❌ Connect failed: ${err.message||err}`,'error');
    }
  });

  document.getElementById('be-disconnect-btn')?.addEventListener('click', ()=>{
    if(!confirm('Disconnect from the shared Sheet and use this device only? Local data remains; shared data is untouched.'))return;
    setBackendMode('local');
    clearBackendConfig();
    initStorage();
    showToast('Disconnected — using local data','warning');
    refreshHeader(); renderCommPage();
  });

  document.getElementById('be-seed-btn')?.addEventListener('click', async ()=>{
    if(!isBackendConfigured()){showToast('Save & connect first','error');return;}
    if(!confirm('Push THIS device\'s data up to seed the Sheet? Existing keys on the Sheet are kept (not overwritten).'))return;
    showToast('⏳ Seeding…','warning');
    try{
      const snapshot=exportAllDataRaw();
      const n=await seedFromLocal(snapshot,false);
      showToast(`✅ Seeded ${n} data keys to the Sheet`,'success');
    }catch(err){showToast(`❌ ${err.message||err}`,'error');}
  });

  document.getElementById('be-pull-btn')?.addEventListener('click', async ()=>{
    if(!isBackendConfigured()){showToast('Save & connect first','error');return;}
    showToast('⏳ Pulling…','warning');
    try{
      await refreshFromBackend();
      setBackendMode('googleSheets');
      showToast('✅ Pulled shared data to this device','success');
      refreshHeader(); renderCommPage();
    }catch(err){showToast(`❌ ${err.message||err}`,'error');}
  });

  // Flush any debounced pending writes to the Sheet immediately. Useful when
  // the user is about to close the tab and wants the most recent edits to land.
  document.getElementById('be-flush-now-btn')?.addEventListener('click', async ()=>{
    showToast('⏳ Flushing pending writes…','warning');
    try {
      const r = await flushPush();
      showToast(r.pushed ? `✅ Pushed ${r.pushed} pending writes` : '✅ Nothing pending — already synced','success');
      renderCommPage();
    } catch(err){ showToast(`❌ Flush failed: ${err.message||err}`,'error'); }
  });
  // Same as the existing be-pull-btn but available inside the status panel for proximity.
  document.getElementById('be-pull-now-btn')?.addEventListener('click', async ()=>{
    showToast('⏳ Pulling latest…','warning');
    try {
      await refreshFromBackend();
      showToast('✅ Pulled latest from Sheet','success');
      renderCommPage();
    } catch(err){ showToast(`❌ Pull failed: ${err.message||err}`,'error'); }
  });

  document.getElementById('be-snapshot-btn')?.addEventListener('click', async ()=>{
    if(!isBackendConfigured()){showToast('Save & connect first','error');return;}
    const label=prompt('Snapshot label (optional, e.g. "End of Week 5"):')||'';
    showToast('⏳ Creating snapshot…','warning');
    try{ const r=await createSnapshot(label); showToast(`📸 Snapshot saved (${r.id})`,'success'); }
    catch(err){showToast(`❌ ${err.message||err}`,'error');}
  });

  document.getElementById('be-list-snapshots-btn')?.addEventListener('click', async ()=>{
    if(!isBackendConfigured()){showToast('Save & connect first','error');return;}
    const el=document.getElementById('be-snapshots-list'); if(el)el.innerHTML='Loading…';
    try{
      const snaps=await listSnapshots();
      if(!el)return;
      if(!snaps.length){el.innerHTML='No snapshots yet.';return;}
      el.innerHTML=snaps.map(s=>`<div class="flex-between" style="padding:4px 0;border-bottom:1px solid var(--border)">
        <span>${escHtml(s.label||'(no label)')} · <span class="text-muted">${new Date(s.createdAt).toLocaleString()}</span></span>
        <button class="btn btn-ghost btn-sm be-restore-snap" data-id="${escHtml(s.id)}">Restore</button>
      </div>`).join('');
      el.querySelectorAll('.be-restore-snap').forEach(b=>b.addEventListener('click', async ()=>{
        if(!confirm('Restore this snapshot? Current shared data is backed up first, then overwritten.'))return;
        showToast('⏳ Restoring…','warning');
        try{ await restoreSnapshot(b.dataset.id); showToast('✅ Restored','success'); refreshHeader(); renderCommPage(); }
        catch(err){showToast(`❌ ${err.message||err}`,'error');}
      }));
    }catch(err){ if(el)el.innerHTML=`Error: ${escHtml(String(err.message||err))}`; }
  });

  // ── Priority 14: Weekly Summary email (preview + send via mail client) ──
  document.getElementById('weekly-summary-preview-btn')?.addEventListener('click', () => {
    const el = document.getElementById('weekly-summary-preview');
    if (!el) return;
    if (el.style.display === 'none') {
      const text = buildWeeklySummary(week);
      el.textContent = text;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  });
  document.getElementById('weekly-summary-send-btn')?.addEventListener('click', () => {
    const recipients = getPlayers().filter(p => p.active && p.email).map(p => p.email);
    if (!recipients.length) { showToast('No player has an email on file','error'); return; }
    const body = buildWeeklySummary(week);
    const subject = `CFB Pickems — ${formatWeekLabel(week)} recap`;
    const siteUrl = window.location.origin + window.location.pathname;
    const fullBody = `${body}\n\n— Sent from CFB Pickems\n${siteUrl}`;
    const mailto = `mailto:?bcc=${encodeURIComponent(recipients.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fullBody)}`;
    if (mailto.length > 1800) {
      showToast(`⚠️ Long recipient list (${recipients.length}). If your mail client only opens a few, copy emails manually.`,'warning');
    }
    window.location.href = mailto;
    showToast(`✉ Opening mail client for ${recipients.length} recipient${recipients.length>1?'s':''}`,'success');
  });
}

/**
 * Priority 14: build a plain-text weekly recap suitable for an email body.
 *
 * Sections:
 *   1. Final picks table (one line per player: W–L record + tiebreaker)
 *   2. Weekly winner (notes if won by tiebreaker)
 *   3. Weekly loser (the "obligation owner")
 *   4. Season standings to date (top to bottom by total wins)
 *
 * Plain text only — mailto: URLs and many mail clients mangle HTML. Easy to
 * read in any mail client and easy to copy/paste anywhere else.
 */
function buildWeeklySummary(week) {
  if (!week) return '';
  const players = getPlayers().filter(p => p.active);
  const picks = getPicks(week.weekId);
  const games = getGames(week.weekId);
  const actualTB = week.actualTiebreakerValue ?? null;
  const results = calculateWeeklyResults(week.weekId, players, picks, games, actualTB);

  const lines = [];
  lines.push(`📊 ${formatWeekLabel(week)} — Recap`);
  lines.push('');
  lines.push('━━━ Final picks ━━━');
  results.forEach(r => {
    const name = players.find(p => p.playerId === r.playerId)?.displayName || '(unknown)';
    const w = r.correctPicks, l = r.incorrectPicks;
    const tb = r.tiebreakerGuess !== null && r.tiebreakerGuess !== undefined
      ? (actualTB !== null ? `TB ${r.tiebreakerGuess} (Δ${r.tiebreakerDelta})` : `TB ${r.tiebreakerGuess}`)
      : 'TB —';
    const marker = r.isWinner ? ' 🏆' : r.isLoser ? ' 💀' : '';
    lines.push(`  ${String(r.rank).padStart(2)}. ${name.padEnd(18)} ${w}–${l}  ${tb}${marker}`);
  });
  lines.push('');

  const winner = results.find(r => r.isWinner);
  const loser  = results.find(r => r.isLoser);
  if (winner) {
    const wName = players.find(p => p.playerId === winner.playerId)?.displayName || '(unknown)';
    lines.push(`🏆 Weekly winner: ${wName}${winner.wonByTiebreaker ? ' (won by tiebreaker)' : ''}`);
  }
  if (loser) {
    const lName = players.find(p => p.playerId === loser.playerId)?.displayName || '(unknown)';
    lines.push(`💀 Weekly loser: ${lName}`);
  }

  // Obligations for this week, if any are configured
  const obligations = getObligations().filter(o => o.weekId === week.weekId);
  if (obligations.length) {
    lines.push('');
    lines.push('━━━ Obligations ━━━');
    obligations.forEach(o => {
      const pName = players.find(p => p.playerId === o.playerId)?.displayName || '(unknown)';
      lines.push(`  ${pName}: ${o.description || o.kind}${o.status ? ` [${o.status}]` : ''}`);
    });
  }

  // Season standings to date
  const allResults = getWeeklyResults();
  const standings = calculateSeasonStandings(players, allResults);
  if (standings.length) {
    lines.push('');
    lines.push('━━━ Season standings ━━━');
    standings.forEach(s => {
      const pName = players.find(p => p.playerId === s.playerId)?.displayName || '(unknown)';
      lines.push(`  ${String(s.currentRank).padStart(2)}. ${pName.padEnd(18)} ${s.totalCorrect}–${s.totalIncorrect}  (${s.weeklyWins}W / ${s.weeklyLosses}L)`);
    });
  }

  return lines.join('\n');
}

// ─── DATA PROOF PANEL ─────────────────────────────────────────────────────────

function renderDataProofPanel(proof, ps, week, games) {
  const mode=week?.dataSourceMode||'—';
  const slateGames=games||[];

  const espnIds=slateGames.filter(g=>g.espnEventId).map(g=>g.espnEventId);
  const fetchMethod=ps.lastFetchMethod==='direct'?'✅ Direct (no proxy)':ps.lastFetchMethod?`⚠️ Via proxy: ${ps.lastFetchMethod}`:'—';

  return `<div class="proof-grid">
    <div class="proof-item"><span class="proof-label">Data Mode</span>
      <span class="proof-value"><span class="source-mode-badge mode-${mode}">${sourceModeLabelOf(mode)}</span></span></div>
    <div class="proof-item"><span class="proof-label">Fetch Method</span>
      <span class="proof-value">${fetchMethod}</span></div>
    <div class="proof-item"><span class="proof-label">ESPN URL</span>
      <code class="proof-code">${escHtml(ps.lastFetchUrl||'(not fetched yet)')}</code></div>
    <div class="proof-item"><span class="proof-label">Last Fetch</span>
      <span class="proof-value">${ps.lastFetchTimestamp?new Date(ps.lastFetchTimestamp).toLocaleString():'—'}</span></div>
    <div class="proof-item"><span class="proof-label">Raw ESPN Events</span>
      <span class="proof-value ${ps.lastRawEventCount>0?'proof-good':ps.lastFetchTimestamp?'proof-bad':''}">${ps.lastRawEventCount||'—'}</span></div>
    <div class="proof-item"><span class="proof-label">Data Quality</span>
      <span class="proof-value">${escHtml(ps.lastQualityReport?.dqStatus||'—')}</span></div>
  </div>
  ${ps.lastRawEvents?.length?`<div class="mt-sm"><div class="proof-label mb-sm">Last ${ps.lastRawEvents.length} ESPN events:</div>
    <ol class="proof-list">${ps.lastRawEvents.map(e=>`<li>${escHtml(e)}</li>`).join('')}</ol></div>`:''}
  ${espnIds.length?`<div class="proof-label mt-sm mb-sm">ESPN IDs on slate:</div>
    <div class="proof-ids">${espnIds.map(id=>`<code class="id-chip">${id}</code>`).join(' ')}</div>`:''}
  ${ps.lastScoreRefresh?`<div class="proof-label mt-sm">Last score refresh: <span class="proof-value">${new Date(ps.lastScoreRefresh).toLocaleString()}</span></div>`:''}`;
}

function renderTiebreakerGuessesAdmin(weekId, players, actualTB) {
  const guesses=players.filter(p=>p.active).map(p=>{
    const g=getTiebreakerGuess(weekId,p.playerId);
    const d=actualTB!==null&&g!==null?Math.abs(g-actualTB):null;
    return{player:p,guess:g,delta:d};
  }).filter(x=>x.guess!==null);
  if(!guesses.length)return'<p class="text-muted text-xs mt-md">No tiebreaker guesses yet.</p>';
  return`<div class="divider"></div><div class="text-xs text-muted mb-sm">Submitted guesses:</div>
    <div class="flex gap-sm flex-wrap">
      ${guesses.map(x=>`<span class="badge badge-final">${escHtml(x.player.displayName)}: ${x.guess}${x.delta!==null?` (Δ${x.delta})`:''}</span>`).join('')}
    </div>`;
}

function currentSeasonObligations() {
  // v0.17.0 — demo-week obligations are excluded everywhere; anything a demo
  // finalize created in the past is invisible and purgeable below.
  const demoIds = new Set(getWeeks().filter(w=>w.dataSourceMode==='demo').map(w=>w.weekId));
  return getObligations().filter(o=>!demoIds.has(o.weekId) && !String(o.obligationId).startsWith('ob_2025_'));
}

// ─── DEBT-PAYMENT APPROVAL (UN-89) ─────────────────────────────────────────
// Badge + action markup shared by EVERY render path that shows an
// obligation's payment status: the Standings weekly-history cell, the comm
// Players-tab Obligations card, and both the current-season and 2K25-
// carryover variants of each. One function so all five surfaces can never
// disagree about copy, badge color, or which button a given viewer sees
// (CONVENTIONS #21 — this is the codebase's most common defect class).
//
//   status   — 'unpaid' | 'pending' | 'paid' | 'waived'
//   ob       — anything carrying payerPlayerId/recipientPlayerId/obligationId;
//              works unmodified for both a real cfbp_obligations record and a
//              synthetic season2025Obligations() row
//   sess     — getSession() shape ({isAdmin, playerId, ...})
//   obClass  — CSS class prefix on the action buttons (and the data-ob-action
//              attribute) so the click delegate knows which store to mutate:
//              'ob-action' → current-season (saveObligation); 'ob2025-action'
//              → the settings.ob2025 status-map overlay
function obligationActionsHTML(status, ob, sess, { payerName, recipientName, obClass }) {
  const role = obligationRole(sess, ob);
  const disp = obligationStatusDisplay(status);
  let title = '';
  if (status === 'pending') title = `Pending confirmation from ${recipientName} or the commissioner`;
  else if (status === 'unpaid' && ob.deniedReason) title = `Denied: ${ob.deniedReason}`;
  const badge = `<span class="badge ${disp.badgeClass}"${title ? ` title="${escHtml(title)}"` : ''}>${escHtml(disp.label)}</span>`;

  const btn = (action, label, cls = 'btn-win') =>
    `<button class="btn ${cls} btn-sm ml-sm ${obClass}-btn" data-ob-id="${escHtml(ob.obligationId)}" data-ob-action="${action}">${escHtml(label)}</button>`;

  let actions = '';
  if (status === 'unpaid') {
    // Payer's own claim needs confirmation (→ pending); the creditor's or the
    // commissioner's own action IS the verification (→ paid, direct).
    if (role === 'payer') actions = btn('mark', 'Mark Paid');
    else if (role === 'creditor') actions = btn('mark', 'Confirm Paid');
    else if (role === 'admin') actions = btn('mark', 'Mark Paid');
  } else if (status === 'pending') {
    if (role === 'payer') actions = `<span class="text-muted text-xs ml-sm">Waiting on ${escHtml(recipientName)} to confirm.</span>`;
    else if (role === 'creditor' || role === 'admin') actions = btn('confirm', 'Confirm') + btn('deny', 'Deny', 'btn-danger');
  } else if (status === 'paid' && role === 'admin') {
    actions = `<button class="btn btn-ghost btn-sm ml-sm ${obClass}-btn" data-ob-id="${escHtml(ob.obligationId)}" data-ob-action="undo">Undo</button>`;
  }
  // waived, and every other (status, role) combo (payer/creditor/bystander on
  // paid; bystander everywhere): badge only — no button rendered.
  return badge + actions;
}

/** Applies one UN-89 transition to a CURRENT-SEASON obligation (a full
 *  cfbp_obligations record). Re-derives role + the legal next status from the
 *  store rather than trusting the caller — the UI hides buttons a viewer
 *  shouldn't see, but a sufficiently motivated person could DOM one in, and
 *  this is the actual permission boundary (existing pattern in this file). */
function handleObligationAction(obId, action) {
  const ob = getObligations().find(o => o.obligationId === obId); if (!ob) return;
  const sess = getSession();
  const role = obligationRole(sess, ob);
  const next = obligationNextStatus(ob.status, role, action);
  if (!next) { showToast("You don't have permission to do that", 'error'); return; }
  const payerName = getPlayer(ob.payerPlayerId)?.displayName || '?';
  const recipientName = getPlayer(ob.recipientPlayerId)?.displayName || '?';

  if (action === 'deny') {
    const reason = prompt('Why are you denying this? (optional — leave blank to skip)');
    if (reason === null) return;                          // cancelled the prompt — no change
    saveObligation({ ...ob, status: next, deniedReason: reason.trim() || null, paidAt: null });
    showToast('Denied — back to unpaid.', 'error');
  } else if (action === 'mark' && next === 'pending') {
    saveObligation({ ...ob, status: next, deniedReason: null });
    showToast(`Marked as paid — waiting on ${escHtml(recipientName)} or the commissioner to confirm.`, 'warning');
  } else if (action === 'mark' && next === 'paid') {
    saveObligation({ ...ob, status: next, paidAt: new Date().toISOString(), deniedReason: null });
    showToast(role === 'creditor' ? 'Confirmed — marked paid.' : 'Marked paid ✅', 'success');
  } else if (action === 'confirm') {
    saveObligation({ ...ob, status: next, paidAt: new Date().toISOString(), deniedReason: null });
    showToast(`Confirmed — ${escHtml(payerName)} paid ${escHtml(recipientName)}.`, 'success');
  } else if (action === 'undo') {
    saveObligation({ ...ob, status: next, paidAt: null });
  }
}

/** Same transitions, applied to the 2K25 CARRYOVER ledger — a status-map
 *  overlay (settings.ob2025) on baked history, not a stored record. See
 *  history-2025.js `ob2025Status()` for the legacy-boolean migration story.
 *  No denial-reason prompt: the map's value shape is intentionally a bare
 *  status string ('pending'|'paid', absence=unpaid) with nowhere to carry an
 *  optional reason, so unlike the current-season ledger, deny here does not
 *  ask for one. */
function handleOb2025Action(obligationId, action) {
  const row = season2025Obligations().find(r => r.obligationId === obligationId); if (!row) return;
  const sess = getSession();
  const role = obligationRole(sess, row);
  const status = ob2025Status(getSettings().ob2025 || {}, obligationId);
  const next = obligationNextStatus(status, role, action);
  if (!next) { showToast("You don't have permission to do that", 'error'); return; }
  const applyStatus = (s) => {
    const map = { ...(getSettings().ob2025 || {}) };
    if (s === 'unpaid') delete map[obligationId]; else map[obligationId] = s;
    saveSetting('ob2025', map);
  };
  if (action === 'deny') {
    applyStatus(next);
    showToast('Denied — back to unpaid.', 'error');
  } else if (action === 'mark' && next === 'pending') {
    applyStatus(next);
    showToast(`Marked as paid — waiting on ${escHtml(row.recipientName)} or the commissioner to confirm.`, 'warning');
  } else if (action === 'mark' && next === 'paid') {
    applyStatus(next);
    showToast(role === 'creditor' ? 'Confirmed — marked paid.' : 'Marked paid ✅', 'success');
  } else if (action === 'confirm') {
    applyStatus(next);
    showToast(`Confirmed — ${escHtml(row.payerName)} paid ${escHtml(row.recipientName)}.`, 'success');
  } else if (action === 'undo') {
    applyStatus(next);
  }
}

/** v0.17.0 — 2K25 outstanding balances, visible to the whole league on the
 *  Standings tab. Paid-state syncs via settings.ob2025 (commissioner or the
 *  payer can mark). Collapsible so the current season stays front and center. */
function renderSeason2025OutstandingSection() {
  const paidMap = getSettings().ob2025 || {};
  const rows = season2025Obligations();
  // "Open" = anything not fully PAID — pending rows still owe the money, so
  // they stay counted, filtered, and rendered right alongside unpaid ones.
  const openRowsAll = rows.filter(r => ob2025Status(paidMap, r.obligationId) !== 'paid');
  const nets = season2025Nets();
  const fmtNet = n => n > 0 ? `+${n}` : `${n}`;
  const sess = getSession();
  // Filter: 'all' | 'iowe' | 'owedto'. Only shown when a player is signed in
  // (bystanders and admins in general commissioner-mode see all).
  const showFilter = !!(sess.playerId && sess.playerVerified);
  const filter = state.ob2025Filter || 'all';
  const filterRows = (rowsList) => {
    if (!showFilter || filter === 'all') return rowsList;
    if (filter === 'iowe')   return rowsList.filter(r => r.payerPlayerId    === sess.playerId);
    if (filter === 'owedto') return rowsList.filter(r => r.recipientPlayerId === sess.playerId);
    return rowsList;
  };
  const openRows = filterRows(openRowsAll);
  const netMe = sess.playerId && (() => {
    const p = getPlayer(sess.playerId);
    if (!p) return null;
    return nets[p.displayName];
  })();
  return `
    <div class="admin-section-title">🍺 2K25 Outstanding Balances</div>
    <div class="card mb-md">
      <p class="text-muted text-xs mb-sm">${openRowsAll.length} of ${rows.length} drinks from last season remain outstanding. Per league bylaw: settled IN PERSON only. Net position: ${Object.entries(nets).sort((a,b)=>b[1]-a[1]).map(([n,v])=>`${escHtml(n)} ${fmtNet(v)}`).join(' · ')}.</p>
      ${showFilter ? `
        <div class="ob-filter-tabs mb-sm">
          <button type="button" class="ob-filter-tab${filter==='all'?' active':''}" data-ob-filter="all">All (${openRowsAll.length})</button>
          <button type="button" class="ob-filter-tab${filter==='iowe'?' active':''}" data-ob-filter="iowe">What I owe (${openRowsAll.filter(r=>r.payerPlayerId===sess.playerId).length})</button>
          <button type="button" class="ob-filter-tab${filter==='owedto'?' active':''}" data-ob-filter="owedto">Owed to me (${openRowsAll.filter(r=>r.recipientPlayerId===sess.playerId).length})</button>
          ${Number.isFinite(netMe) ? `<span class="ob-net-me ${netMe>0?'net-positive':netMe<0?'net-negative':''}">Your net: ${fmtNet(netMe)}</span>` : ''}
        </div>
      ` : ''}
      ${openRows.length ? openRows.map(r => {
        const status = ob2025Status(paidMap, r.obligationId);
        return `<div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
          <div class="text-sm"><strong>${escHtml(r.payerName)}</strong> owes <strong>${escHtml(r.recipientName)}</strong> — ${escHtml(r.prize)}
            <span class="text-xs text-muted">(${escHtml(r.weekLabel)})</span></div>
          ${obligationActionsHTML(status, r, sess, { payerName: r.payerName, recipientName: r.recipientName, obClass: 'ob2025-action' })}
        </div>`;
      }).join('') : (
        showFilter && filter !== 'all'
          ? `<p class="text-muted text-sm">Nothing here — you're clear on ${filter==='iowe'?'what you owe':'what you\'re owed'}.</p>`
          : '<p class="text-muted text-sm">All settled. The ledger rests — for now.</p>'
      )}
    </div>`;
}

/** v0.17.0 — the CFP 2K25 season of record, permanently browsable. */
function renderSeason2025RecordSection() {
  const wkNames = Object.keys(SEASON_2025.weeklyScores);
  return `
    <div class="admin-section-title">📜 Historical Record — ${escHtml(SEASON_2025.label)}</div>
    <div class="card mb-md">
      <details>
        <summary style="cursor:pointer;font-weight:600;font-size:.85rem">🏆 ${escHtml(SEASON_2025.champion.name)} — ${SEASON_2025.champion.points} pts · full season record (tap to expand)</summary>
        <div class="dashboard-scroll" style="margin-top:10px">
          <table class="dashboard-table">
            <thead><tr><th>Rk</th><th>Player</th><th>Reg</th><th>EP</th><th>Conf ×2</th><th>Bowls</th><th>R1 ×2</th><th>QF ×2</th><th>Semis ×3</th><th>Total</th></tr></thead>
            <tbody>${SEASON_2025.standings.map(s=>`<tr>
              <td>${s.rank}</td><td class="player-name-cell">${escHtml(s.name)} <span class="text-xs text-muted">"${escHtml(s.alias)}"</span></td>
              <td>${s.reg}</td><td>${s.extraPt}</td><td>${s.conf}</td><td>${s.bowls}</td><td>${s.cfpR1}</td><td>${s.cfpQF}</td><td>${s.semis??'DNP'}</td><td><strong>${s.total}</strong></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="dashboard-scroll" style="margin-top:10px">
          <table class="dashboard-table">
            <thead><tr><th>Player</th>${Array.from({length:14},(_,i)=>`<th>${i+1}</th>`).join('')}<th>Reg</th></tr></thead>
            <tbody>${wkNames.map(n=>{
              const arr=SEASON_2025.weeklyScores[n];
              return `<tr><td class="player-name-cell">${escHtml(n)}</td>${arr.map(v=>`<td>${v}</td>`).join('')}<td><strong>${arr.reduce((a,b)=>a+b,0)}</strong></td></tr>`;
            }).join('')}</tbody>
          </table>
        </div>
        <div style="margin-top:10px">${SEASON_2025.superlatives.map(s=>`<div class="recap-line"><strong>${escHtml(s.label)}:</strong> ${escHtml(s.value)}</div>`).join('')}</div>
        <p class="text-muted text-xs" style="margin-top:8px">${SEASON_2025.notes.map(escHtml).join(' · ')}</p>
      </details>
    </div>`;
}

function bindSeason2025Sections(c) {
  c.querySelectorAll('.ob2025-action-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      handleOb2025Action(btn.dataset.obId, btn.dataset.obAction);
      renderLeaderboard();
    });
  });
  c.querySelectorAll('.ob-filter-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      state.ob2025Filter = btn.dataset.obFilter;
      renderLeaderboard();
    });
  });
}

function renderObligationsAdmin() {
  const obs=currentSeasonObligations(); const players=getPlayers(); const settings=getSettings();
  const sess = getSession();
  const demoCount = getObligations().length - obs.length - getObligations().filter(o=>String(o.obligationId).startsWith('ob_2025_')).length;
  const purge = demoCount>0 ? `<div class="info-box mb-sm">🧹 ${demoCount} demo-week obligation${demoCount>1?'s':''} hidden. <button class="btn btn-ghost btn-sm" id="ob-purge-demo">Purge permanently</button></div>` : '';
  if(!obs.length)return purge+'<p class="text-muted text-sm">No obligations this season — the slate is clean until Week 1 finalizes.</p>';
  return purge + obs.map(ob=>{
    const payer=players.find(p=>p.playerId===ob.payerPlayerId);
    const recip=players.find(p=>p.playerId===ob.recipientPlayerId);
    const w=getWeek(ob.weekId);
    return`<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div class="text-sm"><strong>${escHtml(payer?.displayName||'?')}</strong> owes <strong>${escHtml(recip?.displayName||'?')}</strong></div>
        <div class="text-xs text-muted">${escHtml(ob.weekId ? formatWeekLabel(w) : (ob.weekLabel||'manual'))} · ${escHtml(ob.note||ob.amountOrPrize||settings.weeklyPrize)}</div>
      </div>
      <div class="flex gap-sm" style="align-items:center">
        ${obligationActionsHTML(ob.status, ob, sess, {
          payerName: payer?.displayName || '?', recipientName: recip?.displayName || '?', obClass: 'ob-action',
        })}
        <button class="btn btn-ghost btn-sm ob-delete-btn" data-ob-id="${ob.obligationId}" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');
}

/** v0.17.0 — the 2K25 carryover ledger. Paid-state lives in settings.ob2025
 *  so the baked history data stays immutable and paid-marks sync cross-device. */
function renderSeason2025ObligationsAdmin() {
  const paidMap = getSettings().ob2025 || {};
  const rows = season2025Obligations();
  const sess = getSession();
  const open = rows.filter(r=>ob2025Status(paidMap, r.obligationId)!=='paid').length;
  return `<div class="text-xs text-muted mb-sm">${open} of ${rows.length} still outstanding · payable IN PERSON only</div>` +
    rows.map(r=>{
      const status = ob2025Status(paidMap, r.obligationId);
      return `<div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
        <div><div class="text-sm"><strong>${escHtml(r.payerName)}</strong> owes <strong>${escHtml(r.recipientName)}</strong> — ${escHtml(r.prize)}</div>
          <div class="text-xs text-muted">${escHtml(r.weekLabel)}${r.note?` · ${escHtml(r.note)}`:''}</div></div>
        ${obligationActionsHTML(status, r, sess, { payerName: r.payerName, recipientName: r.recipientName, obClass: 'ob2025-action' })}
      </div>`;
    }).join('');
}

/** Chat retention (UN-88) — commissioner Data-tab card. CLIENT-SIDE HIDE ONLY,
 *  Drew's explicit call: the backend has no row-removal endpoint, so a real
 *  delete would need a new Code.gs endpoint + redeploy (RG-09 risk) for a
 *  cosmetic gain at 6-player scale. This toggle only stops old messages from
 *  RENDERING — nothing is ever deleted, and it is fully reversible. */
function renderChatRetentionAdmin() {
  const days = getRetentionDays();
  const on = days > 0;
  const stats = on ? retentionStats() : null;
  const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const countLines = () => {
    if (!on) return '';
    if (stats.hiddenCount > 0) {
      return `<p class="text-xs mt-sm">🙈 ${stats.hiddenCount} messages are older than 7 days and hidden (${escHtml(fmtDate(stats.oldestTs))} – ${escHtml(fmtDate(stats.newestTs))})</p>
        ${stats.protectedCount > 0 ? `<p class="text-xs">🏛 ${stats.protectedCount} pinned messages in that range stay visible</p>` : ''}`;
    }
    if (stats.protectedCount > 0) {
      return `<p class="text-xs mt-sm">🏛 ${stats.protectedCount} pinned messages in that range stay visible</p>`;
    }
    return '<p class="text-xs mt-sm">Nothing is hidden yet — no messages are older than 7 days.</p>';
  };
  return `
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="chat-retention-toggle" ${on ? 'checked' : ''} />
      <span class="form-label" style="margin:0">Hide chat messages older than 7 days</span>
    </label>
    <p class="text-muted text-xs mt-sm">${on
      ? 'Older messages stop showing in chat. Nothing is deleted — flip this back off and the full history returns. 🏛 Hall of Records pins are always visible, no matter how old.'
      : 'Off — the full Locker Room history is visible.'}</p>
    ${countLines()}`;
}

function renderCommLogin(c) {
  c.innerHTML=`
    <div class="section-header"><h2>Commissioner</h2></div>
    <div class="card admin-login-card">
      <div class="text-center mb-md"><div style="font-size:2.5rem">🔐</div><h3>Commissioner Login</h3></div>
      <div class="form-group"><label class="form-label">Password</label>
        <input class="form-input" id="comm-password-input" type="password" placeholder="Password…" /></div>
      <button class="btn btn-primary btn-block" id="comm-login-btn">Login</button>
    </div>`;
  document.getElementById('comm-login-btn')?.addEventListener('click', ()=>{
    const val=document.getElementById('comm-password-input')?.value||'';
    if(btoa(val)===getSettings().adminPasswordHash){
      const s=getSession();setSession(s.playerId,true,s.playerVerified);
      showToast('✅ Commissioner access granted','success');renderCommPage();
    } else showToast('❌ Incorrect password','error');
  });
  document.getElementById('comm-password-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('comm-login-btn')?.click();});
}

function renderWeekStatusButtons(week) {
  // All status transitions — Commissioner can go in any direction for corrections
  const t={
    draft:  [{to:'open',  label:'📢 Open for Picks', cls:'btn-primary'}],
    open:   [{to:'locked',label:'🔒 Lock Week',       cls:'btn-secondary'},
             {to:'draft', label:'↩ Back to Draft',    cls:'btn-ghost'}],
    locked: [{to:'live',  label:'▶️ Go Live',         cls:'btn-secondary'},
             {to:'open',  label:'🔓 Re-open Picks',   cls:'btn-ghost'},
             {to:'draft', label:'↩ Back to Draft',    cls:'btn-ghost'}],
    live:   [{to:'final', label:'✅ Finalize',        cls:'btn-primary'},
             {to:'locked',label:'⏸ Pause (Re-lock)',  cls:'btn-secondary'},
             {to:'open',  label:'🔓 Re-open Picks',   cls:'btn-ghost'}],
    final:  [{to:'live',  label:'↩ Reopen to Live',   cls:'btn-ghost'},
             {to:'open',  label:'↩ Reopen to Open',   cls:'btn-ghost'}],
  };
  return(t[week.status]||[]).map(x=>`<button class="btn ${x.cls} btn-sm week-status-btn" data-to="${x.to}">${x.label}</button>`).join('');
}

// ─── MODALS ───────────────────────────────────────────────────────────────────

function showCreateWeekModal() {
  const allWeeks=getWeeks();
  const nextNum=allWeeks.length?Math.max(...allWeeks.map(w=>w.weekNumber))+1:1;
  const ov=document.createElement('div'); ov.className='modal-overlay centered';
  ov.innerHTML=`<div class="modal">
    <div class="modal-header"><h3>Create New Week</h3><button class="modal-close" id="cw-c">✕</button></div>
    <div class="form-group"><label class="form-label">Season</label><input class="form-input" id="cw-season" value="${getSettings().season||'2026'}" /></div>
    <div class="form-group"><label class="form-label">Week Number</label><input class="form-input" id="cw-num" type="number" value="${nextNum}" /></div>
    <div class="form-group"><label class="form-label">Custom Round Label <span class="text-muted text-xs">(e.g. 1.1, 1A — leave blank to use week number)</span></label><input class="form-input" id="cw-round" placeholder="e.g. 1.1" /></div>
    <div class="form-group"><label class="form-label">Start Date</label><input class="form-input" id="cw-start" type="date" /></div>
    <div class="form-group"><label class="form-label">End Date</label><input class="form-input" id="cw-end" type="date" /></div>
    <div class="form-group"><label class="form-label">Data Source</label>
      <select class="form-select" id="cw-mode">
        <option value="espn_live">📡 ESPN Live</option>
        <option value="espn_historical">📅 ESPN Historical</option>
        <option value="manual">✏️ Manual</option>
        <option value="demo">📋 Demo</option>
      </select></div>
    <button class="btn btn-primary btn-block" id="cw-save">Create Week</button>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#cw-c')?.addEventListener('click',()=>ov.remove());
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
  ov.querySelector('#cw-save')?.addEventListener('click',()=>{
    const season=document.getElementById('cw-season')?.value||'2026';
    const weekNum=parseInt(document.getElementById('cw-num')?.value)||nextNum;
    const roundLabel=document.getElementById('cw-round')?.value.trim()||'';
    const startDate=document.getElementById('cw-start')?.value||'';
    const endDate=document.getElementById('cw-end')?.value||'';
    const mode=document.getElementById('cw-mode')?.value||'manual';
    const newW={...createWeek(season,weekNum,startDate,endDate),dataSourceMode:mode,roundLabel};
    saveWeek(newW);setActiveWeekId(newW.weekId);
    showToast(`✅ Week ${weekNum} created`,'success');ov.remove();refreshHeader();renderCommPage();
  });
}

function showGameModal(game, week, onSave) {
  const ov=document.createElement('div');ov.className='modal-overlay centered';
  // Derive initial favorite/margin from any existing signed spread so editing
  // an existing game prefills correctly. Convention: home-perspective signed.
  let initFav = game?.favorite || '';
  let initMargin = '';
  if (game?.spread !== null && game?.spread !== undefined) {
    initMargin = Math.abs(game.spread);
    if (!initFav) {
      if (game.spread < 0) initFav = game.homeTeam || '';
      else if (game.spread > 0) initFav = game.awayTeam || '';
    }
  }
  const initMultiplier = Number(game?.multiplier) > 0 ? Number(game.multiplier) : 1;
  const initIsManual = !!game?.isManual;
  const initLeagueLabel = game?.leagueLabel || '';
  const initEspnSport = game?.espnSport || '';
  const initEspnEventId = game?.espnEventId || '';
  // Editing a game whose status has already advanced past 'scheduled' is
  // risky for the multiplier — it retroactively changes standings. We track
  // the original value so save() can prompt for confirmation.
  const originalMultiplier = initMultiplier;
  const gameHasScored = game && game.status && game.status !== 'scheduled';

  ov.innerHTML=`<div class="modal">
    <div class="modal-header"><h3>${game?'Edit Game':'Add Game'}</h3><button class="modal-close" id="mc">✕</button></div>
    <div class="flex gap-sm">
      <div class="form-group" style="flex:2"><label class="form-label">Home Team</label><input class="form-input" id="m-home" value="${escHtml(game?.homeTeam||'')}" placeholder="e.g. Oklahoma" /></div>
      <div class="form-group" style="flex:1"><label class="form-label">Home Mascot</label><input class="form-input" id="m-home-mascot" value="${escHtml(game?.homeMascot||'')}" placeholder="Sooners" /></div>
    </div>
    <div class="flex gap-sm">
      <div class="form-group" style="flex:2"><label class="form-label">Away Team</label><input class="form-input" id="m-away" value="${escHtml(game?.awayTeam||'')}" placeholder="e.g. Texas" /></div>
      <div class="form-group" style="flex:1"><label class="form-label">Away Mascot</label><input class="form-input" id="m-away-mascot" value="${escHtml(game?.awayMascot||'')}" placeholder="Longhorns" /></div>
    </div>
    <p class="text-muted text-xs mb-md">Display will be "School (Mascot)" — leave Mascot blank to use the auto lookup.</p>
    <div class="form-group"><label class="form-label">Kickoff (local time)</label>
      <input class="form-input" id="m-kickoff" type="datetime-local" value="${game?.kickoff?new Date(game.kickoff).toISOString().slice(0,16):''}" /></div>

    <div class="form-group"><label class="form-label">Spread</label>
      <div class="spread-input-row">
        <select class="form-select" id="m-spread-fav">
          <option value="">— Favorite —</option>
          <option value="home"${initFav===game?.homeTeam?' selected':''}>Home favored</option>
          <option value="away"${initFav===game?.awayTeam?' selected':''}>Away favored</option>
          <option value="pk"${game?.spread===0?' selected':''}>Pick'em (PK)</option>
        </select>
        <input class="form-input" id="m-spread-margin" type="number" step="0.5" min="0" placeholder="margin (positive)" value="${initMargin}" />
      </div>
      <p class="text-muted text-xs mt-sm">Pick which team is favored and enter the spread as a positive number.</p>
    </div>

    <!-- Scoring multiplier: 1x is a normal game, 2x etc. weights this game
         in the standings. Wins AND losses scale by the same factor.
         Tiebreakers are never multiplied. -->
    <div class="form-group modal-subsection">
      <label class="form-label">🎯 Win Multiplier
        <span class="text-muted text-xs">(marquee/rivalry weight, tiebreaker never multiplied)</span>
      </label>
      <div class="mult-input-row">
        <select class="form-select" id="m-mult-preset">
          <option value="1"${initMultiplier===1?' selected':''}>1x — Normal game</option>
          <option value="1.5"${initMultiplier===1.5?' selected':''}>1.5x</option>
          <option value="2"${initMultiplier===2?' selected':''}>2x — Marquee (rivalry, playoff)</option>
          <option value="3"${initMultiplier===3?' selected':''}>3x — Championship-tier</option>
          <option value="custom"${[1,1.5,2,3].indexOf(initMultiplier)<0?' selected':''}>Custom…</option>
        </select>
        <input class="form-input" id="m-mult-custom" type="number" step="0.5" min="0.5" max="10"
          placeholder="e.g. 2.5" value="${[1,1.5,2,3].indexOf(initMultiplier)<0?initMultiplier:''}"
          style="${[1,1.5,2,3].indexOf(initMultiplier)<0?'':'display:none'}" />
      </div>
      ${gameHasScored && initMultiplier !== 1 ? '<p class="text-warning text-xs mt-sm">⚠️ Editing multiplier on a game that has already scored will change existing standings.</p>' : ''}
    </div>

    <!-- Manual / out-of-league game toggle. When enabled, exposes fields for
         the league label, ESPN sport, and ESPN event ID so a one-off NFL
         game (or similar) can flow through the SAME scoring + polling
         pipeline as CFB games. -->
    <div class="form-group modal-subsection">
      <label class="checkbox-row">
        <input type="checkbox" id="m-is-manual" ${initIsManual?'checked':''} />
        <span><strong>This is a one-off / out-of-league game</strong>
          <span class="text-muted text-xs"> — e.g. NFL Thanksgiving, special event</span>
        </span>
      </label>
      <div id="m-manual-fields" style="${initIsManual?'':'display:none'}" class="manual-fields">
        <div class="form-group">
          <label class="form-label">League Label
            <span class="text-muted text-xs">(shown as a small chip on the game — e.g. "NFL", "Special")</span>
          </label>
          <input class="form-input" id="m-league-label" placeholder="NFL" value="${escHtml(initLeagueLabel)}" maxlength="20" />
        </div>
        <div class="form-group">
          <label class="form-label">ESPN Live Scoring
            <span class="text-muted text-xs">(optional — auto-updates scores if set)</span>
          </label>
          <div class="espn-input-row">
            <select class="form-select" id="m-espn-sport">
              <option value=""${!initEspnSport?' selected':''}>None (Manual entry only)</option>
              <option value="college-football"${initEspnSport==='college-football'?' selected':''}>College Football</option>
              <option value="nfl"${initEspnSport==='nfl'?' selected':''}>NFL</option>
            </select>
            <input class="form-input" id="m-espn-eventid"
              placeholder="ESPN event ID or gamecast URL"
              value="${escHtml(initEspnEventId)}" />
          </div>
          <div class="espn-mode-indicator" id="m-espn-mode">${initEspnSport && initEspnEventId ? '<span class="mode-pill mode-auto">🔄 Auto (ESPN-linked) — scores will update automatically</span>' : '<span class="mode-pill mode-manual">✍️ Manual entry only — you\'ll enter scores yourself</span>'}</div>
          <p class="text-muted text-xs mt-sm">Paste the ESPN gamecast URL and we'll extract the event ID automatically. Ex: <code>https://www.espn.com/nfl/game/_/gameId/401671626</code></p>
        </div>
      </div>
    </div>

    <div class="form-group"><label class="form-label">Venue (optional)</label><input class="form-input" id="m-venue" value="${escHtml(game?.venue||'')}" /></div>
    <div class="form-group"><label class="form-label">Home Conference</label><input class="form-input" id="m-hconf" value="${escHtml(game?.homeConference||'')}" /></div>
    <div class="form-group"><label class="form-label">Away Conference</label><input class="form-input" id="m-aconf" value="${escHtml(game?.awayConference||'')}" /></div>
    <div class="form-group"><label class="form-label">Home Rank (blank=unranked)</label><input class="form-input" id="m-hrank" type="number" value="${game?.homeRank||''}" /></div>
    <div class="form-group"><label class="form-label">Away Rank</label><input class="form-input" id="m-arank" type="number" value="${game?.awayRank||''}" /></div>
    ${game?`<div class="form-group"><label class="form-label">Home Final Score</label><input class="form-input" id="m-hs" type="number" value="${game.homeScore??''}" /></div>
    <div class="form-group"><label class="form-label">Away Final Score</label><input class="form-input" id="m-as" type="number" value="${game.awayScore??''}" /></div>
    <div class="form-group"><label class="form-label">Status</label>
      <select class="form-select" id="m-status">
        <option value="scheduled"${game.status==='scheduled'?' selected':''}>Scheduled</option>
        <option value="live"${game.status==='live'?' selected':''}>Live</option>
        <option value="final"${game.status==='final'?' selected':''}>Final</option>
      </select></div>`:''}
    <button class="btn btn-primary btn-block" id="m-save">Save Game</button>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#mc')?.addEventListener('click',()=>ov.remove());
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});

  // Show/hide the custom multiplier input based on the preset dropdown
  const multPreset = ov.querySelector('#m-mult-preset');
  const multCustom = ov.querySelector('#m-mult-custom');
  multPreset?.addEventListener('change', () => {
    if (multPreset.value === 'custom') {
      multCustom.style.display = '';
      multCustom.focus();
    } else {
      multCustom.style.display = 'none';
    }
  });

  // Toggle manual-fields visibility when the checkbox flips
  const manualCheck = ov.querySelector('#m-is-manual');
  const manualFields = ov.querySelector('#m-manual-fields');
  manualCheck?.addEventListener('change', () => {
    manualFields.style.display = manualCheck.checked ? '' : 'none';
  });

  // Live-update the "Auto vs Manual" pill as the commissioner types
  const espnSportSel = ov.querySelector('#m-espn-sport');
  const espnEvIdInp  = ov.querySelector('#m-espn-eventid');
  const espnMode     = ov.querySelector('#m-espn-mode');
  const updateEspnMode = () => {
    if (!espnMode) return;
    const hasEv = (espnEvIdInp?.value || '').trim().length > 0;
    const hasSport = (espnSportSel?.value || '').length > 0;
    espnMode.innerHTML = hasEv && hasSport
      ? '<span class="mode-pill mode-auto">🔄 Auto (ESPN-linked) — scores will update automatically</span>'
      : '<span class="mode-pill mode-manual">✍️ Manual entry only — you\'ll enter scores yourself</span>';
  };
  espnSportSel?.addEventListener('change', updateEspnMode);
  espnEvIdInp?.addEventListener('input', updateEspnMode);

  ov.querySelector('#m-save')?.addEventListener('click',()=>{
    const ht=document.getElementById('m-home')?.value.trim();
    const at=document.getElementById('m-away')?.value.trim();
    if(!ht||!at){showToast('Teams required','error');return;}
    const hMasc=document.getElementById('m-home-mascot')?.value.trim()||'';
    const aMasc=document.getElementById('m-away-mascot')?.value.trim()||'';
    const kr=document.getElementById('m-kickoff')?.value;
    const kickoff=kr?new Date(kr).toISOString():null;
    if(!kickoff && !game){
      if(!confirm('No kickoff date/time is set. This game will be hidden from players and shown as "pending confirmation" until you set a date. Add it anyway?')) return;
    }
    const favPick = document.getElementById('m-spread-fav')?.value || '';
    const marginRaw = document.getElementById('m-spread-margin')?.value;
    const marginVal = marginRaw !== '' && marginRaw !== undefined ? Math.abs(parseFloat(marginRaw)) : null;
    let spread = null, fav = null;
    if (favPick === 'pk') { spread = 0; fav = null; }
    else if (favPick === 'home' && marginVal !== null && !isNaN(marginVal)) { spread = -marginVal; fav = ht; }
    else if (favPick === 'away' && marginVal !== null && !isNaN(marginVal)) { spread = marginVal; fav = at; }

    // Resolve multiplier from preset or custom field
    let multiplier = 1;
    if (multPreset) {
      if (multPreset.value === 'custom') {
        const cv = Number(multCustom?.value);
        multiplier = Number.isFinite(cv) && cv > 0 ? cv : 1;
      } else {
        multiplier = Number(multPreset.value) || 1;
      }
    }
    // Protect standings: prompt before applying a multiplier change to a game
    // whose scoring has already occurred.
    if (game && gameHasScored && multiplier !== originalMultiplier) {
      const ok = confirm(
        `You're changing this game's multiplier from ${originalMultiplier}x to ${multiplier}x.\n\n` +
        `This will change standings retroactively for every player.\n\nContinue?`
      );
      if (!ok) return;
    }

    // Manual game fields
    const isManual = !!document.getElementById('m-is-manual')?.checked;
    const leagueLabel = isManual ? (document.getElementById('m-league-label')?.value.trim() || '') : '';
    const espnSport = isManual ? (document.getElementById('m-espn-sport')?.value || null) || null : null;
    // ESPN event ID: accept either the bare ID or a gamecast URL; extract the digits.
    let espnEventId = null;
    if (isManual) {
      const raw = (document.getElementById('m-espn-eventid')?.value || '').trim();
      if (raw) {
        // URLs look like https://www.espn.com/nfl/game/_/gameId/401671626
        const m = raw.match(/gameId[/=](\d+)/) || raw.match(/^(\d{6,})$/);
        espnEventId = m ? m[1] : raw;
      }
    } else {
      // Non-manual games: preserve any existing pipeline-set espnEventId
      espnEventId = game?.espnEventId || null;
    }

    const venue=document.getElementById('m-venue')?.value.trim()||null;
    const hconf=document.getElementById('m-hconf')?.value.trim()||'';
    const aconf=document.getElementById('m-aconf')?.value.trim()||'';
    const hr=parseInt(document.getElementById('m-hrank')?.value)||null;
    const ar=parseInt(document.getElementById('m-arank')?.value)||null;
    const hs=game?(document.getElementById('m-hs')?.value!==''?parseFloat(document.getElementById('m-hs')?.value):null):null;
    const as_=game?(document.getElementById('m-as')?.value!==''?parseFloat(document.getElementById('m-as')?.value):null):null;
    const status=game?document.getElementById('m-status')?.value||'scheduled':'scheduled';
    const isAlma=!!(getAlmaMaterMatch(ht) || getAlmaMaterMatch(at));
    const tw=getTimeWindow(kickoff);
    let actualWinner=null;
    if(status==='final'&&hs!==null&&as_!==null){if(hs>as_)actualWinner=ht;else if(as_>hs)actualWinner=at;}
    let atsWinner = game?.atsWinner ?? null;
    if (status === 'final' && hs !== null && as_ !== null && spread !== null) {
      const adj = hs + spread;
      const diff = adj - as_;
      if (Math.abs(diff) < 0.01) atsWinner = 'no_decision';
      else atsWinner = diff > 0 ? ht : at;
    } else if (status !== 'final') {
      atsWinner = null;
    }
    onSave({homeTeam:ht,awayTeam:at,homeMascot:hMasc,awayMascot:aMasc,
      kickoff,spread,favorite:fav,venue,
      homeConference:hconf,awayConference:aconf,homeRank:hr,awayRank:ar,
      homeScore:hs,awayScore:as_,status,actualWinner,atsWinner,isAlmaMaterGame:isAlma,
      multiplier, isManual, leagueLabel, espnSport, espnEventId,
      timeWindow:tw,spreadSource:'manual',dataQuality:'manual',dataSource:'manual',
      kickoffConfirmed:!!kickoff,
      lastUpdated:new Date().toISOString()});
    ov.remove();
  });
}

function showEditPlayerModal(playerId) {
  const player=getPlayer(playerId); if(!player)return;
  const ov=document.createElement('div');ov.className='modal-overlay centered';
  ov.innerHTML=`<div class="modal">
    <div class="modal-header"><h3>Edit Player</h3><button class="modal-close" id="ep-c">✕</button></div>
    <div class="form-group"><label class="form-label">Display Name</label><input class="form-input" id="ep-name" value="${escHtml(player.displayName)}" /></div>
    <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="ep-email" type="email" value="${escHtml(player.email||'')}" /></div>
    <div class="form-group"><label class="form-label">Alma Mater</label>
      <select class="form-select" id="ep-alma">
        <option value="">None</option>
        ${ALMA_MATERS.map(am=>`<option value="${am}"${player.almaMater===am?' selected':''}>${am}</option>`).join('')}
      </select></div>
    <p class="text-muted text-xs mb-md">Name changes keep all historical picks linked to this player.</p>
    <button class="btn btn-primary btn-block" id="ep-save">Save</button>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#ep-c')?.addEventListener('click',()=>ov.remove());
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
  ov.querySelector('#ep-save')?.addEventListener('click',()=>{
    const n=document.getElementById('ep-name')?.value.trim();
    if(!n){showToast('Name required','error');return;}
    savePlayer({...player,displayName:n,email:document.getElementById('ep-email')?.value.trim()||'',almaMater:document.getElementById('ep-alma')?.value||''});
    showToast('Updated ✅','success');ov.remove();renderCommPage();
  });
}

function showResetPinModal(playerId, displayName) {
  const ov=document.createElement('div');ov.className='modal-overlay centered';
  ov.innerHTML=`<div class="modal">
    <div class="modal-header"><h3>Reset PIN — ${escHtml(displayName)}</h3><button class="modal-close" id="rp-c">✕</button></div>
    <p class="text-secondary text-sm mb-md">Set a new PIN for ${escHtml(displayName)}. This does not affect their picks.</p>
    <div class="form-group"><label class="form-label">New PIN (4–8 digits)</label>
      <input class="form-input" id="rp-pin" type="password" inputmode="numeric" maxlength="8" placeholder="e.g. 1234"
        style="letter-spacing:.2em;font-size:1.2rem" /></div>
    <div class="form-group"><label class="form-label">Confirm PIN</label>
      <input class="form-input" id="rp-pin2" type="password" inputmode="numeric" maxlength="8"
        style="letter-spacing:.2em;font-size:1.2rem" /></div>
    <button class="btn btn-primary btn-block" id="rp-save">Set PIN</button>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#rp-c')?.addEventListener('click',()=>ov.remove());
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
  ov.querySelector('#rp-save')?.addEventListener('click',()=>{
    const pin=document.getElementById('rp-pin')?.value;
    const pin2=document.getElementById('rp-pin2')?.value;
    if(!pin||pin.length<4){showToast('PIN must be at least 4 digits','error');return;}
    if(pin!==pin2){showToast('PINs do not match','error');return;}
    setPlayerPin(playerId,pin);
    showToast(`✅ PIN updated for ${escHtml(displayName)}`,'success');ov.remove();renderCommPage();
  });
}

// ─── RULES PAGE ───────────────────────────────────────────────────────────────

function renderRulesPage() {
  const c=document.getElementById('page-rules'); if(!c)return;
  const rules=getSettings().customRules||DEFAULT_RULES;
  c.innerHTML=`
    <div class="section-header"><h2>How to Play</h2><div class="subtitle">Rules · FAQ · Permissions</div></div>

    <!-- v0.16.0 — What to do & when: the week lifecycle -->
    <div class="card mb-md">
      <div class="rules-section"><h3>🗓 The Week Lifecycle — what you can do &amp; when</h3>
        <div class="faq-lifecycle">
          <div class="faq-stage"><span class="badge badge-draft">DRAFT</span>
            <div><strong>Commissioner is building the slate.</strong> Players can't see or pick anything yet. Sit tight.</div></div>
          <div class="faq-stage"><span class="badge badge-open">OPEN</span>
            <div><strong>Picks are open.</strong> Log in on the Picks tab, pick all games against the spread, answer the tiebreaker, and (optionally) enter your Ischemic Extra Point guess. Submit. <em>You can come back and edit everything — picks, tiebreaker, Extra Point — as many times as you want until lock.</em> Picks are blind: nobody sees anyone else's picks until they've submitted their own.</div></div>
          <div class="faq-stage"><span class="badge badge-locked">LOCKED</span>
            <div><strong>The week has locked.</strong> No new picks, no edits — for anyone, including games that haven't kicked off yet. If you missed the deadline, that's a documented adverse event. The Commissioner can grant a per-game unlock in genuine emergencies (their call, on the record).</div></div>
          <div class="faq-stage"><span class="badge badge-live">LIVE</span>
            <div><strong>Games are being played.</strong> The Dashboard is public — everyone's picks are visible, scores stream in from ESPN, and each pick shows a soft "covering / trailing" state. Nothing is final until the game is final. This is prime chat time.</div></div>
          <div class="faq-stage"><span class="badge badge-final">FINAL</span>
            <div><strong>The week is graded.</strong> ATS results are locked against the closing spread, the tiebreaker and Extra Point resolve, standings update, and drink debts post to the ledger. The week becomes browsable read-only from the Picks tab (‹ › arrows).</div></div>
        </div>
      </div>
    </div>

    <!-- v0.16.0 — Who can do what -->
    <div class="card mb-md">
      <div class="rules-section"><h3>🔑 Permissions — who can do what</h3>
        <table class="faq-perms"><thead><tr><th></th><th>Player</th><th>Commissioner</th></tr></thead><tbody>
          <tr><td>Make / edit own picks (while OPEN)</td><td>✅</td><td>✅</td></tr>
          <tr><td>Edit picks after LOCK</td><td>❌</td><td>⚠️ per-game unlock only, logged</td></tr>
          <tr><td>See others' picks before submitting</td><td>❌ never</td><td>✅ (admin view)</td></tr>
          <tr><td>Change tiebreaker / Extra Point (while OPEN)</td><td>✅</td><td>✅</td></tr>
          <tr><td>Build the slate, set spreads, lock the week</td><td>❌</td><td>✅</td></tr>
          <tr><td>Enter/override scores &amp; the Extra Point actual</td><td>❌</td><td>✅</td></tr>
          <tr><td>Finalize the week, reopen for corrections</td><td>❌</td><td>✅</td></tr>
          <tr><td>Chat, react, reply</td><td>✅</td><td>✅</td></tr>
          <tr><td>Edit own chat message</td><td>✅ within 5 min</td><td>✅ within 5 min</td></tr>
          <tr><td>Delete own chat message</td><td>✅ (tombstone stays)</td><td>✅</td></tr>
          <tr><td>Reset PINs, manage players, exports, resets</td><td>❌</td><td>✅</td></tr>
        </tbody></table>
        <p class="text-muted text-xs mt-sm">The app never leaks picks: automated posts announce <em>that</em> you locked picks (e.g. "Kevin locked 6/6") — never <em>what</em> you picked — until lock time.</p>
      </div>
    </div>

    <!-- v0.16.0 — Extra Point -->
    <div class="card mb-md">
      <div class="rules-section"><h3>🎯 The Ischemic Extra Point (blackjack rules)</h3>
        <ul class="rules-list">
          <li>Each week, guess the <strong>longest MADE field goal on the slate</strong>, in yards.</li>
          <li><strong>Closest without going over wins.</strong> Any guess over the actual is a <strong>bust</strong> — you're out.</li>
          <li>Hit it exactly = <strong>Blackjack</strong>. Outright win, beats everything.</li>
          <li>Tied winning guesses share the win. Everyone busts → the house (the chart) wins.</li>
          <li>Optional side bet — skipping it just means you can't win it. The actual is auto-detected from ESPN scoring plays and verified by the Commissioner.</li>
        </ul>
      </div>
    </div>

    <!-- v0.17.0 — Chat rules -->
    <div class="card mb-md">
      <div class="rules-section"><h3>💬 Chat</h3>
        <ul class="rules-list">
          <li><strong>One Locker Room.</strong> Everything happens in the main chat. Any message can be tagged to a game — tap 💬 on a game card and your post shows up both in that game's thread and in the Locker Room. Replies inherit the tag, so conversations stay findable. Untag with one tap if the talk drifts.</li>
          <li>React, reply, pin to the 🏛 Hall of Records, edit your own messages within 5 minutes, withdraw with a tombstone. The log is append-only.</li>
          <li>At lock, the Locker Room gets <strong>the reveal</strong> — everyone's picks posted at once. Game finals, standings, and Extra Point results file in automatically. Nothing ever leaks a pick before lock.</li>
          <li><strong>S.C.R.I.B.E. is the seventh member of this league.</strong> Records custodian, attending physician of the chart. It documents lock times, adverse events, live-game complications, and outstanding balances on its own schedule — and it answers when addressed. It is not summoned. It is on duty.</li>
          <li>House rule, inherited and non-negotiable: savage about football, never about real life.</li>
        </ul>
      </div>
    </div>

    <div class="card mb-md">
      ${rules.map(s=>`<div class="rules-section"><h3>${escHtml(s.section)}</h3>
        <ul class="rules-list">${s.items.map(i=>`<li>${escHtml(i)}</li>`).join('')}</ul>
      </div><div class="divider"></div>`).join('')}
      <div class="rules-section"><h3>⭐ Alma Maters</h3>
        <ul class="rules-list">${ALMA_MATERS.map(am=>`<li>${am}</li>`).join('')}</ul>
      </div>
      <div class="divider"></div>
      <div class="rules-section"><h3>🍺 Debts &amp; Bylaws</h3>
        <ul class="rules-list">
          <li>Weekly loser owes the weekly winner. Season loser owes the season winner.</li>
          <li>All outstanding balances are settled <strong>IN PERSON only</strong>, per league bylaw. No exceptions, no Venmo.</li>
          <li>The ledger lives in the app. The ledger forgets nothing.</li>
        </ul>
      </div>
    </div>
    <div class="card"><h3 style="color:var(--maroon);margin-bottom:8px">📱 Install as iPhone App</h3>
      <p class="text-secondary text-sm">Open in Safari → Share → <strong>Add to Home Screen</strong>.</p>
    </div>

    <!-- Priority 13: low-profile feedback / feature-request form -->
    <div class="card feedback-card">
      <h3 style="color:var(--maroon);margin-bottom:6px;font-size:.95rem">💡 Suggest a feature / report an issue</h3>
      <p class="text-muted text-xs mb-sm">Quick way to send the Commissioner an idea or a bug. Auto-fills your name, the date, and the app version.</p>
      <div class="form-group" style="margin-bottom:8px">
        <label class="form-label" style="font-size:.7rem">Your name</label>
        <input class="form-input" id="fb-name" type="text" value="${escHtml(getCurrentPlayerName())}" />
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <label class="form-label" style="font-size:.7rem">Description</label>
        <textarea class="form-input" id="fb-body" rows="3" placeholder="What's the request, bug, or idea?"></textarea>
      </div>
      <div class="flex gap-sm flex-wrap">
        <button class="btn btn-primary btn-sm" id="fb-submit-btn">📨 Send to Commissioner</button>
        <span class="text-muted text-xs" id="fb-status"></span>
      </div>
    </div>

    <div class="app-version-footer" title="Build version">
      CFB Pickems ${escHtml(APP_VERSION)} · ${escHtml(APP_VERSION_DATE)}
    </div>`;

  // Wire feedback handler (Priority 13)
  document.getElementById('fb-submit-btn')?.addEventListener('click', submitFeedback);
}

/**
 * Resolve the current player's display name for pre-filling forms.
 * Returns empty string when not logged in — the user can type their name.
 */
function getCurrentPlayerName() {
  const s = getSession();
  if (!s?.playerId) return '';
  const p = getPlayer(s.playerId);
  return p?.displayName || '';
}

/**
 * Send a feedback / feature-request submission.
 * - Always opens the user's mail client (mailto:) to the Commissioner email
 *   if one is configured in settings.commissionerEmail, otherwise a generic
 *   subject line they can paste anywhere.
 * - Additionally writes the entry to a `cfbp_feedback` list which syncs to
 *   the Google Sheet automatically (via the storage seam) when cloud sync
 *   is enabled — that's the "separate sheet" the priority asked for, without
 *   us needing a second API.
 */
function submitFeedback() {
  const name = (document.getElementById('fb-name')?.value || '').trim();
  const body = (document.getElementById('fb-body')?.value || '').trim();
  const status = document.getElementById('fb-status');
  if (!body) { showToast('Please describe the request or issue first','error'); return; }
  const entry = {
    id: 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    name: name || '(anonymous)',
    body,
    submittedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    siteUrl: typeof window !== 'undefined' ? (window.location.origin + window.location.pathname) : '',
  };
  // Append to local store — auto-syncs to Sheet when cloud sync is on
  appendFeedback(entry);
  // Open mail client to the commissioner
  const commEmail = (getSettings().commissionerEmail || '').trim();
  const subject = `CFB Pickems feedback — ${entry.name}`;
  const mailBody =
    `Submitted: ${new Date(entry.submittedAt).toLocaleString()}\n` +
    `App version: ${APP_VERSION}\n` +
    `From: ${entry.name}\n` +
    `Site: ${entry.siteUrl}\n\n` +
    `${entry.body}\n`;
  const mailto = `mailto:${encodeURIComponent(commEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}`;
  if (commEmail) window.location.href = mailto;
  if (status) status.textContent = commEmail
    ? '✅ Saved + opening mail client'
    : '✅ Saved. (No Commissioner email set yet — ask them to add one in Comm → Security.)';
  document.getElementById('fb-body').value = '';
  showToast('Thanks! Feedback recorded.','success');
}

// ─── v0.16.0 COMMISSIONER EXTRAS (Extra Point + Chat / SCRIBE) ────────────────

function renderCommExtrasV16(week, games) {
  // v0.17.0 FIX — these cards previously appended UNWRAPPED to the page
  // container, so they showed on EVERY comm tab and after the demo panel.
  // Now: Extra Point lives in the Week tab (inserted BEFORE Demo Simulation,
  // which stays last per league preference); Chat & SCRIBE lives in Settings.
  const c = document.getElementById('page-commissioner'); if (!c || !week) return;
  const session = getSession();
  if (!session.isAdmin) return;

  const detect = week.extraPointDetect;
  const graded = week.extraPointActual != null ? gradeWeekExtraPoint(week, getPlayers().filter(p=>p.active)) : null;
  const guesses = getPlayers().filter(p=>p.active).map(p => {
    const g = getExtraPointGuess(week.weekId, p.playerId);
    return `<span class="ep-admin-guess">${escHtml(p.displayName)}: <strong>${g == null ? '—' : g + ' yd'}</strong></span>`;
  }).join(' ');

  const epHTML = `
    <div class="admin-section" data-comm-tab="week">
    <div class="card mb-md" id="comm-ep-card">
      <h3 style="color:var(--maroon)">🎯 Ischemic Extra Point — ${escHtml(formatWeekLabel(week))}</h3>
      <p class="text-muted text-xs">Longest made FG on the slate, blackjack rules. Detect pulls per-game scoring plays from ESPN; you can always override manually.</p>
      <div class="mb-sm"><label class="form-label" style="font-size:.7rem">Guesses on file</label><div class="ep-admin-guesses">${guesses || '<span class="text-muted">none yet</span>'}</div></div>
      <div class="flex gap-sm flex-wrap mb-sm">
        <button class="btn btn-secondary btn-sm" id="ep-detect-btn">🛰 Detect Longest FG (ESPN)</button>
        <span class="text-muted text-xs" id="ep-detect-status">${detect ? escHtml(`${detect.yards} yd — ${detect.text || ''} (${detect.matchup || ''})`) : ''}</span>
      </div>
      <div class="flex gap-sm flex-wrap" style="align-items:flex-end">
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:.7rem">Actual longest FG (yards)</label>
          <input class="form-input" id="ep-actual-input" type="number" min="15" max="75" style="width:110px"
            value="${week.extraPointActual != null ? week.extraPointActual : ''}" />
        </div>
        <button class="btn btn-primary btn-sm" id="ep-save-btn">Save &amp; Grade</button>
        ${graded ? '<button class="btn btn-ghost btn-sm" id="ep-post-btn">📣 Post result to chat</button>' : ''}
      </div>
      <div id="ep-graded-preview">${graded ? renderExtraPointResultsHTML(week, graded, escHtml) : ''}</div>
    </div>
    </div>`;
  // Insert the Extra Point card BEFORE the Demo Simulation section so the demo
  // panel remains the LAST item in the Week tab.
  const demoSection = [...c.querySelectorAll('.admin-section[data-comm-tab="week"]')]
    .find(s => s.textContent.includes('Demo Simulation'));
  if (demoSection) demoSection.insertAdjacentHTML('beforebegin', epHTML);
  else c.insertAdjacentHTML('beforeend', epHTML);

  {
    // Item A — commissioner chat on/off toggle. Placement: TOP of this
    // existing card (RG-10: inside data-comm-tab="settings"), not a new
    // card — a master on/off switch belongs above the features it governs.
    const chatOn = isChatEnabled();
    c.insertAdjacentHTML('beforeend', `
    <div class="admin-section" data-comm-tab="settings">
    <div class="card mb-md" id="comm-chat-card">
      <h3 style="color:var(--maroon)">📋 Chat &amp; S.C.R.I.B.E.</h3>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--border)">
        <input type="checkbox" id="chat-enabled-toggle" ${chatOn ? 'checked' : ''} />
        <span class="form-label" style="margin:0">Chat enabled</span>
      </label>
      <p class="text-muted text-xs mb-sm">${chatOn
        ? 'Players can see and use chat. Turn off to hide it league-wide while you work on it.'
        : 'Chat is hidden for everyone. Nothing is deleted — history returns when you turn it back on. Polling is stopped.'}</p>
      <div class="divider"></div>
      <p class="text-muted text-xs">Tier 0 (deterministic lines) runs automatically with rate limits. Tier 1 lets you paste a reviewed batch of SCRIBE posts. The digest feeds recap generation.</p>
      <div class="flex gap-sm flex-wrap mb-sm">
        <button class="btn btn-secondary btn-sm" id="chat-digest-btn">📤 Copy weekly digest JSON</button>
        <span class="text-muted text-xs" id="chat-digest-status"></span>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:.7rem">SCRIBE queue (Tier 1) — paste JSON: [{"channel":"general","body":"…","postAt":"2026-08-29T18:00Z"}]</label>
        <textarea class="form-input" id="scribe-queue-input" rows="3" placeholder='[{"channel":"general","body":"SCRIBE NOTE: …"}]'></textarea>
      </div>
      <div class="flex gap-sm flex-wrap mb-sm">
        <button class="btn btn-primary btn-sm" id="scribe-queue-btn">Post queue as SCRIBE</button>
        <span class="text-muted text-xs" id="scribe-queue-status"></span>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:.7rem">Season recap blurb (shows on Week 1 under "The Permanent Record")</label>
        <textarea class="form-input" id="season-recap-input" rows="3">${escHtml(getSettings().seasonRecapText || '')}</textarea>
      </div>
      <button class="btn btn-secondary btn-sm" id="season-recap-save">Save blurb</button>
      <div class="divider"></div>
      <div class="mb-sm"><strong style="font-size:.8rem">🩺 Chat diagnostics</strong>
        <p class="text-muted text-xs">Tests the deployed Apps Script for the chat endpoints — the v0.16 outage was an out-of-date deployment, which this detects in one click.</p>
        <div class="flex gap-sm flex-wrap">
          <button class="btn btn-secondary btn-sm" id="chat-diag-btn">Run test</button>
          <span class="text-muted text-xs" id="chat-diag-out"></span>
        </div>
      </div>
      <div class="mb-sm"><strong style="font-size:.8rem">📈 Backend load (last 7 days)</strong>
        <div id="chat-metrics-out" class="text-muted text-xs">—</div>
      </div>
    </div>
    </div>`);
  }

  // ── handlers ──
  document.getElementById('chat-enabled-toggle')?.addEventListener('change', e => {
    saveSetting('chatEnabled', e.target.checked);
    try { refreshChatEnabled(); } catch {}
    try { applyChatNavVisibility(); } catch {}
    showToast(e.target.checked
      ? '💬 Chat enabled — visible to everyone'
      : '🙈 Chat disabled — hidden league-wide, nothing deleted', 'success');
    renderCommPage();
  });
  document.getElementById('ep-detect-btn')?.addEventListener('click', async () => {
    const st = document.getElementById('ep-detect-status');
    if (st) st.textContent = '⏳ Fetching scoring plays…';
    try {
      const r = await detectLongestFieldGoal(games);
      if (r.best) {
        saveWeek({ ...getWeek(week.weekId), extraPointDetect: r.best });
        const inp = document.getElementById('ep-actual-input');
        if (inp && !inp.value) inp.value = r.best.yards;
        if (st) st.textContent = `${r.best.yards} yd — ${r.best.text} (${r.best.matchup})` + (r.skipped.length ? ` · ${r.skipped.length} game(s) skipped` : '');
        showToast(`🎯 Longest FG detected: ${r.best.yards} yards`, 'success');
      } else {
        if (st) st.textContent = 'No made FGs found' + (r.skipped.length ? ` (${r.skipped.length} game(s) unavailable)` : '');
        showToast('No field goals found in the slate data yet', 'warning');
      }
      if (r.skipped.length) console.warn('[ExtraPoint] skipped:', r.skipped);
    } catch (e) { if (st) st.textContent = '❌ ' + (e.message || e); }
  });

  document.getElementById('ep-save-btn')?.addEventListener('click', () => {
    const v = parseInt(document.getElementById('ep-actual-input')?.value, 10);
    if (!Number.isFinite(v)) { showToast('Enter the actual longest FG first', 'error'); return; }
    saveWeek({ ...getWeek(week.weekId), extraPointActual: v });
    showToast('✅ Extra Point actual saved & graded', 'success');
    renderCommPage();
  });

  document.getElementById('ep-post-btn')?.addEventListener('click', () => {
    const g = gradeWeekExtraPoint(getWeek(week.weekId), getPlayers().filter(p=>p.active));
    if (g) { emitExtraPointEvent(week.weekId, g); showToast('📣 Posted to chat', 'success'); }
  });

  document.getElementById('chat-digest-btn')?.addEventListener('click', async () => {
    const st = document.getElementById('chat-digest-status');
    try {
      const players = getPlayers().filter(p=>p.active);
      const wkGames = getGames(week.weekId);
      const picks = getPicks(week.weekId);
      const atsLossesByPlayer = {};
      players.forEach(p => {
        atsLossesByPlayer[p.playerId] = picks
          .filter(pk => pk.playerId === p.playerId)
          .filter(pk => { const g = wkGames.find(x => x.gameId === pk.gameId); const ats = g?.atsWinner; return ats && ats !== 'no_decision' && ats !== pk.selectedTeam; })
          .map(pk => pk.gameId);
      });
      const start = week.startDate ? new Date(week.startDate + 'T00:00:00').getTime() - 4*86400000 : Date.now() - 7*86400000;
      const end = week.endDate ? new Date(week.endDate + 'T23:59:59').getTime() + 2*86400000 : Date.now();
      const digest = chatDigest(start, end, { players, games: wkGames, atsLossesByPlayer, week: week.weekNumber });
      await navigator.clipboard.writeText(JSON.stringify(digest, null, 2));
      if (st) st.textContent = '✅ Copied to clipboard';
    } catch (e) { if (st) st.textContent = '❌ ' + (e.message || e); }
  });

  document.getElementById('scribe-queue-btn')?.addEventListener('click', () => {
    const st = document.getElementById('scribe-queue-status');
    try {
      const arr = JSON.parse(document.getElementById('scribe-queue-input')?.value || '[]');
      if (!Array.isArray(arr) || !arr.length) throw new Error('Paste a non-empty JSON array');
      let posted = 0, deferred = 0;
      const now = Date.now();
      arr.forEach((item, i) => {
        const at = item.postAt ? new Date(item.postAt).getTime() : 0;
        if (at && at > now) { deferred++; return; }   // scheduling proper lands with Tier 1
        if (!item.body) return;
        sendChatEvent({
          type: 'message', gameTag: item.gameTag || '', body: String(item.body),
          author: 'scribe', meta: { source: 'tier1' },
        });
        posted++;
      });
      if (st) st.textContent = `✅ Posted ${posted}` + (deferred ? ` · ${deferred} future-dated skipped (scheduling ships with Tier 1)` : '');
    } catch (e) { if (st) st.textContent = '❌ ' + (e.message || e); }
  });

  document.getElementById('season-recap-save')?.addEventListener('click', () => {
    saveSetting('seasonRecapText', document.getElementById('season-recap-input')?.value || '');
    showToast('✅ Season recap blurb saved', 'success');
  });

  document.getElementById('chat-diag-btn')?.addEventListener('click', async () => {
    const out = document.getElementById('chat-diag-out');
    if (out) out.textContent = '⏳ testing…';
    try {
      const mod = await import('./chatTransport.js');
      const { head } = await mod.fetchHead();
      if (out) out.textContent = `✅ Chat backend OK — head at seq ${head}. Deployment is current.`;
    } catch (e) {
      if (out) out.textContent = e?.stale
        ? '❌ DEPLOYMENT OUT OF DATE — the deployed Apps Script has no chat endpoints. Paste the new Code.gs, then Deploy → Manage deployments → Edit → New version (same URL).'
        : '❌ ' + (e.message || e);
    }
  });

  (async () => {
    const out = document.getElementById('chat-metrics-out');
    if (!out) return;
    try {
      const { rows } = await fetchChatMetrics(7);
      if (!rows.length) { out.textContent = 'No metrics yet — they accrue once chat traffic starts.'; return; }
      out.innerHTML = rows.map(r => {
        const total = r.execCount || 0;
        const warn = total > 2500 ? ' style="color:#B02A37;font-weight:700"' : total > 1600 ? ' style="color:#B8860B;font-weight:600"' : '';
        return `<span${warn}>${escHtml(r.date)}: ${total} calls (${r.appendCount||0} sends, ${r.headHit||0}/${(r.headHit||0)+(r.headMiss||0)} head cache hits)</span>`;
      }).join(' · ');
    } catch { out.textContent = 'Metrics unavailable (older deployment or offline).'; }
  })();
}

// ─── FINALIZATION ─────────────────────────────────────────────────────────────

function finalizeWeek(week) {
  const players=getPlayers().filter(p=>p.active);
  const picks=getPicks(week.weekId);
  const games=getGames(week.weekId);
  games.forEach(g=>{
    if(g.status===GAME_STATUS.FINAL&&g.lockedSpread!==null)
      saveGame({...g,atsWinner:calculateAtsWinner(g)});
  });
  const freshGames=getGames(week.weekId);
  const results=calculateWeeklyResults(week.weekId,players,picks,freshGames,week.actualTiebreakerValue);
  saveAllWeeklyResults(week.weekId,results);
  // v0.16.0 — chat system events + Extra Point grading (deterministic ids ⇒
  // exactly-once even if several devices finalize/re-finalize).
  try {
    const ranked=[...results].sort((a,b)=>(a.rank??99)-(b.rank??99));
    emitWeekFinalEvent(week, ranked);
    freshGames.forEach(g=>{
      const ats=g.atsWinner; if(!ats) return;
      const gp=picks.filter(p=>p.gameId===g.gameId);
      emitGameFinalEvent(g, ats,
        gp.filter(p=>p.selectedTeam===ats).map(p=>p.playerId),
        gp.filter(p=>p.selectedTeam!==ats&&ats!=='no_decision').map(p=>p.playerId));
    });
    if (week.extraPointActual!=null) {
      const graded=gradeWeekExtraPoint(week, players);
      if (graded) emitExtraPointEvent(week.weekId, graded);
    }
  } catch(e){ console.warn('[finalizeWeek] chat events', e); }
  const settings=getSettings();
  const winner=results.find(r=>r.isWinner);
  const loser=results.find(r=>r.isLoser);
  if(winner&&loser){
    const existing=getObligations(week.weekId);
    if(!existing.find(o=>o.type==='weekly'))
      // v0.17.0 — demo weeks NEVER generate real obligations
      if (week.dataSourceMode !== 'demo') {
        saveObligation(createObligation(week.weekId,loser.playerId,winner.playerId,settings.weeklyPrize));
      }
  }
}

// ─── AUTO REFRESH ─────────────────────────────────────────────────────────────

let _refreshTimer=null;

function setupAutoRefresh() {
  if(_refreshTimer)clearInterval(_refreshTimer);
  const{autoRefreshInterval=60}=getSettings();
  if(!autoRefreshInterval)return;
  _refreshTimer=setInterval(async()=>{
    // Auto-transition check runs EVERY tick regardless of active tab or week
    // mode (demo weeks are skipped inside the helper). Transitions affect all
    // users so whichever device ticks first writes the new status to the
    // shared backend and everyone else picks it up on next hydrate.
    tickAutoTransition();

    if(state.currentTab!=='dashboard') return;
    const week=getCurrentWeek();
    if(!week) return;
    // Skip auto-refresh entirely for demo or fully-manual weeks. Otherwise the
    // simulated scores get walked over by whatever ESPN currently returns —
    // which is what was causing "demo resets after a few seconds."
    if (week.dataSourceMode === 'demo' || week.dataSourceMode === 'manual') return;
    await doRefreshScores(week,getGames(week.weekId));
    renderDashboard();
  },autoRefreshInterval*1000);
  // Run one auto-transition check immediately so an app that opens after the
  // lock time has passed doesn't have to wait for the next tick.
  tickAutoTransition();
}

/**
 * Check the active week and auto-transition its status if warranted:
 *   OPEN → LOCKED   at (first kickoff − autoLockOffsetMinutes), or when picksLockAt hits
 *   LOCKED → LIVE   at first kickoff, if autoLiveEnabled
 *   LIVE → pendingFinalization=true when every game is FINAL, if autoFinalizeEnabled
 *     (Commissioner sees a confirm prompt and completes the transition manually.)
 *
 * Demo weeks are skipped — those are commissioner-driven simulations.
 */
function tickAutoTransition() {
  try {
    const week = getCurrentWeek();
    if (!week) return;
    if (week.dataSourceMode === 'demo') return;

    const games = getGames(week.weekId);
    if (!games?.length) return;

    const now = Date.now();
    let changed = false;
    let next = { ...week };

    // OPEN → LOCKED
    if (week.status === WEEK_STATUS.OPEN) {
      const lockAt = computeEffectiveLockAt(week, games);
      if (lockAt && now >= lockAt.getTime()) {
        next.status = WEEK_STATUS.LOCKED;
        next.lockedAt = new Date().toISOString();
        changed = true;
        // Lock the spreads on all games at their current values so late-hour
        // line moves don't rewrite what players were graded against.
        for (const g of games) {
          if (g.spread !== null && g.spread !== undefined && (g.lockedSpread === null || g.lockedSpread === undefined)) {
            saveGame({ ...g, lockedSpread: g.spread, updatedAt: new Date().toISOString() });
          }
        }
      }
    }

    // LOCKED → LIVE
    if ((changed ? next.status : week.status) === WEEK_STATUS.LOCKED && getAutoLiveEnabled(week)) {
      const liveAt = computeEffectiveLiveAt(week, games);
      if (liveAt && now >= liveAt.getTime()) {
        next.status = WEEK_STATUS.LIVE;
        changed = true;
      }
    }

    // LIVE → pending finalization when every game is final (commissioner confirms)
    if ((changed ? next.status : week.status) === WEEK_STATUS.LIVE && getAutoFinalizeEnabled(week) && !week.pendingFinalization) {
      const allFinal = games.every(g => g.status === GAME_STATUS.FINAL);
      if (allFinal) {
        next.pendingFinalization = true;
        changed = true;
      }
    }

    if (changed) {
      next.updatedAt = new Date().toISOString();
      saveWeek(next);
      // Best-effort UI refresh — the picks page and dashboard both depend on
      // week.status, so re-render whichever is showing.
      if (state.currentTab === 'picks') renderPicksPage();
      else if (state.currentTab === 'dashboard') renderDashboard();
      else if (state.currentTab === 'commissioner') renderCommPage();
    }
  } catch (err) {
    console.warn('[tickAutoTransition] error:', err);
  }
}

async function doRefreshScores(week,games) {
  // Which games should we ask ESPN about?
  //   - Regular CFB pipeline games (isManual falsy, espnEventId set)      → yes
  //   - Manual out-of-league games with FULL ESPN linking (both espnSport
  //     AND espnEventId set)                                              → yes
  //   - Manual games without a sport/ID (commissioner enters scores)      → no
  //   - Demo-tagged games                                                 → no
  //
  // The outer setupAutoRefresh already short-circuits demo/manual WEEKS, so
  // this per-game filter is the second line of defense for mixed slates.
  const refreshable = games.filter(g => {
    if (!g?.espnEventId) return false;
    if (g.dataSource === 'demo') return false;
    if (!g.isManual) return true;                       // normal CFB path
    return !!g.espnSport && !!g.espnEventId;            // manual w/ full ESPN linking
  });
  if (!refreshable.length) return;
  const{updated,errors}=await refreshScoresByEventIds(
    refreshable.map(g=>g.espnEventId).filter(Boolean), refreshable
  );
  for(const upd of updated){
    const stored=getGame(upd.gameId);
    if(!stored) continue;
    const wasFinal = stored.status===GAME_STATUS.FINAL;
    const wasLive  = stored.status===GAME_STATUS.LIVE;
    saveGame({...stored,homeScore:upd.homeScore,awayScore:upd.awayScore,status:upd.status,actualWinner:upd.actualWinner,lastUpdated:upd.lastUpdated});
    // v0.17.0 — kickoff system event + SCRIBE live observations
    try {
      const fresh0=getGame(upd.gameId);
      if (!wasLive && !wasFinal && upd.status===GAME_STATUS.LIVE) emitKickoffEvent(fresh0);
      if (upd.status===GAME_STATUS.LIVE) scribeLiveGameCheck(stored, fresh0);
    } catch(e){ console.warn('[refresh] live events', e); }
    // v0.16.0 — a game just went FINAL: post the ATS result to its chat thread.
    if (!wasFinal && upd.status===GAME_STATUS.FINAL) {
      try {
        const fresh=getGame(upd.gameId);
        const ats=calculateAtsWinner(fresh);
        if (ats) {
          saveGame({...fresh, atsWinner: ats});
          const gp=getPicks(week.weekId).filter(p=>p.gameId===upd.gameId);
          emitGameFinalEvent(fresh, ats,
            gp.filter(p=>p.selectedTeam===ats).map(p=>p.playerId),
            gp.filter(p=>p.selectedTeam!==ats&&ats!=='no_decision').map(p=>p.playerId));
        }
      } catch(e){ console.warn('[refresh] game-final event', e); }
    }
  }
  if(errors.length)console.warn('[Refresh]',errors);
}

// ─── EXPORT SUITE ─────────────────────────────────────────────────────────────
// All exports use Excel/Google-Sheets-friendly CSV with proper escaping for
// commas, quotes, and newlines. Full backup uses JSON for fidelity.

/** Properly escape a single CSV cell value */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
/** Rows -> CSV text */
function toCsv(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }
/** Trigger a download for the given content */
function downloadFile(content, filename, mime='text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
}
/** Build a safe filename slug for a week */
function weekSlug(week) {
  if (!week) return 'no-week';
  const lbl = (week.roundLabel ? `wk${week.roundLabel}` : `wk${week.weekNumber}`).replace(/[^A-Za-z0-9._-]/g, '_');
  const range = [week.startDate, week.endDate].filter(Boolean).join('_to_');
  return range ? `${lbl}_${range}` : lbl;
}

/** Per-week — every pick + scoring outcome */
function exportWeekPicksCSV(week) {
  if (!week) { showToast('No week selected','error'); return; }
  const players=getPlayers().filter(p=>p.active);
  const games=getGames(week.weekId); const picks=getPicks(week.weekId);
  const rows=[['Week','Player','Initials','Alma Mater','Tiebreaker Guess','Game (Home)','Game (Away)','Kickoff','Locked Spread','Favorite','Multiplier','League Label','Picked','Result','ATS Winner','Home Score','Away Score']];
  for(const player of players){
    const tbGuess=getTiebreakerGuess(week.weekId,player.playerId);
    for(const game of games){
      const pick=picks.find(p=>p.playerId===player.playerId&&p.gameId===game.gameId);
      if(pick){
        const result=evaluatePick(pick,game);
        rows.push([
          formatWeekLabel(week), player.displayName, getPlayerInitials(player), player.almaMater||'',
          tbGuess??'',
          td(game,'home'), td(game,'away'),
          game.kickoff||'',
          game.lockedSpread??game.spread??'', game.favorite||'',
          game.multiplier??1, game.isManual ? (game.leagueLabel||'MANUAL') : '',
          pick.selectedTeam, result, game.atsWinner||'pending',
          game.homeScore??'', game.awayScore??'',
        ]);
      }
    }
  }
  downloadFile(toCsv(rows), `picks_${weekSlug(week)}.csv`);
  showToast('📥 Week picks CSV exported','success');
}

/** Per-week — the slate (games on the slate) */
function exportWeekSlateCSV(week) {
  if (!week) { showToast('No week selected','error'); return; }
  const games=getGames(week.weekId);
  const rows=[['Game ID','ESPN ID','Home','Home Mascot','Away','Away Mascot','Home Conf','Away Conf','Home Rank','Away Rank','Kickoff','Time Window','Spread (home perspective)','Favorite','Locked Spread','Status','Home Score','Away Score','Actual Winner','ATS Winner','Alma Mater','Spread Source','Venue']];
  for(const g of games){
    rows.push([
      g.gameId, g.espnEventId||'',
      g.homeTeam, g.homeMascot||'',
      g.awayTeam, g.awayMascot||'',
      g.homeConference||'', g.awayConference||'',
      g.homeRank??'', g.awayRank??'',
      g.kickoff||'', g.timeWindow||'',
      g.spread??'', g.favorite||'',
      g.lockedSpread??'',
      g.status, g.homeScore??'', g.awayScore??'',
      g.actualWinner||'', g.atsWinner||'',
      g.isAlmaMaterGame?'yes':'no',
      g.spreadSource||'',
      formatVenueDisplay(g)||g.venue||'',
    ]);
  }
  downloadFile(toCsv(rows), `slate_${weekSlug(week)}.csv`);
  showToast('📥 Week slate CSV exported','success');
}

/** Per-week — final weekly results / standings */
function exportWeekResultsCSV(week) {
  if (!week) { showToast('No week selected','error'); return; }
  const players=getPlayers().filter(p=>p.active);
  const games=getGames(week.weekId);
  const allPicks=getPicks(week.weekId);
  const actualTB=week.actualTiebreakerValue;
  const results=calculateWeeklyResults(week.weekId,players,allPicks,games,actualTB);
  const rows=[['Rank','Player','Correct (weighted)','Incorrect (weighted)','Correct (raw count)','Incorrect (raw count)','No Decisions','Tiebreaker Guess','Actual Tiebreaker','Delta','Winner','Loser','Won by Tiebreaker']];
  for(const r of results){
    rows.push([
      r.rank, r.displayName,
      r.correctPicks, r.incorrectPicks,
      r.correctCount ?? r.correctPicks, r.incorrectCount ?? r.incorrectPicks,
      r.noDecisions,
      r.tiebreakerGuess??'', actualTB??'',
      r.tiebreakerDelta??'',
      r.isWinner?'yes':'', r.isLoser?'yes':'',
      r.wonByTiebreaker?'yes':'',
    ]);
  }
  downloadFile(toCsv(rows), `results_${weekSlug(week)}.csv`);
  showToast('📥 Week results CSV exported','success');
}

/** Per-week — dashboard matrix (rows=games, cols=players) */
function exportWeekDashboardCSV(week) {
  if (!week) { showToast('No week selected','error'); return; }
  const players=getPlayers().filter(p=>p.active);
  const games=getGames(week.weekId).sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff));
  const picks=getPicks(week.weekId);
  const submitted=players.filter(p=>picks.some(pk=>pk.playerId===p.playerId));
  const header=['Game','Spread','Status','ATS Winner', ...submitted.map(p=>p.displayName)];
  const rows=[header];
  for(const g of games){
    const sv=g.lockedSpread??g.spread;
    const spreadStr=sv!==null&&sv!==undefined?fmtSpread(sv,g.favorite,g):(g.status===GAME_STATUS.FINAL?'Final':'TBD');
    const ats=g.atsWinner||(g.status===GAME_STATUS.FINAL?calculateAtsWinner(g):'');
    const row=[`${td(g,'home')} vs ${td(g,'away')}`, spreadStr, g.status, ats||''];
    for(const p of submitted){
      const pk=picks.find(pp=>pp.gameId===g.gameId&&pp.playerId===p.playerId);
      if(!pk){row.push('');continue;}
      const r=evaluatePick(pk,g);
      const tag={win:'WIN',loss:'LOSS',no_decision:'ND',live:'LIVE',pending:''}[r]||'';
      row.push(`${pk.selectedTeam}${tag?' ['+tag+']':''}`);
    }
    rows.push(row);
  }
  downloadFile(toCsv(rows), `dashboard_${weekSlug(week)}.csv`);
  showToast('📥 Week dashboard matrix CSV exported','success');
}

/** Per-week — bundle: kicks off all four week-scoped CSVs sequentially */
function exportWeekBundle(week) {
  if (!week) { showToast('No week selected','error'); return; }
  exportWeekSlateCSV(week);
  setTimeout(()=>exportWeekPicksCSV(week), 250);
  setTimeout(()=>exportWeekResultsCSV(week), 500);
  setTimeout(()=>exportWeekDashboardCSV(week), 750);
  showToast('📦 Week bundle: 4 CSV files downloading','success');
}

/** League-wide — players */
function exportPlayersCSV() {
  const players=getPlayers();
  const rows=[['Player ID','Display Name','Initials','Alma Mater','Email','Active','Created']];
  for(const p of players){
    rows.push([p.playerId,p.displayName,p.initials||'',p.almaMater||'',p.email||'',p.active?'yes':'no',p.createdAt||'']);
  }
  downloadFile(toCsv(rows), `players.csv`);
  showToast('📥 Players CSV exported','success');
}

/** League-wide — season standings */
function exportStandingsCSV() {
  const players=getPlayers().filter(p=>p.active);
  const visibleWeekIds=new Set(getWeeks().filter(w=>w.showInHistory!==false).map(w=>w.weekId));
  const allResults=getWeeklyResults().filter(r=>visibleWeekIds.has(r.weekId));
  const standings=calculateSeasonStandings(players,allResults);
  const rows=[['Rank','Player','Total Correct','Total Incorrect','Total No Decision','Weekly Wins','Weekly Losses','Win %']];
  for(const s of standings){
    rows.push([s.currentRank,s.displayName,s.totalCorrect,s.totalIncorrect,s.totalND,s.weeklyWins,s.weeklyLosses,s.winPct]);
  }
  downloadFile(toCsv(rows), `standings_season.csv`);
  showToast('📥 Standings CSV exported','success');
}

/** League-wide — all weekly results across every visible week */
function exportAllWeeklyResultsCSV() {
  const allResults=getWeeklyResults();
  const weeksById=Object.fromEntries(getWeeks().map(w=>[w.weekId,w]));
  const rows=[['Week','Show in History','Player','Rank','Correct (weighted)','Incorrect (weighted)','Correct (raw)','Incorrect (raw)','No Decisions','Tiebreaker Guess','Tiebreaker Delta','Winner','Loser','Won by Tiebreaker']];
  for(const r of allResults){
    const w=weeksById[r.weekId];
    rows.push([
      w?formatWeekLabel(w):r.weekId,
      w?(w.showInHistory!==false?'yes':'no'):'',
      r.displayName, r.rank,
      r.correctPicks, r.incorrectPicks,
      r.correctCount ?? r.correctPicks, r.incorrectCount ?? r.incorrectPicks,
      r.noDecisions,
      r.tiebreakerGuess??'', r.tiebreakerDelta??'',
      r.isWinner?'yes':'', r.isLoser?'yes':'', r.wonByTiebreaker?'yes':'',
    ]);
  }
  downloadFile(toCsv(rows), `weekly_results_all.csv`);
  showToast('📥 All weekly results CSV exported','success');
}

/** League-wide — obligations */
/**
 * Pure row-builder, exported so loadtest.mjs can assert on it without a DOM.
 * The Status column emits `o.status` VERBATIM (not the mapped display label)
 * — this is the commissioner's audit trail, and 'pending' must read distinct
 * from 'unpaid'/'paid' or the approval feature's whole point (an in-flight
 * claim is not yet settled) is invisible to the export.
 */
export function buildObligationsCsvRows(obs, playersById, weeksById) {
  const rows=[['Obligation ID','Type','Week','Payer','Recipient','Amount/Prize','Status','Created','Paid At']];
  for(const o of obs){
    const w=weeksById[o.weekId];
    rows.push([o.obligationId,o.type,w?formatWeekLabel(w):o.weekId,
      playersById[o.payerPlayerId]||o.payerPlayerId, playersById[o.recipientPlayerId]||o.recipientPlayerId,
      o.amountOrPrize||'', o.status, o.createdAt||'', o.paidAt||'']);
  }
  return rows;
}

function exportObligationsCSV() {
  const obs=getObligations();
  const players=Object.fromEntries(getPlayers().map(p=>[p.playerId,p.displayName]));
  const weeks=Object.fromEntries(getWeeks().map(w=>[w.weekId,w]));
  const rows = buildObligationsCsvRows(obs, players, weeks);
  downloadFile(toCsv(rows), `obligations.csv`);
  showToast('📥 Obligations CSV exported','success');
}

/** Full backup — single JSON file */
function exportFullBackupJSON() {
  const dump=exportAllData();
  const filename=`cfb_pickems_full_backup_${new Date().toISOString().slice(0,10)}.json`;
  downloadFile(JSON.stringify(dump,null,2), filename, 'application/json');
  showToast('💾 Full backup (JSON) exported','success');
}

/** Full CSV bundle — every table as its own CSV, downloaded sequentially */
function exportFullCsvBundle() {
  exportPlayersCSV();
  setTimeout(exportStandingsCSV, 200);
  setTimeout(exportAllWeeklyResultsCSV, 400);
  setTimeout(exportObligationsCSV, 600);
  // Per-week exports for every visible week
  const weeks=getWeeks().sort((a,b)=>a.weekNumber-b.weekNumber);
  let i=0;
  for(const w of weeks){
    setTimeout(()=>exportWeekSlateCSV(w), 800 + i*200); i++;
    setTimeout(()=>exportWeekPicksCSV(w), 800 + i*200); i++;
    setTimeout(()=>exportWeekResultsCSV(w), 800 + i*200); i++;
    setTimeout(()=>exportWeekDashboardCSV(w), 800 + i*200); i++;
  }
  showToast(`📦 Full CSV bundle: ${4 + weeks.length*4} files downloading`,'success');
}

// ─── RULES HELPERS ────────────────────────────────────────────────────────────

function getRulesEditorText(useDefault=false) {
  const{customRules}=getSettings();
  const rules=(!useDefault&&customRules)?customRules:DEFAULT_RULES;
  return rules.map(s=>`## ${s.section}\n${s.items.map(i=>`- ${i}`).join('\n')}`).join('\n\n');
}

function parseRulesText(text) {
  const lines=[];let cur=null;
  for(const line of text.split('\n')){
    const t=line.trim();
    if(t.startsWith('## ')){if(cur)lines.push(cur);cur={id:`r_${Date.now()}`,section:t.slice(3).trim(),items:[]};}
    else if(t.startsWith('- ')&&cur)cur.items.push(t.slice(2).trim());
  }
  if(cur)lines.push(cur);
  return lines.length?lines:null;
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

/** Format spread for a game — always shows favored team with negative number.
 *  Accepts (spread, favorite) or (spread, favorite, game) for fallback derivation. */
function fmtSpread(spread, favorite, game = null) { return formatSpread(spread, favorite, game); }

/** Format spread directly from a game object (preferred — handles all fallbacks). */
function spreadFromGame(game) {
  if (!game) return 'TBD';
  const sv = game.lockedSpread !== null ? game.lockedSpread : game.spread;
  return formatSpread(sv, game.favorite, game);
}

/** Team display "School (Mascot)" — uses explicit mascot or TEAM_MASCOT_LOOKUP fallback. */
function td(game, side='home') { return getTeamDisplay(game, side); }

/** Just the school name (no mascot) — used in dashboard matrix + alma mater watch
 *  where the mascot adds visual noise without clarifying anything. */
function teamSchool(game, side='home') {
  if (!game) return '';
  return (side === 'home' ? game.homeTeam : game.awayTeam) || '';
}

/** Bare-matchup "Away @ Home" using just school names. */
function matchupBare(game) {
  if (!game) return '';
  const sep = game.neutralSite ? 'vs' : '@';
  return `${teamSchool(game,'away')} ${sep} ${teamSchool(game,'home')}`;
}

/**
 * Small chip cluster shown on game rows / cards: multiplier ("2x") and
 * out-of-league label ("NFL"). Both are conditional — a normal 1x CFB game
 * gets nothing. Returns an empty string when nothing to show so callers can
 * concat safely.
 */
function renderGameBadges(game) {
  if (!game) return '';
  const parts = [];
  const m = Number(game.multiplier);
  if (Number.isFinite(m) && m > 0 && m !== 1) {
    // Format 2 → "2x", 1.5 → "1.5x", 3 → "3x"
    const label = (m % 1 === 0) ? `${m}x` : `${m}x`;
    parts.push(`<span class="mult-badge" title="This game counts as ${m}× toward standings">${label}</span>`);
  }
  if (game.isManual && game.leagueLabel) {
    parts.push(`<span class="league-chip" title="Out-of-league / one-off game">${escHtml(game.leagueLabel)}</span>`);
  }
  return parts.join('');
}

/**
 * Priority 7: order players for the dashboard view.
 *  - The logged-in player ALWAYS lands in position 0 (their own column is the
 *    most personally relevant — easiest to scan on mobile).
 *  - After that, apply the user's saved drag-reorder from
 *    settings.dashboardColumnOrder (per-device). Any players not in the saved
 *    order get appended in their natural order.
 *  - New players (just added to the league) appear at the end until reordered.
 */
function getOrderedPlayersForDashboard(players, viewerPlayerId) {
  const order = getSettings().dashboardColumnOrder || [];
  const byId = new Map(players.map(p => [p.playerId, p]));
  const result = [];
  const seen = new Set();
  // Step 1: viewer's column first (if they're in the players list)
  if (viewerPlayerId && byId.has(viewerPlayerId)) {
    result.push(byId.get(viewerPlayerId));
    seen.add(viewerPlayerId);
  }
  // Step 2: walk saved order, skipping viewer (already placed)
  for (const pid of order) {
    if (seen.has(pid)) continue;
    const p = byId.get(pid);
    if (p) { result.push(p); seen.add(pid); }
  }
  // Step 3: any new players not in saved order (natural order)
  for (const p of players) {
    if (!seen.has(p.playerId)) result.push(p);
  }
  return result;
}

/** Persist the new player-column order (per device). */
function setDashboardColumnOrder(playerIds) {
  saveSetting('dashboardColumnOrder', playerIds);
}

/**
 * Hand-curated short abbreviations for major FBS programs. Used in compact
 * dashboard chips where horizontal space is at a premium. Keys are exact
 * school names (matching what ESPN / the data provider returns).
 *
 * Why this exists: the previous implementation took the last word of the
 * school name ("Texas State" → "State"), which collapsed many schools to the
 * same 4-letter token. This table gives each well-known program a unique
 * abbreviation; unknown schools fall through to a smart-truncate that
 * preserves words like "State", "Tech", "A&M".
 */
// TEAM_ABBR + buildAbbrMap moved to data-model.js (v0.17.2) — shared with chat.

/**
 * Render a game as "Away @ Home" (CFB convention — @ reads "at").
 * For neutral-site games we use "vs" instead and omit the home indicator.
 *  - sep: optional override ('@' or 'vs')
 *  - showH: append " (H)" after the home team (default false to keep things tight)
 */
function matchup(game, { sep, showH = false } = {}) {
  if (!game) return '';
  const sepStr = sep || (game.neutralSite ? 'vs' : '@');
  const home = td(game, 'home') + (showH && !game.neutralSite ? ' (H)' : '');
  return `${td(game, 'away')} ${sepStr} ${home}`;
}

function emptyState(icon,title,msg){
  return`<div class="empty-state"><div class="empty-state-icon">${icon}</div><h3>${title}</h3><p class="text-secondary text-sm mt-sm">${msg}</p></div>`;
}

function escHtml(s){
  if(!s)return'';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg,type='success'){
  const c=document.getElementById('toast-container');if(!c)return;
  const t=document.createElement('div');t.className=`toast ${type}`;t.innerHTML=msg;c.appendChild(t);
  setTimeout(()=>{t.style.cssText+='opacity:0;transition:opacity .3s';setTimeout(()=>t.remove(),300);},3200);
}


// ─── SITE PIN GATE ────────────────────────────────────────────────────────────

function showSitePinGate() {
  // v0.16.0 — the gate is now an OVERLAY on top of the (already booted) app,
  // instead of nuking document.body and reloading on success. Killing the
  // reload removes the entire second boot + second Apps Script hydrate that
  // caused the old post-PIN blank screen. Background hydration continues while
  // the user types, so by the time the PIN lands the data is usually fresh.
  const s = getSettings();
  const titleTop  = s.welcomeTitleTop  || 'welcome to';
  const titleMain = s.welcomeTitleMain || (s.welcomeTitle ? s.welcomeTitle.replace(/^welcome to\s*/i,'') : "irb pick 'ems");
  const subtitle  = s.welcomeSubtitle || 'enter access pin';
  document.getElementById('site-gate-overlay')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'site-gate-overlay';
  wrap.innerHTML = `
    <div class="site-gate">
      <div class="site-gate-inner">
        <div class="site-gate-title-top">${escHtml(titleTop)}</div>
        <div class="site-gate-title">${escHtml(titleMain)}</div>
        <div class="site-gate-subtitle">${escHtml(subtitle)}</div>
        <input class="site-gate-input" id="site-pin-input" type="password" inputmode="numeric"
          maxlength="8" placeholder="_ _ _ _" autocomplete="off" />
        <div class="site-gate-error" id="site-gate-error" style="display:none">incorrect pin</div>
        <button class="site-gate-btn" id="site-gate-submit">enter</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const input = document.getElementById('site-pin-input');
  const errEl = document.getElementById('site-gate-error');
  const submit = () => {
    const pin = input?.value || '';
    if (verifySitePin(pin)) {
      setSiteUnlocked(true);
      wrap.remove();                                  // instant — no reload
      navigateTo(state.currentTab || 'dashboard');
    } else {
      if (errEl) errEl.style.display = 'block';
      if (input) { input.value = ''; input.focus(); }
    }
  };
  document.getElementById('site-gate-submit')?.addEventListener('click', submit);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input?.focus(), 100);
}

window.navigateTo=navigateTo;
// Batch 3+4 item A/F — chat-ui.js cannot import app.js (app.js already imports
// chat-ui.js; the reverse would be a cycle), so these two are exposed on
// window as the same bridge window.navigateTo already establishes:
//   - showToast: item A's "Chat has been turned off…" redirect toast.
//   - livePickStatus: item F's game-thread header colors reuse this VERBATIM
//     rather than re-deriving covering/trailing in chat-ui.js.
window.showToast=showToast;
window.livePickStatus=livePickStatus;
