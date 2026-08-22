# Triggered setups — when the level is not knowable yet

**DESIGN ONLY (2026-08-22). Nothing here is built.** It extends the guard contract in
[desks/talos-guards.md](../desks/talos-guards.md), which IS built, and adds one new mode to the
`setup` kind. Read that doc first: this assumes guards, the sweep, and exact levels.

The one line:

> **The numbers do not have to exist at AUTHORING time. They have to exist at FILL time.**

Everything below follows from that, including the part that keeps it safe: the stop order still
rests at the broker, it is simply computed a moment later.

---

## The rule that keeps this narrow

Guards made price bands unnecessary. They also, quietly, made something else possible: a guard can
be **time-only**, so Talos can now be woken with no price level armed at all. Which raises the
question this doc answers — can a setup have no prices? *"Enter when the fast MA crosses the slow
MA"* names no level anywhere.

It can. But the first rule is the one that stops this spreading:

> **RESOLVE TO A PRICE WHENEVER A PRICE IS KNOWABLE.** Mentor reads the structure and writes the
> number. A trigger travels as prose only when no number exists yet.

Most "pattern" triggers are prices wearing a description:

| the user says | knowable in advance? | Mentor does |
|---|---|---|
| "enter when it touches the OB" | **yes** — `get_orderblocks` returns the level | writes the price |
| "when the cup and handle completes" | **yes** — the neckline is a number | places it, or asks |
| "stop below the swing low" | **yes** — `get_structure` / `get_key_levels` | writes the price |
| "on the break of the prior high" | yes | writes the price |
| **"when the 9 EMA crosses the 21 SMA"** | **no** — depends where price is when it happens | a trigger |
| "when RSI crosses back above 30" | no | a trigger |

The line is not *pattern vs indicator*. It is **is there a number yet**. A swing low is a price the
moment you have identified the swing low; a moving-average cross is not a price until it happens.

So the priceless path is the exception, and the sections below describe a MODE that most setups
never enter.

---

## Guards gain a term array

Today a guard is `{ after_min, price, direction, means }` — time AND one price. That generalises:

```
guard = { after_min, when: [ term, … ], means }        // terms ANDed
term  = { left, op, right, by? }
```

`left` and `right` are each a **price, a literal number, or an indicator subject** — reusing the
vocabulary `monitoring/parsers/condition.parser.js` already speaks (`close · open · high · low ·
volume · vwap · rsi(N) · ema(N) · sma(N) · macd_line · macd_signal · macd_hist · atr(N)`).

| intent | term |
|---|---|
| price crosses 312 | `{ left: 'price', op: 'above', right: 312 }` |
| price touches 238 from either side | `{ left: 'price', op: 'touch', right: 238 }` |
| the MAs are converging | `{ left: 'ema(9)', op: 'within', right: 'sma(21)', by: '0.3%' }` |
| the cross itself | `{ left: 'ema(9)', op: 'crossAbove', right: 'sma(21)' }` |
| price near the session VWAP | `{ left: 'price', op: 'within', right: 'vwap', by: '0.5%' }` |

### Why an array, and why no tree

**The guard SET is OR; the terms inside one guard are AND.** That is disjunctive normal form, and
any boolean condition can be written in it. So arbitrary logic is expressible with **no nesting** —
which is precisely what made the legacy `idea` condition TREE hard to author, hard to render and
hard to reason about. The flat two-level shape is not a simplification that gives something up; it
is the same expressive power with none of the recursion.

### The cadence is different, and cheaper

A price term is answered by a quote. An **indicator term needs candles**, and it is only true on a
CLOSED candle — `condition.parser` already carries `confirmation: consecutive candles` for exactly
this. So indicator terms evaluate **once per bar of the working timeframe**, not every sweep.

One fetch per **symbol per rung** per bar, shared across every setup on that symbol — the dedup
`guardSweep.service.js` already does for quotes. A book of thirty setups on eight names costs eight
candle reads a bar, not thirty.

### What proximity actually saves — and what it does not

The instinct is that "are the MAs far apart" is a cheap pre-check for "did they cross". **It is
not.** Both need `ema(9)` and `sma(21)`; once you have them the comparison is free. Proximity buys
nothing on the comparison.

What it does buy is real and lives elsewhere:

- **Candle fetches.** MAs a long way apart → skip bars before refetching. That is the quota cost,
  and quota is the expensive part.
- **Model reads.** Arm `within 2%` first; when that fires, the read re-arms `crossAbove`. Two-stage
  approach, model-driven — exactly how price guards tighten as price walks in.

---

## The one priceless path

Work through when a stop genuinely cannot be a number at authoring time:

- the user names it → price
- structure names it → Mentor reads it → price
- "2% below entry" with a **known** entry → arithmetic → price
- "2% below entry" where the entry is a **market fill from a trigger** → ✗ unknowable

Only the last. Which gives the invariant that bounds this whole feature:

> **A rule-based stop exists ONLY downstream of a trigger-based entry.**

It is a MODE, not a change to how setups work. Every priced setup keeps today's behaviour exactly —
including R:R, sizing, the order plan and the execution projection, which only need a second path on
that one branch. The same holds for size: a risk budget is *required* only here, because everywhere
else the entry price is known and `quantity` computes at authoring as it does now.

### What the readiness gate becomes

It stops demanding **prices** and starts demanding **resolvability**: each leg must be a number now,
or a rule that produces one at fill.

| leg | accepted |
|---|---|
| entry | `price` · `trigger` (market on confirmation) |
| stop | `price` · `rule` (percent \| atr) — **and never nothing** |
| target | `price` · `rule` (r_multiple) · `condition` (does not rest — see talos-guards) |
| size | `quantity` · `risk_budget` (\$ \| % of equity) |

