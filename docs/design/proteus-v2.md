# Proteus v2 — how a stock moves, measured in its own σ

Decided with Roy, 2026-11-21, after the labs of `docs/design/proteus.md` §10.12–10.21: across 53 indicators and patterns,
every target size and horizon, four ways of measuring and a shuffled control, no entry SIGNAL is a dependable edge on daily
bars, and a name's own recent signal outcomes do not predict its next ones. What DOES hold is a description of how a name
moves — its scale, its noise, the levels that fit it, whether it trends or reverts. Proteus is rebuilt to be that, and only
that. The old engine is deleted (§6).

## 1. Decisions (Roy, 2026-11-21)

| | Decision |
|---|---|
| P1 | **Proteus is the behaviour profile, nothing else.** The indicator / pattern tests, the moves-and-steps facts, the news around moves, the chat agent and its chart-reading tools go. |
| P2 | **It works like coverage.** A stored profile per stock with a validity rule; Axl reads a VALID one; missing or stale → Proteus builds it, Axl reads that (`get_company_view`, `docs/design/axl-one-voice.md`). |
| P3 | **The trader (Mentor) reads the new profile only.** When the user asks for a reward : risk ("I want 3:1"), Mentor ASKS Proteus where the stop and the target go for this stock at that ratio, and Proteus answers from the stock's behaviour. |
| P4 | **The old engine is deleted** — its code, its stored profiles (`proteus_profiles`), the lab scripts that run on it, its tests. Git keeps the history. |
| P5 | **Design first, then build**; the 5-stock and 100-stock checks run beside the build to tune the measures. The profile is shown as a DESCRIPTION — never as a rule that beats holding (it has not passed a walk-forward). |
| P6 | **Three SCALES** (Roy, 2026-11-21: "for the trader — is the horizon irrelevant now?" → "yes" to the scales): the stock's behaviour sets the levels, the horizon picks the SCALE they are read on — a day trade (intraday bars), a swing (daily), long term (weekly) — and is CHECKED against how long the levels usually take. |

## 2. The profile — every measure in the stock's own σ

Daily bars. **σ = the monthly σ**: the standard deviation of the last 60 daily returns × √21 (KO ≈ 4.5%, NVDA ≈ 12%). Each
measure is computed at the build and stamped with its date.

| # | Measure | Definition | KO (2026-11) |
|---|---|---|---|
| 1 | **σ** | as above; also ATR(14) in % for continuity with the charts | 4.5% |
| 2 | **Swing scale** | a zigzag on the closes that turns on a 1σ reversal, over the last 3 years: the RUNS up and the PULLBACKS — median and middle half, in σ and %, and their sessions | runs 2.3σ (~10%, 35 sessions), pullbacks 1.5σ (~7.5%, 21) |
| 3 | **Noise** | how deep a pullback goes inside a run that then continues — the depth a stop must clear (the 75th percentile of the pullbacks, σ) | ~1.9σ |
| 4 | **Natural levels** | stop = just past a normal pullback (the noise above); target = the run size ~70% of runs reach (the 30th percentile of the runs) | stop ~1.5–1.9σ, target ~1.5σ |
| 5 | **Implied reward : risk** | target ÷ stop — follows from 4, not chosen; with its record over the 3 years (entries every day, held to the stop or the target, a 1-year cap): win rate, median days to resolve, never resolved, and against holding | ~1:1, ~72% wins, ~1 month |
| 6 | **Trend or revert** | the 63-session regression line of log closes: its angle (% a month) and R² NOW; over the 10 years, the angle's correlation with the NEXT 63 sessions' return (separate windows) → "reverts" (≤ −0.15), "persists" (≥ +0.15), "neither" | reverts (−0.25) |
| 7 | **Stretch from the line** | NOW: the close's distance from its 63-session line in residual σ; and the record: after a stretch of 2+ below / above (separate episodes), the next 63 sessions | 2+ below → +4.5% next 3 months (25/33) |
| 8 | **Regime now** | the 63-session efficiency ratio against the stock's own history: range (bottom third) / mixed / up or down trend (top third, by its sign) | (as of the build) |

**Counts always shown.** Every record line carries how many windows / episodes / trades stand behind it; under a minimum
(10) it says "too few to say", as the old profile did.

### 2b. Three scales (P6)

The table above is the SWING scale. The same eight measures are read on three scales — the levels of a day trade and of a
year-long position live on different scales of the same stock:

