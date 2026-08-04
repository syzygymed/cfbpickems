/**
 * CFB Pickems — Data Provider v9
 *
 * Changes (v9):
 *  - Extract school (location/shortDisplayName) and mascot (team.name) separately
 *  - homeTeam/awayTeam now stores school name (cleaner, matches alma mater patterns)
 *  - homeMascot/awayMascot stored for "School (Mascot)" display format
 *  - extractSpread now matches against the school name reliably
 *
 * Carried over from v8:
 *  - Kickoff time validation (confirmed/date-only/TBD)
 *  - Venue parsing — city/state or city/country
 *  - Date-range filtering
 *  - Multi-day fetchByDateRange merging
 */

import { ALMA_MATERS, TIME_WINDOW, GAME_STATUS, DATA_QUALITY, DATA_SOURCE_MODE, createGame, getAlmaMaterMatch, ESPN_SPORT_ENDPOINTS, espnSportPath } from './data-model.js';

const ESPN_API_ROOT = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_CFB = `${ESPN_API_ROOT}/football/college-football/scoreboard`;

const CORS_FALLBACKS = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const _state = {
  lastFetchUrl:       null,
  lastFetchTimestamp: null,
  lastFetchSuccess:   false,
  lastFetchMethod:    null,
  lastRawEventCount:  0,
  lastParsedCount:    0,
  lastQualityReport:  null,
  lastRawEvents:      [],
  lastScoreRefresh:   null,
  lastRequestedRange: null,  // { startDate, endDate } of what Commissioner asked for
};

// ─── URL BUILDER ──────────────────────────────────────────────────────────────

/**
 * Build the raw ESPN scoreboard URL (no proxy).
 *
 * `params.sport` (optional) — one of the keys in ESPN_SPORT_ENDPOINTS
 *   ('college-football', 'nfl'). Defaults to college-football to preserve
 *   backward compatibility with the pre-multi-sport call sites.
 *
 * The `groups=80` parameter is CFB-specific (FBS division filter) so we only
 * pass it when the sport is college-football. NFL and other sports don't use
 * groups and would return unexpected results if we sent it.
 *
 * Shown in Commissioner panel for transparency.
 */
export function buildEspnUrl(params = {}) {
  const { sport = 'college-football', ...rest } = params;
  const path = espnSportPath(sport);
  const isCfb = sport === 'college-football';
  const p = { ...(isCfb ? { groups: '80' } : {}), limit: '200', ...rest };
  const qs = new URLSearchParams(p).toString();
  return `${ESPN_API_ROOT}/${path}/scoreboard${qs ? '?' + qs : ''}`;
}

// ─── PUBLIC: FETCH ENTRY POINTS ───────────────────────────────────────────────

/**
 * Fetch games for a Commissioner-selected date range.
 *
 * Key behaviour:
 *  - Uses ONLY the Commissioner-selected dates, never ESPN's week range.
 *  - If startDate === endDate (or no endDate): single-day fetch.
 *  - If multi-day: fetch each day separately and merge (ESPN's ?dates= is single-day).
 *  - Games outside the requested date range are filtered out.
 *  - season parameter is optional context only; dates are the source of truth.
 */
