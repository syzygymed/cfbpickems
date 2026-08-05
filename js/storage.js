/**
 * CFB Pickems — Storage v8 (Phase II — pluggable backend)
 *
 * v8: load()/save() route through a pluggable backend.
 *   - 'local'        : localStorage (default; offline; per-device) — unchanged behaviour
 *   - 'googleSheets' : in-memory mirror hydrated from a Google Sheet via backend.js
 * The rest of this module is UNCHANGED — every getter/setter still calls the
 * private load()/save(), so switching modes needs no call-site edits.
 *
 * Session + site-unlock + backend config always stay device-local (they're
 * per-device concerns), regardless of the active backend.
 */

import {
  DEFAULT_SETTINGS, DEMO_PLAYERS, DEMO_WEEK, DEMO_GAMES, DEMO_PICKS,
  REAL_WEEK_1_2026, REAL_WEEK_1_2026_KNOWN_GAMES,
  SITE_PIN, SITE_PIN_KEY,
} from './data-model.js';

import { cacheGet, cacheSet, isBackendReady } from './backend.js';

const KEYS = {
  SETTINGS:    'cfbp_settings',
  PLAYERS:     'cfbp_players',
  WEEKS:       'cfbp_weeks',
  GAMES:       'cfbp_games',          // selected weekly SLATE
  AVAIL_GAMES: 'cfbp_avail_games',    // available-games pool (fetched, not yet on slate)
  PICKS:       'cfbp_picks',
  RESULTS:     'cfbp_results',
  OBLIGATIONS: 'cfbp_obligations',
  NICKNAMES:   'cfbp_nicknames',
  SESSION:     'cfbp_session',
  LOCK_OVR:    'cfbp_lock_overrides',
  TB_GUESSES:  'cfbp_tiebreaker_guesses',
  EP_GUESSES:  'cfbp_extra_point_guesses', // v0.16.0 — Ischemic Extra Point (longest FG, blackjack rules)
  REJECTED_SUGG: 'cfbp_rejected_suggestions',  // per-week dismissed suggested games
  REACTIONS:   'cfbp_reactions',                // per-week game emoji reactions
  FEEDBACK:    'cfbp_feedback',                 // user-submitted feature requests / issues
  COMMENTS:    'cfbp_comments',                 // per-game + general chat messages (with PickEms Bot)
  ACTIVE_WEEK: 'cfbp_active_week',
  FETCH_PROOF: 'cfbp_fetch_proof',
  SITE_UNLOCK: SITE_PIN_KEY,  // 'cfbp_site_unlocked'
};

// Keys that ALWAYS stay device-local even when a shared backend is active.
// (Session/auth and the site PIN unlock are per-device; backend config is local.)
const DEVICE_LOCAL_KEYS = new Set([
  KEYS.SESSION,
  KEYS.SITE_UNLOCK,
  'cfbp_backend_config',
]);

// Active storage backend: 'local' | 'googleSheets'. Default local.
// storage.js owns this flag; app.js flips it after a successful hydrate().
let _backendMode = 'local';
export function getBackendMode() { return _backendMode; }
export function setBackendMode(mode) { _backendMode = (mode === 'googleSheets') ? 'googleSheets' : 'local'; }

function useSheets(key) {
  return _backendMode === 'googleSheets' && isBackendReady() && !DEVICE_LOCAL_KEYS.has(key);
}

function load(k) {
  if (useSheets(k)) {
    try { return cacheGet(k); } catch (e) { console.error('[Storage:sheets]', k, e); return null; }
  }
  try { const r=localStorage.getItem(k); return r?JSON.parse(r):null; }
  catch(e){ console.error('[Storage]',k,e); return null; }
}
function save(k,v) {
  if (useSheets(k)) {
    try { cacheSet(k, v); return true; } catch (e) { console.error('[Storage:sheets] save', k, e); return false; }
  }
  try { localStorage.setItem(k,JSON.stringify(v)); return true; }
  catch(e){ console.error('[Storage] save',k,e); return false; }
}

// ─── INIT / SEED ──────────────────────────────────────────────────────────────

export function initStorage() {
  ensureSeedData();
}

