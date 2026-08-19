# The opportunist — trading the lag, not the news

**Status: DESIGN ONLY, nothing built.** Settled 2026-08-13, substantially revised 2026-08-16 — the
revision moved the centre of gravity from *reasoning about one headline* to *automating unowned tedium
at volume* (§3, §4). A desk that reacts to an event and finds the second/third-order instrument that has
not repriced yet. Working name **Tyche** (fortune) — Kairos, which literally means *the opportune
moment*, is unfortunately already the call desk. Name not decided.

Relates to: `prompts/strategy_system_prompt.md` (Pythia — and §12 on why this is NOT her),
`api/strategy/tilt.service.js` (the grading machinery this borrows), `docs/design/pipeline-service.md`.

---

## The one line

**It does not trade the news. It trades the lag between the news and its consequences being modelled.**

Crude reprices in milliseconds. Tanker equities reprice in weeks, because that leg requires a sell-side
analyst to cut estimates first. The desk lives entirely in that gap.

---

## 1. Why it can work without an information edge

There are two separate risks in any event trade, and they need completely different capabilities:

| Risk | Needs | Have it? |
|---|---|---|
| **Will the event happen?** | tanker AIS, expert networks, political sourcing, physical desks | No, and not buyable |
| **If it happens, what does it imply?** | research, patience, a written transmission chain | Yes |

Reacting *after* the event discards the first risk entirely and keeps only the second. That is the whole
design. Positioning ahead on a scenario we cannot handicap is not sophistication, it is an uncompensated
bet — so we do not take it, and we accept paying the post-event price as the cost.

**The fast legs are conceded on purpose.** Crude, gold, defence, airlines on a peace headline — those are
lost to co-located machines before we finish reading. Every "AI news trading" product races for that leg.
This one deliberately goes the other way.

### 1.1 The rule that decides which legs are tradeable

> **The tradeable legs are the ones that only reprice after a human revises a model.**

An algo maps *"crude down → airline fuel cost down"* instantly. No algo maps *"peace → shorter tanker
routes → ton-mile demand falls → charter rates soften → sell-side cuts FRO estimates → equity re-rates."*
That takes analysts doing work over weeks. The lag is human and structural.

Corollary, and the practical filter when authoring a chain:

> **If the chain is short enough to state in one clause, it is already gone. The edge starts at the third clause.**

| Leg | Reprices in | Ours? |
|---|---|---|
| Crude on the headline | milliseconds | no |
| Gold, defence, airlines | same session | rarely |
| Tanker rates → shipper equities | days–weeks | **yes** |
| Energy HY spreads, oilfield services capex | weeks | **yes** |
| Petro-currency terms of trade | days | sometimes |

---

## 2. Where the edge actually is — the honest inventory

Written down because it is easy to fall in love with the wrong half of this design.

**Not an edge:**

- **The chain reasoning.** A user with ChatGPT builds the same chain, possibly a better one. Zero moat.
  This is the exciting part of the document and it is the commodity part.
- **Speed.** Given away deliberately (§1). Correct call, but it means no edge there by construction.
- **Information.** §1's table says it outright — the "will it happen" capability is not buyable.

**Possibly an edge, all of it process rather than insight:**

- **Measurement that actually happens every time.** ChatGPT *can* compute a z-score. It will not do it
  for thirty names, correctly, unsupervised, on every single event. Reliability and repetition, not
  capability — and it is the difference between knowing you are late and feeling early.
- **A kept record with frozen prices and deadlines** (§10, §13). The only thing here that compounds.
  Nobody keeps this by hand; everyone intends to.
- **The rejected-names ledger** (§13b). A calibration dataset on our own strictness. Almost nobody has one.
- **Enforcement against ourselves.** The expiry forces a cut. A chat window will cheerfully agree we are
  "still early" six months into a losing second-order short, because it has no record.

### 2.1 The actual thesis

Every process edge above needs **volume**, and a headline-at-a-time desk fires 10–20 times a year (§13.1).
That is the right machinery bolted to the worst possible feed. Automation is therefore not a nice-to-have
optimisation — it is the edge itself:

> **Automate tedium that has no owner.**

