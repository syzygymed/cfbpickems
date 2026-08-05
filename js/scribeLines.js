/**
 * CFB Pickems — S.C.R.I.B.E. Tier 0 (deterministic) — v0.16.0
 * ============================================================
 * Spread Coverage Records & Ischemic Banter Engine.
 *
 * Canned-line engine governed by PICKEMS_BOT_VOICE_PROFILE_2.md. No API calls.
 * Voice constraints enforced IN THE POOLS (do not drift):
 *   - deadpan, clinical, chart-note register
 *   - standings = "the chart", picks = "orders", busts = "adverse events",
 *     drink debts = "outstanding balances"
 *   - openers: "SCRIBE NOTE:", "Chart review, gentlemen."  closers: "Filed.", "— SCRIBE"
 *   - profanity rare and surgical (max ONE instance per pool)
 *   - almost no ALL CAPS — restraint is the bit
 *   - savage about football, never about real life
 *
 * RATE LIMITS DEFINE THE CHARACTER:
 *   - max 1 SCRIBE message / 10 min in general
 *   - max 1 SCRIBE message / hour per game channel
 *   - no line reused within 14 days (used-line ledger, device-local)
 *   - a rate-limited trigger is DROPPED, never queued
 *
 * EXACTLY-ONCE ACROSS SIX CLIENTS: every SCRIBE message id is deterministic —
 * `scribe_<trigger>_<subject>_<timeBucket>` — so when all six devices detect the
 * same trigger simultaneously, the server's id-dedupe collapses them to one row.
 */

import { sendEvent } from './chat.js';

const LEDGER_KEY = 'cfbp_scribe_ledger';   // { lineHash: lastUsedMs }
const LAST_POST_KEY = 'cfbp_scribe_lastpost'; // { rateKey: lastMs } ('' = main room, gameId = per-game)
const REUSE_WINDOW_MS = 14 * 24 * 3600 * 1000;
const GENERAL_COOLDOWN = 10 * 60 * 1000;
const GAME_COOLDOWN = 60 * 60 * 1000;