/**
 * Seed default data for any missing keys. Idempotent — only fills gaps, never
 * overwrites. Safe to call in local mode (at startup) and in sheets mode
 * (after hydrate, to seed a brand-new empty Sheet).
 */
export function ensureSeedData() {
  if(!load(KEYS.SETTINGS))    save(KEYS.SETTINGS,   DEFAULT_SETTINGS);
  if(!load(KEYS.PLAYERS))     save(KEYS.PLAYERS,    DEMO_PLAYERS);
  if(!load(KEYS.WEEKS))       save(KEYS.WEEKS,      [REAL_WEEK_1_2026, DEMO_WEEK]);
  if(!load(KEYS.GAMES))       save(KEYS.GAMES,      REAL_WEEK_1_2026_KNOWN_GAMES);
  if(!load(KEYS.AVAIL_GAMES)) save(KEYS.AVAIL_GAMES,{});
  if(!load(KEYS.PICKS))       save(KEYS.PICKS,      DEMO_PICKS);
  if(!load(KEYS.RESULTS))     save(KEYS.RESULTS,    []);
  if(!load(KEYS.OBLIGATIONS)) save(KEYS.OBLIGATIONS,[]);
  if(!load(KEYS.NICKNAMES))   save(KEYS.NICKNAMES,  {});
  if(!load(KEYS.LOCK_OVR))    save(KEYS.LOCK_OVR,   {});
  if(!load(KEYS.TB_GUESSES))  save(KEYS.TB_GUESSES, {});
  if(!load(KEYS.EP_GUESSES))  save(KEYS.EP_GUESSES, {});
  if(!load(KEYS.REJECTED_SUGG)) save(KEYS.REJECTED_SUGG, {});
  if(!load(KEYS.REACTIONS))   save(KEYS.REACTIONS,   {});
  if(!load(KEYS.FEEDBACK))    save(KEYS.FEEDBACK,    []);
  if(!load(KEYS.COMMENTS))    save(KEYS.COMMENTS,    []);
  if(!load(KEYS.ACTIVE_WEEK)) save(KEYS.ACTIVE_WEEK, REAL_WEEK_1_2026.weekId);
}

