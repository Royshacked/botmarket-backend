# botmarket-backend

AI-powered trading assistant backend — Express + MongoDB + LLM agents (Anthropic / OpenAI).

**Six conversational desks** turn natural-language chat into monitored work, then route confirmed
entries and exits to a real broker (cTrader), a paper venue, or IBKR (data-only for now) through one
unified adapter layer. Each desk owns a kind; each kind is watched by its own monitor.

| Desk | Route | Produces | Watched by |
|---|---|---|---|
| **Axl** — reception / concierge / critic | `/api/axl` | nothing (read-only); hands over to a desk | — |
| **Mentor** — the trading desk | `/api/mentor`, `/api/setups` | `setup` | Talos |
| **Atlas** — portfolio construction + review | `/api/portfolio` | `portfolio_item` holdings | Themis |
| **Argus** — the systematic scanner | `/api/scanner` | `scan` | — |
| **Prometheus** — buy-side research | `/api/analyst` | `coverage` | coverage monitor |
| **Pythia** — top-down strategy | `/api/strategy` | `tilt` (the house view — a **broadcast**, not per-user) | tilt monitor |

One desk and its kind are **archived**: frozen whole under [`archive/`](archive/README.md),
imported by nothing, started by nothing, and deliberately not described here or in APP_SPEC — that
README is their documentation. A few of their names survive in live code (a bot id, a hand-off tag,
a kind constant); those are noted where they matter and nowhere else. **Minos**, the legacy `idea`
monitor, was deleted outright — but the `idea` KIND stays, because it is the execution tier every
order rides.

Their work lands on **one execution tier**: the `idea` kind served by `/api/trade-ideas`, which
portfolio holdings ride, alongside the per-desk `setup` that Talos watches. The execution tier has
no desk of its own, so it is watched by two kind-blind loops rather than one agent's monitor —
`entry.monitor` (armed → hit → confirm) and `exit.monitor` (the stop/TP legs that could not rest at
the broker). One reconciler keeps every kind's state honest against the broker.

Everything a desk builds belongs to one of **three workspaces** — `live` · `paper` · `manual` — and
every desk is handed that venue on every turn (see *Workspaces* below).

Behavioral contracts live in [APP_SPEC.md](APP_SPEC.md); file-by-file layout in
[CODE_MAP.md](CODE_MAP.md).

---

## Stack

- **Runtime:** Node 22, ES modules, Express 4
- **Data:** MongoDB (native `mongodb` driver, no ODM)
- **LLM:** Anthropic + OpenAI, selected per request by a model router (`modelRouter.service.js`)
- **Realtime:** SSE for agent streams; WebSocket for social chat; ProtoOA WebSocket to cTrader
- **Auth:** JWT in an httpOnly cookie (`requireAuth` middleware)

### Market / data providers
Massive, Yahoo Finance, Finnhub, FMP, SEC (EDGAR), GNews, Binance (crypto derivatives).
Chart images for vision TA are rendered in-house (KLineCharts headless via Playwright, from our
FMP candles), with chart-img (TradingView) as the fallback.

### Configuration

**`services/config.js` is the single home for every environment variable** — all 56 of them named
once (`KNOWN_KEYS`), each with its type, default and purpose. Read the file rather than a list here; it is the
answer to "what configures this system?". Three properties of it are load-bearing:

- **It owns dotenv.** Importing config loads `.env`, so no module depends on having been imported
  after something that happened to load it.
- **Every value is a live getter.** Several are legitimately read per call, and tests override
  `process.env` — ESM hoists imports above top-level statements, so only a live read sees them.
- **It refuses to load `.env` under `node --test`.** Not hygiene, a safety gate: the unit suite runs
  offline, and several tests pass *because* the database is unreachable.

Startup fails on a **missing** required value **and** on a malformed one (`CANDLE_CACHE_INTRADAY_MS=abc`
used to yield NaN, get swallowed by `|| default`, and run on a setting nobody chose). It also warns
on `.env` keys no schema entry claims — a typo is only detectable from that side.

Required: `MONGODB_URI`, `JWT_SECRET`. Then LLM (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — transcription
only), market data (`FMP_API_KEY`, `MASSIVE_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`,
`GNEWS_API_KEY`, `CHART_IMG_API_KEY`, `SEC_USER_AGENT`), brokers (`CTRADER_*`, `IBKR_*`),
`CLIENT_URL`, and tuning knobs for the candle caches, the paper engines, the own-chart renderer
(`OWN_CHART_RENDER` — prod hosts must run `npx playwright install chromium` or renders fall back to
chart-img) and the market brief.

Operational knobs added with the hardening pass: `DNS_SERVERS` (empty in production — the old
unconditional `dns.setServers` override now only applies on a dev box), `SHUTDOWN_GRACE_MS`,
`UNHANDLED_REJECTION_FATAL`, `TRUST_PROXY_HOPS`, `RATE_LIMIT_API_PER_MIN` /
`RATE_LIMIT_AUTH_PER_15M` / `RATE_LIMIT_AGENT_PER_15M` / `RATE_LIMIT_DISABLED`, the loop-lease pair
`INSTANCE_LEASE_TTL_MS` / `INSTANCE_LEASE_RENEW_MS` (see *Deployment shape*), and the per-user
monthly spend pair `TOKEN_BUDGET_USD` (the percentage shown in the profile) / `TOKEN_DEGRADE_USD`
(the spend at which chat drops to the cheap model — unset by default, so enforcing it stays a
decision rather than a side effect of the display number).

