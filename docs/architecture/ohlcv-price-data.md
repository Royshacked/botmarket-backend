# OHLCV / Price Data Architecture

## Overview

OHLCV (candle) data flows through two stacked layers:

```
Consumers
  ├── Trade agent tools (price.sync_candles, price.get_candles)
  ├── Monitoring system (ohlcv.provider → priceService)
  └── Future: IBKR broker adapter (getCandles → ibkr.provider)

        │
        ▼
  priceService          ← orchestration: cache-first, sync on miss/stale
        │
        ▼
  File cache            ← .cache/ohlcv/{TICKER}/{timeSpan}-{multiplier}.json
        │
        ▼ (cache miss or stale)
  massive.provider      ← Massive/Polygon REST API
```

---

## Data source: Massive (Polygon-compatible)

- **Provider:** `providers/massive.provider.js`
- **API:** `https://api.massive.com` (Polygon-compatible endpoint)
- **Client:** `@massive.com/client-js` — `rest.getStocksAggregates()`
- **Env var:** `MASSIVE_API_KEY`
- **Supports:** US equities, adjusted prices
- **Limit:** 50,000 bars per request

Raw response from Massive:
```js
{ t: unixMs, o, h, l, c, v }   // t is milliseconds
```

Normalised on read:
```js
{ timestamp: unixSec, open, high, low, close, volume }  // t converted to seconds
```

---

## priceService

`services/price.service.js` — the main interface for all OHLCV operations.

### Three public methods

#### `getCandles(ticker, opts)` — primary consumer method

Cache-first with automatic sync:

```
getCandles(ticker, opts)
    │
    ├── load file cache
    │
    ├── shouldFetch?
    │   ├── opts.refresh === true
    │   ├── cache is empty
    │   └── cache is stale (> 1h old)
    │           │
    │           ▼
    │       syncCandles()   ← fetch from Massive, merge into cache
    │
    └── queryCandles()     ← filter cache by date range, return
```

#### `syncCandles(ticker, opts)` — incremental fetch

```
syncCandles(ticker, opts)
    │
    ├── load existing cache
    │
    ├── resolve from/to window:
    │       from = latestCachedTimestamp + 1 bar
    │       (or now - 30 days if cache empty)
    │
    ├── getTickerAggregates()   ← Massive API call
    │
    ├── mergeDeduped(existing, incoming)   ← dedup by timestamp
    │
    └── save to file cache
```

#### `queryCandles(ticker, opts)` — read-only from cache

Filters cached candles by `fromSec`/`toSec` range. No network call.

---

## File cache layout

```
.cache/
  ohlcv/
    AAPL/
      day-1.json        ← daily bars (timeSpan=day, multiplier=1)
      minute-5.json     ← 5-minute bars
      hour-1.json       ← hourly bars
    TSLA/
      day-1.json
      ...
```

**Cache envelope shape:**
```json
{
  "lastFetchedAt": 1716000000000,
  "schema": "ohlcv6",
  "candles": [
    [1715990400, 185.0, 186.5, 184.2, 185.8, 55000000],
    ...
  ]
}
```

**Compact row format (`ohlcv6`):** `[timestamp_sec, open, high, low, close, volume]`

Stored as arrays (not objects) to keep file sizes small.

**Cache TTL:** 1 hour (`CANDLE_CACHE_TTL_MS`). After 1 hour, the next `getCandles()` call
triggers a sync from Massive.

---

## Options object

```js
{
  timeSpan:   'minute'|'hour'|'day'|'week'|'month',  // default: 'day'
  multiplier: number,                                  // default: 1
  from:       unixMs,     // fetch window start (optional)
  to:         unixMs,     // fetch window end   (optional)
  fromSec:    unixSec,    // query filter start (optional)
  toSec:      unixSec,    // query filter end   (optional)
  refresh:    boolean,    // force re-fetch even if cache fresh (default: false)
  format:     'compact'|'object',  // output format (default: 'compact')
}
```

