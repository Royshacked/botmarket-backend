# Paper Trading / Simulation Mode — Design & Plan

Status: **DESIGN (not built)** · Authored 2026-06-30

## Goal

Let a user run ideas and portfolios against **live prices with a simulated account**, producing
real results (equity curve, realized/unrealized P&L) without sending broker orders — and record
every trade (paper *and* live) into a durable, point-in-time history for later use (backtesting,
analytics, scanner/ML signal, funder reporting).

Two distinct concepts, only the first is in scope now:

- **Forward / paper simulation** (this doc): live feed, virtual account, reuses the live engine.
- **Historical backtest** (out of scope): replay archived prices; needs a data store + an explicit
  intrabar-fill + cost model. Deferred.

## Core decisions (confirmed)

| Decision | Choice |
|---|---|
| Account scope | **One simulated account per user** |
| Fill fidelity | **Mid-price, costs configurable** (spread + commission as account settings, default ON) |
| Trade capture | **Both live + sim**, differentiated by a `mode` field |
| Mode toggle | **Global per-user toggle** — while ON, new ideas route to the paper broker |
| First step | Write this plan before code |

## Key architectural insight

Paper trading is a **broker adapter, not a parallel engine.** Everything funnels through
`brokerService(brokerType, userId, accountId)` and the reconciler is **broker-authoritative**, so a
`'paper'` adapter that answers from a virtual store drives the existing monitor + reconciler
**unchanged**. Ideas already fork by broker, so a paper idea is just a fork with `broker: 'paper'`.

```
monitor.service (unchanged)  →  conditions fire  →  placeOrdersForIdea (unchanged)
        │                                                    │
        │                                         brokerService.placeOrder('paper', …)
        ▼                                                    ▼
   ohlcv.provider  ◄──── paper fill engine ────►  PaperBroker adapter
   (live prices)         (watches working orders)    │
        │                        │                    ▼
        └────────────────────────┴──►  executionBus.emit(position.opened/reduced/closed)
                                                       │
                                          execution.reconciler (UNCHANGED)
                                                       │
                                          stamps idea status long/short/closed
```

The only fork in the whole system is *which broker is bound to the user*. That is what keeps paper
results predictive of live: identical evaluation engine, identical reconciler, identical exit logic.

## Seam map (verified against current code)

- **Broker dispatch:** `api/broker/broker.service.js` — every method `(brokerType, userId, accountId, …)`
  routes via `getBrokerAdapter(brokerType)` (factory). Inject `'paper'` here.
- **Order placement:** `api/trade-ideas/ideaExecution.service.js:26` `placeOrdersForIdea` — single broker
  seam at `:49` `brokerService.placeOrder(...)`. Resting entry `:105`.
- **Reconciler (broker-authoritative):** `monitoring/execution.reconciler.js` — `handleExecution:66`
  dispatches `executionBus` events; `_onOpened:169`, `_onReduced:105` (authoritative
  `findOpenPosition:141`), `_finalizeClose:361`, `placeExits:243`. No changes needed.
- **Account interface:** `api/broker/adapters/broker.interface.js:15` `BrokerAccount`
  (`currency/balance/equity/margin`). Paper `getAccount` returns a synthetic one.
- **Price feed:** `providers/ohlcv.provider.js:26` `getCandles` (intraday forces live `refresh`).
  Reused by the paper fill engine.
- **Monitor poll:** `monitoring/monitor.service.js` — `_tick` every 60s over `looking/long/short`.
  Unchanged.
- **Per-user broker keying:** connections in `brokerConnections` (`api/broker/brokerConnection.service.js`).
  Paper needs no external connection — presence of the paper account is enough.
- **Portfolio state:** `services/portfolioState.service.js:54` matches live ideas to broker positions
  via `brokerService.getPositions` — works automatically once paper `getPositions` is implemented.

## Data model (new collections, no changes to `ideas` / `portfolio_chats`)

### `paperAccounts` (one per user)
```js
{
  userId, brokerType: 'paper', currency: 'USD',
  startingBalance,        // configured account size
  cashBalance,            // debited by margin + costs on entry; restored + realizedPnl on close
  realizedPnl,            // running sum of closed trades
  settings: {
    spreadBps,            // per asset_class; fill at mid ± spread/2   (default ON)
    commissionPerTrade,   // flat or per-unit                          (default ON)
  },
  createdAt, updatedAt
}
```
`getAccount('paper')` → synthetic `BrokerAccount`; **equity = cashBalance + Σ unrealized**
(open virtual positions marked to live `ohlcv` price).

