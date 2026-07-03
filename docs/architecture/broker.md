# Broker Integration Architecture

## Overview

The broker system uses the **Adapter Pattern** — a broker abstraction layer where all
consumer code talks to one common interface and every broker-specific detail is isolated
inside an adapter. Adding a new broker = one provider (transport) + one adapter, register
it in the factory, done. Nothing in the routes, services, monitor, or reconciler changes.

Three brokers are live today:

| Broker | Transport | Trading | OHLCV | Notes |
|---|---|---|---|---|
| **cTrader** | ProtoOA JSON-over-WebSocket | ✅ full (place/close/cancel/amend + native SL/TP) | ❌ (falls back to Massive/Polygon) | Live-verified. Hedging accounts → exits are `positionId` closing orders |
| **paper** | none — fills against the live price feed | ✅ full | ❌ | Virtual per-user account; reuses the live engine end-to-end |
| **IBKR** | TWS API socket via IB Gateway (`@stoqey/ib`) | ❌ (data-only, Phase 4) | ✅ over the socket | Connection = `host/port/clientId`, **not** OAuth |

```
Routes / Services / Monitor / Reconciler
                │
                ▼
        [BrokerAdapter interface]   ← capabilities() gates every consumer branch
   read:   getAccount getPositions getCandles getTradingAccounts getSpot findOpenPosition
   trade:  placeOrder closePosition setProtection cancelOrder amendOrder listOrders
   feed:   startExecutionFeed → executionBus
                │            │            │
                ▼            ▼            ▼
        [CTraderAdapter] [PaperAdapter] [IBKRAdapter]  [FutureAdapter…]
                │            │            │
                ▼            ▼            ▼
   ctrader.provider    paperExecution   ibkr.gateway.provider
   ctrader.ws.provider paperBroker      (@stoqey/ib socket → IB Gateway/TWS)
   ctrader.session.provider
                │            │            │
                ▼            ▼            ▼
   MongoDB brokerConnections │       (host/port/clientId, no tokens)
   (per-user OAuth tokens)   paperAccounts/paperPositions/paperOrders/paperEquity
```

> **Directory note:** adapters and services live under `api/broker/` and
> `api/broker/adapters/`, but the **transport providers live at the repo root
> `providers/`** — not `api/broker/providers/`.

---

## Capabilities — consumers branch on flags, never on broker name

`adapter.capabilities()` returns a static `BrokerCapabilities` object. Every consumer
(monitor, reconciler, routes, frontend) decides what it can do by reading these flags, so
no code path ever hardcodes `if (broker === 'ctrader')`. Exposed at
`GET /api/broker/:type/capabilities`.

| Flag | cTrader | IBKR | paper |
|---|---|---|---|
| `trading` | ✅ | ❌ | ✅ |
| `nativeProtection` (broker attaches SL/TP itself) | ✅ | ❌ | ❌ |
| `modifyProtection` | ✅ | ❌ | ❌ |
| `closePosition` | ✅ | ❌ | ✅ |
| `cancelOrder` | ✅ | ❌ | ✅ |
| `listOrders` | ✅ | ❌ | ✅ |
| `amendOrder` | ✅ | ❌ | ✅ |
| `ohlcv` | ❌ | ✅ | ❌ |

- cTrader: `ctrader.adapter.js` (`capabilities()`)
- IBKR: `ibkr.adapter.js` — all trading flags `false` ("Phase 4"); `ohlcv:true` only
- Paper: `paper.adapter.js` — `nativeProtection:false` on purpose, so exits rest as
  `positionId` closing orders exactly like the live design

