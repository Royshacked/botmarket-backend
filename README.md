# botmarket-backend

AI-powered trading assistant backend — Express + MongoDB + Anthropic.

---

## App Flow Schemas

### 1. Trade Ideas

A trade idea moves through a lifecycle from AI chat → condition monitoring → broker order → position close.

```
┌──────────────────────────────────────────────────────────────────┐
│                        CHAT (Trade Agent)                        │
│  POST /api/chat/stream  (SSE)                                    │
│                                                                  │
│  User ──► TradeAgentService.chatStream()                         │
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
│  POST /api/ideas   (or  POST /api/ideas/batch for portfolios)    │
│                                                                  │
│  ideaService.saveIdea()                                          │
│    • resolves condition trees (entry / stop / TP)                │
│    • if multi-broker → forks into per-broker child ideas         │
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
│  POST /api/ideas/:id/orders                                      │
│                                                                  │
│  placeOrdersForIdea()                                            │
│    • user confirms plan in dialog                                │
│    • places MARKET/LIMIT/STOP orders at broker (cTrader / IBKR) │
│    • routes exits:  touch levels → native broker closing orders  │
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
│  Thesis monitor evaluates entry thesis vs live price             │
│                                                                  │
│  When stop or TP triggers:                                       │
│    → status = "closed"  (closedReason: "stop" | "tp")           │
└──────────────────────────────────────────────────────────────────┘

Alternative entry paths:
  "resting"  → PATCH /api/ideas/:id  { status: "resting" }
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
│  POST /api/ideas/batch                                           │
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
│  POST /api/portfolio/:id/complete-review                         │
│    → advances nextReviewAt by cadence interval                   │
└──────────────────────────────────────────────────────────────────┘

Edit mode (modifying an existing portfolio):
  Agent receives current ideas as context → re-emits <portfolio_plan>
  → frontend calls POST /api/ideas/batch with existing portfolioId
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
│  PATCH  /api/scanner/scans/:id    update scan (add/remove names) │
│  DELETE /api/scanner/scans/:id    delete scan                    │
│                                                                  │
│  Chat state saved separately per user:                           │
│  POST   /api/scanner/chat-state   save conversation              │
│  GET    /api/scanner/chat-state   restore conversation on reopen  │
│  DELETE /api/scanner/chat-state   clear                          │
└──────────────────────────────────────────────────────────────────┘

Edit mode (refining an existing scan list):
  Agent receives current candidates as context → emits full updated
  <scan_list> (not just the diff) → frontend calls PATCH to replace
```

---

## Data Flow Summary

```
Scanner ──► Scan candidates ──► user picks one ──► Trade Chat ──► Idea
                                                                    │
                                                               Monitor
                                                                    │
                                                            Broker orders
                                                                    │
Portfolio ──► Batch ideas ──► Monitor (each idea) ──► Positions
                 │
            Portfolio review cycle
```
