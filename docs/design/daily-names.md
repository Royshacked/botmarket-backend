# Hotlist — the short-horizon board (session · day · days · week)

**Status: BUILT — all six phases (§11); everything is OFF behind `DAILY_SCREENER` until the FMP limit is measured.** The screener is **DailyScreener**; the Floor row is **Hotlist**. Discussed with Roy on 2026-10-21; the open decisions were
settled the same day (§10). Argus already finds names
for weeks, months and years; this is how it finds names for **a week, a few days, a day, and the
session itself**. The thresholds below are first proposals, not tuned values. **Shorts are not
discussed yet** — everything here is the LONG side (§9).

Relates to: `docs/desks/argus-scans.md` (the desk that picks from the board),
`docs/desks/mentor-talos.md` (where a pick becomes a trade), `docs/design/horizons.md` (the evidence
rule, §7 here), `docs/design/user-watchlist.md` (entry timing on the user's own names — the same
house-data / per-user-judgment split), `docs/design/opportunist-desk.md` (event-driven, but the
lag of weeks, not this session).

---

## The one line

**A long horizon asks "is this good?". A short horizon asks "is this in play right now, and how much
room does it have?"** At one day to one week most of the move comes from fresh catalysts and
money arriving — events and big-money flows, which is where Roy's edge is.

---

## 1. The split — screener (code) → Argus (judgment) → Mentor (the trade)

| Layer | What it is | Does | Output |
|---|---|---|---|
| **In-play screener** | A deterministic HOUSE service, not an agent. Scheduled. Shared by every user (research binds to no account → all three workspaces). | Gates, in-play numbers, news freshness, news labels (§3), structure flags, free range (§5), regime | **The board**: ~20–50 names with their numbers |
| **Argus** | The agent | Catalyst reading, structure confirmation, exclusions, the contrarian read, the user's own judgment criteria (§4) | 3–8 picks, each with a horizon and a thesis |
| **Mentor** | The trader | Entry, stop, size; Talos watches it per candle | A setup |

Why not a new agent like Pythia: "in play" is arithmetic (relative volume, gap, ATR, spread, dollar
volume, timestamps). An LLM there is slower, costs tokens and can get the numbers wrong — and the
pre-market window is ~85 minutes. Pythia's industry view lives at weeks-to-months; at most it breaks
ties on the week column.

Why it helps Argus: it picks from a board with real numbers, so it cannot invent an "in play" name
(the `services/scanner.grounding.js` idea, made stronger). And Atlas or Prometheus can read the same
board instead of building a second copy — one mechanism.

## 2. Criteria

### 2.1 Hard gates — fail one, the name is out

| Gate | Session / day | Days (2–5) | Week (5–10) | Why |
|---|---|---|---|---|
| Avg $ volume | ≥ $50M | ≥ $25M | ≥ $20M | clean in and out |
| Price | ≥ $5 | ≥ $5 | ≥ $5 | no penny noise, fewer halts |
| Spread | ≤ ~0.05% | ≤ ~0.1% | ≤ ~0.15% | the spread can't eat the edge |
| ATR % of price | ≥ 3% | ≥ 2.5% | ≥ 2% | it has to move enough to trade |

### 2.2 In play (or about to be)

- **Relative volume** — pre-market / opening volume ≥ 2× normal (session/day); 5-day vs 50-day
  average ≥ 1.5× (days/week). Money is arriving.
- **Gap or range expansion** — a gap of ≥ 3% on news, or a wide-range day after compression.
- **Fresh catalyst** — news from the last ~16h (day), the last 1–3 sessions (days). Freshness is
  checked by CODE against timestamps, never by the model.
- **Scheduled catalyst** (week) — earnings, investor day, FDA date, index rebalance, lockup expiry
  inside the window. "About to be in play": the best week names are often quiet today — a tight
  base before a known date.

### 2.3 Catalyst type — sets the horizon

Being in play says something is moving the stock now; it does not say for how long. That comes
from the catalyst:

| Catalyst | Typical life | Horizon |
|---|---|---|
| Upgrade, PR headline, sympathy move, squeeze spike | Hours, fades by the close | **Session / day** |
| Earnings beat **with** raised guidance, big contract, FDA approval | Drift for 2–5 sessions as funds build | **Days** |
| Index addition, M&A / activist, re-rating, sector rotation | Money keeps arriving for 1–2+ weeks | **Week** |

