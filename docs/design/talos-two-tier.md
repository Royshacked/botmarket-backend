# Talos two tiers — build plan

**STATUS: BUILT 2026-09-23** — phases 1, 2, 3, 4.1, 4.3, 5, 6, 7. Suite 3287/0, lint clean, nothing
committed. NOT built: phase 4.2 (per-lens tool kits) and the docs pass. Supersedes the wake model in
[talos-per-candle.md](talos-per-candle.md) — that build made every candle close a full model read,
which is the thing this one undoes. The per-candle doc stays as the record of how the *timer*
became the candle; what changes here is what happens when it fires.

This plan does not preserve existing structure where the structure was built for the old rule.
Where a field or a function no longer has a job, it is deleted rather than kept working.

---

## The rule

**Talos wakes on every candle close. A wake is CHEAP by default** — numbers only, no tools, no
vision, one model call. The cheap read decides whether the expensive read is worth paying for.

**Every expensive read declares when the next expensive read is due, in candle closes.** It also
declares what the cheap reads between now and then should compute.

**`next_expensive_in` is a MATURITY estimate, not a budget.** The read is not being asked how much
it would like to spend — it is being asked how far this setup is from being decidable, and it is
the only thing in the system that can answer. A head-and-shoulders on the 15min with one shoulder
printed needs a head, a right shoulder and a neckline break: that is twenty-odd closes, the read
knows it the moment it looks, and nothing that isn't a model could work it out. Reading again at
the next close buys a picture of the same shoulder for $0.165.

The cost saving is a consequence of asking the right question, not the reason for asking it.

Cheap answers two questions. Expensive answers four.

| | the cheap read | the expensive read |
|---|---|---|
| is the setup fired? | ✓ | ✓ |
| should the expensive read run? | ✓ | — |
| is the setup still valid? | — | ✓ |
| should we move to another rung? | — | ✓ |
| when is the next expensive read? | — | ✓ |
| which numbers do the cheap reads need? | — | ✓ |

Both tiers answer "is the setup fired?" on purpose. **The cheap read detects; the expensive read
confirms and commits.** No order is ever placed off a cheap read.

---

## Today → after

| | today | after |
|---|---|---|
| every candle close | full read — 3.77 tool calls, ~4.8 model turns, **~$0.165** | cheap read — no tools, one turn |
| what the expensive read costs | is the whole monitor | runs on escalation, or when the last one said it was due |
| what paces the expensive read | the candle | the previous expensive read, counted in closes |
| indicators | a tool call that re-fetches bars already in hand | computed from those bars, in the opening block |
| which rungs | derived from one authored timeframe, ±2 | authored — the user's rungs, or Mentor's ladder |
| what picks the ladder | nothing; it was derived | horizon × market cap, at authoring |
| the tool kit | one kit, unfiltered, every setup | one kit per LENS, fixed for the setup's life |

**Measured baseline (prod, 71 reads, all post-2026-09-21):** 3.77 tools/read · **0 of 71 reads
spent nothing on tools** · `get_false_breaks` in 71 of 71 · `get_orderblocks` in 70 of 71 ·
`get_chart` 84 times across 71 rows. $40.96 over 1,188 turns = $0.0345/turn.

The prompt already tells the model to open cheap and pull nothing it doesn't need. It has never once
done so. That is the evidence for D7: **a tool that isn't in the list can't be called, and a prompt
that asks for restraint has been measured failing.**

---

## Decisions

**D1 — the cheap read is a model call, not code.** Conditions are TEXT and stay text. Code can only
evaluate them by first mapping them onto an enum, which is the taxonomy the `setup` kind exists to
not have. A small model reads the sentence directly: it answers "close above 100" off the rows, and
says *can't tell* to "false break down at the previous daily low". No parser, no enum, anywhere.

**D2 — the cheap read is three-valued.** `fired` · `not_fired` · `unknown`. Both `fired` and
`unknown` escalate. Only `not_fired` sleeps. This is what makes a cheap tier that cannot understand
a condition still safe to run in front of one.

**D3 — the cheap read never acts.** It has no verdict vocabulary, no guards, no proposals. Its
entire output is the triage answer plus one line for the journal. Entry, exit, stop moves and edits
are the expensive read's alone.

