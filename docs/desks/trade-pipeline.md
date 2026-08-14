# The trade pipeline — Argus → Mentor → Talos

How a single asset becomes a monitored trade. One path, three desks, one entity kind (`setup`), one
monitor (Talos).

Design record, 2026-08-09. Nothing here is built yet except where marked **BUILT**.

---

## Status

| | state |
|---|---|
| Argus → Mentor → Talos | the live path going forward |
| Kairos + Hermes | **silent** — not deleted, not archived |
| Argus → Mentor handoff | **BUILT 2026-08-10** — backend seed + lens recommendation, FE wired end to end |
| Trading Desk steps | **REWIRED 2026-08-10** — build step is Mentor, not Kairos (`agentMeta.jsx`) |
| Axl's prompt | **REWIRED 2026-08-13** — Kairos is no longer offered as a desk; a new trade routes to Mentor, and `<edit>call ID</edit>` is the only thing that still opens Kairos |
| `call` kind | frozen. Calls in flight run to natural close under Hermes |

**Silent, not gone.** Hermes must keep running until the last live `call` closes — the same strangler
used for legacy tree-`idea`s. Nothing in flight migrates. See
[kairos-hermes.md](./kairos-hermes.md) for what stays alive meanwhile.

**One capability was dropped, deliberately.** Kairos emitted `<scan_request>` — "let's look for
another name" — which walked the desk BACKWARDS to Argus. Mentor emits nothing, so on the trading
desk that hop is now reachable but unused: the route still resolves, there is simply no sender. The
user re-enters the scan by hand instead. Recorded in `deskSteps.test.jsx` rather than deleted,
because the premium autonomous Mentor mode is the natural place for it to come back.

---

## Why Mentor and not Kairos

The difference between the two desks was never the schema. It is **authorship**:

- **Kairos authors, and stops.** It picks the levels; the user presses Generate.
- **Mentor works on what the user brought.** It analyses, proposes, pushes back, then hands the
  decision back.

That is a *mode*, not a second codebase — so it collapses into one agent with two authoring styles,
and the better schema wins. Mentor's is the better schema:

| | `call` | `setup` |
|---|---|---|
| shape | flat zone lists, one `bias` | **scenarios** — each owns its entry, stop, targets, conditions, validity |
| conditions | patterns the desk hypothesised | **free text**, no taxonomy — the monitor reads the sentence and picks its tools |
| dies by | `valid_until` (a time) | `validity` (a price range, with `on_break`) |
| repeat work | — | `persistence: latching` — a settled fact is never re-litigated |

`setup.schema.js` states the reason a taxonomy was refused: an enum "would only ever narrow what can
be checked." The intelligence lives in the monitor, not the shape.

