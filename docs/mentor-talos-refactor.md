# Mentor + Talos — refactor plan

Status: **Phases 0-5 BUILT** (2026-07-31). 1502 tests green.
Phase 0 = the audit fixes · Phase 1 = the condition model + Mentor's gate · Phase 2 = the shared
monitor tool kit (`monitoring/assessTools.js`) + symbol scope + per-wake cost · Phase 3 = the
validity gate, the fire-once latch, and `edit` finally firing a card (A4).

Phase 4 = A3 (zone→exit orders: **D1 far edge, D2 equal split**) + A2 (poll past-entry, journal the
fill). **Still not built, and not pretended:** in-position management (re-reading the thesis,
scaling, moving stops) and the CLOSE journal line — the reconciler flips a closed setup to 'closed',
which drops it out of the polled statuses before Talos sees it, so the exit is recorded by the
trades ledger and not by the journal. Both want the same in-position brain.
Supersedes the `watch[]` taxonomy in `docs/setup-entity.md` §3/§8. Everything else in that
contract stands.

Phase 6 (§10) is **designed, not built** — a price zone becomes a *scenario* that owns its own
conditions, stops, targets and validity range. It supersedes the flat `entry_zones`/`stop_zones`/
`tp_zones` **as the authored shape**; those three stay as the execution projection.

---

## 1. What changes, in one paragraph

A setup stops declaring *typed factors* and starts declaring **conditions in plain text**, each
with an id and a weight. Talos stops mounting a hand-rolled subset of tools and starts drawing
from the shared registry, so it can check any condition against any symbol on any timeframe.
Mentor becomes the gate that makes sure every condition is *checkable* — either by a hard test or
by discretion the user explicitly handed over. And a setup gains a **validity range**, so Talos
has something to say when price is nowhere near a zone.

The through-line: **the setup is the instruction sheet; Talos is a trader reading it.** Today the
code tries to pre-digest the instruction sheet into an enum, then renders that enum back into
prose for the model anyway (`_watchBlock`). The taxonomy buys nothing the model needs — it exists
only to gate which tools get mounted, and that gate is what's making conditions uncheckable.

---

## 2. The condition model

### 2.1 Shape

```js
conditions: [
  { id: 'c1', text: 'orderblock touch at 100',            weight: 'primary'    },
  { id: 'c2', text: 'close above ma20 on the 15m',        weight: 'primary'    },
  { id: 'c3', text: 'FDA approval on the cancer drug',    weight: 'confirming' },
  { id: 'c4', text: 'NVDA weak intraday — below VWAP',    weight: 'confirming' },
]
```

Free text carries the condition. `id` and `weight` are the only structure, and both earn their
keep:

- **`id`** — the per-condition ledger. Talos returns `{id, met, note}` so a verdict maps back to a
  specific declared condition, the UI can render it line by line, and two wakes are comparable
  ("c3 flipped"). Today's `factors[]` keys on `kind`, and two conditions can share a kind, so the
  mapping is already ambiguous.
- **`weight`** — `primary` | `confirming`, unchanged in meaning.

`kind` is deleted. `WATCH_KINDS`, `watchKinds()` and `declaredKinds()` go with it —
`watchKinds()`'s only consumer is a test.

### 2.2 Checkability is Mentor's job, not Talos's

Mentor must not save a condition it cannot describe a way to observe. When it hits one, it asks
the user, and there are **two** acceptable answers:

| user says | result |
|---|---|
| "weak = below VWAP" | a hard test — met/not-met is a fact |
| "weak = how the price action looks" | discretion the user **explicitly handed over** — a mandate |

Both are fine. Mentor is eliminating only the third case: **vague by accident**, where neither the
user nor Talos ever decided which of the two it was. "If the Fed pivots" doesn't survive the
question; it either becomes "a cut at the September FOMC" or it's dropped.

This mirrors an invariant Mentor already holds — *"no honest invalidation = no setup"*. Same
shape: **no observable test = not a condition yet.**

Store the outcome so Talos knows which mode it's in:

```js
{ id: 'c4', text: '…', weight: 'confirming', mode: 'measured' | 'discretionary' }
```

`mode` is Mentor's record of the conversation, not a re-derivation. It changes only the journal's
voice and the confidence attached to a failed check — *"NVDA below VWAP — met"* is a fact,
*"NVDA looks heavy, lower highs since the open — calling it weak"* is a read. It does **not** gate
the verdict.

### 2.3 Discretion is not a defect

