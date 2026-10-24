# The horizon chains — every horizon automatic, and the Hotlist a list per horizon

**Status: BUILT 2026-10-23 (Roy: "go ahead, write the doc and build") — steps 1-4 unit-tested, Argus per horizon
live-checked on a stored board, the Hotlist tabs driven in a browser (`scripts/drive-hotlist-horizons.mjs`). Not pushed.**

## What Roy asked for

Three chains, each running by itself — nobody activates Argus or Prometheus:

| Horizon | Chain | What arrives |
|---|---|---|
| **Long swing / long term** (3m–24m) | Pythia → Argus → Prometheus | covered names with a VALUATION target and its horizon — built ([house-research-chain.md](./house-research-chain.md)) |
| **Short swing** (2–10 days, the Hotlist's `week`) | Hotlist → Argus → Prometheus | names with a CATALYST target, a 1-month horizon and a valid-until date — **this doc** |
| **Day trade** (open · mid-day · into close · tomorrow) | Hotlist → Argus | names with their room (free range) and their time in the session — **this doc** (Argus already reads every board; he now picks per horizon) |

And in the Hotlist: **a list per horizon**.

## The reasoning (2026-10-23 conversation)

- **As the horizon shrinks, the question changes** from "what is the business worth" to "is this catalyst real, how much
  of it is priced, and what can blow up inside the window". A 12-month valuation target says nothing about a 5-day trade.
- **"Priced in" needs a yardstick — a target** (Roy: "how do we know how much priced if Prometheus doesn't give a PT?").
  The short-swing target is a CATALYST target: what the price was before the catalyst, plus what the catalyst is worth
  at a constant multiple (`compute_event_delta`, the quick read's arithmetic), with a band. Remaining = target − price.
  Cross-checked against the options' implied move and the stock's own history of like events.
- **News-driven moves continue; no-news moves reverse** (Chan 2003; post-earnings drift). Whether a move has a real story
  under it is the most useful thing Prometheus can say at this horizon.
- **Dailies are executed on technicals but CHOSEN on catalyst and flow** — the Hotlist's screener, news labels and
  Argus's read do that; Prometheus stays out of the intraday columns.

## The design

### 1. The Hotlist — a list per horizon (frontend)

Today's list gets horizon tabs: **All · Open · Mid-day · Into close · Tomorrow · This week**. A horizon's tab lists the
names graded on that column — Argus's picks for THAT horizon first, then grade, then room — and its Best/Room cells read
that column, not the name's best. On **This week**, a name with a catalyst read shows its target, what is still open,
and its valid-until.

### 2. Argus picks per horizon (backend)

Argus's board read picked at most 8 names across every column. He now picks **up to `HOTLIST_PICKS_PER_COLUMN` (5) per
column on the board** — still one call per board. A row carries `picks: { <column>: { why, caution, rank } }` beside the
old single `pick` (kept: the first, for the readers that have it). The day's list merges picks per column the way it
merges cells: the latest board that graded the column.

### 3. The catalyst read — Prometheus's short-swing mode (backend)

A mode of the research desk (like the quick read: `prompts/analyst_mode_catalyst.md`), not coverage:

- **Its own collection, `catalyst_reads`, NOT coverage.** Coverage is ONE document per symbol (a unique index): a 1-month
  catalyst target there would either be blocked by a name's long-term coverage or block one later, and Atlas sizes
  holdings off coverage. A catalyst read lives beside coverage, expires, and is never read by Atlas. *(In the
  conversation the recommendation was "inside coverage, marked"; the unique index decided against it.)*
- **What Prometheus does:** the catalyst (what, when, material?), news-driven or not, the record (filings, consensus
  revisions), what the catalyst is worth (`compute_event_delta`, with the move since the catalyst), positioning (short
  interest, options), event risk inside the window (earnings, FDA, lockup…). It emits `<catalyst_read>`.
- **What code does:** the target from his delta — `spot × (1 + remaining)`, band from the delta's low/high — the share
  already priced, the window (`1m`, `valid_until`), the price and SPY at the read. A `contradicted` or unsized read is
  stored with no target (a pass).
- **Graded at expiry** (the screener's off-session tick): `hit` when the price reached the target, else at valid-until
  `expired` with its return and SPY's over the window. One record per kind; never mixed with coverage's.

### 4. Hotlist → Argus → Prometheus, automatic (backend)

- **When:** after the **09:20 board** (`preopen` — open + week columns, the strict spreads), Argus's **This week** picks are
  queued for research (source `hotlist`), the board's facts and his why/caution on the row.
- **The run:** the same research run as the Pythia chain (`startRun({ symbols, maxUsd })`), in catalyst mode for these
  rows; the budget pipe of `houseResearch` shared, not copied — a **daily** budget: `HOTLIST_RESEARCH_MAX_USD` ($1) and
  `HOTLIST_RESEARCH_MAX_NAMES` (10) per ET day. A run already going → the names wait for the next screener tick (5 min).
- A name with a live catalyst read is not read again; a covered name IS read (a catalyst read never blocks or replaces
  coverage).

Everything stays behind `DAILY_SCREENER` — off, no boards, no picks, no reads.

## As built (2026-10-23)

- **§2** `hotlist.argus.js`: `MAX_PICKS` is now per column (5); a name may be a pick on two columns; the reply cap 4,000
  tokens. Rows carry `picks.<column>` = `{ why, caution, rank }` (`dailyScreener.checkpoint`), `pick` stays the first.
  `hotlist.service.dayList` merges picks by the cells' rule; `hotlistSeed` hands Mentor the pick of THE column.
  Live on the 08:00 board of 2026-10-23 (12 names): This week RCL, LMT; nothing for the open on a weak tape; $0.0008.
- **§3** `prompts/analyst_mode_catalyst.md` (mode `catalyst`, ledger key `analystAgent-catalyst`, emit tag
  `catalyst_read`), `services/catalystRead.service.js` (`catalyst_reads`: target = spot × (1 + open), band, priced
  share, window 5–30 days, `hit` / `expired` / `pass`). `researchRun` reads a `context.hotlist` row in that mode and
  saves it there — never `initiateCoverage`; a covered name still gets a read, a name with a LIVE read is skipped.
- **§4** `services/hotlistResearch.service.js` on the screener's monitor tick: `afterCheckpoint` (the `preopen` board's
  week picks → queue source `hotlist` → the run), `resume` (today's names), and the hourly grading. The budget pipe is
  `houseResearch.researchQueued` / `resumeQueued`, shared with the Pythia week. Env: `HOTLIST_RESEARCH` (on unless
  `false`), `HOTLIST_RESEARCH_MAX_NAMES` (10/day), `HOTLIST_RESEARCH_MAX_USD` ($1/day). `GET /api/hotlist/reads`.
- **§1** `HotlistPanel`: the horizon tabs above Today's list, the row reading THAT column (grade, room, ★ rank), the
  Target column and Prometheus's read on This week.

## Found live (2026-10-23) — fixed the same day

- **A run-up cannot be sized by the event delta.** The first live read (RCL, a week pick with its report on Oct 27)
  came back `unclear` — a pass, no target, $0.026: the catalyst has NOT happened, so `compute_event_delta` has nothing
  to size, and Prometheus said so. Most week names are exactly this (status "setting up": quiet, a dated report
  ahead). A run-up needs its own yardstick — the stock's own pre-report drift over its last reports, and the options'
  implied move when an expiry covers it.
  **Fixed:** `get_runup_history` (services/tools/runup.tools.js) — over each of its last reports (up to 12), the
  move from the sessions left until this report to the close before it, and the same vs SPY; the model copies its
  line as `runup` and the target is spot × (1 + the median), the band the quartiles. Re-run live on RCL: **active**,
  target 277.34 (median +0.23% over 11 reports, up 64% of the time — a modest record, said plainly), /usr/bin/bash.014.
- **`valid_until` ignores the exit-before date** — RCL's came out Oct 28, after the Oct 27 report Prometheus said to
  be out before. The window should end the day before a report inside it (the board's `exit_before` already knows).
  **Fixed:** the board's `exit_before` rides the queue row's context; `valid_until` ends at 21:00Z the day before
  the report (RCL: Oct 26). Stored on the read as `exit_before`.
- **Found in the bug hunt, fixed:** a server that died between saving the 09:20 board and queueing its picks left the
  day empty — the 5-minute pick-up now queues them when nothing of the day is in the queue yet (never on a day that
  queued anything, so a finished name is not bought twice). And a long whose target is at or under spot (a run-up
  record that runs DOWN, an event fully taken) is a `pass`, never an instant hit on the first grade.

## Code review (2026-10-24) — applied

Three reviewers over the build (catalyst read, hand-off, the Hotlist's tabs); 22 findings applied, one accepted (the
run-up tool counts weekends but not market holidays — a lead one session long around a holiday).

- **The queue keeps kinds apart.** A catalyst read and coverage for the same name are different questions: the
  duplicate check is symbol + kind, and a chain's run takes only its own source's rows (`startRun({ source })`), so the
  Hotlist's day budget is never spent on Pythia's row, or the reverse. The run records its source; an admin's stop
  halts only that chain's pick-up (a stopped Start-all still halts both).
- **A day is its session date.** The Hotlist's rows are matched on `context.day`, not "created since UTC midnight"
  (20:00 ET the day before). Earlier days' waiting rows are expired by the next pick-up — they blocked the name for
  every desk. The hand-off stamps the board `research_queued_at`; the tick catches up an unstamped 09:20 board once,
  and never re-queues a name the day already has a row for. Names with a live read are not queued.
- **Grading.** Inside the window, the live price at the target is a hit. Past it, the window's own daily bars decide
  (its high against the target, its last close for the return) — the hourly grade can miss the evening before a
  report and see the gap after it. The read's own day counts only for a read made before the open: RCL's read day had
  a 280 high above its 277.34 target from before the read existed (live check). One active read per symbol is held by
  a partial unique index; a read past its window no longer blocks a new one, and is graded (or closed unpriced) first.
- **The window.** A read made after the close before its report is a `pass` (`report_too_close`), never the full
  window run through the report. Every pass says why (`pass_reason`).
- **The run-up tool** counts a report today as the next one (it was skipping to next quarter's) and refuses a report
  more than 15 sessions away (`LEAD_MAX`). A block with both lines keeps the run-up and drops the delta.
- **The Hotlist** — a one-ended band no longer crashes the table; a settled read shows only on its own day's list;
  a horizon's Grade sort and its tie-break are that horizon's; a new horizon opens in Argus's order and a third header
  click returns to it; the counts follow the status filter; a horizon that empties falls back to All; a failed reads
  load says so; the horizon buttons are a filter group (`aria-pressed`), like the status filter.
- **"Catalyst read" (Roy, 2026-10-24).** On a This week row with no read, the user asks Prometheus for one — the same
  queue, mode and store, outside the house's daily $ and counted instead (HOTLIST_MANUAL_READS, 10 a day, everyone's).
  Live: XOM, asked for by hand — the run-up tool (median +0.02% over 11 reports), an honest pass, $0.024.
- **The table's headers** sit over their data: a global `button { margin: 5px }` pushed every sort label 5px inside
  its cell. The Info column explains the table while the Hotlist is open (HotlistInfo).

## Build order

1. Argus per horizon + the day's picks per column (backend) — tests.
2. The catalyst read: mode, prompt, parser, `catalyst_reads` + grading (backend) — tests.
3. The automatic hand-off + the shared budget pipe (backend) — tests.
4. The Hotlist's horizon tabs + catalyst targets on This week (frontend) — tests, a browser drive.
5. Live: Argus per horizon on a stored board; one catalyst read; the drive.
