# Stock playbook — how to trade THIS stock

**STATUS: DESIGN ONLY (2026-10-30).** Nothing built. Branch `feat/stock-playbook` (from main). Supersedes the
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
