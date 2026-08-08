# Architecture Documentation

| Document | What it covers |
|---|---|
| [building.md](./building.md) | Chat → armed position: the SSE desks, XML emit blocks, condition trees, persistence, arming |
| [monitoring.md](./monitoring.md) | Background monitoring service; AND/OR condition logic; the 7 leaf evaluators (structured/touch/indicator/chart/news/time/volume) + VWAP + intrabar mechanics; Claude Haiku usage |
| [broker.md](./broker.md) | Multi-broker adapter pattern + capability flags; cTrader live trading (ProtoOA WS), paper broker, IBKR (IB Gateway, data-only); execution reconciler; OAuth / gateway connections |
| [paper-trading-simulation.md](./paper-trading-simulation.md) | Virtual per-user account; live-price fill engine; equity snapshots; the `paper` broker adapter |
| [off-hours-queue.md](./off-hours-queue.md) | **Nothing executes off-hours, paper included.** The one hours gate; `pending_actions`; cancel propagation back to the deciding desk; the market-open drain |
| [manual-mode.md](./manual-mode.md) | Real money at a broker-less institution: data-only adapter, user-confirmed entry/exit fills, why manual is never hours-gated |
| [trades-data.md](./trades-data.md) | The canonical trade entity: the `trades` ledger schema, origin model (idea/call/portfolio), stored-vs-derived metrics, capture path, and gaps to close |
| [ohlcv-price-data.md](./ohlcv-price-data.md) | OHLCV pipeline; Massive/Polygon provider; file cache; priceService; monitoring adapter |
| [../trust-gaps-todo.md](../trust-gaps-todo.md) | **The open work, ranked.** Capture the thesis→execution→management→result chain; make the money path testable without a broker; what still needs live verification |
| [single-instance.md](./single-instance.md) | **The deployment constraint: this backend runs as ONE process.** Which loops claim through Mongo and which rely on being alone; what a second instance breaks, worst first; what it would take to scale out |

## Quick orientation

```
External APIs
  GNews      → news.service (per-symbol news for the monitor's news evaluator)
  Massive    → massive.provider → priceService → ohlcv.service (monitoring)
  Anthropic  → monitor.claude (Haiku) / services/agents/*.agent.service (Sonnet/Opus)
  cTrader    → ctrader.{provider,ws.provider,session.provider} → CTraderAdapter → broker.service   (live trading)
  IBKR       → ibkr.gateway.provider (IB Gateway socket) → IBKRAdapter → broker.service            (data-only)
  paper      → paperExecution/paperBroker (live-price sim) → PaperAdapter → broker.service

Internal services
  services/agents/*   SSE chat → a structured call / setup / plan / scan (see building.md)
  newsService         per-symbol news, on-demand (1h cache)
  priceService        OHLCV cache-first with incremental sync
  brokerService       multi-broker orchestration via capability flags
  executionGate       the market-hours gate — off-hours decisions queue (off-hours-queue.md)
  executionReconciler executionBus → entity status + native exit-order lifecycle

Real-time channels
  SSE                 the desks' chat streams (one per agent) + the market-brief delivery
  WebSocket           social chat; cTrader ProtoOA transport; execution feed → executionBus

Storage
  MongoDB             users, ideas, kairos_calls, coverage, tilt, pending_actions, threads,
                      brokerConnections, paperAccounts/Positions/Orders/Equity, trades
  File cache (.cache) news articles, OHLCV candles
```
