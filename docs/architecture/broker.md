# Broker Integration Architecture

## Overview

The broker system uses the **Adapter Pattern** — a classic broker abstraction layer.
All consumer code talks to a common interface; broker-specific logic is isolated in adapters.
Adding a new broker = one new provider file + one new adapter file. Nothing else changes.

```
Routes / Services
      │
      ▼
[BrokerAdapter interface]
  getAuthUrl()  handleCallback()  isConnected()
  getAccount()  getPositions()    getCandles()
      │                │
      ▼                ▼
[CTraderAdapter]  [IBKRAdapter]  [FutureAdapter...]
      │                │
      ▼                ▼
ctrader.provider  ibkr.provider
(Spotware REST)   (IBKR Client Portal API)
      │                │
      ▼                ▼
   MongoDB: brokerConnections (per-user tokens)
```

---

## Multi-tenancy

This is a **SaaS** — different users connect different brokers.
Tokens are stored per-user in MongoDB, not in-memory.

One user can have multiple active broker connections simultaneously (e.g., both cTrader and IBKR).

---

## MongoDB collection: `brokerConnections`

```js
{
  userId:       string,      // ref to users collection
  brokerType:   string,      // 'ctrader' | 'ibkr' | ...
  accessToken:  string,
  refreshToken: string,
  expiresAt:    number,      // unix ms — when access token expires
  accountId:    string|null, // cached after first API call
  connectedAt:  number,      // unix ms
}
```

One document per `(userId, brokerType)` pair — upserted on connect.

---

## OAuth flow

The OAuth `state` parameter carries user identity across the redirect, so no session or
second cookie is needed:

```
Browser                              Server                      Broker
  │                                    │                           │
  │── GET /api/broker/connect/:type ──►│ (requireAuth reads cookie)│
  │                                    │                           │
  │                                    │ JWT.sign({ userId, type }) = state
  │                                    │ adapter.getAuthUrl(state) │
  │◄── 302 redirect ───────────────────│                           │
  │                                                                │
  │─────────────── GET {broker OAuth URL}&state=xxx ─────────────►│
  │                                                                │
  │◄──────────── 302 /api/broker/callback?code=xxx&state=xxx ──────│
  │                                    │
  │── GET /api/broker/callback ───────►│
  │                                    │ JWT.verify(state) → { userId, brokerType }
  │                                    │ adapter.handleCallback(code, userId)
  │                                    │   └── exchangeCode(code) → tokens
  │                                    │   └── brokerConnectionService.saveConnection()
  │◄── 302 /?broker=connected&type=x ──│
```

The `state` JWT expires in 10 minutes — protects against CSRF.

---

## Routes

All data routes require auth (`requireAuth` middleware reads the JWT cookie).
The callback route is unauthenticated — user identity comes from `state`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/broker/connect/:type` | ✅ | Start OAuth for broker |
| `GET` | `/api/broker/callback` | ❌ | OAuth callback (all brokers) |
| `GET` | `/api/broker/connections` | ✅ | List user's connections |
| `DELETE` | `/api/broker/connections/:type` | ✅ | Disconnect a broker |
| `GET` | `/api/broker/:type/trading-accounts` | ✅ | List all trading accounts for broker |
| `PATCH` | `/api/broker/connections/:type/account` | ✅ | Select primary account |
| `GET` | `/api/broker/:type/account` | ✅ | Account summary (uses cached accountId) |
| `GET` | `/api/broker/:type/positions` | ✅ | Open positions |

---

## Adapter interface

`api/broker/adapters/broker.interface.js`

Every adapter must implement:

| Method | Returns | Notes |
|---|---|---|
| `getAuthUrl(state)` | `string` | OAuth authorization URL |
| `handleCallback(code, userId)` | `Promise<void>` | Exchange code, save tokens |
| `isConnected(userId)` | `Promise<boolean>` | Has a valid refresh token |
| `getAccount(userId)` | `Promise<BrokerAccount>` | Normalised account summary |
| `getPositions(userId)` | `Promise<BrokerPosition[]>` | Open positions |
| `getTradingAccounts(userId)` | `Promise<TradingAccount[]>` | All accounts for the broker |
| `getCandles(symbol, timeframe, count, userId)` | `Promise<OHLCVBar[] \| null>` | `null` = unsupported |

---

## Normalised data shapes

### BrokerAccount

```js
{
  id:          string,
  login:       string,
  broker:      string,
  currency:    string,
  balance:     number | null,
  equity:      number | null,
  margin:      number | null,
  freeMargin:  number | null,
  marginLevel: number | null,   // percentage; null for IBKR
  leverage:    number | null,
}
```

### BrokerPosition

```js
{
  id:           string,
  symbol:       string,
  direction:    'long' | 'short',
  volume:       number | null,
  entryPrice:   number | null,
  currentPrice: number | null,
  pnl:          number | null,
  pnlPips:      number | null,   // null for IBKR
  swap:         number | null,   // null for IBKR
  openedAt:     number | null,   // unix ms; null for IBKR
}
```

### OHLCVBar

```js
{ t: number, o: number, h: number, l: number, c: number, v: number }
// t = unix ms
```

### TradingAccount

```js
{
  id:       string,
  login:    string | null,
  currency: string | null,
  balance:  number | null,
  broker:   string | null,
  isLive:   boolean,
}
```

---

## Broker implementations

### cTrader (FTMO)

- **API:** Spotware REST (`https://api.spotware.com/connect`)
- **Auth:** OAuth 2.0 via `connect.spotware.com`
- **Registration:** https://openapi.ctrader.com/apps
- **OHLCV:** ❌ Not supported via REST (ProtoOA WebSocket only — future work)
- **Token refresh:** handled in `_freshTokens()`, new tokens saved to MongoDB

