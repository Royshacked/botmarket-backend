# The horizon chains — every horizon automatic, and the Hotlist a list per horizon

**Status: BUILT 2026-10-23 (Roy: "go ahead, write the doc and build") — steps 1-4 unit-tested, Argus per horizon
live-checked on a stored board, the Hotlist tabs driven in a browser (`scripts/drive-hotlist-horizons.mjs`). Pushed
2026-10-24, with the same day's rework: no grade shown anywhere, Prometheus's own target on This week, Swing / Long term
as the weekly chain's survivors (sections from "The Hotlist's Swing and Long term" on). 2026-10-25: the DAY trade row
and Argus's per-column picks are ARCHIVED, and This week is the overnight run-up rule — every name to Prometheus, no Argus
(`docs/design/hotlist-day-archive.md`).**

## What Roy asked for

Three chains, each running by itself — nobody activates Argus or Prometheus:

| Horizon | Chain | What arrives |
|---|---|---|
| **Long swing / long term** (3m–24m) | Pythia → Argus → Prometheus | covered names with a VALUATION target and its horizon — built ([house-research-chain.md](./house-research-chain.md)) |
| **Short swing** (2–10 days, the Hotlist's `week`) | Hotlist → Argus → Prometheus | names with Prometheus's own short-swing target (the catalyst's worth is his yardstick — see "This week: Prometheus confirms and sets the target"), a 1-month horizon and a valid-until date — **this doc** |
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
names graded on that column — Argus's picks for THAT horizon first, then room — and its Room cells read that column,
not the name's best. No grade is shown (2026-10-24; Swing and Long term were added the same day — see the sections
below). On **This week**, a name with a catalyst read shows its target, what is still open,
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
  stored with no target (a pass). *Superseded 2026-10-24: the target is his own and the delta only its yardstick — see
  "This week: Prometheus confirms and sets the target".*
- **Graded at expiry** (the screener's off-session tick): `hit` when the price reached the target, else at valid-until
  `expired` with its return and SPY's over the window. One record per kind; never mixed with coverage's.

### 4. Hotlist → Argus → Prometheus, automatic (backend)

- **When (since 2026-10-25):** after the **overnight week board** (`hb_<day>_week`, the run-up rule — hotlist-day-archive.md)
  EVERY name is queued for research (source `hotlist`, `context.rule`), the board's facts on the row; the queue's window
  opens at the previous weekday's UTC midnight, because the board is built the evening before. **As first built:** after
  the **09:20 board** (`preopen` — open + week columns, the strict spreads), Argus's **This week** picks, his why/caution
  on the row.
- **The run:** the same research run as the Pythia chain (`startRun({ symbols, maxUsd })`), in catalyst mode for these
  rows; the budget pipe of `houseResearch` shared, not copied — a **daily** budget: `HOTLIST_RESEARCH_MAX_USD` ($2) and
  `HOTLIST_RESEARCH_MAX_NAMES` (20) per ET day (doubled 2026-10-24 from $1 / 10; 60 / $3 since 2026-10-27 — the busiest night of the run-up rule). A run already going → the names wait for the next screener tick (5 min).
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
- **§4** `services/hotlistResearch.service.js` on the screener's monitor tick: `afterCheckpoint` (the week board's
  names — the `preopen` board's week picks until 2026-10-25 → queue source `hotlist` → the run), `resume` (today's names), and the hourly grading. The budget pipe is
  `houseResearch.researchQueued` / `resumeQueued`, shared with the Pythia week. Env: `HOTLIST_RESEARCH` (on unless
  `false`), `HOTLIST_RESEARCH_MAX_NAMES` (10/day), `HOTLIST_RESEARCH_MAX_USD` ($1/day) — 20/day and $2/day since
  2026-10-24, 60/day and $3/day since 2026-10-27 (services/config.js). `GET /api/hotlist/reads`.
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

## A target too small to trade (2026-10-24)

Roy saw RCL's Last above its target. The Last was the 08:00 pre-market quote (283.45); the target (277.34) was set at
15:51 from 276.70, and the close was 276.48 — no hit. Two fixes:

- **The This week target cell is measured from the read's own price** ("277.34 · +0.2% from 276.70"), with the read's
  time on hover and in the opened row: the row's Last is an earlier checkpoint's quote, by design.
- **A target that leaves less than 1% open — or half the stock's daily range, when wider — is a `pass`
  (`too_small`)** (catalystRead `minOpenPct`; the board row's ATR % rides the hand-off as `atr_pct`). RCL's run-up
  record was a median +0.23%: noise any session reaches, which would have booked a "hit" and flattered the record. Its
  read on axl_dev was set to the pass it would now be (`target_rejected` keeps the old target).

## A run-up already run this cycle (2026-10-24)

Measured only from today, a run-up read did not know how far the stock had ALREADY run into this report: one up 5% over
the last week still looked like it had its whole usual run-up ahead. get_runup_history now also measures the usual FULL
run-up (the 10 sessions before a report, `FULL_LEAD`) and how much of it this cycle has already moved (`soFarPct`, from
the last close — a session in progress left out); its line carries `full_lead`, `full_median_pct`, `so_far_pct`. The
target (catalystRead `runupTarget`) is the smaller of the usual last-sessions move and what is LEFT of the full run-up;
a cycle that ran ahead has its target cut (`cycle_cut_pct`), and one that already moved its whole usual run-up — or so
much that too little is left to trade — is a pass, `already_ran`, worked out from the numbers whatever verdict the model
wrote. Live: XOM, SBUX and CVX had already run theirs (all three Argus avoids); RCL was behind its path (−1.8% of a usual
+4.2%) and kept its small usual move.

## The Hotlist's Swing and Long term (2026-10-24)

"In hotlist — what about longer swings and long-term names?" The day's boards stop at This week; the longer horizons are
the house's COVERAGE, and they had no list of their own — only a company page inside a Forecasts industry. Two more
buttons after This week (services/houseBook.service.js, GET /api/hotlist/book; HotlistBook.jsx):

- **Membership** — live coverage (active, target hit, thesis broken) split by the price target's horizon, the way the
  research run books it: 3m / 6m **Swing**, 12m / 18m / 24m **Long term**. Buy-rated first; All shows holds and sells.
  *(Superseded the same day: the views are Prometheus confirmed · Argus's names · All coverage — see "Swing and Long
  term: the weekly chain's survivors".)*
- **From** — the weekly chain (Pythia's verdict on an industry or theme → Argus → Prometheus), read back from the
  name's latest done `pythia` research_queue row (the only place that context lives), or the desk. Live on axl_dev, 4
  of 89 names came through the chain; the chain's names list first.
- **Did it work** — the move since the target was set, against SPY over the same days, and how far toward the target
  (only for a target at least 5% over the set-day price). Hit / broken are the coverage monitor's; a passed target date
  without a hit is expired. Each book's track record: what came due and was hit, and how the live names stand vs SPY.
- **Prices without a burst** — today's is the screener's overnight close; a name outside its universe (29 of 89: ADRs,
  some large caps) gets its last daily close, and every name its set-day price (and SPY's), read once in the
  BACKGROUND (12 per open) and kept in `house_book_marks` — the coverage documents are not touched; a re-set target has
  a new set_at and is read again; a miss is retried after a day.
- **The opened row** is the thesis itself (CoverageDetail, from the coverage list the Floor already holds), with Build
  with Mentor and Ask Argus (is now the time to buy it). Build with Mentor rides as a REFERENCE — which list
  (scanSeed \`book: { column }\`) — and the server reads the name's coverage back (houseBook \`bookSeed\`): the horizon
  is the coverage's own book (swing / long term, from the target's horizon, whatever the request said), and Mentor's
  seed section, headed "FROM THE HOUSE'S BOOK", carries the rating, target and date, the upside, where it came from
  and what would break it — the horizon the user's to confirm, the target a valuation, not a take-profit.

## This week: Prometheus confirms and sets the target (2026-10-24)

Roy: "hotlist ⇒ Argus automatically ⇒ names ⇒ Prometheus confirms catalyst and fundamentals and gives PT", then
"Prometheus should analyze the catalyst and company and decide of a short-term swing PT".

- **The company.** The catalyst mode now calls `get_fundamentals` once and judges `company`: `sound`, `weak` (it can
  carry the move, the why says what holds the target down) or `broken` (dilution likely inside the window, going
  concern, distress). `broken` is a pass, `pass_reason: 'company'`, whatever the verdict.
- **His target.** The block carries `target: { price, low, high, why }`: his own short-swing price, decided from the
  catalyst and the company. The tools' number (the run-up line, or the event delta) is his YARDSTICK, not the answer. It
  is stored beside his as `target.yardstick` (`basis: 'prometheus'`), and it is NEVER the target: no target of his on
  a `credible` / `priced_in` read is a pass, `pass_reason: 'no_target'`. His price is measured from a fresh quote at
  the read. The trade's rules still hold: above the price, `minOpenPct`, a window before the report, a run-up not
  already run, a company not `broken`.
- **A stretch is flagged, not blocked.** A target more than `STRETCH_X` (3) × the options' implied move or the
  yardstick (the larger) is stored with `target.stretch` (`ref_pct`, `times`) — shown with the read and told to Mentor;
  his number is his call.
- **Scored to the report.** A run-up week trade (a report inside the window) is scored up to the close BEFORE the
  report — live (hotlist.outcomes) and in the replay (hotlistBacktest.service.js): the trade is out before it.
- **The list.** This week opens on **Prometheus confirmed**: the names with a target of his. Then come **Argus's
  names** (every pick, each with his answer; a pass says why) and **All screened**. When the confirmed list is empty it
  says where the reads stand: still to come, all passes, or not loaded.
- **To Mentor.** A week hand-off carries the live read (`catalystRead.readFacts`, via `hotlistSeed`'s
  `catalyst_facts`): his target and band, the date to be out by, the yardstick, the company and the kill. Mentor is
  told his target is the desk's price for the swing: build the take-profit at it, and the user may move it.
- **The week grade is hidden too** (Roy: "hidden"). No horizon shows a grade anywhere: not in the table (the All tab
  keeps a Horizon column, no letter), the track record (the board against its cut and the pool), the replay line (the
  screener's names against the pool), Argus's board and prompt, Axl's `get_hotlist`, or Mentor's hand-off (never
  `unverified`). The screener still computes the grades: they gate which names reach a column and order the board, and
  the outcome log and the replay still score them, out of sight.

## Swing and Long term: the weekly chain's survivors (2026-10-24)

Roy: "Pythia brings the industry ⇒ Argus brings names from the industry ⇒ Prometheus analyses names and brings a thesis
and PT — the survived names in the Hotlist". The chain was already automatic (house-research-chain.md); the lists were
the whole book. Now:

- **Prometheus confirmed** (the default, and the tab's count; `chainSurvivors`): Argus's picks that survived coverage,
  i.e. they have a thesis and a PT, whatever the rating (Roy: "show the Argus-filtered names that survived coverage";
  the first cut kept buys only and was wrong). That's book rows covered through the chain (`origin.source 'pythia'`),
  plus picks the desk had already covered (`already_covered`). A pass has no live row.
- **Argus's names**: `houseBook().picks[book]` — every `pythia` research_queue row of the last `PICK_DAYS` (56, the
  scan's `REJECTED_DAYS`), the newest per name, by its verdict's book: `covered` (his rating and target from the book
  row), `passed` (`no_edge` / `horizon_off_book` / `no_read`, in words), `already_covered` (at the desk), `waiting`.
  `picks: null` means the read failed, not that the chain sent nothing.
- **All coverage**: the live book on that horizon, the desk's names, holds and sells too.
- When the survivors list is empty, it says why: the chain sent nothing yet, names are still waiting for research, or
  he covered none.

On prod the chain has not run (2026-10-24: 30 old `queued` rows, no chain coverage). It needs `PYTHIA_WEEKLY=true`
and the engine crons on Render (house-research-chain.md, "As built").

## Build order

1. Argus per horizon + the day's picks per column (backend) — tests.
2. The catalyst read: mode, prompt, parser, `catalyst_reads` + grading (backend) — tests.
3. The automatic hand-off + the shared budget pipe (backend) — tests.
4. The Hotlist's horizon tabs + catalyst targets on This week (frontend) — tests, a browser drive.
5. Live: Argus per horizon on a stored board; one catalyst read; the drive.
