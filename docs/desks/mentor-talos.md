# Mentor + Talos — the `setup` kind

The user's own trade, built with **Mentor** and watched by **Talos**: a zone gate plus a
setup-driven assessment.

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
| levels | exact points, condition trees | **zones** | zones |
| trigger | tree evaluates true → fire | zone trip → **assess** → fire | zone trip → assess → fire |
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

## Talos

A poll loop with a zone gate, drawing from the **shared monitor tool kit**
(`monitoring/assessTools.js`) rather than a private copy — the same registry Hermes draws from, with
symbol scope and per-wake cost accounting.

- **The card fires ONLY on `enter`.** Every other verdict is journalled, not notified. A monitor
  that announces every look trains the user to stop reading it.
- **Fire-once latch** — a tripped setup cannot re-fire on the next wake.
- **`edit` fires a card too**, which it did not originally: a setup Mentor wanted to revise used to
  change silently.

**Talos is Hermes with pieces missing, and that is a known state, not an accident.** The two
monitors share a shape and a tool kit but not a brain; where Talos is thinner the gap is listed
below rather than hidden behind a claim of parity.

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
  See [trade-pipeline.md](./trade-pipeline.md) for the cascade and the Hermes-duplication expiry.
- **The CLOSE journal line.** The reconciler flips a closed setup to `closed`, which drops it out of
  the polled statuses before Talos sees it — so the exit is recorded by the trades ledger and never
  by the journal. Same root as the above: both want an in-position brain.
- **Scaling in** — several entries inside one scenario is modelled (`scenarioQuantity` sums them)
  but readiness blocks it until the flow is specified.
- ~~**Stop/validity coherence is unchecked.**~~ **DONE** — `rangeProblems` (`setup.schema.js`)
  checks it per scenario and blocks Generate via `setupReadiness().problems`. It guards the range
  being **wider** than the stop (the setup would read live at a price where its own plan is already
  dead); a range tighter than the stop is deliberately allowed — it just warns earlier, and the stop
  still fires. It also rejects an away pivot sitting inside the envelope, where it could never fire.