| Scale | For | Bars | σ (the unit) | History read | Line / regime window | Levels resolve by |
|---|---|---|---|---|---|---|
| **Day** | a day trade | 15-minute (regular hours) | the last 260 intraday 15-minute returns (the overnight one left out) × √26 — a session's σ | the last 3 months | the last 5 sessions | the session's close (a day trade is flat at the close) |
| **Swing** | 2 weeks – ~6 months | daily | 60-day daily σ × √21 — a month's σ | the last 3 years | 63 sessions | a 1-year cap |
| **Long term** | 6 months – 2 years | weekly (from the daily) | 52-week weekly σ × √13 — a quarter's σ | the last 10 years | 26 weeks | a 2-year cap |

- **The horizon picks the scale; the scale's levels are the stock's.** Mentor reads the scale of the trade he is building.
- **The fit is checked, not assumed:** each scale's record carries the median time its natural levels take. A trade whose
  horizon is shorter than that (a week on a swing level that takes a month) is said plainly — Mentor uses the shorter
  scale, or tells the user the level needs the time.
- A scale without enough bars or swings (a new listing, a day scale on a thin name) says "too few to say" — never borrowed
  from another scale.

**As built (step 1, 2026-11-21 — what the live runs on KO, NVDA, TSLA changed):**
- **The day scale reads 15-minute bars** (built from the 5-minute, ~3 months, 26 a session; σ = 260 intraday returns × √26)
  — hourly bars give 7 a session, too coarse for a session's swings. Its swings are **one reading per session**: the
  session's biggest run (a low to a later high) and fall, and its noise the deepest dip from a running high that the
  session later EXCEEDED (a short's: the bounce later undercut). A zigzag rarely completes run–pullback–run in a session.
- **The noise is the counter-move inside a move that CONTINUED** (both sides): a pullback counts only when the next run
  made a new high; a rally (a short's noise) only when the next fall made a new low. All counter-legs made a trending
  name's short stop absurd (NVDA: 55% swing, 480% long term) — the trend's own legs counted as noise.
- **The swings are read over all the history** (10 years daily / weekly): in σ units they scale with today's σ, and three
  years held ~6 continued pullbacks. The levels' RECORD stays on the scale's history (3 years / 10 years / 3 months).
- **Long term turns on half a quarter's σ** (a 1σ turn: ~9 swings in 10 years). Too few still says so — NVDA's
  long-term short has too few continued declines to read.
- **A swing count of 8 is enough** (MIN_LEGS); trades / windows / episodes keep 10.
- **Each side its own levels** (long / short), and the record of every ratio in 0.5, 1, 1.5, 2, 2.5, 3, 4, 5 kept with the
  profile — `levels_for` answers the nearest, no bars fetched.
- Seen live: KO swing — stop ~9%, target ~9.5%, 86% wins, ~58 sessions; 3:1 → a 26% target, 44% first. A day trade's
  natural target (~1 session σ) came before the close in only 8–15% of entries on KO / NVDA — most are still open at
  the close.

## 3. Levels for a requested reward : risk (P3)

`levels_for(symbol, ratio, scale)` — Mentor's question "the user wants 3:1, where do the stop and target go?", on the
scale of the trade (§2b; a day trade's 3:1 is in the session's σ and must resolve by the close):
- **The stop** stays where the stock's noise says (measure 3): a stop tighter than the noise is shaken out (the labs: a 3%
  swing-low stop on KO lost to holding at every horizon). **The target** = ratio × the stop's distance.
- With the record of that pair on the stock's last 3 years: how often the target came first, the median days, how many
  never resolved in a year, and against holding — so Mentor can say "3:1 on KO means a ~20% target; it came first in ~30%
  of the last 3 years' entries, after ~4 months".
- In prices from the current close, and in σ / %. Long and short (short mirrored).
- Proteus does not refuse a ratio; it says what the ratio costs on this stock. The judgment stays Mentor's.

## 4. Validity and building (P2)

- **Stored** per symbol (a new collection, `stock_profiles`), with `computed_at` and a `version`.
- **Valid** while `computed_at` is within 7 days and the version is current (the DAY scale: within 1 day — its window is
  3 months). **Built** by code only (no model): the daily bars (FMP, the existing daily fetch; the weekly made from them)
  and 3 months of hourly bars, then the measures of each scale — seconds.
- **Axl:** `get_company_view` reads it; missing / stale → built inline (seconds) and stored. **Mentor:** his profile read
  and `levels_for` through the same service. **The Hotlist** row page shows its bottom lines.

## 5. Where it shows

- **Axl** (`get_company_view`): the profile's lines, said as "our technical read".
- **Mentor:** the profile on the trade's scale in his context; `levels_for` as a tool.
- **The Hotlist row page:** "How it trades" in bottom lines — σ, its swing scale, its natural levels, trend or revert.
- **The BOTTOM LINE (2026-11-21, Roy: "if a user reads this — what's the bottom line?")** — first on the row and first in
  each scale of the brief Axl reads (`bottomLine`, stockProfile.format.js), by fixed rules: a trend leans only when its
  steep moves PERSIST (reverting is "cools off", no lean); a stretch of 2+ leans only when what followed went that way
  and beat its usual by ¼σ; trend and stretch opposed → "Mixed", both named. Then the trade on the lean's side (long when
  none): its natural reward : risk, how often it worked, and whether it beat holding — or that the levels mostly never
  finished on that scale. On NVDA / KO / TSLA / AAPL / XOM most scales read "No clear lean", which is the honest read.
  Mentor keeps the full lines.
