# Channel-Graph Forecasting Engine — Build Spec

Hand this to Claude Code as project context. Read fully before writing code.

---

## 1. Mental model (do not deviate from this)

The world is **not** a stream of events. It is a coupled dynamical system of
~15–25 measurable *channels* that transmit pressure to each other with lags.

```
state_{t+1} = decay ⊙ state_t + Σ_lag K_lag · state_{t-lag} + shock_t
```

- `state` — vector of current pressure per channel
- `K` — coupling matrix; `K[a][b]` = transmission from channel a into channel b
- `shock` — an event, injected into the system; NOT a first-class object
- Company forecasts = `channel_state × exposure_matrix − priced_in`

**"Chains" are not objects.** They are paths read off `K` after propagation,
used for explanation only. Never propagate a chain in isolation — that
double-counts shared channels. One matrix operation, always, even when only
four channels are wired.

### Where the edge is

| Layer | Edge | Why |
|---|---|---|
| Ingest / NLP | **None** | Commodity. Everyone has it. |
| Channel state | **None** | Proxies are market prices. Already priced. |
| Coupling `K` transit time | Some | Knowing pressure in `a` arrives in `d` in 3 weeks |
| **Exposure matrix** | **Most** | Slow, filings-based, compounds, cannot be bought |
| Calibration loop | Structural | Prevents narrative drift; most strategies die here |

Edge lives where a chain crosses from a channel into a **company-specific
exposure**. Everything upstream of that is in the price.

---

## 2. Anti-goals — do NOT build these

1. **A news scraper as phase one.** Ingest is plumbing. It comes after the
   exposure matrix, not before.
2. **Custom NLP models.** Use an off-the-shelf LLM for extraction. Do not
   fine-tune anything in v1.
3. **A dense coupling graph.** Target 3–5 outgoing edges per channel. A fully
   connected `K` explains everything and predicts nothing.
4. **Chain-walking / graph-traversal propagation.** See §1.
5. **Sentiment scores.** If an item fails the event test, it is discarded, not
   downweighted into a sentiment number.
6. **Backtests of the LLM layer on pre-cutoff events.** The model knows how
   COVID and SVB ended. Any such backtest is contaminated and will look
   brilliant. Validation is forward-only.
7. **Latency optimisation.** Target horizon is days-to-weeks. Do not compete
   on speed.

---

## 3. Phases

Phases 0–2 require **no news data at all** and are fully testable in
isolation. Do them first.

---

### Phase 0 — Channel taxonomy & proxy series

**Objective:** define the state space.

**Hard rule:** every channel must have an *observable proxy* independent of
the model. No proxy → drop the channel or merge it. "Geopolitical tension" is
not a channel; it is a shock hitting energy cost, freight, and risk premium.

Starting set (15–25 total):

| Channel | Proxy | Clock |
|---|---|---|
| energy cost | crude, TTF, regional power | fast |
| freight / logistics | container rates, Baltic, port dwell | medium |
| policy rate expectations | OIS strip, front forwards | fast |
| discount rate | real yields, term premium | fast |
| credit / capital access | HY & IG spreads, issuance volume | medium |
| FX | trade-weighted baskets | fast |
| risk premium | vol surface, skew, cross-asset corr | fast |
| end demand | PMI, real retail, card data | slow |
| input scarcity | inventories, backwardation, lead times | medium |
| labor cost | wage trackers, claims, JOLTS | slow |

Tag each channel with its clock — **fast (hours), medium (weeks), slow
(quarters)**. Mixed clocks on one timestep make fast channels appear to cause
everything.

**Deliverables**
- `channels.yaml` — id, description, proxy series, clock, unit, sign convention
- Ingested proxy history, 15–20y, point-in-time where available
- Normalisation layer (z-score vs trailing regime, not vs full history)

**Tools:** time-series store (TimescaleDB / DuckDB / Parquet + Polars);
market data (verify current vendor terms — Refinitiv, Bloomberg, FRED,
Quandl-style APIs, freight indices often need direct licensing).

**Gate:** every channel has ≥10y of clean daily/weekly proxy data with
documented gaps. No channel without a proxy survives this phase.

---

### Phase 1 — Estimate the coupling matrix `K`

**Objective:** learn transmission structure from proxy time series only.
Never from event narratives.