export function resetToDemo() {
  save(KEYS.SETTINGS,   DEFAULT_SETTINGS);
  save(KEYS.PLAYERS,    DEMO_PLAYERS);
  save(KEYS.WEEKS,      [REAL_WEEK_1_2026, DEMO_WEEK]);
  save(KEYS.GAMES,      [...REAL_WEEK_1_2026_KNOWN_GAMES, ...DEMO_GAMES]);
  save(KEYS.AVAIL_GAMES,{});
  save(KEYS.PICKS,      DEMO_PICKS);
  save(KEYS.RESULTS,    []);
  save(KEYS.OBLIGATIONS,[]);
  save(KEYS.NICKNAMES,  {});
  save(KEYS.LOCK_OVR,   {});
  save(KEYS.TB_GUESSES, {});
  save(KEYS.EP_GUESSES, {});
  save(KEYS.REJECTED_SUGG, {});
  save(KEYS.REACTIONS, {});
  save(KEYS.FEEDBACK, []);
  save(KEYS.COMMENTS, []);
  save(KEYS.ACTIVE_WEEK, REAL_WEEK_1_2026.weekId);
  save(KEYS.FETCH_PROOF, null);
  clearSession();
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

export function getSettings() { return{...DEFAULT_SETTINGS,...(load(KEYS.SETTINGS)||{})}; }
export function saveSetting(k,v){ const s=getSettings();s[k]=v;save(KEYS.SETTINGS,s); }
export function saveSettings(s){ save(KEYS.SETTINGS,s); }

// ─── TIMEZONE + THEME (per-player when logged in, per-device otherwise) ───────
//
// Each player can choose their own time zone and color theme. Preferences live
// on the player record (under `preferences.tz` / `preferences.theme`) so when
// the league is connected to a shared backend, every player's choices follow
// THEM across devices instead of being clobbered by whoever logged in last.
//
// When nobody is logged in (front gate, anonymous viewer), the device-level
// fallback in `settings.timezone` / `settings.theme` is used, so the app
// still has a reasonable default before the user picks a player.

function _playerPref(key) {
  const sess = getSession();
  if (!sess?.playerId) return undefined;
  const p = getPlayer(sess.playerId);
  return p?.preferences?.[key];
}

function _setPlayerPref(key, value) {
  const sess = getSession();
  if (!sess?.playerId) return false;
  const players = getPlayers();
  const idx = players.findIndex(p => p.playerId === sess.playerId);
  if (idx < 0) return false;
  const prefs = { ...(players[idx].preferences || {}), [key]: value };
  players[idx] = { ...players[idx], preferences: prefs };
  save(KEYS.PLAYERS, players);
  return true;
}

export function getTimezone() {
  return _playerPref('tz') || getSettings().timezone || 'PT';
}
export function setTimezone(tzKey) {
  // If a player is logged in, persist on their record; otherwise device default.
  if (!_setPlayerPref('tz', tzKey)) saveSetting('timezone', tzKey);
}

// ── v0.17.0 chat identity + notification prefs (per-player, follow the person) ──
export function getAccent() { return _playerPref('accent') || null; }
export function setAccent(color) { _setPlayerPref('accent', color); }
export function getChatNick() { return _playerPref('chatNick') || null; }
export function setChatNick(nick) { _setPlayerPref('chatNick', (nick || '').slice(0, 16)); }
export function getNotifPrefs() {
  return { sound: false, toasts: true, systemEvents: true, ...(_playerPref('notif') || {}) };
}
export function setNotifPrefs(prefs) { _setPlayerPref('notif', { ...getNotifPrefs(), ...prefs }); }
export function getAccentFor(playerId) {
  const p = (load(KEYS.PLAYERS) || []).find(x => x.playerId === playerId);
  return p?.preferences?.accent || null;
}
export function getChatNickFor(playerId) {
  const p = (load(KEYS.PLAYERS) || []).find(x => x.playerId === playerId);
  return p?.preferences?.chatNick || null;
}

export function getTheme() {
  // v0.17.0 — league default is the school-agnostic neutral palette; players
  // opt into school themes per their own preference.
  return _playerPref('theme') || getSettings().theme || 'neutral';
}
export function setTheme(themeKey) {
  if (!_setPlayerPref('theme', themeKey)) saveSetting('theme', themeKey);
}

// ─── FETCH PROOF ──────────────────────────────────────────────────────────────

export function saveFetchProof(r){ save(KEYS.FETCH_PROOF,r); }
export function getFetchProof(){ return load(KEYS.FETCH_PROOF)||null; }


// ─── SITE ACCESS PIN ──────────────────────────────────────────────────────────

export function isSiteUnlocked() {
  try { return localStorage.getItem(SITE_PIN_KEY) === '1'; }
  catch { return false; }
}
export function setSiteUnlocked(val) {
  try { if(val) localStorage.setItem(SITE_PIN_KEY,'1'); else localStorage.removeItem(SITE_PIN_KEY); }
  catch {}
}
export function verifySitePin(pin) {
  // Settings override takes precedence; falls back to the default constant.
  const override = (getSettings().sitePin || '').trim();
  const effective = override || SITE_PIN;
  return String(pin) === String(effective);
}
export function getEffectiveSitePin() {
  return (getSettings().sitePin || '').trim() || SITE_PIN;
}
export function setSitePin(newPin) {
  saveSetting('sitePin', String(newPin || '').trim());
}

// ─── SESSION ──────────────────────────────────────────────────────────────────

export function getSession(){ return load(KEYS.SESSION)||{playerId:null,isAdmin:false,playerVerified:false}; }
export function setSession(playerId,isAdmin=false,playerVerified=false){
  save(KEYS.SESSION,{playerId,isAdmin,playerVerified,setAt:new Date().toISOString()});
}
export function clearSession(){ localStorage.removeItem(KEYS.SESSION); }

// ─── PLAYER AUTH ──────────────────────────────────────────────────────────────

export function verifyPlayerPin(playerId,pin){
  const p=getPlayer(playerId);
  if(!p)return false;
  if(!p.pinHash)return true;
  return p.pinHash===btoa(String(pin));
}
export function setPlayerPin(playerId,pin){
  const p=getPlayer(playerId); if(!p)return;
  savePlayer({...p,pinHash:btoa(String(pin))});
}
/**
 * Decode the stored PIN. Commissioner-only convenience used by the
 * "Show PIN" / "Email PIN" features. Never call this on the main page.
 */
export function getPlayerPin(playerId){
  const p=getPlayer(playerId);
  if(!p||!p.pinHash) return '';
  try { return atob(p.pinHash); } catch { return ''; }
}

// ─── PLAYERS ──────────────────────────────────────────────────────────────────

export function getPlayers(){ return load(KEYS.PLAYERS)||[]; }
export function getPlayer(id){ return getPlayers().find(p=>p.playerId===id)||null; }
export function savePlayer(player){
  const all=getPlayers();
  const idx=all.findIndex(p=>p.playerId===player.playerId);
  const upd={...player,updatedAt:new Date().toISOString()};
  if(idx>=0)all[idx]=upd;else all.push(upd);
  save(KEYS.PLAYERS,all);
}
export function addPlayer(p){ const all=getPlayers();all.push(p);save(KEYS.PLAYERS,all); }

// ─── NICKNAMES ────────────────────────────────────────────────────────────────

export function getNicknames(){ return load(KEYS.NICKNAMES)||{}; }
export function getNickname(weekId,playerId){ return getNicknames()[`${weekId}__${playerId}`]||null; }
export function setNickname(weekId,playerId,nick){
  const all=getNicknames(); const key=`${weekId}__${playerId}`;
  if(nick?.trim())all[key]=nick.trim();else delete all[key];
  save(KEYS.NICKNAMES,all);
}
export function getDisplayNamePlain(weekId,playerId,players){
  const p=(players||getPlayers()).find(x=>x.playerId===playerId);
  if(!p)return'Unknown';
  const n=getNickname(weekId,playerId);
  return n?`${p.displayName} "${n}"`:p.displayName;
}

// ─── TIEBREAKER GUESSES ───────────────────────────────────────────────────────

export function getTiebreakerGuesses(){ return load(KEYS.TB_GUESSES)||{}; }
export function getTiebreakerGuess(weekId,playerId){
  const v=getTiebreakerGuesses()[`${weekId}__${playerId}`];
  return v!==undefined?v:null;
}
export function setTiebreakerGuess(weekId,playerId,value){
  const all=getTiebreakerGuesses();
  all[`${weekId}__${playerId}`]=Number(value);
  save(KEYS.TB_GUESSES,all);
}

// ─── ISCHEMIC EXTRA POINT GUESSES (v0.16.0) ───────────────────────────────────
// Longest-made-FG guesses, blackjack rules. Same shape as tiebreaker guesses:
// { "weekId__playerId": yards }. Syncs through the seam like all league data.

export function getExtraPointGuesses(){ return load(KEYS.EP_GUESSES)||{}; }
export function getExtraPointGuess(weekId,playerId){
  const v=getExtraPointGuesses()[`${weekId}__${playerId}`];
  return v!==undefined?v:null;
}
export function setExtraPointGuess(weekId,playerId,value){
  const all=getExtraPointGuesses();
  const key=`${weekId}__${playerId}`;
  if(value===null||value===''||value===undefined) delete all[key];
  else all[key]=Number(value);
  save(KEYS.EP_GUESSES,all);
}

// ─── ACTIVE WEEK ──────────────────────────────────────────────────────────────

export function getActiveWeekId(){ return load(KEYS.ACTIVE_WEEK)||null; }
export function setActiveWeekId(weekId){ save(KEYS.ACTIVE_WEEK,weekId); }

// ─── WEEKS ────────────────────────────────────────────────────────────────────

export function getWeeks(){ return load(KEYS.WEEKS)||[]; }
export function getWeek(weekId){ return getWeeks().find(w=>w.weekId===weekId)||null; }

export function getCurrentWeek(){
  const activeId=getActiveWeekId();
  if(activeId){ const f=getWeeks().find(w=>w.weekId===activeId); if(f)return f; }
  const weeks=getWeeks();
  const active=weeks.find(w=>['open','locked','live'].includes(w.status));
  if(active)return active;
  return[...weeks].sort((a,b)=>b.weekNumber-a.weekNumber)[0]||null;
}

export function saveWeek(week){
  const weeks=getWeeks();
  const idx=weeks.findIndex(w=>w.weekId===week.weekId);
  const upd={...week,updatedAt:new Date().toISOString()};
  if(idx>=0)weeks[idx]=upd;else weeks.push(upd);
  save(KEYS.WEEKS,weeks);
}
export function deleteWeek(weekId){ save(KEYS.WEEKS,getWeeks().filter(w=>w.weekId!==weekId)); }

export function getEffectiveWeekStatus(week){
  if(!week)return null;
  if(week.status==='final'||week.status==='draft')return week.status;
  const now=new Date();
  if(week.picksLockAt&&now>=new Date(week.picksLockAt))return'locked';
  if(week.picksOpenAt&&now>=new Date(week.picksOpenAt))return'open';
  return week.status;
}

// ─── SLATE GAMES (selected for this week) ────────────────────────────────────

export function getGames(weekId=null){
  const g=load(KEYS.GAMES)||[];
  return weekId?g.filter(x=>x.weekId===weekId):g;
}
export function getGame(gameId){ return getGames().find(g=>g.gameId===gameId)||null; }

export function saveGame(game){
  const all=getGames();
  const idx=all.findIndex(g=>g.gameId===game.gameId);
  const upd={...game,updatedAt:new Date().toISOString()};
  if(idx>=0)all[idx]=upd;else all.push(upd);
  save(KEYS.GAMES,all);
}
export function deleteGame(gameId){
  save(KEYS.GAMES,getGames().filter(g=>g.gameId!==gameId));
  // Cascade: remove any picks tied to this game so they don't orphan / skew scoring.
  deletePicksForGame(gameId);
  // Also clear any lock override for the removed game.
  const o=getGameLockOverrides(); if(o[gameId]){ delete o[gameId]; save(KEYS.LOCK_OVR,o); }
}
export function deletePicksForGame(gameId){
  const all=load(KEYS.PICKS)||[];
  const filtered=all.filter(p=>p.gameId!==gameId);
  if(filtered.length!==all.length) save(KEYS.PICKS,filtered);
  return all.length-filtered.length; // number of picks removed
}
export function countPicksForGame(gameId){
  return (load(KEYS.PICKS)||[]).filter(p=>p.gameId===gameId).length;
}
export function saveAllGamesForWeek(weekId,newGames){
  const existing=getGames().filter(g=>g.weekId!==weekId);
  save(KEYS.GAMES,[...existing,...newGames]);
}
export function clearSlateForWeek(weekId){
  save(KEYS.GAMES,getGames().filter(g=>g.weekId!==weekId));
}

// ─── AVAILABLE GAMES POOL (fetched from ESPN, not yet on slate) ───────────────
// Stored as { weekId: [game, ...] }

export function getAvailableGames(weekId){
  const all=load(KEYS.AVAIL_GAMES)||{};
  return all[weekId]||[];
}
export function saveAvailableGames(weekId,games){
  const all=load(KEYS.AVAIL_GAMES)||{};
  all[weekId]=games;
  save(KEYS.AVAIL_GAMES,all);
}
export function clearAvailableGames(weekId){
  const all=load(KEYS.AVAIL_GAMES)||{};
  delete all[weekId];
  save(KEYS.AVAIL_GAMES,all);
}

// ─── GAME LOCK OVERRIDES ─────────────────────────────────────────────────────

export function getGameLockOverrides(){ return load(KEYS.LOCK_OVR)||{}; }
export function setGameLockOverride(gameId,unlocked){
  const o=getGameLockOverrides();
  if(unlocked)o[gameId]='unlocked';else delete o[gameId];
  save(KEYS.LOCK_OVR,o);
}
export function clearAllLockOverrides(){ save(KEYS.LOCK_OVR,{}); }

// ─── REJECTED SUGGESTIONS ─────────────────────────────────────────────────────
// Per-week set of suggested-game keys the Commissioner has dismissed, so they
// don't keep reappearing in the suggested slate. Keyed by weekId → [keys].
// A "suggestion key" is a stable matchup identity: "homeTeam@@awayTeam" (lowercased),
// or the ESPN event id when present. This survives re-fetches.

export function suggestionKeyOf(game){
  if(!game) return '';
  if(game.espnEventId) return `espn:${game.espnEventId}`;
  return `m:${(game.homeTeam||'').toLowerCase()}@@${(game.awayTeam||'').toLowerCase()}`;
}
export function getRejectedSuggestions(weekId){
  const all=load(KEYS.REJECTED_SUGG)||{};
  return all[weekId]||[];
}
export function rejectSuggestion(weekId, game){
  const all=load(KEYS.REJECTED_SUGG)||{};
  const key=suggestionKeyOf(game);
  const list=new Set(all[weekId]||[]);
  list.add(key);
  all[weekId]=[...list];
  save(KEYS.REJECTED_SUGG, all);
}
export function unrejectSuggestion(weekId, key){
  const all=load(KEYS.REJECTED_SUGG)||{};
  all[weekId]=(all[weekId]||[]).filter(k=>k!==key);
  save(KEYS.REJECTED_SUGG, all);
}
export function clearRejectedSuggestions(weekId){
  const all=load(KEYS.REJECTED_SUGG)||{};
  delete all[weekId];
  save(KEYS.REJECTED_SUGG, all);
}
export function isSuggestionRejected(weekId, game){
  return getRejectedSuggestions(weekId).includes(suggestionKeyOf(game));
}

// ─── EMOJI REACTIONS ──────────────────────────────────────────────────────────
// Storage shape: { weekId: { gameId: { emoji: [playerId, ...] } } }
// Each player can add multiple emojis to one game; toggling the same emoji
// twice removes their vote. Reactions auto-sync to the Sheet in shared mode
// (they go through load()/save() like everything else).

function _reactionsAll() { return load(KEYS.REACTIONS) || {}; }
function _saveReactions(all) { save(KEYS.REACTIONS, all); }

/** Returns { emoji: [playerId, …] } for one game (empty object when none). */
export function getReactionsForGame(weekId, gameId) {
  const all = _reactionsAll();
  return (all[weekId] && all[weekId][gameId]) || {};
}

/** Toggle a player's reaction. Returns the new list for that emoji on that game. */
export function toggleReaction(weekId, gameId, emoji, playerId) {
  if (!weekId || !gameId || !emoji || !playerId) return [];
  const all = _reactionsAll();
  if (!all[weekId]) all[weekId] = {};
  if (!all[weekId][gameId]) all[weekId][gameId] = {};
  const current = new Set(all[weekId][gameId][emoji] || []);
  if (current.has(playerId)) current.delete(playerId);
  else current.add(playerId);
  if (current.size === 0) {
    delete all[weekId][gameId][emoji];
    if (!Object.keys(all[weekId][gameId]).length) delete all[weekId][gameId];
    if (!Object.keys(all[weekId]).length) delete all[weekId];
  } else {
    all[weekId][gameId][emoji] = [...current];
  }
  _saveReactions(all);
  return all[weekId]?.[gameId]?.[emoji] || [];
}

/** Wipe all reactions for a week (used by week-reset). */
export function clearReactionsForWeek(weekId) {
  const all = _reactionsAll();
  if (all[weekId]) { delete all[weekId]; _saveReactions(all); }
}

// ─── FEEDBACK / FEATURE REQUESTS ─────────────────────────────────────────────
// Player-submitted feedback (Priority 13). Lives at KEYS.FEEDBACK as a list.
// Each entry: { id, name, body, submittedAt, appVersion, siteUrl }.
// Goes through load()/save() so it auto-syncs to the Google Sheet when cloud
// sync is enabled — that's the "separate sheet" the priority asked for.
export function getFeedback() { return load(KEYS.FEEDBACK) || []; }
export function appendFeedback(entry) {
  const all = getFeedback();
  all.push(entry);
  save(KEYS.FEEDBACK, all);
}
export function clearFeedback() { save(KEYS.FEEDBACK, []); }

// ─── COMMENTS / CHAT ─────────────────────────────────────────────────────────
// Per-game comments + general chat + PickEms Bot posts all live in one list.
// Each entry:
//   {
//     commentId: 'c_<timestamp>_<rand>',
//     weekId:    string,
//     gameId:    string | null,   // null = general chat (not tied to a game)
//     authorId:  string,          // playerId, or the literal 'bot' for PickEms Bot
//     authorKind:'player' | 'bot',
//     body:      string,          // trimmed, max 200 chars for players; bot can go slightly longer
//     createdAt: ISO string,
//   }
//
// One list scales well for a small league across a full season (a few hundred
// entries max). If it ever grows too large we can shard by weekId later.

const COMMENT_MAX_LEN = 200;

/** Get all comments across the app. */
export function getComments() { return load(KEYS.COMMENTS) || []; }

/** Get comments for a specific game, oldest-first. */
export function getGameComments(gameId) {
  return getComments()
    .filter(c => c.gameId === gameId)
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/**
 * Add a new comment. Returns the created entry on success or null on rejection.
 * body is trimmed and capped to COMMENT_MAX_LEN chars. If body is empty after
 * trimming, no entry is created (nothing to say = don't spam the log).
 */
export function addComment({ weekId, gameId, authorId, authorKind = 'player', body }) {
  const trimmed = (body || '').trim().slice(0, COMMENT_MAX_LEN);
  if (!trimmed) return null;
  const entry = {
    commentId: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    weekId: weekId || null,
    gameId: gameId || null,
    authorId: authorId || 'unknown',
    authorKind,
    body: trimmed,
    createdAt: new Date().toISOString(),
  };
  const all = getComments();
  all.push(entry);
  save(KEYS.COMMENTS, all);
  return entry;
}

/** Remove a comment (used when a player deletes their own or admin moderates). */
export function deleteComment(commentId) {
  save(KEYS.COMMENTS, getComments().filter(c => c.commentId !== commentId));
}

/**
 * Idempotent bot post. Bot messages are typically triggered by observable
 * events (game finalized, week finalized, new leader) — this dedupe helper
 * ensures a given `eventKey` only produces ONE bot post no matter how many
 * times the trigger fires. Returns true if the post was actually added.
 */
export function addBotPostIfNew({ eventKey, weekId, gameId, body }) {
  const existing = getComments().some(c =>
    c.authorKind === 'bot' && c.botEventKey === eventKey
  );
  if (existing) return false;
  const entry = {
    commentId: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    weekId: weekId || null,
    gameId: gameId || null,
    authorId: 'bot',
    authorKind: 'bot',
    botEventKey: eventKey,
    body: (body || '').trim().slice(0, 400), // bot allowed slightly longer
    createdAt: new Date().toISOString(),
  };
  const all = getComments();
  all.push(entry);
  save(KEYS.COMMENTS, all);
  return true;
}

// ─── PICKS ────────────────────────────────────────────────────────────────────

export function getPicks(weekId=null,playerId=null){
  let p=load(KEYS.PICKS)||[];
  if(weekId)   p=p.filter(x=>x.weekId===weekId);
  if(playerId) p=p.filter(x=>x.playerId===playerId);
  return p;
}
export function getPick(weekId,gameId,playerId){
  return getPicks(weekId,playerId).find(p=>p.gameId===gameId)||null;
}
export function saveAllPicks(newPicks){
  const all=load(KEYS.PICKS)||[];
  for(const pick of newPicks){
    const idx=all.findIndex(p=>p.pickId===pick.pickId);
    if(idx>=0)all[idx]={...pick,updatedAt:new Date().toISOString()};
    else all.push(pick);
  }
  save(KEYS.PICKS,all);
}
export function hasPlayerSubmitted(weekId,playerId){
  const picks=getPicks(weekId,playerId);
  const games=getGames(weekId);
  return games.length>0&&picks.length>=games.length;
}

// ─── RESULTS ──────────────────────────────────────────────────────────────────

export function getWeeklyResults(weekId=null){
  const r=load(KEYS.RESULTS)||[];
  return weekId?r.filter(x=>x.weekId===weekId):r;
}
export function saveAllWeeklyResults(weekId,newResults){
  const existing=(load(KEYS.RESULTS)||[]).filter(r=>r.weekId!==weekId);
  save(KEYS.RESULTS,[...existing,...newResults]);
}

// ─── OBLIGATIONS ──────────────────────────────────────────────────────────────

export function getObligations(weekId=null){
  const all=load(KEYS.OBLIGATIONS)||[];
  return weekId?all.filter(o=>o.weekId===weekId):all;
}
export function saveObligation(ob){
  const all=load(KEYS.OBLIGATIONS)||[];
  const idx=all.findIndex(o=>o.obligationId===ob.obligationId);
  if(idx>=0)all[idx]=ob;else all.push(ob);
  save(KEYS.OBLIGATIONS,all);
}
export function saveAllObligations(list){ save(KEYS.OBLIGATIONS, list || []); }
export function createObligation(weekId,payerPlayerId,recipientPlayerId,prize,type='weekly'){
  return{
    obligationId:`ob_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
    type,weekId,payerPlayerId,recipientPlayerId,
    amountOrPrize:prize,status:'unpaid',
    createdAt:new Date().toISOString(),paidAt:null,
  };
}


// ─── SCOPED RESET (current week only) ────────────────────────────────────────

/**
 * Reset only the current/active week's slate and picks.
 * Does NOT touch players, other weeks, results, or settings.
 */
export function resetCurrentWeekData(weekId) {
  if (!weekId) return;
  clearSlateForWeek(weekId);
  clearAvailableGames(weekId);
  // Remove picks for this week only
  const allPicks = load(KEYS.PICKS) || [];
  save(KEYS.PICKS, allPicks.filter(p => p.weekId !== weekId));
  // Remove results for this week only
  const allResults = load(KEYS.RESULTS) || [];
  save(KEYS.RESULTS, allResults.filter(r => r.weekId !== weekId));
  // Remove obligations for this week only
  const allObs = load(KEYS.OBLIGATIONS) || [];
  save(KEYS.OBLIGATIONS, allObs.filter(o => o.weekId !== weekId));
  // Remove tiebreaker guesses for this week
  const allTb = load(KEYS.TB_GUESSES) || {};
  Object.keys(allTb).forEach(k => { if(k.startsWith(weekId+'__')) delete allTb[k]; });
  save(KEYS.TB_GUESSES, allTb);
  // Remove Extra Point guesses for this week
  const allEp = load(KEYS.EP_GUESSES) || {};
  Object.keys(allEp).forEach(k => { if(k.startsWith(weekId+'__')) delete allEp[k]; });
  save(KEYS.EP_GUESSES, allEp);
  // Remove emoji reactions for this week
  clearReactionsForWeek(weekId);
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────

export function exportAllData(){
  return{
    exportedAt:new Date().toISOString(),
    settings:getSettings(),players:getPlayers(),
    weeks:getWeeks(),games:getGames(),
    picks:load(KEYS.PICKS)||[],results:load(KEYS.RESULTS)||[],
    obligations:getObligations(),nicknames:getNicknames(),
    tiebreakerGuesses:getTiebreakerGuesses(),
    extraPointGuesses:getExtraPointGuesses(),
  };
}

/**
 * Raw snapshot keyed by the ACTUAL storage keys (cfbp_*). Used to seed/push the
 * shared backend. Reads LOCALSTORAGE directly (not the backend cache) so a
 * "push local to Sheet" seed always sends this device's local data. Device-local
 * keys (session, site unlock, backend config) are excluded so they never sync.
 */
export function exportAllDataRaw(){
  const out={};
  Object.values(KEYS).forEach(k=>{
    if(DEVICE_LOCAL_KEYS.has(k)) return;
    try{
      const raw=localStorage.getItem(k);
      if(raw!=null) out[k]=JSON.parse(raw);
    }catch(e){ /* skip unparseable */ }
  });
  return out;
}