**D4 — pace is counted in closes, not minutes.** The per-candle build deleted every time term on
purpose: *"There is no time term. The candle close is the timer and the backstop both."* An
expensive read that asks to be re-run "in 30 minutes" reintroduces a second clock that can disagree
with the first. `next_expensive_in: 4` means four closes of the rung being watched.

**D5 — the mode is stored, defaulted from the conditions, and owned by Talos after the first read.**
Mentor can only set the opening mode; it does not know what will happen. The transitions are only
observable mid-life, and only Talos is there.

**D6 — the ladder is Mentor's, from horizon × market cap.** Horizon alone gives a mega cap and a
microcap the same rungs, and their noise floors are nothing alike.

**D7 — one tool kit per LENS, fixed for the setup's life.** Not per setup. The request prefix
renders `tools` → `system` → `messages`, so the tool block is the first thing in the cache prefix: a
per-setup kit gives every setup its own cache namespace and its own write. Three lens kits keep
caching shared across every setup on the same lens while still making the SMC tools *absent* from a
setup with no SMC conditions. The kit must not change mid-life — every change is a cache reset.

**D8 — no conversation, ever.** Each read is a fresh stateless request; continuity is the memo and
the condition ledger. This is also why caching works at all: `tools` + `system` are byte-identical
across every setup and every user, so one setup's read warms the prefix the next one hits. Giving
Talos a per-setup message history would move each setup into its own namespace and kill that.

---

## Phase 1 — what a setup carries

`services/setup.schema.js`. Three fields added, one changed, two deleted.

```js
// on the setup — the PLAN, authored or derived at Generate
pace_rungs: ['4hr', '1hr']        // CHANGED: never empty any more
market_cap: 'large'               // NEW: mega | large | mid | small | micro
read_mode:  'cheap_then_expensive' // NEW: the five below

// on monitor_state — MONITOR OUTPUT, rewritten whole by every expensive read, like guards
watch:          { rung: '15min', indicators: ['vwap', 'ema(20)'] },   // null = sleep
expensive_due:  12,               // closes until the next expensive read
```

**Two corrections the build made to this list.** `read_mode`, not `mode` — a setup's `mode` is
already the WORKSPACE (`live` | `paper` | `manual`), stamped at Generate, and one key meaning two
things is the trap the condition-`mode` rename exists to avoid. And `watch` belongs on
`monitor_state` beside `guards` and `memo`, not on the plan: it is never Mentor's to author.

**`pace_rungs` always has content.** Empty-means-anything is gone: it was a hole the floor had to
plug. Two sources, one shape — the rungs the user named, or the ladder Mentor computed. Nothing
records which, because nothing behaves differently: a user naming one rung and a ladder of one rung
are the same instruction.

**NAMED RUNGS ARE ABSOLUTE.** This field is where the user forces their own approach, and nothing
overrides it:

- Mentor may **not** add to them. A swing paced on the 15min stays paced on the 15min even when
  Mentor thinks the daily deserves a look. It may say so in the conversation — *"a swing judged on
  the 15min will show you a lot of noise"* — and then file what they said. Same rule the prompt
  already applies to prices: *the one thing you must not do to a level somebody chose is improve it.*
- Talos may **not** roam outside them, in either tier, ever.
- There is **no cap** on how many a user names. `MAX_PACE_RUNGS` does not exist — a cap would be the
  system overruling the user, which is the one thing this field is for. Mentor's own ladder is short
  because the table makes it short, not because a constant clips it.

This costs nothing in reach, because **reading stays unfenced**: being paced on the 15min decides
when Talos is *read*, never what it may *look at*. A condition may name any timeframe and the read
may chart any timeframe.

**`mode` — the five, and what each is for:**

| mode | every candle | when |
|---|---|---|
| `cheap_only` | cheap, never escalates | every condition is arithmetic on the watched rung |
| `expensive_only` | expensive | every condition needs eyes; nothing a cheap read could settle |
| `cheap_then_expensive` | cheap; `fired`/`unknown` escalates | the default. A trigger a cheap read can see |
| `expensive_then_cheap` | expensive until its outstanding structural conditions latch, then cheap | a structural precondition and an arithmetic trigger |
| `both` | cheap every close **and** expensive on its declared cadence | cheap watches the trigger; expensive re-reads the map |

