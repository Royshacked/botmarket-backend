# Horizons — what we can know, from one month to twenty years (2026-10-05)

**PROPOSED, designed whole and built in order.** Decided with Roy on 2026-10-05: design every horizon
now, build long-term first. Its companion is `pythia-industry-questions.md`, which covers the
industry-structure layer.

The one rule: **at every horizon we show and trade only what has published evidence AND passes our
own backtest. Where neither holds, the answer is "no reliable signal", never an opinion.**

---

## 1. What the evidence says, by horizon

From a sourced check on 2026-10-05. Abstract-level quotes only; the full texts were not read.

| Horizon | Evidence-backed | Level | Strength | Key sources |
|---|---|---|---|---|
| **1 month** | Industries continue (1-month industry momentum); single stocks reverse (short-term reversal) | Industry / stock | Small; no recent evidence found | Moskowitz & Grinblatt 1999; Jegadeesh 1990 |
| **3 months** | Analyst estimate revisions: names revised up beat names revised down | Stock | About 1.2 points a quarter, decile spread (recent figure) | Chan, Jegadeesh & Lakonishok 1996; Mill Street Research |
| **6–12 months** | Price momentum, 12 months excluding the last month, for stocks and industries | Both | Industry ~0.4–0.5%/month 1963–95; weaker after 2000; crashes after market falls | Jegadeesh & Titman 1993; M&G 1999; Daniel & Moskowitz 2016 |
| **1 year+** | Quality and profitability: profitable firms earn more | Stock | About as strong as value | Novy-Marx 2013; Asness, Frazzini & Pedersen (QMJ) |
| **3–5 years** | Long-term reversal: past losers beat past winners. Valuation mean-reverts. | Stock / market | Losers beat winners by 24.6% over 36 months (1985); out of sample weak (Goyal & Welch) | De Bondt & Thaler 1985; Goyal & Welch |
| **10 years** | Starting valuation (CAPE) predicts the market's return | Market only | Strong negative relation | Campbell & Shiller |
| **20 years** | No sourced industry or stock return predictor. **Growth is not a return signal**: fast-growing economies and expensive growth stocks under-return. | — | GDP growth vs returns −0.39 (developed markets) | Ritter 2005; Siegel |

**Excluded:** post-earnings-announcement drift. It has been "non-existent since 2006" for large stocks
(Martineau, 2022).

**Decay applies to everything.** Published predictors earn 26% less out of sample and 58% less after
publication (McLean & Pontiff, 97 predictors). Hou, Xue & Zhang find 65% of 452 anomalies fail. So a
published signal is a candidate, and only our own out-of-sample test makes it usable.

### What this changes in the Pythia design

The three structural questions are a **description of an industry, not a return forecast**. No
sourced evidence says owning structurally growing industries pays; Ritter and Siegel say the
opposite when the price is high. So:

- Question 1 (demand) and question 2 (economics) are reported, and question 2 doubles as an
  industry-level quality measure, which has evidence at stock level.
- The only return-relevant use of the answers is **paired with price**: a good industry at a
  normalised valuation (question 3) below its own history.
- Whether that pairing predicts 3–5 year industry returns is **untested**, and the backtest in §3
  must test it before the UI calls it anything stronger than a description.

## 2. The layers

All industry measurements use **our own baskets** of sub-industry companies (classification from
`pythia-industry-questions.md` §4): cap-weighted and equal-weighted. ETFs are only how a bet is
traded, not how an industry is measured. This also ends the "no fund" problem for measurement.

### A. Industry structure: Pythia (long horizons)
As in `pythia-industry-questions.md`. Its outputs are descriptions plus the normalised margin. Those
outputs feed the long-horizon value signal in layer B.

### B. Signal lab (every horizon)
One service that computes candidate signals, backtests them and grades them live. The backtests run
in aether-engine; the backend reads the grades.

| Signal | Level | Horizon | Data | Data status |
|---|---|---|---|---|
| Industry momentum (1m; 6m and 12m excluding the last month) | sub-industry basket | 1m, 6–12m | daily prices | 20y from FMP |
| Stock momentum, 12 months excluding the last month | stock | 6–12m | daily prices | 20y |
| Short-term reversal (1m) | stock | 1m | daily prices | 20y |
| Estimate revisions (EPS, 3-month change), and the up/down breadth per industry | stock, industry | 3–6m | consensus estimates | **No history on our plan. Snapshot daily from now; testable in ~12–18 months.** |
| Quality (gross profitability, ROIC, accruals) | stock, industry | 1y+ | statements | 15y with filing dates |
| Normalised valuation (cycle-adjusted earnings yield vs own history) | stock, industry | 3–5y | statements + prices | 15y |
| Long-term reversal (3–5y loser minus winner) | stock, industry | 3–5y | prices | 20y |

**Every signal has a lifecycle:**
1. **Candidate:** published evidence exists.
2. **Backtested:** point-in-time, on a universe including delisted names, after costs. The measure is
   rank IC at its horizon plus a decile spread.
3. **Live:** passes the bar (a fixed IC and t threshold, set once before testing).
4. **Graded:** its live record is recomputed monthly; a live signal falls back to candidate when the
   record fails.

Only live signals reach a desk or the UI.

