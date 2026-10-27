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

## 16. After the news — test A (2026-10-26)

Roy: "does news move stocks — run test A". `services/newsShock.service.js`, `scripts/lab-news-shock.mjs`. Declared before
the run: a SHOCK is a session that closed 5%+ against SPY (close to close) on 2× its 20-day dollar volume; bought at the
NEXT open (the whole shock known), held 1 / 5 / 10 / 20, net of SPY and the cost; by direction and by a report that day
or the day before; three years (2023-10-09 → 2026-10-23, 13,759 shocks), the last year held out. Drift = the next
sessions go the shock's way.

| Shock | n | Held 1 | Held 5 | Held 20 [per-session 95%] | Before / held out (20) |
|---|---|---|---|---|---|
| Up, no report | 5,749 | −0.37% [−0.63 … −0.12] | +0.09% | +1.29% [+0.21 … +2.37]; blocks of 20 +0.79% [−1.78 … +3.35] | +0.96 / +1.99 |
| — of which 10–20% | 1,847 | −0.12% | +0.46% | +1.90% [+0.12 … +3.69] | +2.09 / +1.57 |
| Up, earnings | 2,750 | +0.16% | −0.38% | +0.02% | −0.36 / +0.82 |
| Down, no report | 2,767 | −0.15% | −0.61% [−1.23 … 0] | +0.01% | −0.23 / +0.51 |
| Down, earnings | 2,493 | −0.27% [−0.54 … −0.01] | −0.32% | +0.19% | −0.71 / +1.96 |

- **Earnings shocks leave nothing** — no post-earnings drift at this cut, either way.
- **Up on no report** gives a little back the next session, then leans on over a month; both periods positive, but the
  honest range (non-overlapping 20-session blocks) crosses zero and fewer than half go up (45.7%) — a few big winners
  carry it. The 10–20% band is the sharpest: a LEAD, not a finding.
- **Down shocks** lean on down for 5–10 sessions (−0.3 … −0.6%) and recover by 20. Nothing clears zero.

**By headline type, the last year** (non-earnings shocks, 2025-11-13 →; FMP `/news/stock` from 16:00 the session before
to 13:00 on the entry day, keywords on titles — `NEWS_TYPES`; 502 reads, four days hit the 250 cap): 'other' and 'no
headline' are 1,902 of the 3,163 (up 861 + 514, down 345 + 182) — the titles rarely say why. Groups
of 31–261, ranges wide, the year's halves often opposite (Nov–Apr a speculative run, May–Oct not). The one cell that
clears zero with both halves agreeing: **down on NO headline, held 5: +2.82% [+0.34 … +5.31], +2.95 / +2.70 (182)** —
a hard fall nobody explained comes back. One of ~80 cells on one year: a lead to test on a wider universe. Deals,
analyst notes, guidance, FDA, contracts, offerings: none separates.

