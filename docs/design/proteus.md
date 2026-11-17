# Proteus — the technical analysis desk (design, 2026-11-12)

Part of the desk rework (`docs/design/argus-rework.md` §1: Proteus = what this stock obeys technically, per horizon;
not picking, not levels). Branch `feat/desk-architecture`. Roy's talk of 2026-11-12; decisions in §8, history depth in §9.

## 1. The job

Given a name, Proteus says **how its price behaves**, per timeframe:

| | Question |
|---|---|
| A | Which indicators it reacts to, if any — moving averages, RSI, MACD, VWAP, volume |
| B | Which price patterns it plays out, if any — flags, cup and handle, head and shoulders… |
| C | Does it false-break levels before choosing a direction |
| D | Does it respect order blocks |
| E | Its ATR (and its typical gap) |
| F | Is it a day-trade name, a swing name, both, or neither |

"Nothing" is a valid answer and an honest one: most names obey nothing in particular on most timeframes.

## 2. Two halves, side by side (Roy, 2026-11-12: "both")

**The measured profile — code.** Counted from candles, no model:

- **A. Indicators:** every touch of the 20/50/200 MA (and VWAP intraday) — how often price held / reversed vs how
  often it held at a **random level** of the same distance (the baseline). RSI extremes and MACD crosses scored by
  what followed (N bars later, in ATRs). Volume: do moves on high relative volume follow through more than ordinary
  ones.
- **C. False breaks:** breaks of prior swing highs/lows (`smc.engine` `detectLiquidity` / `swings`) — the share that
  closed back inside, and how many bars until a direction was chosen.
- **D. Order blocks:** zones from `smc.engine` `detectOrderBlocks` — of those retested, the share that held.
- **E. ATR:** `swingStructure.atr` / `priceStats.atr`, as % of price; the typical overnight gap.
- **F. Day vs swing:** from E, the volume, and how clean A/C/D come out per timeframe.

Every number carries its **sample size**, the **baseline**, and an **out-of-sample check** (argus-rework §5.2): the
rule is found in the older part of the history and must still hold in the recent part, or it is reported as not
holding. A hit rate on 6 touches is said to be 6 touches.

**The visual read — the model.** Proteus looks at the chart now (`get_chart`, `get_orderblocks`,
`get_false_breaks`): **B (patterns)** forming or just completed, and the current picture of C/D. It claims no hit
rate for a pattern. **Patterns stay by eye (Roy, 2026-11-12)** — no coded pattern detector is planned.

Proteus writes the read: the profile's numbers interpreted in plain words, with the visual read beside them, and
which is which said out loud.

## 3. Timeframes

| View | Timeframes | Feeds |
|---|---|---|
| Day trade | 5-minute, 1-hour (+ VWAP) | intraday |
| Swing | daily, weekly | short term swing, swing, long term |

## 4. Who asks (Roy, 2026-11-12: all four)

1. **Mentor, before a trade** — argus-rework §2 step 3: pick → Prometheus → **Proteus** → Mentor. Chain code, the
   same wait-in-line and Generate gate as Prometheus's read (`mentorReads.service`).
2. **The user, in chat** — Proteus is a desk you can talk to: "how does TSLA behave?"
3. **Axl hands off** — "how does TSLA behave" routes to Proteus, as research questions route to Prometheus.
4. **The day boards, automatically** — every board name at 09:20 / 10:30 / 14:30 (the measured profile; see §8.2).
5. **The Pythia chain, nightly** — Argus's house-chain picks.
6. **Daedalus** — when it exists.

## 5. The read is shared and cached

The read binds to no account (like coverage): one per name per view, the house's. Re-read **weekly** (argus-rework
§2), so a name already read this week costs nothing whoever asks. The measured profile is recomputed in code on the
same clock (cheap); the written read only when the profile changed or the week rolled.

Mentor uses the read for levels (argus-rework §2: respects the daily 20 MA → the swing stop weighs the 20 MA next to
the swing lows). Argus's when (§3.4) reads it beside Prometheus's.

## 6. Tools