Every lag in §3 exists for the same reason: some tedious work nobody is paid to do stays undone. Nobody
reads port fee schedules. Nobody preps twelve links deep. Nobody reads four thousand appropriation line
items. Nobody tears a supply chain down to depth five. Commodity reasoning applied five hundred times more
often than any human can apply it is a different product, not a bigger one.

**Corollary on coverage:** volume against Reuters is worthless — the second-order implications of a peace
deal are published by financial media within hours. Volume against sources nobody reads is not. The edge
is not reading *more*; it is reading the **unread**.

---

## 3. The four hunting grounds, ranked

Four different lag sources. They do not have equal edge, and they are not variants of one idea.

### 3.1 Money flows — **strongest**

> **Chosen as the first ground. The concrete flow is `docs/design/opportunist-money-flow.md`** —
> sources, the six-stage funnel, schemas and build order. The headline finding there: the
> significance gate (§15 Q2, the hardest open item in this document) is **free** on this ground,
> because every event arrives with a dollar amount and materiality is arithmetic — award value,
> annualised over its period of performance, against the recipient's revenue.

Appropriations, defence contract awards, infrastructure bills, EU budget lines, state programmes. Public,
structured, free APIs. The lag is **administrative, not informational** — money voted today is spent over
three to five years — so it cannot be arbitraged away by someone reading faster. Ignored for the best
possible reason: four thousand line items of tedium with no owner.

Depth rule applies as always. *Congress funds mines* → not the miner (up on the announcement), not the
equipment maker (up a week later) → **the assay labs, the permitting consultants, the one reagent supplier.**

### 3.2 Phenomena / bottlenecks — **highest ceiling, hardest**

Not event-driven at all. A supply-chain teardown asking *what does this industry need that nobody says out
loud?* Depth 1–3 is fully consensus (AI → Nvidia → TSMC → ASML → power). The edge is depth 4–5:
packaging capacity, substrates, crucibles, HV switchgear, transformer lead times, a specific gas.

This mode is structurally different from the other three and gets its own section (§11) — it has no
trigger and cannot use a date-based expiry.

### 3.3 Boring news — **real**

Port authority fee schedules, export quotas, regulatory rules in comment periods, reflaggings, tariff
line-item revisions, utility rate filings. Individually trivial, which is exactly why no analyst covers
them and why a three-link chain has weeks of room. Requires reading the unread, not more of the wire.

### 3.4 Scheduled events — **weakest**

FOMC, OPEC, elections, scheduled decisions. Every real desk preps these; it is table stakes, not edge.
Still worth doing, but for the right reason: **the value is completeness, not speed.** Under time pressure
we find three links; with a month of preparation we find twelve, including the weird ones, with baselines
already computed so the instant it lands we know which of forty names is still untouched.

> **Prepare the map. Build the chain live.** A candidate universe is not a playbook (see §5).

---

## 4. Architecture — a living map, not a news pipeline

The consequence of §3: **three of the four modes are not reactive.** Money flows, bottlenecks and
scheduled events all build a standing map in advance and get triggered later. Only boring news is a live
stream.

So the core asset is not a feed. It is a **living map** — transmission chains, their candidate universes,
and pre-computed baselines. News is merely one of several things that pokes it; an appropriation line pokes
it too, and a bottleneck teardown *builds* it.

