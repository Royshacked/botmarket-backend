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

**Kairos (`call`) and Hermes are ARCHIVED** (2026-08-18) — `/api/kairos` is unmounted, Hermes is
not started, and both live under [`archive/`](archive/README.md), imported by nothing. Mentor took
the trading over (`docs/desks/trade-pipeline.md`); Kairos returns later as a premium Mentor mode.
**Minos**, the legacy `idea` monitor, was deleted outright — but the `idea` KIND stays, because it
is the execution tier every order rides.

Their work lands on **one execution tier**: the `idea` kind served by `/api/trade-ideas`, which
portfolio holdings ride, plus the per-desk kinds (`call`, `setup`) that their own monitors watch.
One reconciler keeps every kind's state honest against the broker.

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

**`services/config.js` is the single home for every environment variable** — all ~43 of them named
once, each with its type, default and purpose. Read the file rather than a list here; it is the
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
`UNHANDLED_REJECTION_FATAL`, `TRUST_PROXY_HOPS`, and `RATE_LIMIT_API_PER_MIN` /
`RATE_LIMIT_AUTH_PER_15M` / `RATE_LIMIT_AGENT_PER_15M` / `RATE_LIMIT_DISABLED`.

### Run
```bash
npm install
npm run dev          # nodemon + free-port helper
npm start            # node server.js
npm run server:prod  # NODE_ENV=production (serves built frontend from public/)
npm test             # node --test tests/unit/*.test.js
```

On boot `server.js` ensures the Mongo indexes and starts **eleven background loops**: the
market-open sweep, three assessment monitors (Talos / coverage / tilt), Themis, the execution
reconciler, the three paper engines (fill / mark / equity) and the market-brief notifier. Each goes
through `startLoop` (`services/lifecycle.service.js`), which registers it so shutdown can stop it —
a service without a `stop()` is refused and never runs.

`GET /api/health` (liveness) and `GET /api/health/ready` (readiness) are unauthenticated and sit
ahead of the rate limiters, so a platform probe never spends a user's budget.

### Deployment shape — ONE process

Those eleven loops are stopped in order on SIGTERM (see *Shutdown* in CODE_MAP.md), but they start
with **no leader election**, and a handful of module-level
`Map`s are load-bearing rather than caches — above all the exit-order lock in `execution.reconciler`
and the WebSocket registry in `chatWs`, which a second instance cannot even see. Some loops claim
their work through Mongo and are safe (Talos via dueLoop's lease, marketOpen via `claimIf`,
paperFill via `claimOrder`, the brief notifier via its card dedupe); the rest rely on being the only
process alive. **A second instance corrupts the first and breaks the second, mostly in silence.**
Read [docs/architecture/single-instance.md](docs/architecture/single-instance.md) — what is already
claimed, what is not, and the order to fix it in — before raising any replica count.

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
  agents/              the 6 LLM desks — analyst · axl · mentor · portfolio · scanner · strategy
                       (kairos archived). Their prompts live in `prompts/` (see below).
                       Six append LANGUAGE_RULE + VENUE_RULE to their base prompt; `strategy` does
                       not — a broadcast has no user whose venue could be read
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
                       marketOpen — kind-blind: the ONE drain for everything parked while shut
                       execution.reconciler — broker-authoritative fill/close → entity status
                       invalidation — advisory entry-range watcher, never executes
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
│    • persisted to MongoDB  ideas collection                      │
└──────────────────────────────┬───────────────────────────────────┘
                               │
               ┌───────────────┴──────────────────┐
          status=waiting                     status=hit (immediate)
               │                                   │
               ▼                                   ▼
┌──────────────────────────┐         ┌─────────────────────────────┐
│  MONITOR SERVICE (poll)  │         │   ORDER PLAN built at save  │
│  every 60 s              │         │   orderState=awaiting_confirm│
│                          │         └──────────────┬──────────────┘
│  ideas in "looking" /    │                        │
│  "waiting" status        │                        │
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
│      (cTrader / paper / IBKR)                                    │
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
│  Monitor continues evaluating stop/TP condition trees            │
│  Execution reconciler watches broker fill/close events           │
│    (broker-authoritative — asks the broker if the position lives)│
│  Invalidation monitor watches the entry-range band (advisory)    │
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

**Invalidation monitor** — a deterministic entry-range watcher (`monitoring/invalidation.monitor.js`).
This is **not an agent and not a condition leaf.** The authoring desk sets the band once
(`idea.invalidation.range = { lower, upper, *Anchor }`, derived from chart structure); from then
on it's checked deterministically — no LLM in the hot path. The band is a separate field on the
idea, *not* a leaf in the entry/stop/TP tree: on each pass the monitor synthesizes an ephemeral
`structured` leaf per edge (`closes below <lower>` / `closes above <upper>`) and runs it through
the same `evaluateTree()` evaluator the entry conditions use. The setup is alive only while price
stays inside the band; a candle CLOSE outside either edge fires a one-shot advisory alert (bot
message in social chat + a deep link into idea edit mode; latched by `invalidation_status` until
the user acts). It runs pre-entry **and** in-position, but only INFORMS — exits are always
stop-owned, invalidation never executes.

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

- **Capabilities:** `trading`, `nativeProtection`, `modifyProtection`, `closePosition`,
  `cancelOrder`, `listOrders`, `amendOrder`, `ohlcv`. The base class defaults every flag to
  `false` and every method to a throwing stub, so a new adapter degrades safely until wired.
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

**Broker HTTP surface** (`/api/broker`, `:type` = `ctrader | paper | ibkr`):
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

**What belongs to a workspace is whatever binds to an ACCOUNT.** `call`, `setup` and `portfolio` are
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
onto `broker:'paper'` / `accountId='paper-<userId>'`.

- **Virtual account per user**, persisted in Mongo (`paperAccounts` / `paperPositions` /
  `paperOrders`). Cash-only margin: `equity = cashBalance + Σ unrealized`, `freeMargin = equity`.
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

**Paper HTTP surface** (`/api/paper`, all auth):
```
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