export async function fetchByDateRange({ startDate, endDate, season } = {}) {
  if (!startDate) {
    return { games: [], error: 'No start date specified.', usingDemo: false, espnUrl: null };
  }

  _state.lastRequestedRange = { startDate, endDate: endDate || startDate };

  // Collect all dates in the range
  const dates = getDatesInRange(startDate, endDate || startDate);

  let allEvents = [];
  let lastEspnUrl = null;
  let lastMethod  = null;

  for (const date of dates) {
    const params = { dates: toEspnDate(date) };
    if (season) params.season = season;
    const espnUrl = buildEspnUrl(params);
    lastEspnUrl   = espnUrl;
    _state.lastFetchUrl = espnUrl;

    const result = await resilientFetch(espnUrl);
    if (result._rawEvents) {
      allEvents.push(...result._rawEvents);
      lastMethod = result.fetchMethod;
    }
  }

  // Deduplicate by event ID
  const seen = new Set();
  const uniqueEvents = allEvents.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id); return true;
  });

  _state.lastFetchTimestamp = new Date().toISOString();
  _state.lastRawEventCount  = uniqueEvents.length;
  _state.lastRawEvents      = uniqueEvents.slice(0, 10).map(e => e.name || e.shortName || `ID:${e.id}`);

  if (!uniqueEvents.length) {
    const err = `ESPN returned 0 events for ${startDate}${endDate && endDate !== startDate ? ` to ${endDate}` : ''}. Schedule may not be published yet.`;
    _state.lastQualityReport = buildFailReport(lastEspnUrl||'', err);
    return { games: [], error: err, usingDemo: false, espnUrl: lastEspnUrl, qualityReport: _state.lastQualityReport };
  }

  // Parse and filter to requested date range
  const { games, report } = parseAndReport(uniqueEvents, lastEspnUrl, lastMethod, startDate, endDate);
  _state.lastParsedCount   = games.length;
  _state.lastQualityReport = report;
  _state.lastFetchSuccess  = true;
  _state.lastFetchMethod   = lastMethod;

  return {
    games, error: null, usingDemo: false, espnUrl: lastEspnUrl,
    rawEventCount: uniqueEvents.length,
    qualityReport: report,
    rawEvents: _state.lastRawEvents,
    fetchMethod: lastMethod,
  };
}

export async function fetchCurrentCFBGames() {
  const espnUrl = buildEspnUrl({});
  _state.lastFetchUrl = espnUrl;
  return resilientFetch(espnUrl);
}

/**
 * Refresh live scores for a set of stored games. Each game may point at a
 * different ESPN sport (CFB, NFL, etc.) via its `espnSport` field. We bucket
 * games by sport, fetch each sport's scoreboard once, and merge results.
 *
 * Games without an `espnSport` are treated as CFB (default) so the pre-manual
 * codebase keeps working unchanged.
 *
 * The signature is kept the same as before — `(espnEventIds, storedGames)` —
 * so all existing call sites work. `storedGames` is what we actually use to
 * bucket by sport; `espnEventIds` is retained for historical compatibility
 * but is not required.
 */
export async function refreshScoresByEventIds(espnEventIds = [], storedGames = []) {
  // Bucket games by sport (default cfb)
  const bySport = new Map();
  for (const g of storedGames) {
    if (!g?.espnEventId) continue;
    const sport = g.espnSport || 'college-football';
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport).push(g);
  }
  // Fetch each sport's scoreboard in parallel
  const fetches = [...bySport.keys()].map(async sport => {
    const url = buildEspnUrl({ sport });
    const result = await resilientFetch(url);
    return { sport, result };
  });
  const settled = await Promise.all(fetches);

  const updated = [];
  const errors = [];
  for (const { sport, result } of settled) {
    if (result.error) { errors.push(`${sport}: ${result.error}`); continue; }
    if (!result.games?.length) continue;
    const gamesInSport = bySport.get(sport) || [];
    for (const liveGame of result.games) {
      const stored = gamesInSport.find(g =>
        String(g.espnEventId) === String(liveGame.espnEventId)
      );
      if (!stored) continue;
      updated.push({
        gameId: stored.gameId, espnEventId: liveGame.espnEventId,
        homeScore: liveGame.homeScore, awayScore: liveGame.awayScore,
        status: liveGame.status, actualWinner: liveGame.actualWinner,
        lastUpdated: new Date().toISOString(),
      });
    }
  }
  _state.lastScoreRefresh = new Date().toISOString();
  return { updated, errors, timestamp: _state.lastScoreRefresh };
}

export function getProviderState() { return { ..._state }; }
export function getLastFetchUrl()  { return _state.lastFetchUrl; }

// ─── RESILIENT FETCH ──────────────────────────────────────────────────────────

async function resilientFetch(espnUrl) {
  const directResult = await attemptFetch(espnUrl, 'direct');
  if (directResult.ok) return finalise(directResult, espnUrl, 'direct');

  for (let i = 0; i < CORS_FALLBACKS.length; i++) {
    const proxyUrl = CORS_FALLBACKS[i](espnUrl);
    const label    = ['allorigins', 'corsproxy.io', 'codetabs'][i];
    const result   = await attemptFetch(proxyUrl, label);
    if (result.ok) return finalise(result, espnUrl, `proxy:${label}`);
    console.warn(`[DataProvider] ${label} failed:`, result.error);
  }

  const errorMsg = 'ESPN API unreachable — direct fetch and all proxies failed.';
  _state.lastQualityReport = buildFailReport(espnUrl, errorMsg);
  return { games: [], error: errorMsg, usingDemo: false, espnUrl };
}

