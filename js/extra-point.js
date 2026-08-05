/**
 * CFB Pickems — The Ischemic Extra Point (v0.16.0)
 * =================================================
 * Weekly blackjack side contest: each player guesses the LONGEST MADE FIELD
 * GOAL (yards) across this week's slate. Blackjack rules:
 *   - Closest to the actual WITHOUT GOING OVER wins.
 *   - Any guess OVER the actual is a BUST (out entirely).
 *   - Exact hit = BLACKJACK — outright win, beats everything.
 *   - Equal winning guesses share the win (push).
 *   - Everyone busts → no winner ("dealer takes the table").
 *
 * SCOPE DECISION (flag if this should change): "longest FG that week" is scored
 * against THE SLATE, because that's what the app can verify automatically from
 * ESPN per-event data and what every player can watch. Commissioner can always
 * override the actual manually.
 *
 * Auto-detection: ESPN's lightweight scoreboard payload does NOT carry scoring
 * plays, so detection fetches each slate game's SUMMARY endpoint
 * (site.api.espn.com …/summary?event=<id>) and parses scoringPlays entries of
 * type "Field Goal" ("Kicker 43 Yd Field Goal"). Made FGs only — scoringPlays
 * never contains misses. Games without an espnEventId are skipped and reported.
 */

import { getExtraPointGuess } from './storage.js';

// ── Detection ─────────────────────────────────────────────────────────────────

const SUMMARY_ROOT = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary';

async function fetchSummary(eventId) {
  const res = await fetch(`${SUMMARY_ROOT}?event=${encodeURIComponent(eventId)}`);
  if (!res.ok) throw new Error(`ESPN summary HTTP ${res.status}`);
  return res.json();
}

function parseFieldGoals(summary, game) {
  const out = [];
  const plays = summary?.scoringPlays || [];
  for (const p of plays) {
    const typeTxt = String(p?.type?.text || '').toLowerCase();
    const text = String(p?.text || '');
    if (!typeTxt.includes('field goal') && !/yd field goal/i.test(text)) continue;
    const m = text.match(/(\d{1,2})\s*Y(?:ar)?d/i);
    if (!m) continue;
    const yards = parseInt(m[1], 10);
    if (!Number.isFinite(yards) || yards < 15 || yards > 75) continue;  // sanity window
    out.push({
      yards,
      text: text.trim(),
      team: p?.team?.displayName || p?.team?.abbreviation || '',
      gameId: game.gameId,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
    });
  }
  return out;
}

/**
 * Detect the longest made FG across the slate. Returns
 * { ok, best, all, skipped } where best = {yards, text, team, gameId, matchup}.
 * Never throws — per-game failures are collected into `skipped`.
 */
export async function detectLongestFieldGoal(games) {
  const withIds = games.filter(g => g.espnEventId);
  const skipped = games.filter(g => !g.espnEventId)
    .map(g => ({ game: `${g.awayTeam} @ ${g.homeTeam}`, reason: 'no ESPN event id (manual game)' }));
  const all = [];
  const results = await Promise.allSettled(withIds.map(g => fetchSummary(g.espnEventId).then(s => ({ g, s }))));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      all.push(...parseFieldGoals(r.value.s, r.value.g));
    } else {
      const g = withIds[i];
      skipped.push({ game: `${g.awayTeam} @ ${g.homeTeam}`, reason: String(r.reason?.message || r.reason) });
    }
  });
  all.sort((a, b) => b.yards - a.yards);
  return { ok: all.length > 0, best: all[0] || null, all, skipped };
}

// ── Grading (blackjack rules) ─────────────────────────────────────────────────

/**
 * Grade the Extra Point for a week.
 * @param actual  number — the verified longest FG in yards
 * @param entries [{playerId, displayName, guess}] — players WITH a guess
 * @returns { actual, rows:[{playerId,displayName,guess,outcome,delta}], winners:[playerId], allBusted }
 *   outcome: 'blackjack' | 'win' | 'push-win' | 'alive' | 'bust' | 'no-entry'
 */