**Method**
1. Lagged VAR / local projections / transfer entropy across proxy pairs
2. Prune hard. Keep an edge only if it is:
   - statistically present out-of-sample
   - backed by a **nameable mechanism** (one falsifiable sentence)
   - stable across sub-samples
3. Store per edge: `weight, lag_distribution, sign, regime_conditionality,
   mechanism_text, status (validated|provisional), last_reestimated`
4. **Estimate `K` separately per regime.** Oil↑ → equities↓ under supply
   shock; oil↑ → equities↑ under demand recovery. One unconditional `K`
   averages to mush and is wrong in both regimes.
5. Regime conditioners: inventory levels, spare capacity, positioning, vol
   regime. Define 2–4 discrete regimes; do not attempt continuous
   conditioning in v1.

**Deliverables**
- `K` as sparse tensor `[channel × channel × lag × regime]`
- Mechanism registry — one sentence per edge, human-written
- Saturation functions on hub channels (freight, energy, risk premium,
  credit): convex near capacity constraints, concave where substitution
  exists. Linear propagation on hubs will overshoot.

**Tools:** `statsmodels` (VAR/VECM), `numpy`/`scipy`, `pyarrow`;
optionally `linearmodels` for local projections.

**Gate — all must pass**
- `ρ(K) < 1` per regime (spectral radius). If ≥1 the system explodes on any
  shock. This is a hard stop.
- Sparsity ≤ 5 outgoing edges/channel average
- Every edge has mechanism text
- Impulse-response functions reviewed by a human and judged sane

---

### Phase 2 — Propagation engine

**Objective:** one matrix operation propagating the full state.

**Requirements**
- Single `propagate(state, shocks, regime) → state'` — no per-chain code paths
- Per-channel decay half-lives (freight: weeks; regulatory: quarters)
- Cycles must run freely. Chain 2's demand→policy feedback only exists if the
  full state propagates. Truncating loops is a correctness bug.
- **Attribution decomposition**: after propagation, decompose which shocks
  contributed how much to each channel. This produces the human-readable
  "chain" — an output artifact, never the computation.

**Deliverables**
- `propagate()` + `attribute()`
- Replay harness: inject a historical shock, compare simulated channel
  trajectory to realised proxies

**Tools:** `numpy`, `polars`; state snapshots to Parquet for replay.

**Gate:** replay of 3 historical shocks produces channel trajectories directionally
correct at the right lags. Shared-channel double-counting test passes (two
shocks hitting freight yield one freight value, not two).

---

### Phase 3 — Exposure matrix ⭐ THE ASSET

**Objective:** map channel state → company impact. This is the slow,
unglamorous, compounding work. It is the edge. Budget accordingly.

**Schema per (entity, channel)**
```
elasticity            impact per unit channel pressure
lag_profile           not a point estimate — a distribution
hedge_coverage        % and tenor
contract_structure    spot vs contracted, repricing lag
pass_through          pricing power → can they push cost to customers
inventory_weeks       buffer before physical shock bites
maturity_wall         for credit channel: fixed vs floating, refi dates
confidence            0–1, updated by resolved forecasts
source_ref            filing + page, for audit
```

Plus `supply_graph`: entity → entity edges, weight, substitutability.
Propagation to neighbours: **2 hops max, damping ≈ 0.4**. Beyond that it is noise.

**Build order:** one sector first, end to end, ~50–100 names. Do not go wide
before the loop is proven.

**Extraction:** LLM over filings (10-K/10-Q, annual reports, transcripts) with
mandatory source citation per field. Human review queue for low-confidence
extractions. Refresh quarterly on filing cadence.

**Tools:** filings access (EDGAR full-text + equivalent non-US registers);
LLM API for extraction; Postgres for the matrix; a review UI (keep it crude).

**Gate:** one sector fully populated, ≥80% of fields source-cited, spot-check
of 20 entities by a human shows acceptable accuracy.

---

### Phase 4 — Ingest, situation resolution, surprise

**Objective:** turn observations into shocks. Plumbing — do not gold-plate.

**Three levels — do not collapse them**
```
OBSERVATION  raw item (article, filing, print, tick, AIS ping)
EVENT        dated, verifiable change shifting ≥1 channel
SITUATION    persistent arc emitting events, carrying state
```

