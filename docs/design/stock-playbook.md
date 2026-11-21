# Stock playbook — how to trade THIS stock

> **2026-11-21:** the Proteus engine cited in the labs below (`shuffledBars`, its per-name tests) is deleted; Proteus is now
> a behaviour profile ([proteus-v2.md](proteus-v2.md)). The results stand as recorded; git holds the code.

**STATUS: BUILDING (2026-10-30).** The lens is built (below, § Built); the learning loop (the file per stock, grading, replay) is not. Tests 1 / 1b / 1c ran. Branch `feat/stock-playbook` (from main). Supersedes the
one-ticker pattern test in [future-projects.md §5](../future-projects.md#5-test-a-pattern-on-one-tickers-history--with-the-lab-we-built)
— Roy restarted the question from scratch ("forget what we discussed until now").

Roy (2026-10-30): "I want a learning system that will get to know the stocks the user points at — and will say: this is
the way to trade this stock."

## What it is

**An agent that gives inputs to a calculation system, gets the outputs back, and gives the verdict** — plus a memory per
stock and a grading loop, which is what makes it LEARN.

1. **The agent** (Mentor, through tools) turns the user's ask into inputs: the stock, what to test.
2. **The calculation system** measures the stock and tests trading styles on its history — and judges the result by
   FIXED RULES, not by the agent's reading.
3. **The memory** keeps a file per stock: profile, playbook, verdict, evidence, date, and every past version with why it
   changed.
4. **The grading** checks every verdict and every current read against what happened next; the result goes back into the
   file and into a scorecard.
5. **The agent** explains it — and says "don't trade it" or "too little history" when that is the answer.

**Is it ML? Mostly no.** The profile is measurement and the playbook is backtesting. One stock has 30–100 examples of a
setup — an ML model fitted on that finds chance. Every "which stock goes up" model in the lab scored a coin flip held out
([screener-lab.md](screener-lab.md) §10, §18, the run-up meta-label); plain tested rules did better. ML is a LATER layer,
only across many stocks (stocks with this profile trade like that; families of similar stocks; regime-change detection),
and only if it passes a declared bar. The language model is the voice: it never computes or estimates a number.

## What "how to trade this stock" means — two layers

### Layer 1 — the playbook (how it trades, in general; changes when its character changes)

1. **Timeframe** — day / swing / long term. DECIDED BY THE VERDICT (Roy): the playbook says which timeframe the stock
   suits, not the user up front.
2. **Direction** — long, short or both (Roy: both are tested); and which, under which conditions.
3. **Entry style** — the setups with an edge on this name, and the ones that FAIL on it.
4. **When to trade it, when to stay away** — the conditions that make a setup work or fail.
5. **Stop** — from how far its winners went against the entry first; gap risk.
6. **Exit** — how far and how long its good moves ran; fixed target, trail, or time exit.
7. **Size** — from its volatility and the stop distance.
8. **Early failure** — its usual path after entry ("not up by day 4 → it usually doesn't work").

Every answer carries its evidence (examples, result, range, luck check) and a confidence — "not enough history" is an
answer.

### Layer 2 — the current read (what to do now; changes daily)

The playbook applied to today: in the entry zone / wait for X / stay away (earnings Tuesday) / a condition changed
(shorts +30%).

Roy: **both layers.** The playbook comes first; the current read depends on it.

## Inputs — "anything we can fetch" (Roy), options left out for now

To be TESTED, a factor needs its history stamped with the date it became KNOWN, or the backtest uses what nobody had.

| Source | Have | History to test |
|---|---|---|
| Prices, daily + intraday | FMP, Massive, Yahoo | daily from 2012; intraday shorter |
| Earnings (dates, surprise, reaction) | FMP | yes |
| Analysts (grades, targets) | FMP | from 2023 |
| Insiders | FMP / SEC | yes |
| Shorts (interest, daily short volume) | FINRA (`finra.provider`) | yes |
| Dark pool (ATS weekly) | FINRA | yes, published with a lag |
| Big funds (13F) | aether `fund_holdings` | yes — the CUSIP map bug (MSTR missing, commons on preferreds) must be fixed first |
| News | FMP news, GNews | headlines yes; a tested reaction needs an archive with event types |
| Sector / market regime | prices + `spyRegimes` | yes |
| ~~Options~~ | Yahoo snapshot only | **left out for now (Roy, 2026-10-30)** |

## Decisions so far (Roy, 2026-10-30)

- **Both layers**; the playbook first.
- **Timeframe** comes out of layer 1's verdict.
- **Long and short.**
- **Inputs:** technicals, news, shorts, big funds, anything fetchable — **options left for now**.
- **Runs on the laptop for now.** The deployed app and its db are a separate discussion.
- **A tool for Mentor**, not a new desk.
- New work branches from main.

## The trade rules — no setups, price areas (Roy, 2026-10-30)

Roy's approach: the daily chart, fundamentals and news say buy / sell / none; the STOP says when the stock becomes a sell;
the risk limit, the stop and the target then give the entry prices. No setup menu — a price area, and strength.
Described for longs; shorts are the mirror.

**The stop — below the professionals' stops.** When a sell phase ends the professionals buy first, then a gradient of
less informed money higher up, each with stops under it. The stop goes under the deepest layer that still means "the
turn is alive": below the BASE that followed the last sell phase (its low, and any spring — a brief break below the range
that closes back inside), plus a buffer learned per stock (how far this stock usually pokes through a level before it
reverses). A price not visited for a while; price there means the professionals stopped defending — the stock is "too
cheap", a sell. Prior art: Wyckoff accumulation (selling climax → base → spring), change of character, supply/demand
zones, Weinstein's stage base, Minervini's base low.
- **One stop** to start, and test it (Roy). No separate hard stop yet.
- Measured on: the low of the last sell phase (heavy volume); the base after it and its low; the professionals' cost
  (the base's volume profile / an anchored VWAP from the low); signs the buying was real (heavy-volume days that hold,
  dark-pool volume rising, funds adding, shorts covering).

**The target.**
- Selling overhead: the mirror — just under where the professionals' last DISTRIBUTION began (the base before the last
  fall), before the crowd's sell orders.
- At its highs (nothing overhead): a MEASURED MOVE — the current range's height added to the range's high (Roy; the
  classic range projection).

**The entry — all three:**
- A. Entry → stop within the risk limit.
- B. The verdict is buy and the chart shows strength (after a pullback, strength first — no falling knives; already in
  the area → enter now).
- C. Reward to risk ≥ 1.5 (an example value).

What C does with a measured-move target: base low L, high H, height h, buffer b — target H + h, stop L − b. R:R ≥ 1.5
holds only for an entry ≤ (H + h + 1.5(L − b)) / 2.5 — with b = 0.1h, the lower ~74% of the range. Buying the top of the
range or the breakout fails C (risk ≈ h + b, reward ≈ h): the rules buy in the range, near the professionals' cost.

**Exit:** the stop; the target; or the verdict turns to sell while the trade is not working ("not working" to define).
**Management:** a tool to cut risk or raise R:R — averaging only inside a fixed total risk to the stop, planned ahead.

**The stop belongs to the THESIS, not the stock (Roy, 2026-10-30, on MTG).** A REVERSAL thesis (a fast fall —
accumulation happened on a lower timeframe, too fast for a daily base) puts the stop below the low of the LAST SWING DOWN —
the last sellers' swing. Below it the sellers won a swing again: the stock is probably accumulating on the daily and the
reversal thesis is broken — the verdict becomes NONE (still accumulating), not sell; a new trade may come later, lower in
the range, with its own wider stop below the base. A DAILY-ACCUMULATION thesis puts it below the base's low.
"A swing down" needs a mechanical definition (e.g. a fall of ≥ ~2× the normal daily move from a swing high to a swing low).

**The same rules on every timeframe.** A longer-term trade runs the rules on the weekly chart: a bigger stop (below the
last weekly swing down) and a bigger target. The timeframe verdict (layer 1) = which timeframe's rules worked better on
this stock's history.

**Testing: the stop and the target stay FIXED from entry to exit (Roy).** Trailing is a later, separate variant.