**The autonomous build (today's Kairos behaviour) returns later as a premium mode of Mentor.** It is
deliberately the expensive one: measured at ~6.7 model round-trips and ~122k prompt tokens per user
turn, against Mentor's ~2. Pricing it as premium aligns cost with revenue instead of fighting it.

---

## The three lenses

`discretionary` · `smc` · `institutional`

- Mentor **recommends** one and names it. It never blends two — that rule already exists for the
  current pair and extends unchanged.
- **Talos is aware of the lens.** This is a deliberate break from Hermes, where `mode` never reaches
  the monitor. The reason: a setup's conditions reference the lens's own computations, so *"an SMC
  setup built on them is monitored on them."*
- Scope it tightly. The lens changes the monitor's **voice and where it looks first** — a line in
  the prompt (`assess.shared.lensLine`). It does **not** gate tools, change the questions or change
  the verdicts, and it never reaches Tier 2 (which has no tools).

**Two blockers before the third lens ships:**

1. ~~**Name collision.**~~ **DONE 2026-08-10.** Condition modes are now `measured │ judgment`, so
   the lens set is free to become `discretionary │ smc │ institutional`. Migration cost nothing: a
   stored `discretionary` is no longer in the set and falls to the default, which IS `judgment` —
   same meaning, new name. A test asserts the two vocabularies share no word, so it cannot regress
   when the lens set grows.
2. ~~**`institutional` tools must exist**~~ **CHECKED 2026-08-10 — they effectively do.** The kit
   mounts correlations, short interest, options/derivatives context, fundamentals, filings and
   earnings; `get_macro_snapshot` and `get_sector_snapshot` were added 2026-08-10 (no symbol can
   answer a regime condition, so `unchecked` was the only honest verdict available). `get_peers`
   is deliberately NOT mounted: it is a DISCOVERY tool, and a monitor checks the peers a condition
   NAMES rather than re-deriving the peer set — that judgment belongs to the build. More to the point, the premise was wrong: Talos does not gate tools by lens
   at all — everything is mounted and the model picks, deliberately, because conditions are free
   text and gating on a declared kind never served it. The lens is a SENTENCE in the prompt, not a
   filter.

---

## Talos — the three-tier cascade

One assessment path, gated cheapest-first, running both flat and in position.

### Tier 1 — arithmetic
Free. Every wake. Pure comparison, no IO.

**Flat**

| trip | goes to |
|---|---|
| price inside an entry zone | Tier 3 · *entry* |
| close past a validity edge | Tier 3 · *invalidation* |
| `valid_until` within threshold | Tier 3 · *expiry* |
| price moved N band widths from the anchor | **Tier 2** |
| nothing | reschedule, silent |

**In position**

| trip | goes to |
|---|---|
| close past the **adverse** validity edge | Tier 3 · *invalidation* |
| price at or beyond a target zone | Tier 3 · *exit* |
| adverse move past N band widths | Tier 3 · *risk* |
| nothing | **Tier 2** |

### Tier 2 — cheap triage
Haiku · no tools · no thinking · 32-token cap · ~$0.0005.

This tier exists because **exits, scaling and change-of-setup have no natural arithmetic gate.**
"Should I take partial profit?" is not answered by price crossing a line. A cheap model call is the
gate those questions never had.

- In: position summary, entry, stop, targets, price, unrealized R.
- Ask: "anything here worth a real look?"
- Out: `{look: bool, reason: <one word>, next_check_min: int}`.
- **Unsure → `look: true`.** Fail-open, matching the existing fail-open confirmation pass.
- `reason` selects which Tier 3 question runs.

### Tier 3 — full assessment
Sonnet · tools per lens · chart when the read is genuinely visual · ~$0.03–0.05.

**One question per wake. The gate picks it — the model never chooses among six.** A six-way decision
is a bigger prompt and a worse answer than a narrow one.

| question | verdicts |
|---|---|
| entry | `enter` · `wait` · `stand_aside` |
| invalidation | `dead` · `revise` · `hold` |
| exit | `take` · `partial` · `trail` · `hold` |
| risk | `move_stop` · `reduce` · `hold` |
| re-map | `edit_proposal` · `keep` |
| expiry | `let_expire` · `edit` |

---

## Invariants

1. **Talos never executes.** Every verdict is a card the user confirms. This is what makes a wrong
   verdict survivable, and it is the first thing that will feel tempting to break once exits exist.
2. **Tier 1 always runs first.** Tier 2 is cheap per call, not free — a thousand users with three
   open positions is ~144k triage calls a day. Fine as an escalation; ruinous as a base cadence.
3. **One question per wake.**
4. **Journal on Tier 3 only.** Tiers 1 and 2 stay silent. A monitor that writes a line every wake
   turns the monologue into noise.
5. **Latch per event, not per verdict type** — `partial` must be able to re-arm.
6. **The model proposes `next_check_min`; the cadence clamps it.** Reuses `_nextCheckAt`. The
   timeframe is the anchor: a 5-minute setup and a daily setup must not share a floor. Unclamped, a
   model that says "1 minute" on a swing setup burns the budget, and one that says "3 days" goes
   blind.
7. **Re-anchor on Tier 3 only.** Tier 2 sees numbers, not a chart — that is not a real look. If the
   anchor moved on every Tier 2 run, a slow grind would reset forever and never accumulate. Throttle
   Tier 2 by clock instead.

---

## Zones

**Targets become zones**, `lower`/`upper`, the same shape as entry zones — so Tier 1's exit gate is
the same `zoneGate` as entry. One mechanism, parameterised. Not two.

**But the comparison differs, and this is easy to get wrong:**

- **Entry gate — price *inside* the zone.** You want in at that price, not worse.
- **Exit gate — price *at or beyond*.** You will happily take better than target. If the exit gate
  reuses `zoneGate` unchanged, a gap straight through the target never fires, because price was
  never "inside".

**Targets are mandatory at readiness.** No targets, no Generate. The exit gate is then always
available. Existing setups without them keep running.

Target zones need **no validity of their own** — the scenario's covers it. A target price blows past
is exceeded, not dead.

**Ten zones is a supported answer**, and the arithmetic gate makes it nearly free to watch. Three
things to warn the user about at build time:

- Ten zones across ten scenarios are **rivals**: the first to fill takes the whole trade and the rest
  die. Ten zones inside *one* scenario is scaling in, which is a different thing and currently
  blocked.
- Overlap is resolved by **authored order**, which is fine at two scenarios and arbitrary at ten.
- Scattered zones keep the proximity cadence permanently at its floor — the cheap tier stops being
  cheap. Mentor should push back during the build.

---

## Partials

- Size is an **enum**: `third │ half │ two_thirds`. A free float is money chosen by a model; an enum
  is validatable and renderable. Still a card — the user confirms.
- **Fractions are of the ORIGINAL size, never of the remainder.** Thirds of the original terminate at
  three; thirds of the remainder are 1/3, 2/9, 4/27 … and never reach flat.
- **`partial` re-arms.** After a third, Tier 3 may propose another later. Hence invariant 5.
- **`position_state` must track `remaining`.** Today it records `entry.size` at fill, which is no
  longer enough — Tier 3 will otherwise propose a third that does not exist.
- **A floor.** Below some remainder the verdict is `take`, not `partial`. Otherwise: death by a
  thousand thirds.
- **`partial` and `move_stop` are separate verdicts.** They will often be proposed together; they are
  not one action.

**Off-hours — already solved, needs wiring.** The queue was built for this case:

> *"a queued trim, exit or scale-in is **not** an entry, owns no entity of its own, and can outlive
> the review that produced it."*

- Call `deferIfClosed({userId, asset, assetClass, origin, action})` before sending.
- Register a Talos origin in `services/pendingAction/originRegistry.js` — one entry.
- `executionGate` **refuses to queue an unregistered origin**, so this cannot ship half-done.
- `enqueue` is idempotent per `(user, entity, verb)` — which is also the double-accept guard for
  re-arming partials.

---

## Rewrite, don't overlay

| file / function | why |
|---|---|
| `_checkSetup` + `_checkPosition` | two entry points today; the cascade is one, gated by flat/in-position |
| `_checkPosition` | a heartbeat with no brain — nothing to preserve |
| `_applyVerdict` | built for one verdict set; six questions will not overlay |
| `_checkValidity` | becomes a Tier 3 question instead of a deterministic close-check |

**Carry one thing forward through the rewrite: the wick guard.** `_checkValidity` deliberately
fetches the **close**, not the tick — *"The close is the verdict, and it may disagree with the tick:
that IS the wick guard working."* Easy to lose in a rewrite, expensive to rediscover.

---

## Shared services

Reuse, do not fork:

- `assessTools.js` — the one tool registry. Tier 3 draws from it, scoped by lens.
- `monitorJournal.js` — journal shape and cap mechanics.
- `_nextCheckAt` / `next_check_min` — Tier 2 reuses this; no new scheduling code.
- `sendBotMessage` — one card transport.
- `zoneGate` — one function for entry and exit, parameterised by comparison direction.
- `deferIfClosed` / `originRegistry` — the off-hours queue.

Stays per-desk — **share the pipe, not the judgment**: the six questions, their verdict sets, and
the card copy.

If Hermes ever gains a Tier 2, it must be the *same* triage service, not a copy.

---

## Talos completion backlog

| item | state | size |
|---|---|---|
| ~~stop/validity coherence~~ | **already built** — `rangeProblems` | — |
| ~~close journal line~~ | **BUILT 2026-08-09** — `entityRepo.finalizeClose` | — |
| ~~in-position management~~ | **BUILT 2026-08-09** — see below | — |
| ~~scaling in~~ | **BUILT 2026-08-10** — five slices, readiness lifted | — |

Order: **~~close line~~ → ~~in-position~~ → ~~scaling in~~.** The Talos backlog is clear.

### Scaling in, as built

Five slices, the first four deliberately inert so the readiness block could stay shut until
the protective half existed: entry became an aggregate of legs with a size-weighted
`fill_price` (`4c2a85d`), execution sizes by the armed ZONE rather than the premise
(`04cfc47`), a pending leg printing forces the in-position read and never while `adverse`
(`d7e4f63`), `add_leg` places that one leg without touching status (`4b95cb4`), and the
resting stop GROWS by adding a leg for the delta rather than cancel-and-replace, so the
cover never dips and never doubles (`b3bc6e2`).

Readiness now refuses two things instead of refusing scaling in outright: a leg with no size
of its own (it would fall back to the premise total and place everything on the first
print), and a leg drawn PAST the stop — price arriving there means the stop already went,
so it reads as a plan to add twice and can only ever add once.

### In-position management, as built

`_managePosition` in `talos.monitor.service.js`: metrics (always) → cheap gate → assess only if the
gate tripped or a review is due → persist, and post a card when the verdict asks for something.

Gate flags: `adverse` (price within a quarter of the original risk of the working stop — the look
*before* the stop, while there is still a decision), `scale_out` (an un-hit target reached), and
`breakeven` (≥ +1R with the stop not yet protected past entry).

Verdicts, aligned on Hermes's built vocabulary rather than the names sketched above:
`hold` · `let_run` · `take_partial` · `move_stop` · `exit_now`. **`take_partial` uses the doc's
enum — `third │ half │ two_thirds` of the ORIGINAL size** — so partials terminate.

**Tier 2 was not built.** Hermes solves the ungated questions with a periodic full review
(`reviewDue`, one cadence since the last read) rather than a cheap triage call, and that shape is
adopted here. Cheaper to build, more expensive to run; revisit only with a measured cadence cost,
not a guess.

**The duplication is deliberate and time-boxed.** `positionGate` / `computeMetrics` / `rMultiple` /
`reviewDue` are copied from Hermes rather than extracted, because Hermes is silent but still holds
live positions and refactoring it would touch running money for a caller scheduled for retirement.
**Delete the copy when Hermes sleeps** — the block carries the same note. Three things differ and
are the reason a blind copy would have been wrong: cadence is `{min,max}` not `{min_gap_min,…}`;
targets are zones reduced to their near edge, so `scale_out` fires at-or-beyond; and the stop is the
widest edge across `stop_zones`, chosen by price.

- **Coherence is done.** `rangeProblems` (`setup.schema.js`) checks it per scenario and blocks
  Generate through `setupReadiness().problems`. The `mentor-talos.md` Open list saying otherwise
  predates it. Note the direction it actually guards: the fault is a validity range **wider** than
  the stop — *long entry 238 / stop 234.8 / validity.lower 230 → at 234 the stop is blown but the
  setup still reads live.* A range **tighter** than the stop is fine and deliberately unflagged: it
  warns earlier, and the stop is a real broker order that still fires.
- **Close line** is an ordering fix: the reconciler flips a setup to `closed`, dropping it out of the
  polled statuses before Talos sees it. Recording the exit is small; *explaining* it needs the
  in-position brain.
- **In-position** is the cascade above. It is most of the work.
- **Scaling in** last — it is the only item that touches the order layer.

**Not in this backlog:** the momentum pulse. It dissolves into Tier 1 — it was never a mechanism,
only a name for *anchor + distance → escalate*. Keep the anchor field, drop the word, and escalate to
Tier 2 rather than straight to a full visual read. Same trigger, ~100× cheaper response.

---

## Open

- **Tier 1 anchor threshold.** Hermes used 4 band widths because each trigger bought a full visual
  read. A trigger now buys a $0.0005 call, which argues for being *more* sensitive — 2 bands is the
  starting suggestion.
- **In position with no targets authored** — legacy setups predate the readiness rule. What gates
  their exit question?
- **Does the `trades` ledger support partial exits?** It is frozen-at-fill with `pnl =
  exit.realizedPnl`, which reads as a single exit. Confirm before Tier 3 can propose `partial` — if
  it does not, that is a dependency, not a detail.
- **[entity-model.md](../architecture/entity-model.md) is stale** — its per-kind payload and
  ownership tables list only `idea` / `call` / `portfolio_item`. `setup` and Talos are absent though
  live-verified since 2026-08-03. Fix when this lands.