- **The fit lab (`scripts/lab-proteus-fit.mjs`, 102 large caps, 2026-11-21)** — can Proteus recommend a name's horizon,
  its reward : risk, its risk? Picked on the first five years, checked on the last five, long side, against holding:
  - **Horizon / R:R — no.** The first half's pick beat holding in 34% against 30% for any pick; names where holding beat
    every trade went on to beat holding 34% too; swing ratios that beat holding did so again 25% (33% for the ones that
    had not); the best ratio landed 4th of 8. So nothing recommends a horizon or a ratio, and the bottom line no longer
    says "beat holding / holding did better".
  - **Risk — yes, as σ.** The swing pullback in σ is the same for every name (median 1.73σ → 1.80σ) and a name's own
    difference from it noise (correlation 0.07); σ carries (0.40). → the RISK line (`riskLine`): a normal pullback is
    1.75 × σ on the swing scale; the day and long scales (not tested so) say the name's measured noise.
    (Superseded by VERSION 2 below: the risk is the side's stop, the horizon's constant × σ.)
- **Gone:** the technical-analyst chat agent (Axl no longer asks it), its chart tools, the profile's old lines.

## 5b. VERSION 2 — the periods fit the horizon (2026-11-21, Roy: "fit the period to the horizon" → "build the engine change")

**The labs** (102 large caps, 10 years of daily bars cached in `data/tmp/lab-fit-bars.json`; long side):
- `lab-proteus-horizon.mjs` — the normal pullback (75th percentile of the counter-moves inside moves that went on) is a
  CONSTANT × σ over the horizon H, on every name: H 5 → 2.08σ (2.08 → 2.09 between the halves), H 21 → 1.73σ
  (1.73 → 1.82), H 63 (½σ turns) → 0.94σ (0.94 → 0.94). A name's own difference does not carry (correlation −0.08 / 0.11 /
  0.05), and the constant fitted the second half better than the name's own (off by 6 / 11 / 8% against 8 / 14 / 11%).
- `lab-proteus-target.mjs` — the old target (30th percentile of the RUNS between swing turns) belonged to the next
  timeframe up: runs last ~2 × H, so 47% (H 5) and 36% (H 21) of trades had not finished by 3 × H. Measured from the
  entry (what 70% of entries reached within 3 × H before the stop): H 5 0.69σ, H 21 0.81σ, H 63 0.70σ — ~2 in 3 first,
  finished in ~H. One timeframe down gave nearly the same. The result per trade (~+0.1R) was the same for every target
  tried: placement is not an edge, it trades hit rate for size.
- `lab-proteus-rolling.mjs` (Roy: "five years is a long time — I need it for the next horizon") — every month, the
  horizon × ratio that did best on a name over the last 6 / 12 months, traded the next month: 44% / 43% beat most others
  (chance 46.7%), average rank 7.7 / 7.6 of 15 (chance 8), the horizon alone right 34% (chance 33%). **Nothing about a
  name's best horizon or ratio carries — over five years or one month.** What carries is σ.

**As built** (`stockProfile.engine` VERSION 2; a stored v1 profile is rebuilt on its next read):
- Four scales. `day` unchanged (15-minute bars, its measured levels — its own lab is parked). `short` (short term swing,
  NEW — Mentor's `short term swing` had read the month-sized swing levels), `swing`, `long` — all on the DAILY bars, σ the
  last 60 daily returns × √H (5 / 21 / 63), the record's trades capped at 3 × H (15 / 63 / 189 sessions; the swing's
  was a year, which is why "never resolved" always read 0%), entries over the last 3 years.
- The levels: stop = `SCALES[k].stop` × σ, target = `SCALES[k].target` × σ (basis `constant`); the natural reward : risk
  ~0.33 : 1 (short), ~0.47 : 1 (swing), ~0.74 : 1 (long). The measured swings / pullbacks stay as the description.