The same 4% gap on 3× volume can be either — what decides it is *why* it gapped.

### 2.4 Structure — confirms the horizon

- **Session / day levels** — pre-market high/low, prior-day high/low, VWAP, gap fill, opening range.
- **Daily-chart setups** — flag / base, inside day / NR7, range breakout, first pullback to the
  10/20-day average in a strong trend.

### 2.5 Relative strength

- vs SPY and its sector — today (session/day), 5 days (week).
- Holds up while the market is red — the clearest sign of a buyer underneath.

### 2.6 Flows and positioning

- Options: put/call by open interest and volume, near-expiry IV (snapshot only — §6).
- Short interest + days-to-cover — squeeze fuel.
- Block / dark-pool prints — no source yet (B3).
- Contrarian signs — a gap down that gets bought back, capitulation volume into support.

### 2.7 Exclusions

- Earnings inside the holding window, unless earnings IS the trade. On the week column a report 2–10
  days out IS the trade — the run-up into it — and the cell carries `exit_before` (the date): the
  board, Argus and Mentor's hand-off all say to be out before the report. A report tonight or
  tomorrow excludes the week cell outright (Roy, 2026-10-22).
- Halt-prone microcaps.
- Names in a pending merger deal (pinned to the deal price).
- An overnight hold on a session/day name.

### 2.8 Regime

