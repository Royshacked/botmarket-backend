# Guards, not zones — Talos's wake contract

**BUILT 2026-08-22.** This is the contract. It replaced the zone gate described in
[mentor-talos.md](mentor-talos.md), and it changed what **Mentor authors** — both halves landed
together, because a monitor reading a shape nobody writes is worse than either half alone.

The one-line version: **a price band was never the point. It was a workaround for looking at price
too rarely, and for looking at only one price when we looked.** Fix the sampling and the band has no
job left — so Mentor stops drawing bands, and Talos decides for itself when to look next.

> **PROPOSED EXTENSION — [design/triggered-setups.md](../design/triggered-setups.md), not built.**
> A guard's price term becomes an ARRAY of terms over prices *and* indicator subjects (`ema(9)`
> crossing `sma(21)`, price within 0.5% of `vwap`), which in turn allows a setup whose entry is a
> trigger rather than a level. Guards as written here are unaffected — that design is strictly
> additive, and it turns on the rule that most "pattern" triggers resolve to a price anyway.

---

## Why zones exist today, and why that reason expires

Talos polls on a schedule and asks one question, for free, on each wake:

```js
zones.find(z => price >= z.lower && price <= z.upper)
```

Two properties of that line are the whole reason bands exist.

**It reads the SPOT price.** Not "did price trade through this level since I last looked" — "is price
inside the band at this instant". A spike through a level and back between two wakes is invisible.

**The gaps are long.** `CADENCE_BY_TYPE` runs 2–15 minutes for intraday and **30–240 minutes for a
swing**. A setup is not examined between its scheduled wakes; `dueLoop` skips it until
`next_check_at` passes.

Put together: a level can only be caught if price happens to be sitting on it at the moment of a
lazy, scheduled glance. **The band is the compensation** — make the target wide enough that price is
still inside it on the next look. Every zone rule in Mentor's prompt descends from this and from
nothing else:

- *"a breakout zone is a window: near edge at the trigger, far edge ≈ trigger + 1 ATR, so a fast
  break still lands inside on the next check"* — sampling.
- *"size each band to price magnitude and volatility, ATR-derived"* — ATR is a proxy for how far
  price travels between looks.

Two changes retire the whole apparatus:

1. **Test the RANGE since the last poll**, not the spot. A level crossed at any point in the gap
   trips, whether or not price stayed there. An exact price becomes as catchable as a wide band.
2. **Let the model decide when to look next**, given where price is and what it is doing. A band
   ceases to be the yardstick for urgency because urgency is now judged, not measured.

