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
| **Day** | a day trade | hourly (regular hours) | the last 60 intraday hourly returns (the overnight one left out) × √7 — a session's σ | the last 3 months | the last 5 sessions | the session's close (a day trade is flat at the close) |
| **Swing** | 2 weeks – ~6 months | daily | 60-day daily σ × √21 — a month's σ | the last 3 years | 63 sessions | a 1-year cap |
| **Long term** | 6 months – 2 years | weekly (from the daily) | 52-week weekly σ × √13 — a quarter's σ | the last 10 years | 26 weeks | a 2-year cap |

- **The horizon picks the scale; the scale's levels are the stock's.** Mentor reads the scale of the trade he is building.
- **The fit is checked, not assumed:** each scale's record carries the median time its natural levels take. A trade whose
  horizon is shorter than that (a week on a swing level that takes a month) is said plainly — Mentor uses the shorter
  scale, or tells the user the level needs the time.
- A scale without enough bars or swings (a new listing, a day scale on a thin name) says "too few to say" — never borrowed
  from another scale.

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
- **Gone:** the technical-analyst chat agent (Axl no longer asks it), its chart tools, the profile's old lines.

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
