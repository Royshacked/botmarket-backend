# Proteus — how a stock moves, in its own σ (v2)

Rebuilt 2026-11-21 to [design/proteus-v2.md](../design/proteus-v2.md) (the source of truth: decisions P1–P6, the
measures, §2b "As built", §6 what was deleted). The labs of [design/proteus.md](../design/proteus.md) §10.12–10.21 found
no dependable entry signal on daily bars; what holds is a DESCRIPTION of how a name moves. Proteus is now that, and only
that.

**No desk, no chat, no subagent** (P1). The ~~`proteus`~~ registry desk (pipeline ~~`technicals`~~, Axl's ~~`technical_analyst`~~),
its agent and prompt, ~~`get_behaviour_profile`~~ / ~~`check_elliott_count`~~, the old engine (~~`behaviourProfile.*`~~,
~~`moveSteps.engine`~~), the profile queues (Echo's hand-off, Pythia's weekly picks / book, the day boards) and
~~`proteus_profiles`~~ are deleted. Old chat rows by `proteus` still render (a history-only label in the frontend); a session
floor left on `proteus` falls back to Axl (`startTurn`).

## The profile

`services/stockProfile.engine.js` (pure). Eight measures, every one in the stock's own σ (design §2): σ · the swing scale
(runs and pullbacks of a zigzag that turns on a σ reversal) · the noise (the counter-move inside a move that CONTINUED —
the depth a stop must clear) · the natural levels, per side (stop past the noise; target the run ~70% of runs reach) ·
their implied reward : risk with its record (target first, time, never resolved, against holding) · trend or revert ·
the stretch from the line · the regime now. Every record line carries its count; under 10 (swings: 8) it says "too
few to say".

| Scale | For | Bars | σ | Resolves by |
|---|---|---|---|---|
| day | a day trade | 15-minute, from ~3 months of 5-minute | a session's | the session's close |
| swing | 2 weeks – ~6 months | daily, ~10 years (FMP only) | a month's | a 1-year cap |
| long | 6 months – 2 years | weekly, built from the daily | a quarter's | a 2-year cap |

The horizon picks the scale (`scaleOf`). A scale without enough bars never borrows from another.

## Kept and shared

`services/stockProfile.service.js` — like coverage (P2): one profile per symbol, the house's, in `stock_profiles`
(`{ symbol, version, scales: {day, swing, long}, built: {day, swing, long} }`). Valid 7 days (the day scale 1 day);
missing or stale → built inline, code only, seconds, only the scales asked. The bars are never stored (the Atlas quota).

## Who reads it

One text form, `services/stockProfile.format.js`:
- **Axl** — `get_company_view` (`companyView.service`): the swing and long-term lines, "our technical read".
- **Mentor** — `mentor.desk` `_proteusRead` → "THE TECHNICAL READ" on the trade's scale; "ITS NOISE" checks his stop
  against the side's natural stop. `get_levels_for { ticker, ratio, horizon, side }` (`tools/stockProfile.tools.js`,
  P3): the user's "I want 3:1" → stop at the noise, target ratio × stop, prices from the last close, and what that ratio
  cost on this stock. It never refuses a ratio; the trade is Mentor's.
- **The Hotlist row page** — `GET /api/hotlist/profile/:symbol?horizon` (`hotlistBehaviour.profileRow`, `ROW_SCALE`):
  "How it trades" in bottom lines (`rowLines`).

## Proving it

`tests/unit/stockProfile.test.js`, `stockProfileFormat.test.js`, `hotlistBehaviour.test.js`, `companyView.test.js`.
Drives (design step 7): Axl on a company, Mentor asked "3:1 on KO", the Hotlist row page.
