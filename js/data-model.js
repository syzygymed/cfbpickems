/**
 * CFB Pickems — Data Model v10
 * Changes (v10):
 *  - Team display: "School (Mascot)" everywhere via getTeamDisplay()
 *  - homeMascot/awayMascot fields on game; backfill on createGame
 *  - formatSpread() now derives favorite from spread sign + game when missing
 *  - DEMO_GAMES, HISTORICAL_DEMO_GAMES, REAL_WEEK_1_2026_KNOWN_GAMES include mascot
 *  - TEAM_MASCOT_LOOKUP fallback for legacy data without mascot fields
 * v9 carried over:
 *  - ALMA_MATER_EXACT_PATTERNS / ALMA_MATER_EXCLUDE_PATTERNS for precise matching
 *  - DEMO_PLAYERS: alma maters + 2-letter initials
 *  - SITE_PIN: site-level access control
 *  - showInHistory flag on weeks
 */

export const ALMA_MATERS = ['Oklahoma', 'Texas A&M', 'USC', 'Notre Dame', 'Purdue', 'Arkansas'];

// Precise matching patterns — prevents "Arkansas State" from matching "Arkansas" etc.
// These are the exact ESPN displayName substrings that identify each alma mater.
export const ALMA_MATER_EXACT_PATTERNS = {
  'Oklahoma':   ['Oklahoma Sooners', 'Oklahoma'],          // not Oklahoma State
  'Texas A&M':  ['Texas A&M Aggies', 'Texas A&M'],
  'USC':        ['USC Trojans', 'USC', 'Southern California'], // ESPN location is often just "USC"
  'Notre Dame': ['Notre Dame Fighting Irish', 'Notre Dame'],
  'Purdue':     ['Purdue Boilermakers', 'Purdue'],         // not Purdue Fort Wayne
  'Arkansas':   ['Arkansas Razorbacks', 'Arkansas'],       // not Arkansas State, Little Rock, etc.
};

// Negative-match patterns — these teams should never match even if substring is present
export const ALMA_MATER_EXCLUDE_PATTERNS = {
  'Oklahoma':  ['Oklahoma State', 'Central Oklahoma', 'Southeastern Oklahoma', 'Northwestern Oklahoma', 'Northeastern Oklahoma'],
  'Arkansas':  ['Arkansas State', 'Arkansas-Pine Bluff', 'Arkansas-Monticello', 'Arkansas Tech', 'Arkansas-Fort Smith', 'Little Rock', 'Central Arkansas', 'UA Little Rock'],
  'USC':       ['East Carolina', 'USC Upstate', 'South Carolina Upstate'],
  'Purdue':    ['Purdue Fort Wayne', 'Purdue Northwest'],
};

// Display format: School (Mascot)
export const ALMA_MATER_DISPLAY = {
  'Oklahoma':   'Oklahoma (Sooners)',
  'Texas A&M':  'Texas A&M (Aggies)',
  'USC':        'USC (Trojans)',
  'Notre Dame': 'Notre Dame (Fighting Irish)',
  'Purdue':     'Purdue (Boilermakers)',
  'Arkansas':   'Arkansas (Razorbacks)',
};

/**
 * Fallback mascot lookup — used when game data lacks an explicit homeMascot/awayMascot
 * (e.g. legacy data, manually-added games, ESPN data parsed before v10).
 * Keyed by school name (matching homeTeam/awayTeam strings).
 */
export const TEAM_MASCOT_LOOKUP = {
  // Alma maters
  'Oklahoma':'Sooners', 'Texas A&M':'Aggies', 'USC':'Trojans',
  'Notre Dame':'Fighting Irish', 'Purdue':'Boilermakers', 'Arkansas':'Razorbacks',
  // Demo / common opponents
  'Temple':'Owls', 'Utah':'Utes', 'Missouri':'Tigers', 'Indiana':'Hoosiers',
  'Georgia':'Bulldogs', 'Clemson':'Tigers', 'Ohio State':'Buckeyes',
  'Texas':'Longhorns', 'Michigan':'Wolverines', 'Alabama':'Crimson Tide',
  'Penn State':'Nittany Lions', 'West Virginia':'Mountaineers', 'LSU':'Tigers',
  'Florida State':'Seminoles', 'Houston':'Cougars', 'Florida':'Gators',
  'Utah State':'Aggies', 'Miami (OH)':'RedHawks', 'Indiana State':'Sycamores',
  'Louisiana Tech':'Bulldogs', 'Kentucky':'Wildcats', 'Western Michigan':'Broncos',
  'Bowling Green':'Falcons', 'Nicholls':'Colonels',
  'TCU':'Horned Frogs', 'North Carolina':'Tar Heels',
};

/**
 * Format school + mascot. Falls back to TEAM_MASCOT_LOOKUP if mascot blank.
 * Examples:
 *   formatTeamName('Texas A&M', 'Aggies') => 'Texas A&M (Aggies)'
 *   formatTeamName('Oklahoma')            => 'Oklahoma (Sooners)'  (via lookup)
 *   formatTeamName('Unknown School')      => 'Unknown School'
 */
export function formatTeamName(school, mascot) {
  if (!school) return '';
  const m = (mascot && mascot.trim()) || TEAM_MASCOT_LOOKUP[school] || '';
  return m ? `${school} (${m})` : school;
}

/**
 * Get formatted team display for one side of a game.
 * Uses explicit game.homeMascot / game.awayMascot when present, else lookup, else plain.
 */
export function getTeamDisplay(game, side='home') {
  if (!game) return '';
  const school = side === 'home' ? game.homeTeam : game.awayTeam;
  const mascot = side === 'home' ? game.homeMascot : game.awayMascot;
  return formatTeamName(school, mascot);
}

/**
 * Check whether a team name is an alma mater — precise matching.
 * Returns the matching alma mater key, or null.
 *
 * Robustness rules (prevents the USC-class bug where an alma mater's own
 * key wasn't in its pattern list):
 *  1. The alma mater KEY itself is always treated as a valid pattern, even if
 *     it was omitted from ALMA_MATER_EXACT_PATTERNS.
 *  2. Exclusions are checked first (e.g. "Arkansas State" never matches "Arkansas").
 *  3. Matching is word-aware: a pattern matches if it appears as a whole word /
 *     phrase, not as a substring of a longer word. This stops "USC" from
 *     matching inside "USCUpstate"-type concatenations while still matching the
 *     bare "USC" that ESPN returns as team.location.
 */
