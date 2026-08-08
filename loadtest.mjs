/**
 * CFB Pickems — loadtest.mjs (v0.17.0)
 * =====================================
 * MANDATORY after every multi-edit batch (`node --check` is NOT sufficient —
 * it can't catch broken imports, missing exports, or runtime top-level errors;
 * the v0.13 regression proved it).
 *
 * Run:  node loadtest.mjs
 *
 * 1. Stubs enough DOM/localStorage for every module to import cleanly.
 * 2. Imports ALL app modules (incl. app.js top-level execution).
 * 3. Chat fold correctness suite:
 *    - out-of-order seq ingestion
 *    - duplicate id dedupe
 *    - edit arriving BEFORE its target message
 *    - react on a not-yet-seen target (buffered, then applied)
 *    - delete on an already-edited message
 *    - order-independence: same event array shuffled 10×, identical fold
 *    - unread math against a fixture lastSeenSeq
 * 4. Extra Point blackjack grading suite.
 */

import { readFile } from 'node:fs/promises';

// ── DOM / browser stubs ───────────────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};
const nullEl = new Proxy(function () {}, {
  get: (t, p) => {
    if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
    if (p === 'style') return {};
    if (p === 'dataset') return {};
    if (['addEventListener', 'removeEventListener', 'appendChild', 'removeChild', 'insertAdjacentHTML', 'remove', 'focus', 'scrollTo'].includes(p)) return () => {};
    if (p === 'querySelectorAll') return () => [];
    if (p === 'querySelector' || p === 'closest') return () => null;
    if (p === 'innerHTML' || p === 'textContent' || p === 'value') return '';
    return undefined;
  },
  set: () => true,
});
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ ...({}), set innerHTML(v) {}, get innerHTML() { return ''; }, appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {} }, style: {}, id: '', className: '' }),
  body: { classList: { add() {}, remove() {} }, appendChild() {}, innerHTML: '' },
  hidden: false,
};
globalThis.window = globalThis;
try { globalThis.navigator = { serviceWorker: undefined, clipboard: { writeText: async () => {} } }; }
catch { Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: undefined, clipboard: { writeText: async () => {} } }, configurable: true }); }
globalThis.requestAnimationFrame = fn => fn();
globalThis.fetch = async () => { throw new Error('network disabled in loadtest'); };
globalThis.matchMedia = () => ({ matches: false });
globalThis.confirm = () => true;
globalThis.prompt = () => null;
globalThis.alert = () => {};
if (!globalThis.crypto?.randomUUID) globalThis.crypto = { randomUUID: () => 'uuid_' + Math.random().toString(36).slice(2) };

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.error('  ❌', label); }
}

// ── 1. Module import smoke test ───────────────────────────────────────────────
console.log('\n[1] Importing all modules…');
const mods = {};
for (const m of ['data-model', 'storage', 'scoring', 'data-provider', 'notifications', 'backend', 'chatTransport', 'chat', 'scribeLines', 'extra-point', 'recap', 'history-2025', 'chat-ui', 'app']) {
  try {
    mods[m] = await import(`./js/${m}.js`);
    console.log('  ✅ js/' + m + '.js');
    pass++;
  } catch (e) {
    console.error('  ❌ js/' + m + '.js —', e.message);
    fail++;
  }
}

// ── 2. Chat fold suite (v0.17.0 — one room + gameTag) ─────────────────────────
console.log('\n[2] Chat fold correctness (gameTag model)…');
const chat = mods['chat'];
const { ingest, getMessages, getMessage, unreadCount, mentionUnreadCount,
        resolveTag, chatDigest, _resetForTest, _foldedSnapshot } = chat;

function ev(o) { return { gameTag: '', type: 'message', author: 'p1', body: '', notify: o.type === 'message' || o.type === undefined, ...o }; }

// Base log with every tricky case
const LOG = [
  ev({ id: 'm1', seq: 1, ts: 1000, body: 'first' }),
  ev({ id: 'e1', seq: 5, ts: 5000, type: 'edit', targetId: 'm2', body: 'second (edited)', notify: false }),  // edit BEFORE its target
  ev({ id: 'm2', seq: 2, ts: 2000, body: 'second' }),
  ev({ id: 'r1', seq: 6, ts: 6000, type: 'react', targetId: 'm3', meta: { emoji: '💀' }, author: 'p2', notify: false }), // react before target
  ev({ id: 'm3', seq: 3, ts: 3000, body: 'third', author: 'p2' }),
  ev({ id: 'm1', seq: 1, ts: 1000, body: 'first' }),                                          // duplicate id
  ev({ id: 'e2', seq: 7, ts: 7000, type: 'edit', targetId: 'm3', body: 'third (edited)', author: 'p2', notify: false }),
  ev({ id: 'd1', seq: 8, ts: 8000, type: 'delete', targetId: 'm3', author: 'p2', notify: false }),  // delete an edited msg
  ev({ id: 'm4', seq: 4, ts: 4000, body: 'fourth — tagged', author: 'p3', gameTag: 'g1' }),
  ev({ id: 'r2', seq: 9, ts: 9000, type: 'react', targetId: 'm1', meta: { emoji: '🔥' }, author: 'p3', notify: false }),
  ev({ id: 'u1', seq: 10, ts: 10000, type: 'unreact', targetId: 'm1', meta: { emoji: '🔥' }, author: 'p3', notify: false }),
  ev({ id: 'p1pin', seq: 11, ts: 11000, type: 'pin', targetId: 'm4', author: 'p1', notify: false }),
  ev({ id: 'gr1', seq: 12, ts: 12000, type: 'gamereact', gameTag: 'g1', meta: { emoji: '🔥' }, author: 'p2', notify: false }),
  ev({ id: 'm5', seq: 13, ts: 13000, body: '@Drew you seeing this', author: 'p2', meta: { mentions: ['p9'] } }),
];

_resetForTest();
ingest(LOG);
let msgs = getMessages({ tag: 'all' });

assert(msgs.filter(m => m.type === 'message').length === 5, 'dedupe: 5 unique messages from 6 message events');
assert(getMessage('m2').body === 'second (edited)' && getMessage('m2').edited, 'edit-before-target applied after target arrived');
assert(getMessage('m3').deleted === true, 'delete lands on an already-edited message');
assert(getMessage('m3').body === 'third (edited)', 'edit preserved under the tombstone');
assert((getMessage('m3').reactions['💀'] || []).length === 1, 'react buffered before target, then applied');
assert(!(getMessage('m1').reactions['🔥'] || []).length, 'react + unreact nets to zero');
assert(getMessage('m4').pinned === true, 'pin event folds onto its target');
assert(getMessages({ tag: 'g1' }).length === 2, 'tag filter: tagged message + gamereact only');
assert(getMessages({ tag: 'all', pinned: true }).length === 1, 'Hall of Records filter = pinned only');

// The cross-talk rule
assert(resolveTag({ replyTo: 'm4', viewTag: '' }) === 'g1', 'reply to tagged parent from main room inherits the tag');
assert(resolveTag({ replyTo: 'm1', viewTag: 'g1' }) === '', 'reply to untagged parent from a game view inherits null (parent wins)');
assert(resolveTag({ replyTo: null, viewTag: 'g2' }) === 'g2', 'no reply → view tag applies');
assert(resolveTag({ replyTo: null, viewTag: '' }) === '', 'main room composes untagged');

// order-independence: shuffle 10×, identical folded snapshot
_resetForTest(); ingest(LOG);
const baseline = _foldedSnapshot();
let orderOk = true;
for (let i = 0; i < 10; i++) {
  const shuffled = [...LOG];
  for (let j = shuffled.length - 1; j > 0; j--) {
    const k = Math.floor(Math.random() * (j + 1));
    [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
  }
  _resetForTest();
  ingest(shuffled);
  if (_foldedSnapshot() !== baseline) orderOk = false;
}
assert(orderOk, 'fold is order-independent across 10 shuffles');

_resetForTest(); ingest(LOG); ingest(LOG);
assert(_foldedSnapshot() === baseline, 'fold is idempotent (double ingest identical)');

// unread math vs fixture (notify-based; ambient NEVER counts)
_resetForTest(); ingest(LOG);
localStorage.setItem('cfbp_chat_lastseen2', JSON.stringify({ seq: 2, byTag: {} }));
// p9 above seq2: m3 deleted (no), m4 notify (yes), gr1 ambient (no), m5 notify (yes) → 2
assert(unreadCount('p9', 'all') === 2, 'unread: notifying msgs only, deleted + ambient excluded');
assert(unreadCount('p9', 'g1') === 1, 'per-tag unread: only the tagged message counts, not the gamereact');
assert(unreadCount('p3', 'all') === 1, 'own messages never count toward own unread');
assert(mentionUnreadCount('p9') === 1, 'mention inbox: meta.mentions drives the count');
localStorage.removeItem('cfbp_chat_lastseen2');

// digest smoke (client-side, v2 shape)
const dg = chatDigest(0, 20000, { players: [] });
assert(dg.volume.total === 4, 'digest counts live human messages only');
assert(typeof dg.engagement.reactionRate === 'number', 'digest v2 carries engagement instrumentation');

// ── 3. Extra Point blackjack grading ─────────────────────────────────────────
console.log('\n[3] Extra Point blackjack grading…');
const { gradeExtraPoint } = mods['extra-point'];
const g1 = gradeExtraPoint(52, [
  { playerId: 'a', displayName: 'A', guess: 52 },   // blackjack
  { playerId: 'b', displayName: 'B', guess: 49 },
  { playerId: 'c', displayName: 'C', guess: 55 },   // bust
  { playerId: 'd', displayName: 'D', guess: null }, // no entry
]);
assert(g1.rows.find(r => r.playerId === 'a').outcome === 'blackjack', 'exact hit = blackjack');
assert(g1.winners.length === 1 && g1.winners[0] === 'a', 'blackjack beats closer-under');
assert(g1.rows.find(r => r.playerId === 'c').outcome === 'bust', 'over = bust');
assert(g1.rows.find(r => r.playerId === 'd').outcome === 'no-entry', 'missing guess = no-entry');

const g2 = gradeExtraPoint(50, [
  { playerId: 'a', displayName: 'A', guess: 48 },
  { playerId: 'b', displayName: 'B', guess: 48 },
  { playerId: 'c', displayName: 'C', guess: 40 },
]);
assert(g2.winners.length === 2 && g2.rows.filter(r => r.outcome === 'push-win').length === 2, 'tied best = shared push-win');

const g3 = gradeExtraPoint(45, [
  { playerId: 'a', displayName: 'A', guess: 46 },
  { playerId: 'b', displayName: 'B', guess: 50 },
]);
assert(g3.allBusted === true && g3.winners.length === 0, 'everyone over = table bust');

// ── 4. SCRIBE pools sanity ────────────────────────────────────────────────────
console.log('\n[4] SCRIBE voice pool sanity…');
const { SCRIBE_POOLS } = mods['scribeLines'];
let capsViolations = 0, profanityHeavy = 0;
Object.entries(SCRIBE_POOLS).forEach(([k, pool]) => {
  const profane = pool.filter(l => /\b(fuck|shit|damn|ass)\b/i.test(l)).length;
  if (profane > 1) profanityHeavy++;
  pool.forEach(raw => {
    const l = raw.replace(/\{NAME\}|\{N\}|\{TEAM\}/g, 'name');
    const words = l.split(/\s+/).filter(w => w.length > 3 && w === w.toUpperCase() && /[A-Z]{4,}/.test(w) && !['SCRIBE', 'NOTE:', 'BLACKJACK', 'BUST.', 'FINAL:'].includes(w));
    if (words.length) capsViolations++;
  });
});
assert(profanityHeavy === 0, 'max one profanity per pool');
assert(capsViolations === 0, 'almost no ALL CAPS (restraint is the bit)');
assert(Object.values(SCRIBE_POOLS).every(p => p.length >= 4), 'every pool has ≥4 lines');

// ── 5. Team shorthand: ONE source, shared with the compact dashboard ─────────
// Guard for v0.17.2 RG: chat-ui.js carried its own `name.split(' ').pop()`
// heuristic, so "Southern California" rendered as "California" in chat while
// the dashboard said "USC". Both now build from data-model's buildAbbrMap.
console.log('\n[5] Team shorthand — single shared source…');
const dm = mods['data-model'];
assert(typeof dm.buildAbbrMap === 'function', 'buildAbbrMap exported from data-model.js');
assert(typeof dm.TEAM_ABBR === 'object' && dm.TEAM_ABBR, 'TEAM_ABBR exported from data-model.js');

const abbrFixture = [
  { homeTeam: 'USC', awayTeam: 'San Jose State' },
  { homeTeam: 'Arkansas State', awayTeam: 'Arkansas' },
  { homeTeam: 'Texas A&M', awayTeam: 'Ohio State' },
  { homeTeam: 'Miami (OH)', awayTeam: 'Miami' },
];
const abbrMap = dm.buildAbbrMap(abbrFixture);
assert(abbrMap.get('USC') === 'USC', 'USC → USC');
assert(abbrMap.get('San Jose State') === 'SJSU', 'San Jose State → SJSU (not "State")');
assert(abbrMap.get('Arkansas State') === 'ARST' && abbrMap.get('Arkansas') === 'ARK',
  'Arkansas vs Arkansas State stay distinct (RG-02 family)');
assert(abbrMap.get('Texas A&M') === 'TAMU', 'Texas A&M → TAMU');
// No two teams on one slate may collapse to the same shorthand.
const abbrVals = [...abbrMap.values()];
assert(new Set(abbrVals).size === abbrVals.length, 'no duplicate abbreviations within a slate');
// The naive heuristic this replaced would have produced these — assert we don't.
assert(abbrMap.get('San Jose State') !== 'State' && abbrMap.get('Arkansas State') !== 'State',
  'the retired split-on-space heuristic is gone');

// ── 6. iOS hostile-environment init (v0.17.2) ───────────────────────────────
// Reproduces the reported iOS failure: Private Browsing makes localStorage
// throw. chat.js was already guarded; chat-ui.js was not, so tapping a
// dashboard bubble threw before the sheet rendered.
console.log('\n[6] iOS hostile environment — throwing localStorage…');
const realLS = globalThis.localStorage;
const realCrypto = globalThis.crypto;
const realNav = globalThis.navigator;
let hostileOk = true, hostileErr = '';
try {
  const thrower = () => { throw new Error('SecurityError: private browsing'); };
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: thrower, setItem: thrower, removeItem: thrower, clear: thrower },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });      // no randomUUID
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });    // no setAppBadge
  // Re-import with a cache-busting query so module top-level runs again.
  await import(`./js/chat-ui.js?hostile=${Date.now()}`);
  await import(`./js/chat.js?hostile=${Date.now()}`);
} catch (e) {
  hostileOk = false; hostileErr = e.message;
} finally {
  Object.defineProperty(globalThis, 'localStorage', { value: realLS, configurable: true });
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: realNav, configurable: true });
}
assert(hostileOk, `chat modules import with localStorage throwing + no crypto/navigator${hostileErr ? ' — ' + hostileErr : ''}`);

// Static guard: no bare localStorage calls may creep back into chat-ui.js.
const chatUiSrc = await readFile(new URL('./js/chat-ui.js', import.meta.url), 'utf8');
const bareLS = chatUiSrc
  .split('\n')
  .filter(l => /localStorage\./.test(l) && !/^\s*\*/.test(l) && !/function lsGet|function lsSet/.test(l));
assert(bareLS.length === 0,
  `chat-ui.js routes all localStorage through lsGet/lsSet${bareLS.length ? ' — found: ' + bareLS[0].trim() : ''}`);