SPY trend, VIX, breadth (% of the universe above its 20-day average — computed from the
universe's own daily bars). A weak regime limits the long board; short-horizon setups against the
tape fail much more often.

## 3. News — code first, then a cheap model, then Argus

1. **Code** — timestamps (freshness), duplicate stories removed across FMP / Finnhub / GNews,
   each story linked to its ticker.
2. **A cheap model labels each headline in the pool, ONCE for all users** (Haiku, ~200–400
   headlines per morning; decided 2026-10-21):
   - *Material?* — a real event, or noise / recycled articles.
   - *Type* — short-lived / drift / lasting (§2.3). This feeds the horizon grades.
   - *Surprise* — vs expectations ("beat, but guided down").
   - *Priced in?* — news size vs gap size. A small story under a 12% gap is a fade candidate.
   The labels ride on the board as data.
3. **Argus** reads deeper only for its picks: second-order effects, the contrarian read.

## 4. The user's own criteria

Two kinds, run in two places:

- **Numeric filters** (price, sector, ATR %, gap %, horizon, free range ≥ x…) — applied by CODE to
  the board. Instant, free, toggled in the list.
- **Judgment criteria** ("only clean bases", "no biotech binaries") — handed to Argus with the pick
  request.

Saved per user as a **preset**, so every board opens filtered their way and Argus knows the rules.

Example — **price-cycle window**: computable, not judged. `services/cycleAnalysis.service.js`
already finds daily peaks/troughs and the cycle's mean length and consistency, so "in its buy window"
becomes a number per name (days since the last trough vs the mean cycle). It fits the days/week
columns; daily cycles say little about the session open.

## 5. Grades per horizon, by FREE RANGE

**No estimated R:R.** The board cannot know the entry or the stop — those are Mentor's, built with
the user. What it CAN measure is how much room the price has before it meets supply:

> **Free range** = distance from the current price to the nearest overhead level that matters for
> that horizon, in **%** and in **× ATR**.

Both, because 4% means little alone: on a 1%-ATR name it is four days of movement, on an 8%-ATR name
half a session. The grade reads the ATR multiple; the % is shown beside it.

| Column | Computed (ET) | Rewards | Overhead levels that count |
|---|---|---|---|
| **Session open** (first 30–60 min) | ~8:00, ~9:20 | Gap + pre-market relative volume + fresh catalyst | pre-market high, prior-day high, gap fill (gap-down) |
| **Mid-session** | ~10:30 | Trend day above VWAP, opening-range break | high of day, prior-day high, multi-day high |
| **End of day** | ~14:30 | Strength into the close, near the high of day | high of day, multi-day high |
| **Tomorrow** (overnight) | ~15:30 | Closing strong at the highs + an after-hours catalyst; no binary event tonight unless it is the trade | prior-day high, multi-day high |
| **This week** | pre-market | RS + daily structure + one of: a scheduled date in 2–10 days (a run-up, out before it), money arriving (5-day volume ≥ 1.5× the 50-day on a rising week, `vol5_vs_50`), a positive drift/lasting catalyst | multi-week range top, 20/50-day high, 52-week high |

- Each name gets **A / B / C per column**; its best column is highlighted — that is the
  per-name horizon label.
- **Open sky** — no level overhead (above its 52-week / all-time high). Shown as its own flag,
  graded on the ATR alone, never as an infinite range.
- **Breaking out** (Roy, 2026-10-21) — a live price is always at or under the session's own high, and
  the in-session columns want it near it, so as a ceiling the high of day would grade nearly every
  in-session name C. Within **0.1 × ATR** of the high of day, price is breaking out: the high is
  skipped and the range is measured to the next level up (open sky when there is none).
- This keeps the board as analysis, not a signal service: no entry, no stop, no target is shown —
  the payments plan's trading-signals edge.
- Every grade carries an **"unverified"** label until its column has ~8 weeks of outcomes (§7, §10).

### 5.1 Starting cut-offs (free range in × daily ATR; the week column in × daily ATR too)

| Column | A | B | C |
|---|---|---|---|
| Session open | ≥ 1.0 | ≥ 0.5 | < 0.5 |
| Mid-session | ≥ 0.75 | ≥ 0.4 | < 0.4 |
| End of day | ≥ 0.5 | ≥ 0.25 | < 0.25 |
| Tomorrow | ≥ 1.0 | ≥ 0.5 | < 0.5 |
| This week | ≥ 2.5 | ≥ 1.5 | < 1.5 |

The bars shrink through the session because less of the day is left to travel. Free range is the
grade's floor, not the whole grade: a name also needs the column's in-play conditions (the table
above) to be graded at all — otherwise that column shows "—". First proposals; the outcome log
(§7) tunes them.

## 6. Data — checked on 2026-10-21 against the live FMP key (Starter)

| Need | Source | Status |
|---|---|---|
| Pre-market price, bid/ask, volume | FMP `aftermarket-quote`, `aftermarket-trade` | ✅ works, not wired yet |
| Pre-market / intraday bars | FMP `historical-chart/5min?extended=true` | ✅ (had a 06:00 ET bar); 5m / 15m / 1h work, 1m and 30m are refused (402) |
| Avg volume, ATR %, RS, averages, NR7, bases, cycles | FMP daily bars → computed by us | ✅ the quote carries no average volume |
| Base universe | FMP `company-screener` | ✅ wired |
| Earnings dates | FMP `earnings-calendar`, Finnhub calendar | ✅ |
| News with timestamps | FMP `news/stock-latest` (not wired), `news/stock`, Finnhub, GNews | ✅ |
| Upgrades / downgrades | FMP `grades-latest-news` | ✅ wired |
| 8-Ks, insider buys | `providers/sec.provider.js`, FMP `insider-trading/latest` (not wired) | ✅ |
| Float | FMP `shares-float` | ✅ |
| Short interest | Yahoo `getShortInterest` | ⚠️ per name, unofficial, twice-monthly data |
| Options context | Yahoo `getOptionsContext` | ⚠️ nearest expiry, 15-min delayed, a snapshot not flow |
| **Batch quotes** | FMP `batch-quote`, `batch-aftermarket-quote`, `batch-exchange-quote` | ❌ 402 on this plan — one request per symbol |
| **Movers as a seed** | FMP `biggest-gainers`, `most-actives` | ⚠️ work, but full of sub-$1 names and regular-session only — usable after our gates |
| **Regular-hours spread** | — | ❌ the regular quote has no bid/ask; pre-market has it |
| **Options flow (sweeps)** | — | ❌ needs a paid feed |
| **Dark-pool / blocks** | — | ❌ B3 |
| **FMP rate limit** | — | ✅ measured 2026-10-21: **~300 requests / rolling minute** per key (first 429 at 310 in the prior 60 s), back after ~18 s; shared with live pricing (§10) |

### Two passes (because there is no batch quote)

1. **Overnight, once** — the liquid universe (~1,000–1,500 names: price ≥ $5, ≥ 1M shares/day) and
   their daily bars → average dollar volume, ATR %, RS, structure flags, cycles, breadth, earnings
   dates, the overhead levels. ~1,500 requests, paced so they never crowd live pricing.
2. **At each checkpoint** — a **pool of ~200–300**, in this order (Roy, 2026-10-22): earnings
   reported yesterday / today; the names the overnight stats alone already qualify for the week
   (`ready`: RS + structure + a date or money arriving — week checkpoints only); today's rating
   changes; news since the close, most headlines first; the movers (in session); the best remaining
   structures by RS (not by size — by dollar volume the list was the mega caps). Only names that clear
   the stats half of a column's gates enter. No pre-market movers source exists on this plan (probed
   2026-10-22: batch pre-market 402, legacy pre-post-market 403). Quote
   only the pool, compute gap / relative volume / free range, apply the gates, publish the board
   (~30). Yahoo short and options data only for those ~30.

