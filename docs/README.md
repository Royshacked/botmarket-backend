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
| [trade-pipeline.md](./desks/trade-pipeline.md) | **The path a new trade takes: Argus → Mentor → Talos.** Read this first — it is why kairos-hermes.md is a record and not a plan |
| [kairos-hermes.md](./desks/kairos-hermes.md) | **SILENT.** Kairos builds a `call`; Hermes watches it. Still accurate, but describes a FROZEN path — calls in flight only |
| [mentor-talos.md](./desks/mentor-talos.md) | Mentor builds a `setup`; Talos watches it. Scenarios as rivals, conditions, validity |

Not yet written up: **Atlas/Themis** (portfolio — contract in APP_SPEC §3), **Argus** (scan —
APP_SPEC §4), **Prometheus** (coverage) and **Pythia** (tilt). Their behaviour is specified in
APP_SPEC; what is missing is the design reasoning behind it.

**Workspaces and what every desk is told about the venue** are in
[APP_SPEC §8](../APP_SPEC.md#8-workspaces--venue-awareness) — the three books, which kinds are scoped
to one and which are shared across all of them, and why the venue is pushed into every turn rather
than left to a tool.

## `design/` — proposed, not yet the architecture

Open designs. A doc here describes something that is **not fully built** — when it ships, it moves
to `architecture/` or `desks/`, or it is deleted.

| Doc | Status |
|---|---|
| [investor-schools.md](./design/investor-schools.md) | Two axes — selection and allocation. Trap: a school that only changes prose is a costume |
| [pipeline-service.md](./design/pipeline-service.md) | Hops between desks as data. Mostly frontend-owned |

## Open work

| Doc | Covers |
|---|---|
| [trust-gaps-todo.md](./trust-gaps-todo.md) | **The ranked open work.** Capture the thesis→result chain; make the money path testable without a broker |
| [live-verify-checklist.md](./live-verify-checklist.md) | What only a running app can confirm — the queue, by feature |

---

## The rule for this directory

**A doc that describes something that shipped is a record, not a plan — and it must say which.**
The failure mode here is not a missing doc, it is a confident stale one: three separate docs
described the scenario model and the Kairos in-position path as "designed, not built" for weeks
after both went live, and a reader had no way to tell without going to the code.

So: when a design ships, either fold it into the doc that describes the built system and delete the
design note, or rewrite the note as a record of what was decided and why. Do not leave a status line
that will quietly become a lie. When two docs cover one subject, merge them — the pair will drift,
and the reader cannot tell which half is current.