> **Why `nativeProtection` matters:** brokers that can attach a stop/TP to the order
> ticket (cTrader) get their protection sent inline with `placeOrder`. Brokers that can't
> (paper, and cTrader's own multi-level exits) get their exits placed as separate
> **closing orders** tied to the `positionId` — see the reconciler below.

---

## Adapter interface — `api/broker/adapters/broker.interface.js`

Base class `BrokerAdapter`. Instance fields: `brokerType`, `brokerLabel`, `provider`.
Shared concrete helper `_freshTokens(userId)` refreshes tokens within 60s of expiry (OAuth
brokers only). Everything else throws "not implemented" until an adapter overrides it.

**Read / connection**

| Method | Returns | Notes |
|---|---|---|
| `getAuthUrl(state)` | `string` | OAuth consent URL (throws for gateway brokers) |
| `handleCallback(code, userId)` | `Promise<void>` | Exchange OAuth code, persist tokens |
| `isConnected(userId)` | `Promise<boolean>` | Has a valid/refreshable connection |
| `getAccount(userId)` | `Promise<BrokerAccount>` | Normalized account summary |
| `getPositions(userId)` | `Promise<BrokerPosition[]>` | Open positions across all accounts |
| `getTradingAccounts(userId)` | `Promise<TradingAccount[]>` | All accounts for the broker |
| `getCandles(symbol, tf, count, userId)` | `Promise<OHLCVBar[]\|null>` | `null` = unsupported (default) |
| `getSpot(userId, accountId, symbol)` | `Promise<number\|null>` | Live spot for basis-shift (default `null`) |
| `capabilities()` | `BrokerCapabilities` | Default = all false |

**Trading**

| Method | Returns | Notes |
|---|---|---|
| `placeOrder(userId, accountId, order)` | `{orderId, positionId?, accountId}` | Market/limit/stop + optional native SL/TP. `order.positionId` set ⇒ this is a **closing order** |
| `setProtection(userId, accountId, positionId, protection)` | `Promise` | Set/amend SL/TP on an open position |
| `closePosition(userId, accountId, positionId, opts)` | `Promise` | Full or partial close |
| `cancelOrder(userId, accountId, orderId)` | `Promise` | Cancel a working order |
| `amendOrder(userId, accountId, orderId, fields)` | may return a **new** orderId | Change a working order's price |
| `listOrders(userId, accountId)` | `BrokerOrder[]` | Working (pending) orders |

**Position truth & execution feed**

| Method | Returns | Notes |
|---|---|---|
| `findOpenPosition(userId, accountId, positionId)` | object \| `null` \| `undefined` | **Three-state, authoritative.** object = open, `null` = gone, `undefined` = can't check. Implementers MUST **throw** on transport error (never silently return `null`) |
| `startExecutionFeed(userId, accountId)` | `Promise<boolean>` | Stream execution events onto `executionBus`; default `false` |

Key typedefs to know:

- **`BrokerOrder`** — includes `referencePrice` / `referenceQuote` (canonical prices for
  basis-shift on aliased instruments), `clientOrderId`, and **`positionId`** (presence ⇒
  the order only reduces/closes that position, never opens an opposite one — the hedging
  requirement).
- **`BrokerCapabilities`** — the 8 flags above.
- **`BrokerExecution`** — normalized execution event union; notably distinguishes
  `position.reduced` (partial fill) from `position.closed` (full close).

---

## Normalized data shapes

### BrokerAccount
```js
{ id, login, broker, currency,
  balance, equity, margin, freeMargin,
  marginLevel,  // percentage; null for IBKR
  leverage }
```

### BrokerPosition
```js
{ id, symbol, direction: 'long'|'short',
  volume, entryPrice, currentPrice, pnl,
  pnlPips,   // null for IBKR
  swap,      // null for IBKR
  openedAt,  // unix ms; null for IBKR
  accountId, accountNo, currency }  // tagged so multi-account ideas resolve
```

### OHLCVBar
```js
{ t, o, h, l, c, v }   // t = unix ms
```

### TradingAccount
```js
{ id, login, currency, balance, broker, isLive }
```

`normalize.js` provides three tiny coercers used across adapters: `asList(raw)` (bare
array or `{data:[]}` → array), `num(v)` (finite number or null), `money(v)` (integer cents
÷100 or null — cTrader money fields arrive as cents).

---

## cTrader — live trading over ProtoOA WebSocket

cTrader trading is fully live: place/close/cancel/amend, native SL/TP, hedging-safe
closing orders, and an execution feed. **Only OHLCV is unsupported** on cTrader
(`getCandles()` returns `null`, `ohlcv:false`) — candles come from Massive/Polygon
instead. The implementation is split across four layers:

```
ctrader.provider.js          STATELESS REST + OAuth
  getAuthUrl / exchangeCode / refreshTokens   (token host openapi.ctrader.com)
  get('/tradingaccounts', tokens)             (REST base api.spotware.com/connect)
        │  used for OAuth + account/trading-account summaries
        ▼
ctrader.ws.provider.js       STATEFUL transport — CTraderSocket (one per environment)
  wss://{demo|live}.ctraderapi.com:5036, Node global WebSocket (no dependency)
  app-auth 2100→2101, heartbeat 51 (10s), reconnect w/ backoff (1s→30s),
  request/response correlation by clientMsgId, ready-gate
  emits: authenticated, execution (2126), spot (2131), push
        ▼
ctrader.session.provider.js  CTraderSession — account-scoped view over the shared socket
  account-auth 2102, symbol resolve (2114 light → id, 2116 full specs),
  spot snapshot (subscribe 2127 / unsubscribe 2129, ticks ÷1e5),
  reconcile 2124 → getOpenPositions()/getWorkingOrders(), unrealized P&L 2187,
  account list 2149.  Exports: normalizeVolume, lotsToVolume, roundPrice, priceToRelative
        ▼
ctrader.adapter.js           orchestration (implements BrokerAdapter)
ctrader.execution.js         pure ProtoOA(2126) → BrokerExecution translator
```

**payloadType constants** (the off-by-one trap — get these exactly right):

| Constant | payloadType | Layer |
|---|---|---|
| `HEARTBEAT` | 51 | ws |
| `APP_AUTH` | 2100 → 2101 | ws |
| `ACCOUNT_AUTH` | 2102 | session |
| `NEW_ORDER` | 2106 | adapter |
| `CANCEL_ORDER` | **2108** | adapter |
| `AMEND_ORDER` | **2109** | adapter |
| `AMEND_SLTP` | 2110 | adapter |
| `CLOSE_POSITION` | 2111 | adapter |
| `RECONCILE` | 2124 | session |
| `EXECUTION_EVENT` | 2126 | ws |
| `SPOT_EVENT` | 2131 | ws |

### How orders, protection, and hedging work

- **`placeOrder`** — resolves symbol specs, converts lots → native volume
  (`lotsToVolume` + `normalizeVolume`), applies a **basis offset** (broker spot mid −
  canonical `referenceQuote`) to absolute limit/stop prices for aliased instruments
  (e.g. broker `US100` vs canonical `NQ`). Native SL/TP are sent as **relative distance**
  (`relativeStopLoss` / `relativeTakeProfit`, in 1/100000 of price) derived from the
  canonical reference price, so they are basis-immune (not shifted). If `order.positionId`
  is set, `payload.positionId` makes it a **closing order** — reduces/closes only, never
  opens an opposite position (mandatory on HEDGING accounts). Sends `NEW_ORDER (2106)`.
- **`setProtection`** — absolute SL/TP via `AMEND_SLTP (2110)`, with optional basis shift.
- **`closePosition`** — full close needs the volume, so it reconciles (`2124`) first, then
  **cancels the position's resting closing orders** (matched by `positionId`) *before*
  closing (avoids orphaned exits / races), then `CLOSE_POSITION (2111)`, then emits its own
  normalized `position.closed` on the bus (deterministic; the broker's own event is
  idempotent). Partial close skips the pre-cancel.
- **`amendOrder`** — cTrader amends by **cancel-then-place**: cancel the old order, place an
  equivalent at the new price, return the **new** orderId.
- **`getPositions`** — reconciles **every** trading account on the connection (an idea can
  span multiple accounts) and tags each position with `accountId`/`accountNo`/`currency`.
- **`findOpenPosition`** — reconcile-based; returns `null` when gone, **throws** on
  transport error.
- **Execution feed** (`_wireExecutionFeed`) — idempotent per `env:ctid` via a module-level
  `_wiredFeeds` set; bridges session `execution` events through `ctrader.execution.toExecution`
  onto the shared `executionBus`.

---

## Paper — venueless broker on the live price feed

The paper broker fills against the **live price feed** with a virtual per-user account
(one account, id `paper-{userId}`). It trades **canonical symbols directly** (no CFD
aliasing / basis shift). Capabilities: `trading`/`closePosition`/`cancelOrder`/`listOrders`/
`amendOrder` true, `nativeProtection:false`.

```
paper.adapter.js
  placeOrder:
    market → fills instantly at latestPrice
        openPosition, or reducePosition if order.positionId set (closing order)
    limit/stop (resting entries + positionId exits)
        stored 'working' → filled by the global paper fill engine (paperFill.service)
        which fires when a candle high/low touches the level
  findOpenPosition → position or null (never throws on not-found)
  startExecutionFeed → true (fill loop is global, not per-account)
        │  delegates all position mutation to ↓
        ▼
paperExecution.service.js   shared engine
  openPosition / reducePosition / computeEquity / latestPrice / latestMarkPrice
  applySpread (spread crossing), quote cache, banks realized P&L,
  and EMITS THE SAME normalized execution events the reconciler consumes
        │  so paper drives the identical monitor + reconciler path as a live broker
        ▼
paperBroker.service.js   store
  collections: paperAccounts, paperPositions, paperOrders, paperEquity
  account defaults: startingBalance 100_000, spreadBps 2, commissionPerTrade 0, enabled false
```

Because `paperExecution` emits the same `BrokerExecution` events as cTrader, the reconciler,
monitor, exit placement, and status lifecycle are **identical** for paper and live — paper
is not a special case anywhere downstream. Paper has **no** `brokerConnections` document; its
"connected" state is `paperBrokerService.isEnabled`.

---

## IBKR — TWS API socket via IB Gateway (data-only today)

The active IBKR adapter talks to **IB Gateway / TWS over the TWS API socket** using
`@stoqey/ib` — **not** the Client Portal Web API, and **not** OAuth.

```
ibkr.gateway.provider.js   IBKRGateway (EventEmitter) over @stoqey/ib IBApi socket
  one socket per host:port:clientId; ready = first nextValidId (seeds order-id sequence)
  MarketDataType.DELAYED (paper accounts lack live data), reconnect w/ backoff
  reqAccountSummary / reqContractDetails / reqPositions / reqHistoricalBars / reqPnlSingle
  re-emits execDetails, commissionReport, orderStatus, openOrder, position  (for a future feed)
        ▼
ibkr.adapter.js
  connection: { host, port, clientId } — NO OAuth/tokens (getAuthUrl throws)
    defaults 127.0.0.1:4002 clientId 1;  paper vs live by port (PAPER_PORTS {4002,7497})
  LIVE:    getAccount, getTradingAccounts, getPositions (w/ contract qualification + PnL),
           getCandles → reqHistoricalBars (ohlcv:true)
  _qualify: futures → front-month, equities → SMART US;
           IBKR_CONTRACTS maps NQ/ES/RTY/YM/CL/GC → real futures (the CFD-vs-real seam,
           no price offset — a real future, not a CFD)
  STUBBED (Phase 4): placeOrder, closePosition, cancelOrder, listOrders, amendOrder,
           setProtection, execution feed — all trading capability flags false
```

> **Dead code:** `providers/ibkr.provider.js` (the old Client Portal REST/OAuth provider —
> `getAuthUrl`/`exchangeCode`/`refreshTokens`/`resolveConid`/`getHistoricalBars` against
> `api.ibkr.com/v1/api`) still exists but is **no longer imported by the adapter** — it was
> superseded by the gateway transport. Ignore it when reasoning about IBKR.

---

## Execution reconciler — broker-authoritative status + exit lifecycle

`monitoring/execution.reconciler.js` (started via `executionReconciler.start()` in
`server.js`) is a single broker-agnostic listener on the shared `executionBus`. It turns
normalized execution events into idea-status updates **and** owns the lifecycle of an
idea's native exit orders. Because every broker (cTrader, paper) emits the same
`BrokerExecution` shape, this file has zero broker-specific branches.

```
executionBus
   │
   ├── _onOpened   → backfill broker positionId onto idea.brokerOrders linkage
   │                 (resting stop-entry → long/short, inline-linked, unlinked-slot cases)
   │                 then placeExits()
   │
   ├── placeExits  → place native exit orders scaled to the account's filled qty:
   │                 LIMIT for tp, STOP for stop, opposite side, tied to positionId
   │                 (= closing orders). Idempotent per account (exitPlacedAccounts)
   │
   ├── _onReduced  → partial exit fill: mark the matched slice filled, then ASK THE BROKER
   │                 (findOpenPosition) whether the position survived:
   │                   null   → finalize close
   │                   open   → _resyncExits shrinks/cancels working exits exceeding
   │                            live remaining size (netting safety)
   │                   throw  → defer (transport can't confirm)
   │
   └── _onClosed   → idea → 'closed' (+reason/pnl/closedAt), then _cancelExitsForPosition
                     lists the account's working orders and CANCELS EVERY ONE matching
                     positionId (tracked exits + panel-added), so no resting opposite
                     order can open a fresh position
```

Linkage stored on the idea:
```js
brokerOrders: [{ broker, accountId, orderId, positionId, quantity }]
exitOrders:   [{ accountId, broker, leg, type, price, quantity, orderId, status }]
```
A per-`(account, position)` promise-chain lock (`_withLock`) serializes exit-array
mutations. `_resumeFeeds` restarts execution feeds for active/resting ideas after a server
restart. Helpers come from `monitoring/exitOrders.util.js` (`buildExitOrder`,
`exitOrderRecord`) and `monitoring/monitorUtils.js` (`round`, `remainingForAccount`).

> This is the "broker-authoritative" design: on a partial/close the reconciler asks the
> broker whether the position actually survived rather than trusting local state, and a
> close cancels **all** broker orders for that `positionId` — including exits added later
> via the edit-orders panel — so no orphaned stop and no idea stuck `long` after the TP was
> managed manually.

---

## Multi-tenancy & the `brokerConnections` collection

This is a **SaaS** — different users connect different brokers; tokens/coords are stored
per-user in MongoDB, never in-memory. One user can have several connections at once
(e.g. cTrader + IBKR). The collection holds **two variants** that share it
(`brokerConnection.service.js`):

**OAuth brokers (cTrader)** — `saveConnection`:
```js
{ userId, brokerType, accessToken, refreshToken,
  expiresAt,    // unix ms
  connectedAt,  // unix ms
  accountId }   // added lazily by setAccountId
```

**Gateway brokers (IBKR)** — `saveGatewayConnection`:
```js
{ userId, brokerType, gateway: true,
  host, port, clientId,   // port/clientId are Numbers
  connectedAt }           // NO tokens
```

`listConnections` treats a doc as connected when it has a `refreshToken` **or** `gateway`.
Paper has no document — its state is `paperBrokerService.isEnabled`.

Methods: `getConnection`, `saveConnection`, `saveGatewayConnection`, `updateTokens`,
`getAccountId`, `setAccountId`, `listConnections`, `deleteConnection`.

---

## OAuth flow (OAuth brokers only)

The OAuth `state` parameter carries user identity across the redirect, so no session or
second cookie is needed. Gateway brokers (IBKR) skip this entirely — they connect with
`host/port/clientId` and never hit the OAuth routes.

```
Browser                              Server                      Broker
  │── GET /api/broker/connect/:type ──►│ (requireAuth reads cookie)
  │                                    │ JWT.sign({ userId, type }) = state
  │◄── 302 redirect ───────────────────│ adapter.getAuthUrl(state)
  │──────── GET {broker OAuth URL}&state=xxx ───────────────────►│
  │◄──────── 302 /api/broker/callback?code=xxx&state=xxx ─────────│
  │── GET /api/broker/callback ───────►│ JWT.verify(state) → { userId, brokerType }
  │                                    │ adapter.handleCallback(code, userId)
  │                                    │   → exchangeCode → tokens → saveConnection
  │◄── 302 /?broker=connected&type=x ──│
```

The `state` JWT expires in 10 minutes — CSRF protection. The callback route is the only
unauthenticated broker route; identity comes from `state`.

---

## Routes — `api/broker/broker.routes.js`

All require `requireAuth` (JWT cookie) except the callback.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/connect/:type` | ✅ | Redirect to OAuth consent |
| `GET` | `/callback` | ❌ (JWT `state`) | OAuth callback (all brokers) |
| `GET` | `/connections` | ✅ | Map of broker → connected |
| `DELETE` | `/connections/:type` | ✅ | Disconnect a broker |
| `GET` | `/:type/trading-accounts` | ✅ | Accounts + selectedAccountId |
| `PATCH` | `/connections/:type/account` | ✅ | Set selected trading account |
| `GET` | `/:type/capabilities` | ✅ | Static capability flags |
| `GET` | `/:type/account` | ✅ | Account summary |
| `GET` | `/:type/positions` | ✅ | Open positions (enriched w/ assetClass) |
| `GET` | `/:type/orders` | ✅ | List working orders |
| `POST` | `/:type/orders` | ✅ | Place working order (`positionId` ⇒ closing order) |
| `PATCH` | `/:type/orders/:orderId` | ✅ | Amend working order price (may return new id) |
| `DELETE` | `/:type/orders/:orderId` | ✅ | Cancel working order |
| `DELETE` | `/:type/positions/:positionId` | ✅ | Close position (accountId via query) |

`setProtection` and `startExecutionFeed` exist in `broker.service.js` but have **no HTTP
route** — they're used internally by the reconciler and monitor.

---

## Factory & service

`api/broker/broker.factory.js`
```js
const ADAPTERS = { ctrader: CTraderAdapter, ibkr: IBKRAdapter, paper: PaperAdapter }
export const SUPPORTED_BROKERS = Object.keys(ADAPTERS)
export function getBrokerAdapter(type) { ... }   // fresh instance per call; throws 400 if unknown
```

`broker.service.js` is thin orchestration — every method resolves the adapter via the
factory and delegates, with no broker-specific logic. `listConnections` merges DB state and
injects `paper` from `paperBrokerService.isEnabled`. `findOpenPosition` returns `undefined`
when the adapter doesn't implement it.

---

## Adding a new broker

1. Create `providers/{name}.provider.js` — the transport (OAuth+REST, or a socket, or a
   gateway). Stateless where possible; accept credentials as arguments.
2. Create `api/broker/adapters/{name}.adapter.js` — extend `BrokerAdapter`, implement the
   methods you support, and **return honest `capabilities()` flags** (consumers gate on
   them). Persist connection state via `brokerConnectionService` (`saveConnection` for
   OAuth, `saveGatewayConnection` for a gateway).
3. Emit normalized `BrokerExecution` events onto `executionBus` from `startExecutionFeed`
   (or synthesize them like paper/cTrader) so the reconciler drives status + exits for free.
4. Register in `broker.factory.js`:
   ```js
   const ADAPTERS = { ctrader: CTraderAdapter, ibkr: IBKRAdapter, paper: PaperAdapter,
                      new: NewAdapter }   // ← add here
   ```
5. Add any env vars to `.env`.

**Nothing else changes** — routes, service, monitor, reconciler, and frontend pick it up
from the interface + capability flags.

---

## Files

```
providers/                         (repo root — transports)
  ctrader.provider.js              stateless OAuth + REST (tradingaccounts)
  ctrader.ws.provider.js           CTraderSocket — one WebSocket per environment
  ctrader.session.provider.js      CTraderSession — account-scoped view over the socket
  ibkr.gateway.provider.js         IBKRGateway — @stoqey/ib socket to IB Gateway/TWS
  ibkr.provider.js                 (dead) old Client Portal REST/OAuth — not imported

api/broker/
  adapters/
    broker.interface.js            BrokerAdapter base class + typedefs + capabilities()
    ctrader.adapter.js             cTrader orchestration (trading payloadTypes)
    ctrader.execution.js           ProtoOA 2126 → BrokerExecution translator + enums
    ibkr.adapter.js                IBKR (data-only; trading Phase 4)
    paper.adapter.js               virtual broker on the live feed
    normalize.js                   asList / num / money coercers
  broker.factory.js                registry + getBrokerAdapter(type)
  broker.service.js                orchestration (routes → factory → adapter)
  broker.routes.js                 Express routes (requireAuth)
  brokerConnection.service.js      per-user connection CRUD (OAuth + gateway variants)

paper engine
  paperExecution.service.js        shared fill/mutation engine, emits BrokerExecution
  paperBroker.service.js           store: paperAccounts/Positions/Orders/Equity
  paperFill.service.js             global fill loop (candle high/low touch)

reconciler
  monitoring/execution.reconciler.js   executionBus → idea status + exit lifecycle
  monitoring/exitOrders.util.js        buildExitOrder / exitOrderRecord
  monitoring/monitorUtils.js           round / remainingForAccount

src/services/broker/
  broker.service.remote.js         frontend: listConnections/getAccount/getPositions/…
```
