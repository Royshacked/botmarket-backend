# Code Map

Where things live and how they're named. For the runtime architecture + app-flow
diagrams see [README.md](README.md); for behavioral contracts see [APP_SPEC.md](APP_SPEC.md).

## Layers

```
HTTP (api/*)  →  services/  →  providers/            request path
monitoring/   →  services/  →  providers/            background path (poll + reconcile)
```

- **api/** — the HTTP surface. One folder per feature, each with up to three files:
  `<feature>.routes.js` (Express router) · `<feature>.controller.js` (request handlers) ·
  `<feature>.service.js` (DB + business logic). Controllers stay thin; logic lives in services.
- **services/** — business logic, the LLM agents, and cross-cutting utilities. No Express here.
- **providers/** — thin clients for external systems (LLMs, market data, brokers, Mongo).
  This is the only layer that talks to the outside world.
- **monitoring/** — background workers started in `server.js` (poll loop, reconciler, paper engines).

## Directory map

```
server.js                 app wiring, route mounts, background-service boot
api/
  idea/                   Trade Agent SSE chat        POST /api/idea/stream
  trade-ideas/            idea CRUD + order placement /api/trade-ideas/*
    tradeIdeas.service.js     save/get/update/delete, broker forking
    ideaExecution.service.js  placeOrdersForIdea / placeRestingEntryForIdea / triggerEntryNow ("Buy now")
    exitOrders.service.js     in-position exit (re)arming
  portfolio/              Portfolio Agent + review    /api/portfolio/*
  scanner/                Scanner Agent + saved scans /api/scanner/*
  broker/                 broker connections/orders/positions  /api/broker/*
    adapters/
      broker.interface.js     BrokerAdapter base class — THE contract every broker fulfils
      ctrader.adapter.js      + ctrader.execution.js (ProtoOA→BrokerExecution translator)
      paper.adapter.js        virtual venue
      ibkr.adapter.js         data-only, in progress — see APP_SPEC / do not extend casually
      normalize.js
    broker.factory.js         getBrokerAdapter(type); SUPPORTED_BROKERS registry
    broker.service.js         broker-agnostic entry point used everywhere
    paperBroker.service.js / paperExecution.service.js
  paper/                  paper mode toggle/settings/reset/trades/equity  /api/paper/*
  chat/                   social DM + bot notifications (chatWs.js = WebSocket)
  news-feed/ market/ calendar/ user/ authentication/ transcribe/
  _shared/                cross-controller helpers:
      sse.util.js             startSseStream() — SSE headers + heartbeat + abort wiring
      parse.util.js           parseChatMessages / parseIdeaAccounts
      chatState.util.js       makeGetChatState / makeDeleteChatState factories
services/
  idea.agent.service.js   + idea.stateParser.js (response/state machine)
  portfolio.agent.service.js  scanner.agent.service.js
  agentUtils.js           shared tool handlers, makePromptLoader, makeToolHandler,
                          formatMoney/buildAccountLines, stripEmitTags, runtime glue
  llmStream.util.js       createTagSuppressor({ onToken, captures })
  modelRouter.service.js  resolveModel(); REASONING_EFFORT enum
  conditionTree.service.js  resolve/collect/normalize condition trees
  orderPlan.service.js  protectionPlan.service.js  priceCandleSpec.service.js
  price.service.js  market.service.js  timeframe.service.js  brokerSymbol.service.js
  format.util.js  http.util.js  ttlCache.util.js  priceStats.util.js  cycleAnalysis.service.js
  logger.service.js  tokenUsage.service.js
  tradeCapture.service.js   append-only `trades` history (captureOpen / captureOpenBare / captureClose)
  thread.service.js  thread.util.js   unified subject-bound conversation threads
                          (`threads` collection). A conversation gets a threadId at the
                          start (subject-independent), is saved as a `draft` once it crosses
                          the agent's substantive floor (thread.util.isSubstantive over the
                          agent's emitted phase — NOT content), TTL-expired + LRU-capped, and
                          is `linked` to its artifact (idea/portfolio/scan) on generate.
                          Generalizes portfolio_chats; migrating agents off per-agent chat-state.
providers/
  anthropic.provider.js  openai.provider.js            LLMs
  yahoofinance / massive / finnhub / fmp / fred / sec / gnews / binance / chartImg / ohlcv
  ctrader.provider.js  ctrader.session.provider.js  ctrader.ws.provider.js
  ibkr.provider.js (retired) / ibkr.gateway.provider.js
  mongodb.provider.js       getDb(), stripId/stripIds
monitoring/
  monitor.service.js        the 60s poll loop; preflightEntry (arm-time already-satisfied check)
  monitor.orchestrator.js   evaluateTree / evaluateConditions → _evalOne (opts: stateLevel, requireHeld)
  evaluators/               touch · structured · indicator · time · volume · news · chart
  execution.reconciler.js   broker-authoritative fill/close → idea status
  invalidation.monitor.js   entry-range watcher (advisory, never executes)
  positionMonitor.js  portfolio.monitor.js
  paperFill.service.js  paperEquity.service.js
  exitOrders.util.js        buildExitOrder / exitOrderRecord / closeSide / orderSymbol
  monitorUtils.js           candleMs, parseYesNo, round, remainingForAccount, timeframe resolvers
  parsers/                  condition.parser.js, indicators.parser.js
tests/
  unit/                     node:test unit tests — run by `npm test`
  test.*.js                 MANUAL harnesses (hit live broker/DB) — NOT run by npm test
scripts/                    free-port, migrations, seeds
docs/                       architecture design docs
```

## Naming conventions

- **Feature modules:** `<feature>.routes.js` / `.controller.js` / `.service.js`. Routers apply
  `requireAuth` + `log` middleware. (Exceptions: `news-feed` list/stream and `transcribe`… see APP_SPEC.)
- **Providers:** `<name>.provider.js`; export bare named functions. A few also export a
  `<name>Service` namespace object.
- **Broker adapters:** `<broker>.adapter.js`, a class extending `BrokerAdapter`; register in
  `broker.factory.js`.
- **Evaluators:** `<type>.evaluator.js`, export `evaluate<Type>` / `evaluate`.
- **Private helpers:** `_camelCase`. **Log tags:** `const LOG = '[feature]'`, used as `logger.x(LOG, …)`.
- **User id:** `req.user._id` (and `user._id`) is the custom string id equal to `idea.userId` —
  NOT the Mongo `_id`. Strip Mongo `_id` from responses via `stripId` (providers/mongodb.provider.js).
- **Consumers branch on capabilities/flags, never on broker name** (only exception: the paper/live
  `mode` tag in tradeCapture).

## Where to add things

| Task | Touch |
|------|-------|
| New HTTP endpoint | `<feature>.routes.js` + handler in controller + logic in service |
| New SSE stream | `startSseStream()` from `api/_shared/sse.util.js` |
| New agent tool | schema + handler; put shared ones in `agentUtils` (`COMMON_TOOL_HANDLERS`, `makeToolHandler`) |
| New broker | `providers/<b>.provider.js` + `adapters/<b>.adapter.js` (extend `BrokerAdapter`) + one line in `broker.factory.js`; add aliases in `brokerSymbol.service.js` only if it renames instruments |
| New evaluator / leaf type | `evaluators/<type>.evaluator.js` + wire into `monitor.orchestrator._evalOne` + `condition.parser` |
| New pure utility | add a `tests/unit/<name>.test.js` (that's the "write tests after a feature" rule in practice) |

## Testing

- `npm test` → `node --test "tests/unit/*.test.js"` (Node's built-in runner, zero deps).
- Only files under `tests/unit/` matching `*.test.js` run. The `tests/*.js` manual harnesses are
  hand-run probes that connect to live broker/Mongo — they are deliberately excluded.
- Favor unit tests on **pure** functions (utils, parsers, builders). Modules that hit Mongo/providers
  aren't unit-tested here; verify those via the import-smoke pattern or a running stack.