### `paperPositions` / `paperOrders` (virtual broker state; must persist across restarts)
```js
// paperOrders
{ userId, accountId, orderId, positionId, symbol, direction, type:'market|stop|limit',
  qty, triggerPrice, status:'working|filled|cancelled', createdAt, filledAt, fillPrice }

// paperPositions
{ userId, accountId, positionId, symbol, direction, qty, avgPrice,
  openedAt, closedAt, status:'open|closed' }
```

### `trades` (append-only, point-in-time — the long-term asset; covers paper AND live)
```js
{
  tradeId, ideaId, userId, portfolioId,
  mode: 'paper' | 'live',             // differentiator
  broker, accountId, symbol, asset_class, direction,
  entry: { price, qty, ts, spreadApplied, commission },
  conditionsSnapshot,                  // entry conditions AS AUTHORED at fill
  indicatorSnapshot,                   // VWAP/ADX/etc at fill — prevents future lookahead bias
  reasoning,                           // agent thesis text
  accountSnapshot: { equity, cashBalance },
  exit: { price, qty, ts, reason, realizedPnl },  // patched on close
  status: 'open' | 'closed'
}
```
Freeze snapshots — never reference the mutable idea doc, or later edits corrupt history.

## The one genuinely new piece: the paper fill engine

Market orders fill instantly at observed price. **Working orders** (resting STOP entry; native
STOP/LIMIT exits the reconciler places) need a watcher — the job a real broker's execution feed does
intrabar. `PaperBroker.startExecutionFeed` registers the account with a fill loop that:

1. pulls latest price per symbol with open paper working orders (reuse `ohlcv.provider`, ~60s),
2. checks whether price crossed each order's trigger,
3. on fill: mutate `paperPositions` + `cashBalance`, then
   `executionBus.emit({ type:'position.opened|reduced|closed', positionId, … })`.

The reconciler then runs unmodified. Caveat: this inherits intrabar path ambiguity (stop & TP in the
same poll window) — minor in forward mode (frequent live polling), unlike historical replay.

## Trade capture: one hook, both modes

Because paper and live **both flow through the reconciler**, capture is a single hook:
- `_onOpened` / fill → insert `trades` record (`status:'open'`, `mode` from broker type)
- `_finalizeClose` → patch closed with `exit` + `realizedPnl`

This yields live capture for free (`mode:'live'`).

## Build phases

1. **`paperAccounts` + adapter skeleton** — `getAccount`/`getPositions`/`placeOrder` (market only),
   register `'paper'` in `broker.factory.js`. Place a paper idea end-to-end, see a position.
   **DONE 2026-06-30.** Files: `api/broker/paperBroker.service.js` (DB store for
   `paperAccounts`/`paperPositions`/`paperOrders`), `api/broker/adapters/paper.adapter.js`
   (market fills open/close instantly, emit `position.opened/reduced/closed` on `executionBus`;
   working limit/stop orders rest for Phase 2), factory registration. Cash moves only by realized
   P&L (equity = cashBalance + Σ unrealized). Import-chain verified; not yet live-routed (needs
   Phase 5 toggle to fork ideas onto `broker:'paper'`).
2. **Fill engine** — working-order watch loop → synthetic execution events. Resting entries + stops/TPs
   fire; reconciler closes them.
   **DONE 2026-06-30.** Files: `monitoring/paperFill.service.js` (global 30s sweep — env
   `PAPER_FILL_INTERVAL_MS` — over all users' `status:'working'` paper orders; one price lookup per
   symbol; `isTriggered(order,price)` rule: stop→long≥/short≤ trigger, limit→long≤/short≥, holds for
   entries AND closing exits since an exit carries the closing side), started in `server.js`. Position
   open/reduce extracted to `api/broker/paperExecution.service.js` (`openPosition`/`reducePosition`/
   `latestPrice`), shared by the adapter and the engine; events carry `orderId` so the reconciler
   matches resting-entry fills (`_onOpened`) and exit slices (`_onReduced`/`_onClosed`). Fills at the
   trigger price (slippage/gaps deferred to Phase 3). Trigger logic unit-tested 9/9; not yet live-routed.
   NOTE: end-to-end exits depend on `routeExits` populating `idea.nativeExit` for `broker:'paper'`
   (a Phase 5 routing detail) so `placeExits` rests the closing orders the engine then fills.
