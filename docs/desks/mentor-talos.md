# Mentor + Talos — the `setup` kind

The user's own trade, built with **Mentor** and watched by **Talos**.

> **THE ZONE GATE DESCRIBED HERE IS GONE (2026-08-22).** [talos-guards.md](talos-guards.md) replaced
> it with LLM-authored wake guards over time AND price, and Mentor no longer draws bands — every
> level is an exact price. Read that doc first; it is the contract. What survives here is everything
> guards did not touch: the scenario model, conditions, validity, the pipeline, and the history of
> why the exits are shaped as they are. Sections marked **SUPERSEDED** describe how it used to work
> and are kept because the reasoning still explains the shape of what replaced them.

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

| | `idea` (legacy) | `setup` | `call` |
|---|---|---|---|
| levels | exact points, condition trees | **exact prices** | zones |
| trigger | tree evaluates true → fire | **guard fires** → assess → fire | zone trip → assess → fire |
| what is monitored | the leaves | the **declared** factors | four fixed axes |

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

---

## Validity — the range outside which the setup is dead

`validity` bounds where the setup still makes sense, with `on_break`: `revise` │ `close` │
`notify_only`.

**The asymmetry is deliberate — do not flatten it.** Pre-entry, both edges matter: too high is "do
not enter here" just as much as too low is "the thesis broke". In position, only the **adverse**
edge matters, because a favourable move through the far edge is what the targets are for.

There is **one out-of-zone mechanism, not two.** Validity and the old invalidation watcher answered
the same question in two places with two vocabularies.

---

## Exits — the TP window (BUILT 2026-08-15, **SUPERSEDED 2026-08-22**)

> The WINDOW is gone: a target is the price the user named and nothing hangs beneath it. What the
> breadth used to buy — room for Talos to propose banking early — is a GUARD the monitor arms for
> itself, at a level it chooses per wake rather than one Mentor drew once
> ([talos-guards.md](talos-guards.md)).
>
> Principle 1 below is truer than ever and now cuts both ways: an unconditional level is just an
> order, and a conditional TARGET is the opposite — it does not rest at all, because a limit would
> fill regardless of what its condition said. Principle 4's "conditional stops are out of scope" is
> also void: they are built, and a conditional stop ALWAYS keeps its resting stop-market.
>
> The rest of this section is kept for the reasoning, which is what explains the shape.

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

**THE TP PRICE IS THE TOP OF THE WINDOW; THE BREADTH HANGS BELOW IT** (user, 2026-08-15). This is
the framing, and getting it backwards is what makes the feature look like a cost. A tp zone is NOT
"the target is somewhere in this band". It is **the target the user named, plus a stretch of price
beneath it in which Talos is allowed to talk.** For a long: the TP price is the top, the breadth
runs back toward entry. Mirrored for a short — the TP is the bottom and the breadth sits above it.

- **The resting limit is the authored TP price** — the far edge, in the direction of travel.
- **Talos wakes at TP − breadth** (long) — the near edge.
- **Do nothing and you get the TP you named.** That is the default outcome, not a degraded one.

**THE WINDOW USED TO BE ZERO WIDE.** `protectionPlan.zoneExitLevel` rested the TP limit on the NEAR
edge — the first edge price touches — and `setup.schema.targetEdges` woke Talos on that SAME edge.
So the limit filled at the exact instant the `scale_out` gate tripped, and "sell only half" was a
proposal about a position that was already flat. The two are now separate:

| | was | is |
|---|---|---|
| resting limit | near edge | **the TP price** (far edge) — `zoneExitLevel(zone, isLong, 'tp')` |
| Talos wakes | near edge | near edge = TP − breadth (unchanged) |

`setup.schema.targetWindows` reads a zone as `{ wake, target }` and seeds
`position_state.targets[{ price, resting, hit_at }]` — `price` the wake level, `resting` the limit.
A zero-width zone seeds `price: null`, and the gate skips a non-finite `price`, so an exact level
rests and wakes nothing.

Price enters the window → Talos reads and proposes → the user decides while the position is still
on. Nobody answers and price keeps going → the limit takes the whole thing at the TP. A gap clean
through the window fills whole with no conversation, which is the correct outcome, not a miss.

**NO SCHEMA CHANGE.** `tp_zones[{lower, upper}]` already holds exactly this: for a long, `upper` IS
the TP price and `lower` is TP − breadth. What changes is one function's choice of edge for the tp
leg. An earlier draft of this section framed the band as "the target is in here somewhere" and so
counted resting at the far edge as GIVING UP the near one; under the user's framing the near edge
was never a target, and nothing is given up.

**MENTOR AUTHORS IT — IT IS THE HALF THAT DECIDES THE NUMBERS.** The prompt used to teach the
opposite (*"Entry, stop and target are bands, because a level is a decision area"*), so it drew a
fuzzy area and the edges landed where ATR put them. It now teaches:

1. **The TP band means something the other two do not.** Entry and stop stay decision areas; only
   the TP is target-plus-breadth, and the asymmetry is stated outright so the model does not
   generalise it. Written as the mirror of the rule already there for entries (*"a breakout zone is
   a window: near edge at the trigger, far edge ≈ trigger + 1 ATR"*).
2. **Name the target first, then draw the breadth back from it** — never centre a band on a level
   and let the edges fall out, because the far edge is a real price the user exits at.
3. **Breadth ≈ 0.5–1 ATR of the working timeframe, and at most a third of entry-to-target.** Too
   narrow and price crosses the whole window between two checks, so the limit fills before the card
   is read; too wide and Talos asks to bank at +0.4R on a trade planned to +3R.
4. **The R:R paragraph is rewritten.** It still measures to the near edge, but that edge is now the
   floor — what the trade pays if the user takes the first offer every time — and the prompt says so,
   with the warning that it must never be improved by drawing the window narrower. A thin window is a
   worse plan advertising a better number, which is the one way to make the measure lie.

**THE PROMPT AND `zoneExitLevel` SHIPPED IN ONE COMMIT, deliberately.** Prompt-first would have had
Mentor place the target at the top while the limit still rested on the near edge: every trade exiting
at TP − breadth, a silent systematic haircut, invisible because the numbers all still look plausible.

**A TARGET PRICE IS REQUIRED TO GENERATE.** `setupReadiness` lists `target price` under `missing`
for any premise without one — checked through `targetWindows`, so a band of nulls counts as no price
rather than as a zone. The far edge is a limit order resting at the broker, not an annotation, and a
plan that says where it dies but not where it pays leaves the user in a position only a stop can end.
The breadth bounds are enforced too, by `windowProblems` under `problems`.

**Both of these BLOCK, and that is settled** (user, 2026-08-15, asked and confirmed). It is the
opposite of the coverage desk, whose plausibility flags record and never refuse, so the difference is
worth naming rather than discovering: a missing exit and a window too thin to act inside are defects
in the plan, not observations about it. A badly proportioned window is the debatable one — it would
still work, it would just ask too early — and it blocks anyway. Do not downgrade either to a warning
without asking.

**STILL OPEN. FE:** `ZoneEditor` renders tp zones as `lower`/`upper`, which should now read as a target and its
window; `position_state.targets[]` has gained `resting` and its `price` may be null
([[feedback_frontend_sync]]).

**R:R KEEPS MEASURING TO THE BOTTOM.** `computeRR` uses `targetEdges()[0]`, which is now the wake
level rather than the target. Keep it: it is the honest worst case if the user takes the first ask
every time, and an R:R must never flatter. A deliberate choice, not an oversight.

**WHAT MAKES A TP "CONDITIONAL" IS ITS WIDTH, for now.** A tp zone carries no conditions field of
its own, so the discriminator that exists today is the band: a **zero-width** tp zone is an exact
level the user named — it rests and never wakes anything (its near and far edges are the same
price, so there is no window to have a conversation in). A zone with width is the conversation.
Principle 3's "a setup for the TP" — a genuinely conditional exit, where nothing rests and Talos
owns the leg — is a later schema addition, and it needs a per-leg owner (`broker` │ `talos`)
because a position with no resting TP is a different risk profile and must be visible as one.

**THE RE-ARM TRAP** (closed by `rearmTargets`). `position_state.targets[].hit_at` exists to stop a
target re-tripping forever, and that was correct while reaching the near edge meant the limit
filled. Now reaching it means only that we ASKED. A target touched, declined and abandoned by price
must re-arm when price leaves the zone, or the setup's remaining upside is silently disarmed by a
wick. The stamp becomes "we have already asked about this one on this visit", not "this one is
done".

**The accept path needs almost nothing.** "Take half" is `take_partial` — close half at market now
(banking into strength at the current price is the whole point; waiting for the far edge is what
they declined) and let the reconciler resize the resting limit to the remainder. That path already
exists. A different TP level is `let_run` carrying `{ new_tp }`, which the shared executor already
amends; Talos's `let_run` currently carries no proposal and is not in `SETUP_MANAGE_VERBS`, so
principle 3's cheap half is opening exactly that door.

---

## Talos

A poll loop woken by GUARDS (see [talos-guards.md](talos-guards.md)), drawing from the **shared
monitor tool kit**
(`monitoring/assessTools.js`) rather than a private copy, with symbol scope and per-wake cost
accounting.

- **The card fires ONLY on `enter`.** Every other verdict is journalled, not notified. A monitor
  that announces every look trains the user to stop reading it.
- **Fire-once latch** — a tripped setup cannot re-fire on the next wake.
- **`edit` fires a card too**, which it did not originally: a setup Mentor wanted to revise used to
  change silently.

**Talos was built against an older monitor and is thinner than it in places — a known state, not
an accident.** That monitor is now archived, so the gaps below are Talos's own to close; they are
listed rather than hidden behind a claim of parity.

---

## Pipeline — Mentor is the trade ASSISTANT

Mentor works on what the user brought. It does not source names (that is Argus) and it does not
allocate (that is Atlas). A saved setup reopens in Mentor with its worksheet and conversation
restored — the same destination whether reached from the list pencil or from Axl's `<edit>`.

**Share the pipe, not the judgment.** Talos posts through the one `sendBotMessage` transport and
draws from the one tool registry, but the copy on its card and the meaning of its verdicts are its
own.

---

## Open

- ~~**In-position management**~~ **BUILT 2026-08-09.** `_managePosition`: metrics → cheap gate
  (`adverse` │ `scale_out` │ `breakeven`) → an in-position read only when the gate trips or a review
  is due → card. Verdicts `hold` │ `let_run` │ `take_partial` │ `move_stop` │ `exit_now`; partial
  sizes are `third` │ `half` │ `two_thirds` **of the original position**, so they terminate. The
  read re-checks the setup's own declared conditions rather than a fixed axis set — the conditions
  were the reason for the trade, so they are the reason to stay in it.
  See [trade-pipeline.md](./trade-pipeline.md) for the cascade.
- ~~**Nowhere to say yes.**~~ **BUILT 2026-08-13.** The proposal was written and the card was posted,
  but no endpoint accepted it — the verdict died on the card. Now `POST /api/setups/:id/action`
  (`talos.handoff.service`) accepts `move_stop` │ `take_partial` │ `exit_now`, or `dismiss` to clear
  the card and keep the position.
  - **The hands are shared.** Execution runs through `positionManage.service` — an amend / partial /
    close fan-out that every kind reaches the broker through, so there is ONE mechanism rather than
    one per desk. What stays with the desk is its DIALECT: Talos proposes `{stop, why}` / `{fraction}`
    and translates to the executor's `{new_stop}` / `{size_pct}` on the way in. The manual-mode card
    still carries the RAW proposal — the copy is written in Talos's words.
  - **`add_leg` is not an accept.** Talos already builds the order plan for a printing second leg and
    parks it `awaiting_confirm`, so that size is placed by confirming the ORDER. Accepting it as a
    management action would place it twice; the endpoint answers `confirm_order` and the card routes
    to the order dialog instead. `let_run` isn't an accept either — it is a decision not to act.
- ~~**The CLOSE journal line.**~~ **BUILT 2026-08-09.** Written in `entityRepo.finalizeClose`, not
  in a monitor: a closed entity drops out of every polled status before its monitor wakes, and the
  guarded `findOneAndUpdate` there is already the exactly-once property. Kind-blind, so calls got
  the same fix. The journal reason is `exit`; `closed` was renamed `market_closed`, because it
  meant the MARKET was shut and read as the POSITION closing.
- ~~**Monitoring ran through a shut market once past entry.**~~ **CLOSED 2026-08-15.** The rule is
  now **no monitoring off-hours, in or out of position**. Pre-entry had slept through a shut market
  since day one; the position path did not, because past-entry statuses are routed to it BEFORE that
  gate. `fetchLastPrice` answers with the last close at 2am, so a position that shut pressing its
  stop read as `adverse` on every wake — a full LLM read every `cadence.min` all night on an
  identical frozen number, and able to post an `exit_now` card about a trade nobody can exit. It
  sleeps to the open instead; the stop and targets resting at the broker are what protect it
  meanwhile. Two deliberate exemptions: the **fill stamp** (bookkeeping — no price, no model, no
  card, and deferring it would leave a position with no frozen `stop.initial` overnight) and the
  pre-entry **expiry review** (a setup may still need to roll or die at the close).
- ~~**The manage-accept path is not hours-gated.**~~ **CLOSED 2026-08-15.** It was the last route to
  a broker that never asked: closing the monitoring hole stopped NEW cards appearing off-hours, but
  a card posted before the close could still be tapped at 02:00 and go straight out (on paper,
  filling at the stale day close). The gate now sits in `positionManage.applyManage`, the shared
  executor, so **every desk is covered by one call** and none can add a verb that forgets it. The queued verb is the action TYPE, so one accept cannot dedupe away another; the
  replay reloads both documents and runs the same executor. See
  [off-hours-queue.md](../architecture/off-hours-queue.md) phase 5.
  **JUDGMENT LEFT OPEN:** a queued row is RELEASED at the open, not auto-run — the user presses
  Execute. For a protective `move_stop` that means the tightening they accepted overnight is not in
  place when the bell rings. Defensible (price cannot move while the venue is shut, and both the
  card and the queued row say it is pending) but it is the one verb where "queued" and "done" differ
  in a way that could cost money.
- **Scaling in** — several entries inside one scenario is modelled (`scenarioQuantity` sums them)
  but readiness blocks it until the flow is specified.
- ~~**Stop/validity coherence is unchecked.**~~ **DONE** — `rangeProblems` (`setup.schema.js`)
  checks it per scenario and blocks Generate via `setupReadiness().problems`. It guards the range
  being **wider** than the stop (the setup would read live at a price where its own plan is already
  dead); a range tighter than the stop is deliberately allowed — it just warns earlier, and the stop
  still fires. It also rejects an away pivot sitting inside the envelope, where it could never fire.
