# The screener lab — candidate rules tested one by one

**Status: BUILT 2026-10-24/25; rounds one (11 ideas, two universes, one year) and two (the two leads, their variants,
the market regime and each stock's swing — three years, the last one HELD OUT) run. One rule survives, modestly: the
run-up into a report (§6). Nothing here changes the live Hotlist.** Code: `services/screenerLab.service.js`
(hypotheses, scoring), `services/screenerLab.data.js` (data, cache), `scripts/lab.mjs`.

## 1. Why

Roy, 2026-10-24: "think of more criteria and we test one by one — the Argus replay only after we have a screener with
an edge". The Hotlist's own rules, replayed (daily-names.md §7.5), did not beat the market once each session counted
once: This week's screener names +0.24% a week against SPY's +0.23% and the pool's +0.30% (235 sessions); the day
columns lost to their pools over 30 sessions (open −0.74%, tomorrow −1.98%). The run-up path's lower volatility is real
(sd 5.2 against the pool's 7.4), its return edge is not.

## 2. One yardstick

A hypothesis is a SIGNAL on a name's daily bars and reports: on session i, from what was known by the close of i−1, buy
at i's OPEN; hold `hold` sessions, or to its own exit. Every trade is measured:

- **against SPY** over the same sessions (open to close) — the market is not an edge;
- **net of a cost** by the name's 20-day dollar volume (`COST_BY_ADV`: 0.05% ≥ $100M, 0.10% ≥ $20M, 0.25% ≥ $5M, 0.50%);
- **each session once** (the names of a day move together — counted per name, crowded sessions decide the average);
- with a **block range** for a multi-day hold: neighbouring sessions' windows overlap, so the per-session range is too
  narrow; the sessions are cut into non-overlapping blocks of the hold and the range taken across blocks (`blockRange`);
- in **two halves** — an edge in one half only is a regime, not an edge;
- against the **baseline**: every testable name (price ≥ $5, ≥ $5M a day), every session, held 5.

The data is read once per universe and cached in `data/lab/` (gitignored): bars, sectors, SPY, the one-year calendar
(the plan's limit — older `from` is a 402), and on request the per-company earnings HISTORY (back to 2019) and insider
PURCHASES (Form 4 code P, the whole history in one read). `--years=N` reads bars further back (the calendar stays a
year; the run-up ideas read the history and span it all).

## 3. Round one — the screener's universe (1,177 names, 2025-11-13 → 2026-10-23)

Net vs SPY per session, with the 95% range:

| # | Idea | Trades | Net / session | Range | 1st ½ | 2nd ½ |
|---|---|---|---|---|---|---|
| — | Baseline | 263,744 | +0.01% | −0.16 … +0.18 | +0.14 | −0.13 |
| 1 | Beat, bought day two | 1,848 | +0.26% | −0.45 … +0.97 | +0.70 | −0.24 |
| 2 | Beat, up 3%+ and held | 418 | −0.35% | −1.57 … +0.87 | −0.33 | −0.38 |
| 3 | Down 8–25% in a week, over the 200-day | 7,074 | +0.21% | −0.38 … +0.80 | +0.76 | −0.35 |
| 4 | RSI(2) < 5 over the 200-day | 6,665 | −0.07% | −0.35 … +0.21 | 0.00 | −0.14 |
| 5 | Gap down 4%+ that held | 1,510 | +0.82% | −0.37 … +2.01 (blocks −1.06 … +1.93) | +0.99 | +0.66 |
| 6 | **Run-up into a report, in 7 sessions before** | 3,687 | **+0.94%** | **+0.22 … +1.66 (blocks +0.03 … +1.98)** | +0.58 | +1.33 |
| 7 | First 52-week high, held 20 | 711 | +1.46% | −1.05 … +3.97 | +4.19 | −1.97 |
| 8 | Bottom tenth of a rising sector | 11,345 | +0.10% | −0.33 … +0.52 | +0.77 | −0.58 |
| 10 | 2+ insiders buying, held 20 | 203 | +0.28% | −1.57 … +2.14 | −0.70 | +1.39 |
| 11 | Small miss, down 10%+ | 54 | +0.11% | — | — | — |

**#6, the run-up, stress-tested:** in 5 sessions before +0.73% (blocks −0.05 … +1.60, both halves positive), 10 before
+0.95% (blocks −0.25 … +2.24), 3 before +0.17% (nothing). HELD THROUGH the report: the same mean, twice the spread
(sd 13.6 against 7.5) and the range crosses zero — getting out before the report is part of the rule. By streak, 2 or 3
of the last 3 reports beat (+0.8 to +1.3%) over 0–1 of 3 (+0.3 to +0.7%) — suggestive, not separated. By trend and
RS (over / under the 200-day, RS + / −): no split separates — the live week gate's "base + RS" is not what carries it.

## 4. Round one — small caps (#9: 790 names, $300M–$2B)

Nothing works. The baseline itself lost to SPY (−0.22% a session; −0.49% in the second half), and the run-up does not
carry over (+0.08%, −0.92 … +1.07). Every idea's range crosses zero; the sector laggard is negative (−0.57%, −1.11 …
−0.03). Small caps are not the direction on this evidence.

## 5. Caveats, on every number

- One year (the calendar's reach): ~47 independent weeks. The three-year run for #6 is cached, not run.
- Today's universe — survivorship. It flatters the dip ideas (3, 4, 5, 8, 11) most: the names that kept falling left.
- The report DATE is taken as known in advance (companies announce it weeks ahead; the history has the actual date).
- Before/after the bell is unknown: "day two" is day two or three.
- Cost is an estimate by dollar volume, not a measured spread.

## 6. Round two — three years, the last held out (1,177 names, 2023-10-09 → 2026-10-23, 764 sessions)

Roy, 2026-10-25: "go for the two leaders only", then "each stock swing and market regime". Variants were declared
before the run; a variant is CHOSEN on the two years before 2025-11-08 and must hold on the year after, which it never
saw. (The baseline is skipped over three years for the machine's memory — one year's is +0.01%.)

**The run-up into a report** (#6) — net vs SPY per session; the block range in brackets for the whole span:

| Entry | 3 years | Blocks | Before (chosen on) | Held out |
|---|---|---|---|---|
| 3 sessions before | +0.09% | −0.17 … +0.41 | +0.08% | +0.13% |
| 5 sessions before | +0.40% | **+0.06 … +0.84** | +0.26% | +0.71% (+0.09 … +1.34) |
| 7 sessions before | +0.37% | **+0.05 … +1.03** | +0.16% | +0.85% (+0.13 … +1.57) |
| 10 sessions before | +0.40% | −0.05 … +1.03 | +0.20% | +0.88% (0 … +1.76) |
| 7, held THROUGH it | +0.45% | −0.24 … +1.27 | +0.24% | +0.93% — sd 12.4 against 6.7 |

- Over three years it clears zero on the honest range (5 and 7 sessions out), but MOST of it is the last year: the two
  years before give +0.16 to +0.26%, whose ranges cross zero. The effect is real but smaller than the first year said.
- **Chosen on the two years before: in 5 sessions before, last three reports all beat** — the only variant whose range
  cleared zero there (+0.44%, +0.10 … +0.78). On the held-out year: **+0.41%** (−0.14 … +0.96). The same size on data it
  never saw; the range just crosses zero.
- **The market regime** (7 sessions out): SPY over its 200-day and calm +0.50% (before +0.47%, held out +0.56% — the
  steadiest split); over and stormy +0.36% (−0.06% / +1.18%); **under the 200-day it loses** (−0.14% to −0.23%, ~60
  sessions). A filter "only while SPY is over its 200-day" is consistent with every split.
- Held through the report: no better, twice the spread — out before it stays the rule.
- By trend and RS of the name: no split separates in both periods (under-200d · RS+ flips from −1.06% to +0.75%).

**Gap down that held** (#5) — fails. Three years +0.43% (blocks −0.47 … +1.22); its best split chosen before (the name
under its 200-day, +1.40%, +0.07 … +2.72) loses on the held-out year (−0.48%). Gap size, close position, volume: none
separates. By regime: SPY under its 200-day and stormy +2.92% — 40 sessions, a range from −0.63 to +6.46. Dropped.

**Each stock's own swing** (`swing_low`, a close 2 sd under the 20-day average, out back at it) — fails. −0.22% over
three years (blocks −0.54 … +0.30); the SWINGERS — the bet — do worst (−0.29%; −0.49% before, +0.15% held out),
trenders +0.05%. A stock's past rhythm does not predict its next bounce here. Dropped.

## 7. Where it stands, and next

The only screener rule with an edge after costs, against SPY, on three years and a held-out year: **buy a name 5 sessions
before its report when its last three reports beat, out at the close before the report — while SPY is over its
200-day.** Its size is modest: about +0.4% a week over SPY per session, ~+0.5% in a calm rising market. Per TRADE it is
smaller (+0.1%): the crowded sessions of earnings season do worse than the sparse ones, so it pays as a fixed daily
budget split across the day's names, not as a bet per name.

1. Decide with Roy whether this becomes the live This week rule (it replaces the base + RS gate, which carried nothing).
2. Then, as Roy set the order, the Argus replay on it — sessions after the model's cutoff — to see whether his reading
   of the names (the setup, the news) sharpens a rule that already has an edge.
3. Not tested yet: calendar cycles (turn of the month, a name's own seasonality — built as `season_month`, its 10-year
   month read NOT run: Roy, 2026-10-25, "don't run seasonal"), estimate revisions, short interest.

## 8. The slower cycles and the movers (2026-10-25)

**Slower cycles** (three years, net vs SPY per session) — both fail:
- `range_low` — sideways (the 50-day within 5% of 60 sessions back) in a 15%+ 60-session range, at its bottom tenth,
  out at the middle: −0.02% (blocks −0.86 … +1.39). The names with the most past swings do WORST (4+ swings −2.13%).
- `pullback_50` — an uptrend's first close back at the 50-day after an 8%+ run over it, held 20: −0.22%; +0.50% in a
  calm market over the 200-day, −0.99% in a stormy one.

**The movers** (`winnersStudy`, the last 52 weeks; every name 5%+ over SPY in a week — 9,500 — against every name 5%+
under — 9,776 — of 58,759 name-weeks): what comes before a big week — 8%+ volatility, a report in the week, technology,
a $5–10 price, 20%+ under the year's high — comes before the big LOSERS just as often. Each trait's share of its big
movers that went UP sits at 46–52% against a 49% base, both halves alike: the evening's picture finds the movers, not
their direction. The steadiest leans are 2–4 points (up 5%+ last week 52%; down 5%+ last week 45% — no bounce;
reporting that week 46%; no 200-day history 45%). The 24-week cut's leads (healthcare, cheap names) did not hold over
the year. Three in four winners had no report that week: the moves are news.

## 9. Argus on the movers (2026-10-25) — no judgment

`argusReplay.service.js`. Each week, from Monday's likely movers (20-day volatility 8%+ or a report in the week), 10
that went on to beat SPY by 5%+, 10 that lagged it by as much, 10 between — shuffled, the outcome hidden — as a live
week-column board (the same overnight stats and free range, up to three headlines each through Monday's open), read by
`argusRead` itself on the house model (gpt-6-luna; asked, it gives a June 2024 cutoff and knows nothing of the 2026
moves). 48 weeks (2025-11-10 → 2026-10-19; FMP's news answers 402 past a year; one news timeout, one model drop):

| His call | Names | Up hard vs down hard | Net / name | Per week (95%) |
|---|---|---|---|---|
| Picks | 124 | 45 vs 39 (54% up) | +0.46% | +0.50% (−1.22 … +2.21) |
| Avoid | 408 | 149 vs 145 (51%) | +0.48% | +0.51% (−0.74 … +1.76) |
| Neither | 907 | 286 vs 295 (49%) | +0.34% | +0.34% |
| All | 1,439 | 480 vs 479 | +0.39% | |

**With the technicals** (Roy, 2026-10-25: "Argus should check headlines and technicals" — `--tech`, each row's
techLine: trend against the 20/50/200-day, 5/20-session return and RS, volume against the 50-day, distance from the
52-week high and low), the same seeded samples, the 48 weeks both runs read: picks 95 names, 37 up hard vs 33 down
(53%), +0.58% a name; avoids 407, 147 vs 139 (51%), +0.57%; the rest +0.29%. He changed 28% of his calls and none of
the result; without his three best picks his picks average −0.29%. In both runs his picks' MEDIAN (+1.7%) is over the
avoids' (−0.4%) with the same mean — a fatter left tail, ~1.4 standard errors, not a finding.

His picks are no better than his avoids: on headlines and the board's numbers he does not tell the week's winners from
its losers. ~5k tokens a week. Caveats: headlines only (titles, three a name — what the live board gives him), one
model, a week held through any report in it (the live run-up path exits before), today's universe.

## 10. Up movers against down movers (2026-10-25)

`moverDiff.service.js`, `scripts/lab-movers.mjs`. Roy: "let's see what differs the up movers from the down movers".
Every name-week 5%+ over SPY (bought at Monday's open) against every one 5%+ under — 42,519 over 2023-12 → 2026-10 —
on 27 facts known at Monday's open; quintiles cut on the two years before, the year after held out. The share that went
UP is the measure (the movers are chosen by their outcome, so their returns are not a trade).

- **Holds in both periods:** the GAP AT MONDAY'S OPEN — the top fifth (≥ +1.05%) went up 43% / 46%, the bottom fifth
  (≤ −0.89%) 49% / 52% (spread −5.5 / −6.6 points): a gap up into the week fades, a gap down recovers. The beat streak
  (3 of 3 against 0: +1.5 / +3.9) — the run-up's own finding. The 20-session return, weakly (−2.2 / −4.0).
- **Flips:** the week's strength (ret5, rs5, against its sector) was REVERSAL before (the strongest fifth 44% up) and
  MOMENTUM in the held-out year (53%); volatility likewise. A regime, not a trait.
- **Nothing:** the trend (20/50/200-day), range position, the 52-week high, Friday's close, volume, the last report's
  surprise and reaction, days since it.
- **All 27 together** (a logistic regression fitted before, scored held out): AUC 0.51. Its most bullish tenth went up
  53% against 49% in its least — its biggest weight is SPY's own week, which ranks weeks, not names.

**Every session, not only Monday** (`--daily`, Roy: "do this test every day and try to predict the next week") — an
entry at each session's open, held five: 208,082 movers over 716 sessions. Weaker still. The open's gap shrinks to
−4.5 / −1.7 points (the Monday effect does not carry to every day); what holds is the 20-session return (−2.1 / −3.2:
last month's winners a little more often down — a month's reversal) and the beat streak (+1.9 / +3.5). All 27 together:
AUC 0.509; held out, the model's most bullish tenth went up 49.6% (per session 49.7%), its least 46.2% (45.1%).

## 11. The week after a big week (2026-10-25)

`followThrough` (moverDiff.service), `scripts/lab-follow.mjs`. Roy: "the names that went up 5% — what happens to them in
the following week". The last 52 weeks (one-year cache): each name-week, then its NEXT week, Monday's open to the last
close, net vs SPY; each week once in the range.

| Last week | Names | Next week, per week (95%) | Median | Up |
|---|---|---|---|---|
| Every name | 58,600 | +0.01% (−0.36 … +0.39) | −0.2% | 48% |
| Up 5%+ | 9,276 | +0.44% (−0.19 … +1.07) | +0.1% | 51% |
| — up 5–10% / 10–20% / 20%+ | 6,100 / 2,543 / 633 | +0.42% / +0.60% / −0.45% | | |
| — with a report / without | 1,103 / 8,173 | −0.43% / +0.43% | −0.5 / +0.18 | 47% / 51% |
| — closed in its week's top fifth / under | 5,932 / 3,344 | +0.14% / +0.85% (+0.06 … +1.63) | | |
| — gapped up / down into the next week | 2,102 / 1,995 | +0.39% / +0.79% | −0.36 / +0.86 | 48% / 55% |
| Down 5%+ | 9,657 | −0.17% | −0.62% | 46% |
| Down 20%+ | 432 | −0.76% | −1.55% | 43% |

A mild carry — a 5–20% week without a report leans on into the next (+0.4 to +0.6%), a 20%+ or report-driven week
fades, a down week leans on down — but no group's range clears zero except "closed under its week's top fifth", one of
a dozen cuts on one year: a lead to test on three years with the last held out, not a finding. The gap-down entry
agrees with §10's Monday gap.

**Held longer** (`--holds=5,10,15,21`, Roy: "a week, 2 weeks, 3 weeks, a month") — from the next Monday's open, the
range over non-overlapping blocks of weeks as long as the hold. Up 5%+: +0.38% / +0.81% / +0.36% / +1.14% (1 / 2 / 3 / 4
weeks) against every name's −0.01 / +0.08 / +0.11 / 0.00 — the mean grows with the hold, the range grows faster (a
month: −0.70 … +2.97) and the up-share stays under half (48–50%): a few big winners carry it. A 20%+ week fades at every
hold (−0.68 … −2.35%); "closed under its week's top fifth" is the only cut at zero's edge (+0.85% [+0.01 …], +1.17%
[0 …] at two weeks) and none clears it at three weeks or a month. No scanner here.

## 12. The false break of last week's low (2026-10-25)

Roy: "check one candle pattern — prev week low false break". `falsebreak_*`: a session whose low trades under the
previous calendar week's low and closes back over it — the week's first break — bought at the next open; held 5, held
10, held 10 out on a close under the break day's low, and by regime; tagged by the trend (200-day) and the break's depth.
Three years, the last held out:

- **As a whole, nothing:** 36,655 trades, −0.09% (held 5) / −0.13% (held 10); the stop makes it worse (−0.14%, the
  held-out year −0.23%). Under the 200-day it loses (−0.14 to −0.53%).
- **Over the 200-day, a DEEP break (2%+ under last week's low), held 10** — 2,184 trades (~3 a session): +1.53% a
  session, +0.91% a trade; the block range over three years +1.28% (+0.04 … +2.53). Before the held-out year +1.75%
  (blocks +1.14%, −0.46 … +2.73); held out +1.11% (blocks +0.58%, −1.97 … +3.12). Every calendar year positive (2023
  +0.94, 2024 +1.47, 2025 +2.17, 2026 +0.98). Held 5: +0.54% (blocks +0.43%, −0.25 … +1.12). With the stop: +0.87%.
- Caveats: one cut of six tags × three holds, so the chance a cut this good is luck is real; the held-out ranges cross
  zero; survivorship flatters a dip-buy (the names that kept falling left today's universe — §5).

A second lead beside the run-up, weaker on the held-out year: the next step would be the same rule on the small-cap
universe and on another three years before (bars reach 2012), declared before it is run.

**On the movers only** (`falsebreak_movers_*`, Roy's option 2: the same break where the name is in play — a 20-day
volatility of 8%+ or 5%+ against SPY over the five sessions to it; tagged trend × kind of mover, declared before the
run): 9,634 trades. Held 10: +0.32% (blocks +0.33%, −0.42 … +1.08; before +0.11%, held out +0.75%) — no sharper than
every name's. A BIG WEEK UP into the break loses at every cut (−0.7 to −2.2%). A big week DOWN over the 200-day flips
(before −0.21%, held out +1.67%) — the held-out year's rebound, not the pattern. Over the 200-day and volatile is
positive in both periods (held 10: +0.87% / +1.34%), its ranges crossing zero. The movers do not sharpen the break;
§12's every-name cut (over the 200-day, a 2%+ break, held 10) stays the lead.

**Last month's low** (`falsebreak_month_*`, Roy: "check also prev month low false break") — the previous calendar
month's low, the month's first break, closed back over; the same tags; held 5 / 10 / 20. Nothing: +0.13% / −0.07% /
−0.63% (8,047 trades). The week's lead does NOT carry over — over the 200-day with a 2%+ break: +0.13% / −0.43% /
−0.23%. One result is steady, the wrong way: UNDER the 200-day, a shallow break (0–2%) is a real break — held 10,
−0.84% (before −0.87%, held out −0.79%, both ranges under zero); held 20, −1.55%. That reads as an AVOID, not a buy. The
month not echoing the week makes §12's week lead less likely to be structural.

**Out of sample — the small caps** (784 names, $300M–$2B, one year 2025-11 → 2026-10, the same rule unchanged): the lead
FAILS. Over the 200-day with a 2%+ break: held 5 −1.38% (−2.51 … −0.26), held 10 −1.32% (−3.02 … +0.38) — against the
universe's own baseline of −0.22%, and against +1.11% for the same cut on the screener's names over the same year. Every
cut is negative. The week's false break does not travel outside the names it was found on: dropped as a lead.

**Out of sample — the screener's own names, 2019 → 2023** (`--from=2019-01-02 --to=2023-10-06`, a cache of its own:
1,063 of the names had bars then; 1,196 sessions, years the rule never saw; the rule unchanged): the lead FAILS. Over
the 200-day with a 2%+ break, held 10: −0.06% (−0.87 … +0.75; halves +0.47% / −0.58%); held 5: −0.03%. The whole rule
−0.16% / −0.05%. Survivorship flatters a dip-buy most this far back, and still nothing. With the small caps, the
week's false break is DROPPED: §12's three-year cut was the best of eighteen, and it was luck.

## 13. Wyckoff's spring (2026-10-25)

Roy: "wyckoff, build it". `springAt` / `wyckoff_spring[_stop]`, declared before the run: a 40-session range 10–40% wide
(support touched twice, the range's last close within 10% of its first), the first session under support closed back
over within three sessions (the spring no more than 10% under), bought at the next open; out at the range's top or
after 20 — and with a stop on a close under the spring's low. Tagged: a decline (−10%+ over the 60 sessions before the
range) or none × the volume on the break (light < 1×, heavy ≥ 1.5× the range's average).

- **Three years: it loses.** −0.68% a session (blocks −0.66%, −1.67 … +0.35; before −1.01%, held out +0.04%); with the
  stop −0.80% (blocks −0.90%, −1.30 … −0.51 — under zero). The textbook spring — after a decline, LIGHT volume — −0.10%
  (−0.71% with the stop). Without a decline before the range, every cut loses (−0.68% to −1.27%).
- One cut positive: after a decline on HEAVY volume (a shakeout), +3.35% a session (+1.29% a trade; −0.63 … +7.34) —
  checked at once on the 2019–2023 cache: −0.92% (−1.98 … +0.14). Dropped.

## 14. Short interest and short volume (2026-10-25)

Roy: "go with short interest and short volume". FINRA, free and in bulk (`providers/finra.provider.js`; Massive answers
five calls a minute, FMP's short endpoints are legacy-only): short interest per settlement date (80 dates, 2023-06 →
2026-09), safe to know 12 calendar days after settlement (`SHORT_INTEREST_LAG_DAYS` — FINRA publishes ~7 business days
on); the daily short-volume files (853 days) as each name's short share of FINRA-reported volume. Extras
`shortInterest` / `shortVolume`, read per DATE (screenerLab.data BULK). Three years, the last held out:

- **The level** (`si_level`, the session a report is published, held 10, by days to cover): −0.11% overall; 1–3 days
  +0.11%, 3–7 −0.21%, 7+ −0.28% — the heavily shorted lag a little, before (−0.43%) not held out (+0.07%); 72 report
  sessions, every range across zero. **The change** (`si_change`): nothing (−0.14% … +0.12%).
- **The short-volume spike** (`sv_spike`, a week's short share against the name's own 60 sessions, held 5): nothing —
  −0.13% to −0.03%, a spike of 10 points −0.12%.
- **On the live run-up** (5 sessions before, last three beat, SPY over its 200-day; 4,639 trades, +0.39% a session,
  blocks +0.31% −0.10 … +0.72): by days to cover — 1–3 days +0.51% (before +0.43% [+0.09 … +0.78], held out +0.68%),
  3–7 days +0.30%, **7+ days −0.09%** (before −0.24%, held out +0.24%; 487 trades). The heavily shorted names do not run
  up — a filter to try, not proven. By the short-volume spike: no order (normal +0.47%, ±5–10 points ~+0.05%, a 10-point
  spike +0.37%) — noise.

Neither is a screener on its own. Days to cover 7+ is a candidate AVOID on the run-up, beside §12's.

## 15. Dark pools (2026-10-25)

Roy: "go with dark pool". FINRA's weekly ATS volume per symbol (`atsWeek`, summaryTypeCode ATS_W_SMBL; 173 weeks from
2023-06; extras `darkPool`), each week known from its own `initialPublishedDate` — two weeks late for NMS Tier 1, four
for the rest. The share = the week's ATS shares over its volume from the bars; the JUMP = that share less the name's
eight weeks published before (`dpShares`). Declared before the run, three years, the last held out:

- **The jump** (`dp_jump`, the session a week is published, held 10, jump × the week's price): −0.10% overall; the
  "quiet accumulation" cut — a jump of 5+ points while price FELL — is the WORST, −0.36% (before −0.44%, held out
  −0.20%). Every cut's range crosses zero.
- **Rising three weeks running** (`dp_rising`): +0.08% (blocks −0.03%); price up over them +0.01% (−0.33% / +0.73%).
- **On the live run-up** (`runup_dp`): a NORMAL dark-pool week +0.57% (before +0.62% [+0.20 … +1.03], held out +0.49%),
  a 5-point jump −0.15% (−0.47% / +0.61%), a drop +0.25%. Like the short volume's (§14): the run-up does best where the
  flow is ordinary — not an order a filter can use with confidence.

Weekly and late, the dark-pool figure carries no edge here — on its own or under the run-up.
