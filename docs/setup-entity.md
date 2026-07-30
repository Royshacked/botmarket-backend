# `setup` — the 4th entity kind

The user's own trade, built with **Mentor** and watched by **Talos** — a zone gate
plus a setup-driven assessment. Replaces the condition-tree `idea` for all NEW builds.

**Mentor** (agent) builds a **setup** (entity) that **Talos** (monitor) watches.

*Mentor* is the name from the Odyssey — the trusted counsel Odysseus leaves behind,
whose form Athena takes to guide Telemachus. It fits the contract exactly: Mentor
analyses, proposes, pushes back and refines what the user brought, then hands the
decision back. It never fires a trade and it never blocks one.

*Talos* is the bronze guardian given to Minos, circling Crete three times a day — a
tireless fixed-rotation patrol that reacts only when something crosses the perimeter.
A poll loop with a zone gate, inherited from the monitor it replaces.

Per ENTITY_MODEL.md §8: adding a kind = new payload + evaluator + prompt + card,
zero plumbing change. This doc is the payload + evaluator contract.

## 1. Why a new kind, not a new `idea` schema

Old `idea` and new `setup` coexist (strangler). Existing tree-ideas — including
live `long`/`short` positions — keep running on the current Minos path until they
close out naturally; then that path is deleted. Nothing in flight migrates.

| | `idea` (legacy) | `setup` (new) | `call` |
|---|---|---|---|
| levels | exact points, condition trees | **zones** | zones |
| trigger | tree evaluates true → fire | zone trip → **assess** → fire | zone trip → assess → fire |
| what's monitored | the leaves | the **declared** factors | four fixed axes |
| built by | Idea (retired) | **Mentor** | Kairos |
| authored by | agent, from user's words | **the user**, refined by the agent | the agent |

`setup` vs `call` is authorship. A call is the desk's recommendation; a setup is
the user's own trade. Same monitoring machinery, different origin — and the setup
only analyses what its author declared, where a call always scores all four axes.

## 2. Envelope (shared — services never read past this)

```
id · kind:'setup' · userId · parentId:null · status · owner:'talos'
monitor_state { next_check_at, check_count, memo, timeline[] }
executionBinding { broker, accounts[], mainAccountId, brokerSymbol,
                   basisOffset, orderState, brokerOrders[] }
cards · sizing { unit, requested, resolvedQty } · payload
```

`owner` is derived from kind. Gate anchors (`armed_zone_id`, `pulse_anchor_px`)
live in the payload, per ENTITY_MODEL §7.4 — `monitor_state` stays kind-agnostic.

**Execution reads RAW camelCase off the doc**, not through an adapter (the P3b
lesson from calls). So `direction`, `quantity`, `status`, `broker`, `brokerSymbol`,
`basisOffset`, `brokerOrders[]` must exist flat on the setup entity. The reconciler
is already kind-blind (matches `status ∈ [long,short]` + `brokerOrders`), so a
setup that reaches a position reconciles with no reconciler change.

## 3. Payload