### Run
```bash
npm install
npm run dev          # nodemon + free-port helper
npm start            # node server.js
npm run server:prod  # NODE_ENV=production (serves built frontend from public/)
npm test             # node --test tests/unit/*.test.js
```

On boot `server.js` ensures the Mongo indexes and starts **twelve background loops**: the
market-open sweep, the **entry** and **exit** monitors, three assessment monitors (Talos /
coverage / tilt), Themis, the execution reconciler, the three paper engines (fill / mark / equity)
and the market-brief notifier. Each goes through `startLoop` (`services/lifecycle.service.js`),
which registers it so shutdown can stop it — a service without a `stop()` is refused and never
runs. They do not start at import: they start when this process wins the loop lease (below).

`GET /api/health` (liveness) and `GET /api/health/ready` (readiness) are unauthenticated and sit
ahead of the rate limiters, so a platform probe never spends a user's budget.

### Deployment shape — ONE process

ONE INSTANCE RUNS THE LOOPS, and since 2026-08-18 that is **enforced rather than documented**.
They start behind a Mongo lease (`services/instanceLock.service.js`): the process that wins it
calls `startBackgroundLoops()`, a second process wins nothing, starts no loops, and says so — it
still serves HTTP. Losing the lease mid-flight (a Mongo blip, a long GC pause) stands the loops
back down, because by then another process may legitimately hold it. All twelve are then stopped
in order on SIGTERM (see *Shutdown* in CODE_MAP.md).

**It buys SAFETY, NOT SCALE.** A handful of module-level `Map`s are load-bearing rather than
caches — above all the exit-order lock in `execution.reconciler` and the WebSocket registry in
`chatWs`, which is per-process request-path state: a user served by the follower still misses the
cards the leader emits. Read
[docs/architecture/single-instance.md](docs/architecture/single-instance.md) before raising any
replica count — **a green lease is not permission**.

---

## Repository layout

```
server.js              Express app, route mounts, background-loop boot
api/                   HTTP surface — one folder per feature (routes + controller + service)
  _shared/             the cross-kind HTTP tier: reason.util (ONE reason→status map),
                       entityController.util (list/get/patch/delete for any kind), sse.util, parse
  axl/                 Axl — the concierge/critic meta-layer that hands the user to the specialists:
                       `<route>` opens a desk for new work, `<edit>` reopens an item they already
                       have in the editor that owns it, `<open>` carries their own sentence in as
                       the desk's first message, `<suggest>` offers follow-up chips. Also delivers
                       the daily market brief (POST /api/axl/brief/stream — streamed into the Axl
                       chat panel, never posted into the social chat)
  workspace/           which book the user is standing in — GET/PUT /api/workspace
  mentor/ setups/      Mentor chat + the `setup` kind (monitored by Talos)
  analyst/             Prometheus chat + the `coverage` research artifact (initiate/revise/retire)
  strategy/            Pythia chat + the `tilt` publication log. NOT owner-scoped — the house view
                       is a broadcast, so /tilt/current answers the same document to everyone, and
                       there is deliberately no delete (a desk that can erase its own calls has no
                       track record; retire archives instead)
  trade-ideas/         the EXECUTION tier — entity CRUD + order placement over the `idea` kind,
                       which is what `portfolio_item` holdings ride
  portfolio/           Atlas chat + portfolio review/rebalance lifecycle
  scanner/             Argus chat + saved scans
  pendingAction/       the QUEUED list (/api/pending-actions) — everything waiting on the user, from
                       both the off-hours queue and the entities the market-open sweep unparked
  experience/          per-user experience level, read by every desk's prompt (indexes only here;
                       no route of its own)
  health/              liveness + readiness probes. UNAUTHENTICATED and mounted ahead of the rate
                       limiters — a platform probe has no cookie and must not spend a user's budget
  threads/ trades/     build-conversation drafts · the frozen-at-fill trade ledger
  broker/              broker connections, orders, positions
    adapters/          BrokerAdapter interface + ctrader / ibkr / paper / manual adapters
  paper/               paper-mode toggle, settings, trades, equity curve
  chat/                user-to-user (social) messaging + bot notifications (WS)
  market/ calendar/ user/ authentication/ transcribe/
services/              business logic + the desks. No Express here.
  agents/              the 6 LLM desks — analyst · axl · mentor · portfolio · scanner · strategy.
                       Their prompts live in `prompts/` (see below).
                       Five append LANGUAGE_RULE + VENUE_RULE + BREVITY_RULE to their base
                       prompt; `strategy` takes LANGUAGE + BREVITY only — a broadcast has no user
                       whose venue could be read. The market brief takes LANGUAGE alone: it is an
                       authored 250–350 word piece and a four-sentence cap would fight its spec
  tools/               the 12 agent-facing tool modules (*.tools.js) — handlers + LLM-ready
                       formatters. Schemas stay in agentTools.registry
  entity/              the entity envelope + makeEntityCrud (ONE owner-scoped CRUD for every kind)
                       + entityRepo (the kind-blind execution facade)
  pendingAction/       the off-hours queue: executionGate (THE market-hours gate) · the record ·
                       originRegistry (execute + cancel per origin) · pendingWork.listWaiting
  chartRender/         KLineCharts headless render (Playwright) — the own-chart vision path
  config.js            THE configuration surface (see above)
prompts/               every prompt loaded at RUNTIME, in one place — the 6 desk prompts,
                       Argus's investing profile + handoff mode, the market brief and
                       concepts.md. Hot-reloaded (mtime-gated) by `makePromptLoader`, so editing
                       one takes effect without a restart. Loading is LAZY: a wrong path is an
                       ENOENT on a live turn, not an import error — `tests/unit/promptPaths.test.js`
                       is the guard, and it also fails on a prompt nothing loads
middleware/            requireAuth · request log · securityHeaders (hand-rolled, no helmet — see the
                       file for why a CSP is deliberately absent) · rateLimit (three limiters:
                       blanket /api, auth, and the desk streams, which are the ones that buy tokens)
providers/             external clients (LLMs, market data, brokers, Mongo) — the only layer that
                       talks to the outside world
monitoring/            one monitor per kind + the shared execution layer
                       talos (setup) · themis (portfolio) · coverage (analyst) ·
                       tilt (strategy)
                       entry.monitor — armed entities: `looking` → `hit` → order plan → confirm
                       exit.monitor — the residual stop/TP leg that could NOT rest at the broker
                         (both kind-blind, both split out of the deleted Minos: ONE loop, ONE
                          capability, so stopping either leaves the other running)
                       marketOpen — kind-blind: the ONE drain for everything parked while shut
                       execution.reconciler — broker-authoritative fill/close → entity status
                       dueLoop — the shared "select what is due, lease it, reschedule it" driver
                       preflightEntry — pure, called at ARM time: is the level already held?
                       paperFill / paperMark / paperEquity — the paper venue's engines
                       marketBrief.notify — not a monitor: the weekday market-brief offer card
  evaluators/          touch, structured, indicator, time, volume, news, chart
tests/unit/            node:test unit tests (`npm test`). tests/*.js are MANUAL live harnesses
docs/                  README.md is THE index. architecture/ = how the machinery is built ·
                       desks/ = each agent + the monitor that watches its kind · design/ =
                       proposed, not yet built · trust-gaps-todo + live-verify-checklist = open work
```