`cheap_then_expensive` and `expensive_then_cheap` are the same machine from different starting
points, and the starting point falls out of which conditions are still outstanding. Mentor computes
the opening value; it is not a question the user is asked.

**Deleted:** `paceFloor` / `PACE_FLOOR` and `paceRange`. Their job was to bound an unbounded choice.
With a ladder always present there is no unbounded choice, and a floor on top of a ladder is a
second answer to a settled question. `isFetchableRung` stays — that is a data fact, not a policy.

---

## Phase 2 — the ladder

`services/setup.ladder.js` — new, pure, one table.

```js
ladderFor(horizon, marketCap) → rung[]   // coarse→fine
```

| horizon | mega · large | mid | small · micro |
|---|---|---|---|
| `intraday` | 5min · 15min · 1hr | 15min · 30min · 1hr | 30min · 1hr |
| `day` | 15min · 1hr · 4hr | 30min · 1hr · 4hr | 1hr · 4hr |
| `swing` | 1hr · 4hr · day | 4hr · day | 4hr · day |
| `long term` | day · week | day · week | day · week |

**These numbers are a starting point and want your eye on them** — the shape (finer as cap rises,
coarser as horizon lengthens) is the claim; the cells are a guess.

Market cap is fetched once at Generate and bucketed onto the document. Nothing re-fetches it; a
setup's ladder must not move under it because the stock had a good quarter.

---

## Phase 3 — the cheap read

**BUILT 2026-09-23.** `monitoring/talos.cheap.js` + `tests/unit/talosCheap.test.js` (16 tests).
Imports nothing from `talos.assess.js` — both take the numbers from `assess.shared.js`, which is the
pipe.

**What the build settled beyond the plan:**

- **`CHEAP_MODEL` is its own knob** (`TALOS_CHEAP_MODEL`, default Haiku 4.5 — what the replay
  measured). Deliberately not the house Talos model: paying the expensive tier's rate to decide
  whether to run the expensive tier would defeat the point.
- **The spend books under `talosCheap`**, its own agent key, so the ledger can separate the tiers.
  The cost pass of 2026-09-20 happened because two lines were invisible; a new tier that hides
  inside `talosAssess` would repeat that exactly.
- **`cheapWatch` falls back** to the stored rung, then the premise, when no `watch` has been
  declared — so this tier is usable before Phase 4.3 teaches the expensive read to declare one.
- **A setup with no conditions in words escalates without spending a model call.** Nothing written
  down is nothing this tier could judge.
- **Every failure path escalates**: unparseable reply, dead provider, junk `conditions`, a condition
  the model didn't mention. The asymmetry is the whole safety property — wrong towards `escalate`
  costs one read the user was going to pay for anyway; wrong towards `sleep` costs them the trade.

**Request:** no `tools` key at all. System prompt is short and frozen — one prefix for every cheap
read in the system, which makes it the best-caching object here.

**User content:**
- the setup's conditions, verbatim, with their ids
- the resolved ledger (latched conditions shown as settled, never re-asked)
- the candles on `watch.rung`
- the indicators named in `watch.indicators`, computed locally
- current price, the armed guards, the memo

**Response:**
```json
{ "conditions": [{"id": "s1c1", "state": "fired|not_fired|unknown", "note": "..."}],
  "escalate": true,
  "read": "<one first-person sentence>" }
```

`escalate` is the model's, but the monitor forces it true if any condition came back `fired` or
`unknown`. The model can escalate for its own reasons; it cannot decline to.

**Model:** open — see Open decisions.

---

## Phase 4 — the expensive read

`monitoring/talos.assess.js`. Three changes, no rewrite.

**4.1 — the opening block carries numbers, not just rows. BUILT 2026-09-23.** `candlesText` split
into `candleRows` (the fetch) + `formatCandles` + `indicatorsText` in `assess.shared.js`;
`openingContext` fetches once and returns both blocks. Zero extra fetches. This is the direct
attack on 0-of-71: the model reaches for a picture because the rows alone are a thin hand.

**What the build settled beyond the plan:**

