/**
 * history-2025.js — CFP 2K25 season of record (v0.17.0)
 * ======================================================
 * Extracted from the audited "Full Season Post-Mortem" (corrected numbers —
 * the Week 7 / Week 8 grading errors are already applied here). This dataset
 * powers three surfaces with zero commissioner input:
 *   1. The Week-1 "Permanent Record" recap on the Picks tab
 *   2. The Historical Record section on the Standings tab
 *   3. Last year's outstanding drink obligations (carried into 2K26 unpaid)
 *
 * RG-05 note: these numbers come from the explicit-winner audit, NOT the cell
 * colors. Every weekly debt below cross-checks against the corrected
 * winner/loser table.
 */

export const SEASON_2025 = {
  season: '2025',
  label: 'CFP 2K25',
  champion: { playerId: 'p6', name: 'Kihoon', points: 103, note: 'three clear of Jacob' },

  // Final standings — corrected. Reg = weeks 1–14; multipliers: Conf ×2,
  // Bowls ×1, CFP R1 ×2, QF ×2, Semis ×3 (title game never played).
  standings: [
    { rank: 1, playerId: 'p6', name: 'Kihoon',  alias: 'May as well be a Medical Student', reg: 73, extraPt: 2,  conf: 10, bowls: 11, cfpR1: 2, cfpQF: 2, semis: 3,     total: 103 },
    { rank: 2, playerId: 'p5', name: 'Jacob',   alias: 'Night Shift Energy',               reg: 70, extraPt: 4,  conf: 10, bowls: 10, cfpR1: 4, cfpQF: 2, semis: null,  total: 100 },
    { rank: 3, playerId: 'p4', name: 'Koby',    alias: 'Tik Tok',                          reg: 72, extraPt: 3,  conf: 6,  bowls: 7,  cfpR1: 2, cfpQF: 2, semis: 3,     total: 95 },
    { rank: 4, playerId: 'p1', name: 'Drew',    alias: 'Supreme Leader',                   reg: 66, extraPt: 1,  conf: 12, bowls: 4,  cfpR1: 4, cfpQF: 2, semis: 3,     total: 92 },
    { rank: 5, playerId: 'p3', name: 'Kevin',   alias: 'Medical Student',                  reg: 69, extraPt: -1, conf: 8,  bowls: 5,  cfpR1: 0, cfpQF: 2, semis: 6,     total: 89 },
    { rank: 6, playerId: 'p2', name: 'Brayden', alias: 'Cutie Patootie',                   reg: 69, extraPt: 2,  conf: 0,  bowls: 8,  cfpR1: 0, cfpQF: 2, semis: 3,     total: 84 },
  ],

  // Week-by-week matrix (corrected), regular season 1–14.
  weeklyScores: {
    Kevin:   [4, 5, 2, 4, 3, 5, 7, 5, 5, 6, 5, 5, 9, 4],
    Koby:    [5, 6, 4, 4, 5, 5, 6, 6, 5, 4, 6, 5, 9, 2],
    Brayden: [7, 7, 6, 5, 6, 2, 6, 3, 3, 6, 5, 5, 5, 3],
    Drew:    [5, 7, 7, 5, 5, 4, 4, 4, 5, 3, 5, 3, 5, 4],
    Jacob:   [6, 6, 5, 6, 6, 3, 6, 4, 6, 4, 6, 4, 3, 5],
    Kihoon:  [5, 5, 4, 3, 3, 6, 6, 5, 8, 7, 6, 6, 6, 3],
  },

  // Weekly winners/losers → the drink each week generated (corrected: Wk 7 & 8
  // changed hands in the audit).
  weeklyDrinks: [
    { week: 1,  from: 'Kevin',   to: 'Brayden' },
    { week: 2,  from: 'Kihoon',  to: 'Brayden' },
    { week: 3,  from: 'Kevin',   to: 'Drew' },
    { week: 4,  from: 'Kihoon',  to: 'Jacob' },
    { week: 5,  from: 'Kevin',   to: 'Brayden' },
    { week: 6,  from: 'Brayden', to: 'Kihoon' },
    { week: 7,  from: 'Drew',    to: 'Kevin',  note: 'changed in the audit — Kevin wins Wk 7 outright' },
    { week: 8,  from: 'Brayden', to: 'Koby',   note: 'changed in the audit — Koby wins Wk 8 outright' },
    { week: 9,  from: 'Brayden', to: 'Kihoon' },
    { week: 10, from: 'Drew',    to: 'Kihoon' },
    { week: 11, from: 'Kevin',   to: 'Kihoon' },
    { week: 12, from: 'Drew',    to: 'Kihoon' },
    { week: 13, from: 'Jacob',   to: 'Koby' },
    { week: 14, from: 'Koby',    to: 'Jacob' },
  ],

  // Commissioner-fiat bonus per the report ("I do, actually, make the rules"):
  bonusDrinks: [
    { from: 'Brayden', to: 'Kihoon', reason: '0-for-10 championship-week slate penalty' },
  ],

  extraPointTotals: { Jacob: 4, Koby: 3, Brayden: 2, Kihoon: 2, Drew: 1, Kevin: -1 },

  superlatives: [
    { label: 'Best week',            value: 'Kevin & Koby — 9/10 (Week 13)' },
    { label: 'Worst slate on record', value: 'Brayden — 0/10, championship week' },
    { label: 'Most weekly wins',      value: 'Kihoon (5)' },
    { label: 'Most weekly losses',    value: 'Kevin, Brayden, Drew (3 each)' },
    { label: 'Steadiest hand',        value: 'Jacob (volatility 1.10)' },
    { label: 'Wildest swings',        value: 'Kevin (1.58)' },
    { label: 'Biggest chalk-eater',   value: 'Kevin — 80% favourites' },
    { label: 'House contrarian',      value: 'Drew — 56% favourites, 12 lone-wolf calls' },
    { label: 'Unanimous games',       value: 'Only 21% (30 of 140) — we agree on nothing' },
  ],

  notes: [
    'Two grading errors found and corrected in the full audit (Wk 7 ALA/MIZZ, Wk 8 UGA/Ole Miss) — both weekly winners changed.',
    'The title game (×5) was never played; no picks were collected.',
    'All drink debts are payable IN PERSON. No exceptions.',
  ],
};