Required env vars:
```
CTRADER_CLIENTID=
CTRADER_SECRET=
CTRADER_REDIRECT_URI=http://localhost:3030/api/broker/callback
```

### IBKR (Interactive Brokers)

- **API:** IBKR Client Portal Web API (`https://api.ibkr.com/v1/api`)
- **Auth:** OAuth 2.0 via `www.interactivebrokers.com`
- **Registration:** https://www.interactivebrokers.com/en/trading/ib-api.php
- **OHLCV:** ✅ Supported — symbol resolved to `conid` (contract ID), then historical bars fetched
- **Token refresh:** handled in `_freshTokens()`, same pattern as cTrader

Required env vars:
```
IBKR_CLIENT_ID=
IBKR_CLIENT_SECRET=
IBKR_REDIRECT_URI=http://localhost:3030/api/broker/callback
```

**IBKR OHLCV timeframe mapping:**

| App timeframe | IBKR period | IBKR bar |
|---|---|---|
| `minutes` | `1d` | `5mins` |
| `hours` | `5d` | `1h` |
| `daily` | `1y` | `1d` |
| `weekly` | `2y` | `1w` |
| `monthly` | `5y` | `1m` |

**conid cache:** symbol → conid is cached in-memory globally (conids don't change).
Avoids a `/iserver/secdef/search` call on every candle request.

---

## Token refresh pattern

Both adapters use the same pattern for safe token refresh:

```js
async _freshTokens(userId) {
    const conn = await brokerConnectionService.getConnection(userId, brokerType)
    if (!conn) throw 401

    if (Date.now() + 60_000 >= conn.expiresAt) {
        // Access token expires in < 60s — refresh now
        const fresh = await provider.refreshTokens(conn)
        await brokerConnectionService.updateTokens(userId, brokerType, fresh)
        return fresh
    }
    return conn   // still valid
}
```

---

## Factory & registry

`api/broker/broker.factory.js`

```js
const ADAPTERS = {
    ctrader: CTraderAdapter,
    ibkr:    IBKRAdapter,
}

export function getBrokerAdapter(brokerType) { ... }   // throws 400 for unknown type
export const SUPPORTED_BROKERS = ['ctrader', 'ibkr']
```

`brokerService.listConnections(userId)` returns all supported types with their connection status:
```js
{ ctrader: true, ibkr: false }
```

---

## Files

```
providers/
  ctrader.provider.js       Stateless: OAuth + REST for Spotware (accepts tokens as args)
  ibkr.provider.js          Stateless: OAuth + REST + OHLCV for IBKR Client Portal

api/broker/
  adapters/
    broker.interface.js     JSDoc interface + BrokerAdapter base class
    ctrader.adapter.js      cTrader implementation
    ibkr.adapter.js         IBKR implementation (+ getCandles)
  broker.factory.js         Registry + getBrokerAdapter(type)
  brokerConnection.service.js  MongoDB CRUD: per-user tokens + accountId cache
  broker.service.js         Orchestration layer (routes → this → factory → adapter)
  broker.routes.js          Express routes with requireAuth

src/services/broker/
  broker.service.remote.js  Frontend: listConnections, getAccount, getPositions, disconnect
```

---

## Adding a new broker

1. Create `providers/{name}.provider.js`
   - `getAuthUrl(state)`, `exchangeCode(code)`, `refreshTokens({ refreshToken })`, `get(path, tokens)`

2. Create `api/broker/adapters/{name}.adapter.js`
   - Extend `BrokerAdapter`, implement all methods
   - Call `brokerConnectionService.saveConnection / getConnection / updateTokens`

3. Register in `api/broker/broker.factory.js`:
   ```js
   import { NewAdapter } from './adapters/new.adapter.js'
   const ADAPTERS = {
       ctrader: CTraderAdapter,
       ibkr:    IBKRAdapter,
       new:     NewAdapter,     // ← add here
   }
   ```

4. Add env vars to `.env`

**Nothing else changes** — routes, service, frontend all pick it up automatically.

---

## Frontend

`MonitorDashboard.jsx` (mobile view):

```
_loadBrokerData()
    │
    ├── brokerService.listConnections()    → { ctrader: bool, ibkr: bool }
    │
    └── for each connected broker:
            brokerService.getAccount(type)
            brokerService.getPositions(type)
                │
                ▼
            render <BrokerPanel> per connected broker
            render <ConnectButton> per unconnected broker
```

Connect button: `window.location.href = /api/broker/connect/{type}` — browser navigation
sends cookies automatically, so `requireAuth` works correctly.

After OAuth completes, broker redirects to `/?broker=connected&type={type}`.
`MonitorDashboard` detects this on mount and re-fetches broker data.
