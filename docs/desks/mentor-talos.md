# Mentor + Talos — the `setup` kind

The user's own trade, built with **Mentor** and watched by **Talos**.

> **TALOS READS ON EVERY CANDLE CLOSE (2026-09-17).** The per-candle rebuild
> ([design/talos-per-candle.md](../design/talos-per-candle.md), which stays the record of what the
> build settled) replaced the cadence timer, the guard time term, the in-position price gate and the
> TP window with ONE rule: **Talos spends a model call only on a condition the user wrote in words.**
> Pre-entry that is always true, so every wake reads. In position it is true only for a leg the user
> made conditional; a position of plain levels is DORMANT. The [Talos](#talos) section below is the
> current contract for the monitor. [talos-guards.md](talos-guards.md) still holds the reasoning for
> exact prices over bands and for guards over zones, but its three-tier escalation and its time term
> are gone.
>
> **THE ZONE GATE IS GONE (2026-08-22).** [talos-guards.md](talos-guards.md) replaced it with
> LLM-authored wake guards, and Mentor no longer draws bands — every level is an exact price.
> Sections marked **SUPERSEDED** describe how it used to work and are kept because the reasoning
> still explains the shape of what replaced them.

Replaces `docs/setup-entity.md` and `docs/mentor-talos-refactor.md` (2026-08-08). The refactor doc
already superseded parts of the contract doc — the `watch[]` taxonomy — so the two disagreed with
each other in writing, and both still described the scenario model as designed-not-built when it
had been live-verified since 2026-08-03.

*Mentor* is the counsel Odysseus leaves behind, whose form Athena takes to guide Telemachus. It
fits the contract exactly: it analyses, proposes, pushes back and refines what the user brought,
then hands the decision back. **It never fires a trade and it never blocks one.**
*Talos* is the bronze guardian circling Crete three times a day — a tireless fixed-rotation patrol
that reacts only when something crosses the perimeter.

Per [entity-model.md](../architecture/entity-model.md): adding a kind = payload + evaluator +
prompt + card, and no plumbing change. This is that payload and evaluator contract.

---

## Why a kind, not another `idea` schema

| | `idea` (legacy) | `setup` | `call` (archived) |
|---|---|---|---|
| levels | exact points, condition trees | **exact prices** | zones |
| trigger | tree evaluates true → fire | **a read on every candle close** → `enter` → the user confirms | zone trip → assess → fire |
| what is monitored | the leaves | the **declared** conditions, and only those | four fixed axes |

The two shapes coexist by strangler: nothing in flight migrates, and legacy tree-ideas — including
live positions — run on their own path until they close naturally.

---

## A price zone is a SCENARIO

The load-bearing decision, and the one worth stating first because everything else follows from it.

A setup does not carry three flat lists (`entry_zones` / `stop_zones` / `tp_zones`). It carries
**scenarios**, each owning its own entry, stop, targets, conditions and validity range — because a
level only means something inside a story. "If it breaks 420 I'm long, if it fails at 415 I'm
short" is two trades, and flattening them into one list of zones loses which stop belongs to which
and what price would prove each one dead.

> **RIVALS, NOT LEGS.** The first scenario to fulfil takes the WHOLE trade; the rest die with it.

That sentence is the whole safety property. Quantity is **never summed across scenarios** — summing
them would size the position as if both stories could be true at once, which is exactly the trade
nobody intended. Within one scenario, several entries CAN sum (that is scaling in, and
`scenarioQuantity` reserves the sum for it); across scenarios, never.

The flat zone lists survive only as the **execution projection** (`projectScenario`) — what the
order layer reads once a scenario wins. Authored shape and executed shape are different things.

---

## Conditions — the instruction sheet

Each condition carries a `weight` (`primary` │ `confirming`), a `mode` (`measured` │
`discretionary`) and a `persistence` (`live` │ `latching`).

**A condition is what a read costs, and the only thing that does.** Since the per-candle build a
condition is not merely an instruction Talos judges — it is the reason Talos is running at all. The
entry conditions (root ∪ scenario) are why a pre-entry setup is read on every candle close. A
condition on a stop or a target is why a position is read; without one, every exit is an order
resting at the broker and the position is dormant. Mentor therefore asks the exit question ONCE, at
the targets step: *rest it as a limit and let it fill, or have Talos watch into it with a rule?* A
wish to bank partials on the way up IS a target condition, written as one. Silence buys a plain
level that nobody reads, and the interview says so.

**Checkability is Mentor's job, not Talos's.** Mentor must author a condition Talos can actually
evaluate; Talos is not expected to interpret an unfalsifiable instruction at wake time. A vague
condition is caught at build, where the user is present to sharpen it — not at 3am, where the only
options are guess or stall.

**Discretion is not a defect.** `discretionary` is a first-class mode, not a lesser `measured`. Some
real instructions ("wait for the sellers to give up") are judgments; forcing them into a numeric
threshold does not make them more rigorous, it makes them wrong precisely.

**A resolved condition stays resolved** — that is what `latching` means. Without it a condition that
was true an hour ago and is momentarily false again un-fires the setup, and the user watches their
trade flicker.

`referenced_symbols` covers names in exit conditions too, not only entry conditions — a target
condition written against a peer or an index needs that symbol in scope on the in-position read.

---

## Validity — the range outside which the setup is dead

`validity` bounds where the setup still makes sense, with `on_break`: `revise` │ `close` │
`notify_only`.

**The asymmetry is deliberate — do not flatten it.** Pre-entry, both edges matter: too high is "do
not enter here" just as much as too low is "the thesis broke". In position, only the **adverse**
edge matters, because a favourable move through the far edge is what the targets are for.

There is **one out-of-zone mechanism, not two.** Validity and the old invalidation watcher answered
the same question in two places with two vocabularies.

Validity is checked in code, free, on every wake — before the read, so a breached premise fires its
card whether or not a read would have followed. On a `limit` setup it is the one thing the monitor
checks while the order rests (`_disarmLimit` cancels the order on a breach or at expiry).

---

## Exits — what rests and what is watched

The current rule, in full:

- **A plain stop rests as a stop-market, full size. A plain target rests as a limit.** Nobody reads
  either; the reconciler reports the fill and the close.
- **A conditional stop keeps its resting stop-market** (`routeSetupZones`), and Talos may only
  TIGHTEN it. **A conditional target does not rest** — a limit would fill regardless of what its
  condition said — so Talos owns that leg and proposes when the condition is met.
- Which legs are watched is a pure function of the document — `watchedLegs(setup, scenario, entry)`
  in `setup.schema.js`: the stop if it carries conditions, each target that carries conditions, and
  each pending entry leg (judged by the setup's entry conditions, so on a conditional setup every
  pending leg is watched; only a `limit` setup has a plain pending leg with nothing to read).
- **The verdict menu is derived from the watched legs** — `allowedVerdicts`: `hold` always;
  `move_stop` + `exit_now` iff the stop is watched; `take_partial` iff a target is; `add_leg` iff a
  pending entry is. The prompt offers exactly that menu and the monitor refuses anything off it.
- `position_state.targets[]` is stamped at fill as `{ price, quantity, watched }`, nearest first.
- **R:R measures to the NEAREST target** (`computeRR` → `targetEdges()[0]`) from the pessimistic
  fill. An R:R must never flatter; the nearest target is what the trade pays if the first one is
  the one that gets taken.

### History — the TP window (BUILT 2026-08-15, **SUPERSEDED 2026-08-22**, deleted 2026-09-17)

> Two rounds of supersession, kept for the reasoning. First (2026-08-22, guards) the WINDOW went: a
> target is the price the user named and nothing hangs beneath it, and the room for Talos to propose
> banking early became a guard the monitor armed for itself near the target. Then (2026-09-17, per
> candle) that near-target wake went too: Talos no longer starts a conversation about a target
> because price is close to it. It reads a target only if the user attached a CONDITION to it, on
> every candle close, and the discriminator between "an order" and "a conversation" is that
> condition — not the band's width (the first design) and not a guard's proximity (the second).
> `rearmTargets`, `hit_at`, `resting` and `let_run` were deleted with it; the accept path is below.
>
> Principle 1 is what survived every round, and it now reads both ways: an unconditional level is
> just an order, and a conditional TARGET is the opposite — it does not rest at all.

Four principles, in the user's words:

1. **An unconditional level is just an order.** A plain TP rests as a limit, a plain stop as a
   stop-market, for the full size. No monitoring, no cards, no model call. Talos is only involved
   where the plan actually asked for judgment.
2. **A TP zone is a conversation, not an event.** Price entering the zone wakes Talos, which reads
   the trade and PROPOSES a size — take half, take a third, take it all.
3. **Talos may re-map the exit, not merely size it** — a different TP level, or a conditional exit
   plan in place of the flat one.
4. **Nothing reaches the broker without the user's confirm.** Talos proposes; the tap executes.
   The stop is exempt from all of this: it always rests, full size, unless it carries conditions —
   and conditional stops are deliberately out of scope for now.

**THE TP PRICE IS THE TOP OF THE WINDOW; THE BREADTH HANGS BELOW IT** (user, 2026-08-15). This was
the framing. A tp zone was NOT "the target is somewhere in this band". It was **the target the user
named, plus a stretch of price beneath it in which Talos is allowed to talk.** For a long: the TP
price is the top, the breadth runs back toward entry. Mirrored for a short.

- **The resting limit is the authored TP price** — the far edge, in the direction of travel.
- **Talos wakes at TP − breadth** (long) — the near edge.
- **Do nothing and you get the TP you named.** That is the default outcome, not a degraded one.

**THE WINDOW USED TO BE ZERO WIDE.** `protectionPlan.zoneExitLevel` rested the TP limit on the NEAR
edge — the first edge price touches — and `setup.schema.targetEdges` woke Talos on that SAME edge.
So the limit filled at the exact instant the `scale_out` gate tripped, and "sell only half" was a
proposal about a position that was already flat. Separating the two — the limit at the far edge,
the wake at the near — was the fix; both halves shipped in one commit, deliberately, because
prompt-first would have had every trade exiting at TP − breadth as a silent systematic haircut.

**Where the principles stand now.** 2 is gone — the conversation is opened by a condition, not by
proximity. 3 is half-built: a conditional exit plan IS a conditional target (built); moving a target
OUT is an edit of the plan, not a monitor act, which is why `let_run` was deleted rather than
extended. 4 holds unchanged. The "conditional stops are out of scope" clause of 4 is void: they are
built, and a conditional stop ALWAYS keeps its resting stop-market.

**A TARGET PRICE IS REQUIRED TO GENERATE.** `setupReadiness` lists `target price` under `missing`
for any premise without one. The far edge is a limit order resting at the broker, not an
annotation, and a plan that says where it dies but not where it pays leaves the user in a position
only a stop can end. **This BLOCKS, and that is settled** (user, 2026-08-15, asked and confirmed) —
the opposite of the coverage desk, whose plausibility flags record and never refuse. `windowProblems`
(the breadth bounds) went with the window; there are no bands left to police.

**The accept path.** "Take some off" is `take_partial` — Talos names the WATCHED TARGET by id and
the monitor resolves `{ leg, quantity, size_pct }` from that zone's own size, so the model never
emits a fraction (the old `third │ half │ two_thirds` dialect is gone). The executor closes that
much at market now — banking into strength at the current price is the whole point — and the
reconciler resizes what rests. `move_stop` carries `{ stop, why }` and is translated to the
executor's `{ new_stop }` on the way in.

---

## Talos

**The rule: a model call only on a condition the user wrote in words.** Everything below follows
from it. The record of the build, with what it settled differently from the plan, is
[design/talos-per-candle.md](../design/talos-per-candle.md).

### When it reads

| | pre-entry | in position |
|---|---|---|
| reads | **every candle close** on the rung it is watching | **only if a watched leg exists**, then every candle close |
| ahead of the close | a price guard fires (tier-0 sweep, `guardSweep.service`) | a price guard fires |
| also | the expiry review (exempt from the market-hours gate) | — |
| never | market shut, `pre_active`, a `limit` setup (the order IS the plan) | market shut, awaiting fill, dormant |

The rung is the pace: the model asks for the timeframe it wants to open on next (`next_timeframe`),
clamped to the setup's stored `ladder` (`usableLadder` — its fetchable rungs, `1min` never). The next wake is
`market.service.nextCandleCloseMs(symbol, assetClass, rung)` + `READ_LAG_MS` (30s; `dueLoop` polls
at 60s, so the real lag is 30–90s). There is no `cadence`, no backstop and no quiet wake — a wake
that does not read does not exist, and every read journals.

**Guards are `{ price, direction, means }` and nothing else** — rewritten whole on every read, so
what the model does not re-arm is forgotten. The time term went with the timer: with a read on every
close, a conditional timer is the candle and the backstop is the candle. The prompt tells the model
so directly: *do not arm a guard for what the next candle will show you anyway; arm one for the
level that would make you say something different right now.*

**Dormant is a query-level exclusion.** A position whose every exit is a plain level is stamped
`monitor_state.dormant: true` on its first management wake and drops out of the loop's filter —
not a price, not a poll. An in-position edit that writes a scenario clears the flag, so a user who
adds a condition to a live stop is watched from the next tick. A pre-position edit clears
`last_assessment` instead, so the first read of a re-drawn map is a `first_look`.

### What a read is

**Every read opens cheap.** The model is handed the candles on its rung, the reference quotes, its
memo and what it armed — **no image**. The chart, the indicators, the structure reads, the
correlations and the web are TOOLS from the shared kit (`monitoring/assessTools.js`) it calls when
the numbers cannot answer. What a read costs is the model's own decision, per read, and the tools it
pulled are recorded on the journal row (`tools`), not written by the model.

The two prompts share one core (`_CORE`, in `talos.assess.js`) with a pre-entry and an in-position
tail. The in-position tail is written around the watched legs — *you are here because the user made
these legs conditional; judge those conditions; everything else rests at the broker and is not your
question* — and its menu line is generated from `allowedVerdicts`. The default model stays Sonnet,
thinking off (`assessRouting`); the saving was the image and the tokens it dragged in, not the
model.

### Pre-entry — `_checkSetup`

```
no venue            → skip
past entry          → the position path
pre_active          → sleep to active_from, journal once
entry_mode 'limit'  → the limit path: confirm card on the first open-market wake, no read
market shut         → next_check_at = next candle close — no journal line   (expiry review exempt)
validity            → code, free, always first; a breach fires its card and skips the read
READ                → always.  reason = expiry_review │ guard │ first_look │ candle
apply verdict       → next candle close + lag, guards, journal row
```

Which premise is on the table (`hit`) keeps both resolutions — `scenarioGate` on the spot price
and `_hitFromGuard` on the fired guard — because `enter` is only honoured against a zone, and the
crossing that paid for a guard wake must not be thrown away by a spot check a minute later.

- **The card fires ONLY on `enter`** (and on `edit` with a proposal, which used to change a setup
  silently). Every other verdict is journalled, not notified. A monitor that announces every look
  trains the user to stop reading it.
- **Fire-once** — a tripped setup moves to `hit` and the order plan parks `awaiting_confirm`
  (`awaiting_market` off-hours); it cannot re-fire on the next wake.
- Off-menu verdicts are treated as `wait`. Past `valid_until`, an expiry review that still will not
  commit is forced to `let_expire` so the setup terminates instead of paying for a read forever;
  only `enter` is spared (`_effectiveVerdict`) — a trigger that prints in the final minutes is still
  a real trigger.

### In position — `_checkPosition` → `_managePosition`

```
awaiting fill        → limit disarm checks (expiry, validity), no read, no journal
first wake after fill→ the fill line; position_state stamped (legs, size-weighted fill_price,
                       stop.initial/current frozen, targets nearest-first with `watched`)
watchedLegs empty    → dormant
market shut          → sleep to the next candle close, no journal
READ                 → metrics (R, MAE, MFE) · read · verdict ∈ allowedVerdicts · card · journal row
```

The fill stamp is deliberately AHEAD of the off-hours gate — bookkeeping, not monitoring; no price,
no model, no card — so a setup filled at the close has its `position_state` before the open.

- **The menu is the legs.** An off-menu verdict is a `hold`. A `take_partial` that names no sized
  watched target, a `move_stop` with no level, an `add_leg` whose leg is not a watched pending entry
  actually printing (price at it now, or the sweep saw it reached) — each is a `hold` with a warn.
- **A card fires only when the verdict out-ranks the pending one** (`VERDICT_SEVERITY`: `hold` 0 ·
  `add_leg` 1 · `take_partial` 2 · `move_stop` 3 · `exit_now` 4). A same-or-lower verdict does not
  re-post a decision the user already has in front of them; `add_leg` sits below every protective
  verdict on purpose.
- **`add_leg` builds the order plan for ONE leg** at that leg's size (`legQuantity`) and parks it
  `awaiting_confirm`; `armed_zone_id` moves to the new leg so the fill stamps against the right
  zone. Whether to add while the trade presses its stop is the read's judgment, held by the prompt
  ("never to rescue a trade that is going against you") — the old code guard went with
  `positionGate`. Worth knowing if that reflex ever needs to come back as code.

### The journal

One row per read, in its own collection (`journal`, `services/journal.service.js` — append and
list, newest first, cursor on `at`, no cap, no TTL). The setup document keeps a pointer-free
`monitor_state` (memo, guards, `next_check_at`, `timeframe`, `last_assessment`, cost). Read through
`GET /api/setups/:id/journal?before=<iso>&limit=50`, owner-scoped like every setups route.

`reason` ∈ `first_look · candle · guard · expiry_review · limit_order · limit_disarmed · entry ·
invalidation · exit · pre_active`. The row carries the rung, the price, the verdict, the conditions
checked (`{ id, met, note }`), the tools pulled, the guard that fired and the guards armed now. The
fill line (`entry`) and the close line (`exit`) are written by code — events on the trade — and the
close line lives in `entityRepo.finalizeClose`, kind-blind, because a closed entity drops out of
every polled status before its monitor wakes. Non-read wakes do not journal: a shut market writes
nothing, and `pre_active` writes once.

`scripts/migrate-journal.mjs` moved existing `monitor_state.timeline[]` arrays once, mapping the
legacy reasons and dropping the quiet-wake lines the new journal never writes.

---

## Pipeline — Mentor is the trade ASSISTANT

Mentor works on what the user brought. It does not source names (that is Argus) and it does not
allocate (that is Atlas). A saved setup reopens in Mentor with its worksheet and conversation
restored — the same destination whether reached from the list pencil or from Axl's `<edit>`.

**Share the pipe, not the judgment.** Talos posts through the one `postCard` → `postBotCard`
transport (`tradeNotify.service`) and draws from the one tool registry, but the copy on its cards
and the meaning of its verdicts are its own. See [trade-pipeline.md](./trade-pipeline.md) for the
cascade from Mentor's Generate to the reconciler's close line.

---

## Open

- ~~**In-position management**~~ **BUILT 2026-08-09, REBUILT 2026-09-17.** Originally a cheap price
  gate (`adverse` │ `scale_out` │ `breakeven`) plus a periodic review, with a fixed verdict menu and
  partial sizes as fractions of the position. Now: a read on every candle close of the watched legs,
  a menu derived from them, a partial sized by its leg. The read re-checks the setup's own declared
  conditions rather than a fixed axis set — the conditions were the reason for the trade, so they
  are the reason to stay in it. See [Talos](#talos) above.
- ~~**Nowhere to say yes.**~~ **BUILT 2026-08-13.** The proposal was written and the card was posted,
  but no endpoint accepted it — the verdict died on the card. Now `POST /api/setups/:id/action`
  (`talos.handoff.service`) accepts `move_stop` │ `take_partial` │ `exit_now`
  (`SETUP_MANAGE_VERBS`), or `dismiss` to clear the card and keep the position.
  - **The hands are shared.** Execution runs through `positionManage.service` — an amend / partial /
    close fan-out that every kind reaches the broker through, so there is ONE mechanism rather than
    one per desk. What stays with the desk is its DIALECT: Talos proposes `{stop, why}` /
    `{leg, quantity, size_pct}` and translates to the executor's `{new_stop}` / `{size_pct}` on the
    way in. The manual-mode card still carries the RAW proposal — the copy is written in Talos's
    words.
  - **`add_leg` is not an accept.** Talos already builds the order plan for a printing second leg and
    parks it `awaiting_confirm`, so that size is placed by confirming the ORDER. Accepting it as a
    management action would place it twice; the endpoint answers `confirm_order` and the card routes
    to the order dialog instead. `let_run` is gone — a bare "letting it run" is a `hold`, and moving
    a target out is an edit of the plan.
- ~~**The CLOSE journal line.**~~ **BUILT 2026-08-09.** Written in `entityRepo.finalizeClose`, not
  in a monitor: a closed entity drops out of every polled status before its monitor wakes, and the
  guarded `findOneAndUpdate` there is already the exactly-once property. Kind-blind, so calls got
  the same fix. The journal reason is `exit`; `closed` was renamed `market_closed` because it meant
  the MARKET was shut and read as the POSITION closing — and `market_closed` itself was then deleted
  with the per-candle build, because a shut market no longer writes a line at all.
- ~~**Monitoring ran through a shut market once past entry.**~~ **CLOSED 2026-08-15.** The rule is
  now **no monitoring off-hours, in or out of position**. Pre-entry had slept through a shut market
  since day one; the position path did not, because past-entry statuses are routed to it BEFORE that
  gate. `fetchLastPrice` answers with the last close at 2am, so a position that shut pressing its
  stop read as `adverse` on every wake — a full LLM read every few minutes all night on an
  identical frozen number, and able to post an `exit_now` card about a trade nobody can exit. It
  sleeps to the first candle close after the open instead; the stop and targets resting at the
  broker are what protect it meanwhile. Two deliberate exemptions: the **fill stamp** (bookkeeping —
  no price, no model, no card, and deferring it would leave a position with no frozen
  `stop.initial` overnight) and the pre-entry **expiry review** (a setup may still need to roll or
  die at the close).
- ~~**The manage-accept path is not hours-gated.**~~ **CLOSED 2026-08-15.** It was the last route to
  a broker that never asked: closing the monitoring hole stopped NEW cards appearing off-hours, but
  a card posted before the close could still be tapped at 02:00 and go straight out (on paper,
  filling at the stale day close). The gate now sits in `positionManage.applyManage`, the shared
  executor (`deferIfClosed`), so **every desk is covered by one call** and none can add a verb that
  forgets it. The queued verb is the action TYPE, so one accept cannot dedupe away another; the
  replay reloads both documents and runs the same executor. See
  [off-hours-queue.md](../architecture/off-hours-queue.md) phase 5.
  **JUDGMENT LEFT OPEN:** a queued row is RELEASED at the open, not auto-run — the user presses
  Execute. For a protective `move_stop` that means the tightening they accepted overnight is not in
  place when the bell rings. Defensible (price cannot move while the venue is shut, and both the
  card and the queued row say it is pending) but it is the one verb where "queued" and "done" differ
  in a way that could cost money.
- ~~**Scaling in — readiness blocks it.**~~ **BUILT.** Execution places the ARMED zone's size
  (`legQuantity`), the monitor watches the rest (`pendingLegs` → `watchedLegs(...).entries`), and
  the resting stop grows to cover each new leg. Readiness's narrower rule: with more than one leg
  EVERY leg must carry its own size, because a leg with none falls back to the premise total and
  would place the whole position on the first print. **Still open:** a plain-price scale-in leg is
  read on its firing rather than rested as a limit — multi-leg entry placement is not something the
  order layer does (`entry_mode:'limit'` places one leg). Resting legs are a follow-up.
- ~~**Stop/validity coherence is unchecked.**~~ **DONE** — `rangeProblems` (`setup.schema.js`)
  checks it per scenario and blocks Generate via `setupReadiness().problems`. It guards the range
  being **wider** than the stop (the setup would read live at a price where its own plan is already
  dead); a range tighter than the stop is deliberately allowed — it just warns earlier, and the stop
  still fires. It also rejects an away pivot sitting inside the envelope, where it could never fire.
- **Read lag.** `READ_LAG_MS` starts at 30s against a 60s poll. Measure, then set.
- **FE: `ZoneEditor`** still renders tp zones as `lower`/`upper`; under exact prices a target is one
  number plus its conditions. Not in the per-candle plan; stays as it is until picked up.