async function attemptFetch(url, method) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${method}` };
    const raw  = await res.json();
    const data = raw?.contents ? JSON.parse(raw.contents) : raw;
    return { ok: true, data, method };
  } catch (err) {
    return { ok: false, error: err.message, method };
  }
}

function finalise(result, espnUrl, method) {
  const events = result.data?.events || [];
  _state.lastFetchSuccess  = true;
  _state.lastFetchMethod   = method;
  _state.lastRawEventCount = events.length;
  _state.lastRawEvents     = events.slice(0, 10).map(e => e.name || e.shortName || `ID:${e.id}`);

  if (!events.length) {
    const err = 'ESPN returned 0 events for this request.';
    _state.lastQualityReport = buildFailReport(espnUrl, err);
    return { games: [], error: err, usingDemo: false, espnUrl, rawEventCount: 0, _rawEvents: [], fetchMethod: method };
  }

  // For multi-day fetches we return raw events for merging upstream
  const { games, report } = parseAndReport(events, espnUrl, method, null, null);
  _state.lastParsedCount   = games.length;
  _state.lastQualityReport = report;
  return { games, error: null, usingDemo: false, espnUrl, rawEventCount: events.length, _rawEvents: events, qualityReport: report, fetchMethod: method };
}

// ─── PARSE + QUALITY REPORT ───────────────────────────────────────────────────

/**
 * Parse ESPN events into game objects.
 * startDate/endDate: filter games outside requested range.
 */
function parseAndReport(events, espnUrl, method, startDate, endDate) {
  let withValidKickoff=0, withConfirmedTime=0, withFinalScores=0;
  let withSpread=0, withoutSpread=0, withUnknownTeam=0, outsideRange=0;

  const rangeStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const rangeEnd   = endDate   ? new Date(endDate   + 'T23:59:59') : (rangeStart ? new Date(startDate + 'T23:59:59') : null);

  const games = events.map(event => {
    const comp = event.competitions?.[0];
    if (!comp) return null;

    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;

    // ── School + Mascot extraction ──────────────────────────────────────────
    // ESPN team object provides:
    //   team.location         = "Texas A&M"           (school name)
    //   team.name             = "Aggies"              (mascot)
    //   team.shortDisplayName = "Texas A&M"           (often same as location)
    //   team.displayName      = "Texas A&M Aggies"    (full name)
    // We store the school name as homeTeam/awayTeam (clean, matches alma mater patterns)
    // and mascot as homeMascot/awayMascot for "School (Mascot)" display.
    const homeSchool = home.team?.location || home.team?.shortDisplayName || home.team?.displayName || home.team?.name || '';
    const awaySchool = away.team?.location || away.team?.shortDisplayName || away.team?.displayName || away.team?.name || '';
    const homeMascot = home.team?.name || '';
    const awayMascot = away.team?.name || '';

    const homeTeam = homeSchool;
    const awayTeam = awaySchool;
    if (!homeTeam || !awayTeam) { withUnknownTeam++; return null; }

    // ── Kickoff time validation ──────────────────────────────────────────────
    // ESPN returns event.date which is always present, but may be a midnight
    // placeholder when the real time hasn't been scheduled yet.
    // We distinguish:
    //   kickoffConfirmed: true  = real scheduled time
    //   kickoffConfirmed: false = date known but time TBD (midnight UTC placeholder)
    //   kickoff: null           = truly unknown

    const rawDate   = event.date || null;
    const statusName = event.status?.type?.name || '';
    const timeValid  = event.status?.type?.detail;  // e.g. "8:00 PM ET" or "TBD"

    let kickoff          = rawDate;
    let kickoffConfirmed = false;
    let kickoffDateOnly  = false;

    if (rawDate) {
      const d = new Date(rawDate);
      // Midnight UTC is ESPN's placeholder for "date set, time TBD"
      const isMidnightPlaceholder = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;

      if (isMidnightPlaceholder && !timeValid?.match(/\d+:\d+/)) {
        // Date is known but time is TBD
        kickoffDateOnly  = true;
        kickoffConfirmed = false;
      } else if (!isMidnightPlaceholder) {
        kickoffConfirmed = true;
        withConfirmedTime++;
      }
      withValidKickoff++;

      // Filter: exclude games outside the requested date range
      if (rangeStart && rangeEnd) {
        if (d < rangeStart || d > rangeEnd) {
          // Allow ±1 day leeway for timezone edge cases
          const leeway = 24 * 60 * 60 * 1000;
          if (d < new Date(rangeStart.getTime() - leeway) || d > new Date(rangeEnd.getTime() + leeway)) {
            outsideRange++;
            return null;
          }
        }
      }
    }

    const status    = normalizeStatus(statusName);
    const homeScore = parseScore(home.score);
    const awayScore = parseScore(away.score);
    if (status === GAME_STATUS.FINAL && homeScore !== null) withFinalScores++;

    const homeRank = safeRank(home.curatedRank?.current);
    const awayRank = safeRank(away.curatedRank?.current);
    const homeConf = extractConf(home.team);
    const awayConf = extractConf(away.team);

    const { spread, favorite, spreadSource, oddsProvider } = extractSpread(comp, homeTeam, awayTeam);
    if (spread !== null) withSpread++; else withoutSpread++;

    const isAlmaMater = !!(getAlmaMaterMatch(homeTeam) || getAlmaMaterMatch(awayTeam));

    let actualWinner = null;
    if (status === GAME_STATUS.FINAL && homeScore !== null && awayScore !== null) {
      if (homeScore > awayScore) actualWinner = homeTeam;
      else if (awayScore > homeScore) actualWinner = awayTeam;
      else actualWinner = 'tie';
    }

    // ── Venue: city/state or city/country, not stadium name ─────────────────
    const venueObj   = comp.venue;
    const venueName  = venueObj?.fullName || null;
    const venueCity  = venueObj?.address?.city || null;
    const venueState = venueObj?.address?.state || null;
    const venueCountry = venueObj?.address?.country || null;
    const neutral    = comp.neutralSite || false;

    // Build display location
    let venueDisplay = null;
    if (venueCity && venueState) {
      venueDisplay = `${venueCity}, ${venueState}`;
    } else if (venueCity && venueCountry && venueCountry !== 'USA' && venueCountry !== 'US') {
      venueDisplay = `${venueCity}, ${venueCountry}`;
    } else if (venueCity) {
      venueDisplay = venueCity;
    }

    const dq = spread !== null ? DATA_QUALITY.CONFIRMED : DATA_QUALITY.PARTIAL;

    return createGame('', {
      espnEventId:    event.id,
      dataQuality:    dq,
      dataSource:     method === 'direct' ? 'espn_live' : 'espn_historical',
      homeTeam, awayTeam,
      homeMascot, awayMascot,
      homeConference: homeConf, awayConference: awayConf,
      homeRank, awayRank,
      kickoff,
      kickoffConfirmed,
      kickoffDateOnly,
      timeWindow: getTimeWindow(kickoff),
      spread, favorite, spreadSource, oddsProvider,
      lockedSpread: null,
      homeScore: status !== GAME_STATUS.SCHEDULED ? homeScore : null,
      awayScore: status !== GAME_STATUS.SCHEDULED ? awayScore : null,
      status, actualWinner, atsWinner: null,
      isAlmaMaterGame: isAlmaMater,
      venue: venueName,
      venueDisplay,
      neutralSite: neutral,
      lastUpdated: new Date().toISOString(),
    });
  }).filter(Boolean);

  let dqStatus;
  if (!games.length)            dqStatus = outsideRange > 0 ? `All ${outsideRange} ESPN events were outside the requested date range` : 'ESPN returned no parseable games';
  else if (withSpread > 0)      dqStatus = `ESPN confirmed (${withSpread} with odds, ${withoutSpread} without)`;
  else if (withFinalScores > 0) dqStatus = 'ESPN historical — scores present, no odds';
  else if (withConfirmedTime > 0) dqStatus = 'ESPN partial — scheduled games, times confirmed, no odds yet';
  else                          dqStatus = 'ESPN partial — game dates returned, times TBD';

  const report = {
    espnUrl, fetchMethod: method,
    requestTimestamp: new Date().toISOString(),
    requestedDateRange: _state.lastRequestedRange,
    rawEventCount: events.length,
    parsedGameCount: games.length,
    outsideRange,
    withValidKickoff, withConfirmedTime,
    withFinalScores, withSpread, withoutSpread, withUnknownTeam,
    dqStatus,
    firstFiveEvents: events.slice(0, 5).map(e => ({
      id: e.id, name: e.name || e.shortName || '?',
      date: e.date, statusName: e.status?.type?.name,
    })),
  };

  return { games, report };
}

function buildFailReport(espnUrl, error) {
  return { espnUrl, requestTimestamp: new Date().toISOString(), rawEventCount: 0, parsedGameCount: 0, dqStatus: 'Fetch failed', error };
}

// ─── NORMALIZATION HELPERS ────────────────────────────────────────────────────

function parseScore(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw, 10); return isNaN(n) ? null : n;
}

function safeRank(raw) {
  if (!raw) return null; const n = parseInt(raw, 10);
  return n >= 1 && n <= 25 ? n : null;
}

function normalizeStatus(name) {
  if (!name) return GAME_STATUS.SCHEDULED;
  if (name.includes('FINAL')) return GAME_STATUS.FINAL;
  if (name === 'STATUS_IN_PROGRESS' || name.includes('HALFTIME') || name.includes('END_PERIOD')) return GAME_STATUS.LIVE;
  return GAME_STATUS.SCHEDULED;
}

// ESPN conference ID → human name. The lightweight scoreboard payload doesn't
// include conference.name on team objects (only conferenceId), so we map them
// here. IDs are stable in the ESPN API. If a new conference appears, add it
// below; unmapped IDs fall through to the empty-string fallback in extractConf.
const ESPN_CONFERENCE_BY_ID = {
  1: 'AAC',                  // American (some payloads)
  4: 'Big 12',
  5: 'ACC',
  7: 'Big Ten',
  8: 'SEC',
  9: 'Pac-12',
  12: 'Conference USA',
  15: 'MAC',
  17: 'Mountain West',
  18: 'FBS Independents',
  37: 'Sun Belt',
  151: 'AAC',                // American Athletic (current id seen in recent payloads)
  // FCS / lower divisions get rendered as their abbreviation when present
};

function extractConf(teamObj) {
  if (!teamObj) return '';
  // Prefer explicit name on the team object when present
  const direct = teamObj.conference?.abbreviation || teamObj.conference?.name || teamObj.conferenceShortName || teamObj.conferenceName;
  if (direct) return direct;
  // Fall back to mapped conferenceId (most scoreboard payloads only have this)
  const id = teamObj.conferenceId;
  if (id != null && ESPN_CONFERENCE_BY_ID[Number(id)]) return ESPN_CONFERENCE_BY_ID[Number(id)];
  return '';
}

function extractSpread(comp, homeTeam, awayTeam) {
  const odds        = comp.odds?.[0];
  const oddsProvider = odds?.provider?.name || null;
  if (!odds?.details || odds.details === 'Pick' || !odds.details.trim())
    return { spread: null, favorite: null, spreadSource: null, oddsProvider };

  const detail   = odds.details.trim();
  const numMatch = detail.match(/([-+]?\d+\.?\d*)$/);
  if (!numMatch) return { spread: null, favorite: null, spreadSource: 'espn_unparsed', oddsProvider };

  const spreadNum = parseFloat(numMatch[1]);
  const teamPart  = detail.slice(0, detail.length - numMatch[0].length).trim();
  const partLow   = teamPart.toLowerCase();

  // Match against any meaningful token of the school name (length > 2)
  const tokens = (name) => name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const homeTokens = tokens(homeTeam);
  const awayTokens = tokens(awayTeam);

  let favorite = null;
  // First try last-token match (common case: "Aggies -3" or "A&M -3")
  const homeLast = homeTeam.split(/\s+/).pop().toLowerCase();
  const awayLast = awayTeam.split(/\s+/).pop().toLowerCase();
  if (partLow.includes(homeLast) && homeLast.length > 1) favorite = homeTeam;
  else if (partLow.includes(awayLast) && awayLast.length > 1) favorite = awayTeam;
  // Then try any longer token
  if (!favorite) {
    if (homeTokens.some(w => partLow.includes(w))) favorite = homeTeam;
    else if (awayTokens.some(w => partLow.includes(w))) favorite = awayTeam;
  }
  // Last resort: short abbreviations like "TCU"
  if (!favorite) {
    if (partLow.includes(homeTeam.toLowerCase())) favorite = homeTeam;
    else if (partLow.includes(awayTeam.toLowerCase())) favorite = awayTeam;
  }

  let homePerspective = spreadNum;
  if (favorite === awayTeam) homePerspective = -spreadNum;

  return { spread: homePerspective, favorite, spreadSource: 'espn', oddsProvider };
}

// ─── DATE UTILITIES ───────────────────────────────────────────────────────────

/** Convert 'YYYY-MM-DD' to ESPN's '20250913' format */
function toEspnDate(dateStr) { return dateStr ? dateStr.replace(/-/g, '') : ''; }

/** Get all dates in a range as 'YYYY-MM-DD' strings */
function getDatesInRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate + 'T12:00:00');
  const end     = new Date((endDate || startDate) + 'T12:00:00');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ─── GAME SCORING / SLATE SELECTION ──────────────────────────────────────────

export function scoreCandidateGames(games, weekId, count = 15) {
  const valid  = games.filter(g => g.homeTeam && g.awayTeam);
  const scored = valid.map(g => ({
    ...g, weekId,
    _score:            computeScore(g),
    suggestionReasons: getSuggestionReasons(g),
  })).sort((a, b) => b._score - a._score);
  return balanceByTimeWindow(scored, count).slice(0, count);
}

function computeScore(game) {
  let s = 0;
  if (game.isAlmaMaterGame) s += 100;
  if (game.homeRank && game.homeRank <= 25) s += (26 - game.homeRank) * 2;
  if (game.awayRank && game.awayRank <= 25) s += (26 - game.awayRank) * 2;
  if (game.homeRank && game.awayRank) s += 30;
  if (game.spread !== null) { const a = Math.abs(game.spread); if (a <= 7) s += 20; else if (a <= 14) s += 10; }
  if (game.kickoffConfirmed) s += 5;   // prefer games with real times
  return s;
}

function getSuggestionReasons(game) {
  const r = [];
  if (game.isAlmaMaterGame) r.push('⭐ Alma mater');
  if (game.homeRank && game.awayRank) r.push('🏆 Ranked vs ranked');
  else if (game.homeRank || game.awayRank) r.push('📊 Ranked matchup');
  if (game.spread !== null && Math.abs(game.spread) <= 7) r.push('🎯 Tight spread');
  if (game.neutralSite) r.push('🌍 Neutral site');
  if (!game.kickoffConfirmed) r.push('⏰ Time TBD');
  if (!r.length) r.push('🏈 Quality matchup');
  return r;
}

function balanceByTimeWindow(games, max) {
  const windows = [TIME_WINDOW.MORNING, TIME_WINDOW.AFTERNOON, TIME_WINDOW.EVENING, TIME_WINDOW.LATE];
  const buckets = {}; windows.forEach(w => buckets[w] = []);
  for (const g of games) buckets[g.timeWindow || TIME_WINDOW.AFTERNOON].push(g);
  const result = []; const cap = Math.ceil(max / windows.length) + 1;
  for (const w of windows) result.push(...buckets[w].splice(0, cap));
  const left = Object.values(buckets).flat().sort((a, b) => b._score - a._score);
  while (result.length < max && left.length) result.push(left.shift());
  return result.slice(0, max);
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

export function getTimeWindow(isoTime) {
  if (!isoTime) return TIME_WINDOW.AFTERNOON;
  const d  = new Date(isoTime);
  const et = (d.getUTCHours() - 4 + 24) % 24;
  if (et < 12) return TIME_WINDOW.MORNING;
  if (et < 17) return TIME_WINDOW.AFTERNOON;
  if (et < 21) return TIME_WINDOW.EVENING;
  return TIME_WINDOW.LATE;
}

// formatKickoff / formatKickoffFull are no longer exported — app uses
// formatGameTime from data-model.js instead. Kept for internal use only.
function _formatKickoff(isoTime) {
  if (!isoTime) return 'TBD';
  try { return new Date(isoTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZoneName:'short',timeZone:'America/New_York'}); }
  catch { return 'TBD'; }
}