// setAppBadge returns a Promise; an unhandled rejection breaks sync (CONVENTIONS #4).
assert(/setAppBadge[\s\S]{0,220}?\.catch\(/.test(chatUiSrc),
  'setAppBadge promise rejection is caught, not just the throw');

// ── 7. Presence removal (v0.17.2) — unread counting must survive ─────────────
// Presence ("N here now") and read receipts ("seen by k") were removed: both
// rode a 90s CacheService heartbeat, so the indicator could be wrong by up to
// 90 seconds (AD-19, amended). The HAZARD in that removal is that presence
// piggybacked its heartbeat on `lastSeenSeq` — the same value that drives
// unread counts and the dashboard bubbles. Unread is a SEPARATE feature and
// must keep working. These assertions are the guard.
console.log('\n[7] Presence removed; unread counting intact…');
const transport = mods['chatTransport'];

// 7a. The presence surface is gone from both modules.
assert(chat.presenceList === undefined, 'chat.js no longer exports presenceList()');
assert(chat.seenByCount === undefined, 'chat.js no longer exports seenByCount()');
assert(transport.heartbeat === undefined, 'chatTransport.js no longer exports heartbeat() (AD-16: transport is the only backend seam)');
assert(chat.chatStatus().presence === undefined, 'chatStatus() no longer carries a presence array');

const chatSrc = await readFile(new URL('./js/chat.js', import.meta.url), 'utf8');
const code = l => !/^\s*(\/\/|\*|\/\*)/.test(l);          // ignore the removal-rationale comments
const chatCode = chatSrc.split('\n').filter(code).join('\n');
assert(!/startPresence|presenceTimer|S\.seenMap|S\.presence\b/.test(chatCode),
  'chat.js carries no presence timer or presence state');
assert(!/\bheartbeat\b/.test(chatCode), 'chat.js no longer imports or calls heartbeat()');
assert(/removeItem\('cfbp_chat_seenmap'\)/.test(chatCode) && !/setItem\('cfbp_chat_seenmap'/.test(chatCode),
  'the orphaned cfbp_chat_seenmap key is cleaned up, never written');

const uiCode = chatUiSrc.split('\n').filter(code).join('\n');
assert(!/presenceList|seenByCount|chat-seen|here now/.test(uiCode),
  'chat-ui.js renders no presence line and no "seen by k" receipt');
// UN-67: SCRIBE's member framing was concatenated onto the presence line. It is
// static copy, not presence-derived, and must survive the removal.
//
// v0.17.4 (UN-104) narrowed this guard, not deleted it (§5 "a tripwire that
// starts crying wolf gets narrowed, never deleted"): the header subtitle that
// used to carry the LITERAL string "SCRIBE on duty" is gone — UN-104 dropped
// it to compact the header to one line. The underlying UN-67 requirement
// (SCRIBE reads as a standing member, not a summoned bot) is unchanged and
// was verified (per the design input) to survive in the empty-room state
// ("SCRIBE is on duty.") before the subtitle was removed. §[23] adds the
// second surviving instance (the Rules FAQ) as its own guard.
assert(/SCRIBE (on duty|is on duty)/.test(uiCode), 'UN-67: SCRIBE "on duty" framing survives (now via the empty-room state, not the removed header subtitle)');

const cssSrc = await readFile(new URL('./css/styles.css', import.meta.url), 'utf8');
assert(!/\.chat-seen\b/.test(cssSrc), 'read-receipt CSS (.chat-seen) removed');

// v0.17.2: the .chat-pill tap target was ~28-30px, under the 40px floor
// (CONVENTIONS #17). This was the one PRE-EXISTING defect fixed in batch 2 and
// it was the only change shipping without an assertion. Applies to every pill
// in the row, not just the newly-labelled Records pill.
const pillRule = (cssSrc.match(/\.chat-pill\s*\{[^}]*\}/) || [''])[0];
const pillMinH = (pillRule.match(/min-height:\s*(\d+)px/) || [])[1];
assert(Number(pillMinH) >= 40,
  `.chat-pill tap target >= 40px (CONVENTIONS #17) — got ${pillMinH || 'no min-height'}`);


// 7b. Unread counting end-to-end — the thing most likely to break.
// Section [2] covers unreadCount against a fixture; this covers the full
// read-position LIFECYCLE (getLastSeen → markSeen → new arrivals), which is
// what actually shared state with the deleted heartbeat.
const { markSeen, getLastSeen } = chat;
assert(typeof markSeen === 'function' && typeof getLastSeen === 'function' && typeof unreadCount === 'function',
  'unread machinery (getLastSeen / markSeen / unreadCount) still exported');

_resetForTest();
localStorage.removeItem('cfbp_chat_lastseen2');
ingest(LOG);                                     // head → 13
assert(unreadCount('p9', 'all') === 4, 'unread from a clean read-position: 4 notifying messages');

markSeen('all');
assert(getLastSeen().seq === 13, 'markSeen("all") advances the device-local read position to head');
assert(unreadCount('p9', 'all') === 0, 'unread clears to zero after markSeen — no heartbeat required');

ingest([ev({ id: 'm6', seq: 14, ts: 14000, body: 'after the mark', author: 'p2' })]);
assert(unreadCount('p9', 'all') === 1, 'a message arriving after markSeen counts as unread again');

ingest([ev({ id: 'm7', seq: 15, ts: 15000, body: 'tagged, after the mark', author: 'p3', gameTag: 'g1' })]);
assert(unreadCount('p9', 'g1') === 1, 'per-tag unread still tracks its own read position');
markSeen('g1');
assert(unreadCount('p9', 'g1') === 0, 'markSeen(tag) clears only that tag');
assert(unreadCount('p9', 'all') === 2, 'clearing one tag does not clear the room-wide count (dashboard bubble intact)');
localStorage.removeItem('cfbp_chat_lastseen2');

// ── 8. THE PICK REVEAL RITUAL — shorthand in the permanent log ───────────────
// The reveal event is written ONCE per week under a deterministic id
// (`sys_reveal_<weekId>`) into an append-only, idempotent log. Whatever text it
// carries is FROZEN — a wrong abbreviation there can never be re-emitted. That
// makes shorthand correctness in this one emitter a higher bar than anywhere
// else in the app.
//
// The defect this section pins down: chat-ui.js still carried the retired
// `name.split(' ').pop()` heuristic at two sites, one of them inside
// emitPickRevealEvent. On a slate with both "Arkansas State" and "Ohio State"
// every reader saw "State · State" and could not tell which team was picked.
console.log('\n[8] Pick reveal ritual — frozen-log shorthand + vocabulary…');
const storage = mods['storage'];
const chatUi = mods['chat-ui'];

// 8a. The literal reported failure. "Southern California" is ESPN's long-form
// location for USC; the dashboard said USC and chat said something else.
assert(typeof dm.teamAbbr === 'function', 'teamAbbr exported from data-model.js');
assert(dm.teamAbbr('Southern California') === 'USC',
  `teamAbbr('Southern California') → USC (got "${dm.teamAbbr('Southern California')}")`);
// Same string through the slate-aware path the renderers actually use.
assert(dm.buildAbbrMap([{ homeTeam: 'Southern California', awayTeam: 'Texas' }]).get('Southern California') === 'USC',
  'buildAbbrMap resolves "Southern California" → USC too (one table, both entry points)');

// 8b. Two "State" schools on one slate must never collapse to one shorthand.
const stateSlate = dm.buildAbbrMap([
  { homeTeam: 'Ohio State', awayTeam: 'Texas' },
  { homeTeam: 'Arkansas State', awayTeam: 'Southern California' },
]);
assert(stateSlate.get('Ohio State') !== stateSlate.get('Arkansas State'),
  'Arkansas State and Ohio State get DIFFERENT shorthand on the same slate');
assert(stateSlate.get('Ohio State') !== 'State' && stateSlate.get('Arkansas State') !== 'State',
  'neither "State" school degrades to the bare word "State"');

// 8c. Source guard — the split-on-space team heuristic may not come back.
// Deliberately narrow: matches only `.split(' ').pop()` (a split on one literal
// space immediately reduced to its last word), which is the shorthand heuristic
// and nothing else. Does not fire on .split('\n'), .split(/\s+/), .split(',').
const splitPop = chatUiSrc.split('\n')
  .filter(l => code(l) && /\.split\((['"]) \1\)\s*\.pop\(\)/.test(l));
assert(splitPop.length === 0,
  `chat-ui.js has no split-on-space team-shorthand heuristic${splitPop.length ? ' — found: ' + splitPop[0].trim() : ''}`);

// 8d. UN-77 — "order(s)" is retired vocabulary. Picks are PICKS (docs/SCRIBE.md).
//
// v0.17.2: this guard originally covered only chat-ui.js, and VT-77 in the
// ledger scoped its grep to scribeLines.js alone. That gap is exactly why two
// live instances survived a ✅ in emitPickRevealEvent, and why the SINGULAR
// "Order busted at the gun." survived in scribeLines.js. The sweep now covers
// every module and both forms.
//
// Scoped to STRING LITERALS only. Identifiers like `dashboardColumnOrder` and
// `const order = …` are sort order, not league vocabulary — matching those
// would make this guard cry wolf until someone deleted it.
const VOCAB_FILES = ['chat-ui.js', 'chat.js', 'scribeLines.js', 'recap.js', 'app.js', 'extra-point.js'];
const STRING_LITERAL = /'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g;
const ordersHits = [];
for (const f of VOCAB_FILES) {
  const src = await readFile(new URL(`./js/${f}`, import.meta.url), 'utf8');
  src.split('\n').forEach((l, i) => {
    if (!code(l)) return;                            // skip comments
    for (const lit of l.match(STRING_LITERAL) || []) {
      if (/\border(s)?\b/i.test(lit)) ordersHits.push(`${f}:${i + 1} ${lit.trim().slice(0, 60)}`);
    }
  });
}
assert(ordersHits.length === 0,
  `UN-77: no "order/orders" copy survives in any module${ordersHits.length ? ' — found: ' + ordersHits[0] : ''}`);

// 8e. End-to-end through the real emitter. This is the assertion that actually
// exercises the frozen log: seed a locked week whose slate carries both "State"
// schools plus USC's long-form name, emit the reveal, read the event body back
// out of the fold, and require the picked teams to be distinguishable.
const RW = {
  weekId: 'rg_reveal_wk', weekNumber: 99, season: 2026, status: 'locked',
  dataSourceMode: 'demo', startDate: '2026-09-05', endDate: '2026-09-05',
};
storage.saveWeek(RW);
storage.saveGame({ weekId: RW.weekId, gameId: 'rg_g1', homeTeam: 'Ohio State',     awayTeam: 'Texas',               kickoff: '2026-09-05T16:00:00Z', status: 'scheduled' });
storage.saveGame({ weekId: RW.weekId, gameId: 'rg_g2', homeTeam: 'Arkansas State', awayTeam: 'Southern California', kickoff: '2026-09-05T20:00:00Z', status: 'scheduled' });
storage.addPlayer({ playerId: 'rg_p1', displayName: 'RevealTester', active: true });
storage.saveAllPicks([
  { pickId: 'rg_pk1', weekId: RW.weekId, gameId: 'rg_g1', playerId: 'rg_p1', selectedTeam: 'Ohio State' },
  { pickId: 'rg_pk2', weekId: RW.weekId, gameId: 'rg_g2', playerId: 'rg_p1', selectedTeam: 'Arkansas State' },
]);

assert(storage.getEffectiveWeekStatus(storage.getWeek(RW.weekId)) === 'locked',
  'reveal fixture week is LOCKED (the blind rule permits the reveal)');

chatUi.emitPickRevealEvent(storage.getWeek(RW.weekId));
const revealMsg = getMessage(`sys_reveal_${RW.weekId}`);
assert(!!revealMsg, 'reveal event lands in the log under its deterministic id');

const revealLine = (revealMsg?.body || '').split('\n').find(l => l.startsWith('RevealTester'));
const revealParts = (revealLine || '').split(': ')[1]?.split(' · ') || [];
assert(revealParts.length === 2, `reveal row carries one cell per game (got ${revealParts.length})`);
assert(revealParts[0] !== revealParts[1],
  `reveal row keeps Ohio State and Arkansas State DISTINCT — got "${revealParts.join(' · ')}"`);
assert(!revealParts.includes('State'),
  `no reveal cell is the bare word "State" — got "${revealParts.join(' · ')}"`);
// Distinctness alone would still pass if the map lookup broke entirely and fell
// through to the full team name — "Ohio State" and "Arkansas State" are also
// distinct. Assert the cells are actually SHORTHAND, so a silent regression to
// full names is caught too.
assert(revealParts.every(p => p.length <= 5 && !/\s/.test(p)),
  `reveal cells are shorthand, not full team names — got "${revealParts.join(' · ')}"`);
assert(!/\borders\b/i.test(revealMsg?.body || '') && !/\borders\b/i.test(revealMsg?.meta?.title || ''),
  `UN-77: emitted reveal event says picks, not orders — title "${revealMsg?.meta?.title || ''}"`);

// 8g. The abbr memo is a WITHIN-PASS cache. It must be cleared at the top of
// every render entry point that can reach gameShort — renderChatPage,
// renderPillsOnly, renderSheetMessages. A missed clear serves stale shorthand
// after the commissioner edits a slate mid-session. The harness stubs
// getElementById to null, so those functions early-return before the clear and
// cannot be exercised behaviorally here; this is a source-level tripwire on the
// invariant instead.
const clearCount = (chatUiSrc.match(/_abbrMemo\.clear\(\)/g) || []).length;
assert(clearCount === 3,
  `_abbrMemo cleared at all 3 render entry points (found ${clearCount})`);

// The blind rule is not weakened by any of the above: an OPEN week emits nothing.
const OPEN_W = { ...RW, weekId: 'rg_open_wk', status: 'open' };
storage.saveWeek(OPEN_W);
storage.saveGame({ weekId: OPEN_W.weekId, gameId: 'rg_g3', homeTeam: 'Ohio State', awayTeam: 'Texas', kickoff: '2026-09-05T16:00:00Z', status: 'scheduled' });
chatUi.emitPickRevealEvent(storage.getWeek(OPEN_W.weekId));
assert(!getMessage(`sys_reveal_${OPEN_W.weekId}`),
  'BLIND RULE: no reveal event is emitted while the week is still open');

// ── 9. Debt-payment approval (UN-8x) — state machine + ob2025 migration ──────
console.log('\n[9] Debt-payment approval — state machine + ob2025 migration…');
const ob2025Status = mods['history-2025'].ob2025Status;

// 9a. ob2025 boolean→status migration. THIS IS THE DANGEROUS ONE: a legacy
// `true` (every "Mark Paid" click before this batch) MUST still read as
// 'paid', or previously-settled 2K25 drinks silently revert to unpaid.
assert(ob2025Status({}, 'x') === 'unpaid', 'ob2025Status: an absent key reads as unpaid');
assert(ob2025Status({ x: true }, 'x') === 'paid',
  'ob2025Status: LEGACY BOOLEAN true still reads as paid (the backward-compat guarantee)');
assert(ob2025Status({ x: 'pending' }, 'x') === 'pending', "ob2025Status: 'pending' round-trips");
assert(ob2025Status({ x: 'paid' }, 'x') === 'paid', "ob2025Status: 'paid' round-trips");
assert(ob2025Status({ x: false }, 'x') === 'unpaid', 'ob2025Status: false (never a real stored value) still reads as unpaid, not paid');

// 9b. DEFAULT_SETTINGS default-when-missing story for the debt machine's sibling
// feature — chatRetentionDays defaults OFF so old settings blobs still work.
assert(dm.DEFAULT_SETTINGS.chatRetentionDays === 0,
  'DEFAULT_SETTINGS.chatRetentionDays defaults to 0 (off) — old settings blobs without the field still work');

// 9c. The obligation state machine (pure, data-model.js) — every case in the spec.
const { obligationNextStatus, obligationRole, obligationStatusDisplay } = dm;
assert(obligationNextStatus('unpaid', 'payer', 'mark') === 'pending',
  'payer marks paid from unpaid → pending (needs confirmation)');
assert(obligationNextStatus('unpaid', 'creditor', 'mark') === 'paid',
  "creditor's own mark from unpaid → paid directly (their action IS the verification)");
assert(obligationNextStatus('unpaid', 'admin', 'mark') === 'paid',
  'commissioner marks paid from unpaid → paid directly, no pending');
assert(obligationNextStatus('pending', 'creditor', 'confirm') === 'paid', 'creditor confirms a pending claim → paid');
assert(obligationNextStatus('pending', 'admin', 'confirm') === 'paid', 'commissioner confirms a pending claim → paid');
assert(obligationNextStatus('pending', 'creditor', 'deny') === 'unpaid', 'creditor denies a pending claim → unpaid');
assert(obligationNextStatus('pending', 'admin', 'deny') === 'unpaid', 'commissioner denies a pending claim → unpaid');
assert(obligationNextStatus('paid', 'admin', 'undo') === 'unpaid', 'commissioner undo from paid → unpaid (pre-existing affordance, unchanged)');
// Illegal transitions refuse outright — they never guess at a status.
assert(obligationNextStatus('unpaid', 'bystander', 'mark') === null, 'a bystander cannot mark an obligation paid');
assert(obligationNextStatus('pending', 'payer', 'confirm') === null, "the payer can't confirm their own pending claim");
assert(obligationNextStatus('pending', 'payer', 'deny') === null, "the payer can't deny their own pending claim");
assert(obligationNextStatus('paid', 'creditor', 'undo') === null, 'only the commissioner can undo a paid obligation');

// 9d. obligationRole priority: admin > creditor > payer > bystander.
const obFixture = { payerPlayerId: 'pay1', recipientPlayerId: 'rec1' };
assert(obligationRole({ isAdmin: true, playerId: 'pay1' }, obFixture) === 'admin', 'admin role wins even when also the payer');
assert(obligationRole({ isAdmin: false, playerId: 'rec1' }, obFixture) === 'creditor', 'the recipient reads as creditor');
assert(obligationRole({ isAdmin: false, playerId: 'pay1' }, obFixture) === 'payer', 'the payer reads as payer');
assert(obligationRole({ isAdmin: false, playerId: 'nobody' }, obFixture) === 'bystander', 'everyone else is a bystander');

// 9e. Status → display mapping reuses existing badge classes only (spec: no
// new CSS variable, no theme-survival risk) and never prints the raw string.
assert(obligationStatusDisplay('pending').badgeClass === 'badge-nd', 'pending → badge-nd (the existing no-decision tan)');
assert(obligationStatusDisplay('unpaid').badgeClass === 'badge-locked', 'unpaid → badge-locked');
assert(obligationStatusDisplay('paid').badgeClass === 'badge-open', 'paid → badge-open');
assert(obligationStatusDisplay('waived').badgeClass === 'badge-final', 'waived → badge-final (unaffected by this batch)');
assert(obligationStatusDisplay('pending').label === 'Pending', 'status maps to a human label, not the raw lowercase string');

// 9f. exportObligationsCSV must emit 'pending' distinctly from unpaid/paid —
// the whole point of the export is the commissioner's audit trail.
const { buildObligationsCsvRows } = mods['app'];
const csvObs = [
  { obligationId: 'o1', type: 'weekly', weekId: null, payerPlayerId: 'p1', recipientPlayerId: 'p2', amountOrPrize: '1 drink', status: 'unpaid', createdAt: '', paidAt: '' },
  { obligationId: 'o2', type: 'weekly', weekId: null, payerPlayerId: 'p1', recipientPlayerId: 'p2', amountOrPrize: '1 drink', status: 'pending', createdAt: '', paidAt: '' },
  { obligationId: 'o3', type: 'weekly', weekId: null, payerPlayerId: 'p1', recipientPlayerId: 'p2', amountOrPrize: '1 drink', status: 'paid', createdAt: '', paidAt: '' },
];
const csvRows = buildObligationsCsvRows(csvObs, { p1: 'A', p2: 'B' }, {});
const statusCol = csvRows.slice(1).map(r => r[6]);
assert(statusCol.includes('pending') && statusCol.includes('unpaid') && statusCol.includes('paid'),
  `CSV Status column carries all three states distinctly (got ${JSON.stringify(statusCol)})`);
assert(new Set(statusCol).size === 3, 'pending is never folded into unpaid or paid in the CSV export');

// ── 10. Chat retention (UN-8x) — client-side hide, reversible, unread-safe ───
console.log('\n[10] Chat retention — hide-only, pinned exempt, unread excludes hidden…');
chat._resetForTest();                              // clean slate — earlier sections left messages in S.items
storage.saveSetting('chatRetentionDays', 0);

assert(chat.getRetentionDays() === 0, 'retention starts OFF with no setting written (default-when-missing)');
assert(chat.isHiddenByRetention({ ts: Date.now() - 999 * 86400000 }) === false,
  'OFF means nothing is ever hidden, no matter how old');

const RT_NOW = Date.now();
const RT_OLD = RT_NOW - 10 * 86400000;              // 10 days old — outside a 7-day window
const RT_RECENT = RT_NOW - 1 * 86400000;            // 1 day old — inside the window

storage.saveSetting('chatRetentionDays', 7);
assert(chat.getRetentionDays() === 7, 'getRetentionDays reads the synced setting through the storage seam');

chat.ingest([
  ev({ id: 'rt1', seq: 101, ts: RT_OLD, body: 'old, unpinned', author: 'p1' }),
  ev({ id: 'rt2', seq: 102, ts: RT_OLD, body: 'old, pinned', author: 'p1' }),
  ev({ id: 'rt3', seq: 103, ts: RT_RECENT, body: 'recent', author: 'p1' }),
]);
chat.ingest([{ id: 'rt2pin', type: 'pin', targetId: 'rt2', author: 'p1', notify: false }]);
assert(chat.getMessage('rt2').pinned === true, 'fixture check: rt2 is actually pinned before trusting the exemption below');

assert(chat.isHiddenByRetention(chat.getMessage('rt1')) === true, 'a message older than the window IS hidden');
assert(chat.isHiddenByRetention(chat.getMessage('rt2')) === false,
  'a PINNED message older than the window stays visible — that is the entire point of pinning');
assert(chat.isHiddenByRetention(chat.getMessage('rt3')) === false, 'a recent message is never hidden');

const rtFiltered = chat.getMessages({ tag: 'all', respectRetention: true }).map(m => m.id);
assert(!rtFiltered.includes('rt1'), 'getMessages({respectRetention:true}) excludes the old unpinned message');
assert(rtFiltered.includes('rt2'), 'getMessages({respectRetention:true}) still includes the old PINNED message');
assert(rtFiltered.includes('rt3'), 'getMessages({respectRetention:true}) still includes the recent message');

// respectRetention is opt-in: non-display callers (the weekly digest, SCRIBE's
// pre-kick lookup) never lose data just because a commissioner turned on a
// rendering preference.
const rtUnfiltered = chat.getMessages({ tag: 'all' }).map(m => m.id);
assert(rtUnfiltered.includes('rt1'), 'without respectRetention, the old message is still readable (digest/SCRIBE unaffected)');

// Hidden messages must NOT contribute to unread counts. rt2 is old but PINNED
// (so it renders and legitimately still notifies) and rt3 is recent — both
// visible, both should count. rt1 is old and hidden — it must not, or a
// player gets a badge promising a message they can never scroll to.
localStorage.setItem('cfbp_chat_lastseen2', JSON.stringify({ seq: 0, byTag: {} }));
const rtUnread = chat.unreadCount('someone_else', 'all');
assert(rtUnread === 2,
  `unread count excludes the hidden old message (rt1) but still counts the visible pinned (rt2) and recent (rt3) ones (got ${rtUnread})`);
localStorage.removeItem('cfbp_chat_lastseen2');

// retentionStats() — feeds the commissioner card's live count line.
const rtStats = chat.retentionStats();
assert(rtStats.enabled === true && rtStats.days === 7, 'retentionStats reflects the active window');
assert(rtStats.hiddenCount === 1, `retentionStats counts exactly the one hidden message (got ${rtStats.hiddenCount})`);
assert(rtStats.protectedCount === 1, `retentionStats counts exactly the one pinned-but-old message as protected (got ${rtStats.protectedCount})`);

// Fully reversible — nothing was ever deleted (Drew's explicit requirement).
storage.saveSetting('chatRetentionDays', 0);
const rtRestored = chat.getMessages({ tag: 'all', respectRetention: true }).map(m => m.id);
assert(rtRestored.includes('rt1'), 'turning retention back OFF immediately restores the hidden message — nothing was deleted');

chat._resetForTest();
storage.saveSetting('chatRetentionDays', 0);

// 10f. Every surface that COUNTS or LINKS TO messages must respect retention,
// not just the rendered stream. Reviewer found three that didn't: the game-card
// 💬 count read "7" and opened to an empty thread, the game filter pills
// rendered for fully-hidden threads, and "↑ load earlier" fired a real backend
// round-trip then rendered nothing under a notice saying "Showing the last 7
// days". A half-respected filter is worse than none — it makes the UI lie.
const chatUiRetSrc = await readFile(new URL('./js/chat-ui.js', import.meta.url), 'utf8');

const bubbleFn = (chatUiRetSrc.match(/export function gameChatBubbleHTML[\s\S]*?\n}/) || [''])[0];
assert(/respectRetention:\s*true/.test(bubbleFn),
  'game-card 💬 count respects retention (count must match what opens)');

const tagsFn = (chatUiRetSrc.match(/function activeGameTags\(\)[\s\S]*?\n}/) || [''])[0];
assert(/respectRetention:\s*true/.test(tagsFn),
  'game filter pills respect retention (no pill for a fully hidden thread)');

assert(/retentionOn\(\)\s*\?\s*''\s*:\s*'<button class="chat-load-older"/.test(chatUiRetSrc),
  '"load earlier" is hidden when retention is on (it would fetch nothing)');

// 10g. The cutoff is resolved ONCE per unread pass, not per message. Left
// unhoisted this cost ~1.9ms per 800 messages EVEN WITH RETENTION OFF, paid on
// every pill on every poll tick.
const chatRetSrc = await readFile(new URL('./js/chat.js', import.meta.url), 'utf8');
assert(/export function retentionCutoff/.test(chatRetSrc),
  'retentionCutoff() exists so callers can resolve the window once');
const unreadFn = (chatRetSrc.match(/export function unreadCount[\s\S]*?\n}/) || [''])[0];
assert(/const cutoff = retentionCutoff\(\)/.test(unreadFn) && !/isHiddenByRetention\(/.test(unreadFn),
  'unreadCount resolves the cutoff once, outside the per-message loop');

// ── 11. Naming split — "Chat" at entry points, "Locker Room" inside the room ─
console.log('\n[11] Naming split — Chat at entry points, Locker Room inside the room…');
const indexHtmlSrc = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const navChatBlock = (indexHtmlSrc.match(/data-tab="chat">[\s\S]*?<\/button>/) || [''])[0];
assert(/<span>Chat<\/span>/.test(navChatBlock), 'nav: the Chat tab label reads "Chat"');
assert(!/Locker Room/.test(navChatBlock), 'nav: the Chat tab no longer reads "Locker Room"');

// v0.17.4 (UN-104): the header row went from a two-line <h2>Chat</h2> +
// subtitle to one compact line with the UN-101 BETA badge inline in the
// <h2> — narrowed to match, not deleted (the underlying "Chat" naming
// guarantee this row protects is unchanged; see §[23] for the badge itself).
assert(/<h2>Chat\s*<span class="badge badge-beta"/.test(chatUiSrc), 'chat page header reads "Chat" (badge now renders inline in the same <h2>)');
assert(!/<h2>Locker Room<\/h2>/.test(chatUiSrc), 'chat page header no longer reads "Locker Room"');

assert(/dash-chat-title">Chat /.test(chatUiSrc), 'dashboard teaser card TITLE reads "Chat"');
assert(!/dash-chat-title">Locker Room/.test(chatUiSrc), 'dashboard teaser card title no longer reads "Locker Room"');

const appJsSrc = await readFile(new URL('./js/app.js', import.meta.url), 'utf8');
assert(/<h3>💬 Chat<\/h3>/.test(appJsSrc), 'Rules section heading reads "💬 Chat"');
assert(!/<h3>💬 The Locker Room<\/h3>/.test(appJsSrc), 'Rules section heading no longer reads "The Locker Room"');

// Everything that describes what's INSIDE the room is deliberately UNCHANGED —
// a partial rename recreates the exact ambiguity this batch set out to fix.
assert(/data-chat-filter="all">Locker Room /.test(chatUiSrc), 'the "all" filter pill still reads "Locker Room" (it IS the room)');
assert(/The Locker Room is open\. SCRIBE is on duty\./.test(chatUiSrc), 'the empty-room state still says "Locker Room"');
assert(/shows in this game's thread and the Locker Room/.test(chatUiSrc), 'the tag-chip help text still says "Locker Room"');
// Batch 3+4 items D+E deliberately RETIRED the teaser's always-on "The Locker
// Room is open." fallback card — item D's spec is explicit: "Zero messages
// ever: show nothing at all... Do NOT show an empty card taking up dashboard
// space." This is a designed behavior change, not a naming regression; see
// section [15] below for the assertion that replaces this one.
assert(!/'The Locker Room is open\.'/.test(chatUiSrc),
  'the dashboard teaser no longer carries a permanent fallback string — item D retired the always-on card (see [15])');
assert(/<strong>One Locker Room\.<\/strong>/.test(appJsSrc), 'Rules body copy still says "One Locker Room"');

// ── 12. Item A — commissioner chat on/off toggle ──────────────────────────────
console.log('\n[12] Item A — commissioner chat on/off toggle…');

assert(dm.DEFAULT_SETTINGS.chatEnabled === true, 'DEFAULT_SETTINGS.chatEnabled defaults to true');

// The literal hazard named in the task: a missing value must NEVER silently
// disable chat. Simulate an OLD settings blob written before this field
// existed (saveSettings is the raw setter — no DEFAULT_SETTINGS spread).
storage.saveSettings({ timezone: 'PT' });
assert(chat.isChatEnabled() === true,
  'chatEnabled defaults to TRUE when the setting is absent from a stored blob (a missing value must not silently disable chat)');

storage.saveSetting('chatEnabled', false);
assert(chat.isChatEnabled() === false, 'isChatEnabled() reflects an explicit false');
storage.saveSetting('chatEnabled', true);
assert(chat.isChatEnabled() === true, 'isChatEnabled() reflects an explicit true');

// Surface 1 — dashboard game-card chat bubble (both matrix AND compact
// renderers call the SAME function, so gating it once covers both).
chat._resetForTest();
chat.ingest([ev({ id: 'a1', seq: 1, ts: 1000, body: 'hello', author: 'p1', gameTag: 'gameA' })]);
storage.saveSetting('chatEnabled', false);
assert(chatUi.gameChatBubbleHTML('gameA') === '',
  'chat OFF: the game-card bubble renders nothing, even with real messages present (surface 1)');
storage.saveSetting('chatEnabled', true);
assert(chatUi.gameChatBubbleHTML('gameA') !== '', 'sanity: the SAME bubble renders something once chat is back on');

// Surface 2 — dashboard teaser card.
storage.saveSetting('chatEnabled', false);
assert(chatUi.dashboardChatTeaserHTML() === '',
  'chat OFF: the dashboard teaser renders nothing, even with a real notifying message present (surface 2)');
storage.saveSetting('chatEnabled', true);
assert(chatUi.dashboardChatTeaserHTML() !== '', 'sanity: the SAME teaser renders something once chat is back on');

// Surfaces 3+4 — the chat page itself and the bottom-nav entry. The DOM stub
// at the top of this harness returns null from getElementById('page-chat')
// and querySelectorAll() returns [], so renderChatPage()'s isChatEnabled()
// guard and navigateTo()'s nav-visibility toggle are UNREACHABLE from this
// harness — renderChatPage() early-returns one line earlier on `!c`
// regardless of enabled state, and there is no fake nav DOM to inspect.
// This is a harness limitation, not something this suite can see through.
// Source-verified instead — both guards demonstrably exist and are wired to
// the SAME window.* bridge already established for the app.js/chat-ui.js
// module boundary (window.navigateTo, used for exactly this since the
// login-prompt feature).
assert(/if \(!isChatEnabled\(\)\) \{ redirectChatDisabled\(\); return; \}/.test(chatUiSrc),
  'renderChatPage() bails out and redirects when chat is disabled (source-verified — DOM-dependent, not exercised by this harness)');
assert(/function redirectChatDisabled/.test(chatUiSrc) && /window\.navigateTo/.test(chatUiSrc) && /window\.showToast/.test(chatUiSrc),
  'the redirect reuses the SAME window.navigateTo/window.showToast bridge, not a new mechanism');
assert(/tab === 'chat' && !isChatEnabled\(\)/.test(appJsSrc),
  "navigateTo() in app.js refuses to land on 'chat' while disabled (source-verified, same harness limitation)");
assert(/function applyChatNavVisibility/.test(appJsSrc) && /nav-item\[data-tab="chat"\]/.test(appJsSrc),
  'a dedicated function toggles the bottom-nav Chat entry\'s visibility (surface 4)');
assert(/function checkChatEnabledLive/.test(appJsSrc) && /setupChatEnabledWatch/.test(appJsSrc),
  'a periodic watch (independent of the score auto-refresh interval, which can be set to Off) catches a mid-session flip and routes a stranded player home');

// THE core hazard, and the one thing in this section that is NOT just source-
// verified: polling must actually STOP, not merely throttle. roomMode()
// returning 'closed' still polls every 60s (INTERVALS.closed in
// chatTransport.js) — that is NOT "stopped", it keeps burning Apps Script
// quota forever. _isPollingActiveForTest() observes the REAL subscription
// state (whether the transport's unsubscribe handle is live), not a proxy.
chat._resetForTest();
storage.saveSetting('chatEnabled', true);
chat.initChat('polltest_p1');
assert(chat._isPollingActiveForTest() === true, 'chat ON: initChat() actually starts the poll subscription');

storage.saveSetting('chatEnabled', false);
chat.refreshChatEnabled();
assert(chat._isPollingActiveForTest() === false,
  'chat OFF: refreshChatEnabled() actually STOPS the subscription — not merely throttles roomMode to "closed"');

storage.saveSetting('chatEnabled', true);
chat.refreshChatEnabled();
assert(chat._isPollingActiveForTest() === true, 'chat re-ON: refreshChatEnabled() resumes polling');

// Data preserved, never deleted — flipping OFF is visibility only. (Fresh
// ingest here, not the 'a1' fixture from earlier in this section — the
// poll-state checks above called _resetForTest(), which intentionally wipes
// S.items too, so re-seed rather than relying on state from before that.)
chat.ingest([ev({ id: 'a9', seq: 1, ts: 1000, body: 'still here', author: 'p1' })]);
storage.saveSetting('chatEnabled', false);
assert(chat.getMessage('a9')?.body === 'still here',
  'chat OFF: existing messages are still readable in memory — visibility only, nothing deleted');
storage.saveSetting('chatEnabled', true);
chat._resetForTest();

// ── 13. Item G — emoji parity: REACTION_PALETTE is the ONE shared source ─────
console.log('\n[13] Item G — emoji parity: REACTION_PALETTE single shared source…');

assert(Array.isArray(dm.REACTION_PALETTE) && dm.REACTION_PALETTE.length >= 15,
  'REACTION_PALETTE exported from data-model.js, at least as large as the old game-reaction set');

// v0.17.4 (UN-103, batch 2): QUICK_EMOJI is RETIRED, not merely re-derived.
// The composer no longer inserts emoji at all (Drew: players use their own
// keyboard) and the message-level always-visible 3-button quick-react row is
// replaced by a single + that opens the FULL palette per message — there is
// no more "always-visible subset" concept left for QUICK_EMOJI to describe.
// Narrowed from asserting correct derivation to asserting clean absence
// (§5 "a tripwire that starts crying wolf gets narrowed, never deleted" —
// here the SUBJECT retired, so the guard now protects against it quietly
// coming back as a second literal, which is the actual AD-20 risk).
// uiCode (comment-stripped, from §[7]) so this doesn't cry wolf on its own
// explanatory comment mentioning the retired identifier by name.
assert(!/\bQUICK_EMOJI\b/.test(uiCode),
  'UN-103: QUICK_EMOJI is retired from chat-ui.js CODE — no always-visible emoji subset remains anywhere (composer inserts nothing; + opens the full REACTION_PALETTE per message)');
assert(!/const REACTION_PALETTE = \[/.test(appJsSrc),
  'app.js no longer carries its own REACTION_PALETTE literal — the second-mapping defect class (AD-20, RG-13)');
const appImportBlock = appJsSrc.match(/^import \{[\s\S]*?\} from '\.\/data-model\.js';/m)?.[0] || '';
assert(/\bREACTION_PALETTE\b/.test(appImportBlock),
  'app.js imports REACTION_PALETTE from data-model.js rather than defining its own');
assert(/\bREACTION_PALETTE\b/.test(chatUiSrc),
  'chat-ui.js still imports/uses the shared REACTION_PALETTE directly (the per-message react picker) — AD-20\'s single source is intact even with QUICK_EMOJI gone');

// The full picker (item G's "picker layout" requirement) reuses the EXISTING
// grid CSS verbatim (app.js's dashboard reaction picker already solved
// 5×3 desktop / 7×3 mobile at 42-44px targets) rather than inventing a
// second layout — the v0.15.1 picker shipped at ~22×22px and had to be
// rebuilt once already. UN-103 moved WHERE this picker is anchored (the
// message, not the composer foot) but not its class names — both still hold.
assert(/picker\.className = 'reaction-picker'/.test(chatUiSrc),
  'the per-message react picker reuses the .reaction-picker class verbatim');
assert(/class="reaction-pick-option"/.test(chatUiSrc),
  'the per-message react picker\'s emoji options reuse the .reaction-pick-option class verbatim');
assert(!/chat-emoji-picker-grid|chat-emoji-picker-cell/.test(cssSrc),
  'no second grid-layout class family was invented for the chat picker');

// ── 14. Item B — bubble unread three-state + attribution ─────────────────────
console.log('\n[14] Item B — bubble unread three-state + attribution…');
chat._resetForTest();
storage.saveSetting('chatEnabled', true);
localStorage.removeItem('cfbp_chat_lastseen2');
// gameChatBubbleHTML() derives "self" from the live session (me() requires
// BOTH playerId and playerVerified), not from an arbitrary id passed around —
// a logged-in viewer is required for unread/attribution to compute at all.
storage.setSession('someone_else', false, true);

// Empty state: no messages for this game at all.
const bubbleEmpty = chatUi.gameChatBubbleHTML('ghost_game');
assert(/chat-bubble-empty/.test(bubbleEmpty), 'no messages at all → the "empty" (most subdued) state');
assert(!/chat-bubble-count/.test(bubbleEmpty), 'empty state carries no count');

// Read state: messages exist, all already read.
chat.ingest([ev({ id: 'b1', seq: 1, ts: 1000, body: 'thread starter', author: 'p1', gameTag: 'gB' })]);
chat.markSeen('all');
const bubbleRead = chatUi.gameChatBubbleHTML('gB');
assert(/chat-bubble-read/.test(bubbleRead), 'zero unread, has messages → the "read" (muted) state');
assert(!/chat-bubble-count/.test(bubbleRead), 'read state shows no count');

// Unread state — THE regression case the spec calls out by name: the bubble
// must show the UNREAD count, not the thread's total message count, in the
// specific case where they DIFFER.
chat.ingest([
  ev({ id: 'b2', seq: 2, ts: 2000, body: 'reply one', author: 'p2', gameTag: 'gB' }),
  ev({ id: 'b3', seq: 3, ts: 3000, body: 'reply two', author: 'p3', gameTag: 'gB' }),
]);
chat.markSeen('gB');                              // catch up to seq 3
chat.ingest([ev({ id: 'b4', seq: 4, ts: 4000, body: 'reply three', author: 'p2', gameTag: 'gB' })]);
const totalInThread = chat.getMessages({ tag: 'gB', types: ['message'] }).length;
assert(totalInThread === 4 && chat.unreadCount('someone_else', 'gB') === 1,
  `fixture check: total (${totalInThread}) and unread (${chat.unreadCount('someone_else', 'gB')}) genuinely differ for this thread`);
const bubbleUnread = chatUi.gameChatBubbleHTML('gB');
assert(/chat-bubble-unread/.test(bubbleUnread), 'has unread → the "unread" (prominent) state');
assert(/chat-bubble-count">1</.test(bubbleUnread),
  `the bubble shows the UNREAD count (1), not the thread total (4) — got "${bubbleUnread}"`);

// Three DISTINCT, mutually-exclusive state classes.
const bubbleStates = ['chat-bubble-unread', 'chat-bubble-read', 'chat-bubble-empty'];
assert(bubbleStates.filter(s => bubbleUnread.includes(s)).length === 1, 'exactly one state class on the unread bubble');
assert(bubbleStates.filter(s => bubbleRead.includes(s)).length === 1, 'exactly one state class on the read bubble');
assert(bubbleStates.filter(s => bubbleEmpty.includes(s)).length === 1, 'exactly one state class on the empty bubble');

// Attribution — the chosen answer (option 2 of the spec's three acceptable
// answers): `title` for desktop hover PLUS the SAME text in `aria-label` so
// it's reachable via assistive tech on any device, not just desktop hover.
assert(/title="[^"]*"/.test(bubbleUnread) && /aria-label="[^"]*"/.test(bubbleUnread),
  'both title (desktop hover) and aria-label (assistive tech, any device) are present');
const bubbleTitleTxt = (bubbleUnread.match(/title="([^"]*)"/) || [])[1];
const bubbleAriaTxt = (bubbleUnread.match(/aria-label="([^"]*)"/) || [])[1];
assert(!!bubbleTitleTxt && bubbleTitleTxt === bubbleAriaTxt,
  'title and aria-label carry IDENTICAL attribution text (no desktop-only information)');
assert(/unread from p2/.test(bubbleTitleTxt || ''),
  `attribution names WHO the unread is from, not just a count — got "${bubbleTitleTxt}"`);
localStorage.removeItem('cfbp_chat_lastseen2');
storage.clearSession();

// ── 15. Items D+E — dashboard teaser: dismissible ambient, no quick-reply ────
console.log('\n[15] Items D+E — dashboard teaser: dismissible ambient, no quick-reply…');
chat._resetForTest();
storage.saveSetting('chatEnabled', true);
localStorage.removeItem('cfbp_chat_teaser_dismiss_seq');

assert(chatUi.dashboardChatTeaserHTML() === '', 'zero messages ever: the teaser renders nothing (no empty card)');

chat.ingest([ev({ id: 'd1', seq: 1, ts: 1000, body: 'first message', author: 'p1' })]);
const teaser1 = chatUi.dashboardChatTeaserHTML();
assert(teaser1 !== '', 'a real notifying message makes the teaser render');
assert(/data-teaser-seq="1"/.test(teaser1), 'the teaser stamps its own seq (not a boolean) for dismissal tracking');

// Dismiss — device-local, via lsSet, storing the SEQ.
const teaserSeqMatch = teaser1.match(/data-teaser-seq="(\d+)"/);
localStorage.setItem('cfbp_chat_teaser_dismiss_seq', teaserSeqMatch[1]);
assert(chatUi.dashboardChatTeaserHTML() === '', 'dismissed: stays dismissed for the SAME message');

// Only a strictly HIGHER seq counts as new activity (spec's own definition) —
// prove this is a real number comparison, not a boolean flag.
assert(chatUi.dashboardChatTeaserHTML() === '', 'still dismissed a second time with no new activity (idempotent)');
chat.ingest([ev({ id: 'd2', seq: 2, ts: 2000, body: 'second message', author: 'p2' })]);
const teaser2 = chatUi.dashboardChatTeaserHTML();
assert(teaser2 !== '', 'reappears for genuinely new activity since dismissal (a HIGHER seq)');
assert(/data-teaser-seq="2"/.test(teaser2), 'the reappeared card stamps the NEW latest seq');

// Chat disabled overrides everything, dismissed or not.
storage.saveSetting('chatEnabled', false);
assert(chatUi.dashboardChatTeaserHTML() === '', 'chat disabled: the teaser never renders, dismissed or not');
storage.saveSetting('chatEnabled', true);

// E — the quick-reply input is GONE. Source guard so it can never creep back
// (this is exactly the kind of thing that quietly returns during a later
// unrelated edit if there's no tripwire).
assert(!/dash-quick-input/.test(chatUiSrc) && !/dash-quick-send/.test(chatUiSrc) && !/Quick reply…/.test(chatUiSrc),
  'item E: no quick-reply input/send-button/placeholder survives anywhere in chat-ui.js');
assert(!/\.dash-chat-quick\b/.test(cssSrc) && !/\.dash-chat-input\b/.test(cssSrc),
  'item E: no .dash-chat-quick/.dash-chat-input CSS survives');
assert(/dash-chat-dismiss/.test(chatUiSrc) && /dash-chat-dismiss/.test(cssSrc),
  'item D: a dedicated ✕ dismiss control exists in both markup and CSS (distinct from the open-chat tap area)');
localStorage.removeItem('cfbp_chat_teaser_dismiss_seq');

// ── 16. Item F — game thread header colors: static, dashboard-mirrored ───────
console.log('\n[16] Item F — game thread header colors: static, dashboard-mirrored…');

// The window.* bridge is REAL and testable: app.js's module-level code
// assigns this as a side effect of being imported in section [1].
assert(typeof globalThis.livePickStatus === 'function',
  'window.livePickStatus is exposed by app.js for chat-ui.js to reuse verbatim');
assert(!/const adj = game\.homeScore \+ sv/.test(chatUiSrc),
  'chat-ui.js does not re-derive covering/trailing math — no second implementation');
assert(/window\.livePickStatus/.test(chatUiSrc),
  'chat-ui.js calls the SAME function the dashboard uses, not a reimplementation');

assert(/gameThreadHeaderClass\(myHeaderPick, g\)/.test(chatUiSrc) && /chat-sheet-header\$\{headerCls\}/.test(chatUiSrc),
  'the bottom-sheet header applies the computed color class');
assert(/gameThreadHeaderClass\(myViewPick, g\)/.test(chatUiSrc) && /chat-view-header\$\{headerCls\}/.test(chatUiSrc),
  'the main chat page\'s game-filter header applies the SAME computed color class (both render paths stay consistent)');

// HARD REQUIREMENT: static only. None of the five thread-header classes may
// carry an `animation` property — that is the pulsing dashboard classes' job.
['chat-thread-covering', 'chat-thread-trailing', 'chat-thread-even', 'chat-thread-won', 'chat-thread-lost'].forEach(cls => {
  const rule = (cssSrc.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`)) || [''])[0];
  assert(rule.length > 0, `.${cls} is defined in styles.css`);
  assert(!/animation/.test(rule), `.${cls} carries NO animation property (static-only hard requirement) — got "${rule}"`);
});

// The spread stays on the sheet header — batch 1 removed it from message
// CHIPS specifically because the header already carries it; don't remove it
// twice and leave nowhere the spread shows in that view.
assert(/chat-sheet-sub">\$\{g \? esc\(formatSpread/.test(chatUiSrc),
  'the bottom-sheet header still shows the spread (only message chips dropped it, per batch 1)');

// ── 17. Item C — read marking: per-tag cursors while reading the Locker Room ─
console.log('\n[17] Item C — read marking: per-tag cursors advance while reading the Locker Room…');
chat._resetForTest();
localStorage.removeItem('cfbp_chat_lastseen2');

chat.ingest([
  ev({ id: 'c1', seq: 1, ts: 1000, body: 'untagged', author: 'p1' }),
  ev({ id: 'c2', seq: 2, ts: 2000, body: 'tagged gameA', author: 'p2', gameTag: 'gameA' }),
  ev({ id: 'c3', seq: 3, ts: 3000, body: 'tagged gameB', author: 'p3', gameTag: 'gameB' }),
]);
assert(chat.unreadCount('viewer', 'gameA') === 1, 'fixture: gameA has 1 unread before reading');
assert(chat.unreadCount('viewer', 'gameB') === 1, 'fixture: gameB has 1 unread before reading');

// Reading the Locker Room (filter === 'all') calls markSeen('all') — the same
// call renderChatPage()'s 1s-dwell timer makes.
chat.markSeen('all');
assert(chat.unreadCount('viewer', 'gameA') === 0,
  'reading the Locker Room clears a NEVER-directly-visited tag\'s bubble (gameA) — the exact scenario the spec names by example (a BAMA/LSU message read in the main room)');
assert(chat.unreadCount('viewer', 'gameB') === 0,
  'reading the Locker Room clears a second never-visited tag in the same pass (gameB)');

// The "already tracked" branch: visit gameA directly once (its own per-tag
// cursor now exists), a NEW gameA message arrives, then read the room again —
// the ALREADY-tracked cursor must ALSO advance, not stay pinned at its old
// value (which would make the bubble show unread forever after the first
// direct visit, even while reading the room).
chat.ingest([ev({ id: 'c4', seq: 4, ts: 4000, body: 'gameA #2', author: 'p2', gameTag: 'gameA' })]);
chat.markSeen('gameA');
assert(chat.unreadCount('viewer', 'gameA') === 0, 'fixture: directly visiting gameA clears it');
chat.ingest([ev({ id: 'c5', seq: 5, ts: 5000, body: 'gameA #3', author: 'p2', gameTag: 'gameA' })]);
assert(chat.unreadCount('viewer', 'gameA') === 1, 'fixture: a new gameA message after that direct visit is unread again');
chat.markSeen('all');
assert(chat.unreadCount('viewer', 'gameA') === 0,
  'reading the room again ALSO advances the already-tracked gameA cursor, not just never-visited tags');

// Monotonicity — the cursor can never regress.
const seqAfterFirstMark = chat.getLastSeen().seq;
chat.markSeen('all');                             // calling it again with no new head advance
assert(chat.getLastSeen().seq === seqAfterFirstMark,
  'the read cursor never regresses — marking seen again with no new activity leaves it unchanged, not rolled back');
chat.ingest([ev({ id: 'c6', seq: 6, ts: 6000, body: 'one more', author: 'p2' })]);
chat.markSeen('all');
assert(chat.getLastSeen().seq === 6 && chat.getLastSeen().seq > seqAfterFirstMark,
  'the read cursor advances monotonically forward as new messages arrive and get read');
localStorage.removeItem('cfbp_chat_lastseen2');

// 17b. COLD-LOAD REGRESSION — the read cursor must never move backward.
//
// markSeen() assigned S.head unconditionally. S.head is 0 until the first poll
// returns, and Apps Script cold starts run 10-20s (ledger §5) while the chat
// mark timer fires at 1s. So: open the app, tap Chat during the cold start,
// back out — cursor is now 0. Every message you already read counts as unread
// again, and with item B every game bubble lights up filled-maroon claiming
// unread the player cleared yesterday.
//
// The original item-C assertions tested the FORWARD direction only, which
// passes trivially because S.head never moves in a fixture. Ledger §5:
// "a green test on an input adjacent to the defect proves nothing."
console.log('\n[17b] Read cursor never regresses (cold load, S.head=0)…');
_resetForTest();
localStorage.removeItem('cfbp_chat_lastseen2');

// Session 1: a real read position, established after a healthy poll.
ingest([
  ev({ id: 'cold1', seq: 500, ts: 5000, body: 'read yesterday' }),
  ev({ id: 'cold2', seq: 500, ts: 5000, gameTag: 'gBAMA', body: 'also read', author: 'p2' }),
]);
markSeen('all');
markSeen('gBAMA');                     // explicitly track the tag, so byTag has a real entry
const beforeCold = JSON.parse(localStorage.getItem('cfbp_chat_lastseen2') || '{}');
assert(beforeCold.seq === 500, `session 1 establishes a read position (got ${beforeCold.seq})`);
assert(beforeCold.byTag?.gBAMA === 500, `session 1 tracks the per-tag cursor (got ${beforeCold.byTag?.gBAMA})`);

// Session 2: fresh page load. Fold is empty, S.head is back to 0, no poll yet.
// The 1s mark timer fires anyway because the player opened Chat.
_resetForTest();
markSeen('all');
const afterCold = JSON.parse(localStorage.getItem('cfbp_chat_lastseen2') || '{}');

assert(afterCold.seq >= 500,
  `cold load does NOT regress the room cursor — was 500, now ${afterCold.seq}`);
// The EFFECTIVE per-tag cursor is `byTag[tag] ?? seq` — an untracked tag
// legitimately inherits the room cursor, so assert the effective value, not the
// raw map entry.
const effGBAMA = afterCold.byTag?.gBAMA ?? afterCold.seq ?? 0;
assert(effGBAMA >= 500,
  `cold load does NOT regress the per-tag cursor — was 500, now ${effGBAMA}`);

// And the consequence the player actually feels: no phantom unread.
ingest([
  ev({ id: 'cold3', seq: 501, ts: 6000, gameTag: 'gBAMA', body: 'genuinely new', author: 'p2' }),
]);
assert(unreadCount('p1', 'gBAMA') === 1,
  `only genuinely new messages count as unread after a cold load (got ${unreadCount('p1', 'gBAMA')})`);
localStorage.removeItem('cfbp_chat_lastseen2');

// 17c. CSS cascade + tap-target guards for the three review findings that
// source-presence assertions could not see. §[16] asserted the thread-color
// CLASS was applied and passed while the cascade silently discarded it.
console.log('\n[17c] Review fixes — cascade, badges, tap targets…');
const cssFix = await readFile(new URL('./css/styles.css', import.meta.url), 'utf8');

// The tint must be re-asserted AFTER .chat-view-header, or that later rule's
// background:var(--bg-card) wins at equal specificity and the main chat page's
// header renders untinted while the bottom sheet renders correctly.
const viewHeaderAt = cssFix.indexOf('.chat-view-header{');
const scopedTintAt = cssFix.indexOf('.chat-view-header.chat-thread-covering');
assert(viewHeaderAt > -1 && scopedTintAt > viewHeaderAt,
  'thread-color tint is re-asserted AFTER .chat-view-header so the cascade cannot drop it');

// Static only — the dashboard's equivalents pulse deliberately; a pulsing chat
// header is noise (spec, item F).
// Match only the .chat-thread-* rule bodies themselves — slicing between two
// markers swept in unrelated CSS and made this cry wolf.
const threadRules = cssFix.match(/\.chat-thread-[a-z]+\{[^}]*\}/g) || [];
assert(threadRules.length >= 5, `all five thread-color rules present (got ${threadRules.length})`);
assert(!threadRules.some(r => /animation|transition/.test(r)),
  'thread header colors carry NO animation (static, per item F)');

// v0.17.4 (UN-103, batch 2): the composer's "more emoji" button — the thing
// these two assertions guarded — is RETIRED, not just resized/repositioned.
// Narrowed to assert the retirement is clean (the button, its row, and the
// composer-foot-anchored picker override it opened are all gone together)
// rather than testing tap-target/direction properties of a control that no
// longer exists.
assert(!/\.chat-emoji-row\b|\.chat-emoji-insert\b|\.chat-emoji-more\b/.test(cssFix),
  'UN-103: no composer emoji-row/insert/more CSS survives — the composer no longer inserts emoji, it reacts to messages');
assert(!/\.chat-composer-foot \.reaction-picker/.test(cssFix),
  'UN-103: the composer-foot-anchored reaction-picker override is gone with the button that opened it');

// The fifth surface item A missed: title + PWA icon badge must clear when chat
// is off, or a player chases a badge they cannot clear.
const chatUiFix = await readFile(new URL('./js/chat-ui.js', import.meta.url), 'utf8');
const badgesFn = (chatUiFix.match(/export function updateChatBadges[\s\S]*?\n}/) || [''])[0];
assert(/isChatEnabled\(\)/.test(badgesFn),
  'updateChatBadges is gated on isChatEnabled (clears title + PWA badge when off)');

// ── 18. UN-98 + UN-99 — safe-area insets on the installed app ────────────────
// Root cause (design input): viewport-fit=cover + a translucent status bar
// make safe-area insets non-zero and draw the app UNDER the status bar /
// Dynamic Island. Before this batch, env(safe-area-inset-top) appeared ZERO
// times in styles.css while env(safe-area-inset-bottom) appeared 5x — the
// bottom nav was handled, the top never was.
console.log('\n[18] UN-98/99 — header + toasts clear the status bar / camera on the installed app…');

const appHeaderRule = (cssSrc.match(/\.app-header\{[^}]*\}/) || [''])[0];
assert(/padding-top:\s*env\(safe-area-inset-top/.test(appHeaderRule),
  `.app-header pads for env(safe-area-inset-top) — got "${appHeaderRule}"`);

// UN-98's COUPLED change: #toast-container sits below the header today at a
// flat 76px. Once the header can grow taller in standalone, that flat value
// no longer clears it — both the base rule AND the <=480px override (which
// matches virtually every real phone and would otherwise silently mask the
// base-rule fix) must grow with the same inset.
const toastContainerBaseRule = (cssSrc.match(/#toast-container\{[^}]*\}/) || [''])[0];
assert(/top:\s*calc\(76px \+ env\(safe-area-inset-top/.test(toastContainerBaseRule),
  `#toast-container base rule grows with env(safe-area-inset-top) — got "${toastContainerBaseRule}"`);
const toastContainerOverrides = cssSrc.match(/#toast-container\s*\{[^}]*\}/g) || [];
const narrowOverride = toastContainerOverrides.find(r => /70px/.test(r)) || '';
assert(/env\(safe-area-inset-top/.test(narrowOverride),
  `#toast-container's <=480px override ALSO accounts for env(safe-area-inset-top) — without this the base-rule fix is masked on every real phone (got "${narrowOverride}")`);

// UN-99: .chat-toast is a SEPARATE element (the floating new-message toast,
// not the generic toast stack) — same pattern, independently applied.
const chatToastRule = (cssSrc.match(/\.chat-toast\{[^}]*\}/) || [''])[0];
assert(/top:\s*calc\(14px \+ env\(safe-area-inset-top/.test(chatToastRule),
  `.chat-toast grows with env(safe-area-inset-top) — got "${chatToastRule}"`);

const topInsetCount = (cssSrc.match(/env\(safe-area-inset-top/g) || []).length;
assert(topInsetCount >= 4, `env(safe-area-inset-top) now appears in styles.css at every required call site (>=4 expected: .app-header, #toast-container base, #toast-container override, .chat-toast — got ${topInsetCount})`);

// ── 19. UN-100 — no accidental zoom / wobble ──────────────────────────────────
console.log('\n[19] UN-100 — zoom lock (Drew-approved WCAG 1.4.4 tradeoff, 2026-08-07)…');
const viewportMeta = (indexHtmlSrc.match(/<meta name="viewport"[^>]*>/) || [''])[0];
assert(/user-scalable=no/.test(viewportMeta), `viewport meta contains user-scalable=no — got "${viewportMeta}"`);
assert(/maximum-scale=1\b/.test(viewportMeta), `viewport meta contains maximum-scale=1 — got "${viewportMeta}"`);
assert(/viewport-fit=cover/.test(viewportMeta), 'viewport-fit=cover survives (still needed for the safe-area insets themselves)');

// ── 20. UN-96 — installed-app icon identity ───────────────────────────────────
console.log('\n[20] UN-96 — installed-app identity: label, icons, manifest colors…');

async function pngDimensions(relPath) {
  let buf;
  try { buf = await readFile(new URL(relPath, import.meta.url)); } catch { return null; }
  if (buf.length < 24 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null; // PNG signature
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; // IHDR chunk
}

assert(/apple-mobile-web-app-title" content="Pickems"/.test(indexHtmlSrc),
  'apple-mobile-web-app-title is exactly "Pickems" (matches manifest short_name)');
assert(/apple-touch-icon" sizes="180x180" href="icons\/icon-180\.png"/.test(indexHtmlSrc),
  'apple-touch-icon 180x180 (the size iOS actually reads for the home-screen icon) points at icons/icon-180.png');
assert(/apple-touch-icon" href="icons\/icon-180\.png"/.test(indexHtmlSrc),
  'sizeless apple-touch-icon fallback also points at icons/icon-180.png (older iOS)');

const manifestSrc = await readFile(new URL('./manifest.json', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestSrc);
assert(Array.isArray(manifest.icons) && manifest.icons.length > 0 && manifest.icons.every(i => i.purpose === 'any'),
  `every manifest icon entry uses purpose "any", not "any maskable" (the art has no maskable safe zone) — got ${JSON.stringify(manifest.icons.map(i => i.purpose))}`);
assert(manifest.background_color.toLowerCase() === '#500000', `manifest background_color is the maroon #500000 — got ${manifest.background_color}`);
assert(manifest.theme_color.toLowerCase() === '#500000', `manifest theme_color is the maroon #500000 — got ${manifest.theme_color}`);
assert(manifest.short_name === 'Pickems', 'manifest short_name is unchanged ("Pickems") — the DI said leave it');

// Pixel-dimension regression guard — parsed straight out of each PNG's IHDR
// chunk, not assumed. Catches a future regeneration that silently produces
// the wrong size (the exact failure mode the batch task called out to guard
// against).
const dims180 = await pngDimensions('./icons/icon-180.png');
const dims192 = await pngDimensions('./icons/icon-192.png');
const dims512 = await pngDimensions('./icons/icon-512.png');
assert(!!dims180 && dims180.width === 180 && dims180.height === 180,
  `icons/icon-180.png is exactly 180x180 — got ${dims180 ? `${dims180.width}x${dims180.height}` : 'unreadable/missing'}`);
assert(!!dims192 && dims192.width === 192 && dims192.height === 192,
  `icons/icon-192.png is exactly 192x192 — got ${dims192 ? `${dims192.width}x${dims192.height}` : 'unreadable/missing'}`);
assert(!!dims512 && dims512.width === 512 && dims512.height === 512,
  `icons/icon-512.png is exactly 512x512 — got ${dims512 ? `${dims512.width}x${dims512.height}` : 'unreadable/missing'}`);

// ── 21. UN-97 — bottom nav SVG icon exception (CONVENTIONS #16) ──────────────
console.log('\n[21] UN-97 — bottom nav SVG icon exception (the ONE named exception to "icons are emoji")…');

const navBlock = (indexHtmlSrc.match(/<nav class="bottom-nav">[\s\S]*?<\/nav>/) || [''])[0];
const navItemBlocks = navBlock.match(/<button class="nav-item[^"]*"[^>]*>[\s\S]*?<\/button>/g) || [];
assert(navItemBlocks.length === 6, `bottom nav has exactly 6 .nav-item buttons (got ${navItemBlocks.length})`);
navItemBlocks.forEach((block, i) => {
  assert(/<svg[^>]*>/.test(block), `nav item ${i + 1} contains an inline <svg>`);
  assert(/currentColor/.test(block), `nav item ${i + 1}'s <svg> uses currentColor — themed by the EXISTING .nav-item.active,.nav-item:active color rule with zero new CSS`);
});

// Every one of the six original emoji spans must be gone.
['🏈', '📊', '💬', '🏆', '📋', '⚙️'].forEach(emoji => {
  assert(!navBlock.includes(`nav-icon">${emoji}`), `.nav-icon no longer renders ${emoji} directly (replaced by inline SVG)`);
});

// v0.17.5 (batch 4, UN-109) — REWRITTEN. This previously asserted the header
// logo emoji was UNCHANGED (the SVG exception scoped to the nav only, not
// widened to the header). UN-109 removed the header logo ENTIRELY — Drew: the
// app's title/icon doesn't need to be present on every screen, the user
// already knows what app this is. Asserting the new fact (gone, not merely
// unchanged), not the old one. See §[27] for the full UN-109 removal guard.
assert(!/class="app-logo-icon"/.test(indexHtmlSrc) && !/🏈/.test(indexHtmlSrc),
  'the header logo 🏈 emoji is GONE (UN-109) — no leftover instance anywhere in index.html');

// Exactly 6 <svg> in the whole file — the six nav icons and nothing else
// (favicon is a separate .svg FILE referenced via <link>, not an inline <svg>).
const totalSvgCount = (indexHtmlSrc.match(/<svg/g) || []).length;
assert(totalSvgCount === 6, `index.html contains exactly 6 <svg> elements (the six nav icons, nothing leaked outside the nav) — got ${totalSvgCount}`);

// UN-73 nav order + labels + tap target are explicitly NOT to change.
const navOrder = [...navBlock.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
assert(JSON.stringify(navOrder) === JSON.stringify(['picks', 'dashboard', 'chat', 'leaderboard', 'rules', 'commissioner']),
  `nav tab order is unchanged (UN-73) — got ${JSON.stringify(navOrder)}`);
const navLabels = navItemBlocks.map(b => (b.match(/<span>([^<]+)<\/span>\s*<\/button>/) || [, ''])[1]);
assert(JSON.stringify(navLabels) === JSON.stringify(['Picks', 'Dashboard', 'Chat', 'Standings', 'Rules', 'Comm.']),
  `nav labels are unchanged — got ${JSON.stringify(navLabels)}`);
const navItemRule = (cssSrc.match(/\.nav-item\{[^}]*\}/) || [''])[0];
assert(/min-height:44px/.test(navItemRule), 'nav-item tap target (min-height:44px) is unchanged — the hit area stays the full button, not just the glyph');

// The icon's own footprint is still sized to the ~20px the emoji occupied.
const navIconSvgRule = (cssSrc.match(/\.nav-icon svg\{[^}]*\}/) || [''])[0];
assert(/width:\s*20px/.test(navIconSvgRule) && /height:\s*20px/.test(navIconSvgRule),
  `.nav-icon svg is sized to the ~20px footprint .nav-icon{font-size:1.25rem} had — got "${navIconSvgRule}"`);

// ── 22. UN-106 — header identity: signed-in indicator / sign-in CTA ──────────
console.log('\n[22] UN-106 — header identity: signed-in indicator + sign-in CTA…');

const appModForIdentity = mods['app'];
assert(typeof appModForIdentity.renderHeaderIdentity === 'function', 'renderHeaderIdentity is exported from app.js');

// A minimal fake element, swapped in for getElementById('header-identity')
// only, so this exercises the REAL render function against REAL storage
// state instead of just asserting on source text.
function makeFakeHeaderIdentityEl() {
  const attrs = {};
  return { hidden: false, innerHTML: '', setAttribute(k, v) { attrs[k] = v; }, getAttribute: k => attrs[k] };
}
const headerIdentityEl = makeFakeHeaderIdentityEl();
const realGetElementById = document.getElementById;
document.getElementById = id => (id === 'header-identity' ? headerIdentityEl : realGetElementById(id));

// Logged out — no ambiguity, session.playerId is definitively null.
storage.clearSession();
appModForIdentity.renderHeaderIdentity();
assert(headerIdentityEl.hidden === false, 'logged out: the identity chip is visible');
assert(/Sign In/.test(headerIdentityEl.innerHTML), 'logged out: renders the "Sign In" pill');
assert(!/header-identity-avatar/.test(headerIdentityEl.innerHTML), 'logged out: renders no avatar');

// Session-not-yet-resolved (the batch 1 hazard): a session references a
// playerId whose record can't be found (pre-hydrate on a fresh device, in
// practice). Must hold the slot EMPTY, never flash "Sign In".
storage.setSession('ghost_player_not_hydrated', false, true);
appModForIdentity.renderHeaderIdentity();
assert(headerIdentityEl.hidden === true,
  'session references a player not yet in storage: the slot is held EMPTY (hidden), not "Sign In"');
assert(headerIdentityEl.innerHTML === '',
  'unresolved session: no content rendered — never a flash of "Sign In" before a real login resolves');

// Logged in.
storage.addPlayer(dm.createPlayer('Testy', '', '9999', '', 'DT'));
const fixturePlayers = storage.getPlayers();
const testPlayer = fixturePlayers[fixturePlayers.length - 1];
storage.setSession(testPlayer.playerId, false, true);
appModForIdentity.renderHeaderIdentity();
assert(headerIdentityEl.hidden === false, 'logged in: the identity chip is visible');
assert(headerIdentityEl.innerHTML.includes('header-identity-avatar') && headerIdentityEl.innerHTML.includes('DT'),
  'logged in: renders the initials avatar (getPlayerInitials)');
assert(headerIdentityEl.innerHTML.includes('header-identity-name') && headerIdentityEl.innerHTML.includes('Testy'),
  'logged in: renders the first name next to the avatar');
assert(!/Sign In/.test(headerIdentityEl.innerHTML), 'logged in: no "Sign In" pill remains');

document.getElementById = realGetElementById;
storage.clearSession();

// No week-status dependency (DI requirement) — renderHeaderIdentity's source
// never references `week`.
const identityFnSrc = (appJsSrc.match(/export function renderHeaderIdentity\(\)[\s\S]*?\n}/) || [''])[0];
assert(identityFnSrc.length > 0 && !/\bweek\b/.test(identityFnSrc),
  'renderHeaderIdentity has no week-status dependency — renders identically in Draft/Open/Locked/Live/Final');

// Placement + wiring: first in .header-right, ahead of sync/tz/theme, and
// wired into the same two functions that already keep the header in sync.
const headerRightBlock = (indexHtmlSrc.match(/<div class="header-right">[\s\S]*?<\/div>/) || [''])[0];
assert(headerRightBlock.indexOf('id="header-identity"') > -1
  && headerRightBlock.indexOf('id="header-identity"') < headerRightBlock.indexOf('id="sync-badge"'),
  'the identity chip is first in .header-right, ahead of the sync badge / tz toggle / theme toggle');
assert(/renderHeaderIdentity\(\);/.test((appJsSrc.match(/function refreshHeader\(\)[\s\S]*?\n}/) || [''])[0]),
  'refreshHeader() calls renderHeaderIdentity() — covers boot + every week-driven re-render');
assert(/renderHeaderIdentity\(\);/.test((appJsSrc.match(/function resyncPlayerPreferences\(\)[\s\S]*?\n}/) || [''])[0]),
  'resyncPlayerPreferences() calls renderHeaderIdentity() — covers login/logout/player-switch');

// ── 23. Batch 2 (v0.17.4) — UN-101 BETA badge, UN-102 notifications, UN-103
//       composer cleanup + hidden actions, UN-104 chat layout ────────────────
console.log('\n[23a] UN-101 — Chat marked BETA…');

// Structural placement is covered in §[11] (the "Chat" naming guard, updated
// to match the badge now living inline in the same <h2>). Here: the badge's
// OWN styling — reused variables, no new color, no animation.
const badgeBetaRule = (cssSrc.match(/\.badge-beta\{[^}]*\}/) || [''])[0];
assert(badgeBetaRule.length > 0, '.badge-beta is defined in styles.css');
assert(/var\(--text-muted\)/.test(badgeBetaRule) && /var\(--border\)/.test(badgeBetaRule),
  '.badge-beta reuses the existing --text-muted/--border variables, same as .badge-draft (no new color)');
assert(!/animation/.test(badgeBetaRule), '.badge-beta carries no animation — chat surfaces use the static variant (locked, v0.17.2)');
assert(!/#[0-9A-Fa-f]{3,6}\b/.test(badgeBetaRule.replace(/^\.badge-beta\{/, '').split(';')[0] === '' ? '' : badgeBetaRule),
  '.badge-beta does not introduce a new hardcoded hex color (CONVENTIONS #13)');
assert(/title="Still being tested — tell us if something looks wrong"/.test(chatUiSrc),
  'BETA badge carries the touch-safe title copy (tooltips do not fire on touch — the word BETA itself is the signal)');

console.log('\n[23b] UN-102a — toast suppressed on Dashboard, not on other tabs…');
assert(typeof chatUi._toastWouldSuppress === 'function',
  'chat-ui.js exports _toastWouldSuppress (test-only) so the REAL suppression predicate is exercised');
if (typeof chatUi._toastWouldSuppress === 'function') {
  const realQS23 = document.querySelector;
  document.querySelector = sel => (sel === '#page-dashboard.active' ? {} : null);
  assert(chatUi._toastWouldSuppress(false) === true, 'toast suppressed while the Dashboard tab is active (the teaser already conveys it)');
  document.querySelector = sel => (sel === '#page-chat.active' ? {} : null);
  assert(chatUi._toastWouldSuppress(false) === true, 'toast still suppressed while the Chat tab is active (pre-existing rule, unchanged)');
  document.querySelector = () => null;
  assert(chatUi._toastWouldSuppress(false) === false, 'toast NOT suppressed on any other tab (picks/standings/rules/comm)');
  assert(chatUi._toastWouldSuppress(true) === false, 'force:true (e.g. the pick-reveal system toast) bypasses suppression regardless of active tab');
  document.querySelector = realQS23;
}

console.log('\n[23c] UN-102b — the dashboard teaser never resurfaces the viewer\'s OWN post…');
chat._resetForTest();
storage.saveSetting('chatEnabled', true);
localStorage.removeItem('cfbp_chat_teaser_dismiss_seq');
storage.setSession('p1', false, true);   // "I" am p1 — no real player record needed (me() only reads the session)
chat.ingest([ev({ id: 'selfpost1', seq: 1, ts: 1000, body: 'my own post', author: 'p1' })]);
assert(chatUi.dashboardChatTeaserHTML() === '',
  'UN-102b: posting your OWN message never resurfaces the teaser with your own text back at you (pre-fix, this returned your own post)');
chat.ingest([ev({ id: 'otherpost1', seq: 2, ts: 2000, body: 'reply from someone else', author: 'p2' })]);
assert(chatUi.dashboardChatTeaserHTML() !== '', 'sanity: a message from someone ELSE still surfaces the teaser normally');
assert(/reply from someone else/.test(chatUi.dashboardChatTeaserHTML()), 'the surfaced teaser previews the OTHER player\'s text, not your own');
storage.clearSession();
localStorage.removeItem('cfbp_chat_teaser_dismiss_seq');
chat._resetForTest();

console.log('\n[23d] UN-102c — toast "stays for" duration preference…');
storage.addPlayer(dm.createPlayer('Batch2Tester', '', '4321', '', 'B2'));
const b2Players = storage.getPlayers();
const b2Player = b2Players[b2Players.length - 1];
storage.setSession(b2Player.playerId, false, true);
assert(storage.getNotifPrefs().toastDuration === 6000,
  'toastDuration defaults to 6000 when absent from a stored blob (CONVENTIONS #10 — old records must not change behavior)');
storage.setNotifPrefs({ toastDuration: 10000 });
assert(storage.getNotifPrefs().toastDuration === 10000, 'toastDuration round-trips through set/get');
storage.setNotifPrefs({ toastDuration: 0 });
assert(storage.getNotifPrefs().toastDuration === 0, 'toastDuration round-trips the "Until dismissed" value (0) — a falsy-but-meaningful value, not treated as absent');
storage.clearSession();
assert(/getNotifPrefs\(\)\.toastDuration/.test(chatUiSrc) || /const prefMs = getNotifPrefs\(\)\.toastDuration/.test(chatUiSrc),
  'drainToast() reads the duration from getNotifPrefs() rather than a hardcoded 6000');
assert(/prefsPanelHTML[\s\S]*?Stays for[\s\S]*?<select/.test(chatUiSrc) || /Stays for[\s\S]{0,80}<select/.test(chatUiSrc),
  'the "Stays for" duration select is present in the chat prefs panel');
assert(/chat-toast-dismiss/.test(chatUiSrc) && /chat-toast-dismiss/.test(cssSrc),
  'a manual ✕ dismiss control exists on the toast regardless of duration (Drew: "needs to be able to be dismissed"), in both markup and CSS');

console.log('\n[23e] UN-103 — composer emoji row removed; + react control on messages…');
assert(!/chat-emoji-row/.test(chatUiSrc) && !/chat-emoji-insert/.test(chatUiSrc) && !/chat-emoji-more/.test(chatUiSrc),
  'no emoji-insert row survives in composerHTML() — players use their own keyboard (Drew)');
assert(/data-react-open="\$\{esc\(m\.id\)\}"/.test(chatUiSrc),
  'each message renders a + react-open control targeting that specific message');
assert(/toggleMessageReactPicker/.test(chatUiSrc), 'the + opens a dedicated per-message react picker (not the retired composer picker)');

const hoverNoneBlock23 = (cssSrc.match(/@media \(hover:none\)\{[\s\S]*?\}\}/) || [''])[0];
assert(hoverNoneBlock23.length > 0, '@media (hover:none) rule for .chat-actions visibility still exists');
assert(!/\.chat-actions\{opacity:\.75\}/.test(hoverNoneBlock23),
  '.chat-actions is NOT permanently opacity:.75 on touch devices (the "too busy" defect this batch fixes)');
assert(/\.chat-msg\.chat-actions-revealed \.chat-actions\{opacity:1;pointer-events:auto\}/.test(hoverNoneBlock23),
  'touch reveal restores BOTH opacity and pointer-events (v0.17.4: opacity alone left live invisible buttons)');
const baseActionsRule23 = (cssSrc.match(/^\.chat-actions\{[^}]*\}/m) || [''])[0];
assert(/opacity:0/.test(baseActionsRule23), '.chat-actions base rule (all devices, all input types) starts hidden at opacity:0');
// v0.17.4, caught in review: opacity:0 WITHOUT pointer-events:none left a 40px
// strip of live controls under every message on touch. 🏛 pin and 📎 callout
// fire with no confirmation, so a stray tap could publish someone's message to
// the Hall of Records. Hidden must mean untappable.
assert(/pointer-events:\s*none/.test(baseActionsRule23),
  '.chat-actions hidden state is also UNTAPPABLE, not just invisible');
assert(/\.chat-msg:hover \.chat-actions,\.chat-msg:focus-within \.chat-actions\{opacity:1;pointer-events:auto\}/.test(cssSrc),
  'desktop hover-reveal restores opacity AND pointer-events (the pointer-events pair is the v0.17.4 fix)');

// Computed-constraint, not source presence (Testing Protocol step 12) — parse
// the ACTUAL declared px values, the same technique already proven on
// .chat-pill (v0.17.2) and .chat-emoji-more (v0.17.3).
const chatActRule23 = (cssSrc.match(/\.chat-act\{[^}]*\}/) || [''])[0];
const actMinW = Number((chatActRule23.match(/min-width:\s*(\d+)px/) || [])[1] || 0);
const actMinH = Number((chatActRule23.match(/min-height:\s*(\d+)px/) || [])[1] || 0);
assert(actMinW >= 40 && actMinH >= 40,
  `.chat-act (and the + react control, which shares the class) meets the 40px tap-target floor (CONVENTIONS #17) — got ${actMinW}x${actMinH}`);
const toastDismissRule23 = (cssSrc.match(/\.chat-toast-dismiss\{[^}]*\}/) || [''])[0];
const dismissMinW = Number((toastDismissRule23.match(/min-width:\s*(\d+)px/) || [])[1] || 0);
const dismissMinH = Number((toastDismissRule23.match(/min-height:\s*(\d+)px/) || [])[1] || 0);
assert(dismissMinW >= 40 && dismissMinH >= 40,
  `the toast's ✕ dismiss control meets the 40px tap-target floor (CONVENTIONS #17) — got ${dismissMinW}x${dismissMinH}`);

console.log('\n[23f] UN-103 — long-press reveals actions; a scroll swipe must NOT…');
// Reuse check: same 350ms/8px numbers as app.js's bindColumnReorderHandlers,
// not merely a similarly-shaped reimplementation with different numbers.
const appLongPressMs = Number((appJsSrc.match(/const LONG_PRESS_MS\s*=\s*(\d+)/) || [])[1]);
const appScrollThreshold = Number((appJsSrc.match(/const SCROLL_THRESHOLD\s*=\s*(\d+)/) || [])[1]);
const chatLongPressMs = Number((chatUiSrc.match(/const LONG_PRESS_MS\s*=\s*(\d+)/) || [])[1]);
const chatThreshold = Number((chatUiSrc.match(/const LONG_PRESS_THRESHOLD_PX\s*=\s*(\d+)/) || [])[1]);
assert(appLongPressMs === 350 && chatLongPressMs === 350,
  `chat-ui.js's message long-press reuses app.js's EXACT 350ms timer — app=${appLongPressMs}, chat=${chatLongPressMs}`);
assert(appScrollThreshold === 8 && chatThreshold === 8,
  `chat-ui.js's message long-press reuses app.js's EXACT 8px scroll threshold — app=${appScrollThreshold}, chat=${chatThreshold}`);

assert(typeof chatUi._bindMessageActionsLongPress === 'function',
  'chat-ui.js exports _bindMessageActionsLongPress (test-only) for behavioral long-press coverage');
if (typeof chatUi._bindMessageActionsLongPress === 'function') {
  function makeFakeScrollRoot23() {
    const handlers = {};
    return { addEventListener(type, fn) { handlers[type] = fn; }, removeEventListener(type) { delete handlers[type]; }, _fire: (type, e) => handlers[type]?.(e) };
  }
  function makeFakeMsgEl23(mid) {
    const classes = new Set();
    return { dataset: { mid }, classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) }, _classes: classes };
  }
  const revealTargets23 = {};
  const realQS23b = document.querySelector;
  document.querySelector = sel => {
    const m = /\.chat-msg\[data-mid="([^"]+)"\]/.exec(sel || '');
    return m ? (revealTargets23[m[1]] || null) : null;
  };
  const touchTargetFor = el => ({ closest: sel => (sel === '.chat-msg' ? el : null) });

  // Case 1 — genuine long-press (no movement) reveals that message's actions.
  const root1 = makeFakeScrollRoot23();
  const msg1 = makeFakeMsgEl23('long_press_msg');
  revealTargets23['long_press_msg'] = msg1;
  chatUi._bindMessageActionsLongPress(root1);
  root1._fire('touchstart', { touches: [{ clientX: 100, clientY: 100 }], target: touchTargetFor(msg1) });
  await new Promise(r => setTimeout(r, 400));
  assert(msg1._classes.has('chat-actions-revealed'), 'a genuine long-press (no movement) reveals that message\'s .chat-actions');

  // Case 2 — a scroll swipe (well past the 8px threshold) before the 350ms
  // timer fires must CANCEL the press. This is the exact hazard named in the
  // task: scrolling over a message must never summon its actions.
  const root2 = makeFakeScrollRoot23();
  const msg2 = makeFakeMsgEl23('scroll_msg');
  revealTargets23['scroll_msg'] = msg2;
  chatUi._bindMessageActionsLongPress(root2);
  root2._fire('touchstart', { touches: [{ clientX: 100, clientY: 100 }], target: touchTargetFor(msg2) });
  root2._fire('touchmove', { touches: [{ clientX: 100, clientY: 130 }] });   // 30px vertical — a scroll, not a hold
  await new Promise(r => setTimeout(r, 400));
  assert(!msg2._classes.has('chat-actions-revealed'),
    'a scroll swipe (30px before the 350ms timer fires) cancels the long-press — scrolling over a message never reveals its actions');

  // Case 3 — movement UNDER the 8px threshold still counts as a hold.
  const root3 = makeFakeScrollRoot23();
  const msg3 = makeFakeMsgEl23('steady_msg');
  revealTargets23['steady_msg'] = msg3;
  chatUi._bindMessageActionsLongPress(root3);
  root3._fire('touchstart', { touches: [{ clientX: 100, clientY: 100 }], target: touchTargetFor(msg3) });
  root3._fire('touchmove', { touches: [{ clientX: 103, clientY: 101 }] });   // 3+1=4px — under threshold
  await new Promise(r => setTimeout(r, 400));
  assert(msg3._classes.has('chat-actions-revealed'), 'movement under the 8px threshold does not cancel a genuine long-press');

  // Case 4 — touchend BEFORE the timer fires cancels it (a quick tap is not a hold).
  const root4 = makeFakeScrollRoot23();
  const msg4 = makeFakeMsgEl23('tap_msg');
  revealTargets23['tap_msg'] = msg4;
  chatUi._bindMessageActionsLongPress(root4);
  root4._fire('touchstart', { touches: [{ clientX: 50, clientY: 50 }], target: touchTargetFor(msg4) });
  root4._fire('touchend', {});
  await new Promise(r => setTimeout(r, 400));
  assert(!msg4._classes.has('chat-actions-revealed'), 'a quick tap (touchend before 350ms) never reveals actions');

  document.querySelector = realQS23b;
}

console.log('\n[23g] UN-104 — chat layout: sticky stacking, not a nested scroll box…');
const scrollRule23 = (cssSrc.match(/\.chat-scroll\{[^}]*\}/) || [''])[0];
assert(!/max-height:\s*56vh/.test(scrollRule23), '.chat-scroll no longer caps at max-height:56vh (the artificial cap Drew identified as the cause of the overflow)');

const templateMatch23 = chatUiSrc.match(/c\.innerHTML = `[\s\S]*?`;/);
const chatPageTemplate23 = templateMatch23 ? templateMatch23[0] : '';
assert(chatPageTemplate23.length > 0, 'renderChatPage() template block located for structural assertions');
assert(/<div class="chat-sticky-stack">/.test(chatPageTemplate23),
  'the compact header row + pills + view header are wrapped in ONE sticky unit (not per-element sticky math)');
assert(!/class="subtitle"/.test(chatPageTemplate23),
  'UN-104: the two-line "SCRIBE on duty" subtitle row is gone from the chat header — one compact line only');

// v0.17.4 — REPLACED (first pass). These originally asserted position:sticky
// on the pills stack and the composer. Review found that mechanism INERT:
// .page-wrapper and .main-content both set overflow-x:hidden, so per spec
// overflow-y computes to `auto`, they become the nearest scrolling ancestor,
// and they never scroll — so the sticky offset never applied. Measured in
// headless Chrome: the stack's rect.top read -1076 where sticky would have
// given 64. That pass replaced it with a calc()-based .chat-scroll max-height
// driven by a runtime-measured .app-header + .chat-composer height.
//
// v0.17.5 (batch 4, UN-110) — REPLACED AGAIN, this time by design, not a bug
// fix: UN-110 reverses UN-104's "keep the header, make it unobtrusive" answer
// and hides .app-header entirely on the chat tab
// (body[data-tab="chat"] .app-header). The calc()-based max-height this block
// used to assert read a --chat-sticky-top var published by MEASURING that
// now-hidden header — dead on arrival, would forever read 0.
// #page-chat.active is a real flex column instead: an explicit bounded
// height on the PARENT, flex:1 + min-height:0 on .chat-scroll (the ONE child
// that actually scrolls). Every assertion below checks THAT mechanism, not
// the old one — this is the regression-shaped block Testing Protocol step 10
// asks about: run against the pre-fix source, the "no longer bounds itself
// with max-height:calc()" and "--chat-sticky-top is never set" assertions
// below both FAIL (the old rule had exactly those things).
const chatScrollRule = (cssSrc.match(/\.chat-scroll\{[^}]*\}/) || [''])[0];
assert(/overflow-y:\s*auto/.test(chatScrollRule),
  '.chat-scroll is a REAL scroll container');
assert(!/max-height:\s*calc\(/.test(chatScrollRule) && /max-height:\s*none/.test(chatScrollRule),
  '.chat-scroll no longer bounds ITSELF with a calc() max-height — the bound moved to the PARENT (#page-chat.active), below');
assert(!/var\(--chat-sticky-top/.test(chatScrollRule),
  '.chat-scroll no longer reads --chat-sticky-top — that var was published by measuring .app-header, which is now display:none on chat and would forever measure 0');
assert(/flex:\s*1\s+1\s+auto/.test(chatScrollRule),
  '.chat-scroll is flex:1 1 auto — it grows to fill whatever space its flex SIBLINGS (header stack, offline banner, retention notice, composer) leave behind');
assert(/min-height:\s*0\b/.test(chatScrollRule),
  '.chat-scroll has min-height:0 — REQUIRED for a flex child to shrink/scroll at all (the flex default min-height is `auto`, i.e. "at least as tall as my content"); omitting it produces a page that looks fine until the thread is long enough to push the composer off-screen — classic flex-scroll bug, called out explicitly in the design input');

const pageChatActiveRule = (cssSrc.match(/#page-chat\.active\{[^}]*\}/) || [''])[0];
assert(pageChatActiveRule.length > 0, '#page-chat.active rule located');
assert(/display:\s*flex/.test(pageChatActiveRule) && /flex-direction:\s*column/.test(pageChatActiveRule),
  '#page-chat.active is a flex column — the bounding mechanism moved from .chat-scroll\'s own calc() to the PARENT\'s explicit height');
assert(/height:\s*calc\(100dvh/.test(pageChatActiveRule) && /var\(--nav-height\)/.test(pageChatActiveRule) && /env\(safe-area-inset-bottom/.test(pageChatActiveRule),
  '#page-chat.active has an explicit height budgeting for the nav and the bottom safe area (moved here from .chat-scroll)');
assert(/padding-top:\s*env\(safe-area-inset-top/.test(pageChatActiveRule),
  '#page-chat.active supplies its own top safe-area clearance — the notch clearance .app-header used to supply before it was hidden on this tab');
assert(/overflow:\s*hidden/.test(pageChatActiveRule),
  '#page-chat.active clips overflow at the page level — .chat-scroll is the ONLY child that actually scrolls');
assert(/@supports not \(height:100dvh\)\{#page-chat\.active\{height:calc\(100vh/.test(cssSrc),
  'a non-dvh fallback exists for #page-chat.active (moved from the old .chat-scroll fallback, same 100vh substitution pattern)');

const flexAutoRule = (cssSrc.match(/\.chat-sticky-stack,\.chat-offline-banner,\.chat-retention-notice,\.chat-composer,#chat-jump\{[^}]*\}/) || [''])[0];
assert(/flex:\s*0\s+0\s+auto/.test(flexAutoRule),
  'the header stack, offline banner, retention notice, composer, and jump-to-latest button are all flex:0 0 auto — fixed-size flex siblings of .chat-scroll, none of them the scrolling child');

// The header-hiding half of the mechanism (UN-110's data-tab approach).
assert(/body\[data-tab="chat"\]\s*\.app-header\{display:\s*none\}/.test(cssSrc),
  'body[data-tab="chat"] .app-header{display:none} exists — the header is actually REMOVED on the chat tab, not just visually minimized (UN-104\'s answer)');

// The inert rules must not come back.
assert(!/#page-chat \.chat-sticky-stack\{[^}]*position:\s*sticky/.test(cssSrc),
  'the inert position:sticky on .chat-sticky-stack is gone, not left for someone to "fix"');
assert(!/#page-chat \.chat-composer\{[^}]*position:\s*sticky/.test(cssSrc),
  'the inert position:sticky on the composer is gone');

// The per-game bottom sheet must declare its OWN overflow. It inherited it from
// .chat-scroll, so when that was removed the sheet spilled its content out over
// the composer and backdrop, unclipped and unscrollable.
const sheetScrollRule = (cssSrc.match(/\.chat-sheet-scroll\{[^}]*\}/) || [''])[0];
assert(/overflow-y:\s*auto/.test(sheetScrollRule),
  '.chat-sheet-scroll declares its own overflow — never depends on a sibling surface\'s rule');

// The react picker must clear the bottom nav (z-index 100). The composer-scoped
// rule that handled this was deleted with the composer picker; the per-message
// anchor needed its own, or long-pressing the NEWEST message and tapping + does
// nothing visible — the exact bug the deleted rule's comment described.
const msgPickerRule = (cssSrc.match(/\.chat-msg \.reaction-picker\{[^}]*\}/) || [''])[0];
assert(/bottom:\s*100%/.test(msgPickerRule), 'the per-message react picker opens UPWARD');
const pickerZ = Number((msgPickerRule.match(/z-index:\s*(\d+)/) || [])[1] || 0);
const navZ = Number(((cssSrc.match(/\.bottom-nav\{[^}]*\}/) || [''])[0].match(/z-index:\s*(\d+)/) || [])[1] || 0);
assert(pickerZ > navZ, `react picker (z=${pickerZ}) renders ABOVE .bottom-nav (z=${navZ})`);

// The runtime measurement itself.
// v0.17.5 (batch 4, UN-110) — REWRITTEN. This previously proved
// _syncChatStickyMetrics measured .app-header's REAL height and published it
// as --chat-sticky-top. UN-110 deletes that measurement entirely (.app-header
// is display:none on chat; measuring it would return 0 and poison the var
// forever) — the function now measures ONLY the composer. Proving the
// negative as strongly as this harness can without a real layout engine:
// .app-header's mock THROWS on getBoundingClientRect — if the function still
// queried and measured it, this test would fail with an exception, not just
// a wrong value.
assert(typeof chatUi._syncChatStickyMetrics === 'function',
  'chat-ui.js exports _syncChatStickyMetrics (test-only) — the runtime composer-measurement function');
if (typeof chatUi._syncChatStickyMetrics === 'function') {
  const realQS23c = document.querySelector;
  const realDocEl23 = document.documentElement;
  const setProps = {};
  document.documentElement = { style: { setProperty: (k, v) => { setProps[k] = v; } } };
  document.querySelector = sel => {
    if (sel === '.app-header') return { getBoundingClientRect: () => { throw new Error('regression: .app-header must never be measured again — UN-110 hides it on chat'); } };
    if (sel === '#page-chat .chat-composer') return { getBoundingClientRect: () => ({ height: 132.2 }) };
    return null;
  };
  chatUi._syncChatStickyMetrics();
  assert(setProps['--chat-sticky-top'] === undefined,
    `--chat-sticky-top is never set — the measurement that used to publish it is DELETED, not just left unused — got ${setProps['--chat-sticky-top']}`);
  assert(setProps['--chat-composer-h'] === '133px',
    `--chat-composer-h is still set from the REAL measured composer height (rounded up) — still needed for .chat-jump-latest — got ${setProps['--chat-composer-h']}`);
  document.querySelector = realQS23c;
  document.documentElement = realDocEl23;
}

const jumpLatestRule23 = (cssSrc.match(/#page-chat \.chat-jump-latest\{[^}]*\}/) || [''])[0];
assert(/var\(--chat-composer-h/.test(jumpLatestRule23),
  '"jump to latest" clears the composer using the SAME measured composer height (unchanged by UN-110 — only the header half of the UN-104 mechanism was removed)');

console.log('\n[23h] UN-67 collateral guard — member framing survives in BOTH places named in the design input…');
assert(/The Locker Room is open\. SCRIBE is on duty\./.test(chatUiSrc),
  'the chat empty-room state still carries the "SCRIBE is on duty" framing');
assert(/It is on duty\./.test(appJsSrc),
  'the Rules FAQ still carries the "It is on duty" framing (the second surviving instance named in the design input)');

// ── 24. UN-107 — commissioner control over the "Randomize My Picks" shortcut ──
console.log('\n[24] UN-107 — commissioner control over randomize picks…');
const app = mods['app'];

assert(dm.DEFAULT_SETTINGS.randomizePicksEnabled === false, 'DEFAULT_SETTINGS.randomizePicksEnabled defaults to false');

// The literal hazard named in the task: a missing value must NEVER silently
// enable the shortcut. Simulate an OLD settings blob written before this
// field existed (saveSettings is the raw setter — no DEFAULT_SETTINGS spread).
storage.saveSettings({ timezone: 'PT' });
assert(storage.getSettings().randomizePicksEnabled === false,
  'randomizePicksEnabled reads FALSE when the field is absent from a stored settings blob (the default-when-missing case — CONVENTIONS #10)');

storage.saveSetting('randomizePicksEnabled', true);
assert(storage.getSettings().randomizePicksEnabled === true, 'an explicit true is respected');
storage.saveSetting('randomizePicksEnabled', false);
assert(storage.getSettings().randomizePicksEnabled === false, 'an explicit false is respected');

// The row (including the button) must not render at all when off — not
// disabled, not greyed. Source-verified: the DOM stub returns null from
// getElementById('page-picks'), so renderPicksPageCurrent() early-returns
// before reaching this markup and can't be exercised end-to-end here.
assert(/\$\{getSettings\(\)\.randomizePicksEnabled\?`<div class="flex-between mb-sm randomize-row">/.test(appJsSrc),
  'the randomize row (including #randomize-picks-btn) is wrapped behind getSettings().randomizePicksEnabled — it does not render at all when off');
const randomizeRowBlock = (appJsSrc.match(/\$\{getSettings\(\)\.randomizePicksEnabled\?`<div class="flex-between mb-sm randomize-row">[\s\S]*?<\/div>`:''\}/) || [''])[0];
assert(/id="randomize-picks-btn"/.test(randomizeRowBlock),
  'the gated block contains the actual button element, not just the surrounding row');

// The comm card lives in the Settings tab (RG-10: an untagged admin-section
// renders on all five tabs) and follows the chat on/off card's pattern.
const randomizeCardBlock = (appJsSrc.match(/<div class="admin-section" data-comm-tab="settings">\s*<div class="card" id="comm-randomize-card">[\s\S]*?<\/div>\s*<\/div>`\);/) || [''])[0];
assert(randomizeCardBlock.length > 0,
  'the commissioner Randomize Picks card is wrapped in <div class="admin-section" data-comm-tab="settings"> (RG-10)');
assert(/id="randomize-enabled-toggle"/.test(randomizeCardBlock), 'the card contains the randomize-enabled-toggle checkbox');
assert(/Players see a 🎲 Randomize My Picks shortcut on the Picks page\./.test(randomizeCardBlock),
  'the ON-state copy matches the approved design input verbatim');
assert(/The randomize shortcut is hidden\. Players make every pick by hand\./.test(randomizeCardBlock),
  'the OFF-state copy matches the approved design input verbatim');

assert(/getElementById\('randomize-enabled-toggle'\)\?\.addEventListener\('change'/.test(appJsSrc),
  'a change handler is wired to the toggle');
const toggleHandlerBlock = (appJsSrc.match(/getElementById\('randomize-enabled-toggle'\)\?\.addEventListener\('change', e => \{[\s\S]*?\}\);/) || [''])[0];
assert(/saveSetting\('randomizePicksEnabled', e\.target\.checked\)/.test(toggleHandlerBlock),
  'the toggle handler saves through saveSetting() — the shared storage seam, not a parallel abstraction');

// ── 25. UN-105b — Permissions table: fit instead of clip, emoji alignment ────
console.log('\n[25] UN-105b — Permissions table: no clipping, emoji column alignment…');

const allFaqPermsRules = cssSrc.match(/\.faq-perms[^{]*\{[^}]*\}/g) || [];
assert(allFaqPermsRules.length > 0, '.faq-perms CSS rules located');
assert(allFaqPermsRules.every(r => !/white-space:\s*nowrap/.test(r)),
  '.faq-perms: no rule (base or per-column) carries white-space:nowrap anymore — that was the root cause of the clipping');

const faqPermsBaseRule = (cssSrc.match(/\.faq-perms\{[^}]*\}/) || [''])[0];
assert(/table-layout:\s*fixed/.test(faqPermsBaseRule), '.faq-perms carries table-layout:fixed');

const col1 = Number((cssSrc.match(/\.faq-perms th:nth-child\(1\),\.faq-perms td:nth-child\(1\)\{width:(\d+)%\}/) || [])[1] || 0);
const col2 = Number((cssSrc.match(/\.faq-perms th:nth-child\(2\),\.faq-perms td:nth-child\(2\)\{width:(\d+)%\}/) || [])[1] || 0);
const col3 = Number((cssSrc.match(/\.faq-perms th:nth-child\(3\),\.faq-perms td:nth-child\(3\)\{width:(\d+)%\}/) || [])[1] || 0);
assert(col1 > 0 && col2 > 0 && col3 > 0, `all three .faq-perms column widths are declared — got ${col1}%/${col2}%/${col3}%`);
assert(col1 + col2 + col3 === 100, `.faq-perms column widths sum to exactly 100% — got ${col1}+${col2}+${col3}=${col1 + col2 + col3}`);
assert(col1 > col2 && col1 > col3, `the label column is the widest, per the design input's ~46/27/27 split — got ${col1}%/${col2}%/${col3}%`);

// Emoji-column alignment: cells default to text-align:left (no center
// override survives), which — combined with table-layout:fixed — pins every
// row's leading emoji to the same x-position instead of drifting with
// varying text length under center-align.
assert(!/\.faq-perms[^{]*\{[^}]*text-align:\s*center/.test(cssSrc),
  '.faq-perms: no rule re-centers columns 2/3 — left-align (the table default) is what keeps the emoji column straight');
const faqPermsCellRule = (cssSrc.match(/\.faq-perms th,\.faq-perms td\{[^}]*\}/) || [''])[0];
assert(/text-align:\s*left/.test(faqPermsCellRule), '.faq-perms cells are left-aligned');

// The goal is to FIT, not to scroll — no scroll wrapper was added around it.
const faqSection = (appJsSrc.match(/Permissions — who can do what[\s\S]*?<\/table>/) || [''])[0];
assert(faqSection.length > 0, 'the Permissions table markup located in renderRulesPage()');
assert(!/dashboard-scroll|batch-grid-scroll/.test(faqSection),
  '.faq-perms is NOT wrapped in a horizontal-scroll container — the fix makes it fit, per the design input');

// ── 26. UN-105a — horizontal-scroll edge-fade cue ────────────────────────────
console.log('\n[26] UN-105a — horizontal-scroll edge-fade cue…');

assert(typeof app.initScrollFades === 'function', 'app.js exports initScrollFades — the one shared binder');
assert(typeof app._updateScrollFadeState === 'function', 'app.js exports _updateScrollFadeState (test-only) for behavioral coverage');

// v0.17.4 — REPLACED. These asserted absolutely-positioned ::before/::after
// pseudo-elements. Review measured them in Chrome: because they sit INSIDE the
// overflow-x:auto element they scroll away with the content — the right fade
// drifted to mid-table, and the left fade could never be seen at all, since by
// the time it switched on it had already scrolled off screen.
//
// background-attachment:local is purpose-built for this. The `local` layers
// paint relative to the CONTENT and mask the gradients at each end; the
// `scroll` gradient layers paint relative to the SCROLLPORT and stay pinned.
// Each cue appears only when there is more content that way, hides at the
// boundary, and shows nothing when the content fits — with no JS to drift.
const scrollFadeRule = (cssSrc.match(/\.scroll-fade\{[\s\S]*?\}/) || [''])[0];
assert(/background-attachment:\s*local,\s*local,\s*scroll,\s*scroll/.test(scrollFadeRule),
  '.scroll-fade pins its cues to the SCROLLPORT via background-attachment, so they cannot drift with the content');
assert(!/position:\s*absolute/.test(scrollFadeRule),
  '.scroll-fade no longer uses absolutely-positioned overlays inside the scrolling element');
const localLayers = (scrollFadeRule.match(/linear-gradient/g) || []).length;
assert(localLayers === 4, `.scroll-fade declares 4 gradient layers (2 masks + 2 cues) — got ${localLayers}`);

// v0.17.4 — the cascade-order check above is obsolete: there are no longer any
// opacity-activation rules to order, because the cue is now painted by
// background layers rather than toggled pseudo-elements. What matters instead
// is the LAYER ORDER inside the shorthand — the two `local` mask layers must be
// listed BEFORE the two `scroll` gradient layers, or the masks paint underneath
// and the cue never hides at the boundary.
const bgAttach = (scrollFadeRule.match(/background-attachment:([^;]*)/) || ['',''])[1];
const bgLayers = bgAttach.split(',').map(x => x.trim());
assert(bgLayers.length === 4 && bgLayers[0] === 'local' && bgLayers[1] === 'local'
       && bgLayers[2] === 'scroll' && bgLayers[3] === 'scroll',
  `mask layers are declared before the cue layers — got [${bgLayers.join(', ')}]`);
const bgSizeCount = ((scrollFadeRule.match(/background-size:([^;]*)/) || ['',''])[1].split(',').length);
assert(bgSizeCount === 4, `background-size declares all 4 layers — got ${bgSizeCount}`);

// Render-site coverage. Six known raw template occurrences of the wrapper
// classes today — a tripwire: if this count changes, whoever added the new
// site must also wire an initScrollFades() call for it (see the per-function
// checks below).
const wrapperSites = appJsSrc.match(/class="dashboard-scroll[^"]*"|class="batch-grid-scroll[^"]*"/g) || [];
assert(wrapperSites.length === 6,
  `exactly 6 known .dashboard-scroll/.batch-grid-scroll render sites in app.js templates — got ${wrapperSites.length} (if this changed, the new site needs its own initScrollFades() call, and this count must be updated deliberately)`);

// Extract a top-level function's full body by brace-matching (regex alone
// can't handle nested braces reliably).
function fnBody(name) {
  const start = appJsSrc.indexOf(`function ${name}(`);
  if (start === -1) return '';
  const braceStart = appJsSrc.indexOf('{', start);
  let depth = 0, end = braceStart;
  for (let i = braceStart; i < appJsSrc.length; i++) {
    if (appJsSrc[i] === '{') depth++;
    else if (appJsSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return appJsSrc.slice(start, end + 1);
}
// Comment-strip each body before counting (the codebase's own explanatory
// comments near these call sites legitimately mention the class names by
// name, e.g. "the .dashboard-scroll wrapper above" — which would otherwise
// inflate a bare-word count. Reuses the SAME `code` filter as [7]'s uiCode.
const stripComments = body => body.split('\n').filter(code).join('\n');
const dashBody = stripComments(fnBody('renderDashboardInner'));
const leaderBody = stripComments(fnBody('renderLeaderboard'));
const commBody = stripComments(fnBody('renderCommPage'));
const demoGridBody = stripComments(fnBody('renderDemoBatchGrid'));
const season25Body = stripComments(fnBody('renderSeason2025RecordSection'));

assert(dashBody.length > 0 && /dashboard-scroll/.test(dashBody) && /initScrollFades\(/.test(dashBody),
  'renderDashboardInner renders a .dashboard-scroll wrapper AND calls initScrollFades()');
assert(leaderBody.length > 0 && (leaderBody.match(/dashboard-scroll/g) || []).length === 2 && /initScrollFades\(/.test(leaderBody),
  'renderLeaderboard renders its own 2 direct .dashboard-scroll wrappers (season summary + weekly history) AND calls initScrollFades()');
assert(/renderSeason2025RecordSection\(\)/.test(leaderBody),
  'renderLeaderboard also embeds renderSeason2025RecordSection — the SAME initScrollFades(c) call above covers its wrappers via the <details> toggle rebind');
assert(season25Body.length > 0 && (season25Body.match(/dashboard-scroll/g) || []).length === 2,
  `renderSeason2025RecordSection renders exactly 2 .dashboard-scroll wrappers inside its collapsed <details> — got ${(season25Body.match(/dashboard-scroll/g) || []).length}`);
assert(demoGridBody.length > 0 && /batch-grid-scroll/.test(demoGridBody),
  'renderDemoBatchGrid renders the .batch-grid-scroll wrapper');
assert(/renderDemoBatchGrid\(/.test(commBody) && (commBody.match(/initScrollFades\(/g) || []).length >= 2,
  'renderCommPage embeds renderDemoBatchGrid\'s wrapper AND calls initScrollFades() at BOTH initial render and on tab switch (the wrapper can be hidden — 0×0 — at initial paint if the panel opens on a non-"week" tab)');

// Behavioral coverage — the actual boundary-disappearing requirement, tested
// against the real exported function with fake scrollWidth/clientWidth/
// scrollLeft, not just source presence (Testing Protocol step 12).
console.log('\n[26b] UN-105a — boundary behavior: fade classes toggle correctly at each scroll position…');
function fakeScrollEl({ scrollWidth, clientWidth, scrollLeft }) {
  const classes = new Set();
  return {
    scrollWidth, clientWidth, scrollLeft,
    classList: {
      add: c => classes.add(c),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c),
    },
    _classes: classes,
  };
}

// No overflow at all — neither fade may ever show (hinting at a scroll that
// doesn't exist is explicitly called out as worse than no hint).
const noOverflow = fakeScrollEl({ scrollWidth: 400, clientWidth: 400, scrollLeft: 0 });
app._updateScrollFadeState(noOverflow);
assert(!noOverflow._classes.has('scroll-fade-active'), 'no overflow: scroll-fade-active is NOT set');
assert(!noOverflow._classes.has('scroll-fade-at-end') && !noOverflow._classes.has('scroll-fade-scrolled'),
  'no overflow: neither edge class is set — no fade at all when the content does not actually overflow');

// Overflowing, at the very start — right fade shows (more to scroll to);
// left fade does not (nothing hidden to the left yet).
const atStart = fakeScrollEl({ scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
app._updateScrollFadeState(atStart);
assert(atStart._classes.has('scroll-fade-active'), 'overflowing table: scroll-fade-active IS set');
assert(!atStart._classes.has('scroll-fade-at-end'), 'at the start: right fade is showing (scroll-fade-at-end NOT set)');
assert(!atStart._classes.has('scroll-fade-scrolled'), 'at the start: left fade is hidden (scroll-fade-scrolled NOT set)');

// Scrolled to the middle — both fades show.
const midScroll = fakeScrollEl({ scrollWidth: 900, clientWidth: 400, scrollLeft: 250 });
app._updateScrollFadeState(midScroll);
assert(midScroll._classes.has('scroll-fade-scrolled'), 'mid-scroll: left fade shows (scrolled away from the start)');
assert(!midScroll._classes.has('scroll-fade-at-end'), 'mid-scroll: right fade still shows (not at the end yet)');

// Fully scrolled right — THE critical disappearing-at-the-boundary
// requirement. Right fade must vanish; left fade must still show (there IS
// hidden content to the left).
const atEnd = fakeScrollEl({ scrollWidth: 900, clientWidth: 400, scrollLeft: 500 });
app._updateScrollFadeState(atEnd);
assert(atEnd._classes.has('scroll-fade-at-end'), 'fully scrolled right: scroll-fade-at-end IS set — the right fade disappears at the boundary');
assert(atEnd._classes.has('scroll-fade-scrolled'), 'fully scrolled right: left fade still shows');

// Scrolled back to the start — a live toggle, not a one-way flag.
atEnd.scrollLeft = 0;
app._updateScrollFadeState(atEnd);
assert(!atEnd._classes.has('scroll-fade-at-end'), 'scrolled back to the start: right fade reappears');
assert(!atEnd._classes.has('scroll-fade-scrolled'), 'scrolled back to the start: left fade disappears again');

// initScrollFades itself: idempotent binding (no duplicate scroll listeners
// across repeat calls on the SAME node) + recompute-on-recall (the actual
// commissioner-tab-switch fix — a wrapper hidden at 0×0 becomes measurable
// once visible, without needing to be rebound).
console.log('\n[26c] UN-105a — initScrollFades: idempotent binding, recompute on repeat calls…');
function fakeContainerEl(props) {
  const el = fakeScrollEl(props);
  el.dataset = {};
  let scrollHandlerCount = 0;
  el.addEventListener = (type) => { if (type === 'scroll') scrollHandlerCount++; };
  el._scrollHandlerCount = () => scrollHandlerCount;
  return el;
}
function fakeRoot(elements, detailsEls = []) {
  return {
    querySelectorAll: sel => {
      if (sel === '.dashboard-scroll, .batch-grid-scroll') return elements;
      if (sel === 'details') return detailsEls;
      return [];
    },
  };
}

const boundEl = fakeContainerEl({ scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
app.initScrollFades(fakeRoot([boundEl]));
assert(boundEl._classes.has('scroll-fade'), 'initScrollFades adds the shared .scroll-fade class');
assert(boundEl._classes.has('scroll-fade-active'), 'initScrollFades computes state immediately on bind');
assert(boundEl._scrollHandlerCount() === 1, 'initScrollFades binds exactly one scroll listener on first call');
app.initScrollFades(fakeRoot([boundEl]));   // simulate a re-render / tab switch on the same node
assert(boundEl._scrollHandlerCount() === 1,
  'a second initScrollFades() call on the SAME node does not stack a duplicate scroll listener');

const hiddenThenShown = fakeContainerEl({ scrollWidth: 0, clientWidth: 0, scrollLeft: 0 });
app.initScrollFades(fakeRoot([hiddenThenShown]));
assert(!hiddenThenShown._classes.has('scroll-fade-active'), 'a hidden (0×0, e.g. an inactive comm tab) wrapper is inactive at first bind');
hiddenThenShown.scrollWidth = 900; hiddenThenShown.clientWidth = 400; // "the tab became active"
app.initScrollFades(fakeRoot([hiddenThenShown]));
assert(hiddenThenShown._classes.has('scroll-fade-active'),
  'the SAME node is RECOMPUTED (not just bound once) once it becomes measurable — this is the commissioner tab-switch fix');

// <details> toggle rebind — the season-2025 record section's two wrapped
// tables can't be measured while collapsed (display:none); opening it must
// re-run initScrollFades scoped to that <details>.
function fakeDetailsEl() {
  const handlers = {};
  return { dataset: {}, addEventListener: (type, fn) => { handlers[type] = fn; }, _fire: type => handlers[type]?.() };
}
const detailsEl = fakeDetailsEl();
const innerEl = fakeContainerEl({ scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
detailsEl.querySelectorAll = sel => (sel === '.dashboard-scroll, .batch-grid-scroll' ? [innerEl] : []);
app.initScrollFades(fakeRoot([], [detailsEl]));
assert(!innerEl._classes.has('scroll-fade'), 'sanity: the table nested inside the collapsed <details> is untouched before it opens');
detailsEl._fire('toggle');
assert(innerEl._classes.has('scroll-fade') && innerEl._classes.has('scroll-fade-active'),
  'opening the <details> re-runs initScrollFades scoped to it, catching the tables that were unmeasurable while collapsed');

// ── 27. Batch 4 (v0.17.5) — UN-108 header balance, UN-109 logo removal,
//       UN-110 chat owns the screen (reverses UN-104), UN-111 tz/theme
//       contextual, RG banner fix ─────────────────────────────────────────────
console.log('\n[27a] RG — loud-fail banner: position:fixed + safe-area-inset-top…');

// AD-06 regression: showBackendErrorBanner() appends the banner AFTER
// .page-wrapper closes (document.body.appendChild), and position:sticky sticks
// relative to the element's OWN flow position — below the entire app on any
// page taller than one viewport. Fixed to position:fixed (correct for a
// body-level element outside any scrolling flow) + env(safe-area-inset-top)
// so it clears the status bar on the installed app, same as .app-header.
const bannerRule27 = (cssSrc.match(/\.backend-error-banner\{[^}]*\}/) || [''])[0];
assert(bannerRule27.length > 0, '.backend-error-banner rule located');
assert(/position:\s*fixed/.test(bannerRule27),
  `.backend-error-banner is position:fixed, not position:sticky (the actual bug — sticky only offsets within the element's own flow position) — got "${bannerRule27}"`);
assert(!/position:\s*sticky/.test(bannerRule27),
  '.backend-error-banner no longer uses position:sticky at all');
assert(/top:\s*0/.test(bannerRule27) && /left:\s*0/.test(bannerRule27) && /right:\s*0/.test(bannerRule27),
  '.backend-error-banner still pins to all three edges (top/left/right) — regression guard: this must FAIL against the pre-fix rule\'s intent if the edges were ever dropped');
assert(/padding-top:\s*env\(safe-area-inset-top/.test(bannerRule27),
  `.backend-error-banner accounts for env(safe-area-inset-top) so it clears the status bar/Dynamic Island on the installed app (UN-98 pattern) — got "${bannerRule27}"`);
assert(/z-index:\s*200/.test(bannerRule27),
  '.backend-error-banner keeps its z-index:200 (above .app-header\'s z-index:100 and .bottom-nav\'s z-index:100)');

console.log('\n[27b] UN-109 — logo removed from every screen…');

// Markup: the app-logo block (icon + text) must be gone from index.html
// entirely — "no partial keep," Drew's reasoning applies everywhere.
assert(!/class="app-logo"/.test(indexHtmlSrc) && !/app-logo-icon/.test(indexHtmlSrc) && !/app-logo-text/.test(indexHtmlSrc),
  'no app-logo/app-logo-icon/app-logo-text markup survives anywhere in index.html');
// refreshHeader()'s no-week fallback is explicitly EXEMPT — DI: "leave it,
// that edge case wants branding" — and doesn't use the emoji anyway.
assert(/<strong>CFB Pickems<\/strong>/.test(appJsSrc),
  "refreshHeader()'s no-week fallback still prints \"CFB Pickems\" — the one explicitly-kept branding instance, a fresh install with zero weeks");

// CSS: the dead selectors — including their <=480px / <=360px overrides —
// must not survive either.
assert(!/\.app-logo\{/.test(cssSrc) && !/\.app-logo-icon\{/.test(cssSrc) && !/\.app-logo-text/.test(cssSrc),
  'no .app-logo/.app-logo-icon/.app-logo-text CSS rule survives (including narrow-viewport overrides)');

console.log('\n[27c] UN-108 — header balance: header-right is a ROW, header-meta is the left slot…');

// Root cause, verified in the design input: .header-right was
// flex-direction:column — a five-row vertical tower stacked against a single
// small logo. THAT was the actual mechanism behind "unbalanced," not a
// spacing nit. This is the literal fix.
const headerRightRule27 = (cssSrc.match(/\.header-right\{[^}]*\}/) || [''])[0];
assert(headerRightRule27.length > 0, '.header-right rule located');
assert(/flex-direction:\s*row/.test(headerRightRule27),
  `.header-right is flex-direction:row — the actual imbalance mechanism, fixed — got "${headerRightRule27}"`);
assert(!/flex-direction:\s*column/.test(headerRightRule27),
  '.header-right is no longer flex-direction:column (the five-row tower)');

// #header-meta keeps its id (refreshHeader() targets it by id — no JS change
// needed) but is now the LEFT slot, moved OUT of .header-right, ahead of it
// in .app-header-inner so .app-header-inner's existing
// justify-content:space-between creates a real left/right split.
const headerInnerBlock27 = (indexHtmlSrc.match(/<div class="app-header-inner">[\s\S]*?<\/header>/) || [''])[0];
assert(headerInnerBlock27.length > 0, '.app-header-inner block located in index.html');
assert(/id="header-meta"/.test(headerInnerBlock27), '#header-meta still exists with its id — refreshHeader() (app.js) targets it by id');
const metaIdx27 = headerInnerBlock27.indexOf('id="header-meta"');
const rightDivIdx27 = headerInnerBlock27.indexOf('class="header-right"');
assert(metaIdx27 > -1 && rightDivIdx27 > -1 && metaIdx27 < rightDivIdx27,
  '#header-meta is the LEFT slot — it appears BEFORE .header-right in the markup, not nested inside it');
const headerRightMarkup27 = (indexHtmlSrc.match(/<div class="header-right">[\s\S]*?<\/div>\s*<\/div>\s*<\/header>/) || [''])[0];
assert(!/id="header-meta"/.test(headerRightMarkup27),
  '#header-meta is no longer INSIDE .header-right\'s markup — it moved out to become its own slot');
const headerMetaRule27 = (cssSrc.match(/\.header-meta\{[^}]*\}/) || [''])[0];
assert(/text-align:\s*left/.test(headerMetaRule27),
  `.header-meta is text-align:left now that it's the left slot (was text-align:right when it lived inside .header-right) — got "${headerMetaRule27}"`);

console.log('\n[27d] UN-111 — tz/theme visibility uses the REAL tab keys, not "standings"…');

// The naming trap named in the task: the Standings tab's real data-tab value
// is "leaderboard" (index.html nav, asserted in [21] as `navOrder`), not
// "standings" (its human-readable label). Every body[data-tab="..."] selector
// anywhere in styles.css must draw from the REAL key set.
const dataTabRefs27 = [...cssSrc.matchAll(/body\[data-tab="([a-z]+)"\]/g)].map(m => m[1]);
assert(dataTabRefs27.length > 0, 'at least one body[data-tab="..."] CSS rule exists (UN-110/UN-111)');
const validTabKeys27 = new Set(navOrder);   // ['picks','dashboard','chat','leaderboard','rules','commissioner']
assert(dataTabRefs27.every(k => validTabKeys27.has(k)),
  `every body[data-tab="..."] selector uses a REAL nav tab key — got ${JSON.stringify([...new Set(dataTabRefs27)])}, valid keys are ${JSON.stringify([...validTabKeys27])}`);
assert(!dataTabRefs27.includes('standings'),
  'styles.css never uses "standings" as a data-tab value anywhere — the naming trap the task called out by name (the real key is "leaderboard", which this batch correctly never targets since tz/theme are NOT shown on that tab)');

const tzToggleBaseRule27 = (cssSrc.match(/#tz-toggle,#theme-toggle\{[^}]*\}/) || [''])[0];
assert(/display:\s*none/.test(tzToggleBaseRule27), 'tz-toggle/theme-toggle are display:none by default (hidden everywhere unless a tab opts in)');
assert(/body\[data-tab="picks"\] #tz-toggle,\s*\nbody\[data-tab="dashboard"\] #tz-toggle,\s*\nbody\[data-tab="commissioner"\] #tz-toggle\{display:\s*flex\}/.test(cssSrc),
  'tz-toggle shows on picks, dashboard, AND commissioner (kickoff times render in Comm -> Games with no admin-scoped tz control — grounded, not arbitrary)');
assert(/body\[data-tab="picks"\] #theme-toggle,\s*\nbody\[data-tab="dashboard"\] #theme-toggle\{display:\s*inline-flex\}/.test(cssSrc),
  'theme-toggle shows on picks and dashboard ONLY (no Commissioner — theme has no page-content dependency, stays literal to Drew\'s words)');
assert(!/body\[data-tab="commissioner"\] #theme-toggle/.test(cssSrc),
  'theme-toggle is deliberately NOT shown on commissioner (asymmetric from tz on purpose, per the design input\'s reasoning)');

console.log('\n[27e] UN-110 — data-tab wiring: static default, navigateTo(), AD-06 chat sync badge…');

// index.html: data-tab="dashboard" set STATICALLY on <body>, matching the
// hardcoded default-active #page-dashboard, so there's no flash before JS.
assert(/<body class="cfbp-booting" data-tab="dashboard">/.test(indexHtmlSrc),
  'body has data-tab="dashboard" set statically in the HTML (matches the hardcoded default-active #page-dashboard)');

// navigateTo(): sets document.body.dataset.tab, AFTER the chat-disabled
// redirect. Harness limitation (same one already documented in [12] for this
// SAME function): the DOM stub's getElementById/querySelectorAll return
// null/[] so navigateTo()'s full render dispatch can't safely be exercised
// end-to-end here without invoking untested heavy render paths — source-
// verified instead, same as the existing chat-disabled-redirect guard.
const navigateToFnSrc27 = (appJsSrc.match(/function navigateTo\(tab\) \{[\s\S]*?\n\}/) || [''])[0];
assert(navigateToFnSrc27.length > 0, 'navigateTo() function body located for structural assertions');
assert(/document\.body\.dataset\.tab = tab;/.test(navigateToFnSrc27),
  'navigateTo() sets document.body.dataset.tab — drives body[data-tab] CSS (chat\'s header-hidden layout, UN-111\'s tz/theme visibility)');
const redirectIdx27 = navigateToFnSrc27.indexOf("tab = 'dashboard';");
const datasetIdx27 = navigateToFnSrc27.indexOf('document.body.dataset.tab = tab;');
assert(redirectIdx27 > -1 && datasetIdx27 > -1 && redirectIdx27 < datasetIdx27,
  'the chat-disabled redirect (tab reassigned to \'dashboard\') runs BEFORE document.body.dataset.tab is set — otherwise a bounce to dashboard would leave the attribute reading "chat" and the header would stay hidden on the wrong page');

// AD-06 on chat: updateSyncBadge() writes BOTH #sync-badge and
// #chat-sync-badge — one function, two targets, cannot drift (CONVENTIONS
// #21). Source-verified for the same DOM-stub reason as above; behaviorally
// verified below via the REAL _chatSyncBadgeHTML()/setChatSyncStatus() pair.
const updateSyncBadgeFnSrc27 = (appJsSrc.match(/function updateSyncBadge\(status\) \{[\s\S]*?\n\}/) || [''])[0];
assert(updateSyncBadgeFnSrc27.length > 0, 'updateSyncBadge() function body located');
assert(/getElementById\('sync-badge'\)/.test(updateSyncBadgeFnSrc27), 'updateSyncBadge() still writes #sync-badge (the header badge)');
assert(/getElementById\('chat-sync-badge'\)/.test(updateSyncBadgeFnSrc27), 'updateSyncBadge() ALSO writes #chat-sync-badge (chat\'s own copy, since .app-header — and #sync-badge with it — is hidden on that tab)');
assert(/setChatSyncStatus\(status\)/.test(updateSyncBadgeFnSrc27), 'updateSyncBadge() calls setChatSyncStatus() so a FRESH renderChatPage() reflects the current status immediately rather than waiting for the next sync event');

assert(typeof chatUi.setChatSyncStatus === 'function', 'chat-ui.js exports setChatSyncStatus');
assert(typeof chatUi._chatSyncBadgeHTML === 'function', 'chat-ui.js exports _chatSyncBadgeHTML (test-only) — exercising the REAL conditional, not just regex-matching template source');
chatUi.setChatSyncStatus(null);
assert(chatUi._chatSyncBadgeHTML() === '<span id="chat-sync-badge" class="sync-badge"></span>',
  'unknown/no status: the badge span exists (beside the BETA badge) but renders no text and no sync-error class');
chatUi.setChatSyncStatus('syncing');
assert(!/sync-error/.test(chatUi._chatSyncBadgeHTML()) && !/Sync error/.test(chatUi._chatSyncBadgeHTML()),
  "'syncing' does not surface text on chat's badge — only 'error' does, so chat chrome stays minimal in the normal case");
chatUi.setChatSyncStatus('synced');
assert(!/sync-error/.test(chatUi._chatSyncBadgeHTML()), "'synced' renders no badge text either");
chatUi.setChatSyncStatus('error');
const errBadge27 = chatUi._chatSyncBadgeHTML();
assert(/id="chat-sync-badge"/.test(errBadge27) && /class="sync-badge sync-error"/.test(errBadge27) && /⚠️ Sync error/.test(errBadge27),
  "'error' status DOES surface on chat's own badge — the hard loud-fail rule (AD-06) holds even with .app-header hidden on this tab");
chatUi.setChatSyncStatus(null);   // reset — don't leak state into any test that runs after this one

// The badge is wired into renderChatPage()'s header row, beside the BETA badge.
assert(/<h2>Chat <span class="badge badge-beta"[^>]*>BETA<\/span> \$\{_chatSyncBadgeHTML\(\)\}<\/h2>/.test(chatUiSrc),
  'renderChatPage() renders _chatSyncBadgeHTML() inline in the <h2>, beside the BETA badge (design input placement)');

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
