# Mentor + Talos — the `setup` kind

The user's own trade, built with **Mentor** and watched by **Talos**.

> **A WAKE IS CHEAP BY DEFAULT (2026-09-23).** Talos still wakes on every candle close, but what a
> wake COSTS is now one of three: the full read, a CHEAP numbers-only read that decides whether the
> full one is worth paying for, or nothing at all. Every expensive read declares how many closes
> until it is worth another look and what the cheap passes should check meanwhile. Measured on 95
> recorded reads: **78% of wakes needed no expensive read**, $15.68 → $3.80 on that sample. The
> build plan and what it settled differently is
> [design/talos-two-tier.md](../design/talos-two-tier.md); [Tiers](#tiers--what-a-wake-costs) below
> is the contract. That build also deleted the derived `ladder` ([Rungs](#rungs--the-premise-and-the-pace))
> and made the entry gate the VERDICT rather than the level ([Guards](#guards--exact-prices-not-bands)).
>
> **TALOS READS ON EVERY CANDLE CLOSE (2026-09-17).** The per-candle rebuild
> ([design/talos-per-candle.md](../design/talos-per-candle.md), which stays the record of what the
> build settled) replaced the cadence timer, the guard time term, the in-position price gate and the
> TP window with ONE rule: **Talos spends a model call only on a condition the user wrote in words.**
> Pre-entry that is always true, so every wake reads. In position it is true only for a leg the user
> made conditional; a position of plain levels is DORMANT. The [Talos](#talos) section below is the
> current contract for the monitor. [Guards](#guards--exact-prices-not-bands) holds the reasoning
> for exact prices over bands and for guards over zones; its three-tier escalation and its time term
> are gone.
>
> **THE ZONE GATE IS GONE (2026-08-22, finished 2026-09-23).** The guards build replaced it with
> LLM-authored wake guards, and Mentor no longer draws bands — every level is an exact price. That
> doc (`talos-guards.md`) was merged into this one on 2026-09-19; sections marked **SUPERSEDED** or
> **History** describe how it used to work and are kept because the reasoning still explains the
> shape of what replaced them.
>
> What survived until 2026-09-23 was the LAST thing the zone still gated: an `enter` verdict only
> fired if price was also standing inside an entry zone. Against a zero-width price that containment
> test matched a live quote by coincidence — measured in prod, **18 of 18 entry zones were points
> and only 2 of 70 journal rows carried a zone at all**. Entries worked because the model happened
> to arm its guards at the exact authored price. **The entry gate is now the VERDICT and only the
> verdict**; the zone keeps the order price, the size and the r:r, and `firingLeg` says which leg.
> See [Entry — the verdict decides](#entry--the-verdict-decides).

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

## Rungs — the premise, and the pace

> **BUILT 2026-09-23.** Replaced the derived `ladder` (the authored timeframe ±2 rungs), which is
> deleted, not renamed. A stored `ladder` is simply not read any more; nothing to migrate, because
> it was server-derived and carried no user intent.

**Reading and pacing are different permissions**, and one field used to do both.

- **Reading is free.** Talos may chart, measure or check any timeframe at any time — it always could
  at the tool boundary (`assessTools`) and now that is the design rather than a local exception.
- **Pacing is not**, because the rung IS the wake clock and therefore the bill.

So a setup carries two independent fields:

| field | what it is |
|---|---|
| `timeframe` | the **PREMISE** — the one chart the plan was drawn on. The opening view of a read with no stored rung, and the default for `validity.timeframe`. Never constrains pace. |
| `pace_rungs[]` | the rungs Talos may be **READ** on. **Authored**, never derived, and never empty. |

**Two sources, one shape.** What the user named, or `ladderFor(horizon, marketCap, premise)` when
they named nothing (`services/setup.ladder.js`). Nothing records which, because nothing behaves
differently.

**NAMED RUNGS ARE ABSOLUTE.** This is where a user forces their own approach: Mentor may not add to
them, Talos may not roam outside them in either tier, and there is no cap on how many may be named —
a cap would be the system overruling the user. Mentor may argue in the conversation and must then
file what was said, exactly as it must with a price. A spoken range expands to every rung between
its endpoints: *"15min to 1hr"* is `["15min","30min","1hr"]`, never the two ends.

This costs nothing in reach, because reading stays unfenced. Being paced on the 15min decides when
Talos is read, never what it may look at — so **a swing drawn on the daily and triggered on the
15-minute** is finally expressible: `{"timeframe": "day", "pace_rungs": ["15min"]}`. Under ±2 those
rungs were five apart and that setup could not exist.

**The ladder is horizon × market cap**, because horizon alone hands a mega cap and a microcap the
same rungs and their noise floors are nothing alike — a 15-minute candle on a $2T name is structure;
on a $200M name it is two prints and a spread. The cap is bucketed ONCE at Generate and never
re-fetched: a setup's rungs must not move under it because the stock had a good quarter. An unknown
cap lands in the middle rather than refusing the setup. The band always widens to reach the premise,
because a default for people who did not choose is not a reason to overrule the rung they did.

`1min` is never offered anywhere: it is off-plan at the provider, so it is a rung whose fetch can
only fail.

---

## Tiers — what a wake costs

> **BUILT 2026-09-23** ([design/talos-two-tier.md](../design/talos-two-tier.md)). Until then every
> pre-entry wake was a full read at roughly $0.165.

A wake is one of three things. `talos.tiers.tierFor` decides, and it is pure:

| | when |
|---|---|
| **EXPENSIVE** — the full read, tools and all | a first look · an expiry review · a fired guard · `expensive_only` · the countdown elapsed · **the cheap read escalated, on this same wake** |
| **CHEAP** — `talos.cheap`, numbers only, no tools, no vision | inside the countdown, with a `watch` declared · `cheap_only` |
| **NOTHING** | inside the countdown with `watch: null` — the last expensive read said no numbers-only pass could help |

**The cheap read answers two questions**: is the setup fired, and should the expensive read run. It
has no verdict vocabulary, no guards, no proposals, and **no order is ever placed off it**. Both
tiers answer "is the setup fired?" on purpose — the cheap one detects, the expensive one confirms
and commits.

**Its answers are three-valued** — `fired` · `not_fired` · `unknown` — and `unknown` is the point,
not a failure. A numbers-only pass cannot tell whether a push below a level *failed*, and saying so
is exactly what it is for. Both `fired` and `unknown` escalate; so does an unparseable reply, a dead
provider, and any condition the model did not mention. **The model cannot decline to escalate.** The
asymmetry is the whole safety property: wrong towards escalate costs one read the user was going to
pay for anyway, wrong towards sleep costs them the trade.

**What is never triaged**, whatever the mode says: the first look (nothing to triage against), the
expiry review (a decision, not a "did something happen" — the replay found this the hard way), and a
fired guard (the expensive read armed that level precisely because it wanted waking there).

**The countdown is the expensive read's own**, and it is a MATURITY estimate rather than a budget.
`next_expensive_in` asks how far this setup is from being decidable, and only a model can answer: a
head-and-shoulders with one shoulder printed needs a head, a right shoulder and a neckline break,
which is twenty-odd closes, and re-reading next candle buys a picture of the same shoulder. Counted
in CLOSES, never minutes — a second clock alongside the candle is two timers that can disagree.
Capped at 24, which is the only backstop for a setup whose completion has no price to arm a guard at
("RSI divergence forming"); most chart patterns finish AT a level and a guard covers those exactly.

**`read_mode` barely matters.** Of the five, only `cheap_only` and `expensive_only` are overrides;
`cheap_then_expensive`, `expensive_then_cheap` and `both` are the same machine from different
starting points, and which one a setup is in falls out of what its own reads keep asking for. It is
derived from the conditions at Generate (`defaultReadMode`) and owned by Talos after that. It is
`read_mode` and not `mode` because a setup's `mode` is the WORKSPACE.

`cheap_only` still escalates — it only declines the expensive read *on a schedule*. A setup that can
never be looked at properly is one bad `not_fired` away from a missed trade.

---

## Guards — exact prices, not bands

> **BUILT 2026-08-22** as "guards, not zones", **partly superseded 2026-09-17** by the per-candle
> build. This section is the merge of the guards doc into this one (2026-09-19): what stands, with
> its reasoning, and one paragraph on what went. The build record for what went is
> [design/talos-per-candle.md](../design/talos-per-candle.md).

**Mentor emits PRICES and CONDITIONS IN WORDS. It does not draw bands, and it does not decide
breadth.** A user who says *"break of 312, stop 306, target 330"* gets a setup carrying 312, 306 and
330 — not 312–313, 305.2–306.4 and 328–330.

### Why zones existed, and why that reason expired

The old monitor polled on a schedule and asked one free question on each wake: is the SPOT price
inside a band right now. Two properties of that line were the whole reason bands existed. It read the
spot — a spike through a level and back between two wakes was invisible. And the gaps were long —
30 to 240 minutes for a swing. So a level could only be caught if price happened to be sitting on it
at the moment of a lazy, scheduled glance, and **the band was the compensation**: wide enough that
price was still inside it on the next look. Every zone rule Mentor's prompt ever had — the ATR-derived
breadth, the breakout window — descended from that and from nothing else.

Two changes retired the whole apparatus. **Test the RANGE since the last sweep**, not the spot: a level
crossed at any point in the gap trips, whether or not price stayed there, so an exact price is as
catchable as a wide band. And **let the model decide when to look next** — first as a guard it wrote
for itself, now as the rung whose candle close it wants (`next_timeframe`). After both, a band
communicates nothing a price does not — and it actively lied about the stop: the far edge of a stop
band was the order that actually rested (`zoneExitLevel`, long → `lower`), so widening a stop the
user put at 306 to 305.2–306.4 quietly rested it at 305.2, more risk than they agreed to. With no
bands there is no edge to pick, and a stop is where the user put it.

### The sweep — tier 0, and it must stay free

`guardSweep.service` (`GUARD_SWEEP_INTERVAL_MS`, default 30s) prices every symbol with an armed guard
and tests each guard against the range since that symbol was last swept. It is the one tier that must
stay free, and it is why **the model never fetches the price itself**: if the model is the thing that
looks, every wake costs a call including the thousands where nothing happened, and token spend
becomes proportional to elapsed time rather than to events — the failure this whole design exists to
avoid. The sweep reads the shared price trail before buying a quote (a mark younger than half its
interval is as good as a fresh one — half, never the whole, or its own last publication would satisfy
the next pass and the feed would freeze), and **skips shut markets**: a closed market has no
crossings, and an equity book would otherwise buy every symbol every sweep all night.

**A crossing carries a MEANING.** `price >= 311.5` and `price <= 300` are the same mechanism and
completely different questions, so the guard says which: `{ price, direction, means }` — direction
`above · below · any` (a touch, reachable from either side, and the honest translation of the old
"inside the band" trigger), means `entry · invalidation · manage`. The wake arrives already knowing
what read it is doing, which is most of the context a cheap read needs.

**A fired guard is authoritative over spot price.** The sweep proves price reached a level; a minute
later the wake re-checked containment and could find price gone, throwing away the very crossing that
paid for it. `_hitFromGuard` resolves the guard to its own zone instead.

**Guards are rewritten whole on every read** — what the model does not re-arm is forgotten — and
`clampGuards` keeps the set honest: at most `MAX_GUARDS` (6), no guard without a finite price, a
missing direction inferred from where price is, and a guard that is ALREADY TRUE at arm time dropped
rather than armed, because it would wake, re-arm and wake again for ever (a touch is exempt). The
prompt's own line: *do not arm a guard for what the next candle will show you anyway; arm one for the
level that would make you say something different right now.*

**The memo** carries forward why a guard was set, so a wake three hours later resumes a judgment
instead of re-deriving the situation from scratch.

**`lower` / `upper` stay as the storage shape.** Every level authored now is zero-width, so a `price`
field would read better — and renaming it would mean migrating live armed documents for a cosmetic
gain. `normalizeZone` accepts `{ "price": 312 }` on the way in and collapses it, so the model and the
UI both speak prices; only the stored keys are two.

### A free poll NEVER writes

The sweep runs every 30 seconds and almost always answers "no". **Nothing that did not cost a model
call may append a journal line** — a guard evaluated and not fired is not an event. Under the old
capped array this was the difference between a readable history and none at all (1,440 evaluations a
day into 50 slots); under the uncapped collection it is what keeps the trail a list of decisions. Every
row still carries the guards `armed` at the time, because the live copy cannot tell you what was
armed *then*, which is the whole audit value.

### What went, and why

The guards build had a **time term** on every guard (`elapsed ≥ 30min AND price ≥ 305` — the
conjunction that made a timer wake free when price was 20 away), an unconditional **backstop**
(`elapsed ≥ 24h`) so a setup nobody was watching was still seen once a day, a **three-tier
escalation** (sweep → a cheap price-and-memo read → the full chart read) whose tier-1 exit rule was an
open problem, and the journal as a capped array on the document. All four answered one question —
*when do I look if price does nothing* — and the candle close answers it: a setup 20 away for three
weeks is read once per candle of its rung, and earnings, the sector and `valid_until` are seen on
those reads. Tier 1 dissolved INTO the read, which opens on numbers and pulls the chart as a tool
call whose cost shows on the row. `BACKSTOP`, `after_min`, `and_price_above`, `CADENCE_BY_TYPE`,
`PULSE_MOVE_BANDS`, `proximityGapMin` and `skipped_since_last` are gone.

---

## Entry — the verdict decides

> **BUILT 2026-09-23.** The last thing the zone gated, removed.

**An `enter` verdict fires the confirm card. That is the whole gate.** It does not additionally have
to be standing on a level that a containment test agrees about. Whether the setup is fulfilled is
what `conditions[]` is for, and the READ is what judges them.

What the level still decides is WHICH leg (`firingLeg`): the one price is at when the wake resolved
to a specific zone, else the scenario's first unfilled leg. `hit` is still computed and still told to
the model as ARMED LEVEL — entering far from your own entry is usually a worse trade — but that is
the read's judgment, not the monitor's veto.

**Why it had to go.** The shape that broke it is the commonest there is: price arrives, the
conditions confirm two candles later. By then `clampGuards` has dropped the already-satisfied entry
guard (it would be a paid re-arm loop) and `woke_on` is one-shot and long cleared — so a pullback, a
reclaim or a sweep-and-go could reach the point where every condition was true with **no path to
`enter` at all**.

**What an `enter` places: an order at the plan's OWN authored entry price, never at spot.** So an
`enter` while price sits past that level is a resting order that may never fill, and if price has run
far enough that the plan no longer works, the honest answers are `wait` or `edit`. The prompt says
this outright and names the failure — *entering because the conditions are technically true, at a
price that left your entry behind*. Deliberately a judgment the read makes rather than a rule the
monitor enforces: the monitor cannot tell "price ran away" from "price came back to me".

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

### The exit asymmetry

The mechanism is shared between entry, stop and target — a condition in words, judged on the candle.
**What a missed read costs is not**, and this is the one place the symmetry must break:

| leg | read late / model wrong / process down | cost |
|---|---|---|
| entry | the trade does not happen | opportunity — bounded |
| conditional target | profit not taken, position runs on | bounded — the stop still holds |
| **conditional stop** | **the position has no protection** | **unbounded** |

A second multiplier is specific to this app: **Talos proposes, it never executes.** Every verdict is a
card the user confirms, so a conditional stop firing correctly at 3am still closes nothing until
someone taps it. Hence the rule above — a conditional stop ALWAYS carries a resting stop-market
behind it, the condition may only tighten it, and the broker order guarantees the position ends. The
model can get out earlier and smarter; it can never be the only thing standing between the user and
an open loss. And the mirror, settled in the build: a conditional target's limit MUST be held back,
or it fills the moment price prints and makes its own condition dead letter. Both legs follow one
rule — fail in the safe direction (`routeSetupZones`). Before this, `positionMonitor.checkPosition`
— the only code that evaluated an exit condition for a position — had had no caller since Minos was
deleted, so a conditional stop could be authored, stored and shown as protection and never once run.

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
held to `paceRungs` — the rungs this setup may be READ on ([Rungs](#rungs--the-premise-and-the-pace)).
The next wake is `market.service.nextCandleCloseMs(symbol, assetClass, rung)` + `READ_LAG_MS` (30s;
`dueLoop` polls at 60s, so the real lag is 30–90s). There is no `cadence` and no clock — the close
is the timer.

**A wake is no longer the same as a READ** (2026-09-23). Which tier runs is
[Tiers](#tiers--what-a-wake-costs); a wake that costs nothing writes its schedule and no journal
row.

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

**Which model reads (2026-09-20; the house rule 2026-09-21).** Every setup reads on the **house
Talos model** — the admin's own included: `assessRouting` resolves `houseModels.service.js`
`talosModel` against `TALOS_MODELS` (`assess.shared.js`, the monitors' own registry, apart from
the chat desks'), and Sonnet 4.6 when none is set. Nobody's `preferences.hermesModel` is
consulted any more (it is a client-owned snapshot anyone can PUT); the effort cap is still the
user's own. Seven **candidates** carry `adminOnly`: Sonnet 5, GPT-5.6 Luna, Mistral Medium 3.5,
Qwen3.7-Plus, and since 2026-09-21 Qwen3.7 Flash, DeepSeek V4.1 Flash and Gemini 3.8 Flash — the
flag gates nothing at run time now; the *Models* card on the admin's profile (the one selector,
admin-only) offers them all, and the pick is every account's from its next wake, with every
journal row and the last-assessment record naming the model that made it. That is the live
comparison the replay harness (`docs/design/talos-replay-harness.md`) was going to stage offline:
the same prompt, the same tools, real setups, side by side in the pop-out. The non-Anthropic ones run through
`providers/openaiCompat.provider.js` — one OpenAI-format loop, the same tool kit and runner, with
`web_search` dropped (an Anthropic server tool; the condition comes back `unchecked`) and a chart
image delivered as a `user` message after the tool message. Account: `OPENROUTER_API_KEY` for all
three (Medium 3.5 moved off Mistral's own API on 2026-09-20 — same price, and the chat desks get the
web plugin there; `MISTRAL_API_KEY` is only read for a model pinned to the `mistral` endpoint, and
none is). Nothing a candidate
says executes on its own: `enter` parks `awaiting_confirm` and posts a card, as always.

**What a read costs, and the two knobs on it (2026-09-20).** The September ledger split Talos into
output (46%) and cache writes (43%); tools were the rest. Two things followed, both in
`assess.shared.js`:

- **Thinking is capped at `low`** (`ASSESS_MAX_EFFORT`, `capEffort`). A stored `hermesReasoning:
  high` reads as `low` — the user asked for reasoning and gets the affordable kind; the preference
  itself is never rewritten, so a tier that lifts the cap restores the user's own choice. `high` was
  the whole difference between the two heavy users' cost per read ($0.047 vs $0.035) for a verdict
  that is a small JSON object.
- **The prefix is cached for an hour** (`ASSESS_PREFIX_CACHE`, `assessSystem`). Tools + system are
  byte-identical for every setup and every user, and the wakes are paced by candle closes — 15
  minutes and up, past the 5-minute default — so nearly every read re-wrote ~5k tokens at 1.25×. A
  1-hour entry writes at 2× and is refreshed free by every read within the hour: one write an hour
  across the whole book, and cheaper as the book grows. The tool-loop breakpoint on `messages` stays
  at 5 minutes, which is also the API's order rule (longer TTL first).

**Every read can be recorded (2026-09-20, `monitoring/talos.recorder.js`).** `TALOS_RECORD_READS=1`
writes each read to `data/eval/talos-reads/<day>/` as a replayable bundle — the prompt, the tool
list, the whole trajectory with its chart PNGs, the verdict and usage, and a data pack of raw candles
for every symbol in scope on every rung, fetched right after the read so a candidate model asking
for a rung the real read never pulled still gets frozen data. It is the input to the replay eval
(`docs/design/talos-replay-harness.md`) and changes nothing about the read: fire-and-forget after
the answer, every fetch guarded, userId hashed, directory gitignored. On the deployed instance the
disk does not survive a deploy, so `TALOS_RECORD_SINK=mongo` puts the same bundle in the
`talos_reads` collection and `scripts/eval/talos-replay/pull-reads.mjs --db=test` brings them down
to the laptop. Off by default; the cost of having it on is the pack — ~10 candle fetches, 5 chart renders and a quote per read, in the
background — so it is meant for the dev laptop and for capture windows, not as a permanent
production setting.

**Everything a read spends is on its row.** Two lines were invisible until the same day: the
structure-vision tools (`get_orderblocks`, `get_false_breaks`) make a second model call on
`VISION_MODEL`, now booked through the runner's `ctx.onUsage` at the model it ran on; and
`web_search` is billed per search ($10 / 1,000) off the token columns — `usage.server_tool_use`
now rides through to `recordUsage`, priced and counted (`searches`).

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
invalidation · exit · pre_active · manage`. The row carries the rung, the price, the verdict, the
conditions checked (`{ id, met, note }`), the tools pulled, the guard that fired and the guards armed
now. The fill line (`entry`), the close line (`exit`) and the accepted-action line (`manage`, verdict
= the verb the user accepted, written through the same `entityRepo` journal seam by
`positionManage.manageApplied`) are written by code — events on the trade — and the close line lives
in `entityRepo.finalizeClose`, kind-blind, because a closed entity drops out of every polled status
before its monitor wakes. Non-read wakes do not journal: a shut market writes nothing, and
`pre_active` writes once.

`scripts/migrate-journal.mjs` moved existing `monitor_state.timeline[]` arrays once, mapping the
legacy reasons and dropping the quiet-wake lines the new journal never writes.

---

## Pipeline — Mentor is the trade ASSISTANT

Mentor works on what the user brought. It does not source names (that is Argus) and it does not
allocate (that is Atlas). A saved setup reopens in Mentor with its worksheet and conversation
restored — the same destination whether reached from the list pencil or from Axl's `<edit>`.

### Two entry paths (2026-09-20)

A setup arrives one of two ways, told apart on the first message, and the prompt runs a different
contract for each (`prompts/mentor_system_prompt.md`):

- **The interview** — the user recites a plan. One question at a time for what is missing, the
  levels taken exactly as given, no opinions they did not ask for, no tool call needed.
- **The guided build** — a name and no plan. Mentor climbs a **ladder**: name → quick read
  (`get_quote` · `get_candles` · `get_chart` · structure) → direction (Mentor's read, the user may
  overrule) → horizon (the trader's; Mentor says with tools whether the chart supports it) → lens
  (Mentor proposes, waits for the yes) → the deep read under that lens → the scenarios (as many
  as the chart offers ways in; the count is Mentor's, and all-pullbacks is fine) → R:R, then one
  offer to look for a wider target the structure justifies → size and account (the user's).

**The ladder is a checklist, not a state machine.** The server tracks no step. The user may pull
Mentor to any rung at any time (the *detour rule*); afterwards Mentor returns to the first UNSETTLED
rung, which it reads off its own last `<setup>` — the first blank field is the next rung. A detour
that changes a settled rung unsettles everything below it. **Paced by default** — one rung per
turn, each ending in a yes — and *"go all the way"* lifts the pauses, not the rungs: the whole
ladder in one turn, Mentor recording each call instead of asking, then naming the calls it made
(direction, horizon, lens) so any one can be overturned. Anything the user stated still wins, size
is still theirs, and "no trade" is still a legal landing. The tool loop caps a turn at ten rounds
(`DEFAULT_MAX_CONTINUATIONS`, `providers/anthropic.provider.js`); it used to THROW past the cap,
which would have lost a whole unpaced build on an imperfectly batched run. Both loops now run the
last round with tools off and a note on the final tool results (`TOOL_BUDGET_LANDING`,
`services/llmStream.util.js`), so the turn lands as text — the prompt tells Mentor to batch reads
per rung and, on that landing round, emit what is built and continue next turn.
This is why the "no phases" rule of
2026-08 and the ladder coexist: the invariants still govern what must be TRUE, the ladder only
fixes the default order in which Mentor gets there, so nothing is skipped.

Two grounding rules sit under the ladder: **tools, not memory** (every fact about the name comes
from a tool result in this conversation) and **live before levels** (`get_quote` in any turn that
places or moves a level). Both are prompt rules, not code gates — a server-side refusal was
considered and rejected, because the one turn it would fire on most is the interview, where the
user's own levels are filed without a tool call by design, and a refusal there has no honest way
to be told apart from a guess.

The `<setups>` candidate offer is no longer the default answer to "no plan": the fork between
plans is settled by dialogue at the direction, horizon and lens rungs, and the ladder ends in ONE
setup with however many scenarios it needs. Candidates remain for an explicit *"show me a few
options"*; the parsing and the cards are unchanged.

The ladder added two tools to Mentor's kit for the company read: `get_news` (the dated, cached
catalyst check on a name — before `web_search`) and `get_analyst_actions` (positioning's slow leg,
for the `institutional` read). Both are appended after the shared kit and before `consult`.

**Share the pipe, not the judgment.** Talos posts through the one `postCard` → `postBotCard`
transport (`tradeNotify.service`) and draws from the one tool registry, but the copy on its cards
and the meaning of its verdicts are its own. See [trade-pipeline.md](./trade-pipeline.md) for the
cascade from Mentor's Generate to the reconciler's close line.

### Sharing a setup (2026-09-21)

A saved setup can be sent to another user **as a message in their social-chat DM**. The sender
attaches one of their setups from the composer ("Share a setup" — offered on human DMs only), types
an optional note, and sends; the recipient sees a `setup_shared` card with "Open in Mentor".

**What travels is the BLUEPRINT** (`services/setup.blueprint.js` — built for the deleted express
form, kept for exactly this caller, wired now): the plan and nothing personal. Asset, direction,
lens, premise `timeframe`, `pace_rungs`, horizon, `entry_mode`, thesis, conviction, validity window, the setup-wide
conditions, and every scenario with its levels (with their notes and per-zone conditions) and its
conditions. **Not** the size, the account, the broker, the workspace `mode`, the status, the
monitor state, or the sender's Talos reads. Alongside it: the sender's note, the last price at the
moment of sending (`drawn_price`, null-safe — a failed quote never blocks the send), and the doc's
`rr` for display.

**Quantity never travels — in either direction.** `toBlueprint` strips it on the way out and
`hydrateBlueprint` refuses it on the way in, so a hydrated plan always fails readiness on
`quantity` (and on `trading account` until one is marked). That is the security property, not a
gap: nobody generates, arms or fires someone else's plan without having typed the size themselves.

**The copy is a FORK.** The blueprint rides inline in the card, so it keeps opening after the
sender revises or deletes the original; nothing links the two documents afterwards and nothing
syncs. `from` (`{ userId, username, fullname }`) is provenance only. The card's payload keys the
origin as `source_setup_id`, deliberately not `setupId` — `setupId` is a `cardSubject` key, and a
subject would let the SENDER's next write to their own document auto-resolve the recipient's card.
The card `resolvesOn: 'open'`: looking is the whole ask; sizing is the recipient's own decision.

**Pipe and judgment.** `POST /api/setups/:id/share { conversationId, note }` →
`api/setups/setupShare.service.js` (the judgment: owned read, `toBlueprint`, the price, the
payload) → `chat.service.postUserCard` (the pipe: participant check, human-recipient check —
`bot_recipient` otherwise — the shared `sendMessage` writer, socket + push delivery under the
sender's name). `setupShare.service` is its own module rather than a function in `setups.service`
because the chat pipe imports the Axl agent, whose tools read the setups list — importing it from
`setups.service` closed an import cycle.

**Opening it.** The recipient's "Open in Mentor" (`SETUP_SHARED_OPEN`, MainPage) posts the
blueprint to `POST /api/setups/blueprint`, which hydrates it through the SAME `normalizeSetup` +
`setupReadiness` a Mentor turn uses and reports `problems` (levels that could not be read, an
unknown lens, a blueprint from a newer app — the last one refuses the open). The draft lands in the
recipient's Mentor as a **fresh thread** (`chatRestore.freshThread`, so it never persists over the
build that was open — which stays resumable), in the recipient's own workspace with their own
marked accounts (a blueprint carries no `mode`, so `alignWorkspaceTo` is not called), and ON A TURN
(`sharedAsk.js`): *"Roy shared this NVDA long plan with me — their note: … It was drawn with NVDA
at 187.5. Read it against the tape now … then help me size it."* Mentor reads, the recipient sizes,
Generate stamps THEIR `mode`/broker/accounts. The plan stays editable — it is their fork.

**Deliberately not built:** signed links or any share outside the app; sharing a live draft before
Generate; live-follow (linked setups across accounts); sharing to bots; email.

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
- **Sweep resolution.** The trail is built from published marks, so a wick between two publications
  is invisible. Far better than a 30-to-240-minute glance; the escalation if it bites is to confirm a
  near-firing guard with a real 1-minute candle. `GUARD_SWEEP_INTERVAL_MS` (30s) is the knob, and it
  turns UP if quota bites, not down.
- **Broker-native symbols in the sweep.** It prices through `quoteMapForSymbols` (FMP). A
  broker-native symbol that does not resolve there gets no price term — its guards never fire and
  the setup is read only on its candle closes, silently. Worth closing.
- **FE: `ZoneEditor`** still renders tp zones as `lower`/`upper`; under exact prices a target is one
  number plus its conditions. Not in the per-candle plan; stays as it is until picked up.