```jsonc
{
  // ── server-stamped at Generate — NEVER agent-authored ──
  "mode":       "live" | "paper" | "manual",   // derived from the marked account
  "broker":     "ctrader" | "paper" | "manual" | null,
  "accounts":   [ … ],
  "event_risk": [ { "date": "2026-08-04", "label": "NVDA earnings",
                    "when": "after_hours", "impact": "high" } ],
  "cadence":    { "min": 30, "max": 240 },     // minutes, derived from type+timeframe
  "ladder":     ["4hr", "1hr", "30min"],       // derived from timeframe, coarse→fine

  // ── agent-authored ──
  "asset":       "NVDA",
  "asset_class": "stock",
  "direction":   "long",
  "type":        "intraday" | "day" | "swing" | "long term",
  "trade_mode":  "classical" | "smc",
  "timeframe":   "1hr",
  "active_from": null,                          // trade from — nullable
  "valid_until": "2026-08-08T20:00:00Z",        // trade to  — nullable

  "thesis": "Sweep of the 238 shelf that fails and reclaims, semis holding up.",

  "watch": [
    { "kind": "structure",   "look_for": "sweep below 238 that closes back inside, then CHoCH up",
      "timeframe": "15min", "weight": "primary" },
    { "kind": "correlation", "look_for": "SMH leading, not diverging",
      "symbols": ["SMH"], "weight": "confirming" }
  ],

  "entry_zones": [
    { "id": "ez1", "lower": 237.8, "upper": 238.6, "quantity": 100, "note": "the shelf" },
    { "id": "ez2", "lower": 233.0, "upper": 234.2, "quantity": 50,  "note": "deeper OB scale-in" }
  ],
  "stop_zones": [ { "id": "sz1", "lower": 234.8, "upper": 235.9, "quantity": 150 } ],
  "tp_zones":   [ { "id": "tp1", "lower": 246.0, "upper": 247.2, "quantity": 75 },
                  { "id": "tp2", "lower": 252.0, "upper": 253.5, "quantity": 75 } ],

  "conviction": { "level": "medium", "score": 0.6, "rationale": "…" },
  "rr":         2.1,                            // planned — worst-edge (see §6)

  // ── monitor-owned ──
  "armed_zone_id":   null,
  "pulse_anchor_px": null
}
```

Field notes:

- **`thesis`** is what the assessment verifies. Prose — the user's setup in words.
- **`timeframe`** is the one the user/agent chose. `ladder` is derived from it
  (±2 rungs, clamped, coarse→fine) and **locks** the enum the monitor's tools may
  request — so it can change timeframe within the plan, not wander to a monthly
  chart on an intraday setup.
- **`cadence`** clamps the assessment's self-chosen `next_check_min`. Derived, not
  authored: intraday 2–15m · day 5–60m · swing 30–240m · long term 240–1440m.
- **Zone quantities** sum to the position. Multiple entry zones = scale-in (all
  armed; whichever trips first acts). Multiple TP zones = multi-leg exits.
- **`conviction`** is frozen at build and never recomputed by the monitor
  (data-vs-judgment: judgment crosses via persisted artifacts, not live re-derivation).
  It modulates assessment strictness — see §5.
- No condition trees. No leaves. Nothing in this payload is a `ConditionNode`.

## 4. `watch[]` — the switchboard

This is what makes the setup cheaper than a call. The assessment mounts **only**
the tools its `watch[]` declares; an undeclared dimension is never fetched.

| `kind` | monitor fetches |
|---|---|
| `price_action` | chart image + candles, `get_orderblocks`, `get_false_breaks` |
| `structure` | `get_structure` / `get_fvg` / `get_liquidity` — the same engine it was built on |
| `correlation` | live quotes for the named `symbols` only |
| `market` | SPY / QQQ / ^VIX |
| `news` | headlines for the ticker |
| `positioning` | `get_short_interest` / `get_options_context` / `get_derivatives_context` |
| `fundamental` | `get_fundamentals`, `get_sec_filings` |

No `news` factor → no headline fetch. No `market` factor → no index quote. A purely
structural setup costs one chart + candles per wake.

`trade_mode` biases which structural toolkit a `price_action`/`structure` factor
mounts (classical → orderblocks/false-breaks; smc → the numeric SMC engine) and
injects the matching lens instruction, mirroring `_modeLensBlock`.

**One always-on exception: `event_risk`.** A frozen date list stamped server-side by
`eventRisk.service.js` — a lookup, not an LLM axis. It's the only thing that catches
what the setup *couldn't* declare (earnings landing mid-hold). Everything else opt-in.

## 5. Talos — the monitor contract

New service `monitoring/talos.monitor.service.js`. Minos is untouched and keeps
running the legacy `idea` kind until those drain, then is deleted; Talos polls
`kind:'setup'` only, so the two never contend.