---

## App Flow Schemas

### 0. Reception — Axl hands the user to a desk

Axl is where the user lands, so he is also the way in. He is **read-only**: he decides only *where*,
then gets out of the way.

```
AXL  —  POST /api/axl/stream

  Works out only what decides WHERE: one position or several, do they already
  have a name for it. Everything else the user said travels as their sentence.

  <route>desk SYMBOL</route>   NEW work → the desk's entryTab
  <open>…</open>               their sentence, sent on arrival as the desk's
                               FIRST message (rides with a route, never an edit)
  <edit>kind ID</edit>         reopen something they ALREADY have, in the editor
                               that owns it, conversation restored
  <suggest>…</suggest>         up to 3 follow-up chips — never on a routing turn,
                               because the door he just opened IS the next step
        │
        ▼
  setup → Mentor (the trading desk) · coverage → Prometheus
  scan → Argus · portfolio → Atlas (edit or review — the BOOK decides, never the caller)
```

Risk, horizon, constraints and benchmark are the **receiving desk's** first phase, not reception's —
asking at the door means answering twice. See APP_SPEC §2 for the hand-off contract.

### 1. Trade Ideas

A trade idea moves through a lifecycle from AI chat → condition monitoring → broker order → position close.

```
┌──────────────────────────────────────────────────────────────────┐
│    AUTHORING  —  Mentor (setup) · Atlas (book)                   │
│  POST /api/mentor/stream · /api/portfolio/stream                 │
│                                                                  │
│  The kinds differ; everything downstream of the save is shared,  │
│  which is why adding one needs a payload, an evaluator, a prompt │
│  and a card — but no new plumbing.                               │
│                                                                  │
│             └──► streams tokens + the desk's typed emit block    │
└──────────────────────────────┬───────────────────────────────────┘
                               │ frontend captures the emit block
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                         SAVE IDEA                                │
│  POST /api/trade-ideas       (batch: POST /api/trade-ideas/batch)│
│                                                                  │
│  ideaService.saveIdea()                                          │
│    • resolves condition trees (entry / stop / TP)                │
│    • if multi-broker → forks into per-broker child ideas         │
│    • if paper mode ON → forks onto broker:'paper'                │
│    • status = "waiting"  (or "hit" if idea.immediate = true)     │
│    • persisted to MongoDB  entities collection                   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
               ┌───────────────┴──────────────────┐
          status=waiting                     status=hit (immediate)
               │                                   │
               ▼                                   ▼
┌──────────────────────────┐         ┌─────────────────────────────┐
│  ENTRY MONITOR (poll)    │         │   ORDER PLAN built at save  │
│  every 60 s              │         │   orderState=awaiting_confirm│
│                          │         └──────────────┬──────────────┘
│  entities at "looking"   │                        │
│  rising edge, requireHeld│                        │
│                          │         ┌──────────────┘
│  evaluateTree()          │         │
│    Evaluators (AND/OR):  │         │
│    • touch   (price lvl) │         │
│    • structured (pattern)│         │
│    • indicator (TA)      │         │
│    • time   (session)    │         │
│    • volume (VWAP/CVol)  │         │
│    • news   (LLM)        │         │
│    • chart  (LLM vision) │         │
│                          │         │
│  entry conditions MET    │         │
│    → status = "hit"      │         │
│    → builds order plan   │         │
│    → sends notification  │         │
└────────────┬─────────────┘         │
             │                       │
             └────────────┬──────────┘
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                   ORDER CONFIRMATION                             │
│  POST /api/trade-ideas/:id/orders                                │
│                                                                  │
│  placeOrdersForIdea()                                            │
│    • user confirms plan in dialog                                │
│    • places MARKET/LIMIT/STOP orders at the broker adapter       │
│      (cTrader / paper / manual / IBKR)                           │
│    • routes exits:  touch levels → broker closing orders         │
│                     non-touch leaves → software monitor          │
│    • status = "long" | "short"                                   │
│    • starts execution feed per account                           │
└──────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────┐
│                  POSITION MONITORING                             │
│                                                                  │
│  exit.monitor evaluates the stop/TP legs left on software        │
│  Execution reconciler watches broker fill/close events           │
│    (broker-authoritative — asks the broker if the position lives)│
│                                                                  │
│  When stop or TP triggers:                                       │
│    → status = "closed"  (closedReason: "stop" | "tp")            │
│    → trade captured to the append-only `trades` collection       │
└──────────────────────────────────────────────────────────────────┘

Alternative entry paths:
  "resting"  → PATCH /api/trade-ideas/:id  { status: "resting" }
               places a STOP working order at the broker's book;
               execution reconciler flips to long/short on fill.

  "looking"  → idea is being watched; PATCH with status:"looking"
               resets the monitor floor and restarts entry detection.
```

