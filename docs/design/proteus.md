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
