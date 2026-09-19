# Docs

Four questions, four places. If you are not sure which, start with the root four.

| Question | Read |
|---|---|
| What is this system and how does the work flow through it? | [../README.md](../README.md) |
| What is it *contracted* to do? (statuses, rules, refusals) | [../APP_SPEC.md](../APP_SPEC.md) |
| Where does a given thing live, and what do I touch to add one? | [../CODE_MAP.md](../CODE_MAP.md) |
| How should an agent work in this repo? | [../CLAUDE.md](../CLAUDE.md) |

Prompts are **not** documentation and do not live here — every prompt loaded at runtime is in
[`prompts/`](../prompts), guarded by `tests/unit/promptPaths.test.js`.

---

## `architecture/` — how it is built

The mechanism docs. Read these to change the machinery.

| Doc | Covers |
|---|---|
| [entity-model.md](./architecture/entity-model.md) | The envelope every kind shares; what "adding a kind" costs |
| [building.md](./architecture/building.md) | Chat → armed position: the SSE desks, emit blocks, condition trees, arming |
| [monitoring.md](./architecture/monitoring.md) | Condition trees, the 7 leaf evaluators, intrabar mechanics |
| [broker.md](./architecture/broker.md) | The adapter contract, capability flags, the execution reconciler |
| [off-hours-queue.md](./architecture/off-hours-queue.md) | **Nothing executes off-hours.** The one hours gate; cancel propagation; the market-open drain |
| [single-instance.md](./architecture/single-instance.md) | **The deployment constraint: ONE process.** What a second instance breaks, worst first |
| [paper-trading-simulation.md](./architecture/paper-trading-simulation.md) | The virtual venue: fills, cost model, equity curve |
| [manual-mode.md](./architecture/manual-mode.md) | Real money, no broker: user-confirmed fills, why it is never hours-gated, and the server-side workspace record |
| [ohlcv-price-data.md](./architecture/ohlcv-price-data.md) | The candle pipeline, providers, caching |
| [trades-data.md](./architecture/trades-data.md) | The `trades` ledger — the canonical analytics record |

## `desks/` — what each agent does, and what watches it

A desk and its monitor are one subject: the thing that authors a plan and the thing that decides
when to act on it only make sense together.

| Doc | Desk → monitor |
|---|---|
| [trade-pipeline.md](./desks/trade-pipeline.md) | **The path a new trade takes: Argus → Mentor → Talos.** Read this first — it is the record of why the trading desk is the one it is |
| [mentor-talos.md](./desks/mentor-talos.md) | Mentor builds a `setup`; Talos watches it. Scenarios as rivals, conditions, validity |
| [prometheus-coverage.md](./desks/prometheus-coverage.md) | Prometheus writes a house `coverage` thesis; the coverage monitor keeps it living. **The edge is the gap vs the Street, never price**; two tiers — a free daily check and a gated re-model |
| [pythia-tilt.md](./desks/pythia-tilt.md) | Pythia publishes the house `tilt` — a regime and sector stances as active weight vs a benchmark; the monitor grades each stance by arithmetic. **The tilt is the mandate the house pipeline is steered from**; a re-author is offered, never run |
| [talos-guards.md](./desks/talos-guards.md) | Guards, not zones (built 2026-08-22): exact prices, a crossing carries a meaning, the exit asymmetry. **Partly superseded** by the per-candle build — the sections say which |
| [roles-and-sourcing.md](./desks/roles-and-sourcing.md) | **Trader vs admin, desk by desk** — where each gate lives — and the autonomous sleeve hop: Atlas → Argus → Prometheus → Atlas, researched as the house |

Not yet written up: **Atlas/Themis** (portfolio — contract in APP_SPEC §3) and **Argus** (scan —
APP_SPEC §4). Both have their contract in APP_SPEC and are missing the design reasoning.

**Workspaces and what every desk is told about the venue** are in
[APP_SPEC §8](../APP_SPEC.md#8-workspaces--venue-awareness) — the three books, which kinds are scoped
to one and which are shared across all of them, and why the venue is pushed into every turn rather
than left to a tool.

## `design/` — proposed, not yet the architecture

Open designs, and build records. A doc here describes something that is **not fully built** — when
it ships, it moves to `architecture/` or `desks/`, it is deleted, or it stays as the **record** of
the plan and what the build settled differently (the rule at the bottom of this page).

| Doc | Status |
|---|---|
| [talos-per-candle.md](./design/talos-per-candle.md) | **BUILD RECORD** — shipped 2026-09-17; the contract is mentor-talos.md. The plan, the decisions, what the build settled differently |
| [triggered-setups.md](./design/triggered-setups.md) | Design only — a guard's price term becomes an array over prices and indicators; the level need not exist at authoring time |
| [adopted-book.md](./design/adopted-book.md) | A portfolio that wasn't built here. Phase 1 (intake + write) built 2026-08-10, not live-verified; the rest is design |
| [opportunist-desk.md](./design/opportunist-desk.md) | Design only — a desk that trades the lag after an event, not the headline. Working name Tyche |
| [opportunist-money-flow.md](./design/opportunist-money-flow.md) | Design only — the opportunist's first hunting ground: government money flow, recipient resolution, a sigma screen |
| [architecture-vision.md](./design/architecture-vision.md) | House vs per-user pipeline; the Pythia → Argus → Prometheus → Atlas chain. Revised 2026-09-10 after the channel-graph engine was deleted |
| [investor-schools.md](./design/investor-schools.md) | **BUILT 2026-08-02** (record) — two axes, selection and allocation, on two different seams. Trap: a school that only changes prose is a costume |
| [pipeline-service.md](./design/pipeline-service.md) | **BUILT 2026-08-04** in the frontend (record) — hops between desks as artifacts keyed by kind; each desk declares what it emits and accepts. Written for Kairos; Mentor holds that hop now |

## Open work

| Doc | Covers |
|---|---|
| [trust-gaps-todo.md](./trust-gaps-todo.md) | **The ranked open work.** Capture the thesis→result chain; make the money path testable without a broker |
| [live-verify-checklist.md](./live-verify-checklist.md) | What only a running app can confirm — the queue, by feature |
| [code-review-2026-08-19.md](./code-review-2026-08-19.md) | Structural review of both repos: broker sealing, desk/kind plug-in-ability, duplications, plasters to remove |
| [code-review-2026-09-15.md](./code-review-2026-09-15.md) | Full backend review in 10 sections under one eight-point lens; §1 broker + execution done, findings + what landed per section |

## Not about the system

| Doc | Covers |
|---|---|
| [demo-script-10min.md](./demo-script-10min.md) | Shot-by-shot script + voiceover for the 10-minute investor demo. Describes what is *shown*, not what is built — it dates itself and will go stale |

---

## The rule for this directory

**A doc that describes something that shipped is a record, not a plan — and it must say which.**
The failure mode here is not a missing doc, it is a confident stale one: three separate docs
described the scenario model and the in-position path as "designed, not built" for weeks after
both went live, and a reader had no way to tell without going to the code.

So: when a design ships, either fold it into the doc that describes the built system and delete the
design note, or rewrite the note as a record of what was decided and why. Do not leave a status line
that will quietly become a lie. When two docs cover one subject, merge them — the pair will drift,
and the reader cannot tell which half is current.