**Event test** — applied at extraction; failures are *discarded*:
1. Maps to ≥1 channel in the taxonomy
2. Has magnitude, or surprise measurable against a stored prior expectation
3. Is dated and falsifiable

Commentary and "analyst sees risk to X" fail (3). They are not events.

**Situation identity:** fingerprint on `causal_root + entity_set + channel_set`.
Implement `merge` (arcs converge) and `split` (arc spawns independent one).
Errors here either double-count pressure or lose the decay clock.

**Surprise requires stored expectation.** Every situation carries the prior
expectation. Backfill consensus/forwards/implieds so surprise is computable
from day one. Without this a CPI print is a number, not a shock.

**Sources — four, two clocks**
- **PULL** (scheduled, known-date/unknown-outcome): CPI, FOMC, earnings, OPEC,
  elections, court dates, regulatory deadlines. Pre-register the situation
  *before* the date. Shock = outcome − consensus.
- **PUSH**: wires, filings, central bank comms
- **MARKET-DERIVED** (underrated): unusual vol, curve shifts, freight rates,
  spread moves. The market often knows before the wire. Treat as observations.
- **PHYSICAL/ALT** (polled): AIS shipping, port congestion, satellite, power
  output, inventory reports

**Fifth mechanism — active situations subscribe to their own queries.** Each
live arc registers watch terms and polls harder than the general feed.
Escalating arcs get more attention budget; dormant ones get periodic
resolution checks. This is what makes the system compounding rather than
reactive.

**Pipeline**
```
observation → entity resolution → dedup/cluster → event test
  → situation match|merge|split → surprise vs expectation
  → channel contribution → state
```

**Tools:** news API (verify current terms); LLM API for extraction; entity
resolution against a security master (permID/FIGI/LEI); Redis or similar for
dedup windows; a queue.

**Gate:** ≥90% dedup accuracy on a labelled week; situation identity stable
across a 3-month replay (no arc fragmentation, no spurious merges).

---

### Phase 5 — Priced-in baseline & attribution

**Objective:** the step that decides whether a trade exists.

Decompose an observed move against the **concurrent channel state**, not a
single-event window. Twelve things are always live; attributing a 6% move to
your channel when three others were also firing is the core failure mode.

Output: `priced[entity]` + `attribution_confidence`. Low confidence must
**shrink the position**, not be ignored.

**Tools:** factor model (Barra-style or home-rolled), options surface data
for implied moves, revision-breadth data.

**Gate:** on historical windows, attribution recovers known single-driver
moves with acceptable error.

---

### Phase 6 — Forecast objects & calibration loop

**Objective:** falsifiability. Build this before trading anything.

```
Forecast {
  entity, horizon, direction, magnitude, probability,
  channels_responsible[], attribution_confidence,
  invalidation_condition, resolution_date, created_at
}
residual = impact − priced
```

Emit only when residual **and** attribution_confidence clear thresholds.

**Scoring:** Brier, sliced by `channel × event_type × regime`. Score the
**counterfactual separately** — distinguish "we were right about the exposure"
from "the sector carried us." Resolved forecasts update elasticity confidence
in Phase 3 and edge weights in Phase 1.

**Tools:** Postgres, a scheduler (Prefect/Dagster/cron), a dashboard.

**Gate:** **8–12 weeks forecast-only, zero capital.** Brier scores logged by
slice. Deploy only on channels where calibration is demonstrably decent; keep
the rest logging.

---

### Phase 7 — Interference & portfolio

**Interference classification across the forecast set:**
- **compounding** — same channel, same sign → superlinear near capacity
- **offsetting** — opposite channels, same name → small net, high vol →
  express in options, not equity
- **masking** — a loud event suppresses repricing of a quiet one → **this is
  the primary durable edge**; it exists because you have no attention
  bottleneck and human desks do
- **conditioning** — event A changes B's elasticity (regime state)
- **sequencing** — nth occurrence has decaying surprise, sometimes rising
  structural impact

**Portfolio:** correlate on **channel decomposition, not returns**. Thirty
names all long one freight channel is one bet wearing a diversification
costume. Cap gross exposure per channel.

**Monte Carlo over joint channel states belongs here** — its job is the loss
surface and correlation structure, not signal generation.

