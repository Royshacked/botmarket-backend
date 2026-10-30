# Stock playbook — how to trade THIS stock

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