export function getAlmaMaterMatch(teamName) {
  if (!teamName) return null;
  const t = teamName.trim();
  const tLow = t.toLowerCase();

  const wordAwareIncludes = (haystack, needle) => {
    const n = needle.toLowerCase();
    const idx = haystack.indexOf(n);
    if (idx === -1) return false;
    // Ensure the match is bounded by non-alphanumerics (or string ends),
    // so "usc" matches "usc" and "usc trojans" but not "uscupstate".
    const before = idx === 0 ? '' : haystack[idx - 1];
    const after  = idx + n.length >= haystack.length ? '' : haystack[idx + n.length];
    const isWordChar = c => /[a-z0-9]/.test(c);
    return (!before || !isWordChar(before)) && (!after || !isWordChar(after));
  };

  for (const alma of ALMA_MATERS) {
    // Exclusions first
    const excludes = ALMA_MATER_EXCLUDE_PATTERNS[alma] || [];
    if (excludes.some(ex => tLow.includes(ex.toLowerCase()))) continue;

    // Inclusion patterns = configured patterns + the key itself (guaranteed)
    const patterns = new Set([...(ALMA_MATER_EXACT_PATTERNS[alma] || []), alma]);
    if ([...patterns].some(p => wordAwareIncludes(tLow, p))) return alma;
  }
  return null;
}

export const WEEK_STATUS   = { DRAFT:'draft', OPEN:'open', LOCKED:'locked', LIVE:'live', FINAL:'final' };
export const GAME_STATUS   = { SCHEDULED:'scheduled', LIVE:'live', FINAL:'final' };
export const PICK_RESULT   = { PENDING:'pending', LIVE:'live', WIN:'win', LOSS:'loss', NO_DECISION:'no_decision' };
export const TIME_WINDOW   = { MORNING:'morning', AFTERNOON:'afternoon', EVENING:'evening', LATE:'late' };
// v0.17.3 — PENDING added: a payer's own "Mark Paid" claim needs the creditor
// (or the commissioner) to confirm before it counts as settled (UN-89 debt
// approval). See obligationNextStatus() below for the transition rules.
export const OBLIGATION_STATUS = { UNPAID:'unpaid', PENDING:'pending', PAID:'paid', WAIVED:'waived' };
export const STORAGE_MODE  = { LOCAL:'local', GOOGLE_SHEETS:'googleSheets' };

export const DATA_QUALITY  = {
  CONFIRMED:'confirmed', PARTIAL:'partial', DEMO:'demo', MANUAL:'manual', UNAVAILABLE:'unavailable',
};

export const DATA_SOURCE_MODE = {
  DEMO:'demo', ESPN_LIVE:'espn_live', ESPN_HISTORICAL:'espn_historical', MANUAL:'manual',
};

export const TIEBREAKER_TYPE = {
  ALMA_MATER_TOTAL:'almaMaterTotal', MANUAL:'manual', CUSTOM:'custom',
};

export const TIEBREAKER_CALC_MODE = {
  SELECTED_SLATE_ONLY:'selectedSlateOnly', ALL_ALMA_MATER_GAMES:'allAlmaMaterGames', MANUAL:'manual',
};

export const TIME_ZONES = [
  { key:'PT', label:'Pacific',  iana:'America/Los_Angeles' },
  { key:'MT', label:'Mountain', iana:'America/Denver' },
  { key:'CT', label:'Central',  iana:'America/Chicago' },
  { key:'ET', label:'Eastern',  iana:'America/New_York' },
];
export const DEFAULT_TZ = 'PT';

/**
 * The ONE emoji palette for the entire app (AD-20 extended to emoji, batch 3+4
 * item G). Previously two independent literals drifted apart: `QUICK_EMOJI`
 * (6, chat-ui.js) and `REACTION_PALETTE` (15, app.js's dashboard game
 * reactions). Same lesson as `TEAM_ABBR`: a second literal for one concept is
 * the bug, not a feature. data-model.js imports nothing, so it's the only
 * module either app.js or chat-ui.js can both pull from without a cycle.
 *
 * Order historically mattered because chat's QUICK_EMOJI derived from the
 * FRONT of this list — retired in batch 2 (UN-103): the composer no longer
 * inserts emoji at all, and the message-level always-visible subset was
 * replaced by a single + that opens this full list per message. The front
 * entries are still the most-used ones, so the order is left as-is for
 * whoever next wants a curated subset. The dashboard's reaction picker shows
 * the whole list in a grid, where order is purely cosmetic.
 */
export const REACTION_PALETTE = [
  '👍', '👎', '🔥', '😂', '💀', '🍺',
  '😁', '😭', '😅', '😬', '🤡', '👀',
  '🫡', '🤘', '🤙', '☝️', '🚀', '🖕',
];

// Site-level access PIN — DEFAULT only. Commissioner can override this via
// settings.sitePin (Commissioner → Security panel). verifySitePin() in storage.js
// checks settings first, then falls back to this constant.
export const SITE_PIN = '6969';
export const SITE_PIN_KEY = 'cfbp_site_unlocked';

/**
 * Per-player theme catalog.
 *  - Default theme is 'neutral' (school-agnostic slate) as of v0.17.0; school palettes are opt-in.
 *  - Each theme is applied by adding a class `theme-<key>` to <body>, which the
 *    stylesheet uses to override the root CSS variables for primary brand colors.
 *  - Fonts stay constant across themes (Oswald + Inter).
 *  - Selected theme is stored per-DEVICE in settings.theme.
 */
export const THEMES = [
  // key, label, classSuffix is the same as key
  { key: 'aggie',     label: 'A&M (Maroon)',    school: 'Texas A&M' },
  { key: 'sooner',    label: 'Oklahoma (Crimson & Cream)', school: 'Oklahoma' },
  { key: 'trojan',    label: 'USC (Cardinal & Gold)',      school: 'USC' },
  { key: 'irish',     label: 'Notre Dame (Navy & Gold)',   school: 'Notre Dame' },
  { key: 'boilermaker', label: 'Purdue (Old Gold & Black)',school: 'Purdue' },
  { key: 'razorback', label: 'Arkansas (Cardinal)',        school: 'Arkansas' },
  { key: 'neutral',   label: 'Neutral (Slate)',            school: null, desc: 'Default' },
];

// ─── DEFAULT RULES ────────────────────────────────────────────────────────────

export const DEFAULT_RULES = [
  { id:'r1', section:'The Basics', items:[
    'Each week, the Commissioner selects 10 college football games for the slate.',
    'Alma mater games (OU, Texas A&M, USC, Notre Dame, Purdue, Arkansas) are always prioritized.',
    'You pick which team you think will win against the spread.',
    'Picks are blind — you cannot see others\' picks until you submit your own.',
    'Games lock at kickoff. If the week is locked, no picks are accepted even for future games.',
  ]},
  { id:'r2', section:'Scoring', items:[
    'Correct ATS pick = 1 point.',
    'Incorrect ATS pick = 0 points.',
    'Exact spread tie = No Decision (0 points).',
    'Most correct picks wins the week.',
  ]},
  { id:'r3', section:'Tiebreaker', items:[
    'If players are tied on correct picks, the tiebreaker decides.',
    'Default: total combined points scored by all alma mater teams on the slate.',
    'Closest guess wins. If still tied, players share the rank.',
  ]},
  { id:'r4', section:'Prizes', items:[
    'Weekly prize: loser owes winner a consolation prize.',
    'Season prize: season loser owes season winner a grand prize.',
  ]},
];