Later: IBKR's market scanners and real-time bid/ask could replace pass 2's pool — once the gateway
is done, and accepting that it ties a house service to one account's market-data subscription.

## 7. Evidence and outcome logging

`docs/design/horizons.md` sets the rule: show only what has published evidence AND passes our own
backtest. Here:

- **Published evidence** exists for the days column (post-earnings drift) and the end-of-day column
  (the first half-hour's return predicts the last half-hour's — intraday momentum).
- **Trader practice only** for others (gap-and-go, mid-session trend).

So the board **logs every publication and what each name did afterwards from day one** — per
column, per grade. After ~6–8 weeks that is our own backtest, and later a real hit rate per column.

### 7.1 Shown on the name — "did it work" (Roy, 2026-10-24)

"The hotlist says something about a name — can we put some kind of signal to know if what the hotlist said is
working?" The log was there; it only fed the "unverified" note. Now:

- **Each graded cell carries its RESULT** (hotlist.service `cellResult` / `withResults`, on the day list and on every
  board): `reached` the free-range level the grade measured room to, or `missed` it (its best move); open sky has no
  level, so `up` / `down` by the window's end; before that `open` (the window runs, until `ends`) or `scoring`
  (closed; scored after 18:00 ET). The list's **Result** column; the opened row says best / worst / end.
- **Past days**: the API lists the days there are lists for (`days`, newest first, 20 kept) and the panel steps back
  with ‹ › — a week name's result lands five sessions after its day.
- **Each grade's track record** (summarize gained `judged` and `up_rate`): over a horizon's list, per grade, how often
  it reached its level (of the names that had one) and how often it ended up (of all), and how far the column is from
  verified (40 sessions, 30 names); on the grade's hover too.

**Read the hit rate with care.** A grade is the room to the level in ATRs, so a C's level is CLOSER than an A's — "reached"
is easier for a C by construction. On the first two days of mid-day names, C reached 76% (21) and A 33% (3). The up
rate and the mean return compare grades on one footing; the hit rate says whether the room the grade promised was there.

### 7.2 Argus's record (Roy, 2026-10-24: "why did Argus say avoid?")