3. **Costs + equity curve** — spread/commission in fills; equity = cash + unrealized.
   **DONE 2026-06-30.** Costs applied in the shared primitives (`paperExecution.service.js`):
   `applySpread(price,isBuy,spreadBps)` crosses the spread (buy→ask, sell→bid) so the cost is baked
   into the position's effective entry/exit price; `commissionPerTrade` debited as cash per fill
   (entry + each exit slice). Identity holds: **equity = startingBalance + realizedPnl + unrealized**
   (verified: frictionless $100 → $95.90 net with 20bps both sides + $1/side). Equity value via new
   shared `computeEquity(userId)` (dedups the adapter's mark-to-market; `getAccount` now uses it).
   Equity **curve**: `paperEquity` collection + `monitoring/paperEquity.service.js` (5-min snapshot,
   env `PAPER_EQUITY_SNAPSHOT_MS`, only users with open positions; frontend holds last value across
   flat gaps), started in `server.js`. Store gained `listActiveUserIds`/`insertEquitySnapshot`/
   `listEquityCurve`. **Margin model (defined): cash-only, no leverage** — positions reserve no
   margin, `freeMargin == equity`; buying-power enforcement + per-asset_class contract sizing deferred.
4. **Trade capture** — reconciler hook + `trades` collection (covers live too).
   **DONE 2026-06-30.** `services/tradeCapture.service.js` (append-only `trades` collection, one doc
   per accountId+positionId, `mode:'paper'|'live'` from broker). Hooked in `execution.reconciler.js` —
   capture-on-OPEN at all three confirm points in `_onOpened` (resting-entry fill, the `linked` branch
   = market/immediate entries, the backfill branch; idempotent upsert via `$setOnInsert`), capture-on-
   CLOSE in `_finalizeClose` (added `price` param, passed `exec.price` from `_onClosed`/`_onReduced`).
   Verified cTrader emits `position.opened` (price+qty) and `position.closed` (price+pnl), so live
   captures identically. Each record freezes a point-in-time `snapshot` (entry/stop/tp condition trees
   + conditions + timeframes, invalidation, notes, conviction) + `accountSnapshot` (equity/cash via
   `brokerService.getAccount`, uniform both modes) — never a reference to the mutable idea. Capture is
   best-effort (never throws into the reconciler). `listTrades(userId,{mode,status,portfolioId})` read
   ready for Phase 5. No import cycle.
5. **Frontend + routing** — global paper toggle (profile), account-size config, equity/P&L readout,
   paper-vs-live badge, trade-history view.
   **DONE 2026-06-30** (both repos build green). **Routing:** `enabled` flag on the paper account
   (`paperBroker.service`: `setEnabled`/`isEnabled`); override at the top of `_partitionByBroker`
   (tradeIdeas.service) — paper mode ON → every new idea forks onto `broker:'paper'` /
   `accountId='paper-<userId>'`; `broker.service.listConnections` reports `paper` connected when
   enabled so `resolveUserAccounts`/order-plan builder resolve the paper account. `routeExits` is
   already broker-agnostic (touch→nativeExit), so paper exits rest + fill with no special handling.
   **Backend API:** `api/paper/paper.routes.js` (mounted `/api/paper`) — GET `/state`, PUT `/mode`,
   PUT `/settings`, POST `/reset`, GET `/trades`, GET `/equity-curve`. **Frontend:**
   `services/paper/paper.service.remote.js` client; `cmps/PaperTrading/PaperTradingSection.jsx` in
   UserProfile right column (toggle + starting-balance/spread/commission config + live
   equity/realized/unrealized/cash/open readout + recent-trades list + reset); paper-vs-live `PAPER`
   badge on `MonitorDashboard/IdeaCard.jsx` and `TradeIdeas/TradeIdeaCard.jsx` (branch on
   `idea.broker==='paper'` — no new idea field needed). Not yet live-verified end-to-end (toggle →
   place idea → fill → close → see results) — needs a running stack.

## Open questions / risks

- **Symbol/price basis:** paper fills use the same `ohlcv` symbol the idea is authored on; broker-symbol
  vs real-instrument basis (NQ↔US100) still applies — note it in results, don't silently mix.
- **Restart durability:** paper positions/orders must persist (hence collections, not in-memory).
- **Fill granularity:** 60s poll for working orders at MVP; revisit if results need finer touch fidelity.
- **Margin model:** how much `cashBalance` a position reserves (notional? leverage-adjusted?) — define in
  Phase 3.