```
poll 60s → setups where next_check_at ≤ now, status ∈ [waiting, watching]

  claim (lease next_check_at forward — double-fire guard)
  ├─ active_from in the future?   → sleep until it opens
  ├─ within 15m of valid_until?   → EXPIRY REVIEW
  ├─ market closed?               → sleep until open
  └─ fetch price

  price inside an entry_zone?          ← GATE 1 (arithmetic, free)
    no  → reschedule, tightening as price nears the nearest zone
    yes → ASSESS                       ← GATE 2 (the heavy read)
            enter → build the order plan → status 'ready' → card
            else  → status 'watching', no card, look again on Talos's cadence

  ASSESS — mounts only the watch[] tools, judges against `thesis`:
    verdicts: enter | wait | stand_aside | edit | let_expire
    → memo carried forward · next_check_at (self-chosen, clamped to cadence)
```

**The entry gate is the SETUP, not the zone.** This is the Hermes shape: the cheap
arithmetic gate says price is *where* the setup lives, which is what makes an
assessment worth paying for; the assessment says whether the setup actually
*happened*. That second gate is what `watch[]` exists for.

Only an `enter` verdict — "this is the moment" — asks the user to confirm an entry.
A `wait` / `stand_aside` / `edit` read means the setup has not fulfilled, so no card
fires: asking someone to confirm an entry Talos just declined is not advice, it is
noise. The read is still recorded on the setup (assessment, memo, timeline), so the
objection is visible without interrupting anyone.

**A trigger builds its order plan in the same step it flips to `hit`.** `pendingOrder.plan`
+ `orderState` are what the execution path actually places; a `hit` without them opens the
confirm dialog onto nothing. Manual (broker-less) setups skip the plan and get the fill
card instead; a closed market parks at `awaiting_market` and defers the card to the open.

**Conviction sets strictness.** A high-conviction setup gets the benefit of the doubt
on a marginal read; a low-conviction one needs everything lining up before the read
reads clean. One line in the assessment prompt.

**At `valid_until`: expiry review**, like Hermes — `enter` (it finally looks good) /
`edit` (roll it forward with new levels) / `let_expire`. Never a silent auto-close.

Statuses: `unarmed` (persisted, NOT monitored) → `waiting` (armed) → `watching` (price
is inside a zone, setup not yet fulfilled) → `ready` (plan built, awaiting confirm) →
`long`/`short` → `closed`. Talos polls `waiting` **and** `watching`.

**`waiting` → `watching` → `ready` is the SAME ladder a Kairos call runs.** A setup and
a call are the same shape of thing — a plan armed against zones, assessed by a monitor,
surfaced for a decision — so they say it with the same words. The one divergence is
`unarmed` in front: a call is live the moment it is saved, whereas Generate and Arm are
two separate acts for a setup and only the second starts Talos spending.

`ready` carries more than a call's does: a setup's order plan is stamped in the same
write, which is why its card routes straight to the order dialog while a call's routes
to its pop-out. `ready` is NOT past-entry — nothing is at the broker until the user
confirms, so a ready setup stays freely re-plannable and deletable. `hit` remains in the
allowed set for the kind-blind execution path (a manual fill, a forced trigger) but Talos
never writes it.

`watching` exists because the zone is only the first gate: price can sit inside a zone
for hours while the setup fails to fulfil, and that state has to be both visible and
still polled. Price leaving the zone drops it back to `waiting`.

The legacy `idea` kind keeps its own older spelling of armed (`looking`) and is
deliberately NOT migrated — it is draining, and re-spelling a live money path to match a
naming convention is not worth the risk.

**Arming is the real gate.** Only from `waiting` does Talos spend price fetches and
assessments, so `PATCH status:'waiting'` re-runs the full Generate check — a setup whose
broker disconnected after Generate is refused rather than polled forever. A pre-position
plan rewrite disarms back to `unarmed`: the plan Talos was watching no longer exists.