**Idea statuses:**
```
waiting ──► looking ──► hit ──► long / short ──► closed
                  │              │
                  └── resting ───┘  (broker-native stop entry)
```

**Invalidation is the SECOND AXIS, and it is Talos's.** A plan can go stale while it is still
perfectly well `looking`, so it is tracked orthogonally to the lifecycle — `INVALIDATION.DRIFTING`
(soft, running the wrong way) and `INVALIDATION.FIRED` (latched, awaiting the user). See
`services/entity/vocabulary.js`. For a `setup` the trigger is Talos's validity gate, which fires a
`setup_invalidation` card; it only INFORMS — exits are always stop-owned and invalidation never
executes.

A separate `monitoring/invalidation.monitor.js` used to watch a price ENVELOPE on the `idea` kind
(`idea.invalidation.range`). It was deleted on 2026-08-18: the band was only ever authored by the
Idea agent (deleted in July) and by an archived desk, Atlas never stamps one on a holding, and the
monitor's only caller was Minos's tick — so it had been watching a field nothing writes, for a
kind nothing authors, since July. Reviving the envelope means first building something that
authors the band. (`services/entryTimeGate.util.js` was deleted with it and RESTORED hours later:
`entry.monitor` is the caller it had lost. Pure and unit-tested is what made the round trip free.)

**Who watches the `idea` kind, after Minos.** Minos owned four capabilities in one tick — the entry
poll, the exit poll, the invalidation monitor and the deferred-order sweep — so switching it off
took all four down and nobody noticed for weeks. They are now four things, each stoppable alone:

| Capability | Owner | Note |
|---|---|---|
| entry poll | `monitoring/entry.monitor.js` | `looking` → `hit` → order plan → confirm card; parks at `awaiting_market` off-hours |
| exit poll | `monitoring/exit.monitor.js` | calls `positionMonitor.checkPosition` on the residual leg; pre-gates on `hasMonitoredWork`, so a position protected entirely by resting broker orders costs one Mongo write, not three candle fetches |
| deferred-order sweep | `monitoring/marketOpen.monitor.js` | kind-blind, tied to a capability rather than to any desk's lifecycle |
| the invalidation envelope | *nobody* | deleted; nothing authored the band |

Both polls are kind-blind and both EXCLUDE `setup`: Talos owns setup readiness and already claims
`monitor_state.next_check_at` on those documents, and two loops claiming one document would each
push the other's schedule forward until the loser silently stopped running. Entry polls `looking`
and exits poll `long`/`short`, so a document is never eligible for both.

---

### 2. Portfolios

A portfolio groups multiple ideas under one AI-planned allocation, with a periodic review cycle.

