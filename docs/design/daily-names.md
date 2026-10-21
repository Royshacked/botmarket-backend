# Hotlist — the short-horizon board (session · day · days · week)

**Status: BUILDING — phases 1–4 of 6 done (§11); everything is OFF behind `DAILY_SCREENER`.** The screener is **DailyScreener**; the Floor row is **Hotlist**. Discussed with Roy on 2026-10-21; the open decisions were
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

- Earnings inside the holding window, unless earnings IS the trade.
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
| **This week** | pre-market | Drift catalyst + daily structure + a scheduled date in the window | multi-week range top, 20/50-day high, 52-week high |

- Each name gets **A / B / C per column**; its best column is highlighted — that is the
  per-name horizon label.
- **Open sky** — no level overhead (above its 52-week / all-time high). Shown as its own flag,
  graded on the ATR alone, never as an infinite range.
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
| **FMP rate limit** | — | ❓ unknown, no headers; the screener shares it with live pricing |

### Two passes (because there is no batch quote)

1. **Overnight, once** — the liquid universe (~1,000–1,500 names: price ≥ $5, ≥ 1M shares/day) and
   their daily bars → average dollar volume, ATR %, RS, structure flags, cycles, breadth, earnings
   dates, the overhead levels. ~1,500 requests, paced so they never crowd live pricing.
2. **At each checkpoint** — a **pool of ~200–300**: news since the close, earnings today / yesterday,
   today's rating changes and 8-Ks, the gated movers, the top of the overnight structure list. Quote
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

## 8. The Floor — "Hotlist"

- A **"Hotlist"** row in Floor Lists — the board, one for everyone. (Renamed from "Daily watchlist" on 2026-10-21 to stay clear of the existing **Watchlists** row, the scan lists.)
- Clicking it opens the board in the **window over the chat box**, as a pane tab (the way Pythia and
  Aether open).
- A row: ticker · gap · relative volume · catalyst label · the five column grades · free range
  (% and × ATR) · **Ask Argus** / **Build with Mentor**.
- The board **updates at each checkpoint** (§5); a name can rise, fall or leave during the day.
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
- **Options** — build on the Yahoo snapshot; a paid flow feed only if the board proves it is missing.
- **Grade thresholds** — the starting cut-offs in §5.1; tuned from the outcome log, never by feel.
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
5. **Argus picks from the board** — the hand-off to Mentor.
6. **Frontend** — the Floor's Hotlist row and the pane over the chat, then a browser drive.