**Data limits that are known:**
- Our price history starts in 2006, so the backtest covers about 20 years and two crashes.
- For longer tests, Ken French's 49 industry portfolios (free returns since 1926) cross-check the
  industry-momentum and reversal results.
- Our sub-industries don't match French's industries one to one, so the cross-check is approximate.

### C. Name selection, by horizon
Same funnel shape everywhere. What changes is the code-computed ranking that feeds research.

| Book horizon | Ranking inputs (live signals only) | Research | Entry |
|---|---|---|---|
| 10–20 years | Quality, normalised valuation, industry structure (description only) | Prometheus long case: durability, reinvestment runway, kill conditions | Atlas, staged |
| 3–5 years | Quality, normalised valuation, long-term reversal | Prometheus 5-year case | Atlas |
| 1 year | Quality, momentum, revisions (once testable), Prometheus 12-month target | Prometheus coverage | Atlas |
| ≤ 6 months | Momentum, revisions, industry momentum | Light: catalyst and risk check | Mentor timing |

The LLM only ever rejects names, with a reason. It never adds them. Users' own ideas enter at the top
and pass the same gates.

### D. Atlas: horizon decides the inputs
- The mandate already records the horizon. It selects the row of the table above.
- It also sets the review cadence: long books yearly plus triggers; 1-year books quarterly;
  ≤ 6-month books monthly.
- A book never mixes horizons silently. A long book's position is not sold on a 1-month signal.

## 3. Proving it

**One backtest harness** (aether-engine) runs every signal and the Pythia pairing, all on the same
footing:
- monthly rebalance dates since 2006;
- point-in-time fundamentals by `acceptedDate`;
- delisted names included;
- costs deducted;
- results per horizon.

**The bar is fixed before running.** Results are written to Mongo with their run inputs. This is the
same discipline as the 2026-10-01 base-rate test that retired the channel calls.

## 4. The Forecasts view (UI)

Rows are sub-industries, with their level shown when rolled up. Columns are horizons. Each cell holds
only what layer B or Pythia can back:

| Column | Shows | Source |
|---|---|---|
| 1M | Industry 1-month momentum rank | Live signal, else "—" |
| 3M | Revision breadth | "Collecting data until 2027" until testable |
| 6–12M | Industry momentum rank | Live signal |
| 1Y | Quality rank, plus momentum | Live signals |
| 3–5Y | Normalised valuation vs own history | Live signal, if it passes |
| 10–20Y | The three structural answers | Description, labelled "not a return forecast" |

**Every cell shows three things:** the reading, its evidence grade (live and passing / candidate /
no signal), and our own track record once graded. Cells with nothing behind them say so.

**The headline per sub-industry is a range** (Roy, 2026-10-05): "good for trading from X months to Y
years".
- **Built only from live signals that agree.** The range is the run of consecutive horizons where the
  sub-industry ranks in the top tier against all others. An "unfavoured" range is the run in the
  bottom tier.
- **The tier cutoff is open** (§6): top/bottom 30% or 20%.
- **The wording is "favoured" / "unfavoured"**, meaning expected to beat or lag other industries.
  It never says "will rise".
- **Non-adjacent readings get no range.** They read "mixed: favoured 1M, unfavoured 6–12M".
- **The 10–20Y end never says "favoured"** until the quality-at-a-fair-price pairing passes the
  backtest. Until then it shows the three structural descriptions.

Example:
> **Semiconductors**: favoured 1M → 1Y · unfavoured 3–5Y
> Long term: demand growing · economics good · margins at a 10-year high
> Why: industry momentum decile 9 · quality decile 9 · valuation vs own history decile 2

**Open UI choices are listed in §6.**

## 5. Build order

1. **Pythia structure layer.** Its build order is in `pythia-industry-questions.md` §10: GICS
   classification, statement job, aggregates, desk. Retire the old desk.
2. **Start the estimate snapshots NOW.** It is a daily job and costs little; every month of delay is a
   month the revision signal cannot be tested.
3. **Backtest harness and price history.** Sub-industry baskets, industry momentum, stock momentum,
   reversal, quality, valuation.
4. **The 5-year and 20-year funnel:** Argus code ranking, Prometheus long case, Atlas caps and review.
   Resume the house scan on it.
5. **Forecasts view**, initially with the structure column plus whatever signals are already live.
6. **1-year and ≤ 6-month funnels**, as their signals go live; revisions arrive last, once enough
   snapshots exist.

## 6. Open decisions

1. **Range tier cutoff.** Top/bottom 30% or 20% (§4).
2. **Detail under the range headline.** A grid of every sub-industry × horizon, or a card per
   sub-industry, and how a cell shows its reading (decile and arrow, or words).
3. **Cells with no live signal.** Hidden, or shown as "no reliable signal".
4. **Backtest bar.** The IC and t threshold, set before the first run.
5. **Events. PARKED by Roy on 2026-10-05 to think it over.** The proposal on the table: convert
   Aether's output from names to sub-industries, keeping the names as evidence underneath. Two kinds
   of graded claim:
   - **Price claims** over 1–3 months;
   - **Fundamentals claims** on question 3's margins over the next 2 quarters.

   Events would only TRIGGER reviews of questions 1 and 2, never predict them. Historical analogs
   would give each claim a base rate.

   Today's record: 163 name claims across 20 events, 8 graded (4 hit, 4 miss).
