# Mentor's two modes — risk-based, or the user's setup

**STATUS: BUILT + DRIVEN (2026-11-01), not pushed.** Branch `feat/mentor-modes` (from main) in both repos. § Built at the end. Builds on the thesis lens
([stock-playbook.md](stock-playbook.md)) and the build ledger ([mentor-flow-intent.md](mentor-flow-intent.md)); the desk
contract is [../desks/mentor-talos.md](../desks/mentor-talos.md).

Roy (2026-11-01): "In Mentor there should be 2 modes — one, the thesis lens, the default when clicking a name from the
Hotlist; two, the user comes with his own idea for a setup." Then: "if the user doesn't bring a setup, Mentor is in
risk-based mode."

## The two modes

| | **Risk-based** (`thesis`) — the default | **The user's setup** |
|---|---|---|
| When | The user brought NO setup of their own: a bare name, the Hotlist's Build with Mentor, Argus's hand-off | The user brought an idea or a plan — finished or half-made |
| Asked at the start | Nothing — no "which mode?" question | Nothing |
| The levels | Mentor JUDGES the stop and the target off the structure; the user's risk limit and minimum R:R set the entry by code (`get_entry_level`) — § The thesis lens, unchanged | The user's. Mentor builds in their terms, asks only for what is missing, and says a disagreement ONCE, as a remark, never a gate |
| The lens | `thesis` | Mentor RECOMMENDS `discretionary`, `smc` or `institutional` from the user's own words; the user agrees |
| The tools | The risk-based kit (below) | The whole kit |
| Shorts | Allowed, as today — and Mentor still says the mirrored short tested badly | Allowed |

**What counts as a setup.** Any condition, level or pattern OF THE USER'S OWN: *"long NVDA on a pullback to the 50-day"*,
*"in at 238, stop 234"*, *"the breakout over 50"*. A direction or a horizon alone is NOT a setup — *"NVDA long, swing"* is
risk-based, because direction and timeframe are exactly what the thesis lens settles at its opening anyway.

**Switching — either way, at any point** (Roy, 2026-11-01). A user who brings a setup mid-build moves to their setup; a
user who asks for Mentor's way moves to risk-based. Either switch REOPENS everything below the opening: a thesis stop is
wrong under a breakout idea, and the reverse. Direction and horizon stay settled.

**The lens is Mentor's to recommend, nobody else's** (Roy, 2026-11-01: "Argus doesn't decide about trade mode anymore.
Only Mentor. Mentor recommends — the user agrees"). Argus's `recommended_mode` goes; with no setup in a hand-off, the
mode is risk-based by the rule above, so the field has nothing left to say.

## The risk-based kit

Roy (2026-11-01): no pattern or indicator tools in this mode — keep the news, the fundamentals, the chart and the candles.
Then: keep analyst actions, short interest, options, the price-action snapshot and the flip test — "they might help Mentor
choose stops and targets."

- **Kept:** `get_quote`, `get_candles`, `get_chart`, `get_price_action`, `get_price_structure`, `get_entry_level`,
  `get_news`, `get_earnings`, `get_earnings_calendar`, `get_fundamentals`, `get_sec_filings`, `get_analyst_actions`,
  `get_short_interest`, `get_options_context`, `flip_test`, `size_position`, `get_trading_context`,
  `check_broker_symbol`, `get_market_hours`, `web_search`, `consult`.
- **Dropped:** `get_orderblocks`, `get_false_breaks`, `get_indicators` (the ATR comes with `get_price_structure`),
  `get_cycle_analysis`, `get_key_levels` / `get_structure`, `get_correlations`, `get_peers`, `get_macro_snapshot`,
  `get_sector_snapshot`, `get_derivatives_context`.

**Off the list, not just off the prompt.** A "don't call it" line is ignored now and then, and every declared tool is paid
for on every turn. The cost: each mode keeps its own prompt cache (MENTOR_TOOLS is the exact prefix rule —
`mentor.agent.service.js`), so a switch costs one cache write.

## What changes (plan, not built)

1. **Mode = the lens.** No new field: `trade_mode === 'thesis'` is risk-based, any other lens is the user's setup. The
   ledger already carries the lens as a claim and a settlement.
2. **The kit per turn** — `mentor.agent.service.js` picks the tool list from the mode (open question 1 for the first turn).
3. **Prompt** — the opening turn splits by mode. Risk-based: lens settled, direction + timeframe + the thesis read. The
   user's setup: § When the plan is already theirs widens to cover a half-made idea, and the lens choice narrows to three.
4. **The switch** — a lens change past the opening reopens the stages below it (`mentorBuild.util.js`). Today
   "the direction and the lens do NOT reopen on a revise"; a MODE switch is not a revise and gets its own rule.
5. **Argus** — `recommended_mode` out of the scanner prompts and output (`scanner.agent.service.js`, `scanSeed.util.js`,
   `chain/contracts.js`, `chain/rules.js`), the seed section (`_buildSeedSection`), and the frontend hand-offs
   (`hotlist.utils.js`, `MainPage.jsx`, `mentorSurface.utils.js`). `analysisModes.js` stays — the lens vocabulary is still
   Mentor's, Talos's and the flip test's.
6. **Tests** + a browser drive per entry: Hotlist → risk-based; typed bare name → risk-based; typed setup → the user's;
   a switch each way.

## Decided

1. **The first turn of a TYPED message** — (b), Roy 2026-11-01: a cheap read before the turn. The server picks the kit
   before the model reads the message, and only a model can tell a setup from a bare name. Rejected: (a) the whole kit on
   the first typed turn with the prompt holding risk-based to the reduced one (the rule would be prose on exactly the
   turn that reads the most); (c) Mentor naming the mode on its first step and the kit swapped mid-turn (real loop
   surgery). A seeded build is risk-based from its first turn.

## Built (2026-11-01)

- `services/mentorMode.service.js` — `resolveMode` (ledger lens → seed → the read), `makeSetupReader` (Haiku 4.5,
  `CHEAP_MODEL`, one word SETUP / NONE, booked to the user as `mentor`; a failure or any other answer = undecided → the
  whole kit and the prompt's rule), `kitFor` + `THESIS_DROPPED` (13 tools out, 21 kept; the tools-cache breakpoint moves
  from `get_derivatives_context` to `get_market_hours`).
- `mentorBuild.util.js` — `switchLens` and the `switch_lens` op (`sanitizeBuildOps` → `switchLens`, applied first in
  `applyBuildOps`, which returns `switched`). The size is re-claimed as the user's (held); a handed-back spans/entries
  gate is the user's again.
- `mentor.agent.service.js` — the kit per turn; `_buildModeSection` (`MODE:` in the turn context, before the ledger);
  `_forNewLens` on a switch (renamed from `_withoutLevels` in the CR below); `_buildSeedSection` says risk-based for every hand-off and ignores a lens from an old client;
  `mode` / `modeSource` / `switchedTo` on the turn log.
- Prompt — § Two modes (new), the opening's lens line and reading ladder per mode, § When the plan is already theirs
  widened to a half-made idea with the lens among three, § The thesis lens step 1 (a bare name or Argus: direction
  proposed, a short allowed and said to test badly).
- Argus — `recommended_mode` out of `scanner_system_prompt.md` (Phase 3 + the list JSON), `scanner_mode_handoff.md`,
  `_normalizeKairosPick`, `_cleanCandidate` (with `_feasibleMode` and its floor), `scanSeed.util`, `chain/contracts.js`,
  `chain/rules.js`. Frontend: `hotlistHandoff`, `handoffTurn`, MainPage's saved-list hand-off.
- Tests — `tests/unit/mentorModes.test.js` (16); the lens tests in mentorAgent, thesisLens, scannerScore,
  scannerProfiles, scannerHandoffMode, analystAgent rewritten to the new rule. Suite 4775/0 (talosRecorder excluded).

## Code review (2026-11-01)

`/code-review high main...feat/mentor-modes` — 10 candidates, 9 real; 8 fixed in eacf2be, one held:

1. **A switch settled a lens nobody agreed to.** A switch to the user's setup now only RECOMMENDS the lens (claimed by
   Mentor, the settlement taken back — the opening waits on their yes); a switch to thesis is their yes and stays settled.