**Verdict:** on this universe, once the shock day is over, news shocks leave no drift or reversal you can trade with
confidence. Two leads: up 10–20% with no report (drift over a month) and down with no headline (a week's bounce).
Caveats: today's universe (survivorship flatters the down-shock bounces), keyword types, one year of headlines.

## 17. The second order — test B (2026-10-26)

Roy: "does news move 2nd order stocks — test b". `peerRows` (newsShock.service), `scripts/lab-peers.mjs`. The link is
the INDUSTRY (FMP's, off the latest screener stats: 133 industries, 88 with 4+ names) — no supplier/customer map is on
our data. Declared before the run: §16's shocks grouped into one-way industry-days (8,826; mixed days dropped); every
other name of the industry is a PEER (133,023 rows); its own move that session against SPY is its reaction (quiet under
2%, along, against); bought at the next open, held 1 / 5 / 10 / 20, net of SPY and the cost, three years, the last held
out.

- **Day 0 — yes, the peers move with it**: up shocks +0.67…+0.72% (61% of peers up), down −0.76…−0.96% (33–37% up),
  every range well clear of zero. About 60% of peers stay quiet, 28% move along, 11% against.
- **After — nothing reads through.** By the shock: every cell's block range crosses zero at every hold (up, no report,
  held 20: +0.67%, blocks +0.52 [−0.53 … +1.57]; the down shocks' peers show no matching fall — the up-shock number is
  the universe's drift, not the shock's).
- **By the peer's own reaction**: the 'against' peers lean up later on BOTH sides (+1.5…+1.6% held 20) — direction-free,
  so it is the volatile names' drift, not read-through.
- **Leader → laggard** (a bigger name shocked, quiet peers): first run showed down-earnings leaders' peers −1.18% held 20
  (blocks −1.34 [−2.30 … −0.39]) — a LOOK-AHEAD: "bigger" was read on TODAY's caps, and a peer that fell since is smaller
  today. On the cap THAT DAY (today's × the day's close over the last) it is −0.19% (blocks −0.52 [−1.64 … +0.59]).
  Nothing.
- **Earnings read-through** (quiet peers whose own report falls within 20 sessions): nothing either way.

**Verdict:** news moves the second order the SAME DAY — about a tenth of the shock, at once — and leaves nothing after.
On this universe, at the industry level, the market prices the read-through on the day. What is left untested: links the
industry label cannot see (suppliers, customers, competitors across industries) and smaller, less-followed names.

## 18. Can the run-up trade the report? — test C (2026-10-26)

Roy: "after a report we have a prediction of the next one, the analysts' pricing, the news between — so in some cases
the run-up can also trade the report". `services/reportReaction.service.js`, `scripts/lab-report.mjs`. The REACTION is
the close before the report date to the close after it, against SPY (it holds the move before the open or after the
close) — exactly what holding through adds to the run-up. Thirteen facts known the evening before (`REPORT_FEATURES`):
the last three reports' beats, the last EPS and revenue surprise, the last reaction, this estimate against the actual a
year before, the run into it (5 and 20 sessions), SPY over its 200-day, and the ANALYSTS — upgrades less downgrades in
the 60 days before, price-target raises less cuts in the 45 days before, how many notes, the median target's upside
(new lab extras `grades` and `targets`: FMP `/grades` and `/price-target-news`, 111,017 and 47,003 rows from 2023-06; the
estimate HISTORY is a 402 on our plan). Bins cut and a logistic fitted on 2023-10 → 2025-10, scored on the held-out
year; 12,662 reports, 2,517 of them the run-up's own names (the last three beat, SPY over its 200-day).

- **The reaction is a coin with a wide spread**: 48% up, mean ~0, sd 10.4%. The run-up's names: 46–47% up, per report
  day −0.15% / +0.57% (both ranges cross zero).
- **All thirteen together**: AUC 0.518 held out on every report, **0.494 on the run-up's names** — no better than a coin.
  No decile is clear of the others.
- **The analysts**: on the run-up's names, net upgrades and target raises flip between the periods (raised ≥ 2: −0.63%
  before, +1.65% held out, both ranges across zero). Target cuts lean negative in both (−1.42% / −0.68%) — not separated.
- **Only two facts keep their sign and size**, both as AVOIDS on the run-up's names: a falling estimate (this report's
  EPS estimate 21%+ under a year before: 42% / 37% up, against ~47–51% above it) and quiet volume into it (the bottom
  fifth, 42% / 41% up). Neither makes a group whose reaction is reliably UP.

**Verdict:** nothing known the evening before tells which way the report goes — not the history, not the run, not the
analysts. Holding through stays a coin at twice the spread. Two leads, both "get out / skip": the run-up name whose
estimate is falling year on year, and the one arriving on quiet volume — to test as run-up FILTERS (does the run-up
itself do worse on them?), not as report trades. Caveats: the analysts' direction comes from title keywords; the
estimate is the final one (its revisions are not on our plan); today's universe.

## 19. Where a trend comes from — test D (2026-10-26)

Roy: "events keep affecting prices even when far from the event date". `services/trendSource.service.js`,
`scripts/lab-trend-source.mjs`. Each name's year against SPY, in log points so the parts add, cut three ways: its REPORT
windows (the close before each report date → the close after), its INDUSTRY's mean move on every other session (the
name left out; FMP industries), and its OWN move on those sessions. Three yearly windows, the last held out; ~900–1,000
names each. The report windows are 3.2% of the sessions.

| Winners (20%+ over SPY) | Names | Total | Reports | Industry between | Own between | Reports' share |
|---|---|---|---|---|---|---|
| 2023-10 → 2024-10 | 164 | +45.1 | +12.0 | +0.7 | +32.4 | 27% |
| 2024-10 → 2025-10 | 155 | +52.3 | +13.0 | +8.3 | +31.0 | 25% |
| 2025-10 → 2026-10 (held out) | 197 | +50.1 | +11.6 | +5.7 | +32.8 | 23% |