**Worked example — MTG, 2026-10-29 close 28.85 (Roy's levels):** distribution 30.5–31.6 (Jul 30 – Sep 11, high 31.89),
the fall on heavy volume, a selling climax Sep 30 (25.68, 2.8× volume), the automatic rally to 27.87, tests at 26.96 /
26.83 / 26.73 on light volume, a shakeout Oct 21 (27.01, bought back the next day), the sign of strength Oct 23 (close
28.80 over the range top), a quiet pullback. Daily reversal: stop 26.9 (under the Oct 21 swing low), TP1 31.6 (the
distribution top), TP2 31.9 (the high) → risk 1.95 (6.8%), R:R 1.41 / 1.56; the highest entry passing 1.5 to TP1 is 28.78.
Weekly: the last weekly swing down 31.62 → 25.68, stop ~25.4, a measured move 31.89 + 6.2 ≈ 38.1 → risk 3.45 (12%),
R:R ~2.7, ~57% of the daily size for the same dollar risk. The daily trade's target is where the weekly trade's test
begins (a two-year high).

**Learned per stock:** the buffer; how often price broke the base low and still rallied (the stop was wrong) vs broke
down for real; how often the target came before the stop (at 1.5, a hit rate above 40% just breaks even).

## The flow — a Mentor LENS, judged not hard-coded (Roy, 2026-10-30)

1. The company is a long — the house research (Prometheus / Pythia). Exists.
2. The timeframe — short swing / swing / long term (the Hotlist tabs). Exists.
3. **Mentor judges the stop** — from a visual read of the chart and the candle data. A JUDGE, not hard-coded rules
   (Roy's preference). The rules above are what he judges BY, not a formula that replaces him.
4. **Mentor judges the targets.**
5. **Mentor asks the user** for the risk and the minimum reward to risk.
6. **Mentor decides the entry prices and the size.** The highest entry and the share count are arithmetic once 3–5 are
   fixed — CODE computes them; Mentor's call is within them (enter now, or wait for the pullback and strength).

**A new Mentor lens** beside `discretionary` / `smc` / `institutional` (`services/analysisModes.js`, saved as the setup's
`trade_mode`). The Hotlist's **"Build with Mentor"** picks it automatically (Roy, 2026-10-30). Working name `thesis` (stop = where
the thesis breaks) — Roy did not pick a name; changeable.

**The setup Talos gets (Roy, 2026-10-30):** an entry LEVEL — the highest entry passing the minimum R:R — valid "at the
level and below"; and STRENGTH at the level on the 1hr or 4hr, which TALOS judges. Built on what exists
(docs/desks/mentor-talos.md): the entry leg's `price` = the level; a conditional entry (not `limit`); `pace_rungs:
["1hr","4hr"]`; a `judgment` condition for the strength (primary). Above the level → `wait` (the prompt) and a confirm
more than 0.1R worse is refused once (`priceMovedRefusal`); past the stop never fires. `enter` → the confirm card →
market. No new Talos machinery. Decided (Roy, 2026-10-30): an entry below the level keeps the PLANNED size (the risk
is smaller than planned, never resized up); NO hint on strength — Talos judges it on his own; how long an unfilled
setup waits is not decided — for now (dev) the USER sets it (Mentor asks).

**Judgement stays testable:** code hands Mentor the facts (swing highs/lows, volume spikes, the normal move, the range) —
he picks levels, he never invents the numbers under them. Tested by REPLAY (the chart cut at a past date, nothing after;
he places the levels; code plays them forward, fixed — the Talos replay harness's idea), a CONSISTENCY check (the same
chart twice), and FORWARD grading of every real call. The record goes back to him per stock ("on MTG your swing-low
stops were swept 4 of 10 times") — his judgement, corrected by his own record: that is the learning.

## Test 1 — the approach as fixed rules, on history (declared 2026-10-30, before the run)

Roy: "do we have a way to test this approach?" → "Run". A MECHANICAL stand-in for the judgement: does the STRUCTURE (the
reversal thesis, the stop below the last sellers' swing, the target at the start of the fall, the entry level from R:R,
strength before entry) have an edge at all? `services/thesisLab.service.js` (pure), `scripts/lab-thesis.mjs`.

- **Universe:** the point-in-time S&P 500 (§30 of screener-lab.md; member on the signal day; the ≥ 90% bar coverage
  rule), daily bars 2019-01-02 → 2026-10-26 (`sp500-2019-01-02_2026-10-26.json`). Signals from the 261st session on.
  Price ≥ $5, 20-day dollar volume ≥ $5M. **Held out:** signals from 2025-10-23 (the lab's held-out day).
- **ATR** — the mean true range of the last 20 sessions, known at the close.
- **Swings** — a zigzag on highs/lows with a threshold k × ATR: a swing low is CONFIRMED on the first bar whose high is
  k × ATR above it (a swing high, mirrored); known from that close on, never before. **k = 1.5** (1.0 and 2.0 shown).
- **The reversal thesis, signalled at the close of session i (long):**
  1. L\* — the lowest low of the last 60 sessions, a confirmed swing low (bar j\*).
  2. The fall — H0 = the highest high in the 40 sessions before j\*; H0 − L\* ≥ 5 × ATR(j\*).
  3. AR (the automatic rally) — the first confirmed swing high after j\*.
  4. The sign of strength — close[i] > AR, the first such close, within 60 sessions of j\*; close[i] < H0.
- **The plan at that close:** stop S = the LAST confirmed swing low at or after j\* − 0.2 × ATR (the last sellers'
  swing); target T = H0; entry level E = (T + 1.5 S) / 2.5 (R:R 1.5 at E). Rule A: (E − S) / E ≤ 10%, else no trade.
- **Entry, within 20 sessions (Roy: the user sets the wait; 20 for the test):** close[i] ≤ E → in at close[i] (already in
  the area; the sign of strength is the strength). Otherwise, on a later session m: a low ≤ S first → cancelled; a
  session with low ≤ E that closes up on its open and in the upper half of its range (DAILY stand-in for Talos's
  1h/4h strength) → in at close[m] if close[m] ≤ E + 0.1 (E − S) (the confirm's drift tolerance).
- **Exit, fixed levels:** from the next session — open ≤ S → out at the open; low ≤ S → out at S; open ≥ T → out at the
  open; high ≥ T → out at T; both in one session → the STOP (conservative). 250 sessions with neither → out at the close
  (counted). Planned size: the result in R = (exit − entry) / (entry − S), less the round-trip cost (`costFor`) in R.
- **Shorts:** the mirror (a rise to H\*, the fall to the first swing low, a close under it; stop over the last swing
  high; target the low before the rise), shown.
- **Baseline (geometry without the thesis):** every 10th session per name, the same plan from the last confirmed swing
  low and the highest high of the last 40 sessions (above the close), the same entry and exit rules.
- **Read:** trades, hit rate (target before stop) against the 40% that breaks even at 1.5R, mean R after cost, median
  days held; the 5–95% range of the mean R from a bootstrap over calendar MONTHS (2,000 draws); by year, by SPY regime.
- **PASS only if all hold:** before the held-out day the mean R > 0 with the range's 5% end > 0; held out mean R > 0;
  above the baseline's mean R in both periods. Variants (k, the buffer 0 / 0.5 ATR, R:R 2, no strength check, SPY over
  its 200-day only) are shown, not for the bar — each is another try.
- **Known limits:** a rough stand-in for Mentor's and Talos's eye; no "the company is a long" (Prometheus did not exist
  then); daily strength, not 1h/4h; today's adjusted bars; the stop-first rule on a two-sided day understates.

### Test 1 — result (2026-10-30): long PASSES, modestly; short FAILS

Two changes after the first run, both reported: (1) a BUG — a signal whose close was already at or under the stop (the
last sellers' low broke before the signal) was "entered"; now no trade (and a touch-entry gapping under the stop). (2) R
measured on the PLANNED risk (E − S), not the declared entry − S — Roy's "keep the planned size" makes a fill near the
stop risk less money, not more R; the declared measure blew up near the stop (a 58R trade, NaN at buffer 0). The first
run (declared measure, with the bug) also passed: +0.12R before (+0.01 … +0.24), +0.19R held out.

638 names, 2019-12 → 2026-10. Mean R after cost, 5–95% month-bootstrap range:

| | before 2025-10-23 | held out |
|---|---|---|
| **Long PRIMARY** | 3,568 trades, hit 37.9%, **+0.12R** (+0.04 … +0.21) | 476, hit 38.2%, **+0.14R** (−0.03 … +0.28) |
| Long BASELINE (geometry, no thesis) | 33,538, hit 31.9%, +0.07R (+0.01 … +0.13) | 4,790, +0.03R (−0.06 … +0.13) |
| **Short PRIMARY** | 4,730, hit 27.1%, **−0.12R** (−0.19 … −0.06) | 556, **−0.24R** (−0.32 … −0.16) |
| Short BASELINE | −0.09R | −0.10R |

- **The bar (long): PASS** — every check. But the held-out range crosses zero, and the edge over the baseline is
  ~+0.05R before / ~+0.11R held out: part of the long result is the rising market every long earned.
- **Robust across the variants:** every long variant +0.09 … +0.18R (k 1.0 / 2.0, buffer 0 / 0.5, R:R 2, SPY over its
  200-day). Not a lucky setting.
- **Hit 38% under the 40% break-even, yet positive:** most entries are UNDER the level (2/3 already there at the
  signal), so a winner averages ~1.7R on the planned risk and a loser ~−0.8R. The median trade LOSES (−0.64R).
- **By year:** 2019 +0.20, 2020 +0.39, 2021 +0.26, **2022 −0.13** (the bear year), 2023 +0.12, 2024 +0.08, 2025 +0.01,
  2026 +0.20. **By regime:** stormy markets better (+0.17 over the 200-day, +0.21 under) than calm (+0.08).
- **Strength (daily stand-in) adds little:** without it +0.11R / +0.14R on more trades. Talos's 1h/4h eye is untested.
- **Without the best 1% of trades:** +0.09R (+0.01 … +0.18) / +0.11R — not carried by a few gaps.
- **Shorts: no.** The mirrored reversal loses in every year but 2022–23 and in every regime, and worse than its baseline
  held out — topping reversals in the S&P 500 of 2019–2026 are not this structure's mirror.

**Read:** the long structure has a small, steady, real-looking edge (~+0.1R a trade) on fixed rules — a base the
judgement must beat, not a reason by itself. Next: test 2 (Mentor's and Talos's judgement on a replay sample) against
this +0.12R; the short side needs its own thesis, not the mirror.

## Test 1b — "buyers in control", any context (declared 2026-10-30, before the run)

Roy: "I don't want only a bounce." The verdict "daily buy" is any context in which BUYERS ARE IN CONTROL, not only a
reversal. One definition (agreed): buyers are in control from a close ABOVE the last confirmed swing high until a close
BELOW the last confirmed swing low (sellers then, until the next close above a swing high). `--control` in
`scripts/lab-thesis.mjs`; `controlSignals` in the service. Everything else as test 1 (universe, swings k 1.5, ATR,
filters, R:R 1.5 entry level, strength, fixed exits, R on the planned risk, cost, bootstrap, held out from 2025-10-23).

- **Signal:** the first close above a confirmed swing high (each swing high signals once) — a break upward.
- **Context, from what came before:** **breakout** — the close is over the highest high of the 120 sessions before
  (at its highs); else **reversal** — sellers were in control before this break; else **continuation** — buyers were
  already in control (a pullback held above the last swing low, then a new break up).
- **Stop:** the last confirmed swing low − 0.2 ATR (the sellers' last swing).
- **Target:** the highest high of the 40 sessions before the signal, when above the close (the top of the fall, or of
  the trend before the pullback); otherwise (at its highs) the MEASURED MOVE: that high + (that high − the last swing low).
- **Baseline:** test 1's (the same geometry every 10th session).
- **PASS (long) only if:** before — mean R > 0 with the 5% end > 0; held out — mean R > 0; above the baseline in both.
  Shown by context (reversal / continuation / breakout), and the short mirror.

### Test 1b — result (2026-10-30): FAIL overall — the edge is the REVERSAL context only

| Long, mean R after cost (5–95%) | before 2025-10-23 | held out |
|---|---|---|
| **All contexts (PRIMARY)** | 10,027 trades, hit 37.6%, **+0.07R** (+0.00 … +0.14) | 1,383, **+0.07R** (−0.09 … +0.20) |
| Baseline (geometry, every 10th session) | +0.07R | +0.03R |
| **Reversal** | 4,952, hit 39.2%, **+0.12R** (+0.04 … +0.20) | 669, **+0.15R** (−0.00 … +0.26) |
| Continuation | 2,717, +0.03R (−0.08 … +0.12) | 369, +0.04R |
| Breakout (at 120-session highs) | 2,358, +0.02R (−0.07 … +0.11) | 345, **−0.07R** |
| Short, all contexts | −0.15R | −0.14R |

- **The bar: FAIL** — not above the baseline before the held-out day (+0.07 = +0.07). Without the best 1%: +0.04R.
- **The reversal is test 1 again** (+0.12 / +0.15) on a broader definition — the edge is there and only there.
  Continuation and breakout trades add count (median 21 trades a name instead of 7) but no edge: their means are the
  market's drift that every long earned.
- 2022 −0.18R again; shorts lose in every context.
- **R:R 1 as the condition (Roy, a variant — another try):** the entry level moves to halfway between stop and target,
  more setups fill, the hit rate rises to ~46% (break-even 50% at the level; entries under it pay more). Long, all
  contexts: +0.07R before / +0.02R held out (13,728 / 1,729 trades) — no better. Reversal +0.11 / +0.08R (vs +0.12 /
  +0.15 at 1.5); continuation +0.04 / +0.02; breakout +0.03 / −0.09. Short −0.11 / −0.12. More trades, no more edge — and
  less on the held-out year.
- **R:R 3 (Roy, another try):** the entry level deep in the range — 3,992 / 620 trades, hit 24.1% (break-even 25%),
  +0.08R / +0.04R. Reversal +0.11 / +0.09; continuation +0.01 / −0.08; breakout +0.07 / +0.02. **The ratio does not move
  the edge** (R:R 1, 1.5, 2, 3 all ≈ +0.07R overall, ≈ +0.1R on the reversal) — it only trades the number of fills
  against the size of a win. The edge sits in the CONTEXT, not in the ratio.
- **The entry set by the RISK LIMIT, not the R:R (Roy: "where the user goes in is set by his risk limit")** — the entry
  level = the price the limit above the stop (S / (1 − r)), the R:R ≥ 1.5 only a check (`plan`, `entryBy: 'risk'`).
  Long, before / held out: 3% +0.02 / +0.08R (2,846 trades); **5% +0.10 / −0.00R** (3,157); 8% +0.10 / +0.16R (1,789);
  5% without the check +0.05 / −0.01R (14,175, hit 50%). The REVERSAL: 3% +0.09 / +0.08, 5% +0.10 / +0.08, 8% +0.08 /
  +0.22, 5% no check +0.09 / +0.07 — every range crossing zero but the last's before. Continuation and breakout: around
  zero, sign flipping. **The way in does not move the edge either** — R:R-set or risk-set, the reversal earns ~+0.1R
  and the rest ~0. With the check, fewer trades: a far stop now needs a deep pullback before the level is reached.
- **A LOWER stop (Roy: "maybe the stop needs to be lower?")** — the buffer at 1 and 2 × ATR, and the stop under the
  whole down move (the lowest low of 60 sessions, `stopAt: 'low60'`). Long, all contexts: +0.07 / +0.06, +0.08 / +0.08,
  +0.08 / +0.22R. The REVERSAL, before / held out: buffer 1.0 +0.11 / +0.12; **buffer 2.0 +0.12 / +0.22** (2,780 / 333);
  **60-day low +0.13 / +0.27** (3,416 / 446, held-out range +0.09 … +0.42, hit 45%). Before the held-out day the depth
  changes nothing (+0.11 … +0.13 at every depth); only the held-out year improves — one year, ~450 trades, and the
  held-out year has now been looked at ~30 times, so it no longer counts as unseen. Fewer trades (rule A cuts the deep
  stops) and longer holds (17 days). Read: a lower stop does not hurt and may help; not proven.
- **Tries so far on this question:** test 1's 9 variants, test 1b's 9, R:R 1 and 3, four risk limits — ~25. The
  reversal's +0.1R appears in nearly all of them, which is what a real (small) effect looks like; any single best cell
  among them is not to be trusted.
- **Read:** "buyers in control" alone is not a buy. On fixed daily rules, the reversal after a fast fall is the only
  context with an edge; continuation and breakout need something the chart alone does not give (the fundamentals step,
  or a different stop/target), or are not this approach's trade.

## Test 1c — strength on the 1h / 4h before entry (declared 2026-10-30, before the run)

Roy: "and if Talos would go in only when price is strong — would it affect?" The daily stand-in for strength changed
nothing (with +0.12 / without +0.11R) — but 2/3 of the trades entered on the signal's own close, and a daily bar cannot
see what Talos reads on the 1h / 4h. Test 1c puts a mechanical 1h / 4h stand-in in front of EVERY entry.
`scripts/lab-thesis-hourly.mjs`, `playIntraday` in the service.

- **Signals:** test 1b's REVERSAL context (where the edge is), primary settings (k 1.5, buffer 0.2, R:R 1.5 entry
  level, rule A). Long. FMP 1-hour bars from the session after the signal through the 20-session wait (cached in
  `data/lab/thesis-h1.json`); 4-hour = each session's first four hourly bars and its rest.
- **Strength (the stand-in):** watching starts once price is at or under the entry level E (at once, if the signal
  closed under it). Track the lowest bar since; strength = a bar CLOSING ABOVE THE HIGH OF THE BAR THAT MADE THAT LOW —
  sellers' last push failed, buyers took it back — in at that bar's close, if ≤ E + 0.1 (E − S). A low at or under the
  stop first cancels. No entry within the wait → no trade.
- **Exit:** the entry session's remaining hourly bars, then daily as before (gaps fill at the open; both levels in one
  bar → the stop). R on the planned risk, less the cost.
- **Compared on the SAME signals:** the daily stand-in (test 1b), no strength (in at the signal's close or the first
  touch of E), 1h strength, 4h strength. Before / held out, the month bootstrap.
- **Read:** does the hourly check raise the mean R (better entries, fewer losers) or only cut the count? Count, hit,
  mean R, and the share of signals that never enter.

### Test 1c — result (2026-10-30): strength before entry does not move the edge

On a SAMPLE (Roy chose it — the full ~14k hourly reads take ~2 hours at FMP's ~80 a minute, and the laptop ran out of
memory twice): the 4,800 signals already fetched (a block of whole names, every year) + 1,200 drawn at random from the
rest (seed 11, `--sample 1200`); 5,890 with hourly bars. Long, reversal, the same signals entered four ways:

| Entry | Before 2025-10-23 | Held out |
|---|---|---|
| Daily strength (test 1b) | 2,066 (42% of signals), hit 38.4%, **+0.10R** (+0.02 … +0.19) | 334, +0.12R |
| No strength | 3,619 (73%), hit 42.3%, **+0.10R** (+0.02 … +0.18) | 579, +0.09R |
| **1h strength** | 2,593 (52%), hit 38.6%, **+0.10R** (+0.01 … +0.18) | 419, +0.09R |
| **4h strength** | 1,616 (32%), hit 38.4%, **+0.08R** (−0.01 … +0.16) | 259, +0.10R |

- **No effect on the edge:** every entry ≈ +0.1R. Strength only CUTS the count (73% of signals enter without it, 52%
  with the 1h check, 32% with the 4h) — it skips trades that would have done as well as the ones it takes.
- The stand-in is mechanical (a close over the high of the bar that made the low); Talos's read may see more — but on
  this evidence, waiting for strength buys fewer trades, not better ones.

## Test 2 — the exit: a half at the target, the rest trailed under the swing lows (declared 2026-10-30, before the run)

Roy: "yes, let's talk exits" → half for now · the daily trail · D also. Why: the fixed exit earns ~+0.1R, and the winners
ran a median +1.6R past the target within 60 sessions (68% ≥ +1R, 41% ≥ +2R) — the best price reached, which no exit
catches; the question is how much of it a trail keeps. `--exits` in `scripts/lab-thesis.mjs`; `exitManaged` in the
service. The SAME signals, plans and entries as test 1's PRIMARY (the reversal, long); only the exit changes.

- **The trail (Roy's stop rule carried upward):** the stop rises to just under each swing low confirmed AFTER the entry
  (its low − 0.2 × ATR at the bar that confirmed it; k 1.5, the daily chart), never down; in force from the session
  after it was confirmed. Touched → out at it; a gap under it → out at the open. The same mechanics as the first stop.
- **A — fixed** (test 1): all out at the stop or the target.
- **B — half and trail:** half out at the target (a gap over it → the open); until then the stop stays at S; after it the
  other half's stop is the trail (as high as the swing lows since the entry have raised it, never under S).
- **C — trail only:** no target; the whole position's stop is the trail from the entry.
- **D — B + a time stop:** the target not reached within 20 sessions of the entry → all out at that session's close.
- **Both levels in one session** → the stop (as test 1). 250 sessions held → out at the close. R on the PLANNED risk,
  the average exit price of the two halves, less the round-trip cost.
- **Read:** trades, the share that reached the target, mean R (5–95% month bootstrap) before / held out, the median and
  mean days held (a trail that pays more but holds far longer ties up money) — plus test 1b's reversal context, shown.
- **PASS (per variant) only if all hold:** its mean R beats A's before AND held out, and its range's 5% end before is
  above A's mean before. The three are three tries: a pass by one is read with that in mind.
- **Known limits:** the trail is a rule, not Talos's eye; daily bars only (an intraday touch order is unknown — both in a
  bar → the stop); today's adjusted bars.

### Test 2 — result (2026-10-30): FAIL — no exit beats the fixed target

On test 1's signals (long, the reversal), mean R per trade (5–95% month bootstrap), mean days held:

| Exit | Before 2025-10-23 | Held out |
|---|---|---|
| **A fixed** | 3,568 · **+0.12R** (+0.04 … +0.21) · 23d | 476 · +0.14R (−0.03 … +0.28) · 19d |
| B half + trail | 3,567 · +0.13R (+0.04 … +0.23) · 33d | 461 · +0.06R (−0.12 … +0.19) · 27d |
| C trail only | 3,569 · +0.12R (+0.04 … +0.22) · 21d | 477 · −0.01R (−0.16 … +0.10) · 19d |
| D B + time 20 | 3,570 · +0.11R (+0.03 … +0.19) · 18d | 475 · +0.05R (−0.12 … +0.18) · 17d |

On test 1b's reversal context the same: A +0.12 / +0.15, B +0.12 / +0.08, C +0.12 / +0.02, D +0.11 / +0.04.

- **Before the held-out day all four are the same trade** (+0.11 … +0.13R) — the trail keeps about what it gives back.
  The winners' "+1.6R past the target" was the best price reached; a stop under the daily swing lows is hit on the way
  back from it. B holds ~40% longer for nothing.
- **Held out, every managed exit is below A.** Read with care: a trade still trailing at the end of the data is left out
  (B 97 open vs A 81) — those are mostly winners riding their second half, so B's and C's held-out numbers are biased
  down. The before period (almost all closed) says the same thing without that bias: no gain.
- **D:** half of the targets are reached after 20 sessions (hit 38% → 19%); cutting them early costs what it saves.
- **Verdict:** the fixed stop and target stay. The edge is in the entry (the reversal), not in the exit.

## Test 2b — a second target, the stop unchanged (declared 2026-10-30, before the run)

Roy: "do a second exit without changing the stop" — his MTG plan had two (TP1 31.6, TP2 31.9). Half out at the target T
(test 1's), the other half at a second target T2; the stop stays at S for the whole trade, never moved. Gaps, both
levels in a bar (→ the stop), 250 sessions → the close: as test 1. Same signals, plans, entries, cost, R on the planned
risk. `exit: 'two'` in `exitManaged`; `--exits2` in `scripts/lab-thesis.mjs`. Three T2s — three tries:

- **E — the next sellers' level:** the lowest confirmed swing high of the 250 sessions before the signal that is over T
  (the next place sellers took over); none (T at the highs) → the measured move T + (T − S).
- **F — T + 1R**, **G — T + 2R** (R = the planned risk E − S): the plain distances, for comparison.
- **Read and PASS** as test 2 (over A before AND held out; the 5% end before over A's mean), and a second read with the
  trades still open at the end of the data valued at the last close, all variants (test 2's open-trade bias).

### Test 2b — result (2026-10-30): FAIL by the bar — a small gain per trade, none per day held

On test 1's signals (long, the reversal), mean R per trade (5–95%), mean days held (closed trades):

| Exit | Before | Held out (open left out) | Held out (open at the last close) |
|---|---|---|---|
| **A fixed** | **+0.12R** (+0.04 … +0.21) · 23d | +0.14R | **+0.17R** (+0.04 … +0.29) |
| E T2 the next sellers' level | +0.15R (+0.06 … +0.25) · 32d | +0.07R | +0.19R (+0.08 … +0.30) |
| F T2 = T + 1R | +0.15R (+0.06 … +0.25) · 35d | +0.09R | +0.19R (+0.08 … +0.30) |
| G T2 = T + 2R | +0.15R (+0.05 … +0.27) · 46d | −0.01R | +0.21R (+0.10 … +0.31) |

Test 1b's reversal context the same (before A +0.12, E/F/G +0.13 … +0.14; held out at the last close A +0.17, E/F/G
+0.17 … +0.19).

- **The bar fails:** held out with the open trades left out, every T2 is under A — but that read is biased (the trades
  still riding their second half are left out: A 81 open, E 110, G 136). With them valued at the last close, every T2
  is a little over A in both periods (+0.02 … +0.04R). No variant's 5% end clears A's mean: the gain is inside the noise.
- **Per day held, nothing:** A earns +0.12R in 23 days, E +0.15R in 32, G +0.15R in 46 — the extra R is bought with
  extra time in the trade, about at the same rate.
- **Verdict:** a second target with the stop unchanged does not hurt and may add a little per trade; it is not an edge.
  One fixed target stays the rule; a second one (the next sellers' level, E) is a user's choice, not the lens's default.

## Test 3 — the short term swing's stop: 4-hour or daily (declared 2026-11-06, before the run)

Roy: "in which timeframe is it best to find the stop" for a short term swing (2–10 days). Today it reads the daily, like
a swing; the tested daily trade runs ~13 sessions (median) and the 4-hour was never tried. `scripts/lab-thesis-stop.mjs`,
`intradayStop` and `runupExit` in the service. The stand-in is mechanical, as in every test here: Mentor judges the stop.

**The 4-hour stop:** FMP 1-hour bars of the 30 sessions up to the last close known, as 4-hour bars (`toFourHour`). The last
swing low confirmed by then (k 1.5 on the 4-hour ATR, same settings) less 0.2 of that ATR. No confirmed low under the
close → the signal is left out of EVERY arm, so all arms run the same signals.

**Part A — the thesis trade, cut to the horizon.** Test 1b's reversal signals with a plan, long, a random sample (seed 11).
Same target T; the entry level recomputed from each stop (R:R 1.5, rule A 10%), so a tighter stop means a higher level.
Fixed levels, daily bars, both levels in one bar → the stop.
- A0 reference: daily stop, wait 20, hold 250 (the tested trade).
- **A1: daily stop, wait 5, hold 10 sessions** (today's short term swing).
- **A2: 4-hour stop, wait 5, hold 10 sessions.**
- Shown, not for the bar: both at wait 20.
- Measured on PLANNED risk, less the cost: R per trade, hit, days, the share of signals filled, the stop's distance in
  daily ATRs — and **R per SIGNAL** (no fill = 0), since the arms fill different trades. Before / held out from 2025-10-23.
- **PASS (A2 over A1):** the paired difference in R per signal > 0 with its month-bootstrap 5% end > 0 before, and > 0 held out.

**Part B — what Hotlist's This week actually is:** the live run-up rule (`runup_5`, 3 of 3 beat, SPY over its 200-day), the
screener universe's three years, bought at the open 5 sessions before the report, out at the close before it. The stop
is set from the evening before the entry.
- B0 no stop (the live rule) · B1 the daily swing-low stop · B2 the 4-hour swing-low stop. A gap under the stop fills at the open.
- Measured: net % per trade against SPY after cost (equal dollars), R (equal risk, B1 and B2), the share stopped, the stop's
  distance in daily ATRs, and **how often 1.5R was reachable** (the high reached entry + 1.5 × risk before the stop or the exit).
  Before / held out from 2025-11-08 (the lab's split).
- **PASS (B2 over B1):** the paired net % per trade > 0 with its 5% end > 0 before, and > 0 held out. **A stop at all
  earns its place** only if B1 or B2 does not lose net % to B0 beyond the noise — this rule's return is the run-up, which a stop can only cut.

Either part passing does not ship anything by itself; a pass means Roy decides whether `get_price_structure` reads the 4-hour.

### Test 3 — result (2026-11-06): FAIL on both parts — the short term swing's stop stays on the daily

**Part A** (2,000 signals sampled, seed 11; 1,924 with a 4-hour low; 1,668 before, 256 held out):

| Arm | Before: filled, target / stop / time, mean R, per signal | Held out: same |
|---|---|---|
| A0 daily, wait 20, hold 250 | 43%, 39 / 61 / 0%, +0.11R, +0.048 | 38%, 43 / 57 / 0%, +0.20R, +0.076 |
| A1 daily, wait 5, hold 10 | 28%, 8 / 27 / 66%, +0.09R, +0.025 | 25%, 8 / 22 / 70%, +0.08R, +0.019 |
| **A2 4-hour, wait 5, hold 10** | 35%, 12 / 33 / 55%, +0.10R, +0.036 | 32%, 6 / 35 / 59%, −0.05R, −0.014 |

The bar, R per signal A2 − A1: before +0.012 (−0.006 … +0.028), held out −0.034 (−0.084 … +0.011). FAIL. The 4-hour stop is
only a little tighter here (2.42 daily ATRs from the close against 2.85), and fills more. Cut to 10 sessions, most trades of
either arm end on the clock, not at a level. Held-out trades are few (63 and 81).

**Part B** (the live rule, 4,639 trades, 3,704 with both stops; 2,422 before, 1,282 held out). Net per trade, then per session:

| Arm | Before | Held out | Stopped | Stop distance | Reached 1.5R |
|---|---|---|---|---|---|
| B0 no stop | −0.10%, +0.29% | +0.23%, +0.59% | — | — | — |
| B1 daily stop | −0.15%, +0.28% | +0.21%, +0.51% | 23 / 20% | 5.8 / 7.0%, ~2.2 ATR | 9 / 11% |
| **B2 4-hour stop** | −0.16%, +0.29% | +0.01%, +0.22% | 36 / 33% | 3.9 / 5.0%, 1.5 ATR | 15 / 15% |

The bar, net per trade B2 − B1: before −0.007 (−0.056 … +0.047), held out −0.199 (−0.325 … −0.089). FAIL: a tie, then clearly
worse in the held-out year. The daily stop costs the rule little against no stop (−0.05% before, −0.02% held out, both inside
noise), so it is a cheap limit on the loss. The script's all-4,639 line reproduces the lab per session (+0.37% before, +0.45%
held out, screener-lab §6). The per-trade means are lower because the rule is a daily budget: each session counts once.

- **The 4-hour stop is not adopted;** `get_price_structure` keeps day and week.
- **Seen, not tested for:** on This week the 1.5R level is rarely reached from a daily stop (9–11%). The run-up's return comes
  from holding to the close before the report, so the time exit does the work there, not the target.
- **Seen, not tested for:** the 935 trades with no usable stop (nearly all with no daily swing low under the close, or 4-hour
  bars missing) did worse per session (+0.13% before, +0.18% held out). Found after the run, so it is a question, not a rule.
- The weekly stop for long term is still untested.

## Test 4 — the day trade's stop: which timeframe (declared 2026-11-14, before the run)

Roy: "under which timeframe should we look for levels in intraday / day trade?" A daily swing-low stop sits ~2 daily ATRs
under the price — too far for a trade that lives one session — and the prior (5-minute for intraday, 1-hour for a day trade)
is reasoning only; test 3 refuted the last such prior. `scripts/lab-daytrade-stop.mjs`. Mechanical stand-ins, as in every test here.

**Data.** The Hotlist screener's universe (1,177 names, today's list — survivorship, the same for every arm), 2024-11-01 →
2026-10-23. A day is a candidate when the name passed the day board's gates on the prior close (price ≥ $5, 20-day ADV ≥
$50M, ATR14 ≥ 3%) and the day could have met an in-play rule (a necessary condition only, so no signal is lost: volume ≥ the
rule's paced share, a high over the prior close). A seeded sample (seed 11) of **8,000 name-weeks** holding a candidate day;
FMP 5-minute bars of that week and the week before (the history the slower stops need). Regular session only. The 5-minute bars carry ~83% of the consolidated daily volume (a
40-week dry run, 2026-11-14), so a session's volume is scaled by the name's previous session's daily / 5-minute ratio.

**Signals — the live day-board rules** (`hotlist.columns` inPlay), replayed on the 5-minute bars:
- **10:30 (mid):** relative volume ≥ 1.5 (paced), the price over the open and over the prior close.
- **14:30 (eod):** relative volume ≥ 1.3, in the top quarter of the day's range, over the prior close.
The board's pool (news, movers, earnings) and its 60-name cap are not replayed: every name meeting the rule is a trade.
Entry at the checkpoint's price (the close of the 5-minute bar ending then), long. The board says which names MOVE, not
which way — the arms are compared on the same trades, so the stop is what is tested, not the board.

**The stops** (each the last swing low confirmed by the entry, k 1.5 on that chart's 20-bar ATR, less 0.2 of that ATR — the
tested daily rule, moved down the timeframes; none under the entry → that arm has no trade):
S5 5-minute · S15 15-minute · S60 1-hour · **SD daily (today's rule)** · LOD the day's low so far − 0.2 × the 5-minute ATR.

**Part A — intraday** (dies at today's close; both checkpoints). Exits: (i) the stop or the close; (ii) **the plan Mentor
builds: the stop, a target at 1.5R, or the close.** Filled on 5-minute bars; a bar opening under the stop fills at its open;
a bar touching both the stop and the target → the stop. Plus no stop at all (A0), exit (i) only.
**Part B — day** (the archived "tomorrow" rule at 15:30: in the top 15% of the range on 1.2× volume, up on the day; held to the
NEXT session's close; Friday signals left out — the next session is not fetched; on the same candidate days, so under the
intraday gates, stricter than the archived column's own). Stops S15, S60, SD, and none; a gap under the stop fills at the next open.

**Measured**, before / held out from **2026-03-01** (the last third): R per trade on equal RISK, after the round-trip cost
(`costFor` by ADV, in R — a tight stop pays more of it), net % per trade on equal dollars, the share stopped, the share
reaching 1.5R, the stop's distance (% and in daily ATRs), the share of signals each arm can trade.
**PASS — a timeframe replaces the daily stop for its horizon:** the arm with the best R per trade on the plan exit (ii),
paired against SD on the signals both trade, > 0 with its month-bootstrap 5% end > 0 before, and > 0 held out. Several passing →
the best held out. None passing → SD stays and the prompt's day trade keeps the daily structure. A pass changes nothing by
itself: Roy decides what `get_price_structure` reads for a day trade.

### Test 4 — result (2026-11-14, on 3,185 of the 8,000 name-weeks): FAIL — no timeframe beats the daily stop; the daily stop "wins" by not trading

The fetch was stopped at 3,185 weeks (the laptop ran short of memory); Roy chose to analyse what was in. 1,926 intraday
signals (1,447 at 10:30, 479 at 14:30; 1,156 before, 770 held out) and 327 day signals. The 5-minute bars carried 78% of
the daily volume (scaled, as declared). `data/lab/daytrade-stop.out.txt`.

Part A, both checkpoints — R per trade on the plan (stop, 1.5R target or the close), then the paired difference against SD:

| Stop | Before: R, stopped, 1.5R reached, distance | Held out: same | − SD before | − SD held out |
|---|---|---|---|---|
| S5 5-minute | −0.046, 38%, 20%, 1.7% (0.36 ATR) | −0.114, 39%, 19%, 1.7% | −0.049 (−0.104 … +0.009) | −0.103 (−0.161 … −0.047) |
| S15 15-minute | −0.016, 17%, 8%, 3.4% (0.68) | −0.082, 16%, 7%, 3.4% | −0.011 (−0.041 … +0.022) | −0.073 (−0.138 … −0.012) |
| S60 1-hour | +0.004, 5%, 3%, 6.2% (1.28) | −0.034, 3%, 2%, 6.1% | +0.011 (−0.008 … +0.033) | −0.015 (−0.044 … +0.014) |
| **SD daily** | −0.004, 2%, 1%, 13.5% (2.76) | −0.028, 1%, 1%, 13.9% | — | — |
| LOD day's low | −0.024, 18%, 8%, 3.2% (0.67) | −0.085, 18%, 6%, 3.3% | −0.027 (−0.070 … +0.017) | −0.077 (−0.151 … −0.006) |

Part B (day, held to the next close): S15 − SD −0.157 before (clearly worse), S60 − SD −0.031 before / +0.032 held out (a tie). FAIL.

- **By the declared bar, the daily stop stays.** No arm beats it; the 5-minute, 15-minute and day's-low stops are worse
  held out (their 5% ends under 0), the 1-hour ties it in both periods and in Part B.
- **But the daily stop "wins" by barely being a trade.** It sits 13–14% under the entry (2.8 daily ATRs): 1–2% of trades
  reach it and 1% reach a 1.5R target (≈20% away in one session). On equal risk that is a tiny position whose R is close to
  0 — and on entries with no edge, the arm closest to 0 R wins. The test cannot pick a stop by expectancy here.
- **The entries have no edge long:** bought at the checkpoint and held to the close, the board's names lost −0.08% a trade
  after cost before and −0.26% held out (Part B −0.97% / +0.03%). As declared, the board says which names MOVE, not which
  way — and no stop turns that into an edge.
- **Seen, not tested for:** a 1.5R target is reached intraday by 20% of trades from a 5-minute stop, 8% from a 15-minute
  stop and 2–3% from a 1-hour stop. A 1.5R plan only has a target that can fill today from the 5- or 15-minute structure — the
  stops that cost the most R held out.

## Test 4b — the day trade as Mentor builds it: a limit entry off each chart's stop (declared 2026-11-14, before the run)

Roy, on test 4: "but how far from the stops were the entries?" — 2–15% (0.2–3.4 daily ATRs). Test 4 bought at the
checkpoint, after the move; Mentor sets the stop and the target, then a LIMIT at the highest price the R:R allows, and the
monitor waits for price to come down to it. `scripts/lab-daytrade-plan.mjs`, on the 3,185 name-weeks test 4 fetched; the
same signals, gates, held-out date (2026-03-01), cost and month bootstrap.

**The plan, per chart** (5-minute · 15-minute · 1-hour · daily — the bars known at the checkpoint): S = the last confirmed
swing low under the price − 0.2 of that chart's ATR (test 4's stop); T = that chart's `rangeTarget` (the highest high of
the `lookFall` bars before, when over the price; at the highs, the measured move off S's low) — the tested thesis rule on
that chart; **E = (T + 1.5·S) / 2.5** (R:R 1.5 at E, `plan`). No plan when T ≤ E or the risk at E is over 10% (rule A).
**The fill:** price at or under E at the checkpoint → in at the checkpoint's price; else a limit at E for the rest of the
trade's life, filled when a 5-minute bar trades to it (at its open when it opens under E). A bar reaching S before the fill
cancels; a fill bar that also reaches S is filled AND stopped (−1R, the cautious reading). No strength gate (test 1c: it did
not move the edge). **The exit:** S, T, or the close (intraday) / the next session's close (day); a gap through a level
fills at the open; a bar touching both → the stop; the fill bar's own high never counts for T.

**Measured:** **R per SIGNAL** (no plan or no fill = 0) after the cost in R, R per trade, the share filled, target / stop /
close, the median risk (% and daily ATRs), the median T over E. **PASS — a chart replaces the daily for the day trade's
levels:** its R per signal paired against the daily's, > 0 with the 5% end > 0 before, and > 0 held out; several → the
best held out. Read beside it: whether ANY arm makes money per signal (> 0 with the 5% end > 0, both periods) — a stop
timeframe that only loses less is not a reason to build intraday trades.

### Test 4b — result (2026-11-14): FAIL — no chart beats the daily, none makes money; the fast charts lose

Test 4's 3,185 weeks: 1,926 intraday signals (1,156 before, 770 held out), 327 day. `data/lab/daytrade-plan.out.txt`.
Part A, both checkpoints — the share planned / filled, R per SIGNAL, and the paired difference against the daily (PD):

| Chart | Before: filled, R/signal, target/stop/close, risk, E under price | Held out: filled, R/signal | − PD before | − PD held out |
|---|---|---|---|---|
| P5 5-minute | 66%, −0.056 (−0.103 … −0.006), 25/51/24%, 1.1%, 0.6% | 68%, −0.090 | −0.051 (−0.096 … −0.003) | −0.091 (−0.140 … −0.035) |
| P15 15-minute | 48%, −0.035 (−0.066 … −0.006), 12/33/54%, 2.1%, 1.3% | 50%, −0.054 | −0.031 (−0.062 … −0.000) | −0.055 (−0.090 … −0.023) |
| P60 1-hour | 36%, +0.024 (−0.006 … +0.051), 3/12/85%, 4.1%, 2.1% | 34%, −0.000 | +0.028 (−0.001 … +0.058) | −0.002 (−0.015 … +0.012) |
| **PD daily** | 13% (planned 43%), −0.004, 0/6/94%, 6.7%, 4.8% | 13%, +0.001 | — | — |

Part B (day, to the next close): P60 − PD −0.025 before, +0.085 (+0.007 … +0.179) held out; P15 −0.188 before. FAIL.
10:30 alone: P60 − PD +0.036 (+0.001 … +0.075) before, −0.000 held out. FAIL.

- **By the bar, the daily stays — and no arm makes money per signal in both periods.**
- **The 5- and 15-minute plans lose, clearly, in both periods.** Their entry sits 0.6–1.3% under the price and fills 50–70%
  of the time; their target (1.6–3.2% over E) is reachable, and the trades are stopped more than they reach it (5-minute
  51% / 25%). The cautious fill rule (a bar that fills and reaches the stop is a loss) bears hardest on the 5-minute.
- **The 1-hour and the daily come out at ~0 because they mostly do not trade a day:** the 1-hour fills a third of the
  signals and 85–89% of those end at the close (its target, 6% over E, is out of a day's reach); the daily plans under half
  and fills 13%.
- **With test 4: a day-board name has no tested long edge on any chart, bought at the checkpoint or on a limit under it.**
  The faster the chart, the more the plan trades and the more it loses. Part B's held-out +0.085 for the 1-hour is one
  period of 121 signals, against a loss before — a question, not a rule.

**R:R 1 (Roy: "what about 1 R:R" — asked AFTER the result, so exploratory, not a declared test).** `--rr 1`
(`data/lab/daytrade-plan-rr1.out.txt`): the entry halfway between stop and target, nearer the price, so more fills and more
targets — and the same answer. Intraday, R per signal before → held out: 5-minute −0.048 → −0.069 (fills 74–76%, target /
stop 32 / 43%), 15-minute −0.031 → −0.045 (16 / 26%), 1-hour +0.000 → +0.004 (87–90% at the close), daily −0.005 → +0.005.
Against the daily held out: 5-minute −0.074 (−0.112 … −0.030), 15-minute −0.051 (−0.095 … −0.008), 1-hour −0.001. Day:
15-minute −0.191 before; 1-hour −0.013 / +0.027. At 1:1 a plan needs to win more than half its decided trades; the 5- and
15-minute plans are stopped before their target 57–62% of the time.

## Test 4c — a VWAP entry on the day board's names (declared 2026-11-14, before the run)

Roy, after 4 and 4b: "test a VWAP entry first". The ENTRY is what failed (tests 4, 4b), not the stop. `scripts/lab-daytrade-vwap.mjs`,
on test 4's 3,185 name-weeks: the same signals (10:30 and 14:30, the live rules), gates, held-out date (2026-03-01), cost
and month bootstrap. Intraday only (VWAP is the session's).

**VWAP:** the session's, from its 5-minute bars — Σ(typical price × volume) / Σ volume from the open, each bar's value at its close.
**The entry — a pullback to VWAP that holds:** after the checkpoint, the first 5-minute bar whose LOW trades at or under VWAP
and whose CLOSE is back over it → in at that close. None by 15:30 → no trade. (A name already under VWAP at the checkpoint
waits for the same thing — a reclaim.)
**The stop:** the lowest low from the checkpoint through the entry bar (the pullback's low) − 0.2 × the 5-minute ATR.
**The exits:** (a) **1.5R target, the stop or the close** — the primary, Mentor's R:R; (b) 1R; (c) the stop or the close.
A bar touching both → the stop; a gap through a level fills at its open.
**The control — is it VWAP, or any dip?** The same rule on VWAP shifted by ± 0.25 × the daily ATR (a line that moves with
VWAP but is not it), as Proteus's tests shift a line.

**Measured:** R per SIGNAL (no entry = 0) and per trade, after the cost in R; the share entered; target / stop / close;
the risk (% and daily ATRs); and VWAP − each shifted line, paired by signal.
**PASS — a VWAP entry is worth building:** R per signal on exit (a) > 0 with its month-bootstrap 5% end > 0 before, and > 0
held out. Read beside it: whether VWAP beats both shifted lines (if not, the edge is the dip, not VWAP).

### Test 4c — result (2026-11-14): FAIL — the VWAP entry loses, and VWAP is no better than a line beside it

1,926 signals (1,156 before, 770 held out). `data/lab/daytrade-vwap.out.txt`. Both checkpoints, R per signal:

| Line, exit | Entered | Before | Held out | Target / stop / close (before) | Risk |
|---|---|---|---|---|---|
| **VWAP, 1.5R (the bar)** | 60–61% | −0.042 (−0.100 … +0.013) | **−0.111 (−0.155 … −0.067)** | 33 / 48 / 18% | 0.7% (0.14 ATR) |
| VWAP, 1R | 60–61% | −0.075 (−0.123 … −0.033) | −0.115 (−0.145 … −0.085) | 42 / 43 / 15% | |
| VWAP, stop or close | 60–61% | +0.039 (−0.058 … +0.135) | −0.112 (−0.206 … −0.023) | — / 58 / 42% | |
| VWAP + 0.25 ATR, 1.5R | 51% | −0.007 | −0.081 | 26 / 37 / 37% | 1.25% |
| VWAP − 0.25 ATR, 1.5R | 27–30% | −0.051 | −0.036 | 31 / 55 / 14% | 0.6% |

VWAP − the shifted lines (1.5R): before −0.035 (vs +0.25) and +0.009 (vs −0.25); held out −0.030 and **−0.075 (−0.132 … −0.025)**.

- **FAIL:** no exit makes money in both periods; held out every VWAP exit loses, each with its 5% end under 0. 10:30 alone the same
  (−0.134 held out); at 14:30 few names come back to VWAP (12–15%), and those lose too.
- **VWAP is not special here:** it does no better than a line a quarter-ATR above it, and worse held out than one a
  quarter-ATR below. The reclaim of VWAP is not a level these names respect — Proteus's per-name VWAP test says the same
  ("nothing holds", proteus.md §10).
- The pullback's low makes a very tight stop (0.7%, 0.14 daily ATR): about half the entries are stopped. A stop under VWAP by
  a wider buffer was not tried; it was not declared, and it would trade a tighter target miss for a wider stop.
- **With tests 4 and 4b: four long entries on the day board's names — at the checkpoint, a limit off a 1.5 and a 1:1 plan,
  and a VWAP reclaim — none has an edge.** The board finds names that MOVE; none of these finds which way.

## Test 4d — a false break of the stop's level, then in (declared 2026-11-14, before the run)

Roy: "what if we place the stop, then wait for a false break of the stop level and only then enter?" — the sweep / spring
entry: sellers fail at the level first. Prior evidence is against it on daily and weekly bars (Proteus: sweeps that close
back above have not led higher on any name; the false-break rate is chance's; springs did not beat an ordinary false
break), never tested intraday on the board's names. `scripts/lab-daytrade-sweep.mjs`, test 4's 3,185 name-weeks, the same
signals (10:30, 14:30), gates, held-out date (2026-03-01), cost and month bootstrap. **The fifth intraday entry on these
names** — hence the second part of the bar.

**The level, per chart** (5-minute · 15-minute · 1-hour — the bars known at the checkpoint): the last confirmed swing low
under the price (k 1.5 on that chart's ATR — the stop's base in tests 4 / 4b). **The entry:** after the checkpoint, the
first 5-minute bar whose low trades UNDER the level opens a break; the first 5-minute close back OVER the level, on that bar
or within the 3 bars after it (`sweepBack`, the false-break measure's window) → in at that close. Not back over in time → the
break was real, no trade (one try a day). No break-and-reclaim by 15:30 → no trade. **The stop:** the sweep's low (from the
break bar through the entry bar) − 0.2 × the 5-minute ATR. **The exits:** (a) **1.5R target, the stop or the close**; (b) 1R;
(c) the stop or the close. A bar touching both → the stop; a gap through a level fills at its open.
**The control:** the same rule on the level shifted ± 0.25 × the daily ATR (a level the price never made); a shifted level
not under the price at the checkpoint → no trade.

**Measured:** R per SIGNAL (no entry = 0) and per trade after the cost in R; the share entered; target / stop / close; the
risk (% and daily ATRs); the swing low − each shifted level, paired. **PASS — a sweep entry is worth building:** on some
chart, R per signal on exit (a) > 0 with its 5% end > 0 before, and > 0 held out, **and** the swing low beats both shifted
levels on that chart (paired, > 0 before and held out). Two charts passing → the better held out.

### Test 4d — result (2026-11-14): FAIL — the sweep entry loses, and sweeps of the real swing low do WORSE than of a made-up level

1,926 signals (1,156 before, 770 held out). `data/lab/daytrade-sweep.out.txt`. Both checkpoints, exit (a) 1.5R:

| Level | Entered | R/signal before | R/signal held out | Per trade held out | Target / stop / close held out |
|---|---|---|---|---|---|
| 5-minute swing low | 25–26% | −0.046 (−0.082 … −0.014) | **−0.086 (−0.102 … −0.072)** | −0.35 | 31 / 65 / 5% |
| 15-minute swing low | 12% | −0.020 (−0.045 … +0.001) | **−0.055 (−0.069 … −0.039)** | −0.47 | 23 / 69 / 8% |
| 1-hour swing low | 2–3% | −0.007 | +0.001 | +0.05 (15 trades) | 44 / 50 / 6% |

The swing low − the shifted levels, held out: 5-minute −0.034 (vs +0.25 ATR) and −0.077 (vs −0.25), 15-minute −0.038 and
−0.045 — all four with the 5% end under 0; 1-hour +0.009 / +0.006 (ties).

- **FAIL on both parts.** No chart makes money in both periods, and the real swing low does not beat a level shifted off it —
  held out it does clearly WORSE on the 5- and 15-minute: a reclaim of the low these names just made is followed by a
  stop-out more often than a reclaim of a line nobody drew. The 1-hour sweep is too rare (2–3% of signals) to say anything.
- Tight stops again (0.5% under, 0.1 daily ATR): two thirds of the sweep trades are stopped held out.
- **The 14:30 15-minute arm "passed before" (+0.026, 2% entered, 6 trades) and lost held out** — the size of fluke the
  five-entry bar was written for.
- **Five long entries on the day board's names now — at the checkpoint, a limit at 1.5 and at 1:1, a VWAP reclaim, a sweep
  of the stop's level — none has an edge on any chart.** Matches Proteus on daily bars: a reclaimed low is not an entry on
  these names.

## Test 4e — not closing at the end of the day (declared 2026-11-14, before the run)

Roy: "did you check not closing at the end of the day?" — no: every intraday trade in 4–4d was out at the close, and the
1-hour and daily plans came out ~0 mostly because the day ran out (85–94% ended at the close, targets 6–15% away).
`scripts/lab-daytrade-hold.mjs`, test 4's 3,185 name-weeks and signals (10:30, 14:30), gates, held-out date, cost, bootstrap.

**Two entries, each off four charts** (5-minute · 15-minute · 1-hour · daily):
- **E1 — at the checkpoint** (test 4): in at the checkpoint's price; S = that chart's last swing low − 0.2 of its ATR;
  T = 1.5R over the entry.
- **E2 — Mentor's limit plan** (test 4b): S, T = that chart's `rangeTarget`, E = (T + 1.5·S)/2.5; the limit must fill
  on the SIGNAL day (a fill bar also reaching S → filled and stopped).
**Holds:** out at S or T, or at the close of the Nth session after the entry day — **N = 0 (the same day, tests 4/4b), 5,
10, 20.** The entry day plays out on its 5-minute bars; every session after on the daily bars (`screener-3y`, through
2026-10-23): a gap through a level fills at the open, a day touching both → the stop. A signal without N sessions of daily
bars after it is left out of that hold (every arm alike).

**Measured:** R per SIGNAL (no entry = 0) after the cost in R, R per trade, target / stop / time, the median sessions held,
paired against the daily chart of the same entry and hold. **PASS — holding makes a board name worth building:** some
chart × hold, either entry, with R per signal > 0 and its month-bootstrap 5% end > 0 before, AND > 0 held out. 2 entries ×
4 charts × 3 new holds = 24 arms: with that many tries one may pass the first half by luck, which is why both halves count.
A pass held past a session or two is a SHORT TERM SWING started from the day board (test 3's daily stop), not a day trade.

### Test 4e — result (2026-11-14): PASS BY THE LETTER, NOT IN SUBSTANCE — the 1-hour limit plan held 10–20 sessions

`data/lab/daytrade-hold.out.txt` (1,926 signals: 1,156 before, 770 held out). The bar's arms that passed — R per signal:

| Arm | Before | Held out | Against the daily, before / held out |
|---|---|---|---|
| **E2 1-hour, hold 10** | +0.133 (+0.062 … +0.200) | +0.006 (−0.070 … +0.074) | +0.108 (+0.040 … +0.177) / −0.006 |
| **E2 1-hour, hold 20** | +0.127 (+0.047 … +0.203) | +0.027 (−0.051 … +0.108) | +0.100 (+0.020 … +0.181) / +0.023 |
| E2 1-hour, hold 5 (not a pass) | +0.102 (+0.043 … +0.158) | −0.016 | +0.089 / −0.006 |
| 14:30 only: E1 15-minute, hold 10 / 20 | +0.181 / +0.207 (283 signals) | +0.030 / +0.019 (196) | +0.189 / −0.036 · +0.170 / +0.036 |

- **The edge lives in the years before March 2026 and is gone after it.** Held out, the passing arms are +0.006 and +0.027 R per
  signal with intervals from −0.07 to +0.1 — zero, as far as this sample can tell. The bar asked only "> 0 held out", with no
  interval: too weak a second half for 24 arms × 3 views (~72 tries), where a few first-half passes are expected by luck.
- **What held across the board:** the same-day exit loses (N = 0 repeats tests 4/4b); the 5- and 15-minute stops lose at every
  hold for E2 (stopped ~60–65%); holding helps the WIDER charts — the 1-hour and the daily turn from ~0 to positive before March.
  Holding a long 2–4 weeks in a rising tape earns something on any stop that is not hit; the stock's direction after March
  (the board's names lost −0.26% a trade at the checkpoint then) took it away.
- **Read:** a 1-hour limit plan held to the stop or the target is the one thing worth a CONFIRMATION — on data this test has
  not seen: the 4,815 name-weeks test 4 never fetched (seed 11, the same sample), declared before, with a held-out bar that
  needs its 5% end > 0. Nothing is built on this result.

## Test 4f — the confirmation, on weeks no test has seen (declared 2026-11-14, before the fetch)

Roy: "yes fetch and run the confirmation." `scripts/lab-daytrade-confirm.mjs`. **Data:** the 8,000-week sample of test 4
(seed 11, `data/lab/daytrade-sample-keys.json`) LESS the 3,185 weeks tests 4–4e analysed (`data/lab/daytrade-seen-keys.json`,
saved before the fetch) — the other 4,815, fetched now, the same way. The same gates, signals, volume scaling, cost and month
bootstrap; held out from 2026-03-01. **Only two arms**, exactly as test 4e ran them:
- **A — E2 1-hour, hold 10:** Mentor's limit plan off the 1-hour chart (S under its last swing low − 0.2 ATR, T its
  `rangeTarget`, E at R:R 1.5), filled on the signal day, then the stop, the target or the 10th session's close; both
  checkpoints (10:30, 14:30).
- **B — E1 15-minute at 14:30, hold 10:** in at the 14:30 price, S under the last 15-minute swing low − 0.2 ATR, T 1.5R,
  the stop, the target or the 10th session's close; the 14:30 signals only.
**CONFIRMED** (each arm on its own): R per signal on the new weeks' **held-out** signals (from 2026-03-01) > 0 **with its
month-bootstrap 5% end > 0**; also reported: its before-March value on the new weeks, and both periods pooled with tests
4–4e's weeks. Anything less — the arm stays unconfirmed, and nothing is built on it.

**Result (2026-11-14) — NOT CONFIRMED, both arms.** All 4,815 new weeks fetched (0 failed); `data/lab/daytrade-confirm.out.txt`.

| arm | new weeks, held out (the bar) | new, before March | 4e weeks, held out | all weeks, held out |
|---|---|---|---|---|
| A — 1-hour limit plan, hold 10 | +0.020 R (−0.041 … +0.088), 1,076 signals, 38% filled | +0.023 (−0.028 … +0.062) | +0.006 | +0.014 (−0.043 … +0.072) |
| B — 14:30, 15-minute stop, hold 10 | −0.095 R (−0.307 … +0.170), 286 signals | +0.078 (−0.027 … +0.185) | +0.030 | −0.045 (−0.245 … +0.180) |

What it says: 4e's +0.13 (A) and +0.18 (B) before March were the luck of those 3,185 weeks — on new weeks the same
period gives +0.02 / +0.08, and held out both sit on zero. Held 10 sessions, a board day trade is a small swing trade
with no measured edge. Across tests 4–4f no entry off the day boards (checkpoint, limit plans, VWAP, sweep, hold) has
an edge; nothing is built on any of them.

**Built after it (Roy, 2026-11-14: "i will check it live first - lets go for stop in 1hr").** A day trade (intraday · day)
is drawn on the 1-hour chart, the stop test 4 left standing (it tied the daily; the 5- and 15-minute did worse):
`get_price_structure` takes `timeframe: "hour"` — the last 45 days of regular-session hourly bars from the 09:30 open,
closed bars only (`thesisStructure.tools` `hourRows`), no break scenario (a day trade waits on no close to arm) and no
heavy days, and no deeper stop (its 60 bars reach ~9 sessions back: AMD's sat 25% away); a bar ends at the
session's close, 13:00 on the rule-based early closes (`market.service` equityCloseMin). Mentor's turn reads it for a day trade (`_lensTimeframe`), its risk read in normal hours. The trade monitor
breaks both horizons on a 1-hour close (`BREAK_RUNG_MAX`, was 15 minutes intraday), paces an unnamed thesis day trade on
the 1h / 15m (`THESIS_PACE_DAY`) and is told strength on the 15m / 1h (`lensLine`). The opening has a day-trade
version; Mentor never calls a day trade tested better. Whether the board's own picks (its catalyst pool, ranking and
60-row cap — not replayed by tests 4–4f) behave differently is Roy's live check; test 4g is drafted for it, not run.



## Test 5 — the stop's depth, per stock (declared 2026-11-16, before the run)

Roy, 2026-11-16: "each ticker behaves individually" — after Proteus's per-name stop test (proteus.md §10.3: no line makes
a better stop on any name beyond luck), the stop's DEPTH per name, judged on the TRADE (a deeper stop is hit less but
risks more per share — only R decides). Run knowing it is likely too thin to tell (Roy chose it: ~5–6 reversal trades a
name in 7 years; telling 0.1R apart on one name needs ~500). `scripts/lab-thesis-buffer-name.mjs`.

- **Trades:** test 1's rules exactly (`thesisLab.service` — plan, play, inR on the planned risk, `costFor`), long, the
  point-in-time S&P 500 (2019-01-02 → 2026-10-26, the ≥ 90% coverage rule, price ≥ $5, ADV ≥ $5M). Two signal sets, each
  read on its own: the REVERSAL thesis (test 1's signals) and the BASELINE geometry (every 10th session — ~10× the trades).
- **The depths (fixed now):** 0.2 ATR under the stop's swing low (Mentor's — the reference), 0.5, 1, 2 ATR, and 0.2 ATR
  under the 60-day low (`stopAt: 'low60'`). Each SIGNAL is played at every depth; a depth whose plan fails rule A or never
  fills scores 0R (no trade is a result). A trade open at the data's end is marked at the last close.
- **Per name:** signals in the older two-thirds of the name's bars choose the depth — the best mean of (R at that depth −
  R at 0.2) on the SAME signals. `respects`: that best depth beats 0.2 by ≥ 0.1R at z ≥ 3 (paired) on ≥ 15 older signals,
  and on the recent third (≥ 5 signals) still by ≥ 0.05R; else `faded` / `unconfirmed` / `no` (0.2 is the best, or the
  gain is under the bar) / `thin`.
- **The control:** each name's bars shuffled (the Proteus engine's `shuffledBars`), the identical pipeline — the same
  search over five depths, so the search's luck is on both sides.
- **PASS — a stop depth is a trait of some stocks:** real names `respects` ≥ 2× the shuffled AND ≥ 10 more, on either
  signal set. Then the depth goes into the stock's profile and Mentor weighs it (Roy, 2026-11-16). Otherwise Mentor's
  0.2 ATR stays. Beside it, not for the bar: each depth's pooled mean R before / held out (2025-10-23), and how often
  each depth is "best" per name, real vs shuffled.

### Test 5 — result (2026-11-16): FAIL — no stock has a stop depth of its own beyond luck

`data/lab/thesis-buffer-name.out.txt`. 638 names.

- **Reversal signals** (median 17 a name, most never trade): `thin` on 546 names, `no` on the other 92 — 0 `respects`
  (shuffled: 0). Too few, as expected.
- **Baseline signals** (median 166 a name — here the question CAN be answered): `respects` on 2 names — ELV (2 ATR,
  +0.27R) and NSC (1 ATR, +0.22R), both just at z 3 and barely confirmed (+0.06 / +0.07R recent) — against 1 on the
  shuffled bars. The bar was 2× and 10 more. **FAIL.**
- **The "best" depth per name is spread across all five, on the real bars and the shuffled alike** (real: 2 ATR 135,
  60-day low 131, 0.2 ATR 121, 1 ATR 95, 0.5 ATR 79; shuffled: 128 / 127 / 115 / 98 / 96 in another order) — which
  depth "wins" on a name is what chance picks.
- **Pooled, the depths are alike:** reversal +0.050R at 0.2 ATR before (the best) and +0.012R at 2 ATR; held out
  +0.048 … +0.075R. Baseline +0.027 … +0.033R before, +0.029 … +0.049R held out (deeper a hair better, held out only —
  the same small held-out lean as test 1b).
- **So:** Mentor's 0.2 ATR under the swing low stays, for every stock. With Proteus §10.3 (no line a better stop on any
  name), the stop is the one rule for all names that the data supports.

## Built (2026-10-30)

- The `thesis` lens (`services/analysisModes.js` MODES) — Mentor's prompt § The thesis lens: the six steps, the setup
  Talos gets, what was tested and how to say it.
- Mentor's tools `get_price_structure` (day / week, long / short) and `get_entry_level`
  (`services/tools/thesisStructure.tools.js`) over `services/swingStructure.service.js` — the swing code the lab also
  uses (one mechanism). Sizing reuses `size_position`.
- One target by default; Mentor OFFERS a second (the next sellers' level, half the size, the stop unchanged) and
  never sets it unasked — tests 2 / 2b (Roy, 2026-10-30: "keep one target, Mentor offers another").
- Talos's lens line for it (`monitoring/assess.shared.js` lensLine): the level and below, strength on the 1h / 4h.
- The Hotlist's Build with Mentor sends `recommended_mode: 'thesis'` (frontend `hotlist.utils.hotlistHandoff`); the
  seed text says it is the Hotlist's lens, not Argus's; a hand-off lens is validated against MODES.

QA cycle (2026-10-30, Roy: "All"): who-is-in-control and the target now run ONE replay
(`controlReplay`, `rangeTarget`, `lowestLow`, settings in `STRUCTURE`) for both the lab and Mentor's facts — checked
identical to the old two copies on 600 random series (5,422 signals), so every result above stands. The weekly read
leaves out the week still trading (shown apart as `this_week`); a short's `atr_pct` is positive; the sizing tool's
report says when its figures are for the levels before this reply (the false "entry/stop mismatch" seen in the drive).
Left as they are: the prompt section's cost (~1.2k tokens, cached — a fraction of a cent a turn) and the frontend's
lens tooltip copy (an unknown lens shows its name).

## Pieces to build

1. **Calculation engine** — the profile per timeframe; the playbook tester (a fixed menu of setups, long and short, per
   timeframe, against the stock's ordinary days and the market, with the luck check and a minimum count); conditions;
   stop / exit / size from the evidence; the fixed verdict rules. The lab's `screenerLab.service.js` (indicators,
   setups, cost model, `trade`, `spyRegimes`) is the start — built to scan all stocks, to be reshaped around one.
2. **Memory** — one document per stock, versioned.
3. **Current read** — on demand, or daily for the stocks with a file.
4. **Grading** — every verdict and read logged and graded; a scorecard per stock and overall.
5. **Mentor's tools** — e.g. `get_stock_playbook`, `test_setup`, `get_current_read`; the prompt keeps him from
   overriding the numbers.
6. **The view** — the stock's file, playbook, evidence, today's read.

Suggested order: (1) profile + playbook on prices and earnings, one stock end to end, with Mentor's tool; (2) shorts,
insiders, funds, analysts as conditions; (3) the current read; (4) grading; (5) news, then options once their data is
solved.

## Open — next to discuss

- The setup menu: which setups, which settings, per timeframe and side.
- The verdict rules: the bar a setup must clear (vs ordinary days, vs the market, the luck check, minimum examples).
- The profile's exact measures.
- What the file looks like and how a version changes.
- How Mentor uses it inside a trade plan.
- **Price-action habits as part of the stock's story (Roy, 2026-11-09).** After every one-rule-for-all
  scan test failed (industry timing, lead-lag, momentum, pullbacks, gaps), Roy's conclusion: each stock
  has its own story — the company, its events AND its price behaviour ("false-breaks the weekly",
  "respects the 20MA"). The habits sit in the stock's story beside its fundamentals and events; Roy
  does not see them as backtestable, so no declared test for now. If one is ever run, its traps are:
  luck across ~2,800 names, a placebo line (20MA vs 17/23MA), volatility explaining the habit, and
  the habit changing when the story changes.