2. **The switch turn into their setup has the risk-based kit.** Mentor names the lens and draws the new levels NEXT
   turn, on the whole kit (MODE line + § Two modes, per direction) — rather than guessing pattern levels without the tools.
3. **The old pace survived** — Talos would read a thesis setup on a discretionary ladder. 4. **The old conditions,
   read mode and rejects survived**, and the old rejects blocked the new gate's. `_forNewLens` clears all of them unless
   this turn drew them again; thesis gets its own 1h / 4h.
6. **A hand-off could flip on turn two** — the seed rides the first request only, and the cheap read then saw Argus's
   words as the user's setup. The hand-off claims `thesis` on the ledger on turn one, on a stub that carries the lens.
7. **The read held the first token** — now beside the venue fetch, with the turn's abort signal and an 8s timeout.
8. **Off the list was not off the map** — `handlersFor` drops the dropped tools' handlers ("no handler" if called).
9. **The switch was judged against the name active BEFORE the turn** — now against the name the turn writes to.

Held: **#10** — the empty-reply retry is in the OpenAI-compat loop only; the Anthropic loop has none (no empty seen on
Claude, which has barely run since Luna became the house model). DONE 2026-11-01 on fix/anthropic-empty-reply: the same one ask, tools off, riding the tool results (the API takes no empty assistant turn).

**Re-driven after the fixes, 2026-11-01 19:10 — 16/16** (drive-mentor-modes.mjs).

## Open

- **A setup brought mid-build on the risk-based kit.** The read runs only while there is no lens, so a user who brings a
  setup in turn 4 is heard by Mentor (the prompt says switch) on the risk-based kit for that one turn; the next turn
  has the whole kit. Running the read on every risk-based turn would close it for a fraction of a cent a turn — not done.
- ~~**The Hotlist's This week catalyst read** told Mentor to build the take-profit at Prometheus's swing target.~~
  DECIDED 2026-11-01 (Roy: "when building with Mentor in this week — Mentor will find the target"): his target is
  context, the take-profit is Mentor's from the chart (`_buildSeedSection`).
- **Driven 2026-11-01 — `scripts/drive-mentor-modes.mjs` 15/16** (Luna, axl_dev). The Hotlist hand-off carried no lens
  and ran risk-based from the seed with no pattern tool; the user's own idea switched it to `discretionary` and the next
  turn had the whole kit; a typed bare name was read as no setup (risk-based, no pattern tool); a typed setup was read
  as the user's, Mentor recommended `discretionary`; "your way" switched it to `thesis` and the next turn ran on the
  risk-based kit. The one FAIL: the bare-name turn came back EMPTY (`replyLength 0`) after eight tool calls, so no
  worksheet and no lens claim — the mode itself was right. Not from this change: the same empty reply after a tool loop
  is in the log on 2026-10-31 and through October. Fixed on its own branch (fix/compat-empty-reply 0c5d637, merged here):
  one extra round, tools off, when a round after tools lands empty. **Re-driven 2026-11-01 18:45 — 16/16**; no empty
  reply came up, so the retry itself is proven by unit tests only.