His avoids give one of four reasons: too little room to the level, earnings that day (a coin-toss), a big gap on a minor
story (a fade), no catalyst and thin volume. Most are "too little room", so their level is close and "reached" says
little — his record is read by how often a name ENDED UP and its mean move. `argusRecord` (hotlist.outcomes) joins the
log to the boards he read: his picks (per column), his avoids (the row's) and the names he left unmarked, overall and per
column; a board without his read is left out. On the Hotlist: a strip over All (overall) and over each horizon (that
horizon's); GET /api/hotlist/outcomes carries it as `argus`. First two days on axl_dev: picks 11 up 73% (avg +0.58%),
avoids 20 up 60% (+0.46%), unmarked 23 up 44% (−0.26%) — his avoids did better than the names he left alone; far too
few to say yet.

### 7.3 Scoring every quoted name; Argus and Prometheus doubled (Roy, 2026-10-24)

"With the analysis we lose good statistics." The log scored only the board's names. The first two live days showed
where the record was really lost: a board QUOTED 168–300 names and GRADED 3–19 — the board's cut never bit; the names
that graded on no horizon were never measured. Now every quoted name is scored:

- **The board** — its graded names (now up to 60, `BOARD_MAX`; was 30), shown, read by Argus.
- **Graded off it** — graded names past the cut (checkpoint `wide`, compact: symbol, price, when, grade and level).
- **The pool** — quoted names that graded on no column (`poolRow`, grade `-` = `POOL_GRADE`): the control group,
  scored by whether it ended up and its return (no level to reach). It never counts toward a grade or toward verified.

Both off-board kinds are stored on the board as `wide` (never sent to the client), scored by the same run, marked
`shown: false`, and kept **60 days** (`KEEP_WIDE_DAYS`; the board's 168) — ~1,500 outcome rows a day, ~30 MB at 60
days, against the Atlas free tier's 512 MB. Each column's summary carries `board`, `off` and `pool` groups; the
track-record strip sets them side by side. Argus's record stays the board's names (`shown: false` is left out — he
never saw them). Scoring cost: one intraday read per name a day for open / mid / eod and one daily read for tomorrow /
week — ~1,000 FMP requests a night, paced, after hours.

**Doubled** the same day ("more Argus checks and Prometheus checks — double"): Argus up to 10 picks per column and 10
avoids (`MAX_PICKS` / `MAX_AVOID`, his answer up to 8,000 tokens) over a board of 60; Prometheus's automatic catalyst
reads 20 a day for $2 (`HOTLIST_RESEARCH_MAX_NAMES` / `_MAX_USD`), user reads 20 a day; the weekly chain 10 per industry
(`HOUSE_SCAN_PER_INDUSTRY`), 100 a week (`HOUSE_SCAN_WEEKLY_MAX`), $10 a week (`HOUSE_RESEARCH_MAX_USD`). Each is an
env setting to turn back.

### 7.4 Argus reads the pool (Roy, 2026-10-24)

Doubling Argus's picks did little on boards that graded 3–19 names. So he also reads the POOL: the 40 most active quoted
names that graded on no column (`poolForArgus`: a material story first, then the biggest move, then volume), each with
its facts and why it was not graded per column — the gate it failed, or "did not qualify" (`boardRow` with
`keepUngraded`). He may SPOT up to 10 (`MAX_SPOTS`) the rules missed — a symbol, one of the board's columns, why and a
caution; code holds a spot to the pool and the board's columns. A board with nothing graded is still read when it has a
pool. His spots are stored on the board (`argus.spots`, `argus.pool_read`) and shown under his read — not on the
table, they have no grade. On the wide rows, the names he was shown carry `seen` and his spots `spot`, so the outcome
log scores them: his record adds **spotted in the pool** against **pool passed on**. Live (a stand-in pool from the
universe, no news or volume): $0.001 a board on Luna, 16 s, and no spots — rightly, on names with nothing behind them.

## 8. The Floor — "Hotlist"

- A **"Hotlist"** row in Floor Lists — the board, one for everyone. (Renamed from "Daily watchlist" on 2026-10-21 to stay clear of the existing **Watchlists** row, the scan lists.)
- Clicking it opens the board in the **window over the chat box**, as a pane tab (the way Pythia and
  Aether open).
- A row: ticker · gap · relative volume · catalyst label · the five column grades · free range
  (% and × ATR) · **Ask Argus** / **Build with Mentor**.
- The board **updates at each checkpoint** (§5); a name can rise, fall or leave during the day.
- **Today's list** (Roy, 2026-10-22) — the panel's default view, a classic watchlist: every name any
  of the day's boards graded, once (`day_list` on `/api/hotlist`, `hotlist.service dayList`). A name
  keeps each column's latest cell, with the board that cell lives on (`cell_board` — the Mentor
  hand-off references it). Each row has a **status** — *in play* (a session column, or a week cell
  let in by a story), *building* (money arriving), *setting up* (only a date ahead) — from the
  week cell's `path` (`hotlist.columns rowStatus`), the reason in plain words under the name, and
  "since <checkpoint>". Sortable by name, price, change, volume, status and best grade; filterable
  by status. Prices are as of each name's last checkpoint, **never live** — live quotes would cost
  the shared FMP key requests it lacks in session. **Boards** keeps the one-checkpoint view.
  Driven by `scripts/drive-hotlist-list.mjs` (21/21).
- The user's preset (§4) filters it on open.
- Lifetime: session/day names expire at the close, days names after ~3 sessions, week names after
  ~5–10.

## 9. Not discussed yet

- **Shorts — deferred by Roy (2026-10-21), not for now; not a prerequisite for building.** Everything above is the long side. The short side — gates (borrow, hard-to-borrow,
  short-sale restriction after a −10% day), free range DOWN to support, catalyst reading in reverse,
  and whether the board shows shorts at all — is not designed.

## 10. Decided (Roy, 2026-10-21)

- **Grades are shown before the backtest**, labelled **"unverified"** per column until that column
  has ~8 weeks of logged outcomes (§7) — the same call as `industry-screener.md`.
- **News labels** — Haiku, once per checkpoint, for all users (§3).
- **FMP rate limit** — measured with a controlled burst BEFORE the screener is built, outside market
  hours (a weekend or after 20:00 ET), because the key is shared with live pricing.
  **Measured 2026-10-21, 23:00 ET** (`scripts/fmp-burst-test.mjs`, dev backend stopped; Render may have
  been on the same key, so this is a floor): 120 and 240/min clean, the first 429 during the 360/min
  step with 310 sent in the 60 s before it — **~300/min**, a rolling window, answering again after ~18 s.
  The 429 body is `"Limit Reach"`. Live pricing runs ~145/min per backend in session, so two backends on
  one key already use most of it (dev and Render DO share one key — Roy, 2026-10-22); `DAILY_SCREENER_RPM` stays **60**.
  So the screener runs on **one backend only** (`DAILY_SCREENER=true` on dev OR Render, never both).
- **Options** — build on the Yahoo snapshot; a paid flow feed only if the board proves it is missing.
- **Grade thresholds** — the starting cut-offs in §5.1; tuned from the outcome log, never by feel.
- **Pre-market spread gate** — 3× the column's spread limit at the 08:00 checkpoint (the book is thin that
  early), strict at 09:20 (`CHECKPOINTS[].spreadSlack`).
- **Who pays** — a board's news labels and Argus read are house spend, booked to the admin ledger
  (`user.model.houseLedgerUserId`, the first admin by id — the same one Pythia's weekly run books
  to), as monitor spend so it does not count against that admin's chat ceiling. Agents
  `hotlist_news` and `hotlist_argus` in token_usage; each board stores `booked_to`.
- **Names** — the service is **DailyScreener** (to be built as services/dailyScreener.service.js, the usual *.service.js shape); the Floor row is **Hotlist**.
- **Horizon vocabulary** — `swing` is NOT split. It already means weeks to months, the same span as
  Pythia's swing book (`prompts/strategy_system_prompt.md`), and `services/houseLabel.service.js`
  maps a swing scan to that book — narrowing it would make one word mean two spans. Instead ONE value
  is added below it: **short-term swing**, 2–10 days (the hotlist's days and week columns). Stored as
  `short term swing`, in the style of `long term`. `TRADE_HORIZONS` becomes `intraday · day ·
  short term swing · swing · long term`. No saved value changes meaning, so no migration; what changes
  is every reader of the horizon (the scan score weights, the scan→Pythia book mapping — short-term
  swing reads the swing book as a tie-break only) — its own conflict check when it is built. (First
  decided as a split into short swing / swing; reversed the same day once Pythia's span was checked.)

## 11. Build

Six phases, in order. Each ends tested and committed; the FMP rate limit gets measured (§10) before
phase 2's overnight pass is switched on anywhere.

1. **`short term swing` in the horizon vocabulary** — **DONE 2026-10-21.** `TRADE_HORIZONS` is
   `intraday · day · short term swing · swing · long term`; no stored value changed meaning, nothing
   migrated. Every reader that branches on a horizon got its own row rather than a fallback: Argus's
   score weights (`TRADING_WEIGHTS`, else it fell to the swing row), the Talos ladder (`setup.ladder`,
   else it fell to `day`), the house-book mapping (`houseLabel.booksForStyle` — the swing book, as a
   tie-break), the counter-case tool's enum (now the vocabulary itself, not a copy), and the scanner /
   Mentor / Atlas prompts. The scanner prompt's `swing` said "days–weeks"; it now says weeks to
   months, the span Pythia's book means.
2. **DailyScreener, overnight pass** — **BUILT 2026-10-21, OFF** (`DAILY_SCREENER`, opt-in;
   `DAILY_SCREENER_RPM` 60). `services/dailyScreener.service.js` + `dailyScreener.stats.js` + the
   monitor. The universe is ONE screener read (439 names on 2026-10-21: , 1M shares, common stock,
   NYSE/NASDAQ/AMEX), then SPY and each name's daily bars, paced; per name: dollar volume, ATR %,
   RS vs SPY (5/20 sessions, matched by session), SMA 20/50, the overhead levels (day high, 5/20/50-day
   and 52-week highs), NR7, inside day, the trough cycle, the next earnings date; per run: breadth
   and SPY. A 429 ends the run as partial. FMP bulk EOD is 402 on this plan, and the engine's
   daily_prices_recent (written by aether-engine) is weekly and has no SPY, so neither replaces the per-name read. **Turn on
   only after the rate-limit burst (§10).**
3. **Checkpoint pass** — **BUILT 2026-10-21, OFF** (the same `DAILY_SCREENER` switch).
   `services/dailyScreener.checkpoint.js` (the pool, the paced quotes, the board), `hotlist.columns.js`
   (pure: gates, in play, overhead levels, free range, grades), `hotlist.news.js` (the labels). Five
   checkpoints, each with a 30-minute window; pre-market reads the extended-hours book
   (`aftermarket-quote`: bid / ask / volume → midpoint, spread, % of a day's volume), in session the
   regular quote. One board per checkpoint in `hotlist_boards`. A 429 publishes a partial board; a
   failed label call (no credits) publishes an unlabelled one. Live-checked on 2026-10-21's movers
   with no writes — it graded SPCX B mid-session (+10%, 3.4× volume, 0.45× ATR to 166.18), and its
   first run caught a long-side hole (a NEGATIVE drift qualified the week column), fixed the same day.
   Not in this phase: short interest and options context for the board's rows (§6).
4. **The outcome log** — **BUILT 2026-10-21, OFF** (the same switch). `services/hotlist.outcomes.js`:
   every graded cell scored long from the board's price over its own window — open the first session
   hour, mid 10:30 → close, eod 14:30 → close, tomorrow the next session, week five sessions — for
   MFE, MAE, the return at the window's end and whether it reached its free-range level. Scored
   off-session only, at most hourly, paced. The summary gives, per column and grade, samples, the
   share that reached the level, the median best move and the mean return; a column is VERIFIED at
   40 sessions and 30 samples (§7's "~8 weeks"), and each board stamps which of its columns are not
   yet. `boardsForDay` is the history the Floor reads. Live-checked on EXPD's real hourly and daily
   bars (no writes).
5. **Argus reads the board; the user hands names to Mentor** — **BUILT 2026-10-21** (off with the rest).
   Decided by Roy the same day: Argus reads **every checkpoint, once for everyone** (a summary, up to
   8 picks with why and a caution, up to 5 traps — `services/hotlist.argus.js`, on the house chat
   model, every pick held to a graded cell on the board); the user sends names to Mentor **one at a
   time**, exactly like a scan pick; picks **live on the board**, not in Watchlists. The hand-off is a
   reference — board id + column — and the server reads the facts back from the stored board
   (`hotlist.service.hotlistSeed`): the column's horizon (open / mid / eod → intraday, tomorrow →
   day, week → short term swing), the grade and free range, the catalyst, Argus's note, the unverified
   flag; Mentor relays them and builds entry, stop and size with the user. Read API: `GET
   /api/hotlist`, `/boards/:id`, `/outcomes`. Live-checked: on a real board Argus put TSLA on the
   avoid list (no catalyst, 0.31% of room) and picked nothing; the run also showed one label call
   cannot hold a pool, so labels go 40 tickers a call.
6. **Frontend** — **BUILT 2026-10-21.** The Floor's **Hotlist** row (after Watchlists) opens
   `HotlistPanel` over the chat, a DetailPanel like the Calendar: Argus's summary on top, the regime,
   the unverified note, one row per name (Argus's ★ and note or "avoid", price, gap, volume, the
   catalyst, a grade + free range per column), the day's checkpoints as tabs, "Argus's picks only".
   **Build with Mentor** sends the row's best column (Argus's pick column first) as a board reference;
   **Ask Argus** puts the row's facts to Argus as the user's question. Driven:
   `scripts/drive-hotlist.mjs` 21/21 on Vite against the running dev backend — a fixture board, the
   two hand-off turns captured and aborted (no model call); the first run caught the row actions
   overflowing the panel, fixed by stacking them.

**QA/CR cycle, 2026-10-21** (three reviews; Roy approved all but two, with the breakout rule for the
in-session columns):
- An overnight run that stopped short (a 429, an outage, an empty universe) is retried ONCE an hour
  later, then left for the next day — it used to restart on every five-minute tick until the open.
- The in-session columns skip the high of day when price is breaking out (§5).
- The outcome log reads 5-minute bars: mid and eod start at the first bar after the row was quoted
  (each row now stores `quoted_at`), so a high printed before the entry no longer counts as reached.
  A session's windows are due from 18:00 ET (with the overnight pass); a window that comes back short
  is read again rather than written for good, and is kept flagged `partial` once it is long closed.
  The log keeps ~120 sessions.
- The checkpoint takes its board with the overnight pass's atomic claim (`claimRun`).
- A missing number is null in the columns, not 0, so the `??` fallbacks work.
- Frontend: a slow board read for a tab the user has left no longer replaces the one on screen; an
  unknown SPY reading is hidden instead of shown as "below".
- ~~Open: **pre-market volume**~~ — **closed 2026-10-22**: `aftermarket-quote`'s `volume` IS the
  morning's pre-market volume (the first live board read 0.1–3.1% of a normal day at 08:10 ET, not
  ~100%). Declining Argus's "put aside
  your current work?" after Ask Argus leaves the Hotlist closed — accepted as is.

### First live day — 2026-10-22 (dev backend)

- **Overnight pass:** 1,187 of 1,190 names. The first attempt read the whole universe and then lost
  it to a DNS failure on its single final write, and its run stayed `running` for two hours. Fixed:
  stats are saved every 100 names, a retry reads only the names not yet saved, a pass that throws is
  marked `partial` (the hourly retry applies), and liveness is a heartbeat (`runIsLive`: progress
  within 10 minutes), shared by the claim and the Floor.
- **The lease:** a network drop lost and regained the background-loops lease inside one slow stop;
  the stop then stopped the freshly started loops and the process sat as leader with nothing running.
  `instanceLock` now applies one transition at a time, to the latest wish (verified live at 14:59).
- **08:00 board:** 5 rows from a pool of 300, all "this week" (earnings-driven); Argus read it on Luna
  and starred CVX. The news labels failed (Haiku, Anthropic credit at zero), so no name could qualify
  on news — a thin board, as expected. The open column graded nothing: the large caps fail the 3% ATR
  gate, and their 0.13–0.26% pre-market spreads exceed even the 08:00 allowance.
- **The Floor:** the panel shows what the screener is doing (`working`: the overnight pass with its
  count, or a board being built) and the latest finished pass (`stats`), refreshing every 30 s while
  something runs. Each row has a sparkline: the last 20 closes (saved by the overnight pass,
  `closes20` → row `spark`), today's price as a dot, the best grade's overhead level dashed.
- **09:20 board:** 3 rows (AMZN, LLY, SBUX), all week C, all on Argus's avoid list; labels failed again.
- **Why so few (funnel from the stats):** week gate 938 → RS 426 → structure 310 → a report in 2–10
  days 69. A dated report was the ONLY non-news way into the week column, and the pool never reached
  most of those 69: 200 of its 300 slots went to news names (unlabelled, so useless), and the
  structure source was ranked by dollar volume — the mega caps. Fixed the same day: the pool order
  above (the 69 go first), the gate filter, structure by RS, and a second non-news path into the week
  (money arriving, `vol5_vs_50`, from the next overnight pass). The earnings path is kept as a run-up
  trade with `exit_before` (§2.7).
- **10:30 board:** partial — 4 rows, stopped at its 9th quote on a 429. This backend sent ~150/min
  that minute and had 52 refused, so another user of the shared key (most likely Render's live
  pricing) took the rest of the ~300. Fixed: a 429 is waited out (20 s, up to 3 tries per request,
  at most 15 waits per board, `retried_429` on the board) before the board stops partial. The real
  fix is one live-pricing backend per key, or a second key.
