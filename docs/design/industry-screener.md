# Pythia's industry screener — trade or not, and on which horizon (2026-10-08)

**PROPOSED, nothing built.** Roy's spec, adopted on 2026-10-08. It replaces the two three-question
drafts of 2026-10-07 (swing and months to a year), which are deleted. The spec itself is kept word for
word in the Appendix. This doc adds the decisions, how it maps onto what is built, the data status
and the build order.

The one line: **Pythia publishes the industry list, and for each industry whether to trade it and on
which horizon. The screener filters out low-probability industries; it does not pick winners.**

---

## 1. Decisions (Roy, 2026-10-08)

1. **Replace** the swing and months three-question docs with this spec.
2. **The board shows the bucket to the user in plain words**: "good now for swing", "good now for
   long term", "both", "swing only", "wait for pullback", "avoid". This is a deliberate exception to
   the `horizons.md` rule ("show only what passes our own backtest"). The buckets are shown from the
   first run; the backtest (§5) measures them afterwards.
3. **Momentum's job is to filter out, not to pick.** Momentum failed as a ranking signal
   (`horizons.md` §3 Results: no significant spread between top and bottom). Its role here is
   narrower: **if it can say "this industry is unlikely to do well" with good probability, that is
   the achievement.** The test in §5.1 measures exactly that, declared before it runs.
4. **Everything lives under Pythia.** No new desk. Pythia's three structural questions become the
   quality half of the screener, and Pythia's output becomes **the industry list, whether to trade
   each industry, and the horizon for it** (§4). This changes Pythia's contract: until now it
   "never publishes a price direction or a 6-month view" (`pythia-industry-questions.md` §2). It now
   publishes a trade verdict and a horizon; it still never publishes a weight.

## 2. How it is built: code computes, the agent judges

Same split as every desk (data versus judgment):

| Layer | Does | Where |
|---|---|---|
| **Engine (code)** | Every number: regime, moving averages, breadth, extension, ranks, ranges, volume, scores Q1–Q10 and Q12 | aether-engine, a scheduled job, stored per industry with its as-of date |
| **Pythia (built)** | Quality inputs: ROIC, margins, growth, concentration, cycle position | read, never recomputed (one shared service) |
| **Pythia's agent (LLM)** | Q11 catalyst, the one-line reasons, the verdict and horizon, the 3–5 line notes, leading stocks, "changes since last run" | the `industry_view` desk, extended; reads the stored numbers through a tool |
| **Board (FE)** | The industry list with trade verdict and horizon, sorted as the spec's output format | IndustryView (Pythia's existing board) |

The agent never computes a number. A missing number reaches it as N/A, with the reason, and it
reports it as N/A.

