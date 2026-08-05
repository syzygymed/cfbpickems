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
  createElement: () => ({ ...({}), set innerHTML(v) {}, get innerHTML() { return ''; }, appendChild() {}, remove() {}, classList: { add() {}, remove() {} }, style: {}, id: '', className: '' }),
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

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