**Capacity constraint to plan around:** the mispricing at the far end of a
chain lives in mid-caps and thin-coverage second-order names. Sharpe may be
decent; dollar capacity will not be. Size the whole business accordingly.

---

### Phase 8 — Edge discovery governance

Three distinct things get called "a new chain":

| | Cost |
|---|---|
| **New path** — existing edges, novel entry point | Free. Falls out of propagation. Touch nothing. |
| **New edge** — `K[a][b]` that wasn't there | Expensive, dangerous, occasionally the real money |
| **New channel** — pressure with no home | Rare. ~twice a decade. |

**A real new edge comes from a structural change:** dependency crosses a
concentration threshold; a physical good gets financialised and starts
propagating at price speed; regulation creates a path by construction; a new
chokepoint forms or an old one is bypassed. You can name the mechanism in one
sentence, or you have a correlation, not an edge.

**Admission process**
1. Mechanism required first, as a falsifiable sentence. No mechanism → no edge.
2. Out-of-sample check on the proxy pair in a period you did not mine
3. Enters `K` flagged `provisional`, weight discounted, propagation damped
4. Forecast-only for one quarter, scored separately
5. Promote or delete. **Deletion is the default and should feel routine.**

**Budget: 2–4 new edges per year, competing.** With 20 channels there are
~400 candidate pairs; mine 15 years at multiple lags and you will find dozens
of beautiful spurious couplings. The residual monitor always has a suggestion.
An artificial ceiling beats a significance threshold you will rationalise past.

**Edges die quietly and that is worse.** Dead edges generate confident wrong
forecasts. Re-estimate on a schedule; demote anything absent from recent data
even if the mechanism story still sounds right. The story outlives the
mechanism by a year or two.

---

## 4. System integration — how the engine connects to the desks

The engine is **house-layer**: it runs on a schedule, writes to DB, and all
desks read the same shared state. It never runs per-user. Per-user scope begins
only at the desk that consumes the output.

---

### 4.1 What each desk receives

**Pythia (macro/sector layer)**
- Inputs: channel pressure scores by sector, current regime signals, what moved
  and why
- Role shift: Pythia validates the engine's regime label with judgment — does
  coverage support this? Is it already priced? What kills it? She is not the
  computation; she is the house's decision to be graded against it.
- She can say NO. If the coverage book is thin or the move is priced, she
  publishes neutral and states why.
- Phases 1 and 2 of tilt authoring (backdrop + regime) become much faster — the
  engine supplies structured inputs instead of reasoning from raw data.

**Prometheus (company/thesis layer)**
- Inputs: which channels hit a specific name, elasticity estimate, lag profile
  distribution, 2nd/3rd order supply-graph connections
- Adds what the engine cannot: management quality, moat, price target, rating,
  catalysts, qualitative risks
- Engine surfaces uncovered 2nd/3rd order names → Prometheus research demand
  grows → house coverage list expands

**Atlas (position layer) — two distinct paths**

*Path A — conviction trade (direct):* engine surfaces a specific name with a
long-lag signal → Atlas builds a conviction position on that name. Engine
hands Atlas the exposure score, lag profile, channel attribution; Prometheus
coverage provides the qualitative layer.

*Path B — mandate / portfolio build (indirect):* engine's sector-level channel
pressure feeds Pythia → Pythia validates and publishes a sector tilt → Argus
scans convicted sectors → Prometheus covers names → Atlas allocates from the
covered pool. Engine does not feed Atlas directly in this flow.

The mandate pre-filter is Pythia's convicted sectors. Atlas never scans all
covered names — only names inside convicted sectors. An engine-surfaced name
reaches the mandate pool naturally if it is covered and its sector is convicted.

**Coverage in Atlas's pool has two origins — both are valid:**

| Origin | Aether signal? | Fields present |
|---|---|---|
| Engine surfaced the name → Prometheus covered it | Yes | Thesis + PT + exposure score + lag profile + channel attribution |
| Direct research (user request, Argus scan, Pythia-convicted sector) | No | Thesis + PT + qualitative conviction only |

The Aether exposure score is optional enrichment, not a required field. When
present it is weighted; when absent Atlas falls back to qualitative conviction
alone. Atlas should be transparent about which backing a name has
(`thesis only` vs `thesis + quantitative channel exposure`).

