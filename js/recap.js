/**
 * CFB Pickems — Recap & Summary (v0.16.0)
 * ========================================
 * Two picks-page sections rendered BELOW the games list:
 *   1. renderPrevWeekRecapHTML(currentWeek)  — analysis of the most recent
 *      FINALIZED week before this one (winner, records, lone-wolf covers,
 *      unanimous busts, tiebreaker, Extra Point, standings movement).
 *   2. renderSeasonSummaryHTML(currentWeek)  — shown on Week 1 (no prior
 *      finalized week in the current season): summarizes the PRIOR season from
 *      whatever finalized data exists, plus a commissioner-editable blurb
 *      (settings.seasonRecapText) for lore the data can't compute (CFP 2K25).
 *
 * Pure read-side: computes from storage; no writes.
 */

import {
  getWeeks, getPlayers, getWeeklyResults, getGames, getPicks, getSettings,
} from './storage.js';
import { calculateSeasonStandings, calculateAtsWinner } from './scoring.js';
import { formatWeekLabel } from './data-model.js';
import { gradeWeekExtraPoint } from './extra-point.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Most recent finalized, history-visible week strictly before `week` (same season first). */
export function findPreviousFinalizedWeek(week) {
  const weeks = getWeeks().filter(w =>
    w.status === 'final' && w.showInHistory !== false && w.weekId !== week?.weekId);
  if (!weeks.length) return null;
  const sameSeason = weeks
    .filter(w => w.season === week?.season && (week ? w.weekNumber < week.weekNumber : true))
    .sort((a, b) => b.weekNumber - a.weekNumber);
  return sameSeason[0] || null;
}

/** Storyline extraction for one finalized week. */
export function buildWeekStorylines(week) {
  const players = getPlayers().filter(p => p.active !== false);
  const results = getWeeklyResults(week.weekId);
  const games = getGames(week.weekId);
  const picks = getPicks(week.weekId);
  if (!results.length) return null;

  const nameOf = id => players.find(p => p.playerId === id)?.displayName || id;
  const ranked = [...results].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const winner = ranked[0];
  const loser = ranked[ranked.length - 1];

  // Per-game analysis: lone wolves + unanimous busts
  const loneWolves = [];
  const unanimousBusts = [];
  for (const g of games) {
    const ats = g.atsWinner ?? calculateAtsWinner(g);
    if (!ats || ats === 'no_decision') continue;
    const gp = picks.filter(p => p.gameId === g.gameId);
    if (gp.length < 2) continue;
    const right = gp.filter(p => p.selectedTeam === ats);
    if (right.length === 1 && gp.length >= 4) {
      loneWolves.push({ name: nameOf(right[0].playerId), team: ats, matchup: `${g.awayTeam} @ ${g.homeTeam}` });
    }
    if (right.length === 0 && gp.length >= 4) {
      const side = gp[0].selectedTeam;
      if (gp.every(p => p.selectedTeam === side)) {
        unanimousBusts.push({ team: side, matchup: `${g.awayTeam} @ ${g.homeTeam}` });
      }
    }
  }

  const ep = gradeWeekExtraPoint(week, players);

  return { week, players, results: ranked, winner, loser, loneWolves, unanimousBusts,
           nameOf, extraPoint: ep, tiebreakerActual: week.actualTiebreakerValue };
}

export function renderPrevWeekRecapHTML(currentWeek) {
  const prev = findPreviousFinalizedWeek(currentWeek);
  if (!prev) return '';
  return renderWeekRecapCardHTML(prev);
}

/** SCRIBE "Chart Review" card for one finalized week (also used by the
 *  read-only historical picks view). */