// ─── DEFAULT SETTINGS ─────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  almaMaters: ALMA_MATERS,
  weeklyGameCount: 10,
  candidateGameCount: 25,
  weeklyPrize: 'Loser buys winner a consolation prize',
  seasonPrize: 'Season loser owes season winner a grand prize',
  adminPasswordHash: btoa('admin123'),
  storageMode: STORAGE_MODE.LOCAL,
  season: '2026',
  customRules: null,
  autoRefreshInterval: 60,
  timezone: DEFAULT_TZ,
  // v0.17.3 — chat retention (UN-88). 0/absent = OFF (default): the full
  // Locker Room history renders. A positive number is the render window in
  // days; older non-pinned messages stop RENDERING (nothing is deleted — see
  // chat.js isHiddenByRetention()). Default-when-missing story: old settings
  // blobs without this field spread in as 0 via DEFAULT_SETTINGS, same as
  // every other new field (CONVENTIONS #10).
  chatRetentionDays: 0,
  // Batch 3+4 item A — commissioner chat on/off toggle. Default TRUE: chat is
  // on today, and a missing value (every pre-existing settings blob in the
  // Sheet) must not silently disable it (CONVENTIONS #10). Synced through the
  // storage seam so every player sees the same on/off state — this is NOT a
  // device-local key (contrast with the teaser dismissal seq in chat-ui.js,
  // which IS device-local under AD-12).
  chatEnabled: true,
  // UN-107 — commissioner control over the "Randomize My Picks" shortcut.
  // Default FALSE, deliberately: this is the inverse of chatEnabled above.
  // The button ships today as permanent/always-on; going forward it is
  // opt-IN, so a missing value (every pre-existing settings blob) must read
  // as OFF, not on (CONVENTIONS #10). Existing players lose the button until
  // the Commissioner explicitly turns it on — that is the intended behavior
  // change, not a bug.
  randomizePicksEnabled: false,
};

// ─── DEMO PLAYERS — correct alma maters and 2-letter initials ─────────────────

