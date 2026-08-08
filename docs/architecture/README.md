# Architecture

The mechanism docs — how the machinery is built. **The index for all documentation, including this
folder, is [../README.md](../README.md)**; it is kept in one place so the two cannot disagree about
what exists.

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