- **The indicator lines go through `_formatIndicator`, the same formatter `get_indicators` uses.**
  Not a copy — the same function. Two VWAPs that disagree, one in the opening block and one from a
  tool call, is a bug nobody would ever find.
- **VWAP is intraday-only.** On a daily+ rung the bars pre-date any session anchor, so the number
  is noise wearing a name. It is absent there rather than printed as `n/a`.
- **The standard set is `ema(20) · ema(50) · rsi(14) · atr(14)`, plus `vwap` intraday.** Deliberately
  not a menu the model picks from — the whole point is that they arrive without being asked for.
- `get_indicators` keeps its own fetch. It is called for a DIFFERENT ticker or rung, which is the
  only case left worth a tool call, and the measured rate was 1 in 71 even before this.

**4.2 — the kit is per lens.** `buildToolsFor(setup)` stops returning the unfiltered kit and returns
the setup's lens kit. `discretionary` · `smc` · `institutional`. Frozen at Generate.

**4.3 — two new output fields**, validated and rewritten whole exactly as guards are:
```json
"next_expensive_in": 20,
"watch": { "rung": "15min", "indicators": ["vwap", "ema(20)"] }
```

**Ask for maturity, not for a budget.** The prompt wording carries this field — *"how many closes
before this setup is worth looking at properly again? A pattern that needs three more legs to form
is not a pattern you re-read next candle."* A model asked what it would like to spend answers
defensively and says 1.

**`watch: null` means the cheap tier does not run either.** If the read has nothing a numbers-only
pass could usefully check — the whole question is a shape forming — then a cheap read every close is
also waste. A null `watch` puts the setup fully to sleep until `next_expensive_in` elapses or a
guard fires. Their example lands here: `next_expensive_in: 20`, `watch: null`, guards on the neckline
and on the level that would say the pattern has failed.

**`next_expensive_in` is capped** (`MAX_EXPENSIVE_GAP`, ~24 closes). Most chart patterns complete at
a PRICE — a neckline, a trendline, a prior high — and a guard covers those exactly. What a guard
cannot cover is a setup whose completion has no level: "RSI divergence forming", "volume drying up".
The cap is the backstop for those, and nothing else is.

`get_indicators` loses its refetch — it takes the bars it is given. It survives only for a *different*
ticker or a *different* rung than the one the read opened on.

---

## Phase 5 — the monitor

`monitoring/talos.monitor.service.js`. `_checkSetup` gains one branch at the top and loses nothing
else.

```
wake (candle close, or a guard fired, or expiry)
  │
  ├─ validity breach?  → card, no read          (unchanged, free, still first)
  │
  ├─ expiry review?    → EXPENSIVE READ          (a scheduled decision, not a "did something
  │                                              happen" question — never triaged. The replay
  │                                              found this the hard way: the cheap tier's one
  │                                              missed action was a let_expire it slept through)
  │
  ├─ mode says expensive this close?            (expensive_only · both on cadence ·
  │     → EXPENSIVE READ                         expensive_then_cheap while outstanding ·
  │                                              the cheap read escalated last close)
  │
  ├─ guard fired?      → EXPENSIVE READ          (a price guard is the model's own alarm —
  │                                              it does not get triaged)
  │
  ├─ watch is null?    → SLEEP, no read at all   (the last expensive read said there is nothing
  │                                              numbers can settle — see 4.3)
  │
  └─ else → CHEAP READ
             ├─ not_fired → sleep. One journal row, no card.
             └─ fired / unknown → EXPENSIVE READ, same wake, no extra candle of delay
```

Three costs per close, then: **nothing** (asleep on a null `watch`), one cheap read, or one
expensive read. The floor is genuinely zero — a setup waiting twenty closes for a pattern to form
costs its guard sweep and nothing else.

A guard firing skips triage on purpose: the expensive read armed that price precisely because it
wanted waking there.

---

## Phase 6 — the entry gate

**BUILT 2026-09-23.** `firingLeg` (setup.schema) + the branch order in `_applyVerdict`; the
`_PRE_ENTRY` prompt rewritten to match, because it was still telling the model a rule the code had
stopped enforcing. 5 tests in `talosMonitor.test.js` (not the planned `talosEntry.test.js` — the
harness `stubDeps` lives there and duplicating it would be worse than the extra file is worth).