Proteus gets every chart tool there is: `get_candles`, `get_indicators`, `get_price_action`, `get_chart`,
`get_orderblocks`, `get_false_breaks`, `get_cycle_analysis`, the SMC tools (`get_fvg`, `get_structure`,
`get_liquidity`, `get_key_levels`), plus a new **`get_behaviour_profile`** (§2's measured profile). Argus's chart
tools move here once Argus is fully defined (argus-rework §4).

## 7. Model and face

- **Model:** the house chat model (`houseModels.service` `chatModel`), like every desk. Per-user model choice was
  removed 2026-09-21 (one selector, the admin's); bringing it back would be a decision for all desks, not Proteus.
- **Glyph:** his own SVG in the agent set (frontend `AgentGlyphs` / `agentMeta`), a hue, an intro line.

## 8. Decided (Roy, 2026-11-12)

1. **Board names:** the MEASURED profile on every board name, automatically (code, free); the WRITTEN read only when
   a name is opened (Mentor, chat, Axl). A written read on every board name would be ~8–25 names × 3 boards a day.
2. **Where it shows:** a **badge** on the Hotlist rows — what the name obeys, in a word or two (e.g. "20 MA",
   "sweeps lows", "nothing") — opening the read.
3. **Long only, for now** — like the rest of the app. The profile counts the long side: holds at support (an MA,
   VWAP, a bullish order block), sweeps of lows that turn back up, follow-through on up-moves. The short side is a
   later switch, not a redesign.

### 8.1 Decided (Roy, 2026-11-13) — more methods, and the profile in the row

4. **Where it shows — REVISED:** not a badge. Opening a Hotlist row shows the technical profile ("How it trades") on
   the row's horizon — what holds, or what it does (its false breaks, sweep depth), its ATR, its fit, and the new tests
   below — with the way to his full read. The badge (step 5) is removed.
5. **Three more methods**, each split the way the rest is — MEASURED in code against a baseline and the recent third,
   or SEEN on today's chart with no hit rate:
   - **Price cycles** — the existing `get_cycle_analysis` only describes a cycle. The profile adds the TEST: are the
     swing lows spaced more regularly than the same returns reshuffled, found on the older two-thirds and still so on
     the recent third? Only a cycle that holds gets its next window stated.
   - **Wyckoff** — MEASURED: trading ranges found in code; springs (a sweep of the range low that closes back inside)
     and upthrusts, and volume drying up on retests, against the baseline. SEEN: the phase on today's chart
     (accumulation / markup / distribution, A–E) with its invalidation level.
   - **Elliott waves** — the COUNT is never measured (most charts admit several counts; a count fitted afterwards
     always looks right). MEASURED: do pullbacks stop at 38.2 / 50 / 61.8% more often than at random levels. SEEN: the
     current count by eye, called an interpretation, with the level that kills it — and code checks the three hard
     rules (wave 2 never retraces all of wave 1, wave 3 never the shortest, wave 4 never overlaps wave 1) so an
     impossible count is never shown.
6. **Order:** the profile in the row → cycles → Wyckoff → the Fibonacci test + the Elliott / Wyckoff chart reads → then
   Mentor weighs the read for his levels (5b).
7. **Built 2026-11-13:** the profile in the opened row (`GET /api/hotlist/profile/:symbol`, `rowProfile`; the badge removed)
   and the cycle test (`cycleTest` — cycleAnalysis's own troughs and consistency vs the same returns reshuffled 100×,
   z ≥ 3 on the older two-thirds, the recent third must still beat it; PROFILE_VERSION 5). Random walks: ≤1 in 20 hold one;
   a 20-session sine is found at ~20 with its next window. Live: NVDA, TSLA, KO, AMD — no cycle on any timeframe
   (z −2.8 … +2.4; AMD 5-minute the nearest).
8. **The false-break RATE against chance** (Roy, 2026-11-13: "how come it's always false breaks"): random walks score
   75–86% on it, so it said nothing about a stock. `falseBreakChance` compares it with the same bars in a shuffled order
   (30×, seeded; found on the older two-thirds, the recent third must agree): MORE / LESS than chance holds ("fakes its
   lows" / "breaks follow through"), else CHANCE — said so in the row, the analyst's text, the trader's line and his
   prompt. Nothing holding → the headline is the DAILY ATR. The sweep depth stays — the room a stop needs, chance or not.
   PROFILE_VERSION 6. Live: NVDA 77 vs 76, SLS, HAYW, SPCX — chance or faded on every timeframe. Next: Wyckoff.
9. **Wyckoff, measured** (built 2026-11-13, `wyckoffTest`, PROFILE_VERSION 7). A RANGE: 20 bars spanning at most 4× their
   median ATR (noise spans ~5.6), held until a close outside. Inside it, three long-side tests, older two-thirds / recent
   third like the rest: SPRINGS (a dip under the range low closed back inside within 3 bars, from the reclaim) must beat
   BOTH the drift AND an ordinary swing-low false break that is not itself a spring — the weaker verdict counts; BREAKOUTS
   (a close above the range high) against the drift; DRY-UP RETESTS (a retest of the low on volume under 70% of the
   range's average) against all retests. Plus the range it is in NOW. The UPTHRUST share (breakouts that close back inside)
   is in the analyst's text only, marked noise-level: random walks score 50–66% on it, the false-break lesson again — never
   in the row. Random walks: 0 holds across 12. Live: NVDA, SLS, KO, AMD, HAYW, SPY — nothing holds on any timeframe
   (dry-up retests are thin almost everywhere: few retests on light volume). The PHASE (A–E) stays a chart read — next,
   with the Fibonacci test and the Elliott rule check.
10. **Fibonacci measured + the Elliott / Wyckoff chart reads** (built 2026-11-13, PROFILE_VERSION 8).
   - `fibPullbackTest`: impulses = a confirmed swing low → the next confirmed swing high, ≥ 4 ATR; the pullback is
     watched from the high's confirmation until a close over the high, under the low, or 60 bars. The FIRST touch from
     above of each retracement level, with the one outcome from the level. 38.2/50/61.8% pooled, against 20/30/44/56/70/80%
     on the SAME pullbacks. Random walks: 0 of 20 hold; a staircase that turns at 61.8% does. Live (NVDA, SLS, KO, AMD,
     HAYW, TSLA): nothing holds; KO daily 78 vs 63 (z 2.1) is a near-miss, and the row says so.
   - `check_elliott_count` (services/tools/elliott.tools.js — pure, free): the three hard rules on the wave-end prices
     read off the chart, plus the price that kills the count from here (start of wave 1 at wave 2; end of wave 1 at waves
     3–4; end of wave 5 once complete — past it wave 5 is still running) and wave 5's cap when wave 3 is shorter than wave 1.
     The prompt: call it before saying or drawing any count; impossible → never shown; one chart, the tool's level only.
     The first live replay invented a kill level for a complete count — hence the complete-count level.
     THE CANDLE CHECK (Roy, 2026-11-13): the rules only see the prices given, so the tool also takes the ticker and
     timeframe and finds each wave end on the candles — a high or low within 0.5% of it, the latest fitting bars, in order;
     nothing between two wave ends past either of them; and the kill level not already crossed (for a complete count: no
     bar past wave 5's end). A failure is NOT ON THE CHART, never shown; a fetch failure is UNCHECKED, never passed. Live:
     NVDA daily — a count re-read until it passed; TSLA weekly — neither direction valid, said so, nothing drawn. The
     false-break example chart is for behaviour answers only — a chart read draws its own chart (replays showed both,
     then only the wrong one, until the rule said so where it is stated).
   - The Wyckoff phase: from the profile's range NOW, which phase it LOOKS like and the closes that prove it wrong. Live:
     SPY weekly, "Phase B, reaccumulation more plausible", range 702–779 with both invalidations.
   Next: 5b — the trader weighs the read (and the sweep depth) for his levels.
11. **5b — the trader weighs the read** (built 2026-11-13, Roy: option A; PROFILE_VERSION 9).
   - `stopRoom` measures the stop's room on the TRADER'S OWN swing lows (swingStructure's 1.5-ATR zigzag, the 20-bar ATR —
     not the small swings of the false-break count): of all breaks, the share reaching a stop 0.2 / 0.5 / 1 ATR under the
     low, and of those the share closing back above within 3 days. Live, daily: 0.2 ATR (his stop) is reached by 66–75%
     of breaks and 49–75% of those come back; 1 ATR by 22–31%, 14–39% back. NEARLY THE SAME ON EVERY NAME (NVDA, TSLA, KO,
     AMD, SLS, HAYW, JPM, SPY) — like the false-break rate, mostly how prices move, so a per-stock buffer
     (stock-playbook.md "learned per stock") would barely differ. The open question is the ONE buffer, a lab question;
     Roy chose A: the 0.2 rule stays, the stop's room is context said beside the deeper stop, never a move of the stop.
   - `levels_now`: each tested line's price at the last bar.
   - `mentorRead` → the trader's section (mentor.agent `_buildProteusSection`): a line that HOLDS priced now (it may anchor
     an entry or a stop); otherwise "nothing is support — never cite one"; the daily range now (structure, not an edge);
     Fibonacci prices of the latest impulse and the cycle's next window ONLY when they hold; the stop's room; the ATR.
     The old line "a stop under a swing low sits inside the sweep depth — use it for the stop's room" moved a tested stop
     on an untested number — removed.
   - One Axl: Mentor's per-turn sections still said PROMETHEUS'S / PROTEUS'S READ and "name him" (the name test only read
     prompt files) — now by the job, with a test over those sections.
   - Live Mentor turn (NVDA, "is the 50 MA a good stop? how much room?"): refused the 50 MA (did not hold), kept the
     structure stop, gave the stop's room as a cost; the first replay called it "the analyst's" — the section now says whose.
   Next: the Daedalus design talk.
12. **QA/CR cycle on items 7–11** (2026-11-13; two reviewers, every finding verified, Roy: "fix all"; PROFILE_VERSION 10).
   Engine: the cycle window was in CALENDAR time (20 sessions → 20 days, a week early, on a Sunday) — now how long N
   bars have taken in this history, a weekend moved to Monday; stopRoom followed a break 3 bars only — now `horizon` bars
   when it does not come back (live: 1 ATR reached 23–32%, barely moved — most deep breaks go deep at once); Wyckoff
   breakouts one per window and the next range looked for after it (one rally broke out again and again); Fibonacci
   ONE event per pullback per side, its level drawn at random (seeded — the first touch would always be the shallowest);
   dry-up retests against the NOT-dry ones; a spring's dip excluded from the sweeps within sweepBack bars; a break in the
   last bars not counted until it has had its chance; chance's shuffle from the older bars only.
   Text: ONE list of holds (`holdKeys`) for the badge, holdsOf and the trader's read — his own copy missed order blocks,
   sweeps, breakouts and chance and told him "nothing holds"; an event test (RSI, MACD, volume) is a SIGNAL, never a
   priced level; the fit is back in his read; a thin chance verdict says it cannot be told; a cycle near-miss is said as
   one; sweep depth is "how far noise pokes under a low", never "the room a stop needs" (the stop is the trader's).
   Elliott: the waves must alternate; price after the last wave end (a wave still running, wave 5 past its cap); a dead
   count said as dead, alone; the check reads years of candles (`_fetchCandleRows` `windowDays`; get_candles keeps its 40
   bars) and returns each wave end's price on the candles, which is what gets drawn; a non-list `points` is refused.
   Live: TSLA daily, candles → check → one chart at the checked prices (twice); before the order rule, two charts.

## 9. History depth (checked live, FMP, TSLA, 2026-11-12)

- **5-minute:** goes back at least a year (Nov 2025 served), but one call returns ~9 sessions (~550 bars). Three
  months of 5-minute bars = ~10 calls per name.
- **1-hour:** one call returns ~3 months (~440 bars); a year = ~4 calls.
- **Daily / weekly:** years, one call.

So the depth is there; the cost is calls. ~~The intraday bars are **kept and topped up**~~ — SUPERSEDED at build (step 3): only the PROFILE is kept, the bars are re-fetched weekly (~22 calls; see §11). Originally: the intraday bars are **kept and topped up** (the first profile pages
back ~3 months, each weekly re-read fetches only the new week) — otherwise ~25 board names × 10 calls would run
into the provider's rate limit every week. Where they are kept (a collection, its size against the 512 MB Atlas
quota) is a build decision.

## 10. The sample run (build step 2, 2026-11-12)

`scripts/proteus-sample.mjs` on 11 names (TSLA NVDA AAPL AMD PLTR SMCI JPM XOM KO IONQ SPY), 4 timeframes each,
9 tests per timeframe — **396 verdicts, 2 'respects'**: TSLA daily SMA50 (78% vs 49% shifted, n 37) and XOM
5-minute VWAP (71% vs 56%, n 167). At z ≥ 3 about 1 of 396 is expected by chance, so these two are not proof either.
Weekly is mostly 'thin' (two touches a year).

What DOES hold on every name and timeframe: **60–90% of breaks of a swing low close back above within 3 bars**.
What follows the sweep is no better than the drift — so it is a fact for STOPS (a stop just under a swing low is swept
about two times in three), not an entry signal.

Decided (Roy, 2026-11-12): **keep the bar strict.** Proteus's usual answer is "nothing technical holds on this name",
with the facts that do: ATR, the false-break rate and how far sweeps go, the gap, day vs swing. A rule that clears the
bar is reported with its numbers and the caveat that one in a few hundred tests passes by chance.

Seen, not fixed: the 1-hour VWAP baseline runs high on fast names (AMD 92%) — the shifted-down copies sit several
hourly ATRs away (the hourly ATR carries overnight gaps), so they are touched only in sharp drops, which bounce. It
makes the 1-hour VWAP test conservative, not generous.

**Re-run after the code review (2026-11-12, same 11 names):** the rule is now FOUND on the older two-thirds alone and
checked on the recent third (it had been tested on the whole history — a recent-only edge could confirm itself);
order blocks counted only once known, shifted in % and spaced; the drift baseline sampled a window apart; every
unbroken swing low tested for a false break. **0 of 396 tests hold.** TSLA's daily 50 SMA is the clearest near-miss:
80% vs 45% on 20 older touches (z 2.72) and 77% vs 58% on 17 recent ones — strong, but 5 years of daily bars give too
few touches to reach z 3 on two-thirds of them. JPM's daily 50 SMA (87% vs 59%, z 2.39) is the other. False breaks:
69–79% of breaks of a swing low close back above within 3 bars, on every name; sweeps go a median ~0.25 ATR under the
low, 80% within ~0.5 ATR (SPY 0.37 / 0.84).

**Decided (Roy, 2026-11-12): the daily view reads all ~10 years** it already fetches (PROFILE_VERSION 3). Re-run: still
**0 of 396**, and the TSLA near-miss is GONE — on the older two-thirds of 10 years (2016–2022) its 50 SMA is 66% vs
66%: the edge seen above lives only in recent years. More history adds touches, but also older regimes the stock no
longer trades like — the daily test now asks "did it hold for most of a decade AND lately". A rule that appears
recently shows as no edge, not as faded. If that proves too slow to catch a change, the alternative is a separate
recent-only read (e.g. the last 3 years, reported as "lately", never as a rule) — not built.

### 10.1 The false breaks across the whole universe (declared 2026-11-14, before the run)

Roy: "Proteus identifies false breaks / sweeps in a lot of stocks — let's check it." The 23 profiles cached say 65–90%
of breaks are false on every name — and wherever the chance test ran, "chance"; a sweep leading higher, "no" everywhere.
`scripts/lab-proteus-sweeps.mjs` runs Proteus's own engine (`falseBreaks`, `falseBreakChance`, `judge`, PROFILE as built)
on every name at once, with noise run through the identical pipeline beside it:

- **Daily, per name:** the screener's 1,177 names, their ~4 years of daily bars (`data/lab/screener-3y.json`, 2022-09 →
  2026-10 — shorter than the profile's 10 years). Per name the false-break verdict against chance (`more` · `less` ·
  `chance` · `faded` · `thin`) and the sweep verdict against the drift (`respects` · `faded` · `unconfirmed` · `no` · `thin`).
  **The control:** each name's bars shuffled once (`_shuffledBars`' rule, seeded), the same pipeline — how many names
  noise alone flags.
- **Pooled, daily and 5-minute:** every name's sweep outcomes together against every name's drift — the one test with the
  numbers to see a small edge — split older / recent (by date, 2026-03-01 like tests 4–4d), with the shuffled control. The
  5-minute from test 4's cache (3,185 name-weeks of about ten sessions each, regular hours), per week.

**PASS — false breaks / sweeps are a trait Proteus should report as one:** the real data flags more names than the
shuffled control (`more` false breaks, or sweeps `respects`) by a clear margin — at least twice as many and at least 10 more
— AND the pooled sweep win rate beats the pooled drift by ≥ 3 points with the 95% interval above 0, older and recent.
Otherwise the profile's "nothing holds" on false breaks stands, and the 70–80% rate stays said as what noise does.

**Result (2026-11-14): FAIL — false breaks are everywhere because noise makes them; sweeps lead nowhere.**
`data/lab/proteus-sweeps.out.txt`.

- **The rate is real and universal, and it is noise's:** across 1,132 names the median false-break rate is 75.6% (middle
  half 72–79%). Against each name's own bars shuffled: chance on 1,100 names. Flagged `more` false than chance: 4 (ADI BMNR
  MXL BULL) and `less`: 4 (ALB CLSK HYMC VSTM) — against 1 and 2 on the shuffled bars. At z 3 two-sided about 3 of 1,132
  are expected by luck; 8 is not "a lot of stocks", and not twice-and-10-more.