Allocation weight draws from both sources:
```
allocation_weight = f(
  coverage_conviction,      // always present
  PT_upside,                // always present
  aether_exposure_score,    // present if engine surfaced the name
  aether_lag_confidence,    // present if engine surfaced the name
  channel_correlation       // cap gross exposure per channel across the portfolio
)
```

**Mentor (setup layer)**
- Inputs: short-lag signals (days–weeks) where repricing has not yet occurred
- Routing rule: short lag + repricing gap → Mentor constructs entry/stop/target
- Example: "Hormuz opened — 2nd order airline supplier hasn't moved yet" →
  engine hands Mentor the exposure score, lag, confidence; Mentor builds the
  trade
- This is the fastest path in the pipeline: no discovery step, no research
  queue, pre-computed answer waiting
- Prometheus coverage is **not on the critical path** for Mentor. The name goes
  into the Prometheus queue asynchronously — coverage is built behind the trade,
  not before it. There is no time to wait on a days-to-weeks horizon.

---

### 4.2 Lag determines the desk — always

The same event, at different hops, routes to different desks. The exposure
matrix's `lag_profile` makes this deterministic:

| Signal | Lag | Desk | Nature |
|---|---|---|---|
| 1st/2nd order repricing gap | days–weeks | Mentor | Setup — trade before gap closes |
| Structural channel shift | months–quarters | Atlas | Position — own the exposure |
| Regime change | quarters | Pythia → Atlas | Tilt — rebalance the book |

The Hormuz 1st-order airline trade is Mentor. The 3rd-order regional bank play
is Atlas. This is not a judgment call at routing time — it is read off the
`lag_profile` field in Phase 3.

---

### 4.3 The flywheel

```
engine surfaces uncovered 2nd/3rd order name
  → Argus screens it
  → Prometheus covers it → DB grows
  → Pythia cross-check improves
  → better tilt → better Argus filter
  → more targeted Prometheus queue
  → engine's elasticity confidence updated by resolved forecasts (Phase 6)
  → edge weights in K updated (Phase 1)
  → loop
```

The DB is the primary cost-reduction mechanism. A richer shared state means
less per-user computation at every desk. Coverage researched once is read by
Pythia, Atlas, Mentor, and the coverage monitor indefinitely.

---

### 4.4 What stays per-user

Mentor setups, Atlas sizing and allocation decisions, Argus personal scans, all
conversations. Everything else is house-layer and shared.

---

## 5. Cold start

Do not begin with an empty channel state. Decay from zero makes month one
read as a fresh shock everywhere and every position wrong in the same
direction.

1. `channels.yaml` first — it is the schema everything writes into
2. Backfill 12–24 months of situations **point-in-time** to reach present-day
   state through decay
3. Backfill expectation baselines so surprise is computable at t=0
4. Exposure matrix for one sector
5. Forecast-only, 8–12 weeks
6. Deploy narrowly

**Contamination warning on step 2:** the extraction model knows how every
historical situation ended. Backfill establishes *current state* only. It is
not strategy validation. Validation is forward, always.

---

## 6. Suggested repo layout

```
channels/        taxonomy, proxy ingest, normalisation
coupling/        K estimation, regime detection, mechanism registry
propagate/       state engine, attribution, replay harness
exposure/        filings extraction, matrix, supply graph, review queue
ingest/          sources, event test, situation resolution, surprise
pricing/         priced-in decomposition, attribution confidence
forecast/        forecast objects, resolution, Brier scoring
portfolio/       interference, channel-correlation, sizing, Monte Carlo
governance/      edge candidates, admission workflow, decay audit
```

**Build order:** `channels → coupling → propagate → exposure → ingest →
pricing → forecast → portfolio → governance`.

Note that `exposure` precedes `ingest`. This is deliberate and inverts the
usual instinct.

---

## 7. Notes for the implementing agent

- Verify current terms, coverage, and pricing for any data vendor named here
  before committing to it. Vendor landscape moves.
- Prefer boring, inspectable implementations over clever ones. Every number in
  a forecast must be traceable to a source field or a `K` edge.
- When tempted to add a channel, an edge, or a source: check §2 first.
- Fail loudly on `ρ(K) ≥ 1`, on missing proxies, and on uncited exposure fields.
