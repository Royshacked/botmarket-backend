# Industry seasonality — does an industry have its own calendar?

> Roy, 2026-11-22: "go through industries and check — first — is there seasonality to industries."
> Declared below BEFORE the run; the pass rule is not tuned to results. Lifts the 2026-10-25 "don't run
> seasonal" (which was about a single name's month, screener-lab.md §118) for industries only.

## 1. Question

Does an industry do better (or worse) than OTHER industries in particular calendar months, in a way that
repeats out of sample? Market-wide seasonality (January, "sell in May") is not the question: every return
is measured against the same month's cross-section, so a month that lifts everything lifts nothing here.

## 2. Data

- **A — primary:** Ken French 49 industries, value-weighted monthly, 1926-07 → 2026-08
  (`aether-engine/data/history/french49_vw.parquet`). No survivorship. Not GICS.
- **B — check:** the 73 GICS industries, equal-weighted monthly, 2007-01 → 2025-10
  (`industry_returns_monthly.parquet`). Survivors only, 19 years — low power; a sign check, not a verdict.
- **Excess return** = the industry's month return − the equal-weighted mean of all industries that month.

## 3. Test 1 — walk-forward (the verdict)

Each month t: signal = the industry's mean excess return in the SAME calendar month over the previous
20 years (A; at least 10 readings) or 10 years (B). Long the top 5 industries, short the bottom 5, equal
weight, held month t. Control: the same portfolio ranked on the mean excess of the OTHER 11 months over the
same window (an industry that is simply strong, not seasonal).

Reported: spread mean per month, t-stat, hit rate; halves 1946–1985 / 1986–2026; 2000–2026; after costs
(full monthly turnover, 10bp per side per leg ⇒ 0.4% a month off the spread).

**PASS (A) when ALL hold:**
1. full-period spread > 0 with t ≥ 2;
2. positive in both halves;
3. positive 2000–2026;
4. seasonal spread − control spread > 0 (it is the calendar, not persistence);
5. positive after costs (full period).

B is reported beside it: same sign 2017–2025 or not.

## 4. Test 2 — the named cells (descriptive)

- Discovery 1926–1975: every industry × month cell's mean excess and t. The 20 cells with the largest |t|.
- Check 1976–2026: the share of those 20 with the same sign (chance 50%), and their mean excess.
- Per industry, an F-test that its 12 month means are equal; count p < 0.05 against the 2.45 of 49
  expected by chance (full period).

## 5. Result

Run 2026-11-22. `aether-engine/scripts/run_industry_seasonality.py` → `data/history/industry_seasonality.json`.

**Test 1 (A, French 49, 1946-07 → 2026-08, 962 months), long top 5 − short bottom 5, % per month:**

| Window | Seasonal | Control (other months) | Seasonal − control | Seasonal after 0.4% cost |
|---|---|---|---|---|
| Full | +0.46 (t 3.7, hit 55%) | −0.31 (t −2.5) | +0.76 (t 4.4) | +0.06 (t 0.45) |
| 1946–1985 | +0.48 (t 3.5) | −0.29 | +0.76 (t 3.8) | +0.08 (t 0.55) |
| 1986–2026 | +0.43 (t 2.2) | −0.33 | +0.76 (t 2.7) | +0.03 (t 0.17) |
| 2000–2026 | **+0.02 (t 0.09, hit 49%)** | −0.52 (t −2.1) | +0.55 (t 1.45) | −0.38 (t −1.5) |

**B (GICS 73, 2017-01 → 2025-10, 106 months):** −0.12 (t −0.28): the opposite sign.

**The verdict by the declared rule: PASS. All five checks hold, but only just.** Checks 3 and 5 asked only
for "positive", with no t-stat floor. Since 2000 the spread is +0.02% a month (zero), after costs it is +0.06%
(t 0.45), and on GICS since 2017 it is negative. In substance the effect is real over a century and gone
for 25 years. The rule is NOT re-tuned after the fact; the gap is that it should have asked for a t-stat on 3
and 5, and that is recorded here rather than fixed in the table.

Seasonal − control is large because the control is NEGATIVE (−0.3%, −0.5% since 2000): industries that did
well over the other 11 months do worse next month, a medium-term reversal across industries. That is a
separate finding and not tested here.

**Test 2 (named cells, discovery 1926–1975 → check 1976–2026):**
- Of the top 20 cells, 65% keep their sign (chance 50%). Their check-half mean in the discovery
  direction is +0.28% (t 1.49): weak.
- **Two cells hold strongly in both halves: Retail in December (−1.5% then −1.7% vs other industries, t −3.6)
  and Toys in December (−3.6% then −2.6%, t −3.7).** Real Estate in January stays positive (+3.3% then
  +1.0%, t 2.2); Chemicals in January stays negative (−2.0% then −0.8%, t −2.0). Of the rest, most fade to
  about zero (MedEq Oct, Soda May, Oil Jan, Autos Jul, Fin Sep); Software in August flips sign.
- F-test on month means: 18 of 49 industries at p < 0.05 over the full period (2.45 by chance). But
  measured per half, 11 in the first and 11 in the second share only 3 (Chemicals, Retail, Toys), about
  what chance overlap would give (~2.5). **Which industries look seasonal does not repeat; Retail, Toys and
  Chemicals are the exception.**

**Reading:** calendar seasonality across industries existed for most of the century and is not usable
now as a ranking. The one durable pattern is the holiday-retail one: Retail and Toys lag the other
industries in December (why is not tested; one guess is that the sales season is priced in before it arrives). It is a description, not
yet a tested trade on GICS names.