export function gradeExtraPoint(actual, entries) {
  const rows = entries.map(e => {
    if (e.guess === null || e.guess === undefined || e.guess === '') {
      return { ...e, guess: null, outcome: 'no-entry', delta: null };
    }
    const guess = Number(e.guess);
    if (!Number.isFinite(guess)) return { ...e, guess: null, outcome: 'no-entry', delta: null };
    if (guess > actual) return { ...e, guess, outcome: 'bust', delta: guess - actual };
    return { ...e, guess, outcome: 'alive', delta: actual - guess };
  });
  const alive = rows.filter(r => r.outcome === 'alive');
  let winners = [];
  if (alive.length) {
    const exact = alive.filter(r => r.delta === 0);
    if (exact.length) {
      exact.forEach(r => { r.outcome = 'blackjack'; });
      winners = exact.map(r => r.playerId);
    } else {
      const bestDelta = Math.min(...alive.map(r => r.delta));
      const best = alive.filter(r => r.delta === bestDelta);
      best.forEach(r => { r.outcome = best.length > 1 ? 'push-win' : 'win'; });
      winners = best.map(r => r.playerId);
    }
  }
  rows.sort((a, b) => {
    const rank = { blackjack: 0, win: 1, 'push-win': 1, alive: 2, bust: 3, 'no-entry': 4 };
    return rank[a.outcome] - rank[b.outcome] || (a.delta ?? 99) - (b.delta ?? 99);
  });
  return { actual, rows, winners, allBusted: alive.length === 0 && rows.some(r => r.outcome === 'bust') };
}

/** Convenience: build graded results for a week from storage. */
export function gradeWeekExtraPoint(week, players) {
  if (!week || week.extraPointActual == null) return null;
  const entries = players.map(p => ({
    playerId: p.playerId, displayName: p.displayName,
    guess: getExtraPointGuess(week.weekId, p.playerId),
  }));
  return gradeExtraPoint(Number(week.extraPointActual), entries);
}

// ── Display helpers ───────────────────────────────────────────────────────────

export const EP_OUTCOME_LABEL = {
  blackjack: '🂡 BLACKJACK', win: '✅ Wins', 'push-win': '🤝 Push (shared win)',
  alive: 'Under', bust: '💥 BUST', 'no-entry': '— no entry',
};

export function renderExtraPointResultsHTML(week, graded, escHtml) {
  if (!graded) return '';
  const rowsHtml = graded.rows.map(r => `
    <div class="ep-row ep-${r.outcome}">
      <span class="ep-name">${escHtml(r.displayName)}</span>
      <span class="ep-guess">${r.guess == null ? '—' : r.guess + ' yd'}</span>
      <span class="ep-outcome">${EP_OUTCOME_LABEL[r.outcome] || r.outcome}${r.outcome === 'alive' || r.outcome === 'win' || r.outcome === 'push-win' ? ` (−${r.delta})` : ''}${r.outcome === 'bust' ? ` (+${r.delta})` : ''}</span>
    </div>`).join('');
  const detect = week.extraPointDetect;
  return `
    <div class="card mb-md ep-card">
      <h3 class="ep-title">🎯 The Ischemic Extra Point</h3>
      <div class="ep-actual">Longest FG this week: <strong>${graded.actual} yards</strong>
        ${detect ? `<div class="text-muted text-xs">${escHtml(detect.text || '')} — ${escHtml(detect.matchup || '')}</div>` : ''}
      </div>
      ${rowsHtml}
      ${graded.allBusted ? '<div class="ep-house">Everyone busted. The house wins. The house is the chart.</div>' : ''}
      <div class="text-muted text-xs mt-sm">Blackjack rules: closest without going over. Over = bust. Exact = blackjack.</div>
    </div>`;
}