## 6. Execution boundary — where a zone becomes a price

A zone is a *judgment band*. Brokers have no order for "somewhere between 237.8 and
238.6", so at the boundary a zone resolves to a point:

- **Entry** — the fill price at confirm. Software-monitored; no resting entry order.
- **Stop** — on fill, a hard stop rests at the broker at the stop zone's **far edge**
  (the side away from entry). The zone wakes the monitor to judge whether the break
  is real; the resting order is the failsafe if the server is down or an assessment
  fails. An unattended position is never protected by a poll loop alone.
- **Targets** — each TP zone rests as a real closing order at its **near edge**.

**Planned `rr` is computed from the worst edge of the entry band**, never the
midpoint — a 237.8–238.6 zone against a 235 stop is 2.8R of risk at the near edge
and 3.6R at the far one, and the plan should advertise the pessimistic fill.

**Live `rr` is recomputed at card time** from the actual price against the stop and
first target, and shown next to the planned one: *"planned 2.1R; entering here gives
you 1.4R."* Pure arithmetic, no LLM.

## 7. Pipeline — Mentor is the trade ASSISTANT

Mentor gets its **own pipeline**, not a slot in Pipeline B.

```
Pipeline F — ASSIST     Axl → Mentor → setup → Talos
Pipeline B — TRADE      Axl → Argus → Kairos → call → Hermes
```

The difference is where the trade comes from. Pipeline B is the desk *finding* a
trade: Argus screens, Kairos makes the call, the user receives it. Pipeline F is the
user arriving **with a trade already in mind** and Mentor assisting — which is why
Mentor never screens and never scans. **The ticker always comes from the user.** No
Argus hop, no Analyst hop.

That single fact settles a lot: no `<scan_request>` block, no discovery hand-off, no
"find me a ticker" routing. If the user has no name in mind they belong in Pipeline B,
and Mentor says so and points at Axl rather than growing a screener.

Mentor returns to Axl when the setup is generated, on the shared return beat
(`agentMeta.RETURN_MS`, "Heading back to axl") — same as every other specialist.

### Editing a saved setup (wired 2026-07-29)

The pencil on a setup card / Floor row reopens **the conversation that built it**, exactly as the
call pencil reopens the Kairos chat. Three rules make that work, and they matter in this order:

1. **Generate persists `chat_state`** — `{ messages, draft, coverage }` — so an edit restores the
   conversation, the worksheet AND the coverage chips. A setup saved before this existed rebuilds
   its worksheet from the document; the user edits a real setup, just without the reasoning.
2. **A mid-edit turn saves the CONVERSATION only** (`PATCH /api/setups/:id { chat_state }`).
   Routing it through `generate(updateId)` would re-run the readiness gate, re-bind the venue from
   the currently-marked accounts, and send a watched setup back to `waiting` — Talos would stop
   watching a live setup because the user asked a question about it.
3. **"Update setup" writes the plan** (`generate` with `updateId`), which re-arms: pre-entry the
   setup drops to `waiting` and must be armed again, because the plan Talos was watching no longer
   exists. In position it is a LIGHT edit (context fields only) and never disarms.

The pencil is offered pre-entry only. Past entry it is disabled — mid-trade changes go through the
management cards, not a re-run of the build conversation.

## 8. Reuse — share the pipe, not the judgment

Build directive: **reuse the existing shared design wherever a mechanism already
exists.** Per CLAUDE.md, share the *pipe/shell* — never the *judgment/content*.
Mentor's prompt, lens, card copy and `watch[]` reasoning are its own; everything
below is plumbing it inherits unchanged.

**Backend**