// ── Line pools ────────────────────────────────────────────────────────────────
// {NAME} = display name of the subject player. {N} = a number when supplied.
export const SCRIBE_POOLS = {
  // ── v0.17.0: live-game observations (fed by the score poll) ──
  coverageFlip: [
    'SCRIBE NOTE: the number just changed sides. Adjust your blood pressure accordingly.',
    'Coverage status has flipped. The chart is watching. So should you.',
    'Live update: the spread and the scoreboard have exchanged positions. Documented.',
    'Mid-game reversal noted. Several orders now in jeopardy. Filed.',
    'The cover has changed hands. No further comment at this time.',
  ],
  upsetWatch: [
    'SCRIBE NOTE: the underdog is not cooperating with your orders, gentlemen.',
    'Upset conditions developing. The chart advises hydration.',
    'The favorite is experiencing complications. Monitoring.',
    'Documented at this time: {TEAM} did not read the number.',
    'Adverse conditions on the field. Several charts affected. Filed.',
  ],
  callout: [
    'Adverse event. Prior statement available for review.',
    'The record reflects an earlier confidence. The scoreboard reflects otherwise.',
    'For completeness, attaching the pre-game assessment to the post-game outcome.',
    'Chart correlation complete: statement, then result. Filed without commentary.',
    'One prior note is now clinically relevant. Presented as documented.',
  ],
  anniversary: [
    'One year ago today, this was entered into the record. It remains there.',
    'SCRIBE NOTE: annual chart review surfaced the following prior entry.',
    'The permanent record observes an anniversary. Presented as filed.',
    'Twelve months of documentation later, this entry stands unamended.',
  ],
  silence: [
    'Chart is quiet. Unusual.',
    'No entries in some time. The record notes the silence.',
    'SCRIBE NOTE: vitals steady, room quiet. Documented.',
    'The log has been idle. The standings have not moved either, for those wondering.',
  ],
  mention: [
    'Chart review, gentlemen. The answer is in the standings.',
    'SCRIBE NOTE: I document. I do not consult. Filed.',
    'Per my last note, the chart is current and the chart is public. — SCRIBE',
    'Noted. The permanent record reflects your inquiry, {NAME}.',
    'This encounter has been documented. Direct further questions to the chart.',
    'I keep the receipts, {NAME}. I do not issue predictions.',
    'SCRIBE NOTE: query received. Assessment: the standings speak. Plan: none.',
  ],
  backdoorBust: [
    'Adverse event logged. Late-game complication.',
    'SCRIBE NOTE: {NAME} experienced a backdoor cover. Documented without comment.',
    'Adverse Event Report — mechanism: garbage time. Patient: {NAME}. Prognosis: unchanged.',
    'The chart notes a terminal-minute decompensation for {NAME}. Filed.',
    'Order busted at the gun. This encounter has been documented.',
    'Assessment: covered for 59 minutes. Plan: continue current management. — SCRIBE',
  ],
  lastPlaceTaunt: [
    'Noting the confidence. Noting the position on the chart.',
    'SCRIBE NOTE: bold statement from the lower quadrant of the chart. Filed.',
    'The chart has been consulted. The chart does not support the tone, {NAME}.',
    'Documented at this time, for the record: {NAME} is talking. The chart is also talking.',
    'Per my last note, standing on the chart is earned, not announced. — SCRIBE',
    'This is a learning opportunity, {NAME}.',
  ],
  buzzerOrders: [
    'Orders received at the buzzer. Filed.',
    'SCRIBE NOTE: {NAME} submitted orders with {N} minutes to spare. Documented.',
    'Late orders noted. The chart does not award style points for urgency.',
    'Orders in under the wire. This encounter has been documented. — SCRIBE',
    'Timestamp preserved for the permanent record, {NAME}. It is not flattering.',
    'Received. Reviewed. Filed. Next time, gentlemen, consider daylight.',
  ],
  verbosity: [
    'The chart notes elevated verbosity.',
    'SCRIBE NOTE: {NAME} has posted {N} times in two minutes. Vitals otherwise stable.',
    'Output volume documented. Signal-to-noise assessment withheld. — SCRIBE',
    'Per my last note, brevity is also a skill, {NAME}. Filed.',
    'Elevated message frequency observed. Monitoring. No intervention indicated.',
    'The cohort is advised that {NAME} is typing. Still. Noted for the permanent record.',
  ],
  drinkDebt: [
    'Outstanding balance remains open. — SCRIBE',
    'SCRIBE NOTE: an outstanding balance has been referenced. Payment accepted in person only, per league bylaw.',
    'The ledger is current. The ledger is patient. The ledger forgets nothing.',
    'Balance noted. Interest accrues in humiliation, not currency. Filed.',
    'Per league bylaw: outstanding balances are settled in person. The committee has been notified.',
    'Documented. The billing department (me) thanks you for your attention to this matter.',
  ],
  unanimous: [
    'SCRIBE NOTE: unanimous orders detected this week. Historical hit rate of unanimous orders: unfavorable. Filed.',
    'Second Opinion: the cohort agrees. The cohort has agreed before. Noted for the permanent record.',
    'Six identical orders received. I will simply leave the all-time record here. — SCRIBE',
    'Unanimity documented. Confidence is not a diagnosis, gentlemen.',
    'The chart notes full consensus. The chart also has a long memory.',
  ],
  loneWolfWin: [
    'SCRIBE NOTE: lone order on the winning side. {NAME} stands alone, correctly. Filed.',
    'One dissent. One cover. The permanent record credits {NAME}. — SCRIBE',
    'Against the cohort, with the spread. Documented with something adjacent to respect, {NAME}.',
    'Adverse event for five. Routine documentation for {NAME}.',
    'The chart notes a solo cover. The cohort is invited to review its process.',
  ],
  chartLeadChange: [
    'Chart review, gentlemen. New name at the top. Documented.',
    'SCRIBE NOTE: leadership of the chart has changed hands. The chart remains open. I remain.',
    'Lead change filed. Previous occupant is invited to reread their own proclamations. — SCRIBE',
    'The top line of the chart has a new author. Noted for the permanent record.',
    'Standings updated. The throne is drafty this time of year. Filed.',
  ],
  extraPointBust: [
    'Adverse Event Report — Extra Point. Assessment: {NAME} went over. Plan: none. Prognosis: thirsty.',
    'SCRIBE NOTE: {NAME} busted the Extra Point. Blackjack rules were posted. Reading them was optional, apparently.',
    'Bust documented. The house (the chart) thanks you for your donation, {NAME}.',
    'Over the number. Off the table. Filed. — SCRIBE',
    'Extra Point adverse event logged for {NAME}. Restraint, gentlemen, is also a strategy.',
  ],
  extraPointWin: [
    'SCRIBE NOTE: Extra Point resolved. {NAME} holds. The chart credits the discipline. Filed.',
    'Closest without going over: {NAME}. Blackjack rules honored. Documented.',
    'Extra Point settled. {NAME} read the table correctly. — SCRIBE',
    'The Extra Point has a winner. The Extra Point also has casualties. Both are in the chart.',
  ],
};

