# Talos per-candle — build plan

**STATUS: BUILT 2026-09-17** (phases 0–6). The desk docs caught up the same day: the monitor
CONTRACT is now the Talos section of [desks/mentor-talos.md](../desks/mentor-talos.md#talos), and
this file stays where it is as the BUILD RECORD — the plan, the decisions, and what the build
settled differently. It superseded the wake model in `desks/talos-guards.md` (merged into
[desks/mentor-talos.md](../desks/mentor-talos.md#guards--exact-prices-not-bands) on 2026-09-19)
(the three-tier escalation and the time term on guards) and the in-position gate in mentor-talos.md;
both carry SUPERSEDED callouts pointing here.

**What the build settled beyond the plan:**

- **Open decision A resolved without an interim.** A pending entry leg is judged by the setup's
  ENTRY conditions (root ∪ scenario) — the same mandate the first leg was taken on — so on a
  conditional setup every pending leg is watched and read per candle. `watchedLegs(setup,
  scenario, entry)` takes the setup for that reason. Only a `limit` setup, which declares nothing,
  has a plain pending leg with nothing to read; resting those as limits stays a follow-up.
- **The "never add while adverse" code guard went with `positionGate`.** Whether a second leg
  is taken while the trade presses its stop is now the read's judgment, held by the prompt
  ("never to rescue a trade that is going against you") and by the rule that `add_leg` needs a
  watched pending leg actually printing. Worth knowing if that reflex ever needs to come back as
  code.
- **A partial's size is the leg's.** Talos names the watched target by id; the monitor resolves
  `{ leg, quantity, size_pct }` from the zone, so the model never emits a fraction. The old
  `third|half|two_thirds` dialect and `FRACTION_PCT` are gone.
- **A re-drawn plan forgets its last read** (`monitor_state.last_assessment` cleared on a
  pre-position edit), so the first read of the new map is a `first_look`.
- **A `hit` limit setup keeps the expiry clamp** on its next read — only a live position is exempt.
- **The pop-out shipped as `SetupPlan.jsx`, not `SetupExits.jsx`.** Entry AND exits per scenario in
  one component (every leg tagged rests | watched, the live numbers merged into Exits once in
  position), with `SetupPlan.test.jsx`. Phase 6 below keeps the plan's name.

The phase sections keep the PLAN's names. Where a name below is marked deleted, it is gone; where
it names something new, the built symbol may differ — the contract doc has the built names.

## The rule

**Talos spends a model call only on a condition the user wrote in words.** Pre-entry that is always
true — the entry trigger is the condition — so Talos reads on every candle close of the rung it is
watching, plus any time a price guard fires. In position it is true only for a leg the user made
conditional: a plain stop or target is an order at the broker and nobody reads it.

**Every read opens cheap.** The model is handed the numbers — the last candles on its rung, the
price, its memo, what it armed — and nothing else. The chart, the indicators, the structure reads,
the correlations, the web are TOOLS it calls when the numbers cannot answer. What a read costs is
the model's own decision, per read.

## Today → after

| | today | after |
|---|---|---|
| when the model runs, pre-entry | zone hit · price guard fired · expiry · never read | **every candle close on the rung** · price guard fired · expiry |
| when the model runs, in position | price gate (adverse / near target / +1R) · scale zone · periodic review | **only if a watched leg exists**, then every candle close · price guard |
| what a read opens with | chart PNG + candles + ref quotes | candles + ref quotes (**no image**) |
| guards | time AND price, plus a mandatory backstop | **price only** — the candle close IS the timer |
| pace | `cadence{min,max}` by horizon, clamped | the rung the model asked to open on next (`next_timeframe`) |
| a quiet wake | free arithmetic, no read, sometimes a journal line | does not exist — every wake reads, every read journals |
| journal | `monitor_state.timeline[]`, capped at 50, oldest→newest | own collection, uncapped, newest-first, one row per read |
| management verdicts | hold · let_run · add_leg · take_partial · move_stop · exit_now, always on the menu | hold + only what the watched legs allow |

## Decisions

Taken, so the build does not re-open them:

1. **Guards lose the time term.** `{after_min}` existed because the timer was the only other wake.
   With a read on every candle close a conditional timer is the candle, and the backstop is the
   candle. A guard is `{price, direction, means}` and nothing else. Deletes `BACKSTOP`, `after_min`
   clamping, `guardFires`'s elapsed clock, `last_read_at` as a guard clock, the `skipped` counter.
2. **`cadence` is deleted.** The rung is the pace. `CADENCE_BY_TYPE`, `buildCadence`, `clampGap`,
   `reviewDue`, `_minGapMs`, `_maxGapMs`, `_reschedule` all go. `usableLadder` (±2 rungs of the
   authored timeframe, `1min` never) is what bounds how fast the model may ask to be read.
3. **The journal moves out of the setup document.** The timeline rides on the envelope every list
   fetch carries; at one row per candle it cannot stay embedded, and a cap contradicts "describe
   every call". One `journal.service` owns append and list; the setup keeps a pointer-free
   `monitor_state` (memo, guards, next_check_at, timeframe, last_assessment, cost).
4. **The model default stays Sonnet, thinking off** (`assessRouting`). The saving is the image and
   the tokens it dragged in, not the model; the judgment still has to be good. The user pref
   override stays.
5. **Which legs are watched is a pure function of the document** — `watchedLegs(setup, scenario)`:
   the stop if it carries conditions, each target that carries conditions, each pending entry leg
   that carries conditions. It is the one predicate for "does this position earn reads" and the one
   source of the verdict menu. Nothing else may decide either.
6. **A conditional stop keeps its resting stop-market** (already `routeSetupZones`'s rule). A
   conditional target does not rest (same). Unchanged, restated because the whole in-position
   design leans on it.
7. **Non-read wakes do not journal.** `market_closed` lines go (a swing wrote one per night).
   `pre_active` writes once. The fill line (`entry`) and the close line (`exit`) stay — they are
   events on the trade, written by code, and the journal is the trade's record.

Open — flagged in the phases where they land, decided before that phase starts:

- **A. Plain-price scale-in legs.** The rule says a plain level is an order, so a second entry at
  244 should rest as a limit. That is multi-leg entry placement, which the order layer does not do
  today (`entry_mode:'limit'` places one leg). INTERIM in this plan: a plain pending leg is a
  price guard code arms (`means:'entry'`), and the read on its firing may `add_leg`. It is still a
  read on a level the user wrote. Resting legs are a follow-up.
- **B. Read lag.** A candle-close read has to wait for the provider to have the bar. `READ_LAG_MS`
  starts at 30s; `dueLoop` polls at 60s, so the real lag is 30–90s. Measure, then set.

---

## Phase 0 — shared mechanisms

Two mechanisms more than one caller needs. Built first, alone, tested alone.

### 0.1 `market.service.nextCandleCloseMs(symbol, assetClass, rung, nowMs)`

The one place "when does the next `rung` candle close for this instrument" is computed. Session
aware through what is already there (`sessionFor`, `sessionStartMs`, `isAssetOpen`,
`getMarketStatus`):

- intraday rungs (`5min`…`4hr`): aligned to the session start for session-bound instruments
  (equities, futures, forex), to UTC midnight for crypto. A close that lands after the session end
  is the session end.
- `day`: the session close. `week`: the last session close of the week. `month`: of the month.
- market shut now → the first close of the next session.
- returns `ms`, and the caller adds `READ_LAG_MS`.

Pure given `nowMs`. Tests per instrument class and rung, including "shut now" and "a 4hr rung on a
6.5h session".

### 0.2 `services/journal.service.js`

```
appendJournal(entityId, entry)            → insert { entityId, ...entry }
listJournal(entityId, { before, limit })  → newest first, cursor on `at`
```

Collection `journal`, index `{ entityId: 1, at: -1 }`. No cap, no TTL: a setup lives weeks and
its history is the point. Callers, all of which today `$push` into `monitor_state.timeline`:

- `dueLoop.makePersist` — the monitor's write. Drops `timelineMax`; `$set` the patch, then
  `appendJournal` when an entry is given.
- `entityRepo.finalizeClose` — the close line, currently via `withJournal`.
- `execution.reconciler` — builds the `exit` entry (already through `journalEntry`), hands it to
  the above.

`monitorJournal.withJournal` and `JOURNAL_MAX` are deleted. `toEnvelope` / `envelope.js` /
`setups.service` create stop carrying `timeline`.

---

## Phase 1 — the schema: what a setup carries

`services/setup.schema.js`.

**Delete** `CADENCE_BY_TYPE`, `DEFAULT_CADENCE`, `buildCadence`, the `cadence` key in
`normalizeSetup`, `guardsFromZones`, `BACKSTOP`, `MAX_GUARDS`'s time handling, `mayScaleIn`.

**`clampGuards(raw, setup, price)` → price only.** Keeps: finite price, `direction` in
`GUARD_DIRECTIONS`, `means` in `GUARD_MEANINGS`, the already-true check against `price`, the cap.
Drops any guard without a finite price. No backstop is appended — the candle close is the backstop.

**`guardFires(guard, { range })`** — range only. A guard fires when the range since the last sweep
crossed its level in its direction (`any` = touched).

**New `watchedLegs(setup, scenario)`** → `{ stop, targets[], entries[] }`, each a zone that carries
`conditions.length > 0` (entries: only those not yet filled — `pendingLegs` stays, it is the
"not yet filled" half). Pure. `hasWatchedLegs = (w) => !!(w.stop || w.targets.length || w.entries.length)`.

**New `allowedVerdicts(watched)`** → the management menu: `hold` always; `move_stop` + `exit_now`
iff `watched.stop`; `take_partial` iff `watched.targets.length`; `add_leg` iff `watched.entries.length`.
`let_run` is deleted outright — moving a target OUT is an edit of the plan, not a monitor act.

**`position_state.targets[]` at fill** → `{ price, quantity, watched }`. `hit_at` and `resting` go
(the reconciler's `exitOrders` already knows what filled; the wake level was the TP-window idea).
Readers tolerate the old shape for live docs: `price ?? resting`.

`setupReadiness` is unchanged — nothing new blocks. `referenced_symbols` normalisation is unchanged;
Mentor is told (Phase 5) to extract from exit conditions too.

Tests: `setupSchema.test.js` — the guard cases rewritten (no `after_min`, no backstop), `watchedLegs`
and `allowedVerdicts` table tests, `cadence` cases deleted.

---

## Phase 2 — the read (`monitoring/talos.assess.js`)

Rewritten in place. The tool kit, the runner, `_runRead`, `symbolScope`, `openingRung`,
`_ladderLine`, `_conditionsBlock`, `_otherScenariosBlock`, `_armedLine` survive as they are.

**`gatherFor` → `openingContext(setup, tf)`**: `candlesText(asset, tf)` + reference quotes. No
`renderChart`, no `buildStudies`, no `cachedChartImage` import. `primary` is always a text block.

**One system prompt core, two tails.** Today's two prompts repeat the guards paragraph, the
timeframe paragraph, the output rule and the tone. Extract `_CORE` and append `_PRE_ENTRY` /
`_IN_POSITION`. What the core says, in this order:

1. *You open with numbers, not a picture.* The candles on your rung are in front of you. Call
   `get_chart` when a condition needs a shape the rows cannot show — structure, a pattern, a
   discretionary read. Do not call it to confirm what the rows already say. Every tool call is
   money the user is paying for this read; spend it on the condition that needs it.
2. *You will be read again at the next `{rung}` close.* Do not arm a guard for what the next candle
   will show you anyway. Arm guards for what must NOT wait a candle: the level that would make you
   say something different right now.
3. Guards: `{price, direction, means}` only. Rewritten whole each read.
4. `next_timeframe` is the pace: coarser = fewer reads.
5. Conditions are the mandate (kept verbatim from today).
6. Output JSON, one entry per declared condition, `tools` is not something you write — it is
   recorded for you.

`_PRE_ENTRY` keeps today's verdict menu and the `REASON WOKEN` vocabulary, reduced to:
`first_look` · `candle` · `guard` (with the fired guard's `means`) · `expiry_review`.

`_IN_POSITION` is rewritten around watched legs: *you are here because the user made these legs
conditional; judge those conditions; everything else rests at the broker and is not your question.*
The menu line is generated from `allowedVerdicts(watched)` so the prompt never offers a verdict
the monitor would refuse. `take_partial` names a fraction of the watched target's `quantity`, not
of the position. The stop paragraph stays: it always rests; you may only tighten.

`_wakeReason` (adverse / scale_out / breakeven / review) is deleted with the gate that produced it.

**`_runRead` returns `_tools`** (rename of `_calls`, same array) — the journal row needs it.

Tests: `talosMonitor.test.js` / `talosPosition.test.js` cover the read through injected deps; the
prompt-assembly tests assert the menu line follows `watchedLegs` and that no image block is built.

---

## Phase 3 — the monitor (`monitoring/talos.monitor.service.js`)

Rewritten, not patched — the file is 1,050 lines of which roughly half is the machinery this plan
deletes. Target ~450. `talos.gates.js` shrinks with it.

### Pre-entry — `_checkSetup`

```
no venue            → skip                                    (unchanged)
pre_active          → sleep to active_from, journal once      (unchanged)
entry_mode 'limit'  → the limit path, no read                 (unchanged)
market shut         → next_check_at = nextCandleCloseMs(rung) — no journal line
price · validity    → _checkValidity, code, free              (unchanged)
READ                → always
apply verdict       → next_check_at = nextCandleCloseMs(rung) + READ_LAG_MS, guards, journal row
```

`reason` = `expiring ? 'expiry_review' : woke ? 'guard' : !last_assessment ? 'first_look' : 'candle'`.

`hit` (which scenario is on the table) keeps both resolutions — `scenarioGate` on the spot price,
`_hitFromGuard` on the fired guard — because `enter` is only honoured against a zone, and the
crossing that paid for a guard wake must not be thrown away by a spot check a minute later.

**Deleted:** `needsAssessment`, the quiet branch, `_reschedule`, `wakeReason`, `neverRead` /
`guardFiredPrice`, `_nextCheckAt`'s cadence clamp (replaced by the candle-close call), `last_read_at`
(the journal row's `at` is that fact).

### Past entry — `_checkPosition`

```
'hit' (awaiting fill)   → limit disarm checks, no read, no journal          (unchanged)
first wake after fill   → the fill line, position_state stamped             (unchanged, targets shape from Phase 1)
watchedLegs empty       → monitor_state.dormant = true; return              NEW
market shut             → sleep to next candle close, no journal            (unchanged)
_managePosition         → metrics · READ · verdict ∈ allowedVerdicts · card · journal row
```

`dormant` is a query-level exclusion: the Talos `createDueLoop` filter becomes
`{ broker: { $ne: null }, 'monitor_state.dormant': { $ne: true } }`. A dormant position costs
nothing — not a price, not a poll. `setups.service`'s edit path clears `dormant` whenever a
scenario is written, so a user who adds a condition to a live stop is watched from the next tick.

`_managePosition`: `computeMetrics` stays (R, MAE, MFE feed the read and the UI). The read runs
every wake. `add_leg` is honoured only when `hit` resolves to a watched pending entry zone (the
"never invent size" rule stays in code, not just in the prompt). The scale-in order-plan block
survives as is. `pending_action` + `VERDICT_SEVERITY` (minus `let_run`) survive — card dedupe is
still needed.

**Deleted from the monitor:** `positionGate`, `reviewDue`, `_minGapMs`, `_maxGapMs`, `rearmTargets`,
`_markTargetHit`, `_sameLevel`, `_tpStillResting`, `_manageFallbackNote.let_run`, the
`in_position_idle` branch, the `cadence.max` parking in `_checkPosition`.

**Deleted from `talos.gates.js`:** `positionGate`, `reviewDue`, `_minGapMs`, `_maxGapMs`,
`wakeReason`, `zoneGate` if `_hitFromGuard` + `scenarioGate` cover every caller (verify — the
scale-in zone check moves onto `watchedLegs(...).entries`). Keeps: `scenarioGate`, `_hitFromGuard`,
`liveScenarios`, `scenarioState`, `computeMetrics`, `metricsSet`, the validity trio, the condition
ledger (`normalizeConditionResults`, `latchPatch`), `costPatch`.

### Guard sweep (`guardSweep.service.js`)

Stays the tier-0 it is. **Deleted:** `_skipped` map and the `skipped` stamp on `woke_on`, the
elapsed-minutes arithmetic passed to `guardFires`, `_guardsFor`'s `guardsFromZones` fallback (a
never-read setup is due on arm — `next_check_at: null` — and gets guards within a minute). A sweep
still writes nothing but `woke_on` + `next_check_at = now`.

---

## Phase 4 — the journal row (`monitoring/monitorJournal.js`)

One row per read, and the four code-written events. Shape:

```
{ entityId, at, reason, price, rung, verdict, note,
  conditions: [{ id, met, note }],   // what it checked — from the read
  tools: ['get_chart', ...],         // what it pulled — from _runRead
  fired?: { price, direction, means, armed_at },
  armed:  [guards],                  // what it is waiting for now
  proposal?, warning?, next_check_at }
```

`reason` ∈ `first_look · candle · guard · expiry_review · limit_order · limit_disarmed · entry ·
invalidation · exit · pre_active`. **Deleted:** `market_closed`, `guard_time`, `backstop`,
`scheduled`, `zone_trip`, `momentum_pulse`, `in_position` (the position read is `candle`/`guard`
like any other), `skipped`, `levelsLabel`, `gapMin`, the `axes`/`fetched` fields (Hermes's).

`journalEntry(reason, opts)` stays the one builder; `failNote` and `verdictFallbackNote` stay.

**Route:** `GET /api/setups/:id/journal?before=<iso>&limit=50` → `journal.service.listJournal`,
owner-scoped like every setups route. Controller + route + one service line, no new module.

**Migration** (`scripts/migrate-journal.mjs`, one-off, idempotent): for every entity with a
`monitor_state.timeline`, insert each entry into `journal` with `entityId`, then `$unset` the
array. Legacy reasons are mapped to the new vocabulary on the way (`zone_trip`/`momentum_pulse`/
`in_position` → `candle`, `guard_price` → `guard`, `guard_time`/`backstop`/`scheduled`/
`market_closed` → dropped). Run once after deploy; the FE tolerates an empty journal meanwhile.

---

## Phase 5 — Mentor (`prompts/mentor_system_prompt.md`)

Small, and it must land WITH Phase 3, not before: a Mentor that promises "Talos will watch into
the target" on a build Talos does not read is a lie in the interview.

1. **"Conditions on a stop or a target"** gains the opt-in. At the targets step Mentor asks ONCE:
   *rest it as a limit and let it fill, or do you want Talos watching into it with a rule?* A wish
   to bank partials on the way up IS a target condition, written as one. A plain level is never
   watched — say so, so the user knows what silence buys.
2. **Delete** *"where the monitor starts a conversation about banking early is a guard it arms for
   itself"* — that was the near-target wake, and it is gone.
3. **Interview steps 7 and 8**: "a condition on it is OPTIONAL" becomes "a condition on it means
   Talos reads it every candle; without one it rests and nobody reads it — which do they want?".
4. **`referenced_symbols`** must include names in exit conditions, not only entry conditions.
5. `setup.blueprint.js:170`'s cadence comment goes with `cadence`.

`mentorAgent.test.js`: the worksheet/Generate tests that assert `cadence` on the document go.

---

## Phase 6 — the pop-out (`botmarket-frontend`)

`SetupPage.jsx` right column, top to bottom:

```
[ManagementCard / StaleMapCard]   — waiting on the user; stays above everything
1. Thesis      thesis · conviction · mode · broker symbol
2. Entry       ladder · Always-conditions · per scenario: entry legs + entry conditions (armed/dead as today)
3. Exits       per scenario: stop, targets — each tagged  rests | watched
               in position: the live numbers (fill, R now, MAE/MFE, stop current) merge INTO this block
4. Talos journal
               pinned head: memo · armed guards · next read at · rung   ("where Talos stands now")
               rows, newest first, collapsed: time · reason · verdict · one-line read
               expanded: conditions checked (met/unmet + note) · tools pulled · proposal · guards armed
               "older…" loads the next page through the route
```

**New:** `SetupExits.jsx` (built as `SetupPlan.jsx` — see the top; absorbs `ZoneRow` for exits and everything `PositionPanel.jsx` rendered),
`TalosJournal.jsx` + `useJournal(setupId)` (fetches the route; refetches when
`setup.monitor_state.check_count` changes, which every read bumps — no new socket event).

**Deleted:** `TalosWatch.jsx` + `.scss` + both tests, `PositionPanel.jsx` + `.scss` + test,
`MonitorJournal.jsx` + `.scss` + test (Talos is its only caller — verify `CallPage` does not
import it; the grep says it does not). In `talosWatch.js`: `tiers`, `lastWake`, `ZONE_STANDING`,
`conditionRows` (rows now carry their conditions), `readiness`; keep `watchTimeframe`, `showsWatch`.
In `monitorJournal.utils.js`: keep `tidyPrices`, `firstSentence`, `guardLabel` minus the
`after_min` branch; delete `readEntry`'s legacy tolerance. In `setupManage.js`: `let_run`.

`ZoneEditor` (the open item from mentor-talos.md) is NOT in this plan; it stays as it is.

---

## Phase 7 — tests

Written per phase, per the rule. The rewrites and deletions in one place:

| file | action |
|---|---|
| `tests/unit/marketService*.test.js` | + `nextCandleCloseMs` per class × rung |
| `tests/unit/journalService.test.js` | new: append, list newest-first, cursor |
| `tests/unit/setupSchema.test.js` | guards rewritten; `watchedLegs`, `allowedVerdicts`; `cadence` cases deleted |
| `tests/unit/talosMonitor.test.js` | rewritten against the new `_checkSetup` (every wake reads; candle-close scheduling; reasons) |
| `tests/unit/talosPosition.test.js` | rewritten: dormant on no watched legs; read on watched; menu enforcement; `add_leg` only on a watched entry |
| `tests/unit/guardSweep.test.js` | `skipped`/elapsed cases deleted; range-only |
| `tests/unit/monitorJournal.test.js` | new row shape; deleted reasons gone |
| `tests/unit/dueLoop.test.js` | `makePersist` without `timelineMax` |
| `tests/unit/readinessGates.test.js` | `clampGap` cases deleted |
| `tests/unit/setupsGenerate.test.js`, `mentorAgent.test.js` | no `cadence`, no `timeline` |
| FE `TalosJournal.test.jsx`, `SetupExits.test.jsx` (built as `SetupPlan.test.jsx`) | new; `TalosWatch`/`PositionPanel`/`MonitorJournal` tests deleted |

---

## Everything deleted — the checklist

Backend: `CADENCE_BY_TYPE` · `DEFAULT_CADENCE` · `buildCadence` · `cadence` on the document ·
`BACKSTOP` · `after_min` · `guardsFromZones` · `mayScaleIn` · `clampGap` · `reviewDue` ·
`_minGapMs` · `_maxGapMs` · `_reschedule` · `_nextCheckAt` (replaced) · `wakeReason` ·
`positionGate` · `rearmTargets` · `_markTargetHit` · `_sameLevel` · `_tpStillResting` ·
`in_position_idle` · `let_run` · `_wakeReason` · `gatherFor`'s image · `cachedChartImage` and
`buildStudies` imports in the assess · `_skipped` · `skipped` · `last_read_at` · `JOURNAL_MAX` ·
`TIMELINE_MAX` · `withJournal` · `monitor_state.timeline` · `levelsLabel` · `gapMin` · journal
reasons `market_closed` `guard_time` `backstop` `scheduled` `zone_trip` `momentum_pulse`
`in_position` · `position_state.targets[].hit_at` / `.resting`.

Frontend: `TalosWatch.jsx/.scss` · `PositionPanel.jsx/.scss` · `MonitorJournal.jsx/.scss` ·
`tiers` · `lastWake` · `ZONE_STANDING` · `conditionRows` · `readiness` · `readEntry` legacy
branches · `guardLabel`'s `after_min` branch · `let_run` in `setupManage.js`.

## Docs updated (2026-09-17, same day)

`desks/mentor-talos.md` (rewritten: the Talos section is the contract; the TP window stays as
history) · `desks/talos-guards.md` (SUPERSEDED callouts on the time term, the guard set, the tiers — since merged into mentor-talos.md,
the journal, the kept list; open items 1/2/4/6 closed) · `desks/trade-pipeline.md` (the cascade,
invariants, partials, shared services, in-position as built) · `architecture/monitoring.md` ·
`architecture/entity-model.md` (journal leaves the document; `setup` payload row) · `APP_SPEC.md`
(the setup_manage card, the `journal` collection, the who-watches note) · `CODE_MAP.md` (talos.*,
guardSweep, monitorJournal, journal.service, market.service, api/setups) · `README.md` (flow
diagram, thirteen loops). This file stays in `design/` as the build record rather than moving to
`desks/` — the contract is mentor-talos.md, and two copies would diverge.

## Commit order

0.1 candle close → 0.2 journal service (+ callers, + migration script) → 1 schema → 2 read →
3 monitor + sweep (one commit: the loop and its read change together) → 4 journal row + route →
5 Mentor → 6 pop-out → docs.

Phases 0–1 are safe to ship alone. Phases 2–3 must ship together. Phase 5 must not ship before 3.
