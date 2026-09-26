# Mentor — the paths not taken

**STATUS: PLANNED 2026-09-26. Nothing below is built.** Names in backticks that do not resolve yet
(`services/setup.taxonomy.js`, `flip_test`, `on_away`, `alternatives`) are the plan's own
vocabulary, not drift — `npm run check:docs` will report them unresolved until the phases land, and
that is correct. Update this line phase by phase.

**Scope: Mentor (authoring) plus ONE card change at Talos.** No monitor logic, no new assess
behaviour, no frontend. Decided with Roy 2026-09-26 in a principles-first pass; the discussion that
produced it is summarised under [Principles](#principles) because the principles are what govern the
build when a detail below turns out to be wrong.

---

## The problem

Mentor authors a plan and the app checks whether it is **well formed** — a stop on the right side, an
R:R that clears 1R, a validity range in order, a size the user gave. Nothing checks whether it was
the **best plan available**, and nothing tests whether the analysis behind it was work or fluency.
Those are the two questions a user actually has when they read a setup they did not write:

1. *Is there a better way into this than the one you picked?*
2. *Did you really think this through, or is this the first thing that came out?*

Neither is answerable today, and the failure modes are specific to the medium. A model asked to
double-check its own work agrees with itself. A reasoning trace is not a faithful record of the
computation that produced the answer, so "explain your thinking" is not evidence of diligence. And
iterating with a model converges on agreement rather than on truth, so a user who pushes back twice
gets a concession they cannot distinguish from a refutation.

What IS evidence: an observation from a tool, a number that can be compared, a choice made from a
closed set, and a check written in code that refuses.

## The spine

Three features, one obligation: **the plan must account for the paths it is not on.** There are
exactly three such paths, and each gets one mechanism.

| Path not taken | Mechanism | Shape |
|---|---|---|
| the other **direction** | [the flip test](#2--the-flip-test) | an optional pass, one sidecar call |
| the other **way in** | [closed taxonomy + rejects](#1--closed-taxonomy--the-rejects-pool) | always-on worksheet fields |
| the path where price **never comes back** | [the runaway handoff](#3--the-runaway-handoff) | an authored answer + a card that opens Mentor |

And the per-axis challenge this began as — *why that stop, why that target, why that entry* — needs
no feature at all. The taxonomy turns every one of those into a citation from a closed set, which is
answerable in plain conversation and checkable afterwards. See
[why there is no challenge subsystem](#why-there-is-no-challenge-subsystem).

## Principles

These govern the build. Where a phase below contradicts one of these, the principle wins.

1. **A challenge attacks the plan; it does not shop for a different one.** The question is *where is
   this wrong*, not *what else could we trade*. The moment a challenge may propose a different trade
   it is a rebuild, and the user loses the verdict they asked for.
2. **It must be able to come back empty.** `stands` is a real and frequent outcome. A pass that
   always finds something is noise, and the empty rate is the metric that says which kind we built.
3. **A challenge proposes; it never rewrites.** Its output is a list of decisions for the user.
4. **The author cannot be the only judge.** Independent judgment over a shared evidence base — which
   is why the flip test is blinded and server-fed rather than a self-review.
5. **Evidence on both sides.** Attack and defence each cite a measurement already taken. The same
   gate the conditions themselves pass ("how would anyone know?"), turned on the plan.
6. **A challenge is not won by repetition.** The read changes when a FACT changes, never because the
   user asked again. The existing rule protects the user from nagging; this is the mirror that
   protects them from a pushover.
7. **Some fields are the user's and are not on the table.** Size, always. Horizon too — it is how
   they trade, so the only honest verdict is *this chart does not support the horizon you trade*,
   never *trade a different horizon*.
8. **The axes cascade.** Direction → lens → entries → stops/targets. A landed challenge upstream
   voids everything below it; a plan that keeps downstream numbers after an upstream change is a plan
   nobody authored.
9. **Challenging belongs to authoring time.** Before Generate nothing is armed. After arming it is an
   edit; after entry it is Talos's job.
10. **On a plan the user brought, a challenge is something they ASK for, and its result is a comment,
    not a change.** Roy's rule, 2026-09-26. It splits every feature below along the line the prompt
    already has — the interview vs the guided build.

---

## 1 — Closed taxonomy + the rejects pool

"Did it consider a better option" is unanswerable as an open search and trivial against a closed set.
Trading entries are a closed set: there are about eight ways anyone enters, five things a stop
anchors to, five things a target anchors to. Once the set is closed, coverage is a finite question
with an auditable answer.

### The three vocabularies

Direction-agnostic, phrased for a long and mirrored for a short. Small on purpose — eight archetypes
is a real cover; fifteen makes the rejection list noise.

**`ENTRY_ARCHETYPES`** — `pullback` · `breakout` · `retest` (the second chance after the break) ·
`sweep_reclaim` · `fade` · `gap_fill` · `momentum_continuation` · `event_gated`

**`STOP_ANCHORS`** — `structure` (last swing) · `level` (far side of the level traded) · `session`
(PDL/PWL) · `volatility` (ATR multiple) · `indicator` (the MA/VWAP the thesis lives above)

**`TARGET_ANCHORS`** — `liquidity` (next pool) · `structure` (next shelf) · `measured_move` ·
`session` (PDH, round number) · `r_multiple`

**`SIBLINGS`** — which archetype is the continuation of which, used at the runaway redraw:

| primary | sibling |
|---|---|
| `pullback` | `retest` (preferred), else `breakout` |
| `sweep_reclaim` | `retest` of the reclaimed level |
| `gap_fill` | `momentum_continuation`, else none |
| `fade` | **none** — a fade that runs away is the other direction's trade |
| `breakout` · `retest` · `event_gated` | **none** — already on the momentum path |

They live in code (`services/setup.taxonomy.js`), with a prose mirror in the prompt and a drift test
asserting every id appears in both — the `promptToolDrift.test.js` idiom. A taxonomy that exists only
in prose cannot be checked, and checking it is the whole point.

### Worksheet additions

- per scenario: **`archetype`**
- per stop leg and target leg: **`anchor`**
- per setup: **`alternatives: [{ archetype, price, why_not }]`** — capped at 5, `why_not` one clause

`alternatives` is **the pool scenarios are promoted out of.** "Make the retest a second scenario"
moves that entry into `scenarios[]` and removes it from the pool — one truth, and a mechanic the user
drives in words.

**Not to be confused with `<setups>` candidates.** Candidates are rival PLANS you choose between and
discard. Alternatives are rejected ways INTO this plan, recorded. Different mechanism, different
lifetime.

**Token discipline:** authored once at the scenario rung and carried forward unchanged, exactly like
condition ids. Paid for once, never re-derived per turn.

### Coverage strength — 1 and 2 now, 3 deferred

Three possible strengths, and the choice was deliberate (Roy, 2026-09-26):

1. **Prompt obligation** — Mentor names what the chart offered and kills what it did not take. Free,
   unverifiable. **IN SCOPE.**
2. **Readiness warning** — the gate says so when `alternatives` is empty. Cheap, soft. **IN SCOPE.**
3. **Verified coverage at Generate** — the server re-calls the numeric engines and lets the TOOLS'
   OUTPUT decide which archetypes owe an answer: an unfilled FVG exists → `gap_fill` owes a
   `why_not`; a liquidity pool below the entry → `sweep_reclaim` owes one; a broken level with no
   retest leg → `retest` owes one. No model involved. **DEFERRED** — schema must accept it without a
   migration.

Why defer the strongest one: 1 and 2 are a day's work and they reveal from real builds WHICH
archetypes Mentor actually skips. Writing 3 first means guessing at the checks.

### On the interview path

`alternatives` stays **empty**. Mentor did not choose the archetype — the user did, and filling the
pool with what they could have done instead is re-opening their plan by the back door (principle 10).
What Mentor still does is **file**: `archetype` and the leg `anchor`s, exactly as it already files
`trade_mode` from their conditions without asking.

### Persistence

`alternatives` **persists past Generate** into the document and onto the confirm card. Three rules:

- **The monitor never reads it.** Provenance, not conditions. Nothing in `monitoring/` may consume
  it, and the assess prompt must never be "improved" by being fed the rejects.
- **It is a snapshot, stamped as of authoring**, and displayed that way. The reason a gap fill was
  skipped stops being true when the gap fills; that is what a journal entry is.
- **It does not travel in a shared blueprint** (`services/setup.blueprint.js`). A fork gets the plan;
  the author's reasoning about what they did not take stays with the author.

The second reason to persist is the one that matters later: this is the **only record of the road not
taken**. When the offline grader exists, "was Mentor right to skip the sweep?" is only answerable if
the skip was written down.

---

## 2 — The flip test

Re-author the DIRECTION on the same evidence, independently, and compare.

### The blinding is the whole design

If Mentor assembles the case file, the flip test is theatre: it will hand over an evidence pack with
the inconvenient facts thinned out and get back the weak counter-case it expected. So:

- **The server assembles the pack**, from the same numeric engines Mentor used — structure, key
  levels, liquidity, FVGs, indicators, ATR, positioning, the dates. Verbatim numbers, no prose.
- **The sidecar argues the other side** — `deepThink` (Opus 5.5, high), blind to the conversation and
  blind to Mentor's thesis and conviction.
- **Mentor never touches the input.** It relays the verdict and decides what to do about it.

The tool takes only what identifies the question — symbol, timeframe, horizon, the plan's direction.
Anything the model could use to bias the pack is not a parameter.

### Output contract

The opposite case with its own entry, stop and first target, its own R against the 1R floor, then a
comparison verdict: `chart_favours: this | neither | the_other`, with one line of why.

**Stated limits, in the output:** the pack is structure and positioning only. No macro tone, no news
read. It must never override a dated catalyst, and it says so rather than implying an engine
disagreed.

### The three readings

- **Weak flip** → the original read is chart-driven. `stands`.
- **Equal flip** → the chart is two-sided. The most valuable outcome and the one nothing in the app
  produces today: wait for the trigger that distinguishes the two sides, arm both, or stand aside.
- **Strong flip** → the direction rung reopens and everything below it is void (principle 8). No
  keeping the targets.

### Conviction — bad news moves the number, good news moves the words

If surviving raised the score, conviction would measure how many times the pass was run. So:

- **flip lands** → not a conviction event at all. The plan is rebuilt or dropped.
- **flip equal** → **this is the conviction event.** Score down, and the rationale names the cap:
  *"the short case off the same structure clears 1R too — this needs the trigger to distinguish it."*
  The prompt already asks the rationale to name what caps the read; this writes that sentence.
- **flip weak** → the rationale gains a line, the score does not move.

### When it runs

- **On request, always.**
- **Offered once at ready, on real money only** — `live` or `manual` offers, `paper` does not. A
  deterministic trigger, using a distinction the app already makes everywhere, so the offer stays
  rare enough to register. The offer is the cost driver, not the feature.
- **Never offered on the interview path.** Only if the user asks outright. If it lands there, Mentor
  says it in ONE line, files the plan exactly as given, and the verdict goes into the conviction
  rationale so it is in front of them at confirm (principle 10).
- **The moment is always AT READY** — after levels and size exist, before Generate. Earlier is wasted
  breath because the levels are still moving.

### Provenance

A small `challenge` block on the setup, under the same rules as `alternatives` (monitor never reads
it): which pass ran, the verdict, when. It is what lets a confirm card say "this was attacked"
honestly, and it is the other half of the counterfactual record for the grader.

---

## 3 — The runaway handoff

### What exists today

Talos already detects it and already gets the semantics right: `awayEdge` and `validityBreach` in
`monitoring/talos.gates.js` separate *the premise broke* from *it ran away*, `breachPatch` marks the
scenario `drifting`, announces once, and **never closes the setup** — price can come back. The card
is `ran_away` in `services/tradeNotify.service.js`.

**What is missing is intent.** The away edge has a detector and nothing authored behind it, and the
card deliberately carries **no action button**. The comment says why: *"Not a problem to solve, so no
action button; a chase is the user's own decision to make from a clean slate."*

### That decision is overturned, and this is the reason

"A clean slate" is where FOMO lives, and the card assumes the only thing on the table is a chase. It
is not — there are three outcomes and two of them are not chases:

1. the original plan still stands and the pullback is still plausible (the setup is not closed);
2. an honest continuation exists on TODAY's structure and clears 1R;
3. it is gone, close it.

Leaving the user to triage that unaided, while the move is running, is the worst possible moment to
hand them a blank page. Going back to Mentor with the plan loaded is the OPPOSITE of a clean slate —
it is the 1R floor and the anchor taxonomy applied at the one moment they matter. It also aligns with
the newer card convention: a card worth sending is a card that opens something.

### Two answers, not four

`validity.on_away`, sitting beside `on_break` so the two edges finally have two handlers:

- **`revise`** (default, mirroring `on_break`'s default) — Talos says *price went without you, go
  back to Mentor*, and the card opens Mentor with the plan loaded.
- **`pass`** — the user already decided to let it go. The card comes with no button and asks nothing.

**`continuation` was considered and dropped**, and the argument is worth keeping because it looks
like a good idea: pre-author the sibling scenario at build time so the runaway path is already armed.
It fails because **no entry ever fires without the user's confirmation** — an armed scenario produces
a confirm card, not a fill. So pre-authoring buys no action while the user is asleep; it buys a
confirm card when they wake, where `revise` buys a redraw card when they wake. Identical timing, and
the pre-authored one carries a price measured BEFORE the break. Fresh wins.

The deeper reason is the desk's own rule: a level for structure that has not printed is a level from
imagination, and "live before levels" forbids it everywhere else.

"Both paths armed" does not disappear — it stays what it already is: a second scenario the user asks
for at build time because they want the pullback AND the breakout, both levels existing today. That
is ordinary scenario authoring, not a runaway mechanism.

**`mandate` — the designed-but-unbuilt fourth.** If evidence later shows `revise` pings arriving too
late to act on, the bounded hand-off is the shape to build: not a price but a permission — direction,
the archetype allowed, the worst price still payable, the risk cap, an expiry. Talos authors the
price when it can see it; the user still confirms. It crosses the line where a monitor authors a
premise, so it needs the evidence first.

### The Mentor side — arriving from a runaway

The valuable half, and a prompt section in the shape of the existing "a user may arrive FROM Aether"
passage:

- **Re-measure before anything.** `get_quote` and candles. The level moved; nothing from the old
  conversation is a price any more.
- **Say where price sits against the old plan**, which is still armed. "Wait" is a real answer.
- **The direction and the lens do NOT reopen.** The read was not wrong, the entry was missed. Only
  the entry rung is unsettled — no cascade.
- **Three outcomes, named** — the original stands and you wait · a continuation on today's structure
  that clears 1R · it is gone, close it.
- **Size is re-derived from the same risk budget**, never inherited. A different stop distance is a
  different share count, and copying the quantity silently changes the risk while looking identical.
- **Targets are re-derived**, never inherited. Entering six dollars higher makes the old TP1 a
  scratch: with 244/241 against a 246.5 first target the R is 0.83 and the trade is not there, where
  the next pool at 252 gives 2.7.
- **The 1R floor does not move because the user missed the trade.** The sentence the whole feature
  exists to deliver, and the one a user will not say to themselves at that moment.

---

## Why there is no challenge subsystem

The request that started this was "challenge everything — direction, horizon, entries, targets,
stops". The design deliberately does not build a challenge engine, because after the three mechanisms
above there is nothing left for one to do:

- **Direction** → the flip test.
- **Entries** → the taxonomy plus the rejects pool: the archetype was chosen from eight, and the
  seven not chosen either have a `why_not` or are absent from a chart that did not offer them.
- **Stops and targets** → the leg `anchor`. *"Why that stop?"* becomes *"`structure` — the last swing
  at 234.8; the alternatives were the order-block far edge at 233.1 and 1.5×ATR at 232.6, both wider
  than the R would survive."* A citation from a closed set, attackable by naming a different member
  of the set.
- **Horizon** → principle 7. It is the user's, and the only verdict available is whether this chart
  supports it, which the guided build's rung 3 already produces.

Three features, a closed vocabulary, and one gate. No new conversational mode.

---

## Build plan

Five phases. Each ends with tests and a green suite (`npm test` excluding
`tests/unit/talosRecorder.test.js`, which leaks a headless Chromium — known, 2026-09-24).

### Phase 0 — the vocabulary

`services/setup.taxonomy.js`: `ENTRY_ARCHETYPES`, `STOP_ANCHORS`, `TARGET_ANCHORS`, `SIBLINGS`, each
an array of ids plus a one-line gloss, and `siblingOf(archetype)`. No behaviour.

*Tests:* shape and uniqueness; `SIBLINGS` decides every archetype and invents none; the chain is one
hop (the "you do not chase a chase" rule, asserted); `siblingOf` tolerant of junk and of inherited
object keys.

**The prose-mirror drift test belongs to Phase 2, not here** — it asserts every id appears in
`prompts/mentor_system_prompt.md`, and that prose does not exist until Phase 2 writes it. Corrected
after Phase 0 landed; the plan had it in the wrong phase.

### Phase 1 — the schema and the gate

`services/setup.schema.js`:

- normalize `archetype` on a scenario and `anchor` on stop/target legs, both against the taxonomy,
  unknown → null (never a throw; the plan still builds).
- normalize `alternatives[]` on the setup: cap 5, trim `why_not`, drop entries with no archetype.
- normalize `validity.on_away`: `revise` | `pass`, default `revise` — the same shape as `on_break`.
- a `challenge` provenance block: `{ pass, verdict, at }`, additive, never required.

`setupReadiness`: a soft warning when `alternatives` is empty, and **`on_away` required on every
scenario**. Required on every one rather than only on return-requiring entries, so the gate stays
pure — deciding "does this entry need price to come back" needs a live quote, and readiness must not
fetch. The quote-aware nuance lives in the prompt, which asks the question in the way that fits the
archetype.

*Tests:* extend `tests/unit/setupSchema.test.js` (normalisation, defaults, caps) and
`tests/unit/setupsGenerate.test.js` (the gate blocks on a missing `on_away`, warns on empty
`alternatives`). Check `services/setup.blueprint.js` drops `alternatives` and `challenge` — with a
test, since a share leaking the author's rejects is the kind of thing nobody notices.

**BUILT 2026-09-26** — `services/setup.taxonomy.js` + `tests/unit/setupTaxonomy.test.js` (11 tests).
Settled beyond the plan: the glosses are trailing comments rather than exported data (no runtime
consumer would have read them, and the prose mirror is the prompt's), and `SIBLINGS` is exported
alongside `siblingOf` so the drift test can assert total coverage rather than probing one id at a
time.

### Phase 2 — the prompt

`prompts/mentor_system_prompt.md`, four additions:

1. **The taxonomy**, as prose mirroring Phase 0, plus the filing rule: the archetype and the anchors
   are Mentor's read of the plan, never a question put to the user — same as `trade_mode`.
2. **The rejects pool** at the scenario rung (guided build rung 6): name what the chart offered, kill
   what you did not take in one clause, and the promotion mechanic. Empty on the interview path.
3. **The away question**, asked at the same rung in the archetype's own words — *"this needs price to
   come back to 238; if it just goes, do you want a redraw ping or do you let it go?"* One question,
   a shrug closes it, `pass` is accepted instantly without argument.
4. **Arriving from a runaway**, as specced above.

Plus the flip test's offer rule once Phase 3 lands.

*Tests:* a new `tests/unit/mentorChallenge.test.js` asserting the prompt carries every taxonomy id,
the `on_away` vocabulary, and the runaway section's load-bearing sentences; plus the existing
`tests/unit/mentorAgent.test.js` still green.

### Phase 3 — the flip test

- `services/flipTest.service.js`: assemble the numeric pack (reusing the providers behind
  `get_structure` / `get_key_levels` / `get_liquidity` / `get_fvg` / `get_indicators`), call
  `deepThink` with an adversarial system prompt, parse the verdict. Booked under its own ledger tag
  (`flip:mentor`) so its cost is visible separately from `consult`, and capped at one per turn.
- Declared in `MENTOR_TOOLS` **before `consult`**, which must stay contractually last
  (`agentToolsRegistry.test.js`) — and still after the tools cache breakpoint inside `TRADING_TOOLS`.
- Containment identical to `deepThink`'s: a failed flip returns a readable answer and never fails the
  desk's turn.

*Tests:* the handler ignores any model-supplied evidence (the blinding, asserted rather than
described); a failed pack and a failed sidecar both return prose and never throw; the per-turn cap;
the ledger tag.

### Phase 4 — the runaway card

`services/tradeNotify.service.js`: `ran_away` gains a primary action that reopens the setup in Mentor
— the destination the list pencil and Axl's `<edit>` already reach — when `on_away: revise`. A
`ran_away_fyi` variant with no button for `pass`, mirroring `invalidated` / `invalidated_fyi`. Push it
(a runaway decays; the copy says it is worth a look while the move is live). `breachPatch` passes
`on_away` through in the away branch, exactly as it passes `on_break` in the adverse one.

*Tests:* extend `tests/unit/setupNotify.test.js` — card kind and actions per `on_away`, fire-once
unchanged, the payload still carries `side`/`edge`/`scenario`.

### Phase 5 — docs

This doc's STATUS line, the Talos section of `docs/desks/mentor-talos.md` (the away edge now has
authored intent), `docs/desks/trade-pipeline.md` (the runaway → Mentor loop), `CODE_MAP.md` (the new
service and taxonomy), `docs/README.md` index. Then `npm run check:docs`.

---

## Conflict check

Written before the build, per CLAUDE.md, because most of these touch shared state:

- **`setup.schema.js` normalisation is on every path** — generate, validate, blueprint hydration,
  share, the monitor's own reads. New fields must be additive and default-safe: a plan authored
  before Phase 1 must still normalise. Setups were WIPED in both DBs on 2026-09-24, so there is no
  migration — but `archive/` and the `call` kind share none of this, which is why the blast radius is
  small.
- **`setupReadiness` drives the Generate button AND `POST /api/setups/validate`.** A new hard
  requirement changes what the frontend shows as blocking. `on_away` has a default, so the only way
  to hit the block is a model that omits the field — which the prompt must therefore carry before the
  gate ships. **Phase 2 lands before Phase 1's hard gate is switched on.**
- **`MENTOR_TOOLS` order is a cache boundary.** Anything new goes after the breakpoint inside
  `TRADING_TOOLS` and before `consult`, which is contractually last at every desk.
- **`alternatives` costs output tokens on every worksheet re-emit.** Authored once and carried
  forward is the mitigation; if real builds show it being re-derived each turn, that is a prompt bug
  and not a reason to drop the field.
- **The monitor must not read the new provenance fields.** `alternatives` and `challenge` are
  authoring records. Worth a comment at both ends, because the assess prompt is exactly where someone
  would helpfully add them.
- **`ran_away` gaining a button changes an existing notification's contract** — the frontend renders
  card actions generically, but a card that previously never had actions may not have been exercised
  with them. Verify against the real client before calling Phase 4 done.
- **Conviction is now moved by a second mechanism.** Today it is Mentor's read of its own reasoning;
  after Phase 3 an equal flip caps it. Only downward, and only on `neither` — never on a pass that
  merely ran (see the conviction rule above), or the number becomes farmable.

## Deferred, with the reason

- **Verified coverage (strength 3).** Wait for real builds to say which archetypes get skipped.
- **`mandate`** — the bounded Talos hand-off. Needs evidence that `revise` pings arrive too late.
- **The golden set and conviction calibration.** The only things that ever settle whether any of this
  improved the plans rather than changed them. Everything above is process; the offline
  labeler/graders on the deferred list is what turns `conviction` from an assertion into a
  measurement, and the `challenge` + `alternatives` records are the counterfactual data it will need.
- **Frontend surfacing** — the rejects list and the "this was attacked" line on the confirm card.
  Backend writes them first; nothing renders them until then.