export function renderWeekRecapCardHTML(prev) {
  const s = buildWeekStorylines(prev);
  if (!s) return '';

  const lines = [];
  lines.push(`<div class="recap-line recap-winner">🏆 <strong>${esc(s.nameOf(s.winner.playerId))}</strong> took ${esc(formatWeekLabel(prev))} — ${s.winner.correctPicks ?? s.winner.points ?? '?'} correct${s.winner.wonTiebreaker ? ' (won on the tiebreaker)' : ''}.</div>`);
  if (s.loser && s.loser.playerId !== s.winner.playerId) {
    lines.push(`<div class="recap-line">🥶 <strong>${esc(s.nameOf(s.loser.playerId))}</strong> brought up the rear. The chart has been updated accordingly.</div>`);
  }
  s.loneWolves.slice(0, 2).forEach(lw => {
    lines.push(`<div class="recap-line">🐺 Lone wolf: <strong>${esc(lw.name)}</strong> stood alone on ${esc(lw.team)} (${esc(lw.matchup)}) — and covered.</div>`);
  });
  s.unanimousBusts.slice(0, 2).forEach(ub => {
    lines.push(`<div class="recap-line">💀 Unanimous bust: everyone took ${esc(ub.team)} (${esc(ub.matchup)}). Everyone was wrong.</div>`);
  });
  if (s.tiebreakerActual != null) {
    lines.push(`<div class="recap-line">🎯 Tiebreaker actual: <strong>${esc(s.tiebreakerActual)}</strong>.</div>`);
  }
  if (s.extraPoint) {
    const winners = s.extraPoint.rows.filter(r => ['blackjack', 'win', 'push-win'].includes(r.outcome));
    const busts = s.extraPoint.rows.filter(r => r.outcome === 'bust');
    if (winners.length) lines.push(`<div class="recap-line">🂡 Extra Point (longest FG ${s.extraPoint.actual} yd): <strong>${esc(winners.map(w => w.displayName).join(' & '))}</strong> ${winners[0].outcome === 'blackjack' ? 'hit BLACKJACK' : 'held the table'}${busts.length ? `; ${esc(busts.map(b => b.displayName).join(', '))} busted` : ''}.</div>`);
    else if (s.extraPoint.allBusted) lines.push(`<div class="recap-line">🂡 Extra Point: the entire cohort busted. The house thanks you.</div>`);
  }

  // Standings context after that week
  const season = prev.season;
  const seasonResults = getWeeklyResults().filter(r => {
    const w = getWeeks().find(x => x.weekId === r.weekId);
    return w && w.season === season && w.status === 'final' && w.showInHistory !== false && w.weekNumber <= prev.weekNumber;
  });
  const standings = calculateSeasonStandings(s.players, seasonResults);
  if (standings?.length) {
    const top = standings[0];
    lines.push(`<div class="recap-line">📈 Season chart after ${esc(formatWeekLabel(prev))}: <strong>${esc(s.nameOf(top.playerId))}</strong> leads.</div>`);
  }

  return `
    <div class="card mb-md recap-card">
      <div class="recap-header">
        <h3>📋 Chart Review — ${esc(formatWeekLabel(prev))}</h3>
        <span class="recap-byline">filed by S.C.R.I.B.E.</span>
      </div>
      ${lines.join('')}
      <div class="recap-closer">Filed. — SCRIBE</div>
    </div>`;
}

/**
 * Prior-season summary — rendered on Week 1 of a season (i.e. when no previous
 * finalized week exists IN THIS SEASON). Combines computed prior-season data
 * (when present in storage) with the commissioner's freeform blurb.
 */
export function renderSeasonSummaryHTML(currentWeek) {
  if (!currentWeek) return '';
  const season = currentWeek.season;
  const priorWeeks = getWeeks().filter(w =>
    w.season !== season && w.status === 'final' && w.showInHistory !== false);
  const blurb = (getSettings().seasonRecapText || '').trim();
  if (!priorWeeks.length && !blurb) return '';

  let computed = '';
  if (priorWeeks.length) {
    const players = getPlayers().filter(p => p.active !== false);
    const priorIds = new Set(priorWeeks.map(w => w.weekId));
    const priorResults = getWeeklyResults().filter(r => priorIds.has(r.weekId));
    const standings = calculateSeasonStandings(players, priorResults);
    const priorSeason = priorWeeks[0].season;
    if (standings?.length) {
      const nameOf = id => players.find(p => p.playerId === id)?.displayName || id;
      computed = `
        <div class="recap-line">👑 <strong>${esc(nameOf(standings[0].playerId))}</strong> — Champion of record, CFP 2K${String(priorSeason).slice(-2)}.</div>
        ${standings.slice(0, 6).map((s2, i) =>
          `<div class="recap-line recap-standing"><span class="recap-rank">${i + 1}.</span> ${esc(nameOf(s2.playerId))} — ${s2.totalCorrect ?? s2.totalPoints ?? 0} correct over ${priorWeeks.length} week${priorWeeks.length > 1 ? 's' : ''}</div>`
        ).join('')}`;
    }
  }

  return `
    <div class="card mb-md recap-card recap-season">
      <div class="recap-header">
        <h3>📜 The Permanent Record — Last Season</h3>
        <span class="recap-byline">retrieved by S.C.R.I.B.E.</span>
      </div>
      ${computed}
      ${blurb ? `<div class="recap-blurb">${esc(blurb).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="recap-closer">Noted for the permanent record. — SCRIBE</div>
    </div>`;
}

/** The picks-page footer block: recap when available, season summary on week 1. */
export function renderPicksFooterHTML(currentWeek) {
  const recap = renderPrevWeekRecapHTML(currentWeek);
  if (recap) return recap;
  return renderSeasonSummaryHTML(currentWeek);
}
