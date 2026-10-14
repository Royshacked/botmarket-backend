# The Floor's Lists column and the month Calendar

**Status: BUILD RECORD — shipped 2026-10-14** (frontend `8f9bfd6`, backend `639c4d5` + bundle `26d242f`),
driven end to end by `scripts/drive-floor-lists.mjs`. QA / CR cycle: §6. Decided with Roy in one
session, 2026-10-14; the frontend wiring is in `../botmarket-frontend/docs/architecture.md`.

## 1. The Lists column (the Floor's right column)

Three UI questions, answered as recommended:

| Question | Decision | Why |
|---|---|---|
| All desk titles visible, or a menu? | Visible. While a desk is open the other headers still fold away, but a **chip strip** above the list shows every desk with its count; a chip switches desks | The counts are the column's value ("Awaiting orders (2)" means someone is blocked); a menu, or the old full fold, hid them |
| Do empty desks still appear? | Yes, **dimmed**, in place | The column is read by position — a desk that vanished at zero would move every header below it; and a new user must learn the desk exists. Empty = no ROWS (the research queue counts only `queued`, so an all-in-research backlog is not empty) |
| Where does an item's detail show? | The list stays in the column; a page of reading opens in the DetailPanel over the chat (unchanged). Consolidating the setup / idea pop-outs onto the panel was offered and NOT taken |

And, in the same session: no "Admin" / "Calendar" group captions; the "Lists" heading sticky while
the closed desks scroll; desk titles 36px (`$desk-h`), not the 54px column-heading height; renamed
**Your trades** (was Trading floor), **Your portfolios** (Portfolio floor), **Watchlists** (Scans);
**Events radar hidden** (`hidden: true` — rows, counts and sorts still work; MainPage still loads its
candidates); **Research queue last**. A desk request naming a hidden or panel desk is ignored.

The desk KEYS did not change (`trade`, `portfolio`, `scans`, …): sorts in localStorage, desk requests
and tests address keys, not labels.

## 2. The Calendar — decisions

The Earnings, Fed and IPO desks (each a week-long list in the narrow column) became ONE desk:

| Question | Decision |
|---|---|
| Where does it open? | The **middle column** (DetailPanel over the chat) — a month is a grid and needs the width: ~106px cells there against ~55px in the lists column |
| What happens to Earnings / Fed / IPO? | **Replaced.** The date page shows the same rows, so nothing is lost |
| How far does it reach? | **A month view with ‹ › navigation**, past and coming |
| Important Fed releases? | **Marked and named** on their day: the feed's `impact: 'high'` releases — Jobs, CPI, PCE, GDP, FOMC. PPI / JOLTS / Retail (medium) are counted, not marked |

Each day shows its counts; a clicked day **replaces** the grid with that date's page (Fed, IPOs,
Earnings), "‹ October" returns, ‹ › step a day. An earnings or IPO row closes the panel and hands the
event to Mentor (the same `onEarningSelect` / `onIpoSelect` the old desks used) — Mentor is in the
chat column under the panel. The header reads ‹ October ›; the name returns to this month.

## 3. The backend — two reads that cost differently

| Route | Returns | Cost |
|---|---|---|
| `GET /api/calendar/counts?from&to` | `{ days: { date: { earnings, fed, ipo, fedHigh? } } }` | No profile lookups. ≤62 days (a month plus its padding weeks), real dates, ordered — else 400 |
| `GET /api/calendar/day/:date` | `{ earnings, fed, ipo }` for one date | Earnings biggest-first by revenue estimate; names/logos from the profile cache (`peekCompanyProfile`) plus at most 24 live lookups |

**The Finnhub cap** (sampled before building, 2026-10-14): the earnings calendar answers at most
1,500 rows and drops the EARLIEST dates to fit — an October request came back starting on the 8th,
November on the 10th; peak days run 350–485 names. Sampled again against small windows: in a capped
answer every day matches except the earliest one returned, which is cut (Oct 8: 5 of 15; Nov 10: 228
of 399; Oct 29: 198 of 352). So `readEarningsRange` — the ONE earnings read, the week list included
since the CR — asks 7-day chunks, keeps a capped answer's whole days and re-asks only that cut day
and the ones before it, day by day. Complete answers are cached an hour (an empty one too — a quiet
Saturday is a fact); a window with any failed part is served but never cached (the fetch now throws
with `onError: 'throw'`, so "could not ask" is no longer an empty list). Fed:
`fetchFedEventsRange(from, to)` — `fetchFedEvents` (the rolling window, also read by
`eventRisk.service`) delegates to it; a window with a failed release is not cached; each release
carries a `short` name for the cells.

Measured live: a six-week grid in ~1s cold, 0.3s cached (two cold months 2.6s after the CR); Oct 29
2026 = 352 earnings (AMZN, LLY, MRK first), 3 Fed (GDP, PCE, Jobless Claims); a peak day's first open
~9s with 40 live lookups (24 since the CR).