- Re-checked on the 102 names (the engine itself, last 3 years): short — stop 8%, target 3%, first 70%, not finished
  17%, ~5 sessions; swing — 14%, 7%, 69%, 12%, ~20; long — 13%, 10%, 67%, 0%, ~30. A 3 : 1 inside the horizon: 0% / 1% /
  19% first, 81% / 73% / 29% not finished.
- The words: no "against holding" anywhere; each record says "held up to N sessions … not finished within N";
  `get_levels_for` adds the target that fits the horizon's time beside the one asked, and that the ratio is the
  trader's choice, not the name's. Mentor's and Axl's prompts say never to call a ratio or a horizon "this name's".
- Where: Axl reads short / swing / long; the Hotlist's This week row reads the short term swing (it holds ~a week);
  Mentor's noise check accepts either daily-chart scale (short, swing).
- **Open:** the long-term stop (0.94σ of a quarter, ~13% median) sits about at the swing's (~14%) — it is what the
  ½σ-turn pullbacks measured, untested against a 1σ turn. The short side reuses the long side's constants (the labs were
  long-only). The day scale's levels (its own lab, from the entry).

## 6. What is deleted, what is rewired (P4 — mapped from the code 2026-11-21)

**Stays (not the old engine — it only USED them):** `swingStructure.service.js` (Mentor's swings), `smc.engine.js`, and
Mentor's own chart tools — `get_price_structure`, `get_cycle_analysis`, SMC / order blocks, the vision tools. None imports
the old engine.

**Deleted:**
- The engine: `behaviourProfile.engine.js`, `behaviourProfile.service.js`, `moveSteps.engine.js`, `proteusQueue.service.js`,
  `proteusNews.service.js`, `tools/behaviourProfile.tools.js`, `tools/elliott.tools.js` (Proteus-only), and the stored
  `proteus_profiles` (dev now; prod with Roy).
- The chat role: `agents/proteus.agent.service.js`, `desks/proteus.desk.js`, `prompts/proteus_system_prompt.md`, the
  `proteus` registry entry (→ `technical_analyst` leaves `ask_specialist`), the schemas `get_behaviour_profile` and
  `check_elliott_count`.
- Its tests (behaviourProfile*, moveSteps, proteusQueue / Labs / Moves / Values, elliottCheck, hotlistBehaviour) and the
  lab scripts on the engine (lab-proteus-*, proteus-sample, lab-thesis-buffer-name; drive-desk-architecture is fixed).
- Frontend: the Proteus agent / desk / tab / badge (`agentMeta`, `AgentBadges`), the `technicals` flow (`infoFlow`). Old
  chat rows by `proteus` still render (a plain fallback label) — history is not rewritten.

**Rewired to the new profile:**
1. **Axl** — `companyView.service.js`: "OUR TECHNICAL PROFILE" from `stock_profiles`. His prompt's technical-analyst lines
   go: the profile is his material, there is no one to ask.
2. **Mentor** — `mentor.desk.js` / `mentor.agent.service.js`: the profile replaces `_proteusRead` / `mentorRead` /
   `pullbackZone` / `profileBrief` in his context; the stop-vs-pullback check reads the profile's noise; a new tool
   `get_levels_for(symbol, ratio, side)` (§3). `isDayTrade` / `stopTimeframe` are generic — they move to a small Mentor
   util. His prompt: no `<route>technicals`; "PROTEUS'S READ" rewritten for the profile and the ratio question.
3. **The Hotlist** — `GET /api/hotlist/profile/:symbol` serves the new profile; `TechnicalProfile.jsx` shows its bottom
   lines.
4. **The background queues** (Echo's hand-off, Pythia's weekly picks / book, the day boards) — DROPPED: a profile builds in
   seconds on demand.
5. **Prompts** — Echo's and the analyst's answer mode lose the "measured profile" lines; `agentUtils` keeps scrubbing the
   brand name.

## 7. Steps

1. **The profile** — `services/stockProfile.service.js` (the measures of §2 on each scale of §2b, pure, on bars) + the store with validity;
   unit tests on fixtures (a planted swing scale, a reverting and a trending series). **`levels_for`** (§3) + tests.
2. **Axl** — `get_company_view` on the new profile; his prompt.
3. **Mentor** — the profile in his context, `get_levels_for`, the util move, his prompt.
4. **The Hotlist** — the route and `TechnicalProfile.jsx`.
5. **Remove** the chat role, the registry entry, the schemas, the queues' calls, the frontend agent bits; the tool snapshot.
6. **Delete** the engine, its tests and labs; drop `proteus_profiles` on dev.
7. **Suites + drives:** Axl on a company, Mentor asked "3:1 on KO", the Hotlist row page.