```
┌──────────────────────────────────────────────────────────────────┐
│                   PORTFOLIO CHAT (Agent)                         │
│  POST /api/portfolio/stream   (SSE)                              │
│                                                                  │
│  portfolioAgentService.chatStream()                              │
│    Tools: quotes · correlations · risk metrics · fundamentals    │
│           (EV/EBITDA, FCF + earnings yield, ROIC, and Street PT) │
│           · sec_filings · earnings + earnings calendar           │
│           · short interest / options / derivatives context       │
│           · screen_candidates (cross-universe discovery)         │
│           · get_macro_snapshot (Treasury curve + 2s10s, key      │
│             econ indicators, sector rotation)                    │
│           · trading_context + market hours · web_search          │
│                                                                  │
│  Construction is gated at TWO decision points: lock the mandate, │
│  present regime + architecture, then selection/sizing/plan.      │
│  Sizing enforces the mandate's hard constraints (max-position,   │
│  sector caps, cash floor). Atlas NEVER screens — that's Argus.   │
│                                                                  │
│  Agent emits  <portfolio_plan> JSON block                        │
│    → _sizePlan():  normalizes allocation ratios to sum=1,        │
│                    fetches live prices, computes quantities      │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                      SAVE BATCH IDEAS                            │
│  POST /api/trade-ideas/batch                                     │
│                                                                  │
│  ideaService.saveBatchIdeas()                                    │
│    • creates one idea per asset, all linked by portfolioId       │
│    • allocationRatio stored per idea                             │
│    • ideas start as status="waiting" (no entry conditions)       │
│    • portfolioId minted once, reused when editing                │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                   PORTFOLIO LIFECYCLE                            │
│                                                                  │
│  reviewCadence: "monthly" | "quarterly"                          │
│  lastReviewAt / nextReviewAt tracked per portfolio               │
│                                                                  │
│  GET  /api/portfolio/pending-reviews                             │
│    → returns portfolios overdue for review                       │
│                                                                  │
│  POST /api/portfolio/stream  { reviewMode: true }                │
│    → computePortfolioState() fetches live P&L, drift, notional   │
│    → TWO modes on the one stream: in-position (scoreboard +      │
│      rebalance memo) and pre-activation (all-pending, ~$0        │
│      notional — a pre-flight before "Activate all")              │
│    → thesis-anchored: a fingerprint captured at construction     │
│      and each review close yields a BENCHMARK-RELATIVE           │
│      scoreboard + a regime then→now delta, rendered by the       │
│      SERVER, not estimated by the model                          │
│                                                                  │
│  POST /api/portfolio/:portfolioId/rebalance                      │
│    → applies an agent-proposed rebalance to the linked ideas     │
│    → reports three buckets: applied / queued / failed, and       │
│      ok:false when nothing landed (off-hours changes QUEUE)      │
│                                                                  │
│  POST /api/portfolio/:portfolioId/complete-review                │
│    → advances nextReviewAt by cadence interval                   │
└──────────────────────────────────────────────────────────────────┘

The scheduled cadence NOTIFIES only. The bubble carries a cheap non-LLM
pre-check (computeReviewSignals → triggers[]: conviction fell / regime shift /
drift / benchmark lag / imminent earnings); the full memo is generated only when
the user opens the review. Nothing auto-executes — changes stay Accept-gated.

Edit or review is the BOOK's call, never the caller's:
  nothing in a position  → reopens as a construction EDIT (every holding goes
                           back to `waiting` until re-activated)
  any leg long/short     → opens as a REVIEW instead, because re-planning would
                           take an open position off monitoring to rewrite a plan
                           the market has already acted on
  `hit` sits below the line — a parked order is not a position.

Edit mode (modifying an existing portfolio):
  Agent receives current ideas as context → re-emits <portfolio_plan>
  → frontend calls POST /api/trade-ideas/batch with existing portfolioId
  → old ideas replaced, new set linked under same portfolioId
```

---

### 3. Scans

The scanner agent produces a watchlist of trade candidates for a given timeframe/theme.

```
┌──────────────────────────────────────────────────────────────────┐
│                    SCANNER CHAT (Agent)                          │
│  POST /api/scanner/stream   (SSE)                                │
│                                                                  │
│  scannerAgentService.chatStream()                                │
│    Tools: get_price_action, get_quotes, get_risk_metrics,        │
│           get_fundamentals, get_cycle_analysis, get_earnings,    │
│           get_earnings_calendar, get_sec_filings,                │
│           get_short_interest, get_options_context,               │
│           get_derivatives_context, web_search                    │
│                                                                  │
│  Agent streams tokens + emits <scan_list> JSON block             │
│    → _normalizeScan(): drops malformed candidates, uppercases    │
│      tickers, guarantees period/thesis/direction/signals shape   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                         SAVE SCAN                                │
│  POST /api/scanner/scans                                         │
│                                                                  │
│  Scan document:                                                  │
│    thesis    — overarching market theme                          │
│    direction — "long" | "short" | "mixed"                        │
│    period    — { label, start, end }                             │
│    candidates[] — { ticker, direction, thesis, analysis,         │
│                      signals, conviction, sources[] }            │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                      SCAN CRUD                                   │
│                                                                  │
│  GET    /api/scanner/scans        list all scans for user        │
│  PUT    /api/scanner/scans/:id    update scan (add/remove names) │
│  DELETE /api/scanner/scans/:id    delete scan                    │
│                                                                  │
│  Chat state saved separately per user:                           │
│  POST   /api/scanner/chat-state   save conversation              │
│  GET    /api/scanner/chat-state   restore conversation on reopen │
│  DELETE /api/scanner/chat-state   clear                          │
└──────────────────────────────────────────────────────────────────┘

Edit mode (refining an existing scan list):
  Agent receives current candidates as context → emits full updated
  <scan_list> (not just the diff) → frontend calls PUT to replace
```

---

### 4. Research & strategy — the two desks that produce no orders

Neither Prometheus nor Pythia touches a broker. They produce **artifacts other desks read**, which is
the data-vs-judgment split: their output is a document, not an instruction.

```
PROMETHEUS (buy-side research)        POST /api/analyst/stream
  ├─ the edge is the GAP: OUR price target vs the Street's consensus
  ├─ compute_valuation → services/valuation.engine.js (deterministic, not the model's arithmetic)
  └─ emits a `coverage` doc — variant perception · rating · PT + estimates ·
     kill_criteria · append-only revisions[]                     /api/analyst/coverage
        │
        └─► the coverage monitor re-models on new facts (compare-and-swap: a re-model is a
            multi-minute run, so the hourly tick's loser stands down). A price target carries a
            DEADLINE; an early hit reopens the call rather than closing it — a target hit early
            means the target was too low, not that the thesis is done.

PYTHIA (top-down strategy)            POST /api/strategy/stream
  ├─ ONE standing house view: a named regime + sector stances as ACTIVE WEIGHT (bps) vs a
  │  benchmark — a stance, never a return forecast
  ├─ a BROADCAST: no userId anywhere. /api/strategy/tilt/current answers everyone the same doc
  └─ retire ARCHIVES; there is no delete, because a desk that can erase its own calls has no
     track record
        │
        ├─► the tilt monitor re-reads the regime; the clock and the baseline are PER ROW
        └─► CONSUMED, not just published: Atlas reads the house view when constructing and
            reviewing (portfolioChat + sectorView.tools), and Axl surfaces it — a strategy desk
            nobody reads is a costume
```