The week endpoints (`/earnings`, `/fed`, `/ipo`) keep their output — the classic layout's Radar and
Axl's market-open card read them; `/earnings` now reads through the cap-aware path.

## 4. Known limits

- **FOMC dates are a static 2026 list** (`FOMC_DATES`, fred.provider) — a 2027 month shows no FOMC
  until next year's schedule is added (the Fed publishes it mid-year). Was already true of the Fed
  desk; since the CR a window past the list's end logs one warning per process.
- **A peak day's names are partial** on first open: past the 24 live lookups a row shows its ticker
  only, until the profile cache fills.
- ~~The removed desks' sort options~~ — deleted 2026-10-14 (Roy) with the `within` option only they
  used; a sort still saved for one in a browser falls back to default (pinned by a test).
- **The Floor still loads the week feeds** (`useCalendarEvents`) that only the classic layout reads
  now — three requests an hour, harmless.
- **Watchlists** is now a label in use; `user-watchlist.md` (design only, name "not decided") plans
  the user's own list as an extension of the same scan list.

## 5. Files

Backend: `api/calendar/calendar.{service,controller,routes}.js`, `providers/fred.provider.js`,
`providers/finnhub.provider.js`, `tests/unit/calendarMonth.test.js`, `scripts/drive-floor-lists.mjs`.
Frontend: `cmps/Floor/FloorLists.jsx`, `CalendarPanel.jsx`, `calendar.utils.js`, `CalendarRows.jsx`,
`Floor.scss`, `services/calendar/calendar.service.remote.js`, `pages/MainPage.jsx`.

## 6. QA / CR cycle (2026-10-14)

QA: backend suite **3951 / 0** (without `talosRecorder.test.js`, which hangs); `npm run lint` clean
repo-wide (it was failing on main — `drive-detail-panel.mjs` lacked the browser globals its
`page.evaluate` bodies use; fixed the same way as the new drive script). Frontend vitest **1282 / 0**;
`test:node` 430 / 3 — the three failures are on main without this change (two `chartOverlay` zone
cases that predate legs becoming prices, and `coverageRoute.test.js` failing at load); frontend lint
has 5 warnings, all in untouched files. Drive: `drive-floor-lists.mjs` **23 / 23**, twice.

Two high-effort reviews, one per repo; every finding checked against the code. No high severity.

| | Where | What | Done |
|---|---|---|---|
| 1 | `calendar.service` `earningsRowsInRange` | A day that failed inside a capped chunk (the provider turned a 429 into an empty list) was cached for an hour as part of the chunk — a quiet Monday in the grid. medium | The fetch throws (`onError: 'throw'`); `readEarningsRange` returns `{ rows, complete }`; a window with a failed part is served, never cached. Complete empty answers ARE cached now |
| 2 | same | A capped chunk was re-asked for EVERY day — a cold peak-season month near Finnhub's 60/min with the day page's lookups on top. low–medium | Sampled which days a capped answer cuts (only the earliest returned); keeps the whole days, re-asks only the cut ones. Live lookups per day 40 → 24 |
| 3 | `getEarnings` | The week list kept the cap-blind single ask: a 350-a-day week loses its Monday there while the grid shows it. low–medium | Reads through `earningsRowsInRange` — one path |
| 4 | `fred.provider` | FOMC list ends 2026 while the calendar browses any month. low | Logs once per process past the list's end; the dates themselves are still to add |
| 5 | `fred.provider` | A window with a failed release was cached 6h. low, pre-existing | Not cached when any release failed |
| 6 | `CalendarPanel` | The month was reset on CLOSE; the panel lives all session, so closed on Oct 31 it reopened on October on Nov 1. medium–low | Decided at the open, in render (so the old month is never fetched) |
| 7 | `CalendarPanel` | A clicked day unmounted the focused cell; focus fell to `<body>`. low–medium | The day page takes focus; back returns it to the day's cell |
| 8 | `CalendarPanel` | A padding-row day kept the old month while › moved it, so "back" disagreed. low | Both go through `goDay` |
| 9 | `Floor.scss` | The shared "opened row" mark drew a clipped bar on the Calendar chip's pill. low | Overridden on the chip; its `--active` border carries it |
| 10 | `FloorLists.test.jsx` | One case made a real HTTP request and passed on its failure. low | The calendar service is mocked |

Not changed: the reviewer's call to drop the CSS-text test of the sticky heading — guarding a rule by
its text is this repo's pattern for what jsdom cannot measure (see the column-scroll test beside it).
Line endings: the index is LF throughout (git autocrlf); this change normalised `fred.provider.js`,
the one file stored with CRs, which is why its first diff shows every line.
