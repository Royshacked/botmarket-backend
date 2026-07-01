# botmarket-backend

AI-powered trading assistant backend — Express + MongoDB + LLM agents (Anthropic / OpenAI).

Three conversational agents (**Trade**, **Portfolio**, **Scanner**) turn natural-language
chat into monitored trade ideas, then route confirmed entries and exits to a real broker
(cTrader), a paper venue, or IBKR (data-only for now) through one unified adapter layer.

---

## Stack

- **Runtime:** Node 22, ES modules, Express 4
- **Data:** MongoDB (native `mongodb` driver, no ODM)
- **LLM:** Anthropic + OpenAI, selected per request by a model router (`modelRouter.service.js`)
- **Realtime:** SSE for agent streams; WebSocket for social chat; ProtoOA WebSocket to cTrader
- **Auth:** JWT in an httpOnly cookie (`requireAuth` middleware)

### Market / data providers
Massive, Yahoo Finance, Finnhub, FMP, SEC (EDGAR), GNews, chart-img, Binance (crypto derivatives).

### External env vars
```
# required
MONGODB_URI            JWT_SECRET

# LLM
ANTHROPIC_API_KEY      OPENAI_API_KEY      OPENAI_SYSTEM_PROMPT
TOKEN_BUDGET_USD

# market data / news
MASSIVE_API_KEY        FINNHUB_API_KEY     FMP_API_KEY
GNEWS_API_KEY          CHART_IMG_API_KEY   SEC_USER_AGENT

# brokers
CTRADER_CLIENTID       CTRADER_SECRET      CTRADER_REDIRECT_URI   CTRADER_REDIRECT_URL_PROD
IBKR_GW_HOST           IBKR_GW_PORT        IBKR_GW_CLIENTID
CLIENT_URL

# optional tuning
PORT (3030)   NODE_ENV   PAPER_FILL_INTERVAL_MS (30s)   PAPER_EQUITY_SNAPSHOT_MS (5m)
```

### Run
```bash
npm install
npm run dev          # nodemon + free-port helper
npm start            # node server.js
npm run server:prod  # NODE_ENV=production (serves built frontend from public/)
```
`server.js` fails fast if `MONGODB_URI` or `JWT_SECRET` are missing. On boot it starts the
background services: news feed, monitor, execution reconciler, paper fill engine, paper
equity snapshotter.

---

## Repository layout

```
server.js              Express app, route mounts, background-service boot
api/                   HTTP surface — one folder per feature (routes + controller + service)
  orchestrator/        Trade Agent SSE chat (the AI idea-building conversation)
  trade-ideas/         idea CRUD + order placement
  portfolio/           Portfolio Agent chat + review lifecycle
  scanner/             Scanner Agent chat + saved scans
  broker/              broker connections, orders, positions
    adapters/          BrokerAdapter interface + ctrader / ibkr / paper adapters
  paper/               paper-mode toggle, settings, trades, equity curve
  chat/                user-to-user (social) messaging + bot notifications (WS)
  news-feed/ market/ calendar/ user/ authentication/ transcribe/
services/              agent services, model routing, condition trees, pricing, order plan…
providers/             external clients (LLMs, market data, brokers, Mongo)
monitoring/            monitor loop, evaluators, reconciler, invalidation monitor, paper engines
  evaluators/          touch, structured, indicator, time, volume, news, chart
docs/architecture/     design docs
```

---

## App Flow Schemas

### 1. Trade Ideas

A trade idea moves through a lifecycle from AI chat → condition monitoring → broker order → position close.

