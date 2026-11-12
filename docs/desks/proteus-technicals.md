# Proteus — how a stock trades

The technical analysis desk (agent `proteus`, pipeline `technicals`), built 2026-11-12 from
[design/proteus.md](../design/proteus.md). He answers ONE question about ONE stock: **what does its price respect,
if anything?** — and says what that is worth. He sets no levels (Mentor's), judges no business (Prometheus's), picks
nothing (Argus's). Long side only, like the rest of the app.

## Two kinds of answer

| | Where it comes from | What it may claim |
|---|---|---|
| **Measured** | `get_behaviour_profile` — counted in code from the stock's own candles | a rate against a baseline, with its sample and the recent stretch |
| **Seen now** | `get_chart`, `get_orderblocks`, `get_false_breaks` — a vision read of today's chart | what is visible; never a hit rate |

The prompt (`prompts/proteus_system_prompt.md`) makes him call the profile first on every stock, label which kind
each statement is, and treat "nothing holds" as the usual, honest answer.

**Patterns are by eye** (Roy, 2026-11-12): head and shoulders, flags, wedges are seen on the chart, never counted. **He
shows what he found**: `get_chart` with `show_to_user` and labelled horizontal `levels` (shoulders, head, neckline, the
measured target, where it fails; an order block's edges; a swept low) — a sloped line drawn at its price now. Found
nothing → no chart. In Mentor's build his profile line is posted by Mentor's desk (`_sayExperts`) beside Prometheus's.

## The measured profile

`services/behaviourProfile.engine.js` (pure) on four timeframes — 5-minute (~3 months), 1-hour (~1 year), daily
(~10 years), weekly (~10 years, built from the daily):

- **Levels** — touches from above of the 20 EMA, 50 SMA, 200 SMA (and session VWAP intraday; a session's first bar
  has none). Baseline: the same line shifted ±2 and ±3 median ATRs, same touch rule.
- **Events** — RSI crossing under 30, MACD crossing up, an up bar on twice its 20-bar volume. Baseline: the same
  outcome from every bar (the drift).
- **False breaks** — a low under any confirmed swing low not broken before, closing back above within 3 bars: the rate, how
  deep the sweep went in ATRs (median, 80th percentile — the room a stop under a swing low needs), bars until a
  direction, and whether a move up follows the reclaim (against the drift).
- **Order blocks** — bullish blocks (`smc.engine`), retested from above once the block is known (two bars after its
  earliest impulse): held or not, against zones shifted in % of price; retests a window apart.
- **ATR %, gap, dollar volume**, and **day trade / swing** fit (thresholds in `SUITABILITY`).

One outcome everywhere: +1 ATR before a close 0.5 ATR lower, within 10 bars. A test **holds** only at 10+ points over
its baseline, two-proportion z ≥ 3 (a profile runs ~36 tests; at z 2 noise passed ~2% of them), found on the OLDER
two-thirds of the history alone, AND still beating its baseline in the most recent third, which the finding never saw
(else `faded`). Few cases → `thin`. On 11 names, 0 of 396 tests held (§10 of the design); false breaks of swing lows
ran ~70–80% on every name, sweeping a median ~0.25 ATR under the low (80% within ~0.5) — a fact for stops, not an
entry signal.

## Kept and shared

`services/behaviourProfile.service.js` — one profile per symbol, the house's (no account), in `proteus_profiles` for a
week; ~22 provider calls the first time (seconds), nothing after. The bars are never stored (the Atlas quota). A
`PROFILE_VERSION` bump recomputes every stored profile on its next ask.

## How users get here

- **Axl** routes "how does TSLA behave?" — `<route>technicals TSLA</route>` + the question as `<open>`.
- **Mentor** offers him when the user asks how a name trades rather than to build the trade.
- The desks list ("Technicals Desk"), or `@Proteus` in the chat.
- No other desk lists him (`registry.js` `routedFrom: ['axl', 'mentor']`), so their cached prompts did not change.

## Not built yet (design §4, build steps 4–5)

Mentor's pre-trade read through the chain (pick → Prometheus → Proteus → Mentor), the measured profile on day-board
names, the nightly Pythia names, the Hotlist badge, and Mentor weighing the read for his levels.

## Proving it

`scripts/proteus-sample.mjs` (the profile on a sample, read-only), `scripts/drive-desk-architecture.mjs proteus`
(Axl → Proteus in process, real models), `scripts/drive-proteus-ui.mjs` (the same in a browser, desktop + phone).