---

## Off-hours execution queue

**Nothing executes off-hours, paper included** (2026-08-07). A real market order cannot fill into a
shut market, and a simulation that fills anyway — at yesterday's close — is not simulating anything.

```
  user confirms a trim at 02:00
            │
            ▼
  executionGate.deferIfClosed({ userId, asset, assetClass, origin, action })
            │
     ┌──────┴──────┐
  open           closed
     │               │
  proceed to     QUEUE it (`pending_actions`) — do not touch the broker,
  the broker     and tell the user at the moment they act
                     │
                     ▼
            marketOpen.monitor drains BOTH stores at the open:
              • entities parked at `awaiting_market`   (claimIf)
              • queued actions                          (transition from QUEUED)
                     │
                     ▼
            ONE `queue_ready` card per USER, from Axl → the Floor's Queued desk
                     │
            POST /api/pending-actions/:id/execute  → replays through the ORIGINAL
                                                     function (_trimItem/_exitItem/_addToItem)
            POST /api/pending-actions/:id/cancel   → drops the row AND tells the deciding desk
```

Before this there was no rule at all for *changing* a position off-hours: five call sites each
decided hours policy and disagreed, and the review's add/trim/exit fired blind. Two guarantees are
easy to lose in a rewrite — a **monitor's** exit is not cancellable from the list (the stop is still
breached, so dropping the row re-queues it next tick) and is dispatched separately from a user's,
because a monitor's exit can be a *slice* while `_exitItem` closes everything. Full design +
carve-outs: [docs/architecture/off-hours-queue.md](docs/architecture/off-hours-queue.md).

---

## Brokers & Order Routing

All trading goes through one **broker adapter** contract
(`api/broker/adapters/broker.interface.js`). Consumers (order planner, frontend) branch on a
broker's `capabilities()` flags — never on its name. Adding a broker = a provider client + an
adapter + one line in `broker.factory.js`.

| Broker    | Status                | Transport                              | Trading |
|-----------|-----------------------|----------------------------------------|---------|
| cTrader   | **Live**              | REST (OAuth/accounts) + ProtoOA WebSocket | full    |
| paper     | **Live** (simulated)  | in-process virtual venue               | full    |
| manual    | **Live** (data-only)  | the same virtual store, `mode:'manual'` | none — the USER fills |
| IBKR      | In progress (data)    | TWS API socket via IB Gateway (`@stoqey/ib`) | none yet |

**Manual** is real money at an institution the app can't be wired to. It reuses the paper adapter's
read plumbing so positions and mark-to-market work unchanged, but **guards every trading op**: the
lifecycle is driven by the user's own two confirmations (entry fill, exit fill) through a FillCard,
never by an order. That is also why manual books are never hours-gated — a Fill card is an
instruction, not an execution. See `docs/architecture/manual-mode.md`.

- **Capabilities:** `trading`, `selfExecuted`, `nativeProtection`, `modifyProtection`,
  `closePosition`, `cancelOrder`, `listOrders`, `amendOrder`, `ohlcv`. The base class defaults
  every flag to `false` and every method to a throwing stub, so a new adapter degrades safely
  until wired. `capabilities()` is an exhaustive literal per adapter, never a spread of the base —
  an omitted flag reads `undefined`.
- **`selfExecuted` is how a venue says who trades at it**, and it is why `manual` needs no
  special-casing anywhere: the app cannot place the order, but the ACCOUNT HOLDER can, so the
  entity still has a future. `services/venue.resolve.service.js` owns the two derived questions —
  `isSelfExecuted(broker)` (post a card instead of an order) and `isBindableVenue(broker)` (may a
  setup bind here at all — `trading || selfExecuted`). That replaced a hard-coded
  `['ctrader','paper','manual']` list in `setups.service`, which was correct today and wrong in the
  direction nobody notices: the day IBKR's trading flips on, that list would have refused every
  Generate with `no_venue`.
- **Reconciler is broker-authoritative.** Every adapter translates native fills into one
  normalized `BrokerExecution` shape (`order.*`, `position.opened/reduced/closed`) on a shared
  `executionBus`, so all brokers look identical downstream. On a reduce/close the reconciler asks
  the broker whether the position survived before mutating idea state.
- **Hedging brokers** (cTrader): exits are `positionId` closing orders (reduce-only), not naked
  opposite orders. `touch` exit levels rest as broker closing orders; non-touch exits are watched
  by the software monitor.
- **Symbol normalization** (`services/brokerSymbol.service.js`): the app speaks one canonical
  asset per instrument; a static bidirectional per-broker alias map renames index futures ↔ cash
  CFDs (cTrader `NQ↔US100`, `ES↔US500`, `YM↔US30`, `RTY↔US2000`). Everything else resolves by a
  case/separator-insensitive identity fallback. IBKR maps to real futures contracts via its own
  `IBKR_CONTRACTS` table.

**Broker HTTP surface** (`/api/broker`, `:type` = `ctrader | paper | manual | ibkr` — the four
adapters registered in `broker.factory.js`):
```
GET    /connect/:type                     start OAuth (redirect to consent)
GET    /callback                          OAuth callback (identity from signed state)
GET    /connections                       list connected brokers
DELETE /connections/:type                 disconnect
PATCH  /connections/:type/account         set selected trading account
GET    /:type/trading-accounts            list accounts
GET    /:type/capabilities                capability flags
GET    /:type/account                     account summary
GET    /:type/positions                   open positions
GET    /:type/orders                      working orders
POST   /:type/orders                      place a working order
PATCH  /:type/orders/:orderId             amend order price
DELETE /:type/orders/:orderId             cancel a working order
DELETE /:type/positions/:positionId       close a position
```