**The stop is the one that cannot fall through.** A rule is fine; absent is not. That is the
Phase-1 invariant unchanged — the order still rests, it is simply computed a moment later.

### R:R and size are UNKNOWN, and Mentor says so

With no entry price there is no risk-per-unit, so neither R:R nor the share count exists yet. Mentor
states that plainly rather than showing an estimate: a number computed off today's price, on a setup
that may not trigger for three weeks, is a number that flatters and then drifts.

**Both become real at the fill** and should appear the instant the position opens, not stay null for
the life of the trade.

---

## Always confirm — and the confirm read is where the numbers land

A market order is never placed automatically. Talos proposes and the user taps, as everywhere else.

That is a principle, and it also happens to solve the resolution problem. The entry card is fired
from `_applyVerdict`'s `enter` branch, which is **already a model read** — so it is the natural place
for fill-time numbers to be worked out and shown:

```
indicator guard fires
  → Talos reads → verdict 'enter'
  → re-reads structure, resolves: market entry ≈ 238.40, stop 233.60, 210 shares, risk $500
  → card: "9 crossed 21 on the 1hr. Market in around 238.40, stop 233.60 (2%), 210 shares."
  → you tap
```

One read, one place, nothing computed in the dark, and you see the real numbers before anything is
placed. That is what makes a market order acceptable here at all.

**A structural stop is re-read HERE, not trusted from authoring.** A swing low identified three weeks
ago is not the swing low. Staleness is not new — a stop authored Monday for a Friday fill has it too
— but a trigger's wait is open-ended by construction, so it is far more likely. The confirm read is
already happening at the right moment; it should refresh the level rather than quote a stale one.

---

## The honest cost: a derived stop cannot rest before the fill

This is the one place the design is genuinely weaker than an authored level, and it should be stated
rather than discovered.

**An authored stop rests before you are in.** The level is known, so it is attached to the entry
order and is live from the first instant. **A derived stop cannot exist until the fill does** — the
price it is computed from is the fill price.

Two ways to shrink the window, and they are not equivalent:

1. **Attach it as an OFFSET with the order**, where the venue supports a relative stop on a market
   order (worth confirming for cTrader's ProtoOA). Then it is not sequential and the gap is zero.
   This is the right answer wherever it is available.
2. **Place it on the fill callback** — the execution layer already receives fills. Sub-second, but
   non-zero, and it fails open if the second call errors.

What it must **not** be is "the next Talos wake computes it". That is up to a minute of a live
position with nothing behind it, and it would quietly undo the invariant this whole design has been
protecting.

It is also a standing argument for the first rule in this doc: **prefer a price whenever a price is
knowable**, because an authored stop is strictly safer than a derived one.

---

## One arithmetic service, called by both desks

Mentor and Talos both need to compute stops, targets, sizes and R:R — Mentor while building, Talos
at the confirm. That is the CLAUDE.md rule exactly: **shared mechanism → one service.** Not shared
judgment — Mentor still decides the levels and Talos still decides the moment — but the arithmetic
between them must be one implementation both call.

**IT IS ALREADY HALF-BROKEN, which is the argument.** Today:

- `computeRR` is deterministic in `services/setup.schema.js`, and Mentor's prompt says to quote it
  but not rely on its own arithmetic.
- **Sizing has no server-side implementation at all.** `risk-per-unit = |worst entry edge − stop|`
  and `quantity = floor(budget ÷ risk-per-unit)` live in `prompts/mentor_system_prompt.md`, and
  nothing recomputes them. The model does the division — including the contract/point-value branch
  for futures, forex and crypto — and whatever it returns is what gets placed.

So R:R is *computed* and size is *asserted*, and there is already a documented symptom: `computeRR`
measures to the nearest target while Mentor reasons about the blended exit, so the two disagree by
design. Adding a second desk that must do the same sums makes a small inconsistency into a visible
one — the worksheet says 210 shares, the confirm card says 187, and the user is left guessing which
is about to reach the broker.

The shape, pure and shared:

```js
resolveStop(rule, entry, { atr })            // → price
resolveTarget(rule, entry, stop)             // → price   (r_multiple)
resolveSize(budget, entry, stop, instrument) // → qty     (contract/point value lives HERE)
computeRR(entry, stop, target)               // → number  (exists)
```

Both desks call it. **Both prompts describe what a rule MEANS and never how to divide.** Retrofitting
the currently prompt-only sizing is part of this work, not a follow-up — it is the half most likely
to disagree.

---

## Open questions

1. **What the worksheet shows while a triggered setup waits.** It cannot show entry, stop, size or
   R:R. It can show the trigger, the stop rule, the target rule and the budget. That is a visibly
   different card from every other setup in the app, and if it renders as a row of blanks it will
   read as broken rather than as pending. This needs a deliberate design, not a fallback.
2. **`by` units.** Percent is natural for MA convergence; an ATR multiple is natural for a stop.
   Probably both, tagged — but one syntax, decided once.
3. **Candle budget.** Indicator terms turn the sweep from quote-shaped into candle-shaped for the
   symbols that carry them. Per symbol per rung per bar, cached — but it wants a measured ceiling
   before it meets a book of any size.
4. **Does a trigger expire?** A price level is implicitly bounded by `valid_until`. A cross that has
   not happened in three weeks is a setup nobody is thinking about any more, and the backstop read is
   the only thing that would notice.

## Not in scope

The legacy `idea` condition tree stays where it is. This borrows its PARSER and its evaluator
(`services/conditionTree.service.js`, `monitoring/monitor.orchestrator.js`), which is the point —
that machinery is proven and already runs — but a `setup` gains no nested logic. Guards are flat by
design.