`from`/`to` control the **Massive fetch window** (milliseconds).
`fromSec`/`toSec` control the **cache query filter** (seconds).

---

## Output formats

**compact** (default — arrays, same as stored):
```js
[[1715990400, 185.0, 186.5, 184.2, 185.8, 55000000], ...]
```

**object** (used by monitoring system):
```js
[{ timestamp: 1715990400, open: 185.0, high: 186.5, low: 184.2, close: 185.8, volume: 55000000 }, ...]
```

---

## ohlcv.provider (monitoring adapter)

`monitoring/providers/ohlcv.provider.js` — thin adapter between the monitoring system
and `priceService`. Translates monitoring timeframe labels to priceService options
and normalises output to `{ t, o, h, l, c, v }` format.

```
monitoring system
    │  getCandles(symbol, 'daily', 60)
    ▼
ohlcv.provider
    │  maps 'daily' → { timeSpan: 'day', multiplier: 1 }
    │  priceService.getCandles(symbol, opts)
    │  normalise: { timestamp, open, ... } → { t, o, h, l, c, v }
    ▼
[{ t, o, h, l, c, v }, ...]  newest-last
```

**Timeframe mapping:**

| Monitoring timeframe | priceService timeSpan | multiplier | refresh forced? |
|---|---|---|---|
| `minutes` | `minute` | 5 | ✅ yes (5m bars stale quickly) |
| `hours` | `hour` | 1 | ❌ |
| `daily` | `day` | 1 | ❌ |
| `weekly` | `week` | 1 | ❌ |
| `monthly` | `month` | 1 | ❌ |

---

## Trade agent tool registration

`priceService` is also registered as trade agent tools so the AI can call them:

| Tool ID | Function | Description |
|---|---|---|
| `price.sync_candles` | `syncCandles` | Fetch incremental bars, merge into cache |
| `price.query_candles` | `queryCandles` | Read from cache, no network call |
| `price.get_candles` | `getCandles` | Cache-first: sync if needed, then query |

These are used by the trade agent when analysing a chart for trade idea construction.

---

## IBKR OHLCV (future integration point)

When a user has IBKR connected, the monitoring system can use their broker's market data
instead of Massive. IBKR's Client Portal API returns historical bars directly in
`{ t, o, h, l, c, v }` format.

The single integration point: `monitoring/providers/ohlcv.provider.js` — add a
`userId` parameter, check for active IBKR connection, call `ibkr.getHistoricalBars()`
if available, fall back to `priceService` if not.

**Data source priority (planned):**
1. IBKR (if user connected) — real market data, correct for IBKR users
2. Massive/Polygon — default, works for all users

---

## Files

```
providers/
  massive.provider.js           Massive REST client: getTickerAggregates()

services/
  price.service.js              Core: syncCandles, queryCandles, getCandles, toCompactRow
  priceCandleSpec.service.js    Candle specification helpers (used by trade agent)
  util.service.js               loadCandlesFromFile / saveCandlesToFile / isCacheFresh

monitoring/
  providers/ohlcv.provider.js   Monitoring adapter: timeframe label → priceService → {t,o,h,l,c,v}
```

---

## Dedup strategy

Candles are deduplicated by `timestamp` (unix seconds). When merging existing cache
with incoming Massive data, a `Map<timestamp, row>` is built — later values overwrite
earlier ones, so fresh Massive data always wins over stale cached data for the same bar.

```js
// incoming data overwrites existing for the same timestamp:
for (const c of [...existing, ...incoming]) {
    byTs.set(row[T], row)   // incoming comes last → wins
}
```

---

## Default date range

When no `from`/`to` is provided and the cache is empty, `syncCandles` fetches the
last **30 days** of data. This is the startup bootstrap window.

Subsequent syncs use `latestCachedTimestamp + 1 bar` as the `from` value, so only
new bars are fetched (incremental).