Two traders look at the same chart and disagree about strength. Talos pulling an intraday chart,
judging, and reaching for another rung when unsure is the job working — not variance to engineer
away. The only real defect is a condition with **nothing to observe**, and §2.2 removes those at
build time.

### 2.4 A resolved condition stays resolved — `persistence`

Conditions are two different species, and the difference is temporal, not topical:

| | | re-check? |
|---|---|---|
| `latching` | an **event**. "FDA approval on the cancer drug." Once true it stays true | no, once met |
| `live` | a **state**. "close above ma20", "NVDA weak", "OB touch at 100". True *now*, can flip next candle | every wake |

Re-checking a latched event is waste; re-using a cached live state is wrong. Same mechanism,
opposite answers — so Mentor stamps which at build, in the same conversation that establishes
checkability (*"once the FDA approves, that's permanent — yes?"*).

```js
{ id: 'c3', text: 'FDA approval on the cancer drug', weight: 'confirming',
  mode: 'measured', persistence: 'latching' }
```

Talos records what it resolved:

```js
monitor_state.conditions: {
  c3: { met: true, at: '2026-07-31T14:02Z', note: 'Approved Jul 30 — priority review',
        source: 'web_search' }
}
```

Per wake: `live` → always re-check · `latching` + already met → **skip the tool call, but feed the
stored fact into the prompt as established** · `latching` + not yet met → re-check.

**This is correctness, not cost.** Where it bites: after a zone trip with a `wait` verdict the
setup stays `looking` with `armed_zone_id` set, so while price *sits* in the zone Talos re-assesses
on cadence — every 2–15 min intraday. A `web_search` re-run at 14:02 and 14:07 can return different
results, and the model can talk itself out of a fact it already established. A settled condition
that un-settles because search results shifted is a bug, and a miserable one to reproduce.

Three rules:

- **Skipping must not be silent.** Feed `c3: MET on Jul 30 — approved` into the prompt. Omitting it
  shows the model three conditions instead of four, and it concludes the setup isn't ready.
- **Latch scope = the setup's lifetime.** "FDA approval" is permanent; "gapped up on the open"
  latches only for today. v1 keeps one scope and Mentor phrases conditions so it holds. Add
  session-scoped latches only against a real case.
- **Clear on revise.** A plan rewrite already disarms the setup. Preserve a resolved condition only
  when its `id` **and** `text` are unchanged; otherwise clear, so a finding can't ride onto a
  reworded condition.
- **Journal the flip.** `"c3 met — FDA approved the cancer drug"` as its own line, when it happens.
  That is the thing the user actually wants to watch, and nothing surfaces it today.

---

## 3. The validity range

### 3.1 Why

Today Talos has nothing to say when price is far from every zone: the cheap path emits *"price is
outside my zones, checking back in 30m"* forever. A false-break-down setup at 100 is not merely
"not triggered" when price is at 88 — it's **dead**, and the user should hear about it.

### 3.2 Shape

Mentor authors, at build:

```js
validity: {
  lower: 96, upper: 104,          // outside this on a CLOSE → the setup is invalid
  approach: 106,                  // the away-pivot: "ran away, not coming"
  timeframe: '1hr',               // which rung's close decides
  on_break: 'revise' | 'close' | 'notify_only',
}
```

**Three outcomes, not two.** More zones / accept a revise ping — *and* let it die. Some setups
should not generate homework. `on_break` is authored, never assumed.

### 3.3 The asymmetry (do not flatten this)

For a long false-break at 100, the two edges mean different things:

- **below `lower`** → invalidation. Structure broke the other way. The premise is gone.
- **above `approach`** → *ran away, not coming*. The setup was never wrong; you missed it. Chase
  or drop is a different question with different copy.

Pre-entry watches both edges. In-position, only the adverse one — the TP owns the favourable side.

### 3.4 Coherence with the stops — new, nothing checks this today

A long with stop 97 and `validity.lower` 95 is incoherent: at 96 the setup reads "valid" on a plan
that is already dead. Add to `setupReadiness`:

- long: `validity.lower` ≥ the stop zones' far edge (mirrored for short)
- `approach` must sit **outside** the envelope (the existing invalidation monitor already warns and
  ignores when it doesn't)

Block Generate with a named reason, same as every other readiness gate.

### 3.5 Lift these three decisions before `invalidation.monitor.js` is deleted

`monitoring/invalidation.monitor.js` solved this for the legacy `idea` kind and is now dead code
(it was called from Minos; Minos was archived 2026-07-29 and is not started). It is **not** a
drop-in — it emits condition-tree leaves for Minos's parser and setups have no trees. Lift the
decisions, not the code:

1. **Close, not touch.** A wick through the line must not kill a setup.
2. **Fire-once latch.** `invalidation_status`; edit re-arms, dismiss clears. Without it, price
   oscillating on the boundary spams the user. This is the bug this design would otherwise ship.
3. **`drifting` vs `fired`.** Soft (running the wrong way, still alive) vs latched (awaiting the
   user). Already in `vocabulary.js` as `INVALIDATION.DRIFTING/FIRED` with
   `INVALIDATION_EDGES = ['lower','upper','time']` — kind-blind, so a setup needs no new state.

`valid_until` is simply the `'time'` edge of the same axis. Talos stamps **which** edge fired.

### 3.6 One out-of-zone mechanism, not two

Hermes's momentum pulse (`_shouldPulse`) fires an out-of-zone re-map read on a material move —
the same trigger with a different threshold and outcome. Building both gives setups two
out-of-zone mechanisms. Instead:

> arithmetic envelope break (free, every wake, latched) → **one** paid read → an `edit` proposal → card

That collapses pulse + invalidation + edit into a single path, and it uses the `edit` verdict
that is **already in Talos's menu, already persisted, and currently fired at nobody** (§6, A4).

---

## 4. Talos draws from the shared registry

### 4.1 The fork

`services/agentTools.registry.js` holds ~40 tools behind `toolsFor(spec)`, and they take a
**ticker**:

```
get_orderblocks -> ticker, timeframe        get_quotes       -> tickers
get_indicators  -> ticker, timeframe, …     get_correlations -> tickers
get_structure   -> ticker, timeframe        web_search, get_upcoming_events, get_sec_filings, …
```

`hermes.assess.js` hand-rolls `_chartTool` / `_structureTools` / `_smcTools` /
`_institutionalTools` — copies of registry tools with the **ticker removed** (hardcoded to
`call.asset` in `_handleAssessToolUses`) and the timeframe clamped to a ladder enum. Talos imports
those. Handlers are forked the same way: `buildKairosToolHandlers()` already returns a name→fn map,
but the monitor re-implements dispatch as a switch.

So "verify a correlated name" and "verify a news event" are impossible **only** because of a fork
one layer down. Both halves — schemas and handlers — already have a shared home. This is the
CLAUDE.md one-mechanism rule applied where it currently isn't.

### 4.2 Changes

- Build the monitor's tools with `toolsFor(spec)`; build handlers off the same map the agents use.
- **Symbol scope:** `{setup.asset} ∪ {symbols Mentor extracted from the condition text}`. Mentor
  extracts at build into `referenced_symbols` (cap 6, as `normalizeWatch` already caps). Free text
  can name anything; the fetch budget must stay bounded by the setup.
- **Ladder becomes a hint.** `_validChartTf` hard-rejects any rung outside ±2 of the authored
  timeframe today, so "NVDA weak intraday" on a swing setup can't be checked. Registry tools take
  any timeframe — stop clamping; keep the ladder as the suggested primary view.
- **Drop `MAX_TOOL_ROUNDS` in dev** (currently 3 — four conditions across two symbols won't fit in
  three anyway). Decision: **do not cap while developing** — let it reach for what it wants and
  measure what it actually does, then set the ceiling from observation rather than from a guess.
  The loop is still bounded by `CHECK_TIMEOUT_MS` (90s) and by the zone gate, so an unbounded round
  count can't wedge the monitor. Re-introduce a cap before any unattended/production run.
- **`gatherFor` collapses** to the always-on base — chart + candles + price + `event_risk` — and
  everything else becomes on-demand. Today it pre-fetches news/market/positioning for every
  declared kind whether the model would have looked or not.

### 4.3 Two failure states, kept apart

| state | meaning | when |
|---|---|---|
| *(none — Mentor blocked it)* | the condition can never be checked | build time, §2.2 |
| `unchecked` | I couldn't check it **this wake** | provider down, empty `web_search`, symbol won't quote |

`unchecked` must never score as met. A `primary` condition that is `unchecked` is reported in the
verdict and in the journal; whether it blocks entry is **Decision D3** below.

---

## 5. What we lose

`watchKinds()` exists so the UI can say *"this setup costs one chart + candles"* before you save
it. With free text the cost isn't known until the model runs. In exchange `gatherFor`'s
speculative pre-fetch disappears — today it pulls headlines on every wake for any setup declaring
`news`, whether the model would have looked or not — so on-demand is likely **cheaper** in
practice. What rises is variance, not spend.

This is also inherent, not fixable: you cannot have *"Talos reaches for another timeframe when it
has doubt"* and *"the cost is known in advance"* at the same time.

**Replace prediction with observation.** Record per wake what was actually called into
`monitor_state` (tool names + count), and surface the running average — *"this setup has averaged
4 calls per wake over 30 wakes."* More useful than a build-time estimate, and it sharpens over time
instead of being a guess frozen at Generate. The ceiling, when we add one, comes from this data
rather than from a guess (§4.2). `SetupSummary` has to change anyway once it renders conditions
instead of a kind list, so that panel's claim changes with it.

---

## 6. The audit — Talos is Hermes with pieces missing

Independent of the redesign; correct either way.

| # | sev | what | fix |
|---|---|---|---|
| A1 | HIGH | pre-active branch writes `status:'waiting'` + a wake time, but `ACTIVE_STATUSES=['looking']` → the doc can never be re-selected. Any future `active_from` **orphans the setup permanently** after one journal line | write only the schedule, as Hermes does |
| A2 | HIGH | Talos polls `['looking']`; Hermes polls `[...ACTIVE, ...POSITION]` and routes past-entry to `_checkPosition`. Talos's journal **stops dead at the entry card** | poll past-entry statuses |
| A3 | HIGH | **a confirmed setup places a naked entry.** `routeExits()` reads `stop_condition_tree`/`tp_conditions` (idea shape); a setup has `stop_zones`/`tp_zones` → no `nativeExit`, `placeExits` no-ops, entry order carries no SL/TP. Nothing outside schema/CRUD/prompt/`toWatchRow` reads those zones | zone→exit-level adapter feeding the existing `nativeOrders` path |
| A4 | MED | only `enter` fires anything. `edit` is persisted and swallowed; an `enter` on an expiry review with no zone falls through to a bare persist | fire on `enter\|edit\|let_expire` + latch, as Hermes does |
| A5 | MED | no past-expiry terminator — `_isExpiring` stays true forever, so an expired setup pays a **full LLM assessment every wake** | port `_effectiveVerdict` |
| A6 | MED | no momentum pulse. Tell: `setups.service.js` inserts `pulse_anchor_px` at the **doc root**, Hermes reads `monitor_state.pulse_anchor_px`, Talos references it nowhere — field copied, mechanism not | subsumed by §3.6 |
| A7 | LOW | `_persist` swallows write errors; the `broker:{$ne:null}` comment claims it matches a missing field — it does not (missing ≡ null ≡ excluded), so a venue-less setup is invisible with no log line | let errors bubble; fix the comment |
| A8 | BUG | `toWatchRow._firstZone` reads `z.low`/`z.high`; **both** normalizers emit `lower`/`upper` → `nearestEntry`/`stop`/`firstTp` are null on every setup **and call** row, incl. the agent-facing list | one-line fix |

Not a gap: the FE renders a "Talos journal" off `monitor_state.timeline` and a `setup-card__memo`,
and `getSetup` applies no projection. An empty panel means an empty timeline.

---

## 7. Sequencing

**Phase 0 — stop the bleeding.** A1, A5, A7, A8. Pure bug fixes, no design dependency, land first.

**Phase 1 — the condition model.** `setup.schema.js`: `watch[]` → `conditions[]` with ids, `mode`
and `persistence`, drop `WATCH_KINDS`. Add `validity` + `referenced_symbols`. Extend
`setupReadiness` with §3.4. Mentor prompt: the checkability gate, latching-vs-live, the validity
range, the three `on_break` outcomes. *FE (separate repo): `SetupSummary` renders conditions +
range; `ZoneEditor` unchanged.*

**Phase 2 — Talos reads text.** Swap the hand-rolled tools for `toolsFor()` + the shared handler
map. Symbol scope, ladder-as-hint, no round cap (§4.2), `gatherFor` collapse, the `unchecked`
state, per-condition `{id, met, note}` output, the `monitor_state.conditions` latch (§2.4), and
per-wake call accounting (§5). Rewrite the system prompt around "the conditions are your mandate."

**Phase 3 — the second gate.** Arithmetic validity check in the cheap path. Latch via the existing
`INVALIDATION` vocabulary. `edit` → proposal → card (closes A4). `drifting` vs `fired`.

**Phase 4 — through the position.** A2 (poll past-entry) + A3 (zone→exit adapter). Do these
together: A2 without A3 means Talos watches a position it never protected.

**Phase 5 — DONE, but NOT as a merge.** The original plan said fold Talos into Hermes. That was
wrong, and building Phases 0-4 is what showed it: the two monitors' JUDGMENT diverged further, not
less (Talos gained the validity gate, the condition ledger and cost accounting; Hermes has the
in-position brain, re-entry and the momentum pulse). Merging the loops would mean an adapter layer
plus kind-branching in the decision path — the thing CLAUDE.md's own nuance warns against: *share
the pipe, not the judgment.*

What was actually duplicated was the **housekeeping**, and that is now extracted:

- `monitoring/readinessGates.js` — the pure clock/arithmetic chores: too-early, expiring,
  past-expiry, the verdict-vs-clock reconciliation, verdict→status, gap clamping, graded cadence.
- `monitoring/dueLoop.js` — find what's due, claim it against a lease, check it under a timeout,
  and the journal-appending write. The claim is the subtle part (`withTimeout` abandons but cannot
  cancel, so without a lease a still-running check is re-selected and double-fires a card).

Both monitors keep their own prompt, verdicts, cards and brains. Where they genuinely disagree the
difference is now a PARAMETER rather than a second implementation, so it stays visible:

| | Hermes (call) | Talos (setup) |
|---|---|---|
| cadence fallback when no next check is named | lazy (ceiling) | eager (floor) |
| verdicts spared by the past-expiry cutoff | `enter`, `edit` | `enter` |
| a zero-width zone | not a band → lazy cadence | an exact level → measured |

`tests/unit/readinessGates.test.js` pins those three so neither can be "tidied" into the other.

This is the same shape as `assessTools.js` from Phase 2: shared kit and dispatch, per-consumer
descriptions and scope.

---

## 8. Decisions needed from you

| | decision | recommendation |
|---|---|---|
| **D1** | Stop-order price = **near** edge of the stop zone (first touch) or **far** edge? | far — matches `computeRR`'s worst-edge pessimism, gives the zone room to be a zone |
| **D2** | TP leg quantity when `tp_zones[].quantity` is unset — equal split, or full size per leg? | equal split, residue to the first — the rule the idea side already uses (`_assignSlotQuantities`) |
| **D3** | A `primary` condition not met (or `unchecked`) — hard veto in code, or the model's judgment? | model's judgment. Hard-coding cuts against `feedback_agent_decides_no_hardcoded_rules`; a `primary` miss is already stated in the prompt as "this is not the moment" |
| **D4** | Default `on_break` when the user doesn't say | `revise` — but Mentor must ask, not silently default |
| **D5** | Whose close decides a validity break — authored, or the ladder's coarse rung? | authored, defaulting to the coarse rung. An intraday wick must not kill a swing setup |

D1 and D2 are Phase 4 and don't block Phases 0–3.

---

## 9. Tests

- **Schema:** conditions normalise + keep ids; `mode`/`persistence` default safely (`live` when
  unstamped — re-checking is the safe default); unknown fields dropped; validity coherence vs stops
  (both directions); `approach` inside the envelope rejected.
- **Talos pure:** validity gate arithmetic; latch fires once across repeated breaks; `drifting` →
  `fired` transition; past-expiry terminator; pre-active reschedules **without** demoting (A1).
- **Condition persistence (§2.4):** a met `latching` condition is not re-checked on the next wake
  **and still reaches the prompt as established**; a met `live` condition IS re-checked; a resolved
  condition survives a no-op patch but clears when its text changes; an `unchecked` result never
  persists as met.
- **Talos IO (injected deps, no network):** a 4-condition text produces tool calls against both the
  own asset and a referenced symbol; a failing provider yields `unchecked`, never `met`; a wake with
  no cap still terminates within `CHECK_TIMEOUT_MS`.
- **Execution:** `stop_zones`/`tp_zones` → `nativeOrders` at the chosen edge; multi-TP quantities;
  a setup confirm places SL/TP (the A3 regression, which nothing covers today).
- **Snapshot trap:** `tests/fixtures/agentTools.snapshot.json` asserts every agent's tool array
  verbatim, in order, including `cache_control`. Adding the monitor as a registry consumer will
  break it — regenerate deliberately, and re-read the equivalence-harness method in the memory note
  before doing so.

---

## 10. Phase 6 — a price zone is a scenario

Status: **BUILT + LIVE-VERIFIED** (2026-08-03) — backend 1800 green, frontend 322 vitest + 164 node
green, both committed. `scripts/verify-mentor.mjs --persist` finished with **no findings**: two rival
scenarios, generate → arm → live tick → in-zone `wait` holds and posts nothing → in-zone `enter`
fires the RIVAL premise, stamps its stop and its own size, and persists a placeable paper order plan.

**What is left, and it is not part of this phase** (tracked as TODO #18 / #19):

- **Scaling in** — several entries inside ONE scenario. The shape is reserved (`entry_zones[]` per
  scenario, already summed by `scenarioQuantity`); readiness refuses more than one until execution
  can fire per leg, because `_applyVerdict` places the scenario's whole size in one shot.
- **In-position management + the close journal line.** `_checkPosition` writes the fill line and
  parks; nothing re-reads the thesis, scales, or moves a stop. And the reconciler flips a closed
  setup to `closed` before Talos's next wake, so the journal goes quiet exactly when the trade ends.

### 10.1 Why

Ask the question the current shape can't answer: a long at 100 on a **false break** and a long at
104 on a **break and go** are not two legs of one entry. They are two premises that happen to share
a ticker and a direction — different triggers, different stops, different death lines. One
root-level `conditions[]` checked at whichever zone price reaches will grade the breakout against
the false break's trigger, and mean it.

The code has been leaning this way already: `armed_zone_id` exists precisely because *which zone*
is meaningful state. Scenarios give it something to own.

### 10.2 Shape

```js
scenarios: [
  { id: 's1', name: 'false break',
    entry_zones: [ { lower: 99, upper: 100.5, quantity: 100 } ],   // v1: exactly one
    conditions:  [ { id:'s1c1', text:'sweep of the 100 low then reclaim on the 15m',
                     weight:'primary', mode:'measured', persistence:'live' } ],
    stop_zones:  [ { lower: 96,  upper: 96.8 } ],
    tp_zones:    [ { lower: 106, upper: 107 } ],
    validity:    { lower: 95.5, approach: 104, timeframe: '1hr', on_break: 'revise' },
    quantity: 100, rr: 2.1 },                                      // both server-derived

  { id: 's2', name: 'break and go', entry_zones: [ { lower: 104, upper: 104.6, quantity: 60 } ], … },
]

conditions: [ … ]   // ROOT — true of the setup regardless of which scenario prints
```

**Why `entry_zones[]` and not a single `entry`.** A scenario mirrors the flat triple exactly, so the
projection (§10.3) is a copy of three keys rather than a shape change, the legacy wrap is trivial,
and scale-in later means *more entries inside one scenario* with no schema churn. The distinction
that matters is the one the arrays encode: **within** a scenario, entries are legs (they sum);
**across** scenarios they are rivals (they never do). Readiness refuses more than one entry zone per
scenario in v1, since execution still fires once for the scenario's whole size.

**Conditions stay two-tier.** Root = setup-wide truths (the FDA approval, the regime read).
Scenario = that premise's own trigger. A wake checks `root ∪ armed scenario's`. When both scenarios
genuinely share everything, Mentor authors it once at the root and the scenarios carry none — so
"the same conditions twice" costs nothing and is never copied.

**The ledger stays ONE map**, `monitor_state.conditions`, keyed by condition id. Ids are unique
across the doc, so a `latching` event resolves once no matter which scenario armed. The per-scenario
view is a group-by, not a second store. A per-scenario ledger would let a settled fact disagree with
itself — the exact failure §2.4 exists to prevent.

**Validity is per scenario** (§3 unchanged in meaning, moved). Each premise has its own death line:
the false break dies below 95.5, the breakout dies somewhere else entirely. The setup as a whole
closes only when **every** scenario has broken; while one survives it stays `looking`. `on_break` is
still authored per scenario, so one premise can be `revise` and the other `close`.

As built, that is three pieces:

- **`monitor_state.scenarios.<id>`** — the per-premise invalidation latch (`fired` / `drifting`,
  edge, reason, timestamp). It lives in monitor state, not on the scenario, because `scenarios` is
  the AUTHORED plan and a monitor must not rewrite what the user wrote. `fired` drops a premise out
  of the gate (`liveScenarios`); `drifting` leaves it armed — price can come back.
- **`rollUpBreaches`** — the document's own axis, decided by what is LEFT standing. Nothing is
  written while a rival is alive; when the last one falls, **that** scenario's `on_break` decides
  whether the setup closes. `drifting` rolls up the same way and never closes anything.
- **The projection follows the survivors.** If the premise the document was projecting dies while
  another stands, the flat fields are re-stamped onto the first survivor — otherwise the confirm
  dialog, the watch row and the FE would keep advertising a dead plan's levels.

The invalidation card names the premise and says what survived ("the *false break* way into your
LONG NVDA is no longer valid… your other scenario is still armed"), because the old copy — *"your
setup is no longer valid"* — is simply false when a rival is still live.

### 10.3 The rule that keeps this from becoming spaghetti

> **`scenarios[]` is the authored + monitored model. The flat triple is the execution projection,
> written from the winning scenario at arm time.**

`entry_zones` / `stop_zones` / `tp_zones` are **not** setup-private — they are the vocabulary the
`call` kind uses too, and the kind-blind consumers read them flat: `routeSetupZones`
(`protectionPlan.service.js:145`), `tradeCapture`, `monitorJournal`, the order plan
(`orderPlan.service.js:78` reads the doc's `quantity`). So when a scenario fires, stamp its entry /
stop / tp zones and its quantity onto those fields and **execution, capture, the reconciler and the
trades ledger stay untouched.**

That projection also settles the double-count that is live today: `totalQuantity` **sums** the entry
zones (scale-in semantics) while Talos fires **once for the doc's full quantity** (alternative
semantics), so two rival zones of 100 place 200.

**Decided (user, 2026-08-03): one entry per scenario, at the WHOLE position size.** Scenarios are
rivals, not legs — the first to fulfil takes the full trade and the others die. So:

- `totalQuantity` is **deleted**, not deferred. Nothing sums zones any more; summing was the bug.
- `scenario.entry.quantity` **is** the position. Two scenarios may size differently (the false break
  gets 100, the worse breakout entry gets 60) — they're independent numbers, never added.
- The doc's `quantity` is the **armed** scenario's; pre-arm it reads the nearest live scenario's,
  the same rule the row uses (§10.6), so the confirm dialog and the panel can't show a size the
  order wouldn't place.
- Scale-in — several entries inside *one* scenario — stays out of scope. When it lands it is `entry`
  becoming an array **within a scenario**, and it does not disturb this rule: the scenario still
  owns one position, its legs still sum to that position, and rival scenarios still never add.

Three seams, and no fourth:

1. **One shape at the top.** Nothing outside `setup.schema.js` asks "does this doc have scenarios?"
2. **One projection at the bottom.** The stamp at arm, described above.
3. **One legacy adapter.** `normalizeSetup` wraps a pre-scenario doc (root zones, no `scenarios`)
   into a single implicit scenario `s1` carrying the root conditions and the root validity. Every
   other module reads scenarios only. Delete the wrapper once no such docs remain — and if there are
   none in Mongo when this is built, skip it entirely rather than writing compatibility for nobody.

### 10.4 Rewrite, don't patch (three pure functions)

These already score one plan against a mixed bag and get worse, not better, if extended:

- `computeRR` — per scenario, worst entry edge vs that scenario's nearest TP. The doc-level `rr`
  becomes the armed scenario's (pre-arm: the nearest scenario's).
- `validityProblems` — per scenario: floor vs *that* scenario's stop far edge, `approach` outside
  *that* envelope.
- `setupReadiness` — presence moves down a level: every scenario needs an entry zone, a stop zone,
  its own whole-position quantity, and at least one condition **counting the root tier** (a scenario
  with no trigger of its own is legitimate when the root carries it; a setup with no condition
  anywhere is not). Report the failing scenario by name, not a bare reason — with two scenarios
  "missing stop zone" is ambiguous.

### 10.5 What changes, by file

| file | change |
|---|---|
| `services/setup.schema.js` | `normalizeScenario`/`normalizeScenarios`; `validity` + `conditions` move inside; the three rewrites in §10.4; the one legacy wrapper |
| `monitoring/talos.monitor.service.js` | `zoneGate` iterates scenarios → `{scenario, zone}`; `armed_scenario_id` beside `armed_zone_id`; the validity gate runs per scenario and the setup closes only when all have broken; on fire, the projection stamp + the losing scenarios marked dead |
| `monitoring/talos.assess.js` | `_conditionsBlock` = root ∪ armed scenario, and the prompt **names** the scenario, so the read is "the false break, not the breakout" |
| `api/setups/setups.service.js` | generate/patch over the nested shape |
| `services/entity/toWatchRow.js` | §10.6 |
| `services/tradeNotify.service.js` | the invalidation card names the premise + what survived |
| `mentor_system_prompt.md` | authors scenarios; the checkability gate is unchanged, applied per scenario; must ask which premise a level belongs to instead of accumulating zones |
| FE (separate repo) | **NOT DONE — §10.8.** `ZoneEditor` groups by scenario; `SetupSummary` renders scenario blocks |
| — | **no change:** `protectionPlan`, `orderPlan`, `execution.reconciler`, `tradeCapture`, `monitorJournal` |

Three defects found in the bug hunt on this phase's own code, all fixed and test-locked:

1. On an **expiry review** there is no armed scenario, so the recorder judged the root tier alone
   while the assessment had shown the model the projected scenario — every answer keyed to that
   scenario's conditions was dropped as hallucinated. `_applyVerdict` now falls back to
   `pickScenario`, matching what `assessSetup` asks.
2. A **dead premise stayed projected**, so the flat levels kept advertising a plan nobody watches.
3. `carryConditions` read the **root tier only**, so an in-position light edit (a thesis reword)
   silently wiped every latched *scenario* condition. It now carries both tiers (`allConditions`).

### 10.6 The row shows every scenario

`setupToWatchRow.detail` gains:

```js
scenarios: [ { id, name, entry:{low,high}, stop:{low,high}, tp:{low,high}, rr, armed:false } ]
```

`nearestEntry` / `stop` / `firstTp` / `rr` stay, pointing at the **armed** scenario, else the
nearest live one. They are not redundant back-compat: `userData.tools._zone` reads those keys, and
an agent asking "where is my NVDA setup" wants one answer, not a menu. The array is what makes
"I have two ways into this" visible at all.

### 10.7 Tests

- **Schema:** scenarios normalise, ids stable, a scenario with no conditions is valid when the root
  has them; readiness names the failing scenario; per-scenario `computeRR` and validity coherence
  (both directions); a legacy root-zone doc becomes exactly one scenario with the root's validity.
- **Talos:** the gate picks the scenario price is actually in; the assessment prompt carries the
  armed scenario's conditions and NOT the rival's; one scenario breaking validity does not close a
  setup whose other scenario is alive; all broken → closed.
- **Projection:** on fire, the flat triple and `quantity` equal the armed scenario's — and
  `routeSetupZones` produces that scenario's stop/tp legs unchanged (the regression that guards
  "execution never learned about scenarios").
- **Quantity is never summed:** two scenarios of 100 and 60 place 100 or 60, never 160 — the bug
  that is live today, asserted in both directions (armed s1, armed s2).
- **Ledger:** a `latching` condition declared at the root resolves once and is not re-checked when a
  different scenario arms.

### 10.8 The FE (botmarket-frontend, DONE 2026-08-03 — 319 vitest + 164 node green, lint clean)

The trap this section used to describe: once a draft carries `scenarios`, `normalizeSetup` reads
**scenarios** and ignores the flat zones (they are output, not input) — so an edit written to the
flat zones looked accepted in the panel and was **silently discarded on Generate**. Closed by making
the editor scenario-shaped rather than by special-casing the seam.

| file | change |
|---|---|
| `ZoneEditor.jsx` | takes a **scenario**, hands back a scenario. New zone ids are scoped to it (`s2t2`) so they stay unique document-wide. The entry group refuses a SECOND zone — that is a second scenario, not a second leg — and the affordance is simply not offered |
| `ConditionList.jsx` *(new)* | the instruction sheet as prose + the three tags that change how it is judged. ONE component, two tiers (setup-wide and per premise) |
| `ScenarioBlock.jsx` *(new)* | one way in: name, entry, its own r:r and size, armed/dead badges, its zones, its conditions, its validity line |
| `SetupSummary.jsx` | renders the setup-wide conditions once, then a block per scenario, plus "+ another way in". Writes into `scenarios[i]`, never into the projection |
| `SetupPage.jsx` | the pop-out renders every premise (armed / dead) with its own levels and conditions; the flat zones are deliberately not drawn beside them |
| `SetupCard.jsx` · `CandidatePicker.jsx` | show the projected levels **plus** "+N more ways in", so one set of numbers never reads as the whole plan |
| `ChatWindow.jsx` (`EntryConfirmBubble`) | names the premise that fired, from the card's new `scenario` payload |

**Also fixed here, stale since Phase 1:** `SetupSummary` and `SetupPage` were still rendering
`watch[]` — the taxonomy Phase 1 deleted — so the panel had been showing nothing at all where the
conditions should be. Both now render `conditions`.

Not converted, deliberately: `chartOverlay.js` draws the **projection's** zones (the armed premise,
else the primary). Drawing every rival's entry/stop/target on one chart is a legibility question,
not a correctness one, and it wants a look at the real thing before choosing.