---

## Workspaces

`live` · `paper` · `manual` are the **book the user is standing in** — three siblings, not a toggle
plus a special case.

| Workspace | Money | Who executes | Derived from |
|---|---|---|---|
| `live` | real | the app, at a connected broker | the default |
| `paper` | simulated | the app, against live prices | the paper `enabled` flag |
| `manual` | **real**, at an institution the app cannot reach | the **user**, at their bank | the user's stored choice |

**Manual is paper's twin in everything the app does** — same virtual account store, same marks off
live prices, same condition monitoring, same journal. Two things separate it from paper: the money is
real, and execution is external (on a hit we alert; the user places it at their bank and confirms the
actual fill here). One thing separates it from live: the numbers are the user's word, not a broker
read.

Because manual is broker-less it has **no connection flag to derive itself from**. The choice is
persisted per user (`user_workspace`, served by `/api/workspace`) and joined with the paper flag by
one rule — `resolveWorkspace`: the paper flag wins, else a stored `manual`, else live — held in
`api/workspace/workspace.model.js` and mirrored verbatim in the frontend's `useWorkspaceMode`.

**What belongs to a workspace is whatever binds to an ACCOUNT.** `setup` and `portfolio` are
scoped to one book and filtered everywhere they are shown (`listWatchedItems({ workspace })` for the
desks, `inWorkspace()` for every frontend list). Scans, coverage and the house forecast are research,
bind to no account, and are **shared across all three**. A book carries `modes[]` rather than one
value, so a mixed book shows in every workspace it holds something in.

**It is a UI/authoring scope and NEVER an engine filter** — the monitors and the reconciler process
every mode regardless, or a live stop stops firing while the user is looking at paper.

### The venue block

`get_trading_context` was wired into every desk and they still opened turns asking "are we in paper
or live?" — a tool is an invitation, and a model mid-thought declines it. So the venue is now
**pushed** into every turn (`buildVenueSection`) and `VENUE_RULE` says asking anyway is a failure:
the workspace, the connected broker, every account, and **available to deploy** (the balance minus
what open positions already tie up — sizing against balance spends the same money twice).

It forbids asking for facts, never deciding with them. It rides the last user message rather than the
system prompt, because free cash moves on every fill and a volatile system block would sit ahead of
the whole conversation in the cache prefix. Positions and P&L stay in the tool — they move every tick.
Pythia and the market brief are excluded: both are broadcasts with no user whose venue could be read.

---

## Paper Trading

Paper mode is a first-class **`'paper'` broker adapter**, so the same monitor + reconciler that
drive live cTrader also drive paper — no parallel engine. Toggling paper mode ON forks new ideas
onto `broker:'paper'` and the account the user picked in the selector.

- **Several virtual accounts per user**, persisted in Mongo (`paperAccounts` / `paperPositions` /
  `paperOrders`). Cash-only margin: `equity = cashBalance + Σ unrealized`, `freeMargin = equity`.
- **The account id carries its mode**: `makeAccountId` mints `<mode>-<userId>-<short>`, and that
  `<mode>-` prefix is what `isPaperIdea` / `accountMode` derive a workspace from — which is also
  why `manual` reuses this store rather than getting one of its own. Pre-migration docs with no
  `mode` were invisible to `listAccounts({ mode })` while still reachable BY ID, so orders,
  positions and equity points accumulated on accounts their owner could not see or close from;
  `scripts/drop-ghost-paper-accounts.mjs` archived and removed them (2026-08-19) and is kept
  because it is idempotent and finds any that turn up later.
- **A position reports the account it sits on** (`accountName`), not just its id — a user holding
  three paper books needs to read which one a row belongs to.
- **Simulated fills against the live feed.** Market orders fill instantly *while the venue is open*
  — off-hours they queue like any other order, because FMP answers `200` with the last close at 2am
  and a stale print passing as live was the bug that produced the queue. Resting stop/limit orders
  are filled by the paper fill engine (`monitoring/paperFill.service.js`), a global ~3s sweep
  (`PAPER_FILL_INTERVAL_MS`) that fills at the trigger price when live price crosses it and emits
  normalized events onto the `executionBus`. It **claims** each order (`claimOrder`, guarded on
  `status:'working'`) rather than blind-`$set`ting it — two readers both seeing `working` would both
  call the non-idempotent `openPosition` and silently double the size.
- **Marks** are refreshed by their own loop (`monitoring/paperMark.service.js`, ~3s).
- **Cost model:** spread crossed via `spreadBps` (buy→ask, sell→bid) baked into effective price,
  plus `commissionPerTrade` debited per fill. Per-user, default ON, set via `PUT /api/paper/settings`.
- **Equity curve** snapshotted every 5 min (`monitoring/paperEquity.service.js`) for users with
  open positions.
- **Trade capture** (`services/tradeCapture.service.js`) writes an append-only `trades` collection
  for **both** paper and live (both flow through the same reconciler). Each record freezes a
  point-in-time snapshot of the idea as authored and is tagged `mode: 'paper' | 'live'`.

The paper BROKER (orders / positions / account) is served generically under `/api/broker/paper/*`
like any other adapter. These routes own the paper-SPECIFIC surface — the accounts themselves, the
global mode toggle, cost settings, the equity curve and trade history.