**What the build settled beyond the plan:** an `enter` places at the plan's OWN authored entry
price, never at spot — so an `enter` while price sits past that level is a resting order that may
never fill. The code allows it; the prompt now tells the model exactly that and says the honest
answers when the plan no longer works from here are `wait` or `edit`. This is deliberately a
judgment the read makes, not a veto the monitor applies, because the monitor cannot tell the
difference between "price ran away" and "price came back to me".

---

**Not in your spec, and it has to be here anyway.** The cheap read's whole job is answering "is the
setup fired?", and today a `fired` answer cannot become an entry: `_applyVerdict` only places an
order inside `if (zone)`, where `zone` comes from a containment test against a zero-width price.

Measured in prod: **18 of 18 entry zones are zero-width points**, and **only 2 of 70 journal rows
carry a `zone_id` at all** — so ~97% of wakes reach the read with no zone under them and `enter`
structurally unavailable. Entries currently work only because the model happens to arm its entry
guards at the exact authored price (5 of 5 in prod do). The one local counter-example arms 1.7% away
and cannot resolve to a leg.

Worse for this plan specifically: `clampGuards` drops an already-satisfied directional guard, and
`woke_on` is one-shot. So a setup whose price arrives *before* its conditions confirm — a pullback,
a reclaim, a sweep-and-go, the most common shape there is — can end up with no path to `enter` at
all.

**The fix, and it is a deletion.** The zone stops being a gate. It keeps its three real jobs — the
order price, the size, the r:r — and stops being a second opinion on a decision the read already
made. `_applyVerdict` acts on the verdict; the leg comes from the scenario already resolved for that
read. Nothing needs a tolerance, and the `clampGuards`/`woke_on` interaction stops mattering because
nothing depends on `hit` any more.

---

## Phase 7 — Mentor

**BUILT 2026-09-23.** Smaller than planned, because Phase 1 already derives server-side what the
plan expected Mentor to author:

- **`read_mode` is NOT Mentor's.** `defaultReadMode` derives it from the same conditions Mentor
  would have read, deterministically. Deriving beats asking: it cannot drift, and Mentor may still
  override it when it has a reason.
- **The ladder is NOT Mentor's either.** It emits `pace_rungs: []` when nobody named a rung, and
  `normalizeSetup` fills it from `ladderFor(horizon, cap, premise)`. The prompt says so outright —
  *"that is not your job and you must not invent a ladder in prose."*
- **`market_cap` binds at Generate**, beside the venue and the event risk, then the draft is
  re-normalised with the cap in hand so the ladder can use it. `getMarketCap` shares the `/profile`
  fetch and cache that `getSectorRaw` already had — one call behind both, rather than a second cache
  answering the same row.
- **`watch` left `PLAN_FIELDS`.** It is monitor output on `monitor_state`, not plan.

What IS Mentor's is the interview and the filing: asking which chart the plan is drawn on and which
they want it watched on (with "no idea" a complete answer), and **expanding a spoken range** —
*"15min to 1hr"* is `["15min","30min","1hr"]`, never the two endpoints.

---
## Phase 7 — Mentor

`prompts/mentor_system_prompt.md` and `services/setup.finalize.js`.

- The interview asks for rungs as it does now — *"which chart do you want this watched on?"* — and
  takes "no idea" for an answer.
- **Named → those rungs. Not named → `ladderFor(horizon, marketCap)`.** Mentor does not invent a
  ladder in prose; it calls the table.
- **A SPOKEN RANGE EXPANDS TO ITS RUNGS.** *"15min to 1hr"* is the common way a trader says this —
  it is `["15min", "30min", "1hr"]`, every rung between the endpoints inclusive, not the two ends.
  *"nothing under the 4hr"* on a swing is `["day", "4hr"]` — the endpoint plus everything coarser
  that the horizon reaches. A single rung stays a single rung.
- Mentor may push back on a choice in words and must then file it verbatim. It never widens, narrows
  or supplements what was named.
- Mentor sets the opening `mode` by reading its own conditions: all arithmetic on one rung →
  `cheap_only`; all judgment → `expensive_only`; a structural precondition plus an arithmetic
  trigger → `expensive_then_cheap`; otherwise `cheap_then_expensive`. Says which in a clause.
