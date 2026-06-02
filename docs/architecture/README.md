# Architecture Documentation

| Document | What it covers |
|---|---|
| [news-feed.md](./news-feed.md) | Two news pipelines: SSE display feed + per-symbol monitoring feed; GNews provider; AI sentiment filter |
| [monitoring.md](./monitoring.md) | Background monitoring service; AND/OR condition logic; structured / visual / news evaluators; Claude Haiku usage |
| [broker.md](./broker.md) | Multi-broker adapter pattern; OAuth flow; per-user token storage; cTrader + IBKR implementations |
| [ohlcv-price-data.md](./ohlcv-price-data.md) | OHLCV pipeline; Massive/Polygon provider; file cache; priceService; monitoring adapter |

## Quick orientation

```
External APIs
  GNews      → news.service / newsFeedService
  Massive    → massive.provider → priceService → ohlcv.provider (monitoring)
  Anthropic  → monitor.claude (Haiku) / trade.agent.service (Sonnet)
  cTrader    → ctrader.provider → CTraderAdapter → broker.service
  IBKR       → ibkr.provider   → IBKRAdapter    → broker.service

Internal services
  newsService         per-symbol news, on-demand (1h cache)
  newsFeedService     broadcast feed, SSE push (30min poll)
  priceService        OHLCV cache-first with incremental sync
  monitorService      background loop, evaluates active ideas every N min
  brokerService       multi-broker orchestration, per-user OAuth tokens

Storage
  MongoDB             users, ideas, brokerConnections
  File cache (.cache) news articles, OHLCV candles
```
