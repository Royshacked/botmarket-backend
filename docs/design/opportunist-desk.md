# The opportunist — trading the lag, not the news

**Status: DESIGN ONLY, nothing built. Settled 2026-08-13.** A desk that reacts to an event and finds
the second/third-order instrument that has not repriced yet. Working name **Tyche** (fortune) — Kairos,
which literally means *the opportune moment*, is unfortunately already the call desk. Name not decided.

Relates to: `prompts/strategy_system_prompt.md` (Pythia — and §7 on why this is NOT her),
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

## 2. What it explicitly does NOT do

Each of these was considered and dropped, and all for the same reason: they exist to answer
*"will it happen?"*, which is the risk we decided not to take.

- **No scenario trees, no branch probabilities, no Brier/calibration scoring.**
- **No pre-positioning** ahead of an event.
- **No pre-written chain library.** Chains are built live. Optional later as a checklist so the model
  does not miss a channel — a quality aid, never a prerequisite.
- **No pre-frozen baselines.** An earlier draft claimed the chain had to exist beforehand so we would
  have a pre-event price. That is wrong: daily history is retrievable whenever we ask. Dropped.
- **No order placement.** It surfaces candidates; the user decides. The chains are too model-dependent
  and the already-moved filter too coarse to hand a trigger to.

**What it DOES predict:** not whether the event happens — what it *implies*. That transmission call is
the one forecast in the system, and it is made after the fact.

---

## 3. The flow

```
headline (user-fed in v1)
  → significance gate ......... is it big enough to travel 2-3 links and still beat noise?
  → build the chain LIVE ...... event → mechanism → 2nd/3rd order instruments
  → sigma screen .............. what has already moved?        ~30 → ~6   (§4)
  → chart read ................ shape, extended vs basing       ~6 → ~2   (§5)
  → output .................... candidate + reason + EXPIRY     (§6)
  → hand off .................. entry/stop/target → Kairos or Mentor
```

Cheap-to-expensive funnel, the same discipline Atlas already applies to sector charts (*"read the 3–5
sectors the book might actually tilt toward, never all eleven"*). Rendering 30 charts per event burns
real tokens to reach a conclusion one line of arithmetic already reached.

### 3.1 v1 needs no event detection

If the user pastes the headline, the user has already decided it matters — so in v1 the significance
gate **is the user**, for free. No news API, no detection, no classifier. That removes the hardest open
item from the critical path; automate it only once the chains prove to be worth anything.

---

## 4. The sigma screen — the already-moved filter

**This filter is the entire product.** Without it the desk is a playbook reader buying yesterday's move.

**The question it answers:** has this instrument already moved, relative to what is normal *for it*?

```
ret_N   = log(price_today / price_N_days_ago)
sigma_N = stdev of N-day log returns over the past year
z       = ret_N / sigma_N
```

### 4.1 Beta-adjust it

A market-wide rally makes everything look moved. Measure against the benchmark so the number is the
instrument's *own* move:

```
ret_rel = ret_N(instrument) - beta * ret_N(SPY)
z       = ret_rel / sigma_rel
```

Same relative-return discipline as a tilt row's `active_bp x relative return` — reused, not reinvented.

### 4.2 Three windows, never one

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

## 5. The chart read

Runs only on screen survivors. It answers what a scalar cannot: is `+1.5σ` a clean breakout from a
two-year base (early, more to come), a spike-and-fade (the move already happened and reversed), or noise
inside a range (nothing happened)?

**Its real payoff is not the filter — it is the entry level and the invalidation.** The number can only
say "not yet moved"; the chart says "not yet moved, and here is where to buy it." Which is why the setup
itself then goes to Kairos or Mentor, who already own entry/stop/target. No new machinery.

**Caution, consistent with the line already drawn for Argus:** LLM chart vision is reliable for gross
shape and unreliable for precise levels. **Let it classify; let the numbers measure.**

---

## 6. Output — and why every candidate carries an expiry

Each surfaced candidate is a falsifiable claim:

> *"FRO has not yet repriced this, and will fall relative to its sector within 6 weeks."*

Fields: `instrument · direction · vs (benchmark leg) · mechanism · chain (the written links) ·
z_5d/z_20d/z_60d · surfaced_px · surfaced_bench_px · expires_at · rationale`.

**The expiry is load-bearing, not bookkeeping.** *"The market has not noticed yet"* and *"the market
noticed and disagrees with your chain"* look **identical** on day one and are separable only by time.
Without an expiry the desk will hold losing second-order shorts for six months calling itself early.
If the leg has not moved by its expected lag, **the chain was wrong** — not early.

---

## 7. Why this is NOT Pythia, and not an extension of her

An earlier draft proposed extending the tilt with a branched regime and a cross-asset `expressions[]`
array. That was designed for the *pre-positioning* version, which §2 dropped. With no scenario tree left,
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

## 8. Track record

A tilt is gradeable because it is published beforehand with a frozen baseline and a deadline. A
candidate here is generated *after* the event — but it is still a prediction (§6), so it grades the same
way: freeze `surfaced_px` / `surfaced_bench_px` at the moment of surfacing, stamp `expires_at`, grade the
relative move at expiry.

**Score two things, not one:**

**(a) Candidates taken.** Did the instrument move in the predicted direction, relative to its benchmark
leg, by the expiry?

**(b) Candidates REJECTED as already-moved.** Did they keep going? This is the false-negative check. It
is nearly free — their `z` is already computed — and it is the only thing that tells us whether the
threshold in §4.2 is set right. If rejected names routinely run another 15%, the screen is too strict and
we are discarding the trades. Almost nobody measures this.

### 8.1 The sample-size problem, and the fix

Firing 10–20 times a year × ~2 candidates = 20–40 observations annually. That is **years** before any
single number is meaningful. Be honest about it rather than reporting a hit rate off nine trades.

**The fix: aggregate by MECHANISM, not by trade.** Every candidate is tagged with the transmission it
came from (shipping disruption · energy shock · rate expectations · commodity supply · sanctions on/off ·
currency shock). *"My shipping chains work, my credit chains are noise"* arrives far sooner than any
finding about an individual name — and it is the conclusion that actually changes what the desk does.

---

## 9. Open questions

| # | Question | State |
|---|---|---|
| 1 | **Event detection** — the only piece that cannot be done retroactively | v1 sidesteps it (§3.1); no source chosen for v2 |
| 2 | **Significance gate** — decides whether it fires 5×/year or 50× | user decides, LLM suggests a score. Not specified |
| 3 | **Sigma screen** — universe, exact thresholds, beta estimation window | designed (§4), not specified |
| 4 | **Candidate universe** — where the chain's tickers come from, and their liquidity floor | not addressed |
| 5 | **Name** | Tyche is a placeholder |

---

## 10. What is built

**Nothing.** This document is the design record only.