**Paper HTTP surface** (`/api/paper`, all auth):
```
per-account
GET    /accounts                          list all paper accounts (+ live equity)
POST   /accounts                          { name?, startingBalance?, currency? } → create
PATCH  /accounts/:accountId               { name?, spreadBps?, commissionPerTrade? }
DELETE /accounts/:accountId               delete (409 if it holds an open position)
POST   /accounts/:accountId/reset         { startingBalance? } → wipe + restore
POST   /accounts/:accountId/cash          { amount, reason? } → dividend / deposit / fee
GET    /accounts/:accountId/equity-curve  ?fromMs=
GET    /accounts/:accountId/trades        ?status=&limit=

legacy single-account (TRANSITIONAL — these operate on the DEFAULT paper account)
GET  /state          paper flag + account config + live equity
PUT  /mode           turn paper mode on/off
PUT  /settings       spreadBps, commissionPerTrade
POST /reset          wipe positions/orders, restore balance
GET  /trades         paper trade history (?status=&limit=)
GET  /equity-curve   equity points (?fromMs=)
```

---

## Other endpoints

- **Auth** `/api/auth` — `POST /signup`, `POST /signin`, `POST /signout`, `GET /me`.
  JWT lives in an httpOnly cookie; `requireAuth` guards everything except broker OAuth callback
  and transcribe.
- **Users** `/api/users` — CRUD + `GET /:id/usage` (token-usage stats).
- **Workspace** `/api/workspace` — `GET` and `PUT { workspace }` → `{ workspace, stored }`. Which of
  the three books the user is standing in. Its own surface rather than a field on `/api/paper/state`,
  because a workspace is not a paper concept and `manual` is the one with no paper account behind it.
- **Mentor / setups** `/api/mentor/stream` + `/api/setups` — the `setup` kind (price zones are
  RIVAL scenarios, never legs; quantity is never summed across them).
- **Analyst** `/api/analyst` — `POST /stream` + coverage CRUD; `POST /coverage/:id/retire` archives,
  `DELETE` removes. Two verbs because retire once answered the DELETE route and the API claimed a
  removal that never happened.
- **Strategy** `/api/strategy` — `POST /stream` + the tilt log. `GET /tilt/current` is the house
  view, the same document for everyone; `POST /tilt/:id/retire` archives, and there is no delete.
- **Pending actions** `/api/pending-actions` — `GET /` (the queued list), `POST /:id/execute`,
  `POST /:id/cancel`. See the off-hours queue above.
- **Threads** `/api/threads` — the unified build-conversation drafts (subject-bound, TTL-expired,
  linked to their artifact on generate).
- **Trades** `/api/trades` + `/api/trades/stats` — the frozen-at-fill analytics ledger (paper + live).
- **Social chat** `/api/chat` — user-to-user messaging (`/conversations`, messages, read
  receipts, `GET /users/search`). Realtime via WebSocket (`api/chat/chatWs.js`, `userId` → a SET of
  sockets: every tab reads the same inbox). This is **not** the agent chat — those are the per-desk
  SSE streams. Agent notifications (entry confirm, invalidation alert, queue ready) arrive here as
  typed bot cards, one notify bot per desk.
- **Health** `/api/health` (liveness) and `/api/health/ready` (readiness) — the only
  UNAUTHENTICATED surface besides broker OAuth callback and transcribe, and mounted ahead of the
  rate limiters so a probe never spends a user's budget. They are two different questions: liveness
  stays 200 while the process drains (failing it means "restart this container", which turns an
  orderly deploy into a hard kill), readiness goes 503 the moment shutdown begins so the load
  balancer stops routing BEFORE `server.close()` starts refusing sockets. Both answer with
  `.end()` under `Cache-Control: no-store` — `res.json()` computes an ETag, and a byte-identical
  readiness body would come back as a 304 with no body, which a probe reads as an outage.
- **Market** `/api/market/status` · **Calendar** `/api/calendar/earnings` (Finnhub, +company logo/name), `/api/calendar/fed` (macro/FOMC via FRED), `/api/calendar/ipo` (Finnhub).
- **Transcribe** `/api/transcribe` — raw audio → text (registered before `express.json`).

---

## Data Flow Summary

```
                        Axl (reception — decides WHERE, executes nothing)
                                          │
              ┌──────────────┬────────────┴──┬──────────────┬─────────────┐
              ▼              ▼               ▼              ▼             ▼
            Argus         Mentor           Atlas       Prometheus      Pythia
            scan          setup          portfolio      coverage        tilt
              │              │               │              │             │
         candidates ────────►│           holdings          the artifacts other
                             │               │             desks read (no orders)
                             ▼               ▼
                          Talos         Themis (review cadence)
                             │               │
                             │               │
                             └──────┬────────┘
                                    ▼
                     entry conditions met → order plan → USER CONFIRMS
                                    │
                     executionGate — venue open?  ──no──►  pending_actions
                                    │ yes                      │ (drained at the open)
                                    ▼                          ▼
                     Broker orders (cTrader / paper / manual / IBKR)  ◄──┘
                                    │
                     execution.reconciler (broker-authoritative)
                                    │
                     Positions ──► trades (append-only, paper + live + manual)
```

Everything above happens inside ONE of three workspaces — `live`, `paper` or `manual` — and every
desk is told which on every turn. The workspace scopes what is SHOWN and what a desk REPORTS; it
never gates the monitors, which run every mode so a live stop fires while the user is in paper.