**Unit:** the 163 GICS sub-industries Pythia uses, rolled up when thin (Pythia's rule). The spec asks
for 50–150 groups; 163 is close and keeps one taxonomy across the app. The 74 GICS industries are
the fallback if 163 proves too thin for breadth (Q8).

**Industry price series:** an equal-weighted index of the industry's liquid stocks, built by the
engine from the universe. Industry ETFs are optional context, because most sub-industries have none.

## 3. Mapping each question to data

### Step 1 — Market regime

| Input | Source | Status |
|---|---|---|
| S&P 500 against its rising 200-day MA; distance from 52-week high | FMP daily index prices (`^GSPC`) | built (§3.1) |
| VIX against its 1-year average | FMP index quote (unchecked) or CBOE's public history | **unchecked**; the S&P 500's own 20-day realised volatility stands in, labelled so on every regime row |

### Step 2 — Quality (Q1–Q5), from Pythia

| Spec | Pythia measure | Note |
|---|---|---|
| Q1 Return on capital | Q2 economics: median ROIC and its spread against cost of capital | built |
| Q2 Margins | Q2 economics: margin level and stability, 3–5 year direction | built (direction to add) |
| Q3 Growth | Q1 demand: 10-year revenue CAGR | built; GDP growth to add as the comparison |
| Q4 Moat | Q2 economics: concentration (top-5 share) and its trend, margin stability | measured stand-in; pricing power stays judgment, labelled so |
| Q5 Cyclicality | Q3 cycle: margins against 10-year range | built; maps to early / mid / late / bust |

**BUILT 2026-10-08** (`aether_engine/screener/quality.py`, written by the same job onto each
`industry_timing` row as `quality`). Scored from the industry METRICS (the measured numbers, all 163),
not from Pythia's reviewed grades (66 answered on axl_dev, 0 in prod); the agent in step 5 can weigh a
reviewed grade that departs. Thresholds fixed before the run:

| Q | Scored as |
|---|---|
| Q1 | The industry's AGGREGATE return (ROIC; ROE for financials), not the median company's — medians let small loss-makers outvote NVDA/AVGO/MSFT (the metrics module's finding). 2 = ≥ 12% and above its cost of capital; 1 = above its cost of capital; 0 = below. "Stable across a cycle" is not measured for returns |
| Q2 | Healthy = 10-year mean operating margin ≥ the median industry's (10.7% on this run); stable = coefficient of variation ≤ 0.25; expanding = trailing twelve months above the 10-year mean (stand-in for "3–5 years"). 2 = healthy and (stable or expanding); 1 = one; 0 = neither. Financials: ROE vs cost of equity |
| Q3 | Revenue CAGR vs NOMINAL US GDP (FRED `GDP`, annual averages) over 10 and 3 years: 5.4% and 5.8% for 2025. 2 = beats both; 1 = one; 0 = neither |
| Q4 | Measured stand-in: top 5 ≥ 60% of revenue in an industry of ≥ 8 companies (consolidated), and earning above its cost of capital (barriers holding). 2 = both; 1 = one. Pricing power is judgment, not scored |
| Q5 | From the cycle placement: narrow range = 2; peak: cyclical (late) = 0, not cyclical = 1; mid: cyclical = 1, not = 2; trough: revenue growth improving over two quarters = 2 (early / recovering), else 1 (bust / low) |

**First run (asof 2026-10-07):** all five answered for 163 of 163. Quality: 1→1, 2→6, 3→16, 4→14,
5→25, 6→37, 7→25, 8→22, 9→17 (64 at ≥ 7). Cycle: 52 mid, 31 late, 23 high, 22 none, 18 early, 17 bust/low.
Spot checks read right: semiconductors 9 (ROIC 18.7%, margin 24%, 12.6%/yr growth, top 5 at 77%);
oil refining 4 (thin margins, revenue −10% over 3 years, late cycle); electric utilities 5 (ROIC 5.2%
against a 4.4% hurdle, slower than GDP). The metrics call semiconductors NOT cyclical (margin CV 0.19, no
10% revenue drop in the window), so their record margins cost 1 point, not 2.

### Step 3 — Timing (Q6–Q11)

| Spec | Data | Status |
|---|---|---|
| Q6 Relative strength 6-1 and 12-1 | daily prices (the live job); monthly prices (the filter backtest) | built (§3.1) |
| Q6 1m and 3m against S&P (context) | daily prices | built |
| Q7 Trend: above rising 50d and 200d | daily prices | built |
| Q8 Breadth: share above 50d | daily prices per stock | built |
| Q9 Extension: distance above 50d, ATR | daily prices | built |
| Q10 Volatility and liquidity | daily prices + volume | built |
| Q11 Catalyst | earnings calendar (`get_earnings_calendar`), news, rates and commodities | agent, with tools the desks already have |

### Step 4 — Crowding and flow

| Spec | Data | Status |
|---|---|---|
| Q12 Volume | daily volume | built (§3.1) |
| Q13 Sentiment | put/call, retail sentiment, analyst consensus | analyst ratings: FMP `grades-historical`, monthly from about 2018-12 (checked 2026-10-08 on AAPL, XOM, DHI: 90–94 months), so under the 10 years the full test asks for. Put/call and retail sentiment: **no source, N/A** |
| Q14 Institutional flows | ETF fund flows; 13F | **unchecked**; N/A until a source is found |

### 3.1 The engine job (BUILT 2026-10-08; weekly on Render once the blueprint is synced)

`aether-engine/scripts/run_screener_timing.py` → `market_regime/{asof}`, `industry_timing/{asof}|{sub-industry}`
(163 rows, each carrying its answering basket's numbers), `industry_timing_runs`. Code:
`aether_engine/screener/timing.py`. It reads the daily window (`daily_prices_recent`), so it can run on
Render without the Parquet history. A run with under 90% of the universe priced on the day is marked
PARTIAL on every row.

**The industry index** is equal-weighted over the basket's LIQUID companies: market cap ≥ $300M AND a
median daily dollar volume ≥ $1M over the last 60 days. The dollar-volume test was added after the
first dry run put two industries at +44,000,000% and +8,100%: six companies that trade almost nothing
(FUNR ~$20 a day on a listed "$10B" cap; AONC, GLOH, IPEU, INRE, KEGS under $15k) print prices like
12 → 0.1 → 10, and equal weighting turns one such day into the industry's move. 107 of 1,525 companies
checked fell under the floor (7%).

**Thresholds the spec does not number**, fixed on 2026-10-08 before any real run and not to be tuned to
results:

| Where | Spec says | Fixed as |
|---|---|---|
| Regime | "near highs", "well below highs", "elevated" volatility | within 5% of the 52-week high; 10% or more below; 20-day realised volatility above 1.25× its 1-year average |
| Q6 | rank on 6- and 12-month returns | the mean of the two percentile ranks; top 20% = 2, bottom 20% = 0 |
| Q7 | above a rising 50-day and 200-day | one point for each average the index is above while it rises (rising = above its value 21 trading days earlier) |
| Q8 | >60% = 2; "carried by one or two names" = 0 | under 40% = 0 |
| Q9 | near the MA or a fresh breakout = 2; >15–20% or >3 ATRs = 0 | **Changed by Roy, 2026-10-08, after the first real run:** today's distance above the 50-day as a percentile of the same distance over the industry's previous year (≥120 readings): above the 90th = 0, 70th–90th = 1, else 2. The first form (≤5% = 2; >15% or >3 ATRs = 0) read 3 ATRs of a smoothed index as ~4–5%, so semiconductors at their usual +7% scored "extended" |
| Q10 | range ~2–4%+; several stocks at 1M+ shares | one point for a median daily range ≥ 2%, one for ≥ 3 companies averaging 1M+ shares (20 days) |
| Q12 | rising moderately on up days = early; extremely heavy after a long run = crowded | up-day volume (last 20 days) ≥ 1.1× the prior 100-day average = early; ≥ 1.5× AND Q6 = 2 = crowded |

The engine scores Q6–Q10 (max 10) and flags Q12; Q11 (the last 2 Timing points) is the agent's.

**First dry run (2026-10-08, PARTIAL: 1,473 of 2,788 priced while the backfill ran):** regime GREEN
(S&P 500 0.2% below its 52-week high, 200-day rising, volatility normal); 155 of 163 sub-industries
scored; 7 baskets N/A (fewer than 3 liquid companies).

**First real run (2026-10-08, asof 2026-10-07, after the full backfill):** 2,743 of 2,788 priced
(98.4%); regime GREEN; 162 of 163 sub-industries scored (Multi-Sector Holdings N/A: 2 liquid
companies). Engine Timing (of 10): 3→6 rows, 4→30, 5→49, 6→41, 7→21, 8→11, 9→4. Q12: 31 early,
131 neutral, none crowded. Top: health care distributors / services / managed care, alternative
carriers (9); bottom: utilities, rail, multi-family REITs (3) — partly by design, since Q10 asks for a
2%+ daily range that low-volatility groups do not have. Sub-industries that share a parent's basket
show the same numbers.

**Rerun with the percentile Q9 (same day):** Q9 = 2 for 160 of 162, 1 for one (Systems Software,
+9.6%, 71st percentile), 0 for one. Engine Timing: 3→7, 4→30, 5→48, 6→40, 7→17, 8→9, 9→7, 10→4; 20
industries at 8+ (semiconductors, oil refining, tech hardware, life-science tools now among them).
**Two years (Roy, same day):** the reference became the previous TWO years. That needs ~560 days of
each industry's index, more than the daily window, so each basket's line is stored in `industry_index`
(seeded once with `run_screener_timing.py --seed-from-parquet`, extended by every run). Rerun: 144 lines
seeded with full two-year history; Q9 = 2 for 161 of 162, 1 for one (Systems Software, +9.6%, 83rd
percentile), 0 for none. Semiconductors +7.3% sit at the 64th percentile of their two years, oil
refining +5.8% at the 58th. **So the longer window changed little: on 2026-10-07 no industry is unusually
far above its 50-day by its own standards.** The S&P is near its high, but industries sit within about
±7% of their 50-day averages. Q9 will bite when that changes.

## 4. Classification

As in the spec (Appendix, Step 5): Quality max 10, Timing max 12, five buckets, Red regime downgrades
every swing bucket by one level. Thresholds are fixed as written and are not tuned to past results.

**Pythia's output per industry: trade it or not, and the horizon.**

| Spec bucket | Trade? | Horizon | Board text |
|---|---|---|---|
| Swing + Long-term | **Yes** | Swing and long term | Good now — swing and long term |
| Swing only (for now) | **Yes** | Swing (weeks) | Good now for swing only |
| Extended — wait for pullback | **Wait** (pullback) | Swing and long term | Good, but extended — wait for a pullback |
| Long-term watchlist | **Wait** (timing) | Long term | Good for long term — not the moment yet |
| Avoid | **No** | — | Not good now |

The spec has no "yes, long term only" bucket: a good business with weak timing is a wait, not a buy.

**DECIDED by Roy, 2026-10-08: Long-term watchlist is Quality ≥ 7 and Timing < 8** (the spec said
< 6). The spec left Quality ≥ 7 with Timing 6–7 in no bucket — 22 industries on the first run with
Q11 = 0, 31 with Q11 = 2 — and a good business at a middling moment is exactly "good for long term,
not the moment yet". The buckets now cover every case:

| Quality | Timing (of 12) | Bucket |
|---|---|---|
| ≥ 7 | ≥ 8, not extended, not crowded | Swing + Long-term |
| ≥ 7 | ≥ 8, Q9 = 0 or crowded | Extended — wait for pullback |
| < 7 | ≥ 8 | Swing only |
| ≥ 7 | < 8 | Long-term watchlist |
| < 7 | < 8 | Avoid |

A Red regime downgrades every swing bucket one level (spec).

**Q11 is a large lever.** The engine's Timing sits mostly at 4–7 of 10, so the agent's 2 catalyst points
move many industries across the 8 line: swing only 11 → 46 and avoid 88 → 53 between Q11 = 0 and 2.
Preview with Q11 = 0, Swing + Long-term: life-science tools, semiconductors, communications equipment,
semiconductor equipment, health care distributors, managed health care, systems software,
pharmaceuticals, electronic components.
The board lists every industry, sorted by verdict and then by Timing score.

## 5. Testing

### 5.1 Momentum as a filter (first, runs on data in Mongo now)

The question: **does the bottom of the momentum ranking reliably avoid bad industries?** Declared
here before any run; the bar is fixed now and not changed afterwards.

- **Signal:** industry 6-1 and 12-1 relative strength (Q6), bottom 20% = "filtered out" (the spec's
  tier).
- **Measure:** each month, the share of filtered-out industries that do worse than the median
  industry over the next 1, 3 and 6 months (the hit rate), and the mean return of the bottom 20%
  minus the rest.
- **Pass, at a horizon, when ALL hold:**
  - hit rate ≥ 55% on average (50% is a coin flip);
  - bottom-minus-rest negative, with a t-statistic ≤ −2 (Newey–West for overlapping horizons);
  - the same sign in both halves (2007–16 and 2017–26);
  - holds after 10bp per trade.
- **Data:** `monthly_prices` and the existing momentum backtest code (aether). Survivors only, so a
  pass is provisional until the Premium month adds delisted companies (`horizons.md` §6.4).

**Result (run 2026-10-08): FAILED at every horizon.** Survivors only; 2,788 companies, 145 distinct
industry baskets, months 2006-02..2026-09. Stored in `signal_backtests` as
`2026-10-08|momentum_filter|survivors_only` (aether `run_momentum_backtest.py --batch filter`,
grader `backtest.evaluate_filter`).

| Signal | Horizon | Hit rate (bar ≥ 0.55) | Bottom − rest | t (bar ≤ −2) | 2007–16 / 2017–26 | Net |
|---|---|---|---|---|---|---|
| 6-1 | 1m | 0.501 | −0.00% | −0.02 | +0.12% / −0.13% | +0.06% |
| 6-1 | 3m | 0.503 | −0.20% | −0.47 | +0.32% / −0.72% | +0.03% |
| 6-1 | 6m | 0.522 | −0.21% | −0.24 | +0.78% / −1.26% | −0.41% |
| 12-1 | 1m | 0.513 | −0.04% | −0.17 | +0.13% / −0.19% | +0.01% |
| 12-1 | 3m | 0.509 | −0.00% | −0.00 | +0.46% / −0.45% | +0.02% |
| 12-1 | 6m | 0.505 | +0.58% | +0.53 | +1.46% / −0.29% | +0.59% |

- **The bottom 20% does worse than the median about half the time: a coin flip.** No t comes near −2.
- **The halves disagree.** In 2007–16 the filtered-out industries did slightly BETTER than the
  rest; in 2017–26 slightly worse. The recent half alone is not evidence: picking the half that
  works is the tuning the spec forbids.
- **Survivorship works against this test.** Today's companies only means the losers that went
  bust are missing, which flatters the bottom tier. The delisted rerun (Premium month) could move
  the result, but not from a coin flip to the bar.
- **What it means for the screener:** Q6 (relative strength) does not filter out bad industries on
  its own. **Decided by Roy, 2026-10-08: Q6 stays in the Timing score unchanged, and the full
  combined test (§5.2) judges it inside the whole filter.** No reweighting before that test.

### 5.2 The full screener (the spec's own test)

The Appendix's "Testing the system" section is the contract: the full combined filter, 10+ years
including a bear market, results split bull/bear, against SPX buy-and-hold and an equal-weight
industry benchmark, no look-ahead, costs included, every alternative reported. It needs the daily
backfill and the Pythia inputs as they stood on each past date (statements carry filing dates).

#### 5.2.1 The run, as declared on 2026-10-08 BEFORE any code or result (Roy)

Fixed here so nothing can move after the numbers are seen; every alternative listed is reported.

- **Period:** weekly decisions on the last trading day of each week, **2014-01 to 2026-09** (12+ years;
  the 2020 crash and the 2022 bear inside). Quality needs 3+ years of filings, and annual statements
  start with fiscal 2011, so 2014 is the earliest honest start. Halves: **2014–2019 / 2020–2026**.
- **Point in time:** prices from the Parquet daily history (windows ending at the decision); quality
  from `industry_metrics` recomputed as of each month-end from statements ACCEPTED by then, carried to
  that month's decisions; market caps from `monthly_prices` at the prior month-end; the $1M
  dollar-volume floor on the 60 days before the decision.
- **Declared deviations:**
  1. **Annual stand-in for the trailing 12 months.** Quarterly statements cover only the last 12
     quarters, and fetching more would break the 512 MB cluster cap. Where no TTM margin exists, the
     latest ANNUAL margin stands in, the same rule on every date. It feeds Q2 "expanding" and Q5.
  2. **Q11 is mechanical:** 2 when one of the basket's five largest liquid companies (cap at the prior
     month-end) has an earnings date in the 28 days after the decision (FMP per-company earnings
     history, kept in a local file, not Mongo); else 0. This mirrors the live screen, where 60 of 66
     catalysts were earnings. **Alternatives reported:** Q11 = 0 everywhere, and Q11 = 2 everywhere.
  3. **Survivors only:** today's universe and today's GICS classification (as every result so far).
  4. **Today's data for two inputs:** the cost-of-capital hurdle (only the current Damodaran year is
     stored) and GDP (current FRED vintage). Both move slowly; recorded as look-ahead.
- **Buckets:** by `bucketFor` exactly as live (§4, Roy's widened watchlist, red regime downgrade).
- **A trade:** at each decision, every industry in a **Trade** bucket (swing + long-term, swing only) is
  bought, equal-weighted across industries, each industry as its equal-weighted liquid basket (members
  fixed at the decision), held **4 weeks**, **10bp per side**. Cohorts overlap (one opens each week);
  the portfolio's weekly return is the mean of the open cohorts'. **Long-term watchlist:** held 12
  months, reported separately, no bar.
- **Benchmarks:** the equal-weighted basket of ALL scored industries traded the same way (the bar),
  and S&P 500 buy-and-hold.
- **PASS** when ALL hold: the Trade portfolio's mean weekly return minus the equal-weight benchmark's,
  net of costs, is positive with Newey–West t ≥ 2 (3 lags, for the overlapping cohorts), and positive
  in both halves.
- **Reported** (spec): number of trades, win rate (a trade's net return > 0), average win and loss, max
  drawdown, CAGR, for the Trade portfolio, the benchmark and the S&P; split **bull / bear** (bear = the
  S&P 500 at least 20% below its running high at the decision); and the **Avoid** bucket's forward
  returns, to see whether what the screen rejects lags.

#### 5.2.2 Result (run 2026-10-08): FAILED in every variant

Survivors only. 665 weekly decisions 2014-01-03..2026-09-25; 178 baskets over time; 90,535
basket-weeks; quality from 153 month-ends (annual stand-in for 70% of companies in 2014, 4% by 2026).
Stored as `signal_backtests` `2026-10-08|industry_screener|survivors_only`, weekly series in
aether-engine `data/screener_backtest.json` (aether 0d819b3).

| Q11 | Trade − EW, per week | t | 2014–19 / 2020–26 | Trade CAGR | EW CAGR | S&P CAGR | Max DD (Trade / EW / S&P) | Trades, win rate |
|---|---|---|---|---|---|---|---|---|
| mechanical | −0.035% | −0.82 | −0.019% / −0.049% | 8.5% | 10.0% | 12.0% | −42.0% / −41.1% / −31.8% | 43,768, 55.2% |
| 0 | −0.043% | −0.78 | +0.017% / −0.095% | 8.2% | 10.0% | 12.0% | −39.7% / −41.1% / −31.8% | 26,194, 55.2% |
| 2 | −0.046% | −1.13 | −0.021% / −0.068% | 7.9% | 10.0% | 12.0% | −41.2% / −41.1% / −31.8% | 57,864, 55.1% |

- **The Trade verdict does not beat holding every industry.** It trails the equal-weight benchmark by
  about 2% a year, not significantly. Average win +5.1%, average loss −4.9% per 4-week trade, against a
  benchmark trade averaging +0.90%.
- **What the screen rejects did not lag.** Avoid baskets earned +1.31% over 4 weeks against +1.10%
  for all (mechanical Q11): the opposite of the filter's claim, as momentum alone showed (§5.1).
- **Bear markets:** only 11 decision weeks were 20%+ below the S&P's high (81 trades). The Trade
  portfolio beat the benchmark there (+0.89%/week), but 11 weeks is not evidence.
- **CORRECTED 2026-10-09 — this lead was an averaging artefact; see §5.2.7.** ~~The long-term watchlist is the one encouraging number, and it is NOT a tested result:~~
  Quality ≥ 7 with Timing < 8 earned 18.8% over the next 12 months against 14.6% for all baskets
  (mechanical; 17.3% with Q11 = 0, 21.7% with Q11 = 2). It was declared "reported, no bar", has
  heavily overlapping 12-month windows and no significance test, and survivorship flatters it.
  Testing quality alone needs its own declared test.

#### 5.2.3 Holding periods — declared 2026-10-08 AFTER the 4-week result, BEFORE any other run

Roy asked for longer holds. Choosing a hold after seeing results is how a backtest finds luck, so the
whole set is fixed here and every one is reported:

- **Holds:** 4 (a rerun, as a check that it reproduces §5.2.2), 8, 12, 16, 26 and 52 weeks; all three
  Q11 variants. Everything else exactly as §5.2.1 (decisions, buckets, costs, benchmark).
- **Bar at each hold:** as §5.2.1, with Newey–West lags of hold − 1 for the longer overlap.
- **Consistency rule (against chance across six tries):** a hold that passes counts only if a
  neighbouring hold in the list is also positive in both halves. An isolated pass is reported as
  chance.

**Result (run 2026-10-08): no hold passes, in any variant; nothing counted.** The 4-week line
reproduced §5.2.2 exactly. Trade portfolio minus the equal-weight benchmark, per week (t):

| Hold | mechanical Q11 | Q11 = 0 | Q11 = 2 |
|---|---|---|---|
| 4w | −0.035% (−0.82) | −0.043% (−0.78) | −0.046% (−1.13) |
| 8w | +0.010% (0.50), both halves + | −0.000% (−0.01) | +0.002% (0.15) |
| 12w | +0.003% (0.22), both halves + | −0.008% (−0.27) | −0.001% (−0.05) |
| 16w | +0.004% (0.29), both halves + | +0.009% (0.39), both halves + | +0.001% (0.11), both halves + |
| 26w | +0.005% (0.56) | +0.012% (0.75), both halves + | +0.002% (0.26) |
| 52w | +0.006% (0.70) | +0.013% (0.90) | +0.000% (0.03) |

- Beyond 4 weeks the Trade portfolio is indistinguishable from holding every industry: the largest
  gap is 0.013% a week (about 0.7% a year), the best t is 0.90 against a bar of 2.
- The 4-week shortfall was largely trading cost: the benchmark itself earns 10.0% a year at a 4-week
  turnover and 12.4% at 52 weeks.
- **The Avoid bucket beat the average at EVERY hold** (mechanical): +0.21% over 4 weeks, +0.46% (8),
  +0.67% (12), +0.55% (16), +0.57% (26), +1.09% (52). What the screen rejects does not lag; if anything
  it leads. Not tested for significance (overlapping windows).
- Bear weeks (11) stay too few to read.

#### 5.2.4 The fairer tests — declared 2026-10-08 after critiquing §5.2.2-3, BEFORE any run (Roy)

The first test had five weaknesses that could hide a real edge (critique, 2026-10-08): the Trade
bucket held ~half of all industries every week (66 of 136), so it was barely a filter; it tested entries
only, with fixed holds and no exits; it could only detect an edge of ~4.5%/year (t = 2); dropping
delisted companies flatters weak industries; equal-weighted baskets let small, noisy companies drive
them. (a)–(c) answer three of these; the delisted fix needs FMP Premium. Everything not stated is as
§5.2.1 (2014–2026 weekly decisions, point in time, 10bp per side, halves 2014–19 / 2020–26, holds
4/8/12/16/26/52 with §5.2.3's neighbour rule, survivors only). Every line below is reported.

**(a) Ranking — does the score carry information, wherever the bucket lines sit?** At each decision,
rank all scored baskets by the TIMING score (engine Q6–Q10 + mechanical Q11, 0–12; ties broken by Q6's
relative-strength percentile).
- Measures per hold: the mean weekly rank IC between the score and the basket's forward return
  (Newey–West, hold − 1 lags), and the TOP decile's forward return minus all baskets', net of 20bp.
- **Pass** at a hold: IC > 0 with t ≥ 2, positive in both halves, AND top-decile net excess > 0.
- Reported the same way, same bar, as alternatives: ranked by QUALITY (Q1–Q5, ties by timing), and
  by QUALITY + TIMING.

**(b) Professional exits — entries plus risk control, on single companies.** Positions are the five
largest liquid companies (cap at the prior month-end) of every Trade basket (mechanical Q11), one
position per company per decision, entered at the decision's close. Each position exits at the FIRST
of: a close below entry − 2 × its 14-day ATR (a fixed initial stop); a close below its own 50-day average
(trend break); 26 weeks (a time stop). 10bp per side.
- The portfolio's weekly return is the mean of the open positions' returns that week.
- **Benchmark:** the same rules on the five largest of EVERY scored basket.
- **Pass:** the weekly excess is positive with Newey–West t ≥ 2 (8 lags), positive in both halves.
- **Reported:** trades, win rate, average win and loss, average days held, CAGR, max drawdown, and the
  share of exits by stop, trend and time.

**(c) Liquid instruments — industries as professionals hold them.** Each basket becomes its five
largest liquid companies, equal-weighted, instead of every liquid member. This is the stand-in for an
industry ETF, which is cap-weighted and top-heavy; ETFs themselves are not mapped to GICS
sub-industries in our data. Then §5.2.3 exactly: Trade against all, three Q11 variants, six holds, same
bar and neighbour rule.

**Result (run 2026-10-08): nothing passes; nothing counted.** Survivors only, 665 decisions.

**(a) Ranking**, mean weekly rank IC (t) and the top decile's net excess over all baskets:

| Hold | Timing | Quality | Quality + timing |
|---|---|---|---|
| 4w | +0.019 (1.58), top −0.04% | +0.006 (0.66), top −0.36% | +0.015 (1.56), top −0.15% |
| 8w | +0.016 (1.05), top +0.05% | +0.008 (0.65), top −0.50% | +0.013 (1.08), top −0.09% |
| 12w | +0.013 (0.73), top +0.12% | +0.006 (0.46), top −0.66% | +0.009 (0.59), top −0.10% |
| 16w | +0.018 (0.99), top +0.28% | +0.004 (0.25), top −0.79% | +0.009 (0.55), top −0.02% |
| 26w | +0.036 (1.88), top +1.29% | −0.001 (−0.04), top −1.26% | +0.017 (0.73), top +0.46% |
| 52w | +0.020 (0.69), top +2.33% | +0.002 (0.06), top −1.87% | +0.011 (0.30), top +0.02% |

- **Timing carries a weak, consistent signal.** The IC is positive at all six holds and in both halves
  at every one (12 of 12), but the best t is 1.88 (26 weeks), under the bar of 2. The top decile beats
  the average only from 8 weeks on, and by little until 26 weeks (+1.3%) and 52 weeks (+2.3%).
- **Quality as ranked carries no information**, and its top decile LAGS at every hold (−0.4% to
  −1.9%). Positive in 2014–19, negative in 2020–26. This contradicts the long-term watchlist's 12-month
  lead (§5.2.2), which was quality ≥ 7 AND timing < 8, never tested on its own.

**(b) Professional exits** (single companies, 2×ATR stop, 50-day trend exit, 26-week time stop):
Trade minus the same rules on every basket +0.078%/week (about 4%/year), t 1.33, halves +0.003% /
+0.145%: almost all of it after 2020. CAGR 7.4% against 3.4%, max drawdown −25.5% against −29.0%.
186,889 trades, win rate 33%, average win +7.7%, average loss −3.4%, 18 days held; exits 81% trend,
19% stop, 1% time. **Note the absolute level:** the same exit rules on every basket made 3.4% a year,
against ~10% for simply holding the same industries. These stops and trend exits cost far more than
any selection added in this period.

**(c) Liquid baskets** (five largest companies) reproduce §5.2.3: from −0.047% to +0.012% a week, best
t 0.74; the 4-week shortfall again ~2% a year of trading cost.

#### 5.2.5 Buying leaders on pullbacks — declared 2026-10-09 BEFORE any run (Roy)

**Where the idea came from (so it is clear it was found by looking).** The 34 industries that beat the
S&P over 2014–2026 were in Trade 54% of weeks against 46% for the rest; but within them, the next 52
weeks returned +17.9% after a "Trade" week against +25.0% after a "not now" week. The screen says "now"
after the run and "not yet" on the dips. The hypothesis, hence: **buy long-term leaders when a
pullback ENDS.** Because it came from the data, it counts only if this declared test passes.

Everything not stated is as §5.2.1 (weekly decisions 2014-01..2026-09, point in time, equal-weighted
liquid baskets, 10bp per side, halves 2014–19 / 2020–26, holds 4/8/12/16/26/52 with §5.2.3's neighbour
rule, survivors only). All definitions are on the basket's equal-weighted index, on daily closes,
evaluated at each decision's close:

- **Leader:** top 30% of all scored baskets by 12-1 return, AND the index is above its 200-day average,
  which is itself above its value 21 trading days earlier (rising).
- **Pullback:** the index closed below its 50-day average on at least one of the last 20 trading days.
- **The pullback ends** (Roy's choice, the PRIMARY rule) — **reclaim:** the index closes above its
  20-day average. Reported alternatives, same bar:
  - **range break:** a close above the highest close of the previous 10 days;
  - **momentum:** the 14-day RSI fell below 40 within the last 20 days and is now above 50;
  - **breadth:** the share of the basket's companies above their own 50-day average is 15+ points
    above its low of the last 20 days;
  - **buy the dip:** the index is below its 50-day average now (no end signal; buying INTO the pullback).
- **Fresh signals only:** a signal counts at a decision only if its condition is true now and was NOT
  true at the previous decision (one entry per pullback, not one per week the condition lasts). The
  leader and pullback conditions must hold at the signal.
- **The comparison (the bar):** each signal's forward return over the hold, net of 20bp, minus the mean
  forward return of ALL leaders at the same decision. This separates the TIMING from the leaders' own
  edge. **PASS** at a hold: the mean of the weekly averages of that excess is positive, Newey–West t ≥ 2
  (hold − 1 lags), positive in both halves; and the neighbour rule.
- **Reported:** number of signals, win rate, average win and loss; the same signals against ALL baskets
  and against the S&P; the leaders-any-week portfolio against all baskets (is being a leader worth
  anything on its own?).

**Result (run 2026-10-09): no rule passes, and waiting for the pullback to end HURT.** Each cell: the
signal's forward return net of 20bp minus the average leader bought the same week (t).

| Hold | Reclaim 20-day (primary) | Range break | RSI turn | Breadth turn | Buy the dip | Leaders vs all baskets |
|---|---|---|---|---|---|---|
| 4w | −0.28% (−1.42) | −0.26% (−1.29) | −0.08% (−0.32) | −0.38% (−2.42) | −0.31% (−1.64) | +0.21% (1.56) |
| 8w | −0.28% (−1.08) | −0.29% (−0.93) | −0.35% (−1.14) | −0.45% (−1.72) | −0.40% (−1.23) | +0.34% (1.46) |
| 12w | −0.56% (−1.86) | −0.22% (−0.53) | −0.62% (−1.73) | −0.16% (−0.50) | −0.70% (−1.60) | +0.52% (1.70) |
| 16w | −1.11% (−3.24) | −0.55% (−1.12) | −0.77% (−1.69) | −0.70% (−1.95) | −0.77% (−1.48) | +0.71% (1.94) |
| 26w | −1.61% (−3.09) | −1.24% (−2.38) | −1.65% (−2.86) | −1.15% (−2.11) | −1.14% (−1.60) | +1.16% (2.19) |
| 52w | −2.78% (−2.93) | −1.63% (−2.22) | −2.97% (−2.51) | −1.93% (−2.68) | −3.42% (−2.90) | +1.69% (1.40) |

~1,400–2,300 signals per rule; win rates 56–67% (mostly the market rising).

- **Every rule, at every hold, did worse than simply buying the same leaders in any week.** From 16
  weeks on the shortfall is significant: buying the reclaim of the 20-day cost 1.1% (16 weeks), 1.6%
  (26) and 2.8% (52) against the average leader, t −2.9 to −3.2.
- **Why the idea looked good and failed:** it came from the industries that TURNED OUT to be the
  winners. Within those, every dip recovered, by construction. In real time, a leader's pullback is as
  often the start of its leadership ending, and buying it then is worse than holding a leader that is
  still running. The finding was hindsight; the declared test removed it.
- **Leaders on their own** (top 30% by 12-1 above a rising 200-day) beat all baskets by +0.2% (4 weeks)
  to +1.7% (52 weeks). At 26 weeks the t is 2.19, but all of it is 2020–26 (2014–19 slightly
  negative), so it would not pass the both-halves rule; it was reported, not tested.
- Against the S&P the signals were roughly flat (−0.2% to +1.5%).

#### 5.2.6 Event first, technicals for entry — declared 2026-10-09 BEFORE any data or code (Roy)

**The idea (Roy):** a swing trade should follow an event (earnings); technicals only time the entry.
Price-only timing failed throughout §5.2; an earnings reaction carries new information. Classic
earnings drift on the SURPRISE has faded for large caps (horizons.md §1, Martineau 2022); drift after
the market's REACTION to the report has held up better (Brandt et al. 2008), and is what professionals
trade as gap-ups / episodic pivots.

- **Data:** each company's earnings history from FMP (date, EPS actual and estimate), fetched to a local
  file; daily prices from the Parquet history. Universe and liquidity as the screener (cap ≥ $300M at the
  prior month-end, median dollar volume ≥ $1M over the prior 60 days). Reports 2014-01..2026-08.
  Survivors only.
- **The event:** a report on day E with EPS above its estimate, and a REACTION over days E and E+1
  (covering before-open and after-close reports): the close of E+1 at least **+5%** above the close of
  E−1, with the higher of the two days' volume at least **2×** the average of the 50 days before E−1.
  The reaction low is the lower of the two days' lows.
- **Entries:**
  - **immediate:** at the close of E+1;
  - **technical (Roy's primary): holds the gap 3 days:** at the close of E+4, only if no close in
    E+2..E+4 was below the reaction low; otherwise no trade.
- **Holds:** 1, 2, 4 and 8 weeks (5 / 10 / 20 / 40 trading days) from entry, 10bp per side.
  **Primary:** a fixed hold. **Reported:** the same with a stop on a close below the reaction low.
- **The comparison (the bar):** the event stock's net return over the hold minus the mean return over
  the SAME days of its sub-industry's other liquid companies (none reporting within 5 trading days of E):
  the event's own value, net of the industry's move.
- **PASS** (technical entry): the weekly mean of that excess (events grouped by entry week) is positive,
  Newey–West t ≥ 2 (lags = hold weeks − 1, at least 1), positive in both halves (2014–19 / 2020–26),
  with §5.2.3's neighbour rule across the four holds.
- **Reported:** the immediate entry the same way; technical minus immediate (what the confirmation adds);
  events, win rate, average win and loss; the events in the screener's Trade industries against the rest
  (from the saved weekly verdicts — does Pythia's screen add anything to an event); the same reaction
  WITHOUT a beat (does the beat matter, or only the reaction).

**Result (run 2026-10-09): FAILED, and in the opposite direction.** 99,871 reports; 85,914 of liquid
companies; 13,920 reacted +5% on 2× volume; 11,583 of those beat (451 had no quiet peer). Trades: beat +
immediate 11,206, beat + technical 10,569 (the 3-day hold filter kept 94%). Each cell: the stock's net
return minus its sub-industry's quiet peers over the same days (t):

| Hold | Beat, technical (PRIMARY) | Beat, immediate | Beat, technical, with stop | No beat, technical |
|---|---|---|---|---|
| 1w | −0.20% (−1.75) | −0.32% (−2.76) | −0.22% (−1.88) | −0.48% (−1.98) |
| 2w | −0.40% (−3.11) | −0.38% (−2.37) | −0.42% (−3.27) | −0.60% (−2.12) |
| 4w | −0.74% (−3.64) | −0.85% (−3.98) | −0.95% (−4.17) | −0.62% (−1.22) |
| 8w | −0.77% (−2.89) | −0.98% (−3.24) | −1.19% (−3.16) | −0.89% (−1.38) |

- **Buying a beat-and-gap-up LOSES against the stock's own industry**, in both halves, at every hold, and
  significantly from 2 weeks on. On this data (survivors, 2014–2026) gaps fade; they do not drift.
  Survivorship flatters the gappers (the ones that later collapsed are missing), so the true number is
  likely worse.
- **The technical confirmation helps a little:** +0.1% to +0.2% over buying at once. That is not enough to
  turn a losing setup into a winning one.
- **The stop made it worse** at 4 and 8 weeks: it cut winners and losers alike after volatile starts.
- **The beat barely matters:** a gap without a beat fades about as much.
- **Pythia's screen did not help:** events in Trade industries did worse than events elsewhere at
  every hold (e.g. −0.34% against −0.03% at 1 week).
- Win rates of 51–54% and average wins about equal to average losses: a coin flip that pays the
  spread to the peers.

#### 5.2.7 Each bucket against the same week's industries — a report, not a declared test (2026-10-09)

Roy asked whether swing needs quality or only timing. By the spec, timing alone makes a swing trade
(quality < 7 with timing ≥ 8 is "swing only"); quality decides only whether it is also long term (and,
in a red market, where a swing bucket falls). From the saved weekly verdicts (mechanical Q11), each
bucket's forward return minus ALL baskets' in the SAME week, t (Newey–West), halves 2014–19 / 2020–26:

| Bucket | 4w | 26w | 52w |
|---|---|---|---|
| Swing + long term (Q ≥ 7) | +0.03% (0.41) | −0.74% (−1.34) | −1.18% (−1.09) |
| Swing only (Q < 7) | +0.10% (1.33) | +0.46% (1.44) | +0.68% (0.85) |
| Extended | −0.16% (−0.74) | +0.59% (0.49) | +0.72% (0.27) |
| Long-term watchlist (Q ≥ 7) | −0.31% (−2.70) | −1.38% (−2.59), −1.76% / −1.04% | −2.22% (−2.14), −2.60% / −1.84% |
| Avoid | −0.04% (−0.45) | −0.02% (−0.06) | +0.04% (0.05) |

- **High quality went with LOWER returns.** The watchlist lagged significantly in both halves; swing +
  long term did worse than swing only. The ranking test (§5.2.4 a) found the same: quality's top decile
  lagged at every hold. Good industries are priced as good; the structural answers are a description,
  and count toward returns only paired with price (horizons.md §1) — as this design always said.
- **The §5.2.2 "18.8% against 14.6%" was an artefact.** It averaged across all basket-weeks, so it was
  dominated by the periods when many industries sat in the watchlist — periods when everything rose. The
  same-week comparison removes the market's moves and reverses the sign. Recorded so nobody builds on it.

#### 5.2.8 Quality paired with price — declared 2026-10-09 BEFORE any code (Roy)

horizons.md §1 always held that the structural answers count toward returns only PAIRED WITH PRICE: a
good industry at a normalised valuation below its own history. §5.2.7 found quality alone lags (good
industries are priced as good). This tests the pairing.

- **Data limit (said first):** annual statements start with fiscal 2011, so a point-in-time industry
  valuation exists from ~2014, and "against its own history" needs 36 months of it: decisions start
  **2017-01**. A 3–5 year test would have ~2 non-overlapping periods — too few to decide anything. So
  the **PRIMARY horizon is 12 months** (decisions 2017-01..2025-09); 36 months is REPORTED only.
- **Decisions:** monthly, at each month-end; everything point in time (statements accepted by then,
  market caps at that month-end, quality via `quality_at` as in §5.2.1 with its annual stand-in).
- **Normalised earnings yield, per answering basket** (companies above $300M at the month-end):
  - non-financials: the basket's 10-year mean operating margin (the metrics' normalised margin) × its
    companies' latest annual revenue, over enterprise value (market caps + total debt − cash, latest
    annual balance sheets);
  - financials (the metrics' cycle measured on ROE): normalised ROE × latest equity, over market cap.
- **Cheap:** the yield in the TOP 30% of the basket's OWN monthly history (all months from 2014 to the
  previous month, at least 36). **Expensive:** bottom 30%.
- **Groups** (each month): **good + cheap** (quality ≥ 7 and cheap) — the PRIMARY; reported:
  cheap alone, good alone, good + expensive, and cheap against OTHER industries (top 30% of the month's
  yields).
- **Returns:** each basket cap-weighted (monthly prices, dividend-adjusted), compounded over the horizon;
  10bp per side.
- **The comparison (the bar):** the group's mean forward return minus all baskets' that month. **PASS**
  (12 months): positive with Newey–West t ≥ 2 (11 lags), positive in both halves (decisions 2017–2020 /
  2021–2025). Survivors only.

**Result (run 2026-10-09): PASSED at 12 months — the first pass in §5.2, and narrowly.** Each group's
forward return (cap-weighted, net of 20bp) minus all baskets' the same month (t); decision months
2017-01..2025-09 (105) for 12 months, ..2023-09 (81) for 36:

| Group | 12 months (the bar) | 36 months (reported only) |
|---|---|---|
| **Good + cheap** (PRIMARY, 1,690 picks) | **+2.41% (2.03), halves +3.16% / +1.78% — PASS** | +8.40% (8.01*) |
| Cheap alone | +0.13% (0.09) | +7.74% (1.87) |
| Good alone | −0.06% (−0.08) | −0.74% (−0.31) |
| Good + expensive | −0.36% (−0.27) | −4.74% (−1.13) |
| Cheap against other industries | −0.95% (−1.04) | +0.14% (0.04) |

* A t of 8 on 81 overlapping 36-month windows with 35 lags is not credible (Newey–West understates the
variance when the lags approach the sample); treat the 36-month t as uninformative.

- **The pattern is the one horizons.md predicted on 2026-10-05, before any data:** neither quality nor
  cheapness alone pays; quality bought cheap against its own history does, and quality bought dear does
  worst. The hypothesis was not found by looking, which is what makes the pass worth something.
- **Why it is NOT live yet:** (1) t 2.03 is at the edge of the bar; (2) survivors only, and survivorship
  flatters CHEAP groups most (value traps that went bust are missing) — the Premium month must rerun it;
  (3) two inputs are today's (Damodaran hurdles, GDP vintage); (4) ~16 baskets a month, so a few
  industries may carry it — not yet checked; (5) only ~8 independent years.

#### 5.2.9 Robustness of the quality + price pass — checks declared 2026-10-09 BEFORE the rerun

Report only: none of these re-grades §5.2.8's pass; they show whether it is fragile. All on the same
decisions, 12 months, against all baskets the same month (t, Newey–West 11 lags):

1. **Who carries it:** the industries most often in good + cheap and their share of the total excess;
   the sectors' shares.
2. **Leave out the top contributors:** drop each of the five largest contributors, one at a time, then
   all five together.
3. **Leave out 2020** (the crash and the rebound into 2021): decisions in 2020 removed.
4. **Neighbouring thresholds** (every one reported, none chosen): cheap = top 20% / 40% of own history;
   good = quality ≥ 6 / ≥ 8.
5. **Equal-weighted** baskets instead of cap-weighted.

**Result (run 2026-10-09): the pass is FRAGILE — concentrated in a few large companies.** The base
reproduced §5.2.8 exactly (+2.41%, t 2.03).

1. **Who carries it:** 77 industries were ever picked, but five carry most of it: Semiconductors (45% of
   the total excess), Commercial & Residential Mortgage Finance (33%), Household Durables (29% — which
   cap-weighted is APPLE, $4.9T against $37B for the next company; see the GICS note in §5.2.5's winners
   check), Interactive Media & Services (27%), Building Products (17%). The largest drags: Cable &
   Satellite, Diversified REITs, Beverages. By sector, Information Technology and Financials carry it;
   Real Estate and Consumer Staples work against it.
2. **Leave out the top contributors:** dropping any ONE of the five takes t under 2 (1.03–1.85);
   dropping mortgage finance also turns 2021–26 negative. **Without all five: +0.30%, t 0.16.**
3. **Leave out 2020:** +2.38%, t 1.76 — the size holds, the t does not.
4. **Thresholds:** quality ≥ 7 or ≥ 8 is positive at every cheapness cut (+2.1% to +3.0%, t 0.87–2.58);
   quality ≥ 6 is not (+0.5%). The quality line matters; the size is steady above it, the t is not.
5. **Equal-weighted baskets: +0.69%, t 0.45, 2021–26 negative.** The effect lives in the largest
   companies of each industry.

**Reading:** the signal is real in direction and size for quality ≥ 7, but it is largely a few mega-cap
industries — semiconductors, Apple, Alphabet/Meta — bought when they were cheap against their own
history (2022 above all) and recovering. A rule that works because five large industries recovered is not
yet a rule. Not live; the Premium month (delisted companies) and more years are what can settle it.

#### 5.2.10 Step 1 of the long-term pipeline: hot and getting-hot industries — declared 2026-10-09 BEFORE any code (Roy)

**The pipeline (Roy):** (1) the app shows the industries that are hot or getting hot; (2) Argus and
Prometheus choose the companies inside them; (3) Atlas allocates. The three together are meant to beat
the big indices. **This tests step 1 only.** Step 1's job is not to beat the S&P as a basket: steps 2–3
do not buy the average company. Its job is to be a better HUNTING GROUND: industries where more of the
companies, and the best of them, beat the index. (Against the index directly, the average industry
trailed SPY by 1.9%/yr and QQQ by 8.2%/yr over 2017–2026, and good + cheap only matched SPY; §5.2.9.)

- **Decisions:** monthly, 2017-01..2025-09; point in time as §5.2.8 (quality via `quality_at` with its
  annual stand-in; prices and caps at the month-end). Baskets: the answering baskets, companies above $300M.
- **The seven definitions** (each graded separately; a basket can be in several):
  1. **Hot:** top 30% of baskets by 12-1 return (cap-weighted).
  2. **Getting hot:** its 12-1 return rank rose by 30+ percentile points over the last 6 months and is
     now above the median.
  3. **Growing:** revenue CAGR over the last 3 years above its 10-year CAGR AND above nominal GDP's 3-year.
  4. **Good + cheap:** quality ≥ 7 and normalised earnings yield in the top 30% of its own history (§5.2.8).
  5. **Earnings breadth:** at least 60% of its companies with two reports a year apart grew EPS year on
     year in their latest report (FMP earnings history, by report date), and that share rose over the
     last 3 months.
  6. **Margins turning up:** the trailing margin's percentile in its own 10-year range rose by 20+ points
     over the last 6 months.
  7. **Hot and growing:** 1 and 3 together.
- **PRIMARY measure — the pool's hit rate:** the share of the flagged baskets' companies whose next
  12-month return, net of 20bp, beats SPY's (dividends included), minus the same share among ALL
  baskets' companies that month. **PASS:** positive with Newey–West t ≥ **2.5** (11 lags; raised from 2
  because seven definitions are tried), positive in both halves (2017–2020 / 2021–2025).
- **Reported:** the flagged pool's best-quartile company return against all companies'; the flagged
  baskets (cap-weighted) against SPY and against QQQ; the pool's size; 36 months for the hit rate.
  Survivors only — which flatters every pool's hit rate alike, and the cheap pools most.

**Result (run 2026-10-09): good + cheap passes as a hunting ground; hot + growing is close; the rest
do not.** Hit rate = the share of the pool's companies that beat SPY over the next 12 months, minus the
share among all companies (percentage points, t). 105 decision months:

| Definition | Pool (median companies) | Hit rate vs all, 12m | Best quartile vs all | Baskets vs SPY | Baskets vs QQQ |
|---|---|---|---|---|---|
| **Good + cheap** | 286 | **+4.7pp (3.45), halves +6.8 / +3.1 — PASS** | +2.2% | +0.5% | −5.8% |
| Hot + growing | 347 | +2.5pp (2.44), halves +3.5 / +1.8 — just short of 2.5 | +0.7% | −1.1% | −7.4% |
| Getting hot | 311 | +1.5pp (1.14) | +2.0% | +0.1% | −6.2% |
| Hot | 705 | +0.7pp (0.68) | +0.5% | −1.5% | −7.9% |
| Growing | 1,095 | +0.2pp (0.19) | −0.6% | −2.4% | −8.7% |
| Earnings breadth | 702 | −0.1pp (−0.12) | −0.2% | −2.6% | −8.9% |
| Margins turning up | 334 | −1.4pp (−0.82) | −1.0% | −3.4% | −9.7% |

36 months (reported only): good + cheap +3.6pp (1.35, 2021–25 negative); hot + growing +2.9pp (1.68);
growing +1.4pp (1.66); the rest flat or negative.

- **For step 1, good + cheap is the hunting ground that works on this data:** about 5 points more of its
  companies beat SPY over the next year, in both halves, and the hit rate counts every company equally —
  so, unlike §5.2.9's cap-weighted basket, it is not five mega-caps carrying it. Its best quartile is 2.2%
  better too: the pool is richer where steps 2–3 pick.
- **Hot + growing** (leadership confirmed by accelerating demand) is the second candidate: +2.5pp,
  positive in both halves, t 2.44 against the raised 2.5.
- **Momentum, demand, earnings breadth and margins alone do not make a better pool.**
- **As baskets none beats QQQ** (−5.8% at best): step 1 alone does not beat the index — as Roy framed
  it, steps 2–3 must. Survivors only; the Premium-month rerun is still required before live.

#### 5.2.11 Concentration of the step-1 pass — checks declared 2026-10-09 BEFORE the rerun

Report only; none re-grades §5.2.10's pass. All on good + cheap's 12-month hit rate against SPY (pool's
share minus all companies' share, Newey–West 11 lags):

1. **Who supplies it:** every industry ever flagged — months flagged and its share of the total extra
   hit rate; sector shares.
2. **Leave one out:** without each of the five largest contributors in turn, then all five.
3. **Without 2020** decisions.
4. **Neighbouring thresholds** (all reported): quality ≥ 6 / 7 / 8 × cheap top 20% / 30% / 40%.
5. **Without the largest companies:** the pool and the base both drop each industry's top 20% of
   companies by market cap at the decision.

**Reading, fixed now:** robust if the extra hit rate stays positive in both halves without any single
top contributor and across the neighbouring thresholds; fragile if dropping one or two industries ends it.

**Result (run 2026-10-09): broader than the basket result, but by the reading fixed in advance it is
FRAGILE on one industry — Regional Banks.** The base reproduced §5.2.10 (+4.7pp, t 3.45).

1. **Who supplies it:** 77 industries ever flagged; 54 added, 23 subtracted. Top five = 67% of the total:
   Regional Banks 30%, Banks (industry level) 12%, Semiconductors 10%, Food, Beverage & Tobacco 8%,
   Specialty Retail 6%. By sector: Financials 40%, Consumer Discretionary 21%, Information Technology 16%.
2. **Leave one out:** without Banks, Semiconductors, Food/Beverage/Tobacco or Specialty Retail it holds
   (+4.2 to +5.0pp, t 2.69–3.42, both halves positive). **Without Regional Banks: +3.2pp, t 1.63, and
   2021–25 turns negative (−0.6pp).** Without all five: +1.7pp, t 0.96, 2021–25 −1.8pp.
3. **Without 2020:** +4.2pp, t 3.00, both halves — holds.
4. **Thresholds:** quality ≥ 6 or ≥ 7 at every cheapness cut is positive in both halves (+2.7 to
   +6.2pp, t 1.98–3.61); quality ≥ 8 at 20% and 30% turns 2021–25 negative.
5. **Smaller companies only** (each industry's top 20% by cap removed): +4.5pp, t 3.65, both halves —
   **not a large-company effect**, unlike §5.2.9's basket.

**Reading (as fixed before the run):** robust to 2020, to size and to four of the five leave-outs, but
dropping ONE industry — Regional Banks — ends the 2021–25 half. So, by the declared reading, fragile.
**And it is fragile exactly where survivorship bites hardest:** regional banks were "cheap against their
own history" in 2023, and the banks that failed that year (Silicon Valley, Signature, First Republic)
are MISSING from a survivors-only universe — the pool's losers were removed. The Premium-month rerun
with delisted companies is the test that decides this; until then step 1 has a promising lead, not a rule.

#### 5.2.12 Good + cheap without the value traps — declared 2026-10-10 BEFORE any code (Roy)

**Where it came from (found by looking, so the bar is raised):** inside good + cheap, the industries that
sat in the pool longest were "cheap for a reason" — Diversified and Industrial REITs, payment processing,
cable, commodity chemicals — and did WORSE there than overall, while recovering industries (banks,
building products, semi equipment, consumer finance) did much better. Roy: remove the cheap AND declining.

Same decisions, data and measure as §5.2.10 (monthly 2017-01..2025-09, the share of a pool's companies
beating SPY over 12 months, survivors only). Good + cheap as §5.2.10, then REMOVE a flagged industry that
is also declining by:

1. **Returns falling:** the industry's aggregate return on capital (ROIC; ROE for financials — the
   metrics' own measure) in its latest fiscal year below its own average of up to 10 years, AND below
   its value 3 years earlier.
2. **Demand shrinking:** revenue CAGR over the last 3 years below its 10-year CAGR AND below nominal GDP's.
3. **Price still falling:** in the bottom 30% of baskets by 12-1 return.
4. **Any of the three** (reported).

- **Compared with:** (a) ALL companies — the general pool; (b) plain good + cheap — does removing
  the traps improve on it?
- **PASS** (each of 1–3): hit rate above ALL companies with Newey–West t ≥ **3** (11 lags; raised
  because the idea was found by looking and three versions are tried), positive in both halves; AND
  above plain good + cheap on average. Reported: pool size, the share beating SPY by 50%+, the median
  company against SPY.

**Result (2026-10-10) — only "demand shrinking" clears the declared bar, and it barely changes the
pool; removing the traps does not fix the fragility.** The base reproduced §5.2.10 exactly.

| pool (median companies / month) | hit rate vs ALL | NW t | halves 17–20 / 21–25 | vs plain (t) | beat SPY by 50%+ | median vs SPY | verdict |
|---|---|---|---|---|---|---|---|
| ALL companies | — | — | — | — | 8.8% | −7.8% | |
| plain good + cheap (286) | +4.7pp | 3.45 | +6.7 / +3.1 | — | 8.4% | −3.7% | (§5.2.10) |
| − returns falling (158) | +5.8pp | 2.38 | +6.6 / +5.3 | +1.2pp (0.80) | 8.4% | −2.9% | FAIL (t) |
| − demand shrinking (285) | +5.4pp | 3.37 | +7.5 / +3.7 | +0.7pp (1.64) | 8.3% | −3.2% | PASS |
| − price still falling (172) | +2.3pp | 1.47 | +5.9 / −0.5 | −2.2pp (−1.39) | 8.2% | −5.3% | FAIL |
| − any of the three (91) | +3.4pp | 1.46 | +5.3 / +2.0 | −0.7pp (−0.37) | 8.3% | −5.7% | (reported) |

- **Returns falling** removes almost half the flags and lifts the hit rate (+1.2pp over plain) and the
  weak 2021–25 half (+3.1 → +5.3), but with a smaller pool the t drops below 3. A direction, not a pass.
- **Demand shrinking** passes by the letter, but it removes few flags (198 of 1,690 basket-months, the
  smaller industries) and its gain over plain is +0.7pp at t 1.64 — not distinguishable from plain.
- **Price still falling** HURTS: the cheap industries still falling are the recoveries (banks and the
  like). Consistent with §5.2.5 — buying cheap means buying weak, and the weak ones paid.
- **No pool has more big winners.** Beating SPY by 50%+ stays at ~8.3–8.9% against 8.8% for all, on
  both monthly-averaged and pooled counts. The edge is fewer losers (median company −3 to −4% against
  SPY vs −7.8%), not more winners. (An earlier chat figure of 10.9% for the pool does not reproduce on
  this measure and is withdrawn.)
- **Reported, not declared — §5.2.11's fragility stays.** Without Regional Banks: plain +3.2pp t 1.63
  (−0.6 in 2021–25); − returns falling +4.0pp t 1.20 (+1.0); − demand shrinking +3.2pp t 1.23 (−1.4).
  Regional Banks is never "shrinking" and only 13 of its 48 flagged months are "returns falling", so
  neither filter touches the industry that carries the result.

Code: `screener/step1.py` (`aggregate_returns`, `returns_falling`), `scripts/run_step1_backtest.py`
(dump rows carry `shrinking`, `ret_falling`, `rs`).

#### 5.2.13 Good cheap vs bad cheap — declared 2026-10-10 BEFORE any code for (b) (Roy)

**Where it came from (found by looking, so the bar stays raised):** inside the pool, quality, cheapness
and demand did not separate the industries whose companies beat SPY from those that did not. What did
(description, 945 industry-months): the KIND of business (REITs, commodity materials, airlines, cable
lagged; semis, building products, durables led), how LONG it had been cheap (over 24 months −3.2pp vs
+4.5pp at 3–12), smaller companies, weaker price. The reading: "cheap" assumes margins return to their
10-year average; in the traps that normal broke.

**Base:** good + cheap minus returns falling (§5.2.12 — Roy's working pool, ~160 companies a month).
Same data, months (2017-01..2025-09), measure and survivors-only caveat as §5.2.10. Then REMOVE:

- **(a) Cheap too long:** the industry has been good + cheap (§5.2.10's rule, before the returns
  filter) for more than 24 consecutive months, counting the decision month. Counted from 2017-01, so
  nothing can be removed by (a) before 2019-01 — a known limit.
- **(b) The normal broke:** the industry's aggregate margin — Σ EBIT / Σ revenue; Σ net income / Σ
  average equity (ROE) for baskets the metrics measure on ROE — was below its own average of up to 10
  fiscal years in EACH of the latest 3 fiscal years public by the decision date. Needs at least 6 years;
  otherwise not removed.
- **(c) REITs:** Equity REITs (GICS 6010 — every node whose code starts 6010) are out; their earnings
  do not fit an operating-margin yield. Real-estate management & development (6020) stays.

Run separately and in every combination: a, b, c, a+b, a+c, b+c, a+b+c (seven).

- **Compared with:** ALL companies, and the base.
- **PASS** (each of the seven): hit rate above ALL with Newey–West t ≥ **3** (11 lags), positive in
  both halves (2017–20 / 2021–25), AND above the base on average.
- **Reported:** pool size, share beating SPY by 50%+, median company vs SPY, the gain over the base
  with its own t, and each variant WITHOUT Regional Banks (§5.2.11's fragility — reported, not graded).

**Result (2026-10-10) — a+c and a+b+c PASS by the letter; none improves on the base by a measurable
amount, and the Regional Banks fragility is untouched.** Of the base's 945 industry-months, (a) flags
100, (b) 46, (c) 183.

| variant | pool | vs ALL | NW t | 17–20 / 21–25 | vs base (t) | 50%+ | median vs SPY | verdict | without Regional Banks |
|---|---|---|---|---|---|---|---|---|---|
| base | 158 | +5.8pp | 2.38 | +6.6 / +5.3 | — | 8.4% | −2.9% | | +4.0pp t 1.20 |
| − a | 148 | +6.5pp | 2.48 | +6.3 / +6.6 | +0.6pp (1.47) | 8.1% | −2.3% | fail | +3.7pp t 1.00 |
| − b | 158 | +5.7pp | 2.28 | +6.4 / +5.1 | −0.1pp (−0.66) | 8.3% | −2.8% | fail | +3.6pp t 1.05 |
| − c | 148 | +5.9pp | 2.71 | +6.7 / +5.3 | +0.2pp (0.18) | 8.7% | −2.9% | fail | +4.2pp t 1.38 |
| − a+b | 148 | +6.5pp | 2.44 | +6.2 / +6.7 | +0.6pp (1.24) | 8.0% | −2.3% | fail | +3.2pp t 0.80 |
| − a+c | 134 | +6.5pp | 3.19 | +6.5 / +6.6 | +0.6pp (0.52) | 8.5% | −2.2% | **PASS** | +4.5pp t 1.51 |
| − b+c | 148 | +5.8pp | 2.62 | +6.6 / +5.2 | +0.1pp (0.11) | 8.6% | −2.9% | fail | +3.8pp t 1.18 |
| − a+b+c | 134 | +6.5pp | 3.18 | +6.4 / +6.6 | +0.6pp (0.55) | 8.4% | −2.2% | **PASS** | +3.9pp t 1.19 |

- **Why so little moves:** the description that motivated this counted INDUSTRIES (each industry-month
  once); the measure counts COMPANIES, and about a third of the pool's companies are regional banks.
  The traps are many industries but few companies (c removes 183 industry-months and only ~10
  companies a month), so cutting them barely shifts a company-weighted hit rate.
- **(a) cheap too long** is the one that does something: the 2021–25 half rises (+5.3 → +6.6) and
  the median company improves (−2.9% → −2.3%). Its gain over the base is +0.6pp at t 1.47 — a
  direction, not proven.
- **(b) the normal broke** rarely fires (46) once returns-falling has already filtered, and adds
  nothing.
- **(c) REITs out** is neutral on the hit rate; it steadies the series (t up) more than it lifts it.
- **The pass is a+c's:** above ALL at t 3.19 with both halves positive, by the declared rule. Without
  Regional Banks every variant is t 0.8–1.5 — the result still rests on one industry.

Code: `screener/step1.py` (`aggregate_margin`, `normal_broke`), runner dump carries `normal_broke`.

#### 5.2.14 One vote per industry — declared 2026-10-10 BEFORE the run (Roy)

**Why:** §5.2.10–13 count COMPANIES, so an industry with 204 companies outvotes one with 8, and a
third of the pool's votes are regional banks. Roy's pipeline gives each flagged industry a share
(Argus picks a few names per industry, Atlas spreads the book), so the question step 1 answers is
"does the screen pick good INDUSTRIES?" — one vote per industry.

**Measure:** each month, each industry's hit rate = the share of its companies beating SPY over the next
12 months (an industry needs ≥ 3 companies to count). The pool's score = the plain average of its
industries' hit rates; the benchmark = the plain average of ALL industries' hit rates that month.
Months with fewer than 3 industries in a pool are skipped for that pool. Same data, months
(2017-01..2025-09), dump (data/step1_rows.json) and survivors-only caveat as §5.2.10–13.

**Pools (five):** plain good + cheap (§5.2.10); the base = good + cheap − returns falling (§5.2.12);
base − (a) cheap too long; base − (c) REITs; base − a+c (§5.2.13's definitions).

- **PASS** (each): score above ALL industries with Newey–West t ≥ 3 (11 lags), positive in both halves
  (2017–20 / 2021–25). For the three filtered pools, also above the base on average.
- **Reported:** industries per month, each pool's gain over the base with its t, the median industry's
  median company vs SPY, and every pool WITHOUT Regional Banks.

**Result (2026-10-10) — ALL FIVE FAIL. Counted one vote per industry, the screen picked better
industries in 2017–20 and not in 2021–25.**

| pool | industries / month | vs ALL industries | NW t | 17–20 / 21–25 | vs base (t) | median company vs SPY | without Regional Banks |
|---|---|---|---|---|---|---|---|
| plain good + cheap | 15 | +2.8pp | 1.63 | +6.6 / −0.3 | — | −6.3% | +2.5pp t 1.38 |
| base (− returns falling) | 9 | +1.9pp | 0.68 | +6.6 / −1.9 | — | −5.7% | +1.3pp t 0.44 |
| base − a | 8 | +1.9pp | 0.63 | +6.4 / −1.9 | −0.3pp (−0.61) | −5.1% | +1.5pp t 0.46 |
| base − c | 8 | +3.3pp | 1.34 | +8.3 / −0.8 | +1.9pp (2.11) | −5.0% | +2.6pp t 0.95 |
| base − a+c | 7 | +4.4pp | 2.14 | +7.9 / +0.8 | +1.4pp (1.48) | −3.6% | +3.7pp t 1.49 |

- **What §5.2.10–13's passes were:** a company-weighted pool in which a third of the votes were
  regional banks. As an INDUSTRY picker, good + cheap is +6–8pp in 2017–20 in every version and about
  zero in 2021–25. The 2021–25 half is where the company-weighted reading also leaned on one industry
  (§5.2.11); this says the same thing a second way.
- **Filters help in the direction the description said:** REITs out (+1.9pp over the base, t 2.11)
  and a+c (+1.4pp) lift the score, and a+c is the only pool positive in both halves — but at t 2.14
  overall, below the bar.
- **What the Premium-month rerun can and cannot change:** adding the failed 2023 banks can only lower
  the company-weighted result; it does not touch the industry-weighted failure in 2021–25.

### 5.3 Step 5 — the weekly screen (BUILT 2026-10-08)

**Decided by Roy, 2026-10-08:**
1. **Q11 rule:** 2 = a DATED event inside the four weeks after the run date that directly moves the
   industry's revenue or costs (its leaders report; a scheduled regulatory or rate decision; a dated
   industry data release), with the date and the mechanism named. 1 = an identifiable driver with no
   date in the window. 0 = nothing named. The code holds the claim: a 2 without a date in the window or
   a mechanism is marked down (to 1 with a reason, else 0), and the correction is kept on the row.
   **Known and accepted (Roy, 2026-10-08, after the first live run):** in earnings season the rule
   gives nearly every industry a 2. The first run (window 2026-10-07 to 11-04, mid Q3 season) scored
   60 of 66 at 2, all from earnings reports, and the swing buckets filled (31 swing + long-term, 42
   swing only). Offered: earnings count only 1, or only when results are expected to swing. Roy kept
   the rule as is.
2. **Scope:** the agent looks only where it matters: engine timing 6 or 7 (Q11 decides the bucket) and
   the top two buckets (they need notes). Every other industry's Q11 is "not assessed: could not change
   this bucket".
3. **Cadence: weekly.** Engine: `daily-prices` Saturday 06:00 UTC, `industry-screener` Sunday 08:00 UTC
   (aether render.yaml). Backend: `monitoring/industryScreen.monitor.service.js` checks every 3 hours
   for a complete engine run without a screen, and runs one. Opt-in: `INDUSTRY_SCREEN=true`.

**How it is built:**
- `api/strategy/screenerData.service.js`: reads the engine's collections; the bucket rule
  (`bucketFor`, §4 including Roy's widened watchlist); `needsAgent`; `checkScreen` (the Q11 claim);
  `composeRows` (verdict, horizon, change since the previous screen).
- `services/industryScreenRun.service.js`: the headless run, batches of 10 through Pythia (the
  `strategy` desk), which answers `<industry_screen>` blocks; a failed batch publishes with Q11 = 0
  and is counted.
- `api/strategy/industryScreen.service.js`: the house collection `industry_screen`, one document per
  engine run date (never edited; next week is a new document).
- Pythia gains `get_earnings_calendar` and a "weekly screen" section in its prompt. The VERDICT is
  code; the agent never picks a bucket.
- Routes: `GET /api/strategy/screen` (everyone, the latest screen); `POST /api/strategy/screen/run`
  (admin, `{force}` reruns a date).
- **Leading stocks** (engine): liquid, within 10% of the 52-week high, no more than 15% above their own
  50-day average, ranked by 6-1 return, up to five per industry.
- **Red regime** ("downgrade every swing bucket one level"), read as: the swing half goes. Swing +
  long-term and extended become the long-term watchlist; swing only becomes avoid.

### 5.4 Regimes — the history and the connection (Roy, 2026-10-10)

**Why:** §5.2.14 — good + cheap picked better industries in 2017–20 and not in 2021–25; what led in
2021–25 (energy, metals, capex, defence) was neither "good" nor "cheap". Roy: the rules may hold in one
macro regime and not another — go back in time, read the channels, see which industries led, connect,
explain, and only then define a rule (to be tested walk-forward, §5.4.3).

#### 5.4.1 The history (built 2026-10-10)

`aether-engine scripts/build_regime_history.py` → two LOCAL tables under `data/history/` (never Mongo):
- `channels_monthly.parquet` — 30 FRED series (the deleted channel engine's primaries + CPI, core CPI,
  unemployment, industrial production), each as KNOWN at every month end since 1996 (release lags:
  daily 0, weekly 7, monthly 50; unemployment 40, durable orders 60, consumer credit 70), with its
  12-month change and trailing-2y z.
- `industries_monthly.parquet` — every GICS node, every month 2006-11..2025-09: its liquid companies'
  ($300M cap, $1M median dollar volume) next-12-month returns against SPY and QQQ. Survivors only, today's
  GICS labels; ~930 liquid companies in 2006, ~2,200 in 2024.

#### 5.4.2 The connection — regime axes declared BEFORE looking at outcomes by regime

Each month is placed on four axes from `channels_monthly` (point in time):
- **Inflation:** HIGH when CPI y/y ≥ 3%, else LOW.
- **Fed:** TIGHTENING when fed funds is ≥ 0.25pp above 12 months earlier, EASING when ≥ 0.25pp below,
  else HOLDING.
- **Growth:** EXPANDING when industrial production y/y > 0, else CONTRACTING.
- **Stress:** STRESS when the BAA spread's or the VIX's trailing-2y z ≥ 1 (the deleted engine's stress
  threshold), else CALM.

Measured, one vote per industry (§5.2.14): each sector's / industry's share of companies beating SPY
over the next 12 months minus the average's, averaged over the months in each state, with the number of
separate EPISODES (runs of consecutive months) per state — a state seen in one episode is one example,
however many months it lasts. Our rules are scored the same way on the step-1 dump (2017-01..2025-09):
good (quality ≥ 7), cheap (own-history percentile ≥ 0.70), good + cheap, and 12-1 momentum top / bottom
30%; momentum also on the history table from 2007 (an industry's equal-weight return over months m−13..m−1).

This is DESCRIPTION (Roy's "connect, explain"). No pass bar here; a rule found here is declared in
§5.4.3 and judged walk-forward, never on these numbers.

**What it showed (2026-10-10):**
- **Calendar.** High inflation: 3 episodes (2007-11..08-11, 2011-05..12-02, 2021-05..24-06) — the
  last is 38 of its 61 months. Tightening: 2006–07, 2016-12..19-07, 2022-03..24-06. Easing: 2007–09,
  2019-09..21-02, 2024-09 on. Stress: 19 short episodes.
- **One axis alone says little** (sectors within ±9pp). **Inflation × Fed says more:**
  - HIGH inflation, Fed HOLDING (behind the curve; 20 months): Utilities +16, Staples +13, Energy +13;
    Tech −17, Comm −12, Health −11.
  - HIGH inflation, Fed TIGHTENING (chasing; 28 months, mostly 2022–24): Industrials +9, Financials +8,
    Tech +6; Real Estate −10, Utilities −9, Staples −6.
  - HIGH inflation, Fed EASING (13 months, 2008): Staples +17, Utilities +16; Energy −15, Real Estate −11.
  - LOW inflation, EASING: Tech +7, Energy +7; Utilities −16, Staples −7. LOW, TIGHTENING: Tech +9,
    Health +6; Energy −9, Financials −9.
- **Our rules by state (2017–25 only, one vote per industry, pp vs all):** good + cheap +4.1 in low
  inflation, +0.5 in high; good alone and cheap alone ≈ 0 everywhere; low quality (q ≤ 4) +3.8 easing,
  +3.2 holding, −3.3 tightening; momentum top 30% vs bottom 30% (2007–25): about 0 when calm or
  tightening, −8.4 when easing and −9.1 in stress (it reverses at turns).
- **Limits:** 2017–25 holds ONE high-inflation episode; survivors only; each combination is 1–3 episodes.

#### 5.4.3 Channel sensitivity, walk-forward — declared 2026-10-10 BEFORE any code (Roy)

**Traits (industry level, ≥ 5 liquid companies), point in time at each month end m:** the slope of the
industry's monthly equal-weight return MINUS the average industry's, on the month's change in a channel,
over the 36 months ending m (all 36 needed):
- **inflation beta** — on the change in the 10-year breakeven (T10YIE);
- **oil beta** — on the % change in WTI;
- **rate beta** — on the change in the 10-year Treasury yield.

Monthly industry returns: the equal-weight 1-month return of the companies liquid at the month's start
(the §5.4.1 floor), added to the regime-history builder. First decision 2009-10 (36 months after 2006-11),
last 2025-09.

**The recipe (mechanical — nobody chooses per year):** at each decision month m, take m's state —
inflation × Fed from §5.4.2. Look only at PAST decision months d with d + 12 ≤ m (their outcomes known)
in the same state; if fewer than 12, fall back to the inflation axis alone; if still fewer than 12, no
pick that month. For each of the six trait-sides (top 30% or bottom 30% of each beta) compute its past
average score in that state; pick the best one if positive, else no pick. The pool = the industries on
that side of that beta at m.

**Score (one vote per industry, §5.2.14):** the pool's average share of companies beating SPY over the
next 12 months minus the average over all industries that month.

- **PASS:** Newey–West t ≥ 3 (11 lags) over the months with a pick, positive in both halves
  (2009-10..2017-12 / 2018-01..2025-09), and a pick in at least half the months.
- **Reported:** coverage; which trait-side the recipe picked, by state and year; the score by state; the
  same against QQQ; and a FIXED-sign version written from §5.4.2's logic (high inflation → top inflation
  beta; tightening → top rate beta; easing → bottom rate beta; else no pick) — reported, not graded,
  since that logic was read off the same years.
- Survivors only; today's GICS labels.

**Result (2026-10-10) — FAIL, and backwards.** Walk-forward: a pick in 86 of 192 months (45%, under the
half required), −3.2pp vs all industries, t −1.40, halves −4.8 / −1.8; against QQQ −2.3pp. The
fixed-sign version (reported only) is worse: −5.1pp, t −2.63, both halves negative. ~18 industries per
side.

| state (all months, hindsight, for reference) | infl top | infl bottom | oil top | oil bottom | rate top | rate bottom | months |
|---|---|---|---|---|---|---|---|
| HIGH / HOLD | −8.4 | +4.0 | −8.6 | +5.6 | −5.4 | +2.7 | 20 |
| HIGH / TIGHT | +0.6 | −4.8 | +3.4 | −6.4 | +1.5 | −0.5 | 28 |
| LOW / EASE | +7.1 | −10.9 | +6.3 | −6.4 | +5.4 | −8.0 | 32 |
| LOW / HOLD | −1.7 | −3.4 | −2.5 | −2.8 | −1.6 | −1.3 | 80 |
| LOW / TIGHT | −6.7 | +2.4 | −4.8 | +4.0 | −5.2 | +3.0 | 32 |

- **The sector pattern of §5.4.2 does not survive being measured as a sensitivity.** Under high
  inflation with the Fed holding (2021, 2011), the industries whose returns had moved WITH inflation
  and oil over the prior three years did −8.4 / −8.6pp — the opposite of the energy/staples/utilities
  reading.
- **Likely why:** the three betas are one thing. Breakevens, oil and yields all fell with cyclical
  stocks in 2020 (and 2008, 2015), so a 36-month "inflation beta" mostly measures plain cyclicality,
  and its sign flips with the cycle (+7 when easing, −7 when tightening, low inflation).
- **And the measure punishes extremes:** every side scores below the average unconditionally (−1 to
  −3pp) — the industries at either end of a beta are the volatile ones, and a volatile industry has
  fewer companies beating SPY in a typical year.
- Not tuned after the run. Narrower betas (controlling for the market, longer windows) would be new
  tries on the same years and need their own declaration.

#### 5.4.4 The full chain — channels → regime → rule → industries, walk-forward — declared 2026-10-10 BEFORE the run (Roy)

**A thin first pass:** our rules exist only from 2017 (the step-1 dump), so the chain learns from 2017
and can predict from 2018; high inflation is one episode (2021-05..2024-06). The same code reruns on the
Premium-month history.

**Each decision month m (2017-01..2025-09), mechanically:**
1. **Regime:** inflation × Fed from `channels_monthly` (§5.4.2), point in time.
2. **Rule:** among EIGHT rules — good (quality ≥ 7), cheap (own-history percentile ≥ 0.70), good +
   cheap, good + cheap − returns falling (§5.2.12), low quality (≤ 4), expensive (percentile ≤ 0.30),
   12-1 momentum top 30%, bottom 30% — score each over PAST decision months d with d + 12 ≤ m in the same
   state (fallback: the inflation axis; at least 12 such months, else no pick). Use the best if its past
   average is positive; else no pick. A rule flagging fewer than 3 industries in a month has no score
   that month.
3. **Industries:** those the chosen rule flags at m.
4. **Score:** one vote per industry (§5.2.14; industries with ≥ 3 companies) — the pool's average share
   of companies beating SPY over the next 12 months minus all industries' average.

- **PASS:** Newey–West t ≥ 3 (11 lags) over months with a pick, positive in both halves (2018–21 /
  2022–25-09), a pick in at least half the months from 2018-01, AND above plain good + cheap applied in
  the same months (does choosing by regime beat the one rule we had?).
- **Reported:** which rule the chain chose by state and year, the score by state, against QQQ.

**Result (2026-10-10) — FAIL.** A pick in 59 of 93 months (63%); −0.6pp vs all industries, t −0.18;
halves 2018–21 **+6.7** / 2022–25 **−7.6**; QQQ −1.3pp; −2.2pp against plain good + cheap in the same
months (t −1.37).

| year | rule the chain chose | score |
|---|---|---|
| 2018–21 (low inflation) | good + cheap (learned from 2017–20) | +2.7 / +5.0 / +6.6 / +12.9 |
| 2022 | — no pick (high inflation, no past) | — |
| 2023 | bottom momentum, good + cheap − returns falling, low quality | −2.8 |
| 2024 | good + cheap − returns falling, low quality, expensive, top momentum | −4.9 |
| 2025 (low inflation, easing) | good + cheap − returns falling | −16.1 |

- **Low inflation, 2018–21: the chain works** — it learned good + cheap from 2017–20 and it kept paying.
- **High inflation, 2022–24: it had nothing to learn from** but the first months of the same episode, and
  hopped between rules; no pick at all in 2022.
- **2025 broke the mapping:** back in low inflation, the chain chose what low inflation had taught it,
  and it did −16.1pp. The low inflation of 2024–25 (real 10y ~2%, AI-led) is not that of 2017–20 (real
  10y ~0.3%). A hypothesis, NOT tested: real rates may be the axis that matters, not CPI — read off the
  same years, it would need its own declaration and the longer history.
- **Verdict on the design:** the chain is the right shape and is now code; with one episode per state it
  cannot be judged. It reruns unchanged on the Premium-month history.

#### 5.4.5 The clean view — correlations before naming anything (Roy, 2026-10-10)

Roy: channels, industries, rules — find the correlations first; name regimes and rules only after.
`scripts/run_channel_correlations.py` (2006–25, GICS) and `run_channel_correlations_long.py` (§5.4.6).
Each channel read two ways at the decision month — its 12-month change, and its level against its own
trailing 2 years (z); each outcome over the next 12 months, one vote per industry. Significance counts
each YEAR once (months / 12). **Chance check:** the channel history is shifted circularly against the
outcomes (24+ months; ~30 shifts on 2006–25, 124 on the long history) and the share of |t| ≥ 2 cells is
counted — what luck alone gives.

**2006–25 (GICS, survivors):** sectors × channel level 2.7% of cells vs luck 0.9% (3% of shifts as
high) — likely real; industries 1.2–1.4% vs 0.7–0.8% — borderline; rules (2017+) BELOW luck. The 30
series cluster into ~8–11 forces (Fed policy; long rates; inflation + wages; risk/dollar/credit/copper;
input costs; the economic cycle; mood; four loners).

#### 5.4.6 The long history — Ken French's 49 industries, 1960–2025 (2026-10-10)

`scripts/fetch_long_history.py` → local parquet: the 49 industry portfolios (CRSP, every stock of its
time — NO survivorship; monthly returns since 1926-07, firms, size, Sum BE / Sum ME by year) and the
market; the channels on their longest FRED proxies since 1947 (monthly WTI, GS10, TB3MS, BAA, AHETPI
swapped in; dollar = DTWEXM chained into DTWEXBGS; real 10y = GS10 − CPI y/y; curve = 10y − 3m; credit
= BAA − 10y). Outcome: industry VW return over the next 12 months minus the average industry's.

**Result — channels → industries: REAL. Channels → rules: still nothing.**
- Industries: **5.6%** of cells at |t| ≥ 2 (12-month change) and 4.8% (level) against luck's 1.8%;
  **none of 124 shifts** reached it. About three times chance — though which single cells are the real
  ones cannot be told from the table.
- The channels carrying it are the **economic cycle** (capacity use, unemployment, jobless claims,
  durable orders, industrial production) and **input costs** (PPI). The shape is classic rotation:
  after the economy has run hot, defensives lead the next 12 months (Health, Drugs, Utilities; e.g.
  industrial production → Drugs r +0.39) and cyclicals lag (Autos, Machinery, Toys; PPI level → Autos
  −0.41); after jobless claims have risen, cyclicals lead (claims → Autos +0.45); commodities and food
  rising → Oil leads (+0.41 to +0.52).
- Rules: 0.4–0.8% of cells vs luck 0.4–0.8% — no channel moves a rule's success detectably, even over
  65 years. The rules themselves work ON AVERAGE: cheap vs own history +2.8pp a year over the average
  industry, momentum top 30% +1.3pp / bottom −1.4pp; rank ICs: momentum +0.075, own-history cheapness
  +0.062, BE/ME +0.044.
- **Reading (not yet a rule):** the channels act on WHICH INDUSTRIES lead, not on WHICH RULE works.
  A design that follows: rules as a constant layer, plus a channel-driven industry tilt — to be built as
  a small shrinkage model and judged walk-forward on 1960–2025 before anything is named.

## 6. Build order

1. **Momentum filter test (§5.1)** on data in Mongo. No FMP calls.
2. **Daily price + volume backfill** for the universe and the S&P 500 (FMP; check plan limits first,
   the daily limit was hit on 2026-10-07).
3. **Engine job:** regime + Q6–Q10 + Q12 per sub-industry, stored with as-of dates. **BUILT
   2026-10-08 (§3.1)**; first real run after the backfill; Render crons (daily refresh + this job)
   not added yet.
4. **Pythia read:** Q1–Q5 from existing views, plus GDP comparison and margin direction. **BUILT
   2026-10-08** from the industry metrics (§3, Step 2).
5. **Pythia's agent + tool:** classification, reasons, notes, leading stocks, changes since last run.
   **BUILT 2026-10-08 (§5.3).**
6. **Board:** buckets in plain words on IndustryView. **BUILT 2026-10-08:** the Forecasts tab opens on
   "Trade now" when a screen exists (regime line; industries grouped by verdict; Trade / Wait / No chip,
   horizon, one-line reason); a row opens onto notes, main risk, catalyst, the quality and timing scores
   and the leaders; "Structure" keeps the three answers (frontend 46b1281, bundle in backend 523fdce;
   driven with `scripts/drive-screen-ui.mjs`).
7. **Full backtest (§5.2).**
8. **Source checks:** VIX, ETF flows, 13F (analyst rating depth checked: from about 2018-12). Each stays N/A until found.

## 7. Open

- ~~How often it runs~~ — **weekly**, decided by Roy 2026-10-08 (§5.3).
- ~~Whether the board shows the scores~~ — on the line: the verdict, horizon and a reason (its two
  scores and a dated catalyst); every question's score in the opened row (step 6).
- **To go live (Roy):** push the three repos; sync the aether Render blueprint (two new crons, FRED key);
  set `INDUSTRY_SCREEN=true` on the backend service. Prod's first screen follows the first Sunday
  engine run. The `industry_index` lines in `test` are already seeded.

---

## Appendix — Roy's spec (2026-10-08, verbatim)

# Industry Screener Agent — Swing to Long-Term Classification

## Role
You are an equity research agent. Your job is to scan all industries and classify each one by how suitable it is right now for swing trading, long-term holding, both, or neither. You filter out low-probability industries; you do not predict winners.

## Ground rules
- Use real market and fundamental data only. For every number, state the source and the as-of date.
- If data is missing or you cannot compute something, say "N/A" and why. Never estimate or invent figures.
- Never claim a backtest result unless you actually ran code on real price data. Show the data source, date range, tickers and code.
- Work at the industry level with fine granularity (GICS industries or a similar set of ~50–150 groups), not just the 11 broad sectors. Use an industry ETF where a liquid one exists; otherwise build an equal-weighted index of the industry's liquid stocks.
- Avoid survivorship bias: include industries and stocks that existed at the time being analyzed, not only today's survivors.

## Step 1 — Market regime (report at the top, once)
- Is the S&P 500 above its rising 200-day moving average?
- How far is it from its 52-week high, and is volatility (e.g., VIX) elevated vs. its 1-year average?
- Classify the regime:
  - **Green:** above 200-day MA, near highs, normal volatility → full-size trading.
  - **Yellow:** mixed signals → reduced size.
  - **Red:** well below highs with high volatility → momentum strategies are prone to crashes; swing trading at minimum size or not at all.

## Step 2 — Quality questions (long-term lens)
Score each 0 (fail), 1 (neutral), 2 (pass), with a one-line reason.
1. **Return on capital:** Is median ROIC high and stable across a full cycle (roughly above 12–15%)?
2. **Margins:** Are margins healthy and stable or expanding over the last 3–5 years?
3. **Growth:** Is industry revenue growing faster than GDP?
4. **Moat / competition:** High barriers to entry, consolidated competition, pricing power?
5. **Cyclicality:** Is the industry cyclical, and where is it in its cycle (early, mid, late, bust)? Late-cycle peak margins should lower the score.

## Step 3 — Timing questions (swing lens)
Score each 0 / 1 / 2, with a one-line reason.
6. **Relative strength:** Rank the industry vs. all industries on 6- and 12-month returns, skipping the most recent month. Top 20% = 2, middle = 1, bottom 20% = 0. Also report 1- and 3-month relative performance vs. the S&P 500 for context only.
7. **Trend:** Price above a rising 50-day and 200-day moving average?
8. **Breadth:** Share of the industry's stocks above their 50-day MA. Broad participation (>60%) = 2; carried by one or two names = 0.
9. **Extension:** Distance above the 50-day MA. Near the MA or a fresh breakout = 2; moderately extended = 1; far above (e.g., >15–20% or >3 ATRs) = 0.
10. **Volatility and liquidity:** Average daily range around 2–4%+ and several stocks trading 1M+ shares/day?
11. **Catalyst:** Any identifiable near-term driver (earnings season, rates, regulation, commodity prices, a theme)?

## Step 4 — Crowding and flow checks
Flag each as Early / Neutral / Crowded, with a one-line reason.
12. **Volume:** Is volume rising moderately on up days (early), or extremely heavy after a long run (crowded)? Research shows high-volume winners tend to reverse faster.
13. **Sentiment:** Is sentiment toward this industry extreme in either direction (media hype, retail enthusiasm, put/call, analyst consensus)? Sentiment is a contrarian signal, strongest in speculative, hard-to-value groups.
14. **Institutional flows:** Is institutional buying new (last 1–2 quarters) or long-running and crowded? Use ETF fund flows as a timely proxy; note that 13F data lags ~45 days. Institutional herding tends to predict positive short-term but negative long-term returns.

## Step 5 — Classification
Compute a Quality score (Q1–5, max 10) and a Timing score (Q6–11, max 12), then assign one bucket:
- **Swing + Long-term:** Quality ≥ 7 and Timing ≥ 8, not extended, not crowded.
- **Extended — wait for pullback:** Quality and Timing strong, but Q9 = 0 or crowding flags are "Crowded".
- **Swing only (for now):** Timing ≥ 8 but Quality < 7 (e.g., cyclicals, commodities, speculative themes). Trade the move, don't hold long-term.
- **Long-term watchlist:** Quality ≥ 7 but Timing < 6. Good business, wrong moment; wait for relative strength and trend to turn up. *(Changed by Roy on 2026-10-08 to Timing < 8 — see §4.)*
- **Avoid:** Weak on both.

In a Red market regime, downgrade every Swing bucket by one level and say so.

## Output format
1. Market regime summary (2–3 lines, with data and dates).
2. A table sorted by bucket, then by Timing score:
   | Industry | Bucket | Quality | Timing | Volume | Sentiment | Inst. flows | Key reason |
3. For each industry in the top two buckets: 3–5 lines covering the main strengths, the main risk, and 3–5 leading liquid stocks in it (strong relative strength, near highs, not extended).
4. A short "changes since last run" section if prior results exist.
5. A data-gaps section listing anything marked N/A.

## Testing the system (only when asked to backtest)
- Test the full combined filter, not individual filters in isolation.
- Use 10+ years of data including at least one bear market; report results separately for bull and bear periods.
- Compare against buying and holding the S&P 500 and an equal-weight industry benchmark.
- Use only data available at each decision date (no look-ahead), include transaction costs, and report: number of trades, win rate, average win/loss, max drawdown, and CAGR.
- Do not tune thresholds to maximize past results; if you test alternatives, report all of them.