- **A sweep leading higher: 0 names** (`no` 1,077, `thin` 55) — and 0 on the shuffled bars.
- **Pooled, daily:** sweeps won 48.3% vs the drift's 47.1% in the older years (+1.2 points, 95% +0.6 … +1.8) and 45.8% vs
  47.1% recently (−1.3, −2.6 … +0.1) — an edge that did not last, and under the 3-point bar anyway.
- **Pooled, 5-minute** (3,169 name-weeks, ~75,000 sweeps): 43.4% vs 43.9% older, 43.4% vs 43.8% recent — none.
- **So the profile is right as it stands:** "breaks of a swing low are false ~75% (chance: ~75%)" is a fact about NOISE —
  useful for the stop (a stop just under a swing low is swept about three times in four), never a trait of the name and
  never an entry. Tests 4d (intraday sweep entries) said the same with trades.

### 10.2 Ten combinations (declared 2026-11-16, before the run)

Roy: "what about combinations of patterns and indicators and both? … let's pick 10 — you pick." Picked BEFORE looking,
each one a trader would name — no search over pairs (66 pairs × 4 timeframes would pass something on every name by luck).
`scripts/lab-proteus-combos.mjs`, Proteus's own engine (PROFILE as built), long side.

**The parts** (all known at the event bar's close): T20 / T50 / T200 — a touch from above of the 20 EMA / 50 SMA / 200
SMA (`levelTouches`' rule); UP200 — the close over the 200 SMA; STACK — 20 EMA > 50 SMA > 200 SMA; VOL — volume ≥ 2× its
20-bar average; VUP — VOL on an up bar; SWEEP — a false break of a swing low, at the reclaim (`falseBreaks`); RSI30 — RSI 14
crossing under 30; MACD↑ — the MACD line crossing up through its signal; FIB — the first touch from above of 38.2 / 50 /
61.8% in a pullback (`fibPullbackTest`'s pullbacks); SPRING — a Wyckoff spring at its reclaim (`wyckoffTest`).

| # | Combination | Part A alone | Part B alone |
|---|---|---|---|
| 1 | T50 + UP200 (a pullback to the 50 in an uptrend) | T50 under the 200 | bars over the 200 |
| 2 | T20 + STACK (a pullback to the 20 in a stacked trend) | T20 not stacked | stacked bars |
| 3 | T200 + VOL (the 200 tested on heavy volume) | T200 on ordinary volume | VOL bars off the 200 |
| 4 | any MA touch on a VUP bar (a touch that closes up on 2× volume) | touches without VUP | VUP bars off any MA |
| 5 | SWEEP + VOL on the break or reclaim bar (stops run on volume) | sweeps on ordinary volume | VOL bars, no sweep |
| 6 | SWEEP + UP200 (a sweep in an uptrend) | sweeps under the 200 | bars over the 200 |
| 7 | RSI30 + UP200 (oversold in an uptrend) | RSI30 under the 200 | bars over the 200 |
| 8 | MACD↑ under the zero line (the turn from a decline) | MACD↑ over zero | bars with MACD under zero |
| 9 | FIB within 0.25 ATR of the 20 EMA or 50 SMA (two levels agree) | FIB away from both | T20/T50 not at a FIB level |
| 10 | SPRING on light volume (dip bar under 70% of the range's average) | springs on ordinary volume | ordinary sweeps (not springs) |

**The one outcome, everywhere:** from the event bar's close, +1 ATR before a close 0.5 ATR lower within 10 bars; one event
per 10 bars. **A combination must beat Part A alone, Part B alone AND the drift** — three `judge` verdicts, the weakest
counts (the spring's rule). Each part's events exclude the combination's own, so the baselines are not the combination.

- **Per name, daily:** the screener's 1,177 names, ~4 years each (`data/lab/screener-3y.json`, 2022-09 → 2026-10 —
  shorter than the profile's 10; the 200 SMA eats the first ~10 months). Per combination, how many names come out
  `respects`. **The control:** each name's bars shuffled (the engine's own `shuffledBars`), the same pipeline.
- **Pooled, daily and 5-minute** (test 4's cache, ~3,185 name-weeks): every name's combination events against every
  name's Part A, Part B and drift, split older / recent by date (2026-03-01), with the shuffled control.

**PASS, per combination — either one is a candidate for the profile:**
- **A trait of some names** (Roy: "each ticker behaves individually"): real names `respects` at least 2× the shuffled
  count AND at least 10 more.
- **An edge everywhere:** pooled, the combination beats its STRONGEST baseline by ≥ 3 points with the 95% interval above 0,
  older AND recent.
Otherwise it stays out. Expected limit, said now: on 4 years most names will be `thin` on most combinations.

**Result (2026-11-16): FAIL — no combination passes.** `data/lab/proteus-combos.out.txt`.

- **Per name, daily: `thin` on every combination, on ~all 1,132 names** — on 4 years a combination happens ~5–15 times a
  name; the bar needs 15 in the older two-thirds. So this run CANNOT answer "per ticker" for combinations; only the
  profile's 10 years could, and only for the common ones (1, 2, 6, 8, 9). Shuffled: the same.
- **Pooled, daily:** none beats its strongest baseline (−3.2 … +2.0 points, every interval across 0 or under it). Two do
  WORSE than their parts: a sweep on 2× volume (−3.2 older, −5.8 recent) and a spring on light volume (−2.8 / −2.1).
- **Pooled, 5-minute — two near-misses, under the 3-point bar** (both periods, interval above 0, ~0 on shuffled bars):
  **7. RSI under 30 over the 200 SMA** +3.5 [+1.8 … +5.2] older, +2.6 [+0.7 … +4.6] recent; **3. a 200 SMA touch on 2×
  volume** +2.7 [+1.2 … +4.3], +2.4 [+0.4 … +4.3]. Three months of 5-minute bars; a 2–3 point edge is small beside
  intraday costs. Leads for the intraday lab, not rules. Every other one: none; the light-volume spring −4.4 / −2.6.
- Seen, not fixed: combination 9's Fibonacci touches keep a bar that slices straight through the level (the engine's
  test drops it) — a handful of events; it scored −0.5 / −0.3, nowhere near the bar either way.

### 10.3 Lines as stops, per name (declared 2026-11-16, before the run)

Roy: "each ticker behaves individually — check stops in the same manner Proteus checks reaction to patterns." Decided
(Roy, 2026-11-16): **a line that passes, Mentor takes into consideration** for the stop. One setting, Mentor's own: the
stop 0.2 ATR under the line. `scripts/lab-proteus-stops.mjs`.

- **Anchors** (each a level known at the bar BEFORE the event): SWING — the latest confirmed swing low of Mentor's own
  swings (swingStructure, 1.5 ATR); EMA20, SMA50, SMA200; RANGE — the low of the Wyckoff range price is in; FIB618 — the
  61.8% level of the pullback under way; OB — the bottom of the latest known bullish order block under price; VWAP
  (5-minute only).
- **Event — the stop is hit:** the previous close over the anchor, this bar's low under anchor − 0.2 ATR. One per 10 bars.
- **Outcome — was it a good stop?** GOOD: a low 1 ATR past the stop (anchor − 1.2 ATR) before any close back over the
  anchor — the line broke for real and the stop saved the trade. BAD (whipsaw): a close back over the anchor first — the
  hit bar's own close included (checked first, like the engine's bracket). Neither within 10 bars: counted, not good.
- **Baseline:** the same anchor shifted ±2 and ±3 median ATRs (`levelTest`'s baseline) — a stop the same way under a
  line that is not this one. `respects` = this line is a better stop than a line next to it, on this name.
- **Per name daily, pooled daily and 5-minute, shuffled control, PASS** — exactly §10.2's rules. Beside it, said not
  judged: each anchor's whipsaw share.
- **If an anchor passes:** it goes into the profile's per-name stop test and Mentor weighs it when placing the stop.
  If none does, Mentor's 0.2 ATR under the swing low stays as it is, with the stop's room as context (5b, option A).

**Result (2026-11-16): FAIL — no line is a better stop than a line next to it, per name or pooled.**
`data/lab/proteus-stops.out.txt`.

- **Per name, daily — here the question COULD be answered** (unlike the combinations: SWING, EMA20 and OB were `thin` on
  only 4–8% of names): `respects` on SWING 0 (shuffled 0), EMA20 1 (1), SMA50 1 (0), OB 4 (1: OBDC OLN QUBT FFBC), SMA200 /
  RANGE / FIB618 0. At z 3 about 1–2 of 1,132 are expected by luck; the bar was 2× the shuffled and 10 more. **Nothing
  says a ticker has a line of its own that makes a better stop** — Roy's hypothesis, tested on ~1,100 names, not seen.
- **Pooled:** only about 36–40% of daily stop hits are GOOD (1 ATR more before a close back over the line) on EVERY
  line — ~6 in 10 are whipsaws or go nowhere, whatever the line. The swing low (Mentor's own) is a touch better than the
  shifted copies: daily +2.2 [+1.5 … +2.9] older, +0.8 recent; 5-minute +2.2 / +1.1 (shuffled +0.6 / +0.7) — real and small,
  under the bar. The 5-minute Wyckoff range low is the nearest miss: +3.4 [+2.9 … +4.0] older, +2.2 [+1.6 … +2.9] recent,
  shuffled ~0.
- **A worse stop:** the 5-minute 20 EMA, −3.5 / −3.9 points (shuffled −0.8 / −1.1) — a stop under the 20 EMA intraday is
  whipsawed more than one off it. VWAP −0.9 / −0.5.
- **So:** nothing goes into the profile's per-name stop test; Mentor keeps 0.2 ATR under his swing low (the one anchor
  that is slightly better than a line beside it), with the stop's room as context (5b, option A). For intraday the
  nearest leads are the range low (better) and the 20 EMA (worse), both for the intraday lab.

### 10.4 Indicator values, per name (declared 2026-11-16, before the run)

Roy: "what about different values of indicators and atr" → 3 (the stop depth first — stock-playbook.md Test 5, FAIL —
then the values). Proteus tests ONE value of each method (`PROFILE` — "nothing holds" means at those settings). Here
each name may pick its own value, honestly: the older two-thirds choose, the recent third checks only the chosen one, and
each name's SHUFFLED bars run the identical search — the search's luck lands on both sides.
`scripts/lab-proteus-values.mjs`, Proteus's engine as built (PROFILE, `judge`, `levelTest`, `eventOutcomes`), long side.

- **Data:** the screener's names, ~10 years of daily bars each (`data/lab/screener-10y.jsonl`, 2016-10 → 2026-10, fetched
  for this — the profile's own daily depth). Daily only.
- **The families (fixed now):**
  1. **MA as support** — a touch from above against the same line shifted ±2/±3 ATR (`levelTest`): EMA and SMA × 10 /
     20 / 50 / 100 / 200 (10 values).
  2. **MA as a stop** — §10.3's test (a stop 0.2 ATR under the line; GOOD = 1 ATR more before a close back over) against
     the shifted line: the same 10 values.
  3. **RSI oversold** — RSI period 2 / 7 / 14 crossing under 10 / 20 / 30, against the drift (9 values).
  4. **Volume up bar** — volume ≥ 1.5× / 2× / 3× its 20-bar average on an up bar, against the drift (3 values).
  5. **Swing size as a stop** — §10.3's swing-low stop on Mentor's swings at 1 / 1.5 / 2 / 3 ATR (4 values).
- **Per name, per family:** every value judged; the one with the largest older-part edge (rate − baseline) among those
  not `thin` is the name's value, and ITS verdict counts (`judge`: edge ≥ 10 points at z ≥ 3 on the older part, the
  recent third still ≥ 5 points). Shown: which value names pick, real vs shuffled.
- **PASS, per family — "this ticker has its own value":** real names `respects` ≥ 2× the shuffled AND ≥ 10 more. Then the
  family's per-name value goes into the profile and Mentor takes it into consideration (Roy, 2026-11-16). Beside it,
  not for the bar: each value pooled over all names, before / after 2026-03-01.

**Result (2026-11-16): FAIL on all five — no ticker has a value of its own beyond luck.**
`data/lab/proteus-values.out.txt`. 1,133 names, median 10.0 years.

- **Ten years answered it:** `thin` on only 2–4% of names (it was ~all on 4 years). Real `respects` vs shuffled:
  MA as support 3 vs 4 · MA as a stop 6 vs 5 · RSI oversold 1 vs 1 · volume up bar 0 vs 1 · swing size as a stop 2 vs 1.
  The bar was 2× and 10 more; at z 3 with the search, a handful a family is what luck gives — and the shuffled bars give
  as many.
- **The value names pick is spread like chance:** e.g. MAs as support — real sma200 145 · sma100 141 · ema200 136 …
  ema10 44; shuffled sma200 149 · ema200 138 · ema100 132 … ema10 56. The order follows how often each line is touched
  (a slow line is touched rarely, so its rate swings further), not the stock.
- **Pooled, nothing either:** every MA as support at or UNDER its shifted copies (−3.2 … 0 points older); as a stop,
  +0 … +1.5 points; RSI and volume bars under the drift in the older years; Mentor's swing size the same at every k
  (+1.5 … +2.7 points older, ~0 recent).
- **So:** Proteus keeps its one value of each method; the per-name profile does not choose values. Together with §10.3
  and stock-playbook test 5: on ~1,100 names, neither the line, the value nor the stop's depth is a trait of a stock.

### 10.5 The moves backwards — one company (declared 2026-11-16, before the run)

Roy: "find the movements · look at the chart · how they started · is there a common thing — let's try one company".
The other way round from §10.1–10.4: start from the MOVES and look back at the bar each began on. A DESCRIPTION of one
name (LNG, ~10 years daily, `data/lab/screener-10y.jsonl`), not a test — what it finds is a candidate for a declared
test across names. `scripts/lab-proteus-moves.mjs`.

- **A move:** from a bar's close, the high reaches +4 ATR within 20 bars before any close 1 ATR under that close. Bars
  that qualify within 20 bars of each other are ONE move; it STARTS on the one with the lowest close.
- **The facts at the start's close (fixed now, all known on that bar):** a swept swing low (low under the latest 2-bar
  swing low, close back above, in the last 3 bars) · a new 60-bar closing low in the last 3 bars · ≥ 3 ATR under the
  20-bar high close · RSI 14 under 30 in the last 3 bars · 3+ down closes running · close over the 200 SMA · over the
  50 SMA · within 0.5 ATR of the 50 or 200 SMA · volume ≥ 2× its 20-bar average · volume dried up (5-bar average under
  0.7× the 50-bar) · ATR squeezed (under 0.8× its 100-bar median) · a tight 10 bars (range under 3 ATR) · a gap down
  ≥ 0.5 ATR · a reversal bar (closes up, in the bar's top third) · SPY over its 200 SMA · SPY ≥ 5% under its 20-day high.
- **Why a fact found before moves is not enough:** each is counted at the starts AND on every bar. Shown: its share at
  the starts, its share on all bars, the LIFT (the ratio), and the forward rate — of the bars with it, how many began a
  move, against all bars. Older two-thirds and recent third apart; and LNG's own bars SHUFFLED (20 seeds) run the same
  count — a fact whose lift the shuffled bars give as well is chance (the SPY facts have no shuffled side).
- **A candidate for a test across names:** lift ≥ 1.5 in the older two-thirds AND the recent third, ≥ 10 starts with
  it in the older part, and the older lift over the shuffled bars' 95th percentile. Nothing goes into the profile from
  one name.

**Result (2026-11-16, LNG): no candidate.** `data/lab/proteus-moves-LNG.out.txt`. 2,513 bars, 31 moves (+8% … +52%).

- **The common thing is that a move starts at a low:** at the starts, 3+ down closes (53% vs 15% of bars, older), a new
  60-bar low (32% vs 7%), ≥ 3 ATR under the 20-bar high (32% vs 12%), under the 50 SMA (79%); never on an up bar.
  That is the definition — a move starts on its lowest close — not a sign: of the bars that HAD those facts, no more
  began a move than of any bar (9–21% vs 18%). LNG's shuffled bars show the same facts at their starts with lifts as
  high or higher (shuffled 95th 4.2–7.6), and as many moves (29 a run vs 31).
- **Nothing cleared the bar.** The few facts with a better forward rate are a few dozen bars (volume ≥ 2× in the recent
  third: 29% vs 19%, n 28; at the 50/200 SMA in the recent third, 23% vs 19%) and did not hold in the older part.
- **So:** looking back from LNG's moves shows the lows they started from, which every chart has; nothing on the start
  bar told them apart from the bars that went nowhere.

### 10.6 The pullback before an event — one company (declared 2026-11-16, before the run)

Roy: "my next step was to connect it to another event — technical or fundamental". §10.5's common thing (a move starts
at a low) is a GATE, not a sign; a rarer event may pick which low. The first event: EARNINGS. Same name (LNG), same
moves and bars as §10.5; the dates from `data/lab/screener.extras.json` (`history`, 40 reports 2017-02 → 2026-10).
`scripts/lab-proteus-moves-event.mjs`.

- **The gate — a pullback:** 3+ down closes running, OR ≥ 3 ATR under the 20-bar high close, OR a new 60-bar closing
  low in the last 3 bars (§10.5's three facts at the starts).
- **The windows:** BEFORE = the 20 bars before a report's date (its bar left out: the report is not known yet);
  AFTER = the report's bar and the 19 after it (beside it, for the drift after the report).
- **Counted:** (a) of the moves, how many started in each window, against the share of all bars in it (the lift);
  (b) the forward rate — of the bars with the gate in the window, how many began a move, against the gate anywhere,
  the window without the gate, and every bar; (c) ONE entry a report — the first gate bar of its BEFORE window: how
  many began a move; and the same on LNG's shuffled bars (20 seeds; the report dates stay, the prices are shuffled).
  Older two-thirds and recent third apart.
- **A candidate for the test across names:** the gate-in-the-window forward rate ≥ 1.5× the gate anywhere, older AND
  recent, ≥ 10 one-a-report entries in the older part, over the shuffled bars' 95th percentile. Forty reports on one
  name is a look, not a result.

**Result (2026-11-16, LNG): no.** `data/lab/proteus-moves-event-LNG.out.txt`.

- **(a) Moves did not gather before reports:** older 8 of 19 started in a BEFORE window (42% vs 31% of bars), recent
  0 of 8; AFTER 6 of 19 and 1 of 8 (vs 32%).
- **(b) A pullback before a report began a move as often as any bar:** older 19% vs 18% (every bar) and 17% (a pullback
  anywhere); recent 15% vs 19%. Not on the declared list but there to see: before a report WITHOUT a pullback, older
  28% (97/350) — the opposite of the idea, and recent 17%.
- **(c) One entry a report:** older 5 of 17 (29%; shuffled bars median 17%, 95th 40%), recent 2 of 11 (18%; shuffled
  median 25%).
- **The June 2026 low was not in the window:** the 2026-06-18 move started 34 bars before the 2026-08-06 report; that
  report's first pullback in its 20 bars (07-28) went +12%, under the +4 ATR bar.

### 10.7 The chain backwards — one company, the moves only (declared 2026-11-16, before the run)

Roy: "1. look for moves at the daily chart · 2. what led to the moves — technical · 3. if there is something in
common, what led to the thing that led to the move — technical or fundamental · 4. what led to that, and so on" —
"for now I don't care about days that a move didn't start"; "the steps after the first can be technical from the
chart too". So a DESCRIPTION of the moves alone, link by link — no bars without a move beside it (Roy's call for now;
§10.5 showed why a link needs that before it is traded). LNG, §10.5's moves. `scripts/lab-proteus-moves-chain.mjs`.

- **Link 1 — the move** (§10.5).
- **Link 2 — the pullback it started from:** the high = the highest close of the 60 bars before the start; its depth
  (% and ATR), its length (bars), where it ended against the 50 and 200 SMA.
- **Link 3 — what led to the pullback, at and just after the high (the chart):** a run into the high (the 20 bars
  before it, ATR) · the high a new 250-bar high · RSI 14 over 70 at the high · stretched (≥ 3 ATR over the 50 SMA) ·
  climax volume at the high (≥ 2× the 20-bar average) · a failed breakout (the high over the prior 60-bar high, a close
  back under it within 5 bars) · a hard start (a gap down ≥ 1 ATR or a down day ≥ 2 ATR within 3 bars after the
  high). Beside them: SPY over the same span, and a report between the high and the start.
- **What counts as common:** a fact on at least two-thirds of the moves, in the older two-thirds AND the recent third.
  It becomes link 3, and link 4 is asked of it the same way.

**Result (2026-11-16, LNG): link 3 = a failed breakout.** `data/lab/proteus-moves-chain-LNG.out.txt`. 26 moves with
310 bars behind them (18 older, 8 recent).

- **Link 2, the pullback:** ≥ 2 ATR on 94% / 100%, ending under the 50 SMA on 78% / 88%. Median −12.3% (4.4 ATR) over
  45 bars — slow pullbacks, not quick dips (≤ 20 bars on only 17% / 38%).
- **Link 3, the high it fell from:** a NEW 60-BAR HIGH THAT REVERSED on 67% / 75% — the high closed over the prior
  60-bar high and a close was back under THAT within 5 bars. **Corrected the same day: not a failed breakout.** The
  prior 60-bar high at the top is the close just before it, so any top dips under it. Against the level the breakout
  first broke (link 4's breakout): it ran a median 3.4 ATR further before the top; 14 of the 18 closed back under that
  level, but 4–61 bars after the breakout (median ~16), and 4 never did. Near it: stretched ≥ 3 ATR over the 50 SMA 61% / 75%; a run of ≥ 3 ATR into
  the high 50% / 50%. Not common: a 250-bar high, RSI over 70 (both ~45–50%), climax volume (6% / 0%), a hard start
  (6% / 25%), SPY down (50% / 50%), a report in the pullback (61% / 50%).
- **The chain so far:** a breakout to a new 60-bar high runs ~3 ATR on, tops → a slow pullback of ~4 ATR under the 50
  SMA → the move. Described on the moves alone (§10.7); how often the same chain runs without a move is not counted.

**Link 4 — what led to the failed breakout (declared 2026-11-16, before the run; Roy: "yes").** The moves whose link 3
is a failed breakout. The breakout = the FIRST close over the prior 60-bar high in the 20 bars up to the high. At it:
- **the base:** bars since that prior 60-bar high was set (how long it stayed under it); the 40 bars before the
  breakout spanning < 6 ATR (a tight base); a run of ≥ 3 ATR in the 20 bars into it (off a run, not a base);
- **the breakout bar:** volume ≥ 1.5× its 20-bar average; a gap up ≥ 0.5 ATR; a bar ≥ 1.5 ATR; over the 200 SMA;
- **how far it got:** the best close over the old high, in ATR — a shallow breakout ≤ 1 ATR;
- **beside it:** a report in the 5 bars before the breakout (beat / miss); SPY up over the 20 bars into it; SPY at a
  60-day high on the breakout day too.
Common = on ≥ two-thirds of those moves, older AND recent (§10.7's rule).

**Link 4 result (2026-11-16, LNG): only what comes with any breakout.** 18 moves (12 older, 6 recent) — 16 breakouts:
two pairs of moves fell from the same top. Common: over the 200 SMA (92% / 100% — near-automatic at a new 60-bar high)
and SPY up over the 20 bars into it (67% / 67%). Not common: a tight base (50% / 33%), off a run (42% / 33%), volume
≥ 1.5× (25% / 33%), a gap up (8% / 17%), a report in the 5 bars before (0% / 33%), SPY at its own 60-day high
(33% / 33%), a shallow breakout (8% / 0%). The breakouts were of both kinds — out of a ~60-bar base (2018–2020) or
straight off the last high (2021, 2024–26). Median: 9 bars under the old high, a 6.6-ATR base, a 2.7-ATR run in.
The chain on LNG's chart ends here: link 4 is an uptrend in a rising market, which says nothing particular.

**Name by name (declared 2026-11-16, before the run).** Roy: "my vision is this process for each name individually —
each name's behaviour is different". The same chain, unchanged, on eleven very different names, side by side: LNG ·
NVDA · TSLA · SMCI · ENPH · CELH (fast, volatile) · KO · PG · DUK (slow, defensive) · JPM · XOM. The question: do the
chains DIFFER by name? If every name shows the same chain, it is how stocks move, not a name's own behaviour; if
they differ, the per-name chain is worth building into Proteus. `node scripts/lab-proteus-moves-chain.mjs LNG NVDA …`
→ each name's file and `data/lab/proteus-moves-chain-summary.out.txt`.

**Result (2026-11-16): the chains do not differ — the same chain on all eleven.** 26–35 moves a name.
- **Link 2 on every name:** a pullback of ≥ 2 ATR (86–100%) ending under the 50 SMA (72–100%). Only its SIZE differs,
  and by the kind of stock: median −8% (KO, PG, DUK) … −25 to −29% (TSLA, SMCI, ENPH, CELH) — in ATR, 4.4–7.0 on all.
- **Link 3:** a new 60-bar high that reversed — common on LNG (67/75%) and KO (68/70%), near it on most (PG 83/62,
  DUK 73/62, NVDA 65/75, XOM 61/58); a run of ~3–4 ATR into the high and RSI ~63–70 at it on every name.
- **Link 4 on every name:** over the 200 SMA and SPY up into the breakout — an uptrend in a rising market.
- **Name by name the differences are of degree, not of chain:** NVDA's pullbacks came with SPY falling (71/75%); ENPH's
  breakouts off a run (69/100%); LNG's pullbacks the slowest (median 45 bars vs 24–43).
- **So:** described on its moves alone, every name's chain is the same: up into a new high, a slow pullback of 4–7 ATR
  under the 50 SMA, the move. That is how stocks move, not a name's own behaviour; a per-name chain built on these
  facts would read the same for every name. What does differ is size and pace, which the ATR already carries.

**Patterns, order blocks and indicators at every link (declared 2026-11-16, before the run).** Roy: "did you check
patterns / order blocks / indicators for every step?" — no: the links above used a short list. The same moves, links
and eleven names, now with Proteus's own detectors (`smc.engine` order blocks and swings, `wyckoffTest` ranges and
springs, the monitor's EMA / SMA / RSI / MACD). `scripts/lab-proteus-moves-patterns.mjs`. Common = §10.7's rule.
- **At the low (the start bar; "near" = it or the 3 bars before):** at a bullish order block (a known block's zone —
  formed within 250 bars — reached by a low, not sliced 0.5 ATR under) · a swept 2-bar swing low (closed back above
  within 3 bars) · a Wyckoff spring (its dip near the low) · inside a Wyckoff range · the pullback retraced 38.2 / 50 /
  61.8% (± 5 points) of the run into the top (from the lowest close of the 60 bars before it) — and the median depth ·
  at the 200 SMA (a low within 0.5 ATR) · MACD under zero · MACD histogram turning up on the start bar · a MACD cross
  up near it or in the 3 bars after · RSI bullish divergence (a lower close than the lowest of 40–5 bars before, a
  higher RSI) · MACD bullish divergence (the same on the MACD line) · a double bottom (a low 10–60 bars before within
  0.5 ATR, ≥ 2 ATR up between) · a hammer or a bullish engulfing on the start bar or the next.
- **At the top (it ± 3 bars):** at a bearish order block (a known block's zone reached by a high, not cleared 0.5 ATR
  over) · a swept 2-bar swing high (closed back under within 3 bars) · a MACD cross down in the 5 bars after · RSI
  bearish divergence · MACD bearish divergence (as above, on highs) · a double top · a shooting star or bearish
  engulfing on the top or the next bar.
- **At the breakout (it and the 20 bars before):** a Wyckoff range breakout (a range ended by a close over it within 3
  bars of the breakout) · a bullish order block retested in the 20 bars before · a swept swing low in them · MACD over
  zero · a MACD cross up in the 10 bars before · 20 EMA over the 50 SMA · RSI over 60.
- Left out, said so: head-and-shoulders, flags and wedges — no detector in the app, and drawn by eye they are not a
  count.

**Result (2026-11-16): the same on every name again; what is "common" is the detector, not the stock.**
`data/lab/proteus-moves-patterns.out.txt`.
- **Common on all or nearly all eleven:** at the low a bullish order block (70–100%), a double bottom (70–100%), MACD
  under zero (10 names); at the top a bearish order block (9) and a double top (8); at the breakout a bullish OB
  retested in the 20 bars before, MACD over zero, the 20 EMA over the 50, RSI over 60 (all 11).
- **Those fire on almost any bar.** `detectOrderBlocks` finds 400–530 blocks in ten years (every fair-value gap makes
  one), so 85–93% of ANY bar of LNG, KO and TSLA sits at a bullish or bearish block; the double bottom / top (0.5 ATR,
  10–60 bars) fires on 67–83% of any bar. The breakout's four come with the definition — a new 60-bar high after a
  run has MACD over zero and RSI over 60. Checked on every third bar from bar 400, the scratch count only; not a
  comparison of outcomes.
- **The selective ones are on no name's two-thirds:** Wyckoff springs (0–50%), Fibonacci 38.2/50/61.8 (10–44%), RSI /
  MACD divergence (0–88%, never both parts), a MACD cross up at the low (11–64%), the 200 SMA (7–38%), hammer /
  engulfing (7–50%), shooting star / engulfing at the top (6–47%), a Wyckoff range breakout (17–75%).
- **One difference by name, of degree:** the pullback's depth as a share of the run into the top — median ~58% on LNG
  and NVDA, 66% on PG and JPM, 72–80% on SMCI, ENPH, CELH and KO, ~95% (the whole run given back) on TSLA, DUK and XOM.
- **So:** with patterns, order blocks and indicators at every link, the chain still reads the same for every name. A
  detector loose enough to be on two-thirds of the moves is on most bars of any chart; the tight ones are on no name's
  moves. Proteus's detectors as built are too loose to mark a name's own chain (the order-block count most of all).

**Tightened detectors (declared 2026-11-16, before the run; Roy: "tighten the detectors — fundamentals later").** In
the lab only (`--tight`); the engine's detectors stay as built until a tight one earns its place. Same moves, links,
names.
- **Order block, tight:** a block (as `detectOrderBlocks`) that (1) DISPLACED — the close 3 bars after the block bar
  ≥ 1.5 ATR beyond its zone; (2) is NARROW — zone ≤ 1.5 ATR; (3) is RECENT — formed ≤ 120 bars before; (4) is FRESH —
  the bar is its FIRST touch since it was known (no bar traded into the zone before). Bullish at the low and before the
  breakout, bearish at the top.
- **Double bottom / top, tight:** the earlier extreme a 2-bar swing, 15–60 bars before, within 0.25 ATR; ≥ 3 ATR the
  other way between; the anchor's bar the extreme of its ± 2 bars.
- **How loose each detector is, beside it:** the share of ANY bar it fires on (every third bar from bar 400, LNG / KO /
  TSLA). Over 30% is marked LOOSE — a calibration of the detector, not an outcome. The others as before.
- Common = §10.7's rule.

**Result (2026-11-16): tight, they are rare — and then on no name's moves.** `data/lab/proteus-moves-patterns-tight.out.txt`.
- **Order blocks, tight:** from 85–93% of any bar to 4% (bullish, at the low) and 9% (bearish, at the top). On the
  moves: at the low 0–33% a name, at the top 0–25%, retested before the breakout 0–46% — on no name's two-thirds.
- **Double bottom / top, tight:** from 67–83% of any bar to 9% / 15%. On the moves 0–38% / 0–32% — on none.
- **What is still common is loose or comes with the definition:** MACD under zero at the low (40% of any bar; a
  pullback under the 50 SMA has it), MACD over zero and the 20 EMA over the 50 at the breakout (60%), RSI over 60 at
  it (27%, but a new 60-bar high after a run has it), a swept swing high at the top (42%, common on TSLA, DUK, XOM)
  and a swept swing low before the breakout (73%, on SMCI, DUK, JPM, XOM).
- **The one selective fact common on a few names:** a MACD cross down within 5 bars after the top (24% of any bar) —
  LNG 83/75%, PG 72/69%, XOM 72/67% (NVDA 88/58% just misses). After a top momentum turns down, so it says little.
- **So:** loose, the detectors are on every chart; tight, they are on few moves of any name. Neither marks a name's
  own chain. On these eleven names the chart has given what it has: the same chain everywhere, its size and pace the
  name's own (the ATR, the pullback's depth). Next, as Roy said: fundamentals at the pullback link.

### 10.8 Size and pace, on every name (BUILT 2026-11-16)

Roy: "so size and speed might be the individual behaviour we are looking for … we will run it from now on on each
name"; "if a stock is for day trade, the same check on the lower timeframe — maybe 15-minute is better than 5-minute"
→ option 2: the 15-minute BESIDE the 5-minute, for size and pace only, until the steadiness says which to keep.
"Mentor later" — his read does not use it yet.

- **Engine — K, `movesProfile`** (`behaviourProfile.engine.js`): on every timeframe, §10.5's moves (+4 ATR on a high
  within 20 bars before a close 1 ATR under; one move per cluster, starting at its lowest close). On the 5- and
  15-minute bars (`SESSION_MOVES`) a move must finish inside its own ET session — a day trade is flat at the close; not
  on the 1-hour (it is the short term swing's too; inside one session it found 2 moves on LNG). Per move: the run into
  the top it fell from (ATR, bars), the pullback (% of the run, ATR, bars), RSI and the stretch over the 50 at the top,
  RSI, MACD (in ATR) and the distance to the 20 EMA / 50 / 200 SMA at the low, the move after (ATR, bars to +4 ATR).
  Each measure: its median, older / recent medians, and STEADY when the recent third's median sits inside the older
  two-thirds' middle half (`changed` when not; null under 7 older / 3 recent). Under 10 moves: `thin`. `now`: the top of
  the last 60 bars, how far (ATR, % of the run) and how long since, RSI — where it stands against its own pullbacks.
  A description, never an edge: the tool text says "never cite it as support".
- **15-minute** (`fifteenFromFive`, the service): built from the 5-minute bars already fetched — no extra calls; in the
  profile's `moves` only (`MOVES_ONLY_TIMEFRAMES`), not a full timeframe.
- **Shown:** the opened Hotlist row, "<timeframe> size and pace" on the horizon's bars (a day trade: 5-minute,
  15-minute, 1-hour); Proteus's tool text, a SIZE AND PACE block on every timeframe. PROFILE_VERSION 11 — stored
  profiles are measured again on their next ask.
- **Live, LNG 2026-11-16:** daily 27 moves, 11 of 14 measures steady — a run of ~7.5 ATR over ~47 days into a top, a
  pullback of ~59% of it (4.4 ATR) over ~45 days to 1.8 ATR under the 50 SMA, RSI ~40 at the low, then ~4.8 ATR. Weekly
  4 moves (thin). 5-minute 71 moves, 12 of 14 steady; 15-minute 15 moves, 4 of 14 steady — on one name the 5-minute is
  the steadier; the choice waits for more names.

### 10.9 The news around the moves — one company (declared 2026-11-17, before the run)

Roy: "can we look for any news anywhere before the movement?" → "let's take one name and try this — where the news
appear around the move and what can we learn from it". LNG. A DESCRIPTION of its moves (§10.5's rule; on the 5-minute,
inside one session — §10.8), every dated event put on a timeline around each move's start.
`scripts/lab-proteus-moves-news.mjs`.

- **The sources:** SEC 8-K filings (EDGAR, every year; by item — 2.02 results, 7.01 / 8.01 other news, 1.01
  agreements, 5.02 people …) · earnings reports (date, beat / miss) · analyst grades and price targets (from 2023-06) ·
  insider trades (buys / sells) · FMP headlines (`/news/stock`, the last year only — FMP refuses older on this plan).
- **Daily (~10 years):** for each move, the events from 10 sessions before its start to 5 after, by session relative to
  the start. Counted: the share of moves with each kind BEFORE (−10…−1), ON the start day, and AFTER (+1…+5).
- **5-minute (the last ~3 months, fetched now):** for each move, the headlines in the 24 hours before its start, during
  it (start → +4 ATR) and in the 24 hours after, by hours relative to the start; and the 8-K / report / analyst events
  of the same session.
- **Beside it, how dense the news is** — headlines a day on LNG over the year, and the share of sessions with any — so
  "news before the move" is read against how often there is news at all (a calibration, like §10.7's detectors).
- What it is for: whether LNG's moves FOLLOW news (it comes before), come WITH it (the start day) or are EXPLAINED by it
  after. A look at one name, no rule.

**Result (2026-11-17, LNG): the news is there as often before a move as at any other time.**
`data/lab/proteus-moves-news-LNG.out.txt`; the sources kept in `data/lab/news-LNG.json` (252 8-Ks since 2016, 560
headlines from 2025-11-20 — 189 name Cheniere, the rest are the LNG industry's news FMP tags with the ticker).
- **Daily, 31 moves over ten years — before the start (−10…−1) vs any 16-session window:** any 8-K 68% vs 70%;
  agreements 23% vs 26%; people 19% vs 18%; Reg FD news 16% vs 23%; a report 10% vs 26% (moves start LESS often in the
  run-in to a report); insider buys 6% (2 moves) vs 3%; analyst targets 2 of the 8 moves since 2023-06. On the start
  day itself almost nothing (a report 6%, an 8-K 10%).
- **The three daily moves in the news year:** each had a run of headlines before it — company 6–7, industry 11–18 —
  as every window does. Two had a NEW price target days before: 2025-12-17 (254, at 189) before 2025-12-26, and
  Bernstein 2026-06-16 (283, at 231) before 2026-06-18 — with "Buy the dip — there's no more war premium" (06-11).
- **5-minute, 71 moves in the last three months:** a company headline in the 24 hours before 38% (any 5-minute bar:
  42%); an industry headline 77% (any bar: 77%); DURING a move almost none (1% company, 4% industry); an 8-K / report /
  analyst event the same session 8%. The clear exceptions are the Q3 report (2026-10-29/30, results + its coverage)
  and the Orlen–Qatar cancellation (WSJ, 2026-11-11 06:00) before the 11-11 move.
- **So, on LNG:** the moves do not follow the news — it is there before them as often as before any bar, and nothing
  lands during them. What stands out on the daily is an ANALYST STARTING COVERAGE with a target well over the price a
  few days before the last two moves — two cases, a lead for the names with analyst data, not a finding.

**KO, the same (2026-11-17; Roy: "let's go on KO"): the same answer.** `data/lab/proteus-moves-news-KO.out.txt`; 319
8-Ks, 1,638 headlines (company = "Coca-Cola" / "Coke" in the title).
- **Daily, 35 moves:** an 8-K before the start 26% vs 50% of any window; results / a report 9% vs 25%; people 6% vs
  20% — on KO too the moves start LESS often in the news-heavy stretches, the run-in to a report most of all.
- **Analysts, 10 moves since 2023-06:** a change before 1 move (an upgrade 9 sessions before 2025-01-23) and a target
  raise before 1 (89 at 82, before 2026-06-04); the other new targets came AFTER moves (+4, +5 sessions). LNG's lead —
  new coverage just before the move — is not on KO.
- **5-minute, 61 moves:** headlines on 88–94% of sessions; a company headline in the 24 hours before 92% (any bar
  89%), industry 85% (any bar 90%); during a move 13–16% — KO's news never stops, so it is there through everything.
- **So, two names:** the moves do not follow the news. On the daily they start more often in the quiet stretches, away
  from reports and filings; intraday the headlines are background. What LNG's last two moves showed (new coverage a
  few days before) is one name's, twice.

**Major news along the whole chain (declared 2026-11-17, before the run).** Roy: "there weren't any major news before
or after — even before the steps that led to the move?" Not looked at: how BIG the news was, and the links before the
start. LNG and KO, daily, §10.9's sources. `scripts/lab-proteus-moves-news-chain.mjs`.
- **Major:** a session with a dated event (8-K, report, analyst / target, insider trade, a headline in the news year)
  on which the stock reacted — its close-to-close move ≥ 2 ATR (the day before's ATR) OR volume ≥ 2× its 20-session
  average. Beside it, a BIG session with no dated event at all (a move nothing explains).
- **The chain's parts, per move:** AT THE TOP (the highest close of the 60 sessions before the start, ± 5 sessions) ·
  IN THE PULLBACK (between them) · AT THE LOW (the start ± 5). Counted per 100 sessions in each part, against the same
  rate over the name's whole history — the parts differ in length (a pullback runs ~45 sessions). And per move, the
  major news days listed with their part and offset.

**Result (2026-11-17): major news is rare everywhere in the chain, and no part of it gathers it.**
`data/lab/proteus-moves-news-chain.out.txt`. Per 100 sessions, major news / a big session with nothing dated:
- **LNG (28 moves):** at the top 0.7 / 1.6 · in the pullback 1.2 / 2.3 · at the low 0.3 / 3.2 · any time 1.1 / 2.5.
  Moves with any major news — at the top 2, in the pullback 6, at the low 1.
- **KO (33 moves):** at the top 1.1 / 5.1 · in the pullback 0.3 / 3.3 · at the low 1.1 / 3.0 · any time 0.8 / 2.7.
  At the top 4, in the pullback 2, at the low 4.
- **What the major news was:** nearly all EARNINGS reports — LNG's in the pullbacks (2020-02, 2023-05, 2024-05 miss,
  2026-05-07 the −16.65 miss, −5.6% that day), KO's at the tops (2019-02 −8.4%, 2024-10 with a target cut); then the
  2020 crash (LNG directors buying on 2020-03-09, −18.1%); KO's 2026-04-28 beat 4 sessions into a move.
- **Big sessions with nothing dated are 2–5× as common as major news,** in every part — most of what moves these
  stocks on a day is not in the filings, reports or analyst notes (and before 2025-11 the headlines are not in the
  sources at all, so part of "nothing dated" is press news this lab cannot see).
- **So:** the chain is not news-driven on either name. Where major news sits in it, it is a report — inside a pullback
  (LNG) or at the top (KO) — and the move itself starts away from it.

### 10.10 The news around the moves, on every name (BUILT 2026-11-17)

Roy: "I want Proteus to also characterise this per name — in the future if we see we learn nothing from it we will
take it out." So it is ONE part, `news`, easy to remove: the engine's L (`newsProfile`), the reader
`services/proteusNews.service.js`, two word functions and two lines in the tool text / the opened row.

- **Read with the weekly profile, beside the bars** (`profileFor`; never holds it up — a failed source is empty, a
  failed read is a profile without `news`; each source retried once): SEC 8-Ks since 2016 (`sec.provider.get8kFilings`,
  EDGAR, free — and the company's name), earnings reports (FMP `/earnings`), analyst ratings (`/grades`) and target
  notes (`/price-target-news`, ≤ 3 pages), insider purchases, FMP headlines for the last ~3 months (14-day windows, the
  5-minute bars' span). ~10 FMP calls a name beside the bars' ~22; LNG and KO profiled in 13–14 s.
- **Counted (L, §10.9's rules):** daily — major news (a dated event on a session the stock moved ≥ 2 ATR or traded ≥ 2×
  its volume) per 100 sessions at the top / in the pullback / at the low of each move, against any time; the moves
  with any, what it was and where; an 8-K / a report in the 10 sessions before a start, against any window; big
  sessions with nothing dated. 5-minute — a company / an industry headline (company = its name's core or "(TICKER)",
  `companyPattern`) in the 24 hours before its intraday moves, against any moment, and during.
- **Shown:** the opened row's "News (daily)" for a swing horizon, "News (5-minute)" for a day trade, led by one phrase
  ("its moves start away from news" / "start ON major news" / "no more common …"); the tool text's NEWS AROUND ITS
  MOVES block, "a description, not a signal — never cite news as the reason a move will come". Mentor's read: not yet.
  PROFILE_VERSION 12.
- **Live, 2026-11-17:** KO — major news at the tops 2.2 per 100 (any 0.8: downgrades, reports), at the low 0.5;
  intraday a company headline before 90% of moves vs 87% of any moment. LNG — its moves start away from news (0.3 vs
  1.1), the major news reports inside the pullbacks; intraday 35% vs 40%. As the labs found.

### 10.11 What sits at every step of a move, every timeframe — and volume profile, Elliott (declared 2026-11-17)

Roy: "I prefer to check patterns / OBs / indicators at all move steps — in time I'll see if to take it off. Also we
tried it only on daily charts. Also — can we add to our profile volume profile and Elliott waves?" §10.7's checks ran
on the daily bars of 11 names in a lab; now on EVERY name, on every timeframe (5-min, 15-min, 1-hour, daily, weekly),
in the profile. One part (`steps`, inside each timeframe's size and pace), easy to take out.

- **The moves and steps are K's** (§10.8): the move's start (the LOW), the TOP it pulled back from (the highest close of
  the 60 bars before), and INTO THE TOP (the run up to it). Session-only moves on 5/15-min, as K.
- **Each fact is read against ANY bar** — the base: the same fact at every bar treated as a "low" (its top and run
  found the same way), sampled (≤ ~1,500 bars). A fact on 80% of moves means nothing if it is on 80% of any bar (the
  lab's LOOSE detectors). Per fact: the share of the older / recent moves, the share of any bar, and `stands_out` when
  the older moves beat any bar by ≥ 10 points at z ≥ 3 and the recent by ≥ 5 (Proteus's own `edge` / `z` / `recentEdge`).
  Thin (< 10 moves): shares only.
- **Changed in the build (2026-11-17, before any result was reported), each for a reason found on the first look:**
  1. *Any bar → any LOW.* A move starts at a low by construction; any bar made the low's own traits look like the
     moves' (the MACD histogram still falling at a low: 0% of moves vs 51% of any bar). The base is every local low (the
     lowest close of 5 bars each side; on 5/15-minute, the same session's bars, as a move's are — 14 of KO's 61
     5-minute starts were not the lowest of the 5 bars before, those being the session before's).
  2. *A second baseline: its own bars shuffled.* Against its other lows alone, random walks "stood out" on 10 of 80
     daily runs (z 3 … 5 never cleared the tail: a deep pullback leaves the MACD under zero in a random walk too). So a
     fact stands out only when it beats BOTH its other lows and the moves of the name's bars in 4 shuffled orders (each
     bar kept, the sequence gone — Proteus's own shuffle), like a Wyckoff spring must beat both. Random walks: 0 of 40.
  3. *The candles split.* "A hammer / bullish engulfing" fired at half of a random walk's lows (an up bar after the red
     bar that made the low "engulfs"): hammer, bullish engulfing, shooting star, bearish engulfing are each their own fact.
  A planted trait is found (a unit test: every rally starting at a hammer stands out).
- **The facts** — §10.7's, with the TIGHT order block and double bottom/top (the loose ones fired on 30%+ of any bar):
  - at the low: a bullish order block (tight), a swept swing low, a Wyckoff spring, inside a Wyckoff range, a 38.2/50/61.8%
    retrace (±5), at the 200 SMA, MACD under zero, the histogram turning up, a MACD cross up, RSI / MACD bullish
    divergence, a double bottom (tight), a hammer / bullish engulfing;
  - at the top: a bearish order block (tight), a swept swing high, a MACD cross down, RSI / MACD bearish divergence, a
    double top (tight), a shooting star / bearish engulfing;
  - into the top: a Wyckoff range breakout, a bullish OB retested, a swept low (20 bars before), MACD over zero, a MACD
    cross up (10 before), the 20 EMA over the 50 SMA, RSI over 60.
- **Volume profile (new)** — the volume at each price over the 120 bars before the bar (each bar's volume spread evenly
  over its high–low, 40 price bins): the point of control (POC, the busiest bin), the value area (the 70% of volume
  around it, VAL–VAH), high- / low-volume nodes (a bin ≥ 1.5× / ≤ 0.5× the average bin). At the low (its low price): at
  the POC, at the VAL (each within 0.5 ATR), under the value area, at a high-volume node, at a low-volume node. At the top
  (its high): at the POC, at the VAH, over the value area, at a high-volume node, at a low-volume node.
- **Elliott (new) — the part with rules, never the count.** Turns from a zigzag on the closes: a turn needs a reversal
  ≥ 1.5 ATR. Into the top: the run (its low → the top) is FIVE legs keeping Elliott's three rules — wave 2 never under
  wave 1's start, wave 3 not the shortest of 1/3/5, wave 4 never into wave 1's range. At the low: the pullback (the top →
  the low) is THREE legs (A down, B up, C down) with C past A's end, and C within 0.618–1.618 × A. The wave LABELS a
  chart reader would draw are not measured (§8.1's rule) — only whether the legs were there and kept the rules.
- **Shown:** the opened row's "<tf> at the steps" line — the facts that stand out (rarer, faded) with their shares, or
  "nothing stands out of 41 facts"; the tool text the same, plus every other fact by name ("no difference"). A
  description of the moves, not a signal. PROFILE_VERSION 13. Stored compact (one array a fact): ~31 KB a profile,
  was ~20 KB. The engine ~1–1.5 s a name (all timeframes, the shuffles included).
- **Live, 2026-11-17 — KO, LNG, NVDA, TSLA, DUK, every timeframe:** NOTHING stands out, on any name or timeframe (the
  weekly: too few moves, 4–7). Against the other lows alone a few did (KO and DUK daily MACD under zero, NVDA hourly a
  MACD cross and RSI divergence) — each also on the shuffled bars' moves: what any move has, not the name. As §10.7's
  lab found on the daily, now on the intraday too.

## 11. Build order and status

1. **The measured profile engine** — BUILT 2026-11-12 (`services/behaviourProfile.engine.js`, 68080cdf): one
   outcome, a baseline for every rate, z ≥ 3 (raised from 2 after a random walk passed ~2% of tests), the recent
   third; sweep depth added in step 3.
2. **The sample run** — DONE 2026-11-12 (§10; `scripts/proteus-sample.mjs`, cf6f547f, with the VWAP touch fix).
3. **The desk** — BUILT 2026-11-12 (c1240bc0, FE c81e392): `services/behaviourProfile.service.js` (fetched, kept a
   week in `proteus_profiles` — the PROFILE only, not the bars: 5-minute history per name would eat the Atlas
   quota, §9 superseded), `get_behaviour_profile`, the agent + prompt + desk, registry `technicals` routed from Axl
   and Mentor (Axl's capture now carries the key `'axl'`), Axl's and Mentor's prompts, the FE agent + Technicals
   Desk + wave badge. Live-driven 2026-11-12 (908640ee): Axl → Proteus on TSLA (the daily 50 SMA held: 78% vs 49%,
   n 37 — reported with the chance caveat) and NVDA in the browser (nothing holds), desktop + 390px.
4. **The triggers** — BUILT 2026-11-12: Mentor's pre-trade read is his desk's own (`mentor.desk _proteusRead`, every
   turn on the build's name, with Prometheus's deciding read — argus-rework.md §2.3). The measured profile on every
   day-board name and on the house scan's picks goes through ONE queue, `services/proteusQueue.service.js` — one name
   at a time, 2 s between names, a 429 pauses 60 s and retries the same name, the loop leader only, in memory (a
   restart forgets the waiting names; the next board or the name's first open profiles it). The Pythia picks come out
   of the WEEKLY run (pythiaWeekly → houseScan), not a nightly one. Live-checked: TSLA from the week cache, MSFT and
   AMD profiled, ~10 s a name.
   **2026-11-13, after a live ask:** "how does NVDA behave?" answered from the cached profile, then "how did you do it
   so fast?" got "I made those figures up" — the history held the reply's text, never the call. Fixed for every desk:
   the reply keeps its `tools` (sessionTurn) and the next turn opens with the app's note naming them
   (context.toolNote). And each answer now shows ONE example chart: the engine keeps each timeframe's latest false
   break (`false_breaks.latest`, PROFILE_VERSION 4), the tool text names its prices and get_chart timeframe. Replayed
   live: NVDA daily, Nov 12 swept the 151.49 low to 148.80 and closed back above; the follow-ups named the profile.
5. **The Hotlist badge** — BUILT 2026-11-13. Every Hotlist row carries what the name obeys on its horizon's timeframes
   (intraday: 5-minute + 1-hour; This week: 1-hour + daily; Swing: daily + weekly; Long term: weekly + daily) — "50 MA +1",
   "sweeps lows", "nothing" — from the STORED profile only (`behaviourBadge`, `storedProfile`; one request per tab,
   `GET /api/hotlist/behaviour`); the tooltip says what was measured, a click asks the technical analyst "How does X
   trade?" in the chat (handed off like Build). Profiling (Roy, option b): the covered book (Swing + Long term, ~340 names)
   is queued after the weekly run (`profileHouseBook`), never from a look; Intraday / This week names still queue on a look.
   Driven (scripts/drive-proteus-badge.mjs): Intraday's 9 names, one request, all "nothing"; MBGL's badge → his read.
   Mentor weighing the read for his levels — not built.
6. **Size and pace (K)** — BUILT 2026-11-16 (§10.8): every timeframe's moves described per name, the 15-minute beside
   the 5-minute; in the opened row and the tool text. **Mentor's use — BUILT 2026-11-17** (Roy: "let's add size and pace"):
   his read carries size and pace on the trade's timeframes and ITS USUAL PULLBACK on the stop's chart (the median depth
   from its latest top, and the middle half, as prices — `pullbackZone`); the server checks the stop against the median
   (`_buildPullbackSection`) and, when it sits above, the turn tells him to say so and offer the choice (entry lower, or
   the stop under the median) — never moving the stop himself. The prompt rule alone was skipped on the first drive; with
   the code-side line it was said (ARMK 1-hour, 52.40 vs 50.64). PROFILE_VERSION 14. Mentor's output budget 32k (Luna
   reasoned 19.5k characters and landed empty at 16k).
7. **No profile on a short fallback history** — FIXED 2026-11-17 (Roy: "fix 1"). When FMP failed (a 429 while the
   queue profiled several names, a timeout) the candle router fell back to a provider with ~2 years of daily bars, and
   the profile was measured on them and kept a week (LLY, OXY: ~500 daily bars, no weekly view). The daily now comes
   from FMP only (`fmpDaily`, 3 tries, 3 s and 10 s apart); still failing, no profile is made or kept — the error says
   try again (a 429 pauses the queue and retries; the opened row reads "could not be fetched just now"). FMP answering
   EMPTY (a symbol it does not cover) still takes the fallback; USE_FMP_CANDLES off, the router as before. The
   intraday pages still fall back page by page (a skipped or mixed page, not a short history).
8. **The news around the moves (L)** — BUILT 2026-11-17 (§10.10): per name, beside size and pace; in the opened row
   and the tool text. One part to take out if it teaches nothing (Roy). Mentor's use — later.
9. **What sits at every step of the moves (M)** — BUILT 2026-11-17 (§10.11): patterns, order blocks, indicators, a
   volume profile and Elliott's rules at the run into each top, the top and the low, every timeframe, against its other
   lows and its shuffled bars (`services/moveSteps.engine.js`, one part to take out). The opened row also lists what was
   TESTED with no edge (Roy: "add the tested line"). Mentor's use — later.
   **Horizontal support / resistance** (levels from ≥ 2 swing lows / highs within 0.25 ATR, a forward test against
   shifted levels, and at the steps: a low at support, a top at resistance, the flip) — proposed 2026-11-17, LEFT FOR
   LATER (Roy: "let's leave it for now").
