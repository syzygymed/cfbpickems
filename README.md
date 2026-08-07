# 🏈 IRB Pick 'Ems

A private college-football against-the-spread pick'em league app for six degenerates and one records custodian. Mobile-first PWA, free to host, no framework, no build step.

**Current revision: v0.17.0 (2026-08-05) · Phase III**

Live at: `https://ischemicrb.github.io/cfbpickems/` (a.k.a. irbfootball.com)

---

## What this app does

- **Weekly ATS picks** — commissioner builds a 10-game slate (ESPN-fed or manual); players pick blind against locked spreads; automatic grading, tiebreakers, weekly winners/losers, drink obligations.
- **Season standings** — weighted scoring with per-game multipliers, weekly history, obligations ledger, plus the permanently browsable **CFP 2K25 Historical Record** and its carryover drink debts.
- **League chat (one room)** — every message can carry a game tag; game "threads" are filtered views of the single room. Pick-reveal ritual at lock, live game threads, one-tap callouts, the 🏛 Hall of Records, presence, read receipts, nicknames and accent colors, in-app notifications (toasts, title badge, PWA icon badge, mention inbox, optional sound). No push, by design — measured first.
- **S.C.R.I.B.E.** — Spread Coverage Records & Ischemic Banter Engine. The league's seventh member: deadpan, clinical, rationed. Documents locks, finals, adverse events, live-game complications, outstanding balances, and anniversaries. It is not summoned. It is on duty.
- **Ischemic Extra Point** — longest-FG blackjack side game with ESPN auto-detection and commissioner override.
- **Recaps** — SCRIBE-voiced Chart Review of last week under the picks list; Week 1 shows the baked 2K25 Permanent Record automatically.

## Architecture (the short version)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla JS ES modules, PWA, GitHub Pages | Deploy = git push; debuggable on phones (AD-01) |
| Storage seam | Everything through `load()`/`save()` in `storage.js` | One choke point made Sheets a drop-in; makes any future backend a drop-in (AD-02) |
| League data | Google Sheets key/value blob via Apps Script, debounced pushes, loud-fail | Free, commissioner-inspectable (AD-04, AD-06) |
| Chat | Append-only event log (own sheet + endpoints), order-independent client fold, ONE room + `gameTag` | Blob last-write-wins would eat concurrent messages (AD-09, AD-17) |
| Chat transport | `chatTransport.js` is the ONLY module touching the chat backend; two-phase cached-head polling, adaptive intervals + jitter | Quota survival now, one-file Supabase swap later (AD-16) |
| Boot | localStorage mirror primes paint <1s; hydrate in background; PIN gate is an overlay | Apps Script cold starts are 10–20s (AD-08) |
| Spreads | Signed, home perspective (negative = home favored) | One formula: `adjustedHome = homeScore + spread` (AD-03) |

Full decision log, regression history, and the complete Phase I→III requirements matrix: **`DEVELOPMENT_LEDGER.md`** (the single source of institutional memory — the old REQUIREMENTS_TEST_MATRIX is merged into it).

## File map

```
index.html                 shell + nav (picks · dashboard · standings · chat · rules · comm)
service-worker.js          network-first PWA cache (bump CACHE_NAME every release)
config.json                backend URL + token — devices auto-connect (Option A)
css/styles.css             all styling incl. themes (default: neutral slate)
js/
  app.js                   pages, commissioner panel, boot, score refresh
  storage.js               THE seam — every read/write, prefs, obligations
  backend.js               Sheets sync: mirror, hydrate, debounced push, loud-fail
  chatTransport.js         the only chat-backend toucher (AD-16)
  chat.js                  event fold, outbox, unread, presence, digest
  chat-ui.js               chat page, sheet, toasts/badges, system emitters, SCRIBE hooks
  scribeLines.js           SCRIBE Tier 0: pools, triggers, rate limits, no-repeat ledger
  extra-point.js           blackjack grading + ESPN longest-FG detection
  recap.js                 weekly Chart Review + Week-1 Permanent Record
  history-2025.js          the audited CFP 2K25 season of record
  scoring.js               ATS math, weekly results, season standings
  data-provider.js         ESPN fetch/scoring pipeline, Central-time buckets
  data-model.js            factories, constants, demo data, themes
  notifications.js         in-app toast helper (app-level)
backend/Code.gs            Apps Script: KV store + chat endpoints + presence + metrics
loadtest.mjs               MANDATORY test — imports all 14 modules, chat fold suite, EP suite
```

## Deploying a release

1. Bump the trio: `APP_VERSION` (app.js) · `CACHE_NAME` (service-worker.js) · `?v=` (index.html).
2. `node loadtest.mjs` → must print ALL PASS.
3. Push to GitHub Pages.
4. **If Code.gs changed**: paste it into the Apps Script editor, run `setup()` once if new sheets were added, then **Deploy → Manage deployments → Edit → New version** (same deployment — a *new* deployment changes the URL and breaks `config.json`). Verify with Commissioner → Settings → 🩺 chat diagnostics.

## Setup docs

- `CROSS_DEVICE_SETUP.md` — one-time Sheet + Apps Script + config.json setup (commissioner only)
- `PUBLISHING.md` — GitHub Pages + custom domain
- `UPGRADE_NOTES_v0.17.0.md` — this release's deploy steps and post-deploy checklist
- `BACKEND_MIGRATION.md` — when/how chat would move to Supabase (triggers + shape)
- `GOOGLE_SSO_PLAN.md` — deferred Phase III auth plan
- `SECURITY_ROADMAP.md` — Phase III security tracking

## League constants

Six players (Drew, Brayden, Kevin, Koby, Jacob, Kihoon) + SCRIBE. Site PIN gates the app; per-player PINs gate identity. Picks are blind until lock — and no automation, system event, or chip may reveal a selection before then. Drinks are payable in person. Savage about football, never about real life.
