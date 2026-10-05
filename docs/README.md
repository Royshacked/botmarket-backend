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
| [virtual-venue.md](./architecture/virtual-venue.md) | **Paper and manual on one venue.** An adapter, not a parallel engine; one store keyed by mode, N accounts per user; paper fills against the live feed, manual is filled by the user's two confirmations; the workspace record |
| [ohlcv-price-data.md](./architecture/ohlcv-price-data.md) | The candle pipeline, providers, caching |
| [trades-data.md](./architecture/trades-data.md) | The `trades` ledger — the canonical analytics record |
| [notifications.md](./architecture/notifications.md) | **Every alert is a card in social chat; web push is that card delivered to the devices.** The one `_deliver` step, presence decided on the device, the PWA worker and what it will never cache |

## `desks/` — what each agent does, and what watches it

A desk and its monitor are one subject: the thing that authors a plan and the thing that decides
when to act on it only make sense together.

| Doc | Desk → monitor |
|---|---|
| [trade-pipeline.md](./desks/trade-pipeline.md) | **The path a new trade takes: Argus → Mentor → Talos.** Read this first — it is the record of why the trading desk is the one it is |
| [mentor-talos.md](./desks/mentor-talos.md) | Mentor builds a `setup`; Talos watches it. Scenarios as rivals, conditions, validity (both edges authored), guards (exact prices, the free sweep, the exit asymmetry), and **the paths not taken** — the closed authoring taxonomy, the rejects pool and the blinded flip test (2026-09-26). The guards doc was merged here 2026-09-19 |
| [argus-scans.md](./desks/argus-scans.md) | Argus turns a question about a period into a ranked, grounded list — one spine, three targets (a trading list, an investing shortlist for Prometheus, one pick for Mentor). **Names come from the tape, and the code enforces it**; the server scores and ranks |
| [atlas-themis.md](./desks/atlas-themis.md) | Atlas builds a book against a mandate from house coverage only, reviews it as a delta against its thesis, proposes Accept-gated changes; Themis is the LLM-free doorbell that says when to look |
| [prometheus-coverage.md](./desks/prometheus-coverage.md) | Prometheus writes a house `coverage` thesis; the coverage monitor keeps it living. **The edge is the gap vs the Street, never price**; two tiers — a free daily check and a gated re-model |
| [pythia-industries.md](./desks/pythia-industries.md) | Pythia + the industry-view monitor — the `industry_view` artifact. Pythia answers three structural questions (demand, economics, cycle) per GICS sub-industry from the engine's measured numbers; the monitor seeds, triggers and schedules reviews. Descriptions, never forecasts — the tilt was deleted 2026-10-05 |
| [roles-and-sourcing.md](./desks/roles-and-sourcing.md) | **Trader vs admin, desk by desk** — where each gate lives — and the autonomous sleeve hop: Atlas → Argus → Prometheus → Atlas, researched as the house |

Every desk and its monitor is written up above. Axl (reception) is described by its hand-off
rules in APP_SPEC §2 and §4; a desk doc for it waits until the desks it routes into are settled.

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
| [mentor-challenge.md](./design/mentor-challenge.md) | **BUILD RECORD — phases 0–4 shipped 2026-09-26**; the contract is mentor-talos.md §The paths not taken. The three mechanisms (closed taxonomy + rejects pool, blinded flip test, runaway handoff), the 10 principles, and the two options rejected with the argument that killed them |
| [talos-per-candle.md](./design/talos-per-candle.md) | **BUILD RECORD** — shipped 2026-09-17; the contract is mentor-talos.md. The plan, the decisions, what the build settled differently |
| [triggered-setups.md](./design/triggered-setups.md) | Design only — a guard's price term becomes an array over prices and indicators; the level need not exist at authoring time |
| [adopted-book.md](./design/adopted-book.md) | A portfolio that wasn't built here. Phase 1 (intake + write) built 2026-08-10, not live-verified; the rest is design |
| [opportunist-desk.md](./design/opportunist-desk.md) | Design only — a desk that trades the lag after an event, not the headline. Working name Tyche |
| [opportunist-money-flow.md](./design/opportunist-money-flow.md) | Design only — the opportunist's first hunting ground: government money flow, recipient resolution, a sigma screen |
| [pythia-industry-questions.md](./design/pythia-industry-questions.md) | **BUILT 2026-10-05** — Pythia rebuilt: three structural questions per GICS sub-industry from measured data; the tilt and channel desk deleted. Why, the decisions, the build order. The contract is desks/pythia-industries.md |
| [horizons.md](./design/horizons.md) | Design, built in order — what can honestly be known at every horizon from 1 month to 20 years, on sourced evidence; the signal lab; the Forecasts board's future range view; events PARKED |
| [architecture-vision.md](./design/architecture-vision.md) | House vs per-user pipeline; the Pythia → Argus → Prometheus → Atlas chain. Revised 2026-09-10 after the channel-graph engine was deleted; its tilt-led chain is stale since 2026-10-05 (Pythia publishes industry views, the house scan is paused) |
| [investor-schools.md](./design/investor-schools.md) | **BUILT 2026-08-02** (record) — two axes, selection and allocation, on two different seams. Trap: a school that only changes prose is a costume |
| [pipeline-service.md](./design/pipeline-service.md) | **BUILT 2026-08-04** in the frontend (record) — hops between desks as artifacts keyed by kind; each desk declares what it emits and accepts. Written for Kairos; Mentor holds that hop now. The mechanism doc is `botmarket-frontend/docs/hand-offs.md` |

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

## Naming something that no longer exists

A long-lived doc is mostly history: the paragraph that explains why a mechanism was replaced has to
name the thing that was replaced. **Strike it through** — ~~`zoneGate`~~ — and `npm run check:docs`
skips it, so a sentence doing its job stops being reported as drift. The name keeps its code font
and now says "dead" on sight; what is left in the drift report is prose that means to be true.

Two notes. Inside a fenced block (CODE_MAP's tree) strikethrough does not render, so a retired path
drops its extension instead — `was portfolio.monitor` — which the scanner reads as prose. And a
name that was *proposed and never built* is not retired: put it in quotes, not backticks, because
there is nothing to strike.

## What `npm run check:docs` reports, and what it does not

The scan splits on the line this directory already draws. **Living docs — the root four,
`architecture/` and `desks/` — are the contract, and every name in them has to resolve.**
`design/` is a moment: a plan names what is not built yet, a record keeps the names its build
shipped under, and neither is drifting when it does. Records get their own table and their own
total; their findings print with `--records`, or whenever you ask for one by name.

So a living doc at anything but zero is a sentence to go read. That is the whole signal, and it
only works if the count means something — which is why the two conventions above exist.