```
┌──────────────────────────────────────────────────────────────────┐
│                  TRADE AGENT CHAT (Orchestrator)                 │
│  POST /api/orchestrator/stream   (SSE)                           │
│                                                                  │
│  User ──► tradeAgentService.chatStream()                         │
│             │  model chosen per-request by modelRouter           │
│             │  Tools: get_quote, get_candles, get_chart,         │
│             │         get_short_interest, get_options_context,   │
│             │         get_derivatives_context, web_search        │
│             │                                                    │
│             └──► streams tokens + <trade_idea> JSON block        │
└──────────────────────────────┬───────────────────────────────────┘
                               │ frontend captures <trade_idea>
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                         SAVE IDEA                                │
│  POST /api/trade-ideas        (batch: POST /api/trade-ideas/batch)│
│                                                                  │
│  ideaService.saveIdea()                                          │
│    • resolves condition trees (entry / stop / TP)                │
│    • if multi-broker → forks into per-broker child ideas         │
│    • if paper mode ON → forks onto broker:'paper'                │
│    • status = "waiting"  (or "hit" if idea.immediate = true)     │
│    • persisted to MongoDB  ideas collection                       │
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
│    (broker-authoritative — asks the broker if a position survived)│
│  Invalidation monitor watches the entry-range band (advisory)    │
│                                                                  │
│  When stop or TP triggers:                                       │
│    → status = "closed"  (closedReason: "stop" | "tp")           │
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
This is **not an agent and not a condition leaf.** The Trade Agent authors the band once
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
│    Tools: get_quote, get_quotes, get_correlations,               │
│           get_risk_metrics, get_fundamentals, get_sec_filings,   │
│           get_earnings_calendar, get_short_interest,             │
│           get_options_context, get_derivatives_context,          │
│           web_search                                             │
│                                                                  │
│  Agent emits  <portfolio_plan> JSON block                        │
│    → _sizePlan():  normalizes allocation ratios to sum=1,        │
│                    fetches live prices, computes quantities        │
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
│    → injects live state into agent context for review advice     │
│                                                                  │
│  POST /api/portfolio/:portfolioId/rebalance                      │
│    → applies an agent-proposed rebalance to the linked ideas     │
│                                                                  │
│  POST /api/portfolio/:portfolioId/complete-review                │
│    → advances nextReviewAt by cadence interval                   │
└──────────────────────────────────────────────────────────────────┘

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
│           get_fundamentals, get_earnings_calendar,               │
│           get_sec_filings, get_short_interest,                   │
│           get_options_context, get_derivatives_context,          │
│           web_search                                             │
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
│  GET    /api/scanner/chat-state   restore conversation on reopen  │
│  DELETE /api/scanner/chat-state   clear                          │
└──────────────────────────────────────────────────────────────────┘

Edit mode (refining an existing scan list):
  Agent receives current candidates as context → emits full updated
  <scan_list> (not just the diff) → frontend calls PUT to replace
```

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
| IBKR      | In progress (data)    | TWS API socket via IB Gateway (`@stoqey/ib`) | none yet |

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

## Paper Trading

Paper mode is a first-class **`'paper'` broker adapter**, so the same monitor + reconciler that
drive live cTrader also drive paper — no parallel engine. Toggling paper mode ON forks new ideas
onto `broker:'paper'` / `accountId='paper-<userId>'`.

- **Virtual account per user**, persisted in Mongo (`paperAccounts` / `paperPositions` /
  `paperOrders`). Cash-only margin: `equity = cashBalance + Σ unrealized`, `freeMargin = equity`.
- **Simulated fills against the live feed.** Market orders fill instantly; resting stop/limit
  orders are filled by the paper fill engine (`monitoring/paperFill.service.js`), a global ~30s
  sweep (`PAPER_FILL_INTERVAL_MS`) that fills at the trigger price when live price crosses it and
  emits normalized events onto the `executionBus`.
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
  JWT lives in an httpOnly cookie; `requireAuth` guards everything except broker OAuth callback,
  the news-feed router, and transcribe.
- **Users** `/api/users` — CRUD + `GET /:id/usage` (token-usage stats).
- **Social chat** `/api/chat` — user-to-user messaging (`/conversations`, messages, read
  receipts, `GET /users/search`). Realtime via WebSocket (`api/chat/chatWs.js`). This is **not**
  the AI agent chat — that's the orchestrator SSE. Agent notifications (idea hit, invalidation
  alert) arrive here as bot messages.
- **News feed** `/api/news-feed` — `GET /`, `GET /stream` (SSE), `GET /asset/:symbol`,
  `GET /asset/:symbol/sentiment`.
- **Market** `/api/market/status` · **Calendar** `/api/calendar/earnings`, `/api/calendar/fda`.
- **Transcribe** `/api/transcribe` — raw audio → text (registered before `express.json`).

---

## Data Flow Summary

```
Scanner ──► Scan candidates ──► user picks one ──► Trade Chat ──► Idea
                                                                    │
                                                               Monitor
                                                                    │
                                                     Broker orders (cTrader/paper/IBKR)
                                                                    │
Portfolio ──► Batch ideas ──► Monitor (each idea) ──► Positions ──► trades (paper+live)
                 │
            Portfolio review cycle
```
