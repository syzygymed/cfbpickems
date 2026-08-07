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
assert(/SCRIBE on duty/.test(uiCode), 'UN-67: SCRIBE "on duty" framing survives presence removal');

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

assert(/<h2>Chat<\/h2>/.test(chatUiSrc), 'chat page header reads "Chat"');
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

assert(!/const QUICK_EMOJI = \[/.test(chatUiSrc),
  'chat-ui.js QUICK_EMOJI is DERIVED, not an independent literal array (the exact defect class AD-20 forbids)');
assert(/const QUICK_EMOJI = REACTION_PALETTE\.slice\(/.test(chatUiSrc),
  'chat-ui.js QUICK_EMOJI derives from the shared REACTION_PALETTE');
assert(!/const REACTION_PALETTE = \[/.test(appJsSrc),
  'app.js no longer carries its own REACTION_PALETTE literal — the second-mapping defect class (AD-20, RG-13)');
const appImportBlock = appJsSrc.match(/^import \{[\s\S]*?\} from '\.\/data-model\.js';/m)?.[0] || '';
assert(/\bREACTION_PALETTE\b/.test(appImportBlock),
  'app.js imports REACTION_PALETTE from data-model.js rather than defining its own');

// Chat's set is a superset-of-or-equal-to the game-reaction set BY
// CONSTRUCTION (both read the identical array object) — assert that
// construction rather than trusting a coincidental match.
const quickEmojiSliceMatch = chatUiSrc.match(/REACTION_PALETTE\.slice\((\d+),\s*(\d+)\)/);
assert(!!quickEmojiSliceMatch, 'QUICK_EMOJI slice bounds are readable from source');
if (quickEmojiSliceMatch) {
  const [, from, to] = quickEmojiSliceMatch;
  const derivedQuick = dm.REACTION_PALETTE.slice(Number(from), Number(to));
  assert(derivedQuick.length > 0 && derivedQuick.every(e => dm.REACTION_PALETTE.includes(e)),
    'every QUICK_EMOJI entry is a member of the shared REACTION_PALETTE');
}

// The full picker (item G's "picker layout" requirement) reuses the EXISTING
// grid CSS verbatim (app.js's dashboard reaction picker already solved
// 5×3 desktop / 7×3 mobile at 42-44px targets) rather than inventing a
// second layout — the v0.15.1 picker shipped at ~22×22px and had to be
// rebuilt once already.
assert(/picker\.className = 'reaction-picker'/.test(chatUiSrc),
  'the composer\'s "more emoji" picker reuses the .reaction-picker class verbatim');
assert(/class="reaction-pick-option"/.test(chatUiSrc),
  'the composer\'s emoji options reuse the .reaction-pick-option class verbatim');
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

const moreRule = (cssFix.match(/\.chat-emoji-more\{[^}]*\}/) || [''])[0];
const moreMin = (moreRule.match(/min-height:\s*(\d+)px/) || [])[1];
assert(Number(moreMin) >= 40,
  `"more emoji" tap target >= 40px (CONVENTIONS #17) — got ${moreMin || 'none'}`);
assert(/\.chat-composer-foot \.reaction-picker\{[^}]*bottom:\s*100%/.test(cssFix),
  'emoji picker opens UPWARD from the composer foot (downward is off-screen behind the nav)');

// The fifth surface item A missed: title + PWA icon badge must clear when chat
// is off, or a player chases a badge they cannot clear.
const chatUiFix = await readFile(new URL('./js/chat-ui.js', import.meta.url), 'utf8');
const badgesFn = (chatUiFix.match(/export function updateChatBadges[\s\S]*?\n}/) || [''])[0];
assert(/isChatEnabled\(\)/.test(badgesFn),
  'updateChatBadges is gated on isChatEnabled (clears title + PWA badge when off)');

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