After both, a band communicates nothing a price doesn't — and it actively lies about the stop (see
[The exit asymmetry](#the-exit-asymmetry)).

---

## The load-bearing decision: the LLM writes its own wake condition

Every read ends by naming the condition under which it wants to be disturbed. Code evaluates that
condition on every poll, for free. **The model runs only when it fires.**

The condition is **two-dimensional and conjunctive** — time AND price, not time OR price:

```
elapsed >= 30min  AND  price >= 305        // routine re-check, but only if still relevant
price >= 311.5                             // the trade may be happening — now, not on the timer
price <= 300                               // the premise is breaking — now
elapsed >= 24h                             // unconditional backstop
```

The conjunction is the part that saves the money. A timer firing while price is still $20 away buys
a model call whose only possible answer is *"still $20 away"*. Under `time OR price` you pay for
every one of those. Under `time AND price` you pay for none.

### What this replaces, and why it is strictly better

Today urgency is **measured** by a formula: `proximityGapMin` grades distance-to-zone in
zone-widths, floor at ≤1 width, ceiling at ≥8, linear between. It is a decent approximation and it
is blind to everything that isn't distance. These two are identical to it:

- 311, arrived from 305 in twenty minutes on rising volume
- 311, drifting down from 314 all afternoon

A model writing its own guard separates them, and can also price in what no distance function can
see: earnings in twenty minutes, the last hour of the session, a base building under the level, a
gap forming. **The model expresses the whole proximity curve itself**, per situation — loose guard
and a long timer at 20 away, tight guard and a short timer at 1 away — which is what
`proximityGapMin`, `PULSE_MOVE_BANDS` and `pulseGapMin` are all crude stand-ins for.

### The guard SET — three kinds, and the third is not optional

A read emits several guards, not one, because a pure conjunction can starve. If every guard carries
a price term, a setup whose price sits 20 away for three weeks is **never examined** — and meanwhile
earnings came and went, the sector rolled over and `valid_until` passed. Those are exactly the
failures price does not show, which was the one job the time dimension had.

| kind | example | job |
|---|---|---|
| conditional | `elapsed ≥ 30min AND price ≥ 305` | the common case — cheap, targeted |
| immediate | `price ≥ 311.5` | the interrupt: fire ahead of the timer |
| **backstop** | `elapsed ≥ 24h`, unconditional | the safety net — catches what price cannot show |

The backstop is cheap precisely because it is rare: one read a day on a setup nobody is watching,
versus none at all. Horizon-scaled — hours for intraday, a day or more for a swing.

### A crossing carries a MEANING

`price >= 311.5` and `price <= 300` are the same mechanism and completely different questions. The
guard says which, so the wake arrives already knowing what read it is doing:

```json
{ "price": 311.5, "direction": "above", "means": "entry" }
{ "price": 300,   "direction": "below", "means": "invalidation" }
```

That label is most of the context a cheap read needs, which is what keeps the escalation below
honest.

---

## Escalation — cheapest thing that can answer the question

Three tiers. Each is allowed to answer and stop; only the last one is expensive.

| tier | who | cost | does |
|---|---|---|---|
| 0 | code | a quote | evaluate the guards. Nothing fires → sleep. |
| 1 | model | small | price + memo. Re-schedule, or escalate. |
| 2 | model | full | candles/chart on the chosen rung. The real decision. |

Tier 0 is the one that must stay free, and it is why **the model never fetches the price itself**.
If the model is the thing that looks, every wake costs a call including the thousands where nothing
happened — token spend becomes proportional to elapsed time rather than to events, which is the
failure this whole design exists to avoid.

**Tier 1 needs an exit rule, and this is an open problem.** *"Escalate to the chart if you need to"*
asks the model to police its own spending, and the safe answer is always yes. Without a rule, tier 1
collapses into tier 2 and every wake costs full price. Candidates: escalate only within X of a
guard; cap chart reads per session; make tier 1 stateless and let the memo carry the reasoning.

### The memo is what makes a cheap read possible

A wake triggered by a guard set three hours ago needs to know **why that guard was set**. The memo
carries it forward, so the model resumes a judgment instead of re-deriving the situation from
scratch. It already exists on the current monitor and survives unchanged.

---

## Mentor stops authoring zones

The other half, and it cannot ship separately.

**Mentor emits PRICES and CONDITIONS IN WORDS. It does not draw bands, and it does not decide
breadth.** A user who says *"break of 312, stop 306, target 330"* gets a setup carrying 312, 306 and
330 — not 312–313, 305.2–306.4 and 328–330.

What this deletes from `mentor_system_prompt.md`:

- the **Zones, not points** section entirely — ATR-derived breadth, the breakout window, the TP
  window and its far-edge/near-edge rule, `lower < upper`
- *"draw the bands"* as step 1 of the interview's **Then draw it** block
- the ATR read that step 1 was just made to require — the interview no longer needs it, because
  nothing derived from ATR is being authored

What Mentor keeps, unchanged: the lens, hoisting general conditions, settling the timeframe, tagging
conditions on three axes, sizing, R:R, conviction, `validity`. **Everything except breadth.**

This also resolves, by deletion, the defect that started this thread: the far edge of a stop band is
the order that actually rests at the broker (`zoneExitLevel`, long → `lower`), so widening a stop the
user specified at 306 to 305.2–306.4 quietly rests it at 305.2 — more risk than they agreed to. With
no bands there is no edge to pick, and a stop is where the user put it.

---

## Entry, stop and TP are one mechanism

Same guards, same escalation, same contract. What differs is only what happens when there is **no**
condition attached.

### Unconditional → a resting order, and no model involvement at all

| leg | order |
|---|---|
| TP | **limit** at the named price |
| stop | **stop-market** at the named price |

This is already what `routeSetupZones` builds (`nativeOrders`, `monitorTree: null`). It needs no
guard, no wake and no tokens — *"an exact level has no window to talk in, so it simply rests"*. It
survives this design untouched.

### Conditional → guarded evaluation, exactly like entry

*"Out if it closes below the 4hr VWAP"* is a judgment, so it runs the tier-0/1/2 ladder against a
guard the model rewrites each read.

### The exit asymmetry

The mechanism is shared. **What a missed guard costs is not**, and this is the one place the
symmetry must break:

| leg | guard misses / model late / process down | cost |
|---|---|---|
| entry | the trade does not happen | opportunity — bounded |
| conditional TP | profit not taken, position runs on | bounded — the stop still holds |
| **conditional stop** | **the position has no protection** | **unbounded** |

A second multiplier is specific to this app: **Talos proposes, it never executes.** Every verdict is
a card the user confirms. So a conditional stop firing correctly at 3am still closes nothing until
someone taps it.

**THE RULE: a conditional stop ALWAYS carries a resting stop-market behind it.** The condition
governs the discretionary exit and may only ever *tighten* it; the broker order guarantees the
position ends. The model can get out earlier and smarter; it can never be the only thing standing
between the user and an open loss.

A conditional **TP needs no backstop** — the worst case is an unrealised gain on a position that is
still protected.

### This closes a hazard that is live right now

`protectionPlan.service.js` already says so:

> *a user can author a stop that isn't a plain price level, have it accepted, stored, and shown as
> protection — and have it never once evaluated. THE AUTHORING PATH IS VERY MUCH ALIVE.*

`positionMonitor.checkPosition` — the only code that evaluates a stop/TP condition tree for
something already in a position — **has had no caller since Minos was deleted (2026-08-18)**. So
conditional exits can be authored today, are displayed as protection, and nothing runs them. This
design is what finally evaluates them, and the mandatory resting order is what makes the dangerous
case structurally impossible rather than a warning in the UI.

---

## The journal

One append-only first-person log per entity (`monitor_state.timeline`, `$slice: -50`), shared with
Hermes and rendered by `MonitorJournal.jsx` / `TalosWatch.jsx`. **The entry shape survives.** What
changes is what a line is *about*.

Today `reason` answers *what kind of wake was this*. Under guards the useful question is **which
guard fired, and when did I arm it** — so the journal stops being a list of glances and becomes an
audit trail of **attention**: why I looked, why I didn't, and what I am waiting for now.

### The rule that protects the record: a free poll NEVER writes

Tier 0 runs every poll and almost always answers "no". At a 60-second poll that is **1,440
evaluations a day into a 50-entry capped array — the entire history would be wiped every 50
minutes.**

> **Nothing that did not cost a model call may append a line.** A guard evaluated and not fired is
> not an event.

This is already the instinct in the current monitor (*"No journal entry: an idle wake that writes
'still waiting' every wake"*), but under guards it stops being a nicety and becomes the thing
standing between a readable history and no history at all.

### Every entry carries the guard set it armed

`next_check_at` was one timestamp — "when I'll next stir". It becomes **what I am waiting for**,
which is the far more useful thing to read:

```json
{
  "at": "2026-08-21T11:47:03Z",
  "reason": "guard_price",
  "fired": { "price": 311.5, "direction": "above", "means": "entry", "armed_at": "2026-08-21T08:20:00Z" },
  "tier": 2,
  "price": 311.62,
  "verdict": "wait",
  "note": "It tagged 311.5 but the 5-min candle is still open and volume is thin — not the break yet.",
  "armed": [
    { "price": 312.4, "direction": "above", "means": "entry" },
    { "price": 305,   "direction": "below", "means": "invalidation" },
    { "after_min": 15, "and_price_above": 308 },
    { "after_min": 240 }
  ],
  "skipped_since_last": 9
}
```

Three fields are new and each answers a question the old shape could not:

| field | answers |
|---|---|
| `fired` + `armed_at` | *why am I awake* — and that I armed this level 3½ hours ago, deliberately |
| `armed` | *what am I waiting for now* — the forward half, replacing a bare timestamp |
| `tier` | *what did this cost, and how much should you trust it* — a price-only read is not a chart read |

### The interesting silence: wakes deliberately NOT taken

The whole point of a conjunction is that the timer can fire while price is 20 away and **cost
nothing**. That is a decision, not a non-event — and it is the exact thing the design is optimising,
so it has to be visible somewhere.

But it happens constantly, and journaling each one would break the rule above. So it rides as a
**counter on the next real entry**: `skipped_since_last: 9`, rendered as one clause —

> *"Nine timer wakes passed without a look — price never came near 308."*

One line, at the next read that was worth paying for. The audit trail without the noise. It is also
the cheapest possible answer to *"is this actually saving tokens?"* — a rolling ratio of reads to
polls, visible on the artifact itself rather than in a metrics dashboard.

### `reason` values

Old entries stay readable through the existing read-side `LEGACY_REASON` map — the same mechanism
that already carries the `closed` → `market_closed` rename — and age out of the cap on their own.

| today | becomes | |
|---|---|---|
| `zone_trip` | `guard_price` | a level crossed; `fired.means` says entry or invalidation |
| `scheduled` | `guard_time` | a conjunctive time guard whose price term also held |
| `momentum_pulse` | *(gone)* | the pulse existed to catch development away from a mapped band |
| — | `backstop` | the unconditional heartbeat fired: nothing happened, look anyway |
| `pre_active` · `market_closed` · `expiry_review` · `entry` · `exit` | unchanged | not wake-mechanism lines |

### What a timeline reads like

```
08:20  guard_time    Price 305.10, quiet. Base holding under 312. Watching 311.5 for the break
                     and 305 for the premise breaking. Back in 30m if it stays here.
11:47  guard_price   ↑311.5 (armed 08:20) · tier 2
                     Nine timer wakes passed without a look — price never came near 308.
                     It tagged 311.5 but the 5-min candle is still open and volume is thin —
                     not the break yet. Moving my line to 312.4.
11:58  guard_price   ↑312.4 (armed 11:47) · tier 2
                     Closed through on three times average volume. This is the break. → enter
12:03  entry         In on NVDA around 312.55, stop resting at 306. The broker holds the exits.
```

Four lines for a morning, each one a decision. The old shape would have written *"price is outside
my zones, checking back in 30m"* nine times in the gap and pushed the 08:20 line — the one that
explains everything after it — out of the cap.

### One thing that breaks

`zonesLabel(entity)` formats `entry_zones` as `"188–189"`. With exact prices it would render
`"312–312"`. It becomes a level list (`"312"`, `"312, 318"`), and the `scheduled` sentence stops
saying *"outside my zones"* — there is no inside or outside any more, only distance to a line.

---

## Blast radius — what stops being needed

Every one of these exists to serve band-width-as-a-yardstick or spot-price sampling.

| what | where | why it goes |
|---|---|---|
| `zoneWidth` | talos.monitor | the volatility yardstick; guards are authored, not measured |
| `zoneDistance` · `proximityGapMin` · `NEAR_WIDTHS`/`FAR_WIDTHS` | talos.monitor | the model writes the curve itself |
| `shouldPulse` · `PULSE_MOVE_BANDS` · `pulseGapMin` | talos.monitor | tier-2 pulse existed to catch development away from a mapped band |
| `targetWindows` · wake/target split | setup.schema | a TP is a price; the "window to talk in" becomes a guard |
| `zoneExitLevel` | protectionPlan | no edge to choose |
| `windowProblems` · `MIN_WINDOW_FRACTION` · `MAX_WINDOW_SHARE` | setup.schema | nothing to be too thin or too wide |
| `zonesLabel`'s `"188–189"` band text | monitorJournal | becomes a level list — see [The journal](#one-thing-that-breaks) |
| ZoneEditor's two-edge rows | frontend | price rows |

**Deliberately KEPT:** `CADENCE_BY_TYPE` as a **clamp** on the model's chosen interval (one bad
estimate must not leave a live trade unwatched); `TF_RUNGS` + the ladder; `positionGate`'s `adverse`
/ `breakeven` arithmetic as a tier-0 guard the model does not have to author; `armed_zone_id` for
multi-leg entries; `rangeProblems`; the whole readiness gate.

`normalizeZone` already collapses to a zero-width zone and already accepts a bare `price`, so the
**schema can carry exact prices today without a migration**. Whether `lower`/`upper` eventually
become `price` is a separate, later cleanup — not a blocker.

---

## Decided during the build

- **`lower`/`upper` STAY as the storage shape.** Every level authored now is zero-width, so a
  `price` field would read better — and renaming it would mean migrating live armed documents for a
  cosmetic gain. `normalizeZone` already accepts `{"price": 312}` on the way in and collapses it, so
  the model and the UI both speak prices; only the stored keys are two. That is the whole cost.
- **A conditional TARGET does not rest at all.** The design said a stop needs a resting order and a
  target does not need one; the truth is stronger — a target's limit MUST be held back, or it fills
  the moment price prints and makes its own condition dead letter. Both legs follow one rule: fail
  in the safe direction (`protectionPlan.routeSetupZones`).
- **A fired guard is authoritative over spot price.** The sweep proves price reached a level; up to
  a minute later the wake re-checked containment and could find price gone, throwing away the very
  crossing that paid for it. `_hitFromGuard` resolves the guard to its own zone instead.
- **A third direction, `any` (touch).** The zone gate fired on "price is INSIDE the band", not on a
  directional cross, so migrating a band to a directional guard would have been a mistranslation.
  It is also the right answer for a pullback reachable from either side.
- **The sweep skips shut markets.** A closed market has no crossings, and at 30s an equity book
  would otherwise buy every symbol every sweep all night.

## Still open

1. **Interval vs. timeframe coupling.** The model emits both, and they can contradict: *"open the
   15-minute chart"* + *"check in 2 minutes"* re-reads the same unfinished candle and bills 7× for
   one bar. `next_check_min` was **built and deleted** for exactly this. Either derive the interval
   from the rung, or floor it at a fraction of the candle period — but choose deliberately.
2. **Tier-1 escalation rule.** Still unsolved, and still unbuilt: every read today is a full one, so
   the ladder is two tiers rather than three. That is why journal entries carry no `tier` field —
   recording a number that is always 2 would claim a capability we do not have.
3. **Resolution.** The trail is built from published marks, so a wick between two publications is
   invisible. Far better than a 30-to-240-minute glance, and the escalation if it bites is to confirm
   a near-firing guard with a real 1-minute candle. `GUARD_SWEEP_INTERVAL_MS` (default 30s) is the
   knob, and it turns UP if quota bites, not down.
4. **Guard clamps.** Floor and ceiling on the interval; a cap on how many price levels one read may
   arm; what happens when a guard is unreachable (a level on the wrong side of price).
5. **Broker-native symbols.** The sweep prices through `quoteMapForSymbols` (FMP). A broker-native
   symbol that does not resolve there gets no price term — its guards degrade to the backstop
   heartbeat, silently. Roughly today's behaviour rather than a break, but worth closing.
6. **Journal retention.** Storing `armed` on every entry duplicates what `monitor_state` already
   holds live — deliberately, because the live copy cannot tell you what was armed *at the time*,
   which is the whole audit value. It is small (50 short arrays), but if the cap of 50 turns out to
   cover months rather than days once free polls stop writing, the better question is whether to
   raise the cap or age by TIME rather than by count.

---

## Not in scope

Execution is untouched. **Talos still never fires** — every verdict is a card the user confirms,
every order rests at the broker, and nothing here changes the venue layer, the off-hours queue or
the confirm dialog.
