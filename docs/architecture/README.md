# Architecture Documentation

| Document | What it covers |
|---|---|
| [building.md](./building.md) | Chat → armed trade idea: SSE agents (Trade/Portfolio/Scanner), XML emit blocks, condition trees, persistence, arming |
| [monitoring.md](./monitoring.md) | Background monitoring service; AND/OR condition logic; the 7 leaf evaluators (structured/touch/indicator/chart/news/time/volume) + VWAP + intrabar mechanics; Claude Haiku usage |
| [broker.md](./broker.md) | Multi-broker adapter pattern + capability flags; cTrader live trading (ProtoOA WS), paper broker, IBKR (IB Gateway, data-only); execution reconciler; OAuth / gateway connections |
| [paper-trading-simulation.md](./paper-trading-simulation.md) | Virtual per-user account; live-price fill engine; equity snapshots; the `paper` broker adapter |
| [trades-data.md](./trades-data.md) | The canonical trade entity: the `trades` ledger schema, origin model (idea/call/portfolio), stored-vs-derived metrics, capture path, and gaps to close |
| [news-feed.md](./news-feed.md) | Two news pipelines: SSE display feed + per-symbol monitoring feed; GNews provider; AI sentiment filter |
| [ohlcv-price-data.md](./ohlcv-price-data.md) | OHLCV pipeline; Massive/Polygon provider; file cache; priceService; monitoring adapter |

## Quick orientation

```
External APIs
  GNews      → news.service / newsFeedService
  Massive    → massive.provider → priceService → ohlcv.provider (monitoring)
  Anthropic  → monitor.claude (Haiku) / {trade,portfolio,scanner}.agent.service (Sonnet/Opus)
  cTrader    → ctrader.{provider,ws.provider,session.provider} → CTraderAdapter → broker.service   (live trading)
  IBKR       → ibkr.gateway.provider (IB Gateway socket) → IBKRAdapter → broker.service            (data-only)
  paper      → paperExecution/paperBroker (live-price sim) → PaperAdapter → broker.service

Internal services
  {trade,portfolio,scanner}.agent.service   SSE chat → structured idea/plan/scan (see building.md)
  newsService         per-symbol news, on-demand (1h cache)
  newsFeedService     broadcast feed, SSE push (30min poll)
  priceService        OHLCV cache-first with incremental sync
  minosService        background 60s loop, evaluates active ideas (7 leaf types)
  brokerService       multi-broker orchestration via capability flags
  executionReconciler executionBus → idea status + native exit-order lifecycle

Real-time channels
  SSE                 agent chat streams (Trade/Portfolio/Scanner) + news feed
  WebSocket           social chat; cTrader ProtoOA transport; execution feed → executionBus

Storage
  MongoDB             users, ideas, brokerConnections, paperAccounts/Positions/Orders/Equity
  File cache (.cache) news articles, OHLCV candles
```