export const DEMO_PLAYERS = [
  { playerId:'p1', displayName:'Drew',    initials:'DH', email:'', active:true, pinHash:btoa('1111'), almaMater:'Texas A&M',  createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z' },
  { playerId:'p2', displayName:'Brayden', initials:'BR', email:'', active:true, pinHash:btoa('2222'), almaMater:'Oklahoma',   createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z' },
  { playerId:'p3', displayName:'Kevin',   initials:'KC', email:'', active:true, pinHash:btoa('3333'), almaMater:'Purdue',     createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z' },
  { playerId:'p4', displayName:'Koby',    initials:'KR', email:'', active:true, pinHash:btoa('4444'), almaMater:'USC',        createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z' },
  { playerId:'p5', displayName:'Jacob',   initials:'JP', email:'', active:true, pinHash:btoa('5555'), almaMater:'Arkansas',   createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z' },
  { playerId:'p6', displayName:'Kihoon',  initials:'KB', email:'', active:true, pinHash:btoa('6666'), almaMater:'Texas A&M',  createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z' },
];

// ─── REAL WEEK 1 2026 ─────────────────────────────────────────────────────────

export const REAL_WEEK_1_2026 = {
  weekId:'w2026_1', season:'2026', weekNumber:1,
  label:'Week 1', roundLabel:'', espnWeekNumber:'1',
  startDate:'2026-08-29', endDate:'2026-08-30',
  status: WEEK_STATUS.DRAFT,
  dataSourceMode: DATA_SOURCE_MODE.ESPN_LIVE,
  picksOpenAt:null, picksLockAt:null,
  showInHistory: true,
  blurb:'🏈 Week 1 — 2026 Season. Commissioner: fetch ESPN data for Aug 29–30 to populate the slate.',
  recap:'', emailSentAt:null,
  tiebreakerQuestion:'What is the total combined points scored by all alma mater teams on the slate this week?',
  tiebreakerType: TIEBREAKER_TYPE.ALMA_MATER_TOTAL,
  tiebreakerCalculationMode: TIEBREAKER_CALC_MODE.SELECTED_SLATE_ONLY,
  actualTiebreakerValue:null, tiebreakerFinalized:false,
  extraPointEnabled:true, extraPointActual:null, extraPointDetect:null,
  createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z',
  lockedAt:null, finalizedAt:null,
};

/**
 * Real Week 1 starts with NO games on the slate. The Commissioner pulls games
 * from ESPN (or adds manually) — nothing is auto-proposed.
 *
 * Previously this seeded a single TCU vs North Carolina game as a placeholder;
 * that was confusing because it showed up automatically every time someone
 * factory-reset. Now it's empty by design; if a user wants a starting slate,
 * they pull from ESPN's Available Games pool and pick from there.
 */
export const REAL_WEEK_1_2026_KNOWN_GAMES = [];

// ─── DEMO WEEK ────────────────────────────────────────────────────────────────

export const DEMO_WEEK = {
  weekId:'w_demo', season:'2026', weekNumber:0,
  label:'📋 Demo Week', roundLabel:'', espnWeekNumber:'',
  startDate:'2026-08-29', endDate:'2026-08-30',
  status: WEEK_STATUS.OPEN,
  dataSourceMode: DATA_SOURCE_MODE.DEMO,
  picksOpenAt:null, picksLockAt:null,
  showInHistory: false,   // hidden from standings Weekly History by default
  blurb:'📋 DEMO WEEK — Fictional games for testing the app. Not real matchups.',
  recap:'', emailSentAt:null,
  tiebreakerQuestion:'What is the total combined points scored by all alma mater teams on the slate this week?',
  tiebreakerType: TIEBREAKER_TYPE.ALMA_MATER_TOTAL,
  tiebreakerCalculationMode: TIEBREAKER_CALC_MODE.SELECTED_SLATE_ONLY,
  actualTiebreakerValue:null, tiebreakerFinalized:false,
  extraPointEnabled:true, extraPointActual:null, extraPointDetect:null,
  createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z',
  lockedAt:null, finalizedAt:null,
};

// Demo games — spreads all expressed as favored team with negative number
export const DEMO_GAMES = [
  { gameId:'dg1',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Oklahoma',     awayTeam:'Temple',        homeConference:'SEC',     awayConference:'AAC',     homeRank:12, awayRank:null, kickoff:'2026-08-29T17:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-28.5, favorite:'Oklahoma',    lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg2',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Texas A&M',    awayTeam:'Notre Dame',    homeConference:'SEC',     awayConference:'Ind',     homeRank:8,  awayRank:7,   kickoff:'2026-08-29T20:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'evening',   spread:-2.5,  favorite:'Texas A&M',   lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg3',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'USC',          awayTeam:'Utah',          homeConference:'Big Ten', awayConference:'Big 12',  homeRank:15, awayRank:20,  kickoff:'2026-08-29T23:30:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'late',      spread:-3.5,  favorite:'USC',         lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg4',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Missouri',     awayTeam:'Arkansas',      homeConference:'SEC',     awayConference:'SEC',     homeRank:null,awayRank:null, kickoff:'2026-08-29T17:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-3.5,  favorite:'Missouri',    lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg5',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Indiana',      awayTeam:'Purdue',        homeConference:'Big Ten', awayConference:'Big Ten', homeRank:null,awayRank:null, kickoff:'2026-08-29T12:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'morning',   spread:-7.0,  favorite:'Indiana',     lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg6',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Georgia',      awayTeam:'Clemson',       homeConference:'SEC',     awayConference:'ACC',     homeRank:1,  awayRank:14,  kickoff:'2026-08-29T20:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'evening',   spread:-7.5,  favorite:'Georgia',     lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg7',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Ohio State',   awayTeam:'Texas',         homeConference:'Big Ten', awayConference:'SEC',     homeRank:2,  awayRank:4,   kickoff:'2026-08-29T16:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-3.0,  favorite:'Ohio State',  lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg8',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Michigan',     awayTeam:'Alabama',       homeConference:'Big Ten', awayConference:'SEC',     homeRank:6,  awayRank:3,   kickoff:'2026-08-29T20:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'evening',   spread:-2.5,  favorite:'Alabama',     lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg9',  weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'Penn State',   awayTeam:'West Virginia', homeConference:'Big Ten', awayConference:'Big 12',  homeRank:10, awayRank:null, kickoff:'2026-08-29T14:30:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-17.5, favorite:'Penn State',  lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'dg10', weekId:'w_demo', espnEventId:null, dataQuality:'demo', dataSource:'demo', homeTeam:'LSU',          awayTeam:'Florida State', homeConference:'SEC',     awayConference:'ACC',     homeRank:9,  awayRank:18,  kickoff:'2026-08-29T23:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'late',      spread:-4.5,  favorite:'LSU',         lockedSpread:null, homeScore:null, awayScore:null, status:'scheduled', actualWinner:null, atsWinner:null, isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:null, venue:null, venueDisplay:null, neutralSite:false },
];

// ─── HISTORICAL DEMO WEEK ─────────────────────────────────────────────────────

export const HISTORICAL_DEMO_WEEK = {
  weekId:'hw1', season:'2025', weekNumber:2,
  label:'Historical Demo', roundLabel:'', espnWeekNumber:'2',
  startDate:'2025-09-13', endDate:'2025-09-14',
  status: WEEK_STATUS.OPEN,
  dataSourceMode: DATA_SOURCE_MODE.DEMO,
  picksOpenAt:null, picksLockAt:null,
  showInHistory: true,
  blurb:'📅 Historical Demo — Sept 13–14, 2025. Real final scores, pre-set spreads.',
  recap:'', emailSentAt:null,
  tiebreakerQuestion:'Total combined points scored by all alma mater teams on the slate?',
  tiebreakerType: TIEBREAKER_TYPE.ALMA_MATER_TOTAL,
  tiebreakerCalculationMode: TIEBREAKER_CALC_MODE.SELECTED_SLATE_ONLY,
  actualTiebreakerValue:201, tiebreakerFinalized:true,
  createdAt:'2025-09-01T00:00:00Z', updatedAt:'2025-09-01T00:00:00Z',
  lockedAt:'2025-09-13T11:00:00Z', finalizedAt:null,
};

export const HISTORICAL_DEMO_GAMES = [
  { gameId:'hg1',  weekId:'hw1', espnEventId:'401628561', dataQuality:'demo', dataSource:'demo', homeTeam:'Oklahoma',     awayTeam:'Houston',        homeConference:'SEC',    awayConference:'Big 12',  homeRank:null,awayRank:null, kickoff:'2025-09-13T17:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-17.0, favorite:'Oklahoma',   lockedSpread:-17.0, homeScore:16, awayScore:12, status:'final', actualWinner:'Oklahoma',   atsWinner:'Houston',    isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T23:00:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg2',  weekId:'hw1', espnEventId:'401628562', dataQuality:'demo', dataSource:'demo', homeTeam:'Texas A&M',    awayTeam:'Florida',        homeConference:'SEC',    awayConference:'SEC',     homeRank:null,awayRank:null, kickoff:'2025-09-13T19:30:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'evening',   spread:-3.0,  favorite:'Texas A&M',  lockedSpread:-3.0,  homeScore:21, awayScore:8,  status:'final', actualWinner:'Texas A&M',  atsWinner:'Texas A&M', isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T23:30:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg3',  weekId:'hw1', espnEventId:'401628563', dataQuality:'demo', dataSource:'demo', homeTeam:'USC',          awayTeam:'Utah State',     homeConference:'Big Ten',awayConference:'Mtn West',homeRank:null,awayRank:null, kickoff:'2025-09-13T22:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'late',      spread:-21.0, favorite:'USC',        lockedSpread:-21.0, homeScore:42, awayScore:13, status:'final', actualWinner:'USC',        atsWinner:'USC',       isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-14T01:30:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg4',  weekId:'hw1', espnEventId:'401628564', dataQuality:'demo', dataSource:'demo', homeTeam:'Notre Dame',   awayTeam:'Miami (OH)',     homeConference:'Ind',    awayConference:'MAC',     homeRank:5,   awayRank:null, kickoff:'2025-09-13T17:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-28.0, favorite:'Notre Dame', lockedSpread:-28.0, homeScore:38, awayScore:7,  status:'final', actualWinner:'Notre Dame', atsWinner:'Notre Dame',isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T21:00:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg5',  weekId:'hw1', espnEventId:'401628565', dataQuality:'demo', dataSource:'demo', homeTeam:'Purdue',       awayTeam:'Indiana State',  homeConference:'Big Ten',awayConference:'FCS',     homeRank:null,awayRank:null, kickoff:'2025-09-13T19:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'evening',   spread:-24.0, favorite:'Purdue',     lockedSpread:-24.0, homeScore:49, awayScore:0,  status:'final', actualWinner:'Purdue',     atsWinner:'Purdue',    isAlmaMaterGame:true,  spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T22:30:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg6',  weekId:'hw1', espnEventId:'401628566', dataQuality:'demo', dataSource:'demo', homeTeam:'Arkansas',     awayTeam:'Louisiana Tech', homeConference:'SEC',    awayConference:'CUSA',    homeRank:null,awayRank:null, kickoff:'2025-09-13T17:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-14.0, favorite:'Arkansas',   lockedSpread:-14.0, homeScore:35, awayScore:14, status:'final', actualWinner:'Arkansas',   atsWinner:'no_decision',isAlmaMaterGame:true, spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T21:00:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg7',  weekId:'hw1', espnEventId:'401628567', dataQuality:'demo', dataSource:'demo', homeTeam:'Georgia',      awayTeam:'Kentucky',       homeConference:'SEC',    awayConference:'SEC',     homeRank:1,   awayRank:null, kickoff:'2025-09-13T20:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'evening',   spread:-10.5, favorite:'Georgia',    lockedSpread:-10.5, homeScore:13, awayScore:12, status:'final', actualWinner:'Georgia',    atsWinner:'Kentucky',  isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T23:30:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg8',  weekId:'hw1', espnEventId:'401628568', dataQuality:'demo', dataSource:'demo', homeTeam:'Ohio State',   awayTeam:'Western Michigan',homeConference:'Big Ten',awayConference:'MAC',    homeRank:3,   awayRank:null, kickoff:'2025-09-13T17:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-38.0, favorite:'Ohio State', lockedSpread:-38.0, homeScore:56, awayScore:0,  status:'final', actualWinner:'Ohio State', atsWinner:'Ohio State',isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T21:00:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg9',  weekId:'hw1', espnEventId:'401628569', dataQuality:'demo', dataSource:'demo', homeTeam:'Penn State',   awayTeam:'Bowling Green',  homeConference:'Big Ten',awayConference:'MAC',    homeRank:7,   awayRank:null, kickoff:'2025-09-13T16:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-35.0, favorite:'Penn State', lockedSpread:-35.0, homeScore:52, awayScore:0,  status:'final', actualWinner:'Penn State', atsWinner:'Penn State',isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T20:30:00Z', venue:null, venueDisplay:null, neutralSite:false },
  { gameId:'hg10', weekId:'hw1', espnEventId:'401628570', dataQuality:'demo', dataSource:'demo', homeTeam:'LSU',          awayTeam:'Nicholls',       homeConference:'SEC',    awayConference:'SLC',     homeRank:null,awayRank:null, kickoff:'2025-09-13T17:00:00Z', kickoffConfirmed:true, kickoffDateOnly:false, timeWindow:'afternoon', spread:-38.5, favorite:'LSU',        lockedSpread:-38.5, homeScore:44, awayScore:21, status:'final', actualWinner:'LSU',        atsWinner:'Nicholls',  isAlmaMaterGame:false, spreadSource:'manual', oddsProvider:null, lastUpdated:'2025-09-13T21:00:00Z', venue:null, venueDisplay:null, neutralSite:false },
];

export const HISTORICAL_DEMO_TIEBREAKER_VALUE = 201;
export const DEMO_PICKS = [];

// ─── FACTORY FUNCTIONS ────────────────────────────────────────────────────────

export function createPlayer(displayName, email='', pin='0000', almaMater='', initials='') {
  return {
    playerId:`p_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    displayName, initials, email, active:true, almaMater,
    pinHash:btoa(pin),
    // ── Notification fields (Phase III prep — SMS/email pick updates) ──
    // Populated later; safe defaults now so existing code and exports are stable.
    phone:'',                 // E.164 format, e.g. "+15125550123"
    phoneVerified:false,      // set true only after a verification flow (later)
    notifyPrefs:{             // per-channel, per-event opt-ins
      sms:   { enabled:false, picksOpen:false, picksReminder:false, gameFinal:false, weeklyRecap:false },
      email: { enabled:false, picksOpen:false, picksReminder:false, gameFinal:false, weeklyRecap:false },
    },
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
  };
}

export function createWeek(season, weekNumber, startDate='', endDate='') {
  // v0.16.0 — weeks carry Ischemic Extra Point fields (enabled/actual/detect)
  // v0.17.1 — weeks carry auto-transition config (auto-lock/auto-live/auto-final)
  return {
    weekId:`w_${Date.now()}`,
    season, weekNumber,
    label:`Week ${weekNumber}`,
    roundLabel:'', espnWeekNumber:'',
    startDate, endDate,
    status: WEEK_STATUS.DRAFT,
    dataSourceMode: DATA_SOURCE_MODE.MANUAL,
    picksOpenAt:null, picksLockAt:null,
    // Auto-transition config. Defaults preserve the previous behavior for
    // existing weeks (which lacked these fields) — a missing value is read as
    // the default in the accessor helpers below, so old data still works.
    // autoLockOffsetMinutes = minutes BEFORE first kickoff to auto-lock.
    // Commissioner can override picksLockAt to a specific time to bypass.
    autoLockOffsetMinutes: 30,
    autoLiveEnabled: true,        // auto-transition LOCKED → LIVE at first kickoff
    autoFinalizeEnabled: true,    // when all games final, mark ready for final confirm
    pendingFinalization: false,   // set true when auto-final trigger fires; commissioner confirms
    showInHistory: true,
    blurb:'', recap:'', emailSentAt:null,
    tiebreakerQuestion:'What is the total combined points scored by all alma mater teams on the slate this week?',
    tiebreakerType: TIEBREAKER_TYPE.ALMA_MATER_TOTAL,
    tiebreakerCalculationMode: TIEBREAKER_CALC_MODE.SELECTED_SLATE_ONLY,
    actualTiebreakerValue:null, tiebreakerFinalized:false,
    extraPointEnabled:true, extraPointActual:null, extraPointDetect:null,
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    lockedAt:null, finalizedAt:null,
  };
}

// Read helpers for auto-transition config with safe defaults for pre-v0.17.1 weeks.
export function getAutoLockOffsetMinutes(week) {
  const v = week?.autoLockOffsetMinutes;
  return Number.isFinite(v) && v >= 0 ? v : 30;
}
export function getAutoLiveEnabled(week) {
  return week?.autoLiveEnabled !== false; // default true
}
export function getAutoFinalizeEnabled(week) {
  return week?.autoFinalizeEnabled !== false; // default true
}

// ─── ESPN MULTI-SPORT ENDPOINTS ──────────────────────────────────────────────
// Base path map for ESPN's public scoreboard API. Same shape for every sport,
// so one polling routine can serve CFB + NFL (and easily extend).
// Doc reference: site.api.espn.com/apis/site/v2/sports/<sport>/<league>/scoreboard
export const ESPN_SPORT_ENDPOINTS = {
  'college-football': {
    label: 'College Football',
    path: 'football/college-football',
    // A CFB event ID is what the existing pipeline uses; nothing new to do here.
  },
  'nfl': {
    label: 'NFL',
    path: 'football/nfl',
  },
  // Extend by adding more entries as needed — the fetcher is generic.
};

/** Resolve the ESPN base path for a game's sport, defaulting to CFB. */
export function espnSportPath(sportKey) {
  const s = ESPN_SPORT_ENDPOINTS[sportKey || 'college-football'];
  return s ? s.path : ESPN_SPORT_ENDPOINTS['college-football'].path;
}

export function createGame(weekId, overrides={}) {
  return {
    gameId:`g_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    weekId, espnEventId:null,
    dataQuality: DATA_QUALITY.MANUAL,
    dataSource:  DATA_SOURCE_MODE.MANUAL,
    homeTeam:'', awayTeam:'',
    homeMascot:'', awayMascot:'',
    homeConference:'', awayConference:'',
    homeRank:null, awayRank:null,
    kickoff:null,
    kickoffConfirmed: false,
    kickoffDateOnly:  false,
    timeWindow:'afternoon',
    spread:null, favorite:null, spreadSource:'manual', oddsProvider:null,
    lockedSpread:null,
    homeScore:null, awayScore:null,
    status:'scheduled', actualWinner:null, atsWinner:null,
    isAlmaMaterGame:false,
    venue:null, venueDisplay:null, neutralSite:false,
    // Scoring multiplier — default 1.0 keeps behavior identical to pre-multiplier
    // weeks. Commissioner sets 2 (or 1.5, 3, etc.) for marquee/rivalry/playoff
    // games. Wins AND losses scale equally by this factor so a 2x game gives
    // +2 or -2 in the standings math. Tiebreakers are NOT multiplied — they
    // remain a separate numeric guess used only for tiebreaks.
    multiplier: 1,
    // Manual / out-of-league game flag. When true the game is NOT part of the
    // normal ESPN CFB pipeline — it's an ad-hoc pick the commissioner added
    // (e.g. NFL Thanksgiving). Manual games still flow through the SAME
    // scoring pipeline as CFB games (multiplier, spread, results) — the flag
    // just controls UI cues (league chip, ESPN link visibility, refresh sport).
    isManual: false,
    leagueLabel: '',      // e.g. "NFL", "Special", "Thanksgiving" — shown as a small chip
    // Multi-sport ESPN linking for manual games. When espnEventId + espnSport
    // are both set on a manual game, the auto-refresh pipeline queries the
    // matching ESPN scoreboard so live scores update the same way they do for
    // CFB. Values are the string keys used by `ESPN_SPORT_ENDPOINTS` below.
    // Unset → the game stays fully manual (commissioner types scores).
    espnSport: null,      // 'nfl' | 'college-football' | null
    lastUpdated:null,
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    ...overrides,
  };
}

export function createPick(weekId, gameId, playerId, selectedTeam) {
  return {
    pickId:`pk_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    weekId, gameId, playerId, selectedTeam,
    selectedAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    locked:false, result:'pending',
  };
}

// ─── SPREAD DISPLAY ───────────────────────────────────────────────────────────

/**
 * Format spread for display: always "FavoredTeam -N.N"
 * Never shows plus sign. Always shows negative for the favorite.
 * If favorite is missing, derives it from spread sign + game.homeTeam/awayTeam.
 * Examples:
 *   formatSpread(-6.5, 'TCU')                              → "TCU -6.5"
 *   formatSpread(7.0, 'Indiana')                           → "Indiana -7.0"
 *   formatSpread(-6.5, null, {homeTeam:'TCU',awayTeam:'UNC'})→ "TCU -6.5"
 *   formatSpread(7.0,  null, {homeTeam:'IU',awayTeam:'PU'})  → "PU -7.0"
 *   formatSpread(0,    null, {homeTeam:'A',awayTeam:'B'})    → "PK"
 *   formatSpread(null)                                     → "TBD"
 */
export function formatSpread(spread, favorite, game = null) {
  if (spread === null || spread === undefined) return 'TBD';
  let fav = favorite || null;

  // If favorite not explicitly given, derive from spread sign + game teams
  if (!fav && game) {
    if (spread < 0)      fav = game.homeTeam;
    else if (spread > 0) fav = game.awayTeam;
    // spread === 0 stays Pick'em (no favorite)
  }

  const abs = Math.abs(spread);
  if (spread === 0) return fav ? `${fav} PK` : 'PK';
  if (!fav) return spread < 0 ? `-${abs}` : `+${abs}`;
  return `${fav} -${abs}`;
}

// ─── DATE / LABEL HELPERS ─────────────────────────────────────────────────────

export function formatWeekLabel(week) {
  if (!week) return '';
  const weekPart = week.roundLabel
    ? `Week ${week.roundLabel}`
    : (week.label?.startsWith('📋') || week.label?.startsWith('Historical')
        ? week.label
        : `Week ${week.weekNumber}`);

  if (week.dataSourceMode === 'demo') return weekPart;
  if (week.startDate && week.endDate && week.startDate !== week.endDate) {
    return `${weekPart} — ${fmtDate(week.startDate)}–${fmtDate(week.endDate)}`;
  }
  if (week.startDate) return `${weekPart} — ${fmtDate(week.startDate)}`;
  return weekPart;
}

function fmtDate(ds) {
  if (!ds) return '';
  try { return new Date(ds+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
  catch { return ds; }
}

export function sourceModeLabelOf(mode) {
  return { demo:'Demo', espn_live:'ESPN Live', espn_historical:'ESPN Historical', manual:'Manual', proposed:'Proposed' }[mode] || mode || '—';
}

/**
 * Format kickoff time with TBD awareness.
 */
export function formatGameTime(isoTime, tzKey='PT', game=null) {
  const confirmed = game?.kickoffConfirmed ?? true;
  const dateOnly  = game?.kickoffDateOnly  ?? false;
  if (!isoTime) return 'TBD';
  const tz = TIME_ZONES.find(z=>z.key===tzKey) || TIME_ZONES[0];
  try {
    const d    = new Date(isoTime);
    const day  = d.toLocaleDateString('en-US',{weekday:'short',timeZone:tz.iana});
    const date = d.toLocaleDateString('en-US',{month:'numeric',day:'numeric',timeZone:tz.iana});
    if (dateOnly || !confirmed) return `${day} ${date} · Time TBD`;
    const time = d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:tz.iana});
    return `${day} ${date} ${time} ${tzKey}`;
  } catch { return 'TBD'; }
}

export function formatVenueDisplay(game) {
  if (!game) return null;
  if (game.venueDisplay) return game.venueDisplay;
  if (game.venue) return game.venue;
  return null;
}

/** Get player initials — use stored initials if set, else first letter of display name */
export function getPlayerInitials(player) {
  if (!player) return '?';
  return player.initials || player.displayName?.charAt(0)?.toUpperCase() || '?';
}

/**
 * Classify how "ready" a game's data is, for validation / warning UX.
 * Returns { ready:boolean, level:'ok'|'warn'|'incomplete', issues:[...] }.
 *
 *  - 'ok'         : has both teams, a confirmed kickoff time, and a spread
 *  - 'warn'       : usable but missing something soft (time TBD or spread TBD)
 *  - 'incomplete' : missing required data (no teams, or no date at all) — should
 *                   NOT be presented to players as a normal game
 *
 * This replaces ad-hoc "is the kickoff null" checks scattered across the UI and
 * gives the Commissioner panel a single source of truth for the pending state.
 */
export function gameDataReadiness(game) {
  const issues = [];
  if (!game) return { ready:false, level:'incomplete', issues:['No game'] };

  if (!game.homeTeam || !game.awayTeam) issues.push('Missing team name(s)');

  const hasDate = !!game.kickoff;
  if (!hasDate) {
    issues.push('No kickoff date set');
  } else if (game.kickoffDateOnly || game.kickoffConfirmed === false) {
    issues.push('Kickoff time not confirmed (date only)');
  }

  const sv = game.lockedSpread !== null && game.lockedSpread !== undefined ? game.lockedSpread : game.spread;
  if (sv === null || sv === undefined) {
    // A finalized game legitimately may have no spread; only warn pre-final.
    if (game.status !== GAME_STATUS.FINAL) issues.push('No spread set');
  }

  // Determine level
  let level;
  if (!game.homeTeam || !game.awayTeam || !hasDate) {
    level = 'incomplete';
  } else if (issues.length) {
    level = 'warn';
  } else {
    level = 'ok';
  }
  return { ready: level !== 'incomplete', level, issues };
}


// ── Team abbreviations (SHARED SOURCE) ───────────────────────────────────────
// Moved here from app.js in v0.17.2 so the compact dashboard, the picks page,
// and chat all render identical shorthand. data-model.js has no imports, so
// every other module can pull from it without a cycle.
// DO NOT create a second mapping anywhere. Import buildAbbrMap from here.

export const TEAM_ABBR = {
  // SEC
  'Alabama':'BAMA','Arkansas':'ARK','Auburn':'AUB','Florida':'FLA','Georgia':'UGA',
  'Kentucky':'UK','LSU':'LSU','Mississippi':'OLE','Ole Miss':'OLE','Mississippi State':'MSST',
  'Missouri':'MIZZ','Oklahoma':'OU','South Carolina':'SCAR','Tennessee':'TENN','Texas':'TEX',
  'Texas A&M':'TAMU','Vanderbilt':'VAN',
  // Big Ten
  'Illinois':'ILL','Indiana':'IND','Iowa':'IOWA','Maryland':'MD','Michigan':'MICH',
  'Michigan State':'MSU','Minnesota':'MINN','Nebraska':'NEB','Northwestern':'NW','Ohio State':'OSU',
  'Oregon':'ORE','Penn State':'PSU','Purdue':'PUR','Rutgers':'RUT','UCLA':'UCLA','USC':'USC',
  'Washington':'WASH','Wisconsin':'WISC',
  // Big 12
  'Arizona':'ARIZ','Arizona State':'ASU','Baylor':'BAY','BYU':'BYU','Cincinnati':'CIN',
  'Colorado':'COLO','Houston':'HOU','Iowa State':'ISU','Kansas':'KU','Kansas State':'KSU',
  'Oklahoma State':'OKST','TCU':'TCU','Texas Tech':'TTU','UCF':'UCF','Utah':'UTAH',
  'West Virginia':'WVU',
  // ACC
  'Boston College':'BC','California':'CAL','Clemson':'CLEM','Duke':'DUKE','Florida State':'FSU',
  'Georgia Tech':'GT','Louisville':'LOU','Miami':'MIA','NC State':'NCST','North Carolina':'UNC',
  'Notre Dame':'ND','Pittsburgh':'PITT','SMU':'SMU','Stanford':'STAN','Syracuse':'SYR',
  'Virginia':'UVA','Virginia Tech':'VT','Wake Forest':'WAKE',
  // AAC + selected G5
  'Army':'ARMY','Charlotte':'CHAR','East Carolina':'ECU','Florida Atlantic':'FAU','Memphis':'MEM',
  'Navy':'NAVY','North Texas':'UNT','Rice':'RICE','South Florida':'USF','Temple':'TEMP',
  'Tulane':'TULN','Tulsa':'TLSA','UAB':'UAB','UTSA':'UTSA',
  // Mountain West
  'Air Force':'AF','Boise State':'BOIS','Colorado State':'CSU','Fresno State':'FRES',
  'Hawaii':'HAW','Nevada':'NEV','New Mexico':'UNM','San Diego State':'SDSU','San Jose State':'SJSU',
  'UNLV':'UNLV','Utah State':'USU','Wyoming':'WYO',
  // Sun Belt
  'Appalachian State':'APP','Arkansas State':'ARST','Coastal Carolina':'CCAR','Georgia Southern':'GASO',
  'Georgia State':'GAST','James Madison':'JMU','Louisiana':'ULL','Louisiana Monroe':'ULM',
  'Marshall':'MARS','Old Dominion':'ODU','South Alabama':'USA','Southern Miss':'USM',
  'Texas State':'TXST','Troy':'TROY',
  // MAC
  'Akron':'AKR','Ball State':'BALL','Bowling Green':'BGSU','Buffalo':'BUFF','Central Michigan':'CMU',
  'Eastern Michigan':'EMU','Kent State':'KENT','Massachusetts':'UMASS','Miami (OH)':'M-OH',
  'Northern Illinois':'NIU','Ohio':'OHIO','Toledo':'TOL','Western Michigan':'WMU',
  // CUSA
  'FIU':'FIU','Jacksonville State':'JVST','Liberty':'LIB','Louisiana Tech':'LT','Middle Tennessee':'MTSU',
  'New Mexico State':'NMSU','Sam Houston':'SHSU','UTEP':'UTEP','Western Kentucky':'WKU',
  // Independents
  'Connecticut':'UCONN','UConn':'UCONN',

  // ── ESPN long-form / alternate location strings ────────────────────────────
  // homeTeam/awayTeam come from ESPN's `team.location` (data-provider.js ~L280),
  // which is NOT stable across schools or seasons — some return the marketing
  // initialism ("USC"), some the full school name ("Southern California").
  // A miss here silently degrades to the initials fallback, which is how
  // "Southern California" rendered as "SC" while the dashboard said "USC".
  // Every alias below resolves to a school ALREADY keyed above — these add no
  // new abbreviations, they only stop known schools falling through.
  'Southern California':'USC',        // corroborated: ALMA_MATER_EXACT_PATTERNS.USC, this file
  'Miami (FL)':'MIA',                 // disambiguated counterpart of 'Miami (OH)'
  'Louisiana State':'LSU',
  'Texas Christian':'TCU',
  'Brigham Young':'BYU',
  'Central Florida':'UCF',
  'Southern Methodist':'SMU',
  'North Carolina State':'NCST',
  'Florida International':'FIU',
  'Middle Tennessee State':'MTSU',
  'Southern Mississippi':'USM',
  'Sam Houston State':'SHSU',
  'Army West Point':'ARMY',
  'Pitt':'PITT',
  'UMass':'UMASS',
  // Hawaii ships with three different apostrophes depending on the feed:
  // ASCII ('), typographic (’), and the Hawaiian okina (ʻ). All are one school.
  "Hawai'i":'HAW','Hawai’i':'HAW','Hawaiʻi':'HAW',
  // San Jose State's ESPN location carries the accent.
  'San José State':'SJSU',
  // Louisiana's two branch campuses appear hyphenated and as "UL X".
  'Louisiana-Lafayette':'ULL','UL Lafayette':'ULL',
  'Louisiana-Monroe':'ULM','UL Monroe':'ULM',
};

/**
 * Build a Map<schoolName, uniqueAbbr> for all teams in a list of games.
 * Falls back to a smart-truncate for unknown schools, then runs a dedup pass
 * so no two teams in the same render share an abbreviation (appending the
 * first letter of the dropped word, e.g. "Sam Houston State" vs "Texas State"
 * → SHSU vs TXST already; "X State" vs "X State" gets X-1, X-2 as last resort).
 */
export function buildAbbrMap(games) {
  const map = new Map();
  const smartTrunc = (name) => {
    if (!name) return '';
    if (TEAM_ABBR[name]) return TEAM_ABBR[name];
    const words = name.split(/\s+/).filter(Boolean);
    // Single-word names: take first 4 chars uppercase.
    if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
    // Multi-word: take first letter of each word, max 5 chars (handles "A&M" specifically).
    const initials = words.map(w => w.replace(/[^A-Za-z&]/g,'').charAt(0)).join('').toUpperCase().slice(0,5);
    return initials || words[0].slice(0,4).toUpperCase();
  };

  const teams = new Set();
  for (const g of games) {
    if (g.homeTeam) teams.add(g.homeTeam);
    if (g.awayTeam) teams.add(g.awayTeam);
  }
  // First pass: assign best-known abbreviation
  for (const t of teams) map.set(t, smartTrunc(t));

  // Dedup pass: any two teams sharing an abbreviation get suffixed
  const byAbbr = new Map();
  for (const [team, abbr] of map) {
    if (!byAbbr.has(abbr)) byAbbr.set(abbr, []);
    byAbbr.get(abbr).push(team);
  }
  for (const [abbr, teamList] of byAbbr) {
    if (teamList.length === 1) continue;
    // Try to use a more distinctive abbreviation — take first 3 chars of the
    // first DIFFERENT word in each name. If still colliding, add a numeric suffix.
    teamList.forEach((team, i) => {
      const words = team.split(/\s+/).filter(Boolean);
      // Pick the first word that's distinctive (not "State", "University" etc.)
      const distinctive = words.find(w => !/^(state|university|college|the|of)$/i.test(w)) || words[0];
      const candidate = (distinctive.slice(0,3) + abbr.slice(-1)).toUpperCase();
      map.set(team, candidate);
    });
    // After replacement, do one final dedup check — append numeric suffix to any still-colliding
    const seen = new Map();
    for (const team of teamList) {
      const a = map.get(team);
      if (!seen.has(a)) { seen.set(a, 1); }
      else { const n = seen.get(a) + 1; seen.set(a, n); map.set(team, a.slice(0, 3) + n); }
    }
  }
  return map;
}

/**
 * Shorthand for one team, using the shared table with the same smart-truncate
 * fallback as buildAbbrMap. Use buildAbbrMap when you have a slate — it also
 * dedups across the render so two teams never share an abbreviation.
 */
export function teamAbbr(name) {
  if (!name) return '';
  if (TEAM_ABBR[name]) return TEAM_ABBR[name];
  const words = String(name).split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  const initials = words.map(w => w.replace(/[^A-Za-z&]/g, '').charAt(0)).join('').toUpperCase().slice(0, 5);
  return initials || words[0].slice(0, 4).toUpperCase();
}

// ─── DEBT-PAYMENT APPROVAL (UN-89) ─────────────────────────────────────────
// One state machine, shared by BOTH the current-season obligation ledger
// (`cfbp_obligations`, full records) and the 2K25 carryover ledger
// (`settings.ob2025`, a status-map overlay on baked history — see
// history-2025.js `ob2025Status()`). Both shapes carry `payerPlayerId` /
// `recipientPlayerId`, so obligationRole()/obligationNextStatus() work
// unmodified against either one. Pure — no storage access — so every
// transition is unit-testable without a DOM.

/** Status → { label, badgeClass }. ONE table so Standings, the commissioner
 *  Players-tab card, and the 2K25 carryover card can never disagree about
 *  what a status is called or which (pre-existing) badge color it gets.
 *  Reuses existing badge classes only — no new CSS variable, no theme risk. */
export const OBLIGATION_STATUS_DISPLAY = {
  unpaid:  { label: 'Unpaid',  badgeClass: 'badge-locked' },
  pending: { label: 'Pending', badgeClass: 'badge-nd' },
  paid:    { label: 'Paid ✓',  badgeClass: 'badge-open' },
  waived:  { label: 'Waived',  badgeClass: 'badge-final' },
};
export function obligationStatusDisplay(status) {
  return OBLIGATION_STATUS_DISPLAY[status] || OBLIGATION_STATUS_DISPLAY.unpaid;
}

/**
 * A viewer's relationship to one obligation. Priority: admin > creditor >
 * payer > bystander. An admin who ALSO happens to be the payer or the
 * creditor still gets commissioner-level authority — the spec's rule is that
 * the commissioner's own action always IS the verification, with no carve-out
 * for "unless it's their own debt." `sess` is `{isAdmin, playerId}` (the
 * shape `getSession()` already returns).
 */
export function obligationRole(sess, ob) {
  const isAdmin = !!sess?.isAdmin;
  const playerId = sess?.playerId;
  if (isAdmin) return 'admin';
  if (playerId && ob && playerId === ob.recipientPlayerId) return 'creditor';
  if (playerId && ob && playerId === ob.payerPlayerId) return 'payer';
  return 'bystander';
}

/**
 * Pure obligation state-machine transition. Returns the NEXT status string,
 * or `null` if this (status, role, action) combination is not a legal move —
 * callers must refuse the action (and re-check role server-side; the UI
 * hiding a button is not a permission boundary by itself).
 *
 *   unpaid  --payer "mark"-->             pending   (needs confirmation)
 *   unpaid  --creditor/admin "mark"-->    paid      (their action IS the verification)
 *   pending --creditor/admin "confirm"--> paid
 *   pending --creditor/admin "deny"-->    unpaid
 *   paid    --admin "undo"-->             unpaid    (pre-existing affordance, unchanged)
 *
 * Nothing here ever multiplies or scores anything (CONVENTIONS #22-23) —
 * obligations are drink debts, not pick results.
 */
export function obligationNextStatus(status, role, action) {
  if (status === 'unpaid' && action === 'mark') {
    if (role === 'payer') return 'pending';
    if (role === 'creditor' || role === 'admin') return 'paid';
    return null;
  }
  if (status === 'pending' && action === 'confirm' && (role === 'creditor' || role === 'admin')) return 'paid';
  if (status === 'pending' && action === 'deny' && (role === 'creditor' || role === 'admin')) return 'unpaid';
  if (status === 'paid' && action === 'undo' && role === 'admin') return 'unpaid';
  return null;
}