- Market cap is fetched at Generate and bucketed.
- Mentor never authors `watch` — that is the expensive read's output.

---

## Everything deleted

| | why |
|---|---|
| `paceFloor`, `PACE_FLOOR`, `paceRange` | a floor under a ladder is a second answer to a settled question |
| `pace_rungs: []` as a meaning | there is no "Talos picks from everything" any more |
| `zoneGate` / `scenarioGate` / `_hitFromGuard` as an ENTRY gate | Phase 6. They may survive as "which premise is price at" for the prompt; they stop deciding |
| the refetch inside `makeIndicatorsHandler` | it re-fetches bars the caller already holds |
| `buildToolsFor` returning the unfiltered kit | D7 |

---

## Tests

| file | what |
|---|---|
| `setupSchema.test.js` | `pace_rungs` never empty · `mode` enum + default · `watch` normalisation · floor gone |
| `setupLadder.test.js` | new — every horizon × cap cell, coarse→fine, fetchable only |
| `talosCheap.test.js` | new — three-valued parse · `fired`/`unknown` force escalate regardless of the model's own `escalate` · a malformed reply escalates |
| `talosMonitor.test.js` | the branch: which tier runs, per mode · guard skips triage · `not_fired` writes a row and no card |
| `talosAssess.test.js` | indicators in the opening block · lens kit · `next_expensive_in` and `watch` validated and rewritten whole |
| `talosEntry.test.js` | new — `enter` fires with no `hit`, at the authored price, on the resolved scenario |

---

## Commit order

1. Phase 2 ladder (pure, no callers) + tests
2. Phase 1 schema + tests — `pace_rungs`/`mode`/`market_cap`/`watch`, floor deleted
3. Phase 6 entry gate + tests — **independently shippable, and worth shipping first**
4. Phase 4.1 indicators in the opening block — measurable on its own against the replay harness
5. Phase 3 cheap read + tests
6. Phase 5 monitor branch + tests
7. Phase 4.2/4.3 lens kits + the two new output fields
8. Phase 7 Mentor + prompt
9. Docs: `desks/mentor-talos.md`, `CODE_MAP.md`

Steps 3 and 4 are worth doing and measuring before 5 — the cheap tier is being sized against a read
that currently pays for three vision calls it was told not to make, and 4.1 may move that number on
its own.

---

## Open decisions

1. **Which model runs the cheap read.** Haiku 4.5 is the obvious candidate and you rejected Haiku
   for a Talos read on 2026-09-20 — for the *verdict*. This is triage, whose failure mode on any
   doubt is "escalate", i.e. the read you were going to pay for anyway. Confirm that distinction
   holds before it is built.
2. **The ladder cells** in Phase 2.
3. **Does `cheap_only` really never escalate?** As written it means a setup can run its whole life
   without a full read — cheapest possible, and also the one mode where nothing ever looks at the
   chart. The safe variant is a floor: `cheap_only` still takes one expensive read on `first_look`
   and one at expiry review.
4. ~~**Replay the recorded reads through a cheap prompt first.**~~ **DONE 2026-09-23 — the tier
   clears the bar.** 95 recorded bundles, frozen bars from each one's own data pack, Haiku 4.5,
   $0.33:

   | | |
   |---|---|
   | slept — no expensive read needed | **74 / 95 = 78%** |
   | condition states | `not_fired` 74 · `unknown` 20 · `fired` 1 |
   | reads whose real verdict ACTED | 2 |
   | of those, missed | 1 (the `let_expire` — fixed by the expiry branch in Phase 5) |

   Cost on this sample: **$15.68 → $3.80, a 76% reduction**, before Phase 4.1 touches the expensive
   read's own 3.77 tools.

   **What this does NOT establish:** only 2 of 95 reads did anything, so the safety column has no
   statistical power. The 78% saving is solid; "it does not miss actions" is not yet a claim the
   data can carry. Before the tier is trusted with `cheap_only` (Open decision 3), it needs replaying
   against a sample with real entries in it — either a longer prod window once there are more, or
   hand-built cases where a condition genuinely fires.

   The 20 `unknown`s are the design working: the tier declined to guess on conditions the numbers
   could not settle, and every one escalated.