| need | reuse |
|---|---|
| model routing | `modelRouter.service.js` **classifier mode** — no `PHASE_TABLES` entry (Mentor has no phases; `axl: {}` is the precedent) |
| agent scaffolding | `agentUtils.js` — `makePromptLoader`, `resolveAgentStream`, `buildAccountLines`, `makeToolHandler`, `COMMON_TOOL_HANDLERS` |
| market tools | `marketData.tools.js` — quote / candles / earnings / chart / indicators handlers |
| SMC toolkit | `smc.tools.js` — `SMC_TOOLS` + `SMC_TOOL_HANDLERS` (same engine at build AND at assess) |
| structure vision | `priceStructure.tools.js` — `makeStructureVisionHandler`, `OB_VISION`, `FB_VISION` |
| emit-tag capture | `llmStream.util.js` — `buildTagCaptures` |
| assessment runner | `hermes.assess.js` — `_runAssessment`, `_chartTool`/`_structureTools`/`_smcTools`, `_validChartTf`, `_handleAssessToolUses`, `_thinkingConfig`. **Extract the shared runner; do NOT fork it.** Talos supplies its own system prompt + a `watch[]`-driven tool set |
| poll loop | `monitorUtils.js` — `createPollLoop`, `withTimeout`, `fetchCandles`, `extractFirstJSON` |
| event risk | `eventRisk.service.js` (already server-stamped) |
| notifications | the unified notification service — `postBotCard` / `cardActions` shell; Mentor writes its own card copy |
| persistence | `entityRepo` + `entityCollection.js` |
| execution | `orderPlan.service.js`, `execution.reconciler.js`, `exitOrders.util.js` — already kind-blind, **zero change** |
| market hours | `market.service.js` — `isAssetOpen`, `sessionPhase` |

**Frontend**

| need | reuse |
|---|---|
| input row (mic + send/stop/resume + clear) | `ChatInputRow.jsx` — one shared style for every agent; pass `prefix="mentor"` |
| Whisper dictation | `useMicInput.js` → `POST api/transcribe` |
| streaming | `sse.util.js` — `postSSE`, `buildStreamHandlers` |
| user prompt | `userPrompt.service.remote.js` — **parameterize the endpoint** rather than forking the file (it hard-codes `/api/idea/stream`); `clientTimeContext()` comes along |
| model / reasoning / routing selectors | `ModelSelector`, `ReasoningSelector`, `modelOptions`, `reasoningOptions`, `routingModeOptions` |
| chat rendering | `ChatBubble`, `ChatMarkdown`, `ChatReasoning`, `UserMsg`, `ToolStatusChip` |
| buttons / modal / status | `Modal.jsx`, `StatusIcon.jsx`, `ConvictionChip`, existing button classes |
| accounts | `ChatPanel/AccountSelector.jsx` |
| threads | `ThreadHistory` |
| hub + return-to-Axl | `AxlHub/agentMeta.jsx` — add a `mentor` entry to `AGENTS`; `SUMMON_MS`/`RETURN_MS` and the summon/return beat come free |
| edit mode | the existing TradeIdeas edit panel — reuse the shell |

**Genuinely new FE work** (no existing component covers it): the **zone editor**
(bands with quantities, replacing the leaf/condition editor), the **coverage chips**
that replace `ChatPhaseHeading.jsx`, and the **setup card/detail** renderer.

## 9. Open

1. **Agent route + key.** Canonical agent keys today are `idea`/`portfolio`/`scanner`
   with brands UI-only (`/api/idea/stream`). Mentor either keeps the `idea` key and
   rebrands, or gets its own `mentor` key + route + `modelRouter` entry. A new key is
   cleaner given the kinds coexist, at the cost of a parallel controller.
2. **Does the legacy Idea agent survive?** Nothing needs to *build* new tree-ideas, so
   Mentor replaces it outright. But existing tree-ideas are still editable through the
   old panels — decide whether editing stays live or freezes to view-only while they
   drain.
3. **The multi-setup offer** (2–3 candidates the user picks from) — structured emit
   block + FE cards, or prose in chat. Unresolved from the flow design.
4. **FE.** `ConditionTree.jsx` renders leaves; a setup has zones. New card + detail
   renderer, and the setup/idea kinds render differently in the list.