/** Deterministic obligation records for the 2K25 carryover ledger. */
export function season2025Obligations() {
  const nameToId = { Drew: 'p1', Brayden: 'p2', Kevin: 'p3', Koby: 'p4', Jacob: 'p5', Kihoon: 'p6' };
  const rows = SEASON_2025.weeklyDrinks.map(d => ({
    obligationId: `ob_2025_wk${d.week}`,
    season: '2025',
    weekId: null,
    weekLabel: `2K25 Wk ${d.week}`,
    type: 'weekly',
    payerPlayerId: nameToId[d.from], payerName: d.from,
    recipientPlayerId: nameToId[d.to], recipientName: d.to,
    prize: '1 drink',
    status: 'unpaid',
    note: d.note || '',
  }));
  SEASON_2025.bonusDrinks.forEach((d, i) => rows.push({
    obligationId: `ob_2025_bonus${i + 1}`,
    season: '2025', weekId: null, weekLabel: '2K25 bonus',
    type: 'bonus',
    payerPlayerId: nameToId[d.from], payerName: d.from,
    recipientPlayerId: nameToId[d.to], recipientName: d.to,
    prize: '1 drink', status: 'unpaid', note: d.reason,
  }));
  return rows;
}

/**
 * v0.17.3 — normalize a `settings.ob2025` map entry to a status string.
 *
 * BACKWARD COMPATIBILITY, read this before touching it: before this batch the
 * map was BOOLEAN-only (`{ [obligationId]: true }` = paid, absent = unpaid).
 * The debt-approval feature (UN-89) needs a third state ('pending'), so the
 * map becomes a status map going forward — but every device that already
 * marked a 2K25 drink paid has a literal `true` sitting in the Sheet right
 * now. A legacy `true` MUST still resolve to 'paid', or those already-settled
 * drinks silently revert to unpaid the moment this ships. That is the single
 * most dangerous line in this feature — get it wrong and six people who
 * already paid up get billed again.
 */
export function ob2025Status(map, obligationId) {
  const v = (map || {})[obligationId];
  if (v === true) return 'paid';                     // legacy boolean (pre-v0.17.3)
  if (v === 'paid' || v === 'pending') return v;
  return 'unpaid';                                    // absent, false, or anything unrecognized
}

/** Net drink position for the season (for the ledger summary line). */
export function season2025Nets() {
  const nets = {};
  const bumpNet = (name, delta) => { nets[name] = (nets[name] || 0) + delta; };
  SEASON_2025.weeklyDrinks.forEach(d => { bumpNet(d.from, -1); bumpNet(d.to, 1); });
  return nets;
}