// ── Rate limiting + no-repeat ledger ─────────────────────────────────────────
function ledger() { try { return JSON.parse(localStorage.getItem(LEDGER_KEY) || '{}'); } catch { return {}; } }
function saveLedger(l) { try { localStorage.setItem(LEDGER_KEY, JSON.stringify(l)); } catch {} }
function lastPosts() { try { return JSON.parse(localStorage.getItem(LAST_POST_KEY) || '{}'); } catch { return {}; } }
function saveLastPosts(l) { try { localStorage.setItem(LAST_POST_KEY, JSON.stringify(l)); } catch {} }

function hashLine(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return 'h' + (h >>> 0).toString(36); }

function rateLimited(gameTag) {
  const lp = lastPosts();
  const key = gameTag || 'main';
  const cooldown = gameTag ? GAME_COOLDOWN : GENERAL_COOLDOWN;
  return Date.now() - (lp[key] || 0) < cooldown;
}
function noteRate(gameTag) { const lp = lastPosts(); lp[gameTag || 'main'] = Date.now(); saveLastPosts(lp); }

function pickLine(poolKey, vars = {}) {
  const pool = SCRIBE_POOLS[poolKey] || [];
  const led = ledger();
  const now = Date.now();
  const fresh = pool.filter(l => (now - (led[hashLine(l)] || 0)) > REUSE_WINDOW_MS);
  if (!fresh.length) return null;   // whole pool burned within 14 days → stay silent
  // Deterministic-ish selection keyed to the day so simultaneous clients pick
  // the same line (their ids collide anyway; this keeps the *content* identical).
  const dayKey = Math.floor(now / 86400000);
  const line = fresh[dayKey % fresh.length];
  const led2 = ledger(); led2[hashLine(line)] = now; saveLedger(led2);
  return line.replace(/\{NAME\}/g, vars.name || 'gentlemen')
             .replace(/\{N\}/g, vars.n != null ? String(vars.n) : 'several');
}

/** Time bucket for deterministic ids (10-minute granularity). */
function bucket(ms = Date.now(), sizeMin = 10) { return Math.floor(ms / (sizeMin * 60000)); }

/**
 * Fire a SCRIBE trigger. Silently drops when rate-limited or the pool is spent.
 * `trigger`: key of SCRIBE_POOLS. `subject`: stable string identifying the event
 * (playerId, gameId…) — part of the deterministic id so six clients dedupe.
 */
export function scribeTrigger(trigger, { gameTag = '', subject = '', vars = {}, bucketMin = 10, notify = false, quote = null } = {}) {
  if (!SCRIBE_POOLS[trigger]) return false;
  // Direct-mention replies bypass the rate limit (spec); everything else is
  // rationed — the restraint IS the character.
  const direct = trigger === 'mention';
  if (!direct && rateLimited(gameTag)) return false;   // dropped, not queued
  const line = pickLine(trigger, vars);
  if (!line) return false;
  const id = `scribe_${trigger}_${subject || 'x'}_${bucket(Date.now(), bucketMin)}`
    .replace(/[^a-zA-Z0-9_:-]/g, '');
  sendEvent({ type: 'message', gameTag, body: line, author: 'scribe', id,
              notify: direct || notify,
              meta: { source: 'tier0', trigger, ...(quote ? { quote } : {}) } });
  if (!direct) noteRate(gameTag);
  return true;
}

// ── Message-driven trigger detection ─────────────────────────────────────────
// Called by chat-ui after a HUMAN message is sent. Keeps detection cheap and
// entirely deterministic.

const recentByAuthor = new Map();  // author -> [timestamps]

export function scribeInspectMessage({ author, authorName, body, gameTag = '', standings = null }) {
  const low = (body || '').toLowerCase();

  // 1. Direct @scribe mention with a question
  if (low.includes('@scribe')) {
    return scribeTrigger('mention', { gameTag, subject: author, vars: { name: authorName } });
  }
  // 2. Drink debt vocabulary
  if (/\bdrink|owes?\b|\bbalance|\bbeer|\bsapporo\b/.test(low)) {
    return scribeTrigger('drinkDebt', { gameTag, subject: 'debt' });
  }
  // 3. Verbosity: >5 messages from one author in 2 minutes
  const now = Date.now();
  const arr = (recentByAuthor.get(author) || []).filter(t => now - t < 120000);
  arr.push(now); recentByAuthor.set(author, arr);
  if (arr.length > 5) {
    recentByAuthor.set(author, []);   // reset so it doesn't refire per message
    return scribeTrigger('verbosity', { gameTag, subject: author, vars: { name: authorName, n: arr.length } });
  }
  // 4. Last place taunting first place (needs standings context)
  if (standings && standings.lastPlaceId === author && standings.firstPlaceName &&
      low.includes(standings.firstPlaceName.toLowerCase())) {
    return scribeTrigger('lastPlaceTaunt', { gameTag, subject: author, vars: { name: authorName } });
  }
  return false;
}