This also closes what was the largest hole in the original design — where the chain's tickers come from
(old open question #4, §15). **The teardown mode is the universe builder for the other three.**

The sigma screen (§8) is the one mechanism shared across all four modes. It asks the same question
regardless of what triggered it: *am I late?*

### 4.1 The watchlist inversion

Two directions to run the same machine, and they are not equally expensive:

| | Question | Cost | Precision |
|---|---|---|---|
| **Event mode** | headline → what could this possibly touch? | wide, expensive | low |
| **Watchlist mode** | did anything touch these fifty names? | narrow, cheap | high |

Watchlist mode is the same scanner pointed at a fixed, already-researched list. It is the direct fix for
the failure mode in §14.1 — a tripwire on fifty names we already understand fires rarely and is worth
reading every time.

---

## 5. What it explicitly does NOT do

Each of these was considered and dropped, and mostly for the same reason: they exist to answer
*"will it happen?"*, which is the risk we decided not to take.

- **No scenario trees, no branch probabilities, no Brier/calibration scoring.**
- **No pre-positioning** ahead of an event. Note this is *not* contradicted by §3.4: preparing a candidate
  universe takes no risk before the event. Preparation is not a position.
- **No pre-written chain library.** Chains are built live — a stored chain gets followed lazily.
  §3.4 prepares the **map** (universe + baselines), never the conclusion.
- **No pre-frozen baselines** *as a prerequisite*. An earlier draft claimed the chain had to exist
  beforehand so we would have a pre-event price. That is wrong: daily history is retrievable whenever we
  ask. Pre-computing baselines for a known universe (§3.4) is an optimisation, not a requirement.
- **No order placement.** It surfaces candidates; the user decides. The chains are too model-dependent
  and the already-moved filter too coarse to hand a trigger to.

**What it DOES predict:** not whether the event happens — what it *implies*. That transmission call is
the one forecast in the system, and it is made after the fact.

---

## 6. The event flow

```
trigger (headline · budget line · watchlist tripwire)
  → significance gate ......... is it big enough to travel 2-3 links and still beat noise?
  → build the chain LIVE ...... event → mechanism → 2nd/3rd order instruments
  → sigma screen .............. what has already moved?        ~30 → ~6   (§8)
  → chart read ................ shape, extended vs basing       ~6 → ~2   (§9)
  → output .................... candidate + reason + EXPIRY     (§10)
  → hand off .................. entry/stop/target → Kairos or Mentor
```

Cheap-to-expensive funnel, the same discipline Atlas already applies to sector charts (*"read the 3–5
sectors the book might actually tilt toward, never all eleven"*). Rendering 30 charts per event burns
real tokens to reach a conclusion one line of arithmetic already reached.

**At scale the funnel is the architecture, not an optimisation.** Reasoning is expensive per item;
arithmetic is free per item. A cheap classifier gates the raw feed, the expensive chain runs only on
survivors, the screen ranks them, and a human is involved only at the very end.

### 6.1 v1 needs no event detection — and what that costs

If the user pastes the headline, the user has already decided it matters — so in v1 the significance
gate **is the user**, for free. No news API, no detection, no classifier.

Be honest about the trade: that dodge is what caps v1 at 10–20 firings a year, which is precisely what
makes its track record worthless for years (§13.1). **Automating means building the significance gate
first, not last.** It is the hardest open item and it is on the critical path the moment we want volume.

---

## 7. Source selection is the craft

Stated separately because it is where the differentiation actually lives, and it is a judgment call, not
an engineering one. Obscure sources are free and unscraped precisely because nobody wants them.

> **Pick Reuters and we have built a worse terminal.**

---

## 8. The sigma screen — the already-moved filter

**This filter is the entire product.** Without it the desk is a playbook reader buying yesterday's move.
It is also the one component shared by every mode in §3, and the ranking function that makes automation
tractable at all.

**The question it answers:** has this instrument already moved, relative to what is normal *for it*?

```
ret_N   = log(price_today / price_N_days_ago)
sigma_N = stdev of N-day log returns over the past year
z       = ret_N / sigma_N
```

### 8.1 Beta-adjust it

A market-wide rally makes everything look moved. Measure against the benchmark so the number is the
instrument's *own* move:

```
ret_rel = ret_N(instrument) - beta * ret_N(SPY)
z       = ret_rel / sigma_rel
```

Same relative-return discipline as a tilt row's `active_bp x relative return` — reused, not reinvented.

### 8.2 Three windows, never one

We do not know when the market started pricing the event, and **the announcement date is the wrong
anchor** — rumours leak for weeks, so a single window measured from the headline will call an instrument
"flat" precisely when it has already finished moving. Compute `z` at 5d / 20d / 60d and read the pattern:

| 5d | 20d | 60d | Read |
|---|---|---|---|
| 0.2 | 0.3 | 0.4 | untouched → **candidate** |
| 2.8 | 3.0 | 3.1 | moved on the headline → too late |
| 0.3 | 2.5 | 2.9 | moved on the **rumour** weeks ago → too late, and a single-window screen misses this |
| 0.4 | 0.5 | 2.6 | old unrelated move, since quiet → **candidate**, check why |

**Thresholds** (starting values, tune once there is data): `|z| < 1` untouched · `1–2` partially priced ·
`> 2` gone.

**Data:** ~1 year of DAILY bars per candidate plus the benchmark. Nothing intraday, so the FMP intraday
candle limitation (402 off-plan) does not bite here.

---

## 9. The chart read

Runs only on screen survivors. It answers what a scalar cannot: is `+1.5σ` a clean breakout from a
two-year base (early, more to come), a spike-and-fade (the move already happened and reversed), or noise
inside a range (nothing happened)?

**Its real payoff is not the filter — it is the entry level and the invalidation.** The number can only
say "not yet moved"; the chart says "not yet moved, and here is where to buy it." Which is why the setup
itself then goes to Kairos or Mentor, who already own entry/stop/target. No new machinery.

**Caution, consistent with the line already drawn for Argus:** LLM chart vision is reliable for gross
shape and unreliable for precise levels. **Let it classify; let the numbers measure.**

---

## 10. Output — and why every candidate carries an expiry

Each surfaced candidate is a falsifiable claim:

> *"FRO has not yet repriced this, and will fall relative to its sector within 6 weeks."*

Fields: `instrument · direction · vs (benchmark leg) · mechanism · chain (the written links) ·
z_5d/z_20d/z_60d · surfaced_px · surfaced_bench_px · expires_at · rationale`.

**The expiry is load-bearing, not bookkeeping.** *"The market has not noticed yet"* and *"the market
noticed and disagrees with your chain"* look **identical** on day one and are separable only by time.
Without an expiry the desk will hold losing second-order shorts for six months calling itself early.
If the leg has not moved by its expected lag, **the chain was wrong** — not early.

**This applies to event candidates only.** Bottleneck candidates die a different way — §11.3.

---

## 11. Bottleneck mode — two jobs, not one

The §3.2 objection is real: a bottleneck name can be completely correct and dead money for three years.
The resolution is to split the work.

> **The teardown answers WHO MATTERS. The catalyst hunt answers WHEN.**

And therefore: **never hold it dead.** We hold the *research*; the position starts at the catalyst. The
teardown produces a watchlist, and watchlist mode (§4.1) is what converts it into a trade.

### 11.1 Catalysts worth waiting for

Mechanical and observable, in rough order of strength:

- **A customer's capex announcement.** Someone announces the fab, the datacentre, the plant — the
  bottleneck supplier's revenue is then arithmetic, eighteen months out. Cleanest of the lot.
- **Lead times extending.** Published in some industries; the purest read on a binding constraint.
- **A contract award** — §3.1 pointing directly at §3.2.
- **Capacity leaving.** A competitor exits and the constraint tightens.
- **First analyst coverage.** The thesis eating itself, in a good way: §1.1 says a leg reprices when a
  human revises a model. A company nobody covers is one where **no human has ever built the model at
  all.** Initiation is not a signal that it repriced — it *is* the repricing.

### 11.2 The M&A trap

*"Maybe one is about to merge"* is a **will-it-happen** bet — the exact risk §1 excluded, and one that
needs banker sourcing we cannot buy. Do not ask *will they be acquired*.

Ask instead whether they are **acquirable** — a measurable characteristic, not a forecast:

- sole-source position in something a much larger company depends on
- small float, no controlling family, or a PE holder at the end of its fund life
- trading below replacement cost of the asset
- the customer is vertically integrating everyone else in the chain

None of that predicts a deal. It says the name carries an **extra way to win** we are not paying for.
An option riding along, never the thesis.

### 11.3 Invalidation — pruning, not just triggering

A date-based expiry would cut every good bottleneck idea, so it cannot be used here. The replacement:

> **The constraint got solved.** Substitution, new capacity, a process change that routes around it.

Without an explicit invalidation the watchlist silently fills with names whose reason to exist expired,
and the tripwire eventually fires on a thesis that died two years ago.

---

## 12. Why this is NOT Pythia, and not an extension of her

An earlier draft proposed extending the tilt with a branched regime and a cross-asset `expressions[]`
array. That was designed for the *pre-positioning* version, which §5 dropped. With no scenario tree left,
none of the fit survives:

| Pythia's tilt | This desk |
|---|---|
| standing view, published on a cadence | fires on an event |
| 11 FMP equity sectors, enum-locked | any instrument, any asset class |
| nets to ~0bp (fully invested book) | not a book; no funding constraint |
| benchmark-relative sector stance | instrument-level, per-row `vs` leg |
| consumed by Atlas as an allocation input | consumed by Kairos/Mentor as a trade candidate |

**Its own desk.** What it borrows is *mechanism*, per the shared-mechanism rule: the frozen-baseline +
per-row clock + relative-contribution grading built in `tilt.service.js`, and the existing chart and
monitor scaffolding. Not the schema, and not the judgment.

---

## 13. Track record

A tilt is gradeable because it is published beforehand with a frozen baseline and a deadline. A
candidate here is generated *after* the event — but it is still a prediction (§10), so it grades the same
way: freeze `surfaced_px` / `surfaced_bench_px` at the moment of surfacing, stamp `expires_at`, grade the
relative move at expiry.

**Score two things, not one:**

**(a) Candidates taken.** Did the instrument move in the predicted direction, relative to its benchmark
leg, by the expiry?

**(b) Candidates REJECTED as already-moved.** Did they keep going? This is the false-negative check. It
is nearly free — their `z` is already computed — and it is the only thing that tells us whether the
threshold in §8.2 is set right. If rejected names routinely run another 15%, the screen is too strict and
we are discarding the trades. Almost nobody measures this.

### 13.1 The sample-size problem, and the fix

Firing 10–20 times a year × ~2 candidates = 20–40 observations annually. That is **years** before any
single number is meaningful. Be honest about it rather than reporting a hit rate off nine trades.

**Fix one — aggregate by MECHANISM, not by trade.** Every candidate is tagged with the transmission it
came from (shipping disruption · energy shock · rate expectations · commodity supply · sanctions on/off ·
currency shock · fiscal allocation · capacity constraint). *"My shipping chains work, my credit chains are
noise"* arrives far sooner than any finding about an individual name — and it is the conclusion that
actually changes what the desk does.

**Fix two — get the volume from somewhere else (§14).** The screen calibrates in months if it runs on
everything the house already produces daily, instead of on thirty rows a year.

---

## 14. Build order

Deliberately inverted from how the document reads. The screen ships before the desk.

1. **The sigma screen (§8) as a shared tool, not a desk feature.** *Has this already moved, relative to
   itself and its benchmark?* is a question four existing desks want to ask — Argus (is the score already
   in the price?), Mentor (am I authoring a chase?), Pythia (is this tilt already priced?), Atlas (same,
   at allocation time). Per the shared-mechanism rule it is one service with many callers. Burying it
   inside a desk that fires 15×/year would be exactly the duplication-by-siloing the rule exists to stop.
2. **Wire it into what already fires daily.** Hundreds of observations, so §8.2's thresholds calibrate in
   months rather than years. If `|z| < 1` is the wrong line we learn it from a thousand Argus candidates,
   not from thirty opportunist rows.
3. **Fill the ledger.** The kept record (§2) is the only compounding asset and the only thing a chat
   window structurally cannot have. It is currently instrumented and empty.
4. **The teardown / watchlist (§11)** — builds the universe, and gives the cheap high-precision surface.
5. **The opportunist prompt on top, last.** By then it sits on a tool we already trust. It is not the
   source of the edge, and shipping it first would be building the commodity half.

### 14.1 The failure mode that kills it regardless

**Precision is the product.** If it surfaces twenty items a day it will be ignored inside a week, and then
it is worth zero no matter how good the reasoning was. The bar is roughly **two a week that we are glad we
read.** That is a savage precision requirement and it is a far harder problem than the chain reasoning —
which is why §4.1 (watchlist mode) matters more than it looks.

---

## 15. Open questions

| # | Question | State |
|---|---|---|
| 1 | **Event detection** — the only piece that cannot be done retroactively | v1 sidesteps it (§6.1); no source chosen. On the critical path the moment volume is wanted |
| 2 | **Significance gate** — decides whether it fires 5×/year or 50× | user decides in v1; must be built first to automate (§6.1). Not specified |
| 3 | **Sigma screen** — universe, exact thresholds, beta estimation window | designed (§8), not specified |
| 4 | ~~**Candidate universe**~~ | **answered 2026-08-16**: the teardown mode builds it (§4). Liquidity floor still unspecified |
| 5 | **Source list** — which feeds, and how obscure | the actual craft (§7). Not started |
| 6 | **Cost model** — per-item classifier cost at feed scale | not addressed |
| 7 | **Name** | Tyche is a placeholder |

---

## 16. What is built

**Nothing.** This document is the design record only.