- **A report session moves a winner 7–10× an ordinary one** (+1.4…+1.6 against +0.1…+0.2 points a session) — and the
  losers mirror it (−1.5…−1.7). The reports are DENSE.
- **But three quarters of a winner's year is made BETWEEN reports, and mostly its OWN** — the industry carries 1–16% of
  it (it beat the name's own between-report move for only 20–32% of winners). Reports were negative for a quarter to a
  third of the winners. The losers lean more on the industry (−11 … −18 of ~−50).
- PEB, the held-out year: +49.4 = reports +7.7 + industry +18.9 + own +22.8. CAKE: +51.9 = reports +4.5 + industry −34.6
  (restaurants fell) + own +82.0.

## 20. The drift after a report, by its surprise — test E (2026-10-26)

`collectDrift` (reportReaction.service), `scripts/lab-report-drift.mjs`. Every report with an actual, by the EPS
surprise (the estimate floored at 5 cents: miss under −2%, in line, beat to +10%, big beat), crossed with the reaction's
sign; bought at the open of the SECOND session after the report date (both known), held 20 / 40 / 60, net of SPY and
the cost; 13,297 reports, the last year held out.

- **No classic drift** (a beat leaning on up, a miss on down). Every surprise band's block range crosses zero at every
  hold; up-shares are 40–47% — the means are carried by a few big winners (big beat held 60: +7.3%, range −3.5 … +18).
- **The leans run AGAINST the event**: a beat the market bought fades (held 40: −1.64% [−2.72 … −0.56], before −1.57 /
  held out −1.83; blocks cross zero); a MISS the market sold recovers (held 60: +4.37% [+0.58 … +8.17], blocks +3.99
  [+0.31 … +7.67], before +5.33 / held out +1.85) — the one cell clear on both ranges. Survivorship flatters exactly that
  cell (today's universe: the misses that kept falling are gone), and 43% of them went up. A lead at most.

**Verdict on Roy's question:** events keep moving prices far from their date only in the sense that NEW events keep
arriving — three quarters of a trend is made between reports, mostly by the company's own flow, not its industry. The
report itself does not keep pushing its way; if anything its move partly comes back.

## 21. The early reporters → the late one — test F (2026-10-26)

Roy: "we need to anticipate the price movement after earnings". `peerSeason` (reportReaction.service),
`scripts/lab-peer-season.mjs`. For each report, its industry's EARLY reporters: the other names with a report in the 45
days before it whose reaction window closed by its evening before (2+ needed). Their mean EPS surprise, the share that
beat (over +2%), their mean reaction, how many. Two outcomes: did the target BEAT, which way did it REACT. Terciles and a
logistic cut/fitted on 2023-10 → 2025-10, scored on the held-out year; 8,865 reports.

| Early reporters' beat share | Target beat — before / held out | Target reacted up — before / held out |
|---|---|---|
| low (≤ 50%) | 58.7% / 58.2% | 49.0% / 50.6% |
| mid | 62.4% / 62.7% | 47.4% / 48.0% |
| high (> 73%) | 68.5% / 68.2% | 46.4% / 44.8% |

- **The RESULTS read through**: when the early reporters beat, the late one beats more often — 58% → 68%, the same in
  both periods; the four facts together AUC 0.553 held out for the beat (the first fact in the lab that predicts a report
  outcome out of sample). The early surprise's size says the same (+8.6 / +10.5 points top to bottom).
- **The PRICE does not**: for the reaction the same facts score AUC 0.505, and the reacted-up share runs slightly the
  OTHER way (49% → 46%, 51% → 45% held out). Every reaction range crosses zero.

**Verdict:** the market reads the peers too — the better the season, the higher the bar, and the late beat is in the
price before it prints. Real business information flows between peers, and it is already in the expectation.

**As a run-up filter** (`scratch/peer-runup.mjs`; `peerSeason` `lead: 5` — only the early reporters known at the
run-up's ENTRY): the 5-session run-up by the early reporters' beat share, net vs SPY per session. Held out, a weak season
looks like an avoid (every report −0.57%, the rule's names −0.66% with 39% up; mid/high +0.6 … +1.05%) — but the years
before do not agree (low +0.31% / −0.01%, high the weakest), and every range crosses zero. Not a filter.

## 22. The funds (13F) — test G (2026-10-26)

Roy: "start with EDGAR". The data is already ours: `fund_holdings` in `test` (pythia-money-flows.md §3.2 — SEC's
quarterly 13F data sets, shares only, one filing per filer, split-safe), one row per company per quarter, 9 quarters
2024-06 → 2026-06, ~2,500 companies. `services/fundFlow.service.js`, `scripts/lab-funds.mjs`.

**Declared before the run.**
- **Facts, per company per quarter** (vs the quarter before): `own_chg` — the change in institutional ownership, 13F
  dollars ÷ the market cap at the quarter end (today's cap × that close ÷ the last close, so a split cannot move it), in
  points; `holders_chg` — the change in the NUMBER of filers holding it, log (breadth, Chen–Hong–Stein 2002);
  `own_level` — the ownership itself (crowding). A change that more than doubles or halves ownership is a CUSIP or
  filing break and is dropped (§3.2's rule).
- **The trade:** buy at the first open on or after quarter end + 46 days (the filing deadline is day 45, so every
  filing is public on EDGAR by then), hold 63 sessions (to the next quarter's facts), net vs SPY after cost; the lab's
  price and volume floor. Quintiles WITHIN each quarter, so the drift every quarter shares (§3.2 trap 4) cancels.
- **Eight periods:** four before the split (entries Nov 2024 → Aug 2025), four held out (Nov 2025 → Aug 2026; the
  last is scored to the latest close, ~50 sessions, and said so).
- **Expected direction** (the literature): ownership and breadth RISING → better; a high level (crowded) → worse.
- **Bar — a fact passes only if:** the top-minus-bottom quintile has the expected sign in BOTH halves and in at least
  6 of the 8 periods; it is a long-only rule only if the top quintile is also above SPY after cost in both halves.
- **Secondary:** the same, entered 20 sessions later — when SEC's data set (what our job reads) is out, not the
  filings one by one.
- Known limits: 8 periods is thin (a pass is a "maybe", a fail is a fail); share issuance reads as funds buying (the
  cap proxy keeps today's share count); the universe is the lab's names that `fund_holdings` also holds.

**Result (2026-10-26).** 22,865 rows, 9,721 in the lab → 8,488 changes, 8,213 traded (~1,000 names a quarter). Top
minus bottom quintile, net vs SPY over the hold, mean of the periods:

| Fact | At the deadline — before / held out (expected sign) | 20 sessions later — before / held out |
|---|---|---|
| own_chg | +3.70% / −3.22% (4 of 8) — **FAIL** | +1.90% / −1.31% (3 of 7) — FAIL |
| holders_chg | +4.51% / +0.55% (5 of 8) — **FAIL** | +4.44% / +4.54% (6 of 7) — pass |
| own_level | −5.74% / −0.64% (5 of 8) — **FAIL** | −5.90% / −1.47% (6 of 7) — pass |
| *mom (control, not declared)* | +2.28% / −4.12% (3 of 8) | +3.59% / +0.23% (5 of 7) |

- **The declared test fails** on all three. Ownership CHANGE (the "funds are buying" fact) has no sign at all — it flips
  between the halves.
- **The secondary's two passes are not trusted:** they pass by the minimum (6 of 7), the 20-session entry loses the last
  period — the worst one for breadth (−13.6%) — and the two entries share 43 of their 63 sessions, so a fact that fails
  at one and passes at the other is mostly noise. A period's spread swings ±10–15 points; over 7–8 periods a +4.5% mean
  is about t 1.3.
- **Breadth is not just momentum:** it correlates 0.52 with the quarter's price move, but the price move alone does worse
  (3 of 8, 5 of 7). Low ownership doing better is most likely the small / foreign / newly listed names this period
  favoured — a style, not the funds.

**Verdict:** FAIL — no rule. Breadth (more filers) and low crowding lean the way the literature says, which is a
"maybe" for a longer history, nothing to trade. The way to settle it: 13F back to 2019 (SEC's data sets, ~20 more
quarters, the aether job's backfill) against the lab's 2019 → 2023 bars — ~27 periods instead of 8.

## 23. The funds on the run-up — stay to the next report? — test H (2026-10-26)

Roy: "test it on the run up — as a rule for staying for the report, until following earnings". `factsKnown`
(fundFlow.service), `scripts/lab-funds-runup.mjs`.

**Declared before the run.**
- **The names:** the run-up rule's (§ run-up: the last three reports beat, SPY over its 200-day), entered at the open 5
  sessions before report k — only entries from 2024-11-15, the first day a 13F change is public.
- **The facts:** each name's latest 13F change PUBLIC on the entry day (publicDay ≤ entry), its quintile within that
  quarter's whole cross-section (test G's quintiles, every company, not only the rule's).
- **Three numbers per trade,** net vs SPY: the RUN-UP (open k−5 → close k−1, after cost — the rule as it is); the STAY
  part (close k−1 → close before the next report, vs SPY; no extra cost — one round trip either way); the WHOLE (open
  k−5 → close before the next report, after cost). A next report 40–110 sessions after k, inside the data; otherwise the
  trade is out.
- **Primary:** `holders_chg` Q5 (breadth rising most — test G's best lean). **Also shown:** `own_chg`, `own_level` (Q1
  is the "uncrowded" side) and every rule name.
- **Bar — staying is a rule only if** the primary group's STAY part is above zero in both halves (split 2025-10-23),
  beats the bottom quintile's stay in both halves, and its 21-session block range over all of it excludes zero.
- Known limits: ~2 years of entries; the stay holds overlap (each ~60 sessions), so the block range is the honest
  range, not the per-name one; test G's limits carry over.

**Result (2026-10-26).** 1,216 run-up trades (entries 2024-11-15 →), held to the next report a median 67 sessions.
Net vs SPY, mean per trade; the stay part's 21-session block range:

| Group | Run-up | Stay — before / held out | Stay up | Stay blocks |
|---|---|---|---|---|
| every rule name | −0.10% | −0.97% / +2.75% | 46% | −4.0 … +2.4 |
| holders_chg Q5 (declared) | +0.30% | +1.18% / +5.01% | 47% | −8.8 … +4.2 |
| holders_chg Q1 | −0.68% | +0.71% / +4.43% | 51% | −6.2 … +7.3 |
| own_chg Q5 | +0.51% | −1.09% / −0.73% | 39% | −10.0 … +2.8 |
| own_level Q1 (uncrowded) | +0.03% | −6.27% / +0.07% | 38% | −11.0 … +0.1 |

- **The declared rule FAILS:** breadth Q5 stays better than Q1 in both halves, but by 0.5 points — and its range runs
  −8.8 … +4.2. Across the quintiles nothing is in order (breadth: +2.7, −0.6, +0.5, −0.9, +3.4).
- **Staying itself is not an edge:** fewer than half the stays end above SPY (46%); the means are the tails and the
  period — every group lost before the split and gained in the held-out year, the market's year, not the funds'.
- **Test G's leads turn over:** the "uncrowded" side (own_level Q1) is the WORST stay (−2.8%, 38% up); funds buying
  most (own_chg Q5) is below SPY in both halves.
- Seen on the way: since 2024-11 the run-up on these names is flat (−0.10% over the 5 sessions) — a shorter, later
  window than the rule's own test; read with the rule's full record, not instead of it.

**Verdict:** FAIL. 13F says nothing about which run-up names to keep through the report. Exit at the close before the
report, as the rule does.

## 24. The funds at the report — hold through it or sell before? — test I (2026-10-26)

Roy: "can I use this data when deciding on the following earnings — keep holding or sell before?" `scripts/lab-funds-report.mjs`.

**Declared before the run.**
- **Every report** from 2024-11-15 (and the run-up rule's names apart), the REACTION as test C has it (close k−1 →
  close k+1, vs SPY — `collectReports`), by the latest 13F change PUBLIC on day k−1 (`factsKnown`), its quintile within
  its quarter's whole cross-section.
- **Read:** the mean reaction and the reacted-up share per quintile, before / held out (split 2025-10-23); the three facts'
  AUC for "reacted up", cut on the years before and scored on the held-out year (`fitAndScore`, test C's way).
- **Bar — a hold-or-sell fact only if:** top-minus-bottom reaction has one sign in BOTH halves, the up share moves
  the same way, and the held-out AUC ≥ 0.53 (test F's beat read was 0.553; test C's reaction reads ~0.50).

**Result (2026-10-26).** 7,502 reports with 13F facts known the day before (1,480 of them the run-up rule's names).
Top-minus-bottom quintile, the reaction vs SPY (the up share's gap in brackets):

| Fact | Every report — before / held out | The rule's names — before / held out |
|---|---|---|
| own_chg | +1.17% (+6.0) / +0.18% (−0.5) | +4.62% (+17.9) / −1.22% (−2.3) |
| holders_chg | +1.13% (+3.0) / +0.85% (+0.8) | +0.61% (−5.5) / −1.65% (−5.0) |
| own_level | −2.47% (−7.3) / −0.56% (−0.2) | −3.97% (−11.0) / −0.97% (+2.8) |
| AUC, the three facts (held out) | 0.505 | 0.494 |

- **FAIL on the bar** — the AUC is test C's coin (0.505, 0.494), and on the rule's names every fact flips between the
  halves.
- **Two leans across all reports**, the same way in both halves: breadth rising reacts a little better (+0.85 points held
  out), crowded a little worse (−0.56). Both shrink to under a point held out against a reaction that swings ±10% —
  a tilt across thousands of reports, nothing for the one name in front of you.

**Verdict:** FAIL. 13F does not decide hold-through-the-report or sell-before; that call stays "sell before" (the
reaction is a coin, §18).

## 25. The 13F spot-check (2026-10-26)

Roy: "did you read each 13F report?" — no: tests G–I read `fund_holdings`, the aether job's per-company totals. Checked
before going further (scratchpad scripts, independent of aether_engine's code):

- **The job against the data set:** SEC's Jun–Aug 2026 file (11,852 filings; 8,891 counted from 8,857 filers), 10 companies
  from AAPL to two small caps picked by rank (ORBS, BBW): shares and dollars EXACTLY equal (0.000%) for all 10; filers +1
  for each — Vanguard's two new CIKs, which the job counts as one (FILER_SUCCESSORS), as documented.
- **The data set against EDGAR:** 9 filings fetched from EDGAR's archive (BlackRock, FMR, T. Rowe Price, Barclays,
  CalSTRS ×2, three small filers), PEB and CAKE summed from each info table: every share count equal to the data set.
- **The CUSIPs:** every row's issuer name for the 10 is the company (a handful of filers' own typos).
- **Found:** (1) T. Rowe Price Associates files VALUE in THOUSANDS (its PEB $166M reads $166K; table total $999M for a
  ~$1T book) — dollar facts understate such a filer 1,000× (shares are right); (2) CalSTRS swapped shares and value, then
  filed a restatement — the job keeps the restatement only (correct); an unrestated misfiling stays in the stored rows
  (the job's `jumpy_out` runs at the node level, not on them); (3) PEB's funds report 143M shares of 113M outstanding
  (127%): 17.5M were short (lent shares are reported twice), the rest shared discretion (70M of it "DFND"). LEVELS read
  high; CHANGES are what the data is good for.
- **Carried into the next tests:** test G's caps were today's share count — FMP's historical caps (`monthly_prices.caps`)
  exist and are used from here; dollar values get a per-filing unit check.

## 26. The managers — test J (2026-10-26)

Roy: "test the managers — do not make short cuts". Not every fund together (index money swamps it — tests G–I) but
WHICH manager bought, from each filing's own holdings. `scripts/lab-13f-extract.py` (SEC data sets → per filer per
quarter), `scripts/lab-managers.mjs`. Literature: Cohen, Polk & Silli (2010), "Best Ideas" — a manager's
highest-conviction positions beat the market; most of a fund's other holdings do not.

**Declared before the run.**
- **Span:** filings for quarters 2018-12-31 → 2026-06-30 (31 files), against the lab's bars 2019-01 → now (the 2019–2023
  and 3-year caches joined). Held out: entries from 2025-10-23.
- **Each filing read whole** (every holding, not only our companies): the filer's book value V and its number of
  positions N. Counted as the job does (shares only, no options, the restatement/new-holdings rule, the quarter's own
  period). **Units checked per filing:** each position's value/shares against the median of every filer for that CUSIP;
  a filing whose median ratio is ~1/1000 is in thousands (×1000), ~1000 in dollars where thousands were due (÷1000);
  any other far-off filing is left out of V-based rules and counted.
- **A conviction bet:** a company in the lab's names that the filer did NOT hold in its filing for the quarter before
  (it must have filed one), at ≥ 3% of its book.
- **Groups:** PRIMARY — conviction bets by CONCENTRATED managers (N ≤ 40 positions, V ≥ $100M). CONTROL — ≥ 3% new
  bets by every other filer (N > 40). Secondary: (a) concentrated managers ADDING ≥ 50% to a ≥ 3% position (dollar value
  ÷ the price move, so a split cannot fake it); (b) CONSENSUS — 2+ concentrated managers' new bets on one company in one
  quarter; (c) TRACK RECORD — concentrated managers whose earlier primary bets (5+, only holds already finished on the
  filing day) averaged above SPY.
- **The trade:** the first session AFTER the filing's own date (EDGAR posts it that day), held 63 sessions, net vs SPY
  after cost, the lab's price/volume floor; one trade per company per quarter per group (the earliest filing).
- **Bar — PRIMARY passes only if all hold:** mean net > 0 before AND held out; the 21-session block range over the whole
  span above zero; above CONTROL in both halves; and — the minority check — the mean with the best 1% of trades removed
  still above zero (the median shown).
- Known limits: the lab's names are TODAY's (survivors) — every group is flattered, so the CONTROL is the comparison
  that counts; a CUSIP that changed is missed in the quarters before the change.

## 27. A model on the run-up, and rules combined — test K (2026-10-27)

Roy, 2026-10-27: "start with a [a model that filters the run-up trades], and test also combination of rules". Every test
so far asked "which name goes up" and failed (§10 AUC 0.51, §18 0.518). This one asks a smaller question: of the run-up's
OWN trades — the one rule with an edge (§6) — which to skip. Known in the trade as meta-labelling. `services/runupModel.service.js`
(the trades and their facts), `scripts/lab-runup-ml.mjs` (→ `data/lab/runup-ml.csv`), `scripts/lab-runup-ml.py`
(the model and the rule search; LightGBM 4.7, scikit-learn 1.9).

**Declared before the run.**
- **The trades:** EVERY run-up entry (bought at the open 5 sessions before a report, out at the close before it —
  `runup_5`), any streak, any market: the live rule (3 of 3 beat, SPY over its 200-day) is one combination INSIDE the
  population, so the search can find it, beat it, or not. Span: the 2019–2023 and 3-year caches joined (joinWindows),
  entries from the 261st session. Held out: entries from **2025-10-23** (as §22–§26).
- **The label:** the trade's net vs SPY after cost (screenerLab `trade`) > 0. The net itself is kept for scoring.
- **The facts** — each known by the close before the entry (the entry open only for the gap): moverDiff's 26 (less
  `report_in_week`, always 1 here); the report's own (exp_growth, last_rev_surprise, upgrades less downgrades 60 days,
  price-target raises less cuts / notes 45 days, the median target's upside 90 days); short interest days to cover and
  its change (§14), the short-volume share against its 60 sessions, the dark-pool jump (§15) — these three only from
  2023-06, MISSING before (the trees treat missing as its own branch; read with that in mind); insider buyers 90 days;
  the season so far — of the same sector's names that reported in the 30 days before, the share that beat; the market
  regime calm/stormy (spyRegimes).
- **THE MODEL** (one setting, NOT tuned): LightGBM, 300 trees, learning rate 0.03, 15 leaves, ≥ 200 trades a leaf, 80%
  of the facts a tree, L2 1. Beside it a logistic regression (the §10 kind) on the same facts.
  - **Walk-forward:** test years 2021, 2022, 2023, 2024, 2025 (to the held-out day); each fitted on every trade whose EXIT
    came before the test year's first day (no overlap leaks), scored on that year only.
  - **The held-out year:** fitted on every trade exiting before 2025-10-23, scored once.
  - Within each scored period the trades are cut in thirds by score; each third's net per session (each session once)
    with the 5-session block range.
  - **PASS only if all hold:** the pooled walk-forward AUC ≥ 0.53 and above 0.5 in 4 of 5 years; the top third above the
    bottom third in 4 of 5 years; on the held-out year the top third's net per session above BOTH every run-up trade's and
    the live rule's, with its block range above zero.
- **RULES COMBINED:** each fact cut at its tertiles on the trades before the held-out day (low ≤ ⅓, high ≥ ⅔, and the
  0/1 facts as they are) → conditions; every single, pair and triple of conditions on different facts. On the trades
  before the held-out day a combination qualifies with ≥ 300 trades on ≥ 100 sessions and a positive net in BOTH halves
  of that span (cut at 2022-10-23); ranked by its 5-session block range's LOWER bound.
  - **The luck check:** the same search run 20 times with the nets shuffled among the trades of each session (the day's
    market kept, the names' order broken) — the real best must clear the 95th percentile of the 20 shuffled bests.
  - **PASS only if all hold:** the real best clears the luck check; and on the held-out year the #1 combination's net per
    session is above zero, above the live rule's, with its block range above zero. The top 10 are shown held out.
- Known limits: today's names (survivors — they flatter every group, so the comparisons against the population and the
  live rule are what count); the short / dark-pool facts cover only the last three years; the report date taken as known
  in advance (§5).

**Run 2026-10-27 — FAILS, both parts.** 28,856 run-up trades 2018-12 → 2026-10 (9,495 under the live rule), 40 facts
(the short and dark-pool facts missing on ~55%, price targets on 70%). Full output: `data/lab/runup-ml.out.txt`.

- **The model.** Walk-forward AUC 2021 0.515 · 2022 0.517 · 2023 0.497 · 2024 0.502 · 2025 0.537 — pooled **0.507**
  (logistic 0.519); top third over bottom third in **1 of 5** years. Held out: AUC 0.510; top third +0.51% a session,
  bottom third +0.87%, every run-up trade +0.55%, the live rule +0.43%. Within the live rule the model's top half +0.70%
  against +0.35% — ranges overlapping, and the walk-forward does not back it. Gain went to the MARKET's facts (SPY's 5
  days, the sector's, the season) — a day's tide, not which name. Bar: AUC ≥ 0.53 ✗, 4/5 ✓, top > bottom 1/5 ✗, held out ✗.
- **Rules combined.** 79 conditions, 79,197 combinations, 20,306 qualify. The best (block low +1.18%) clears the luck
  check (shuffled bests 0.49 … 0.95, 95th percentile +0.93%) — so the search found SOME order among the names before the
  held-out day. It does not carry: **#1** (a volatile name, its sector down the week, the season beating) **−0.21%** held
  out (−1.98 … +2.24); #2 −0.49%. Of the top 10, 8 are positive held out but every range crosses zero. 7 of the 10 share
  one shape — a VOLATILE name that DIPPED the week before (rs5 / ret5 / the Friday down) while still OVER its 50-day: a
  pullback into the report. Chosen after seeing the held-out year, it is a lead to grade forward, not a rule.
- **Found on the way — the run-up itself, by year** (net per session; the live rule in brackets): 2019 −0.16 (−0.35) ·
  2020 +0.58 (+0.94) · 2021 −0.47 (−0.33) · 2022 −0.30 (+0.92, 28 sessions) · 2023 +0.05 (+0.09) · 2024 +0.41 (+0.34) ·
  2025 −0.06 (+0.34) · 2026 +0.73 (+0.33). **The live rule on 2019 → 2023-10-08, years §6 never saw: +0.02% a session**;
  from 2023-10-09 +0.38%. The run-up's edge (§6, §7) is a three-year one; on the five years before it, it is not there.

## 28. The run-up re-tested on 2019 → now (2026-10-27)

Roy agreed (2026-10-27) to re-test the run-up over the joined span before it goes live anywhere. From test K's table
(`runup_5` entries; net per session, 5-session block range):

| Group | 2019 → 2023-10-08 | 2023-10-09 → 2025-10-22 | Held out 2025-10-23 → | Whole |
|---|---|---|---|---|
| Every run-up entry | −0.11% (−0.41 … +0.22) | +0.30% (−0.01 … +0.75) | +0.55% (−0.15 … +1.37) | +0.08% (−0.12 … +0.36) |
| 3 of 3 beat, any market | −0.02% | +0.44% (+0.15 … +0.99) | +0.39% | +0.16% (−0.12 … +0.61) |
| **LIVE: 3 beat, SPY over 200d** | **+0.02%** (−0.23 … +0.43) | +0.36% (−0.02 … +0.88) | +0.43% (−0.60 … +0.90) | **+0.18% (−0.04 … +0.46)** |
| Live, calm | −0.14% | +0.11% | +0.37% | −0.01% |
| Live, stormy | +0.40% | +0.68% | +0.49% | +0.52% (+0.14 … +0.99) |

- **Over eight years the live rule no longer clears the lab's bar**: +0.18% a session, range across zero; on the four
  and a half years before §6's window it is nothing (+0.02%). §7's "the only rule with an edge" holds only on 2023-10 →.
- §6's choice of the CALM market is reversed on the longer span (calm −0.01%, stormy +0.52% and above zero). Stormy is
  read AFTER seeing the numbers — a lead for a forward check, not a rule.
- Not taken from this: the live Hotlist is unchanged; nothing here is wired into the app.
