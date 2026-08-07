/**
 * The /api/market read surface: chart candles + the live-bar quote.
 *
 * ⚠ NOT services/market.service.js. That one is THE market-hours engine (isAssetOpen /
 * getMarketStatus / sessionPhase) and is imported by half the app. This one is the HTTP feature's
 * own service — the two share a name because the feature is called `market` and the convention is
 * `<feature>.service.js`, and they never share a caller: this module is used only by
 * market.controller, and it imports the hours engine rather than duplicating any of it.
 *
 * Lifted out of market.controller.js, which held the caches, the window arithmetic and the feed
 * read inline and was the only controller importing a provider directly.
 */

import { fetchMarketCandles } from '../../services/candleFetch.service.js'
import { getFmpQuoteFull }    from '../../providers/fmp.price.provider.js'
import { createTtlCache }     from '../../services/ttlCache.util.js'
import { defaultLookbackDays } from '../../services/candleInterval.util.js'
import { logger }             from '../../services/logger.service.js'
import { readMark, publish }  from '../../services/priceFeed.service.js'
import { config } from '../../services/config.js'

const LOG = '[market:service]'

// How stale a published mark may be before the chart buys its own. The chart polls the quote every
// 5s to repaint the live bar, so this is deliberately just under that: fresh enough that the tick
// still moves, loose enough that a held symbol (marked by the paper loop) is served for free.
const QUOTE_MAX_AGE_MS = config.quoteFeedMaxAgeMs
const DAY_MS = 86_400_000

// Closed bars are immutable, so responses are cached in a module-level (shared across all viewers)
// TTL cache — N users on AAPL/5min collapse to one upstream fetch per window. The default (live)
// window keys on 'default' so repeated polls hit the cache within the TTL; explicit from/to
// (historical scrolls) key on the exact window.
const _intradayCache = createTtlCache({ ttlMs: config.candleCacheIntradayMs, max: 300 })
const _dailyCache    = createTtlCache({ ttlMs: config.candleCacheDailyMs, max: 300 })
const _cacheFor = timeSpan => (timeSpan === 'minute' || timeSpan === 'hour') ? _intradayCache : _dailyCache

/** Parse a from/to query value (epoch ms, epoch sec, or ISO date) to epoch ms, or undefined. Pure. */
export function parseWhenMs(v) {
    if (v == null || v === '') return undefined
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n   // treat < 1e12 as seconds
    const d = Date.parse(v)
    return Number.isFinite(d) ? d : undefined
}

/**
 * The live last price for the chart's current-bar tick. Historical candles alone freeze the price
 * until a bar closes (all session on a daily/4h chart), so the chart patches the current bar's close
 * from this. FMP `/quote` is ~3s-fresh and covers equities/ETF/crypto/forex; it returns null for
 * what it can't price (futures/index) — the client then keeps candle-only.
 *
 * Soft-fails to `{ price: null }` so a transient upstream blip is a skipped tick, not a 500 storm.
 * That is why this returns a payload rather than throwing: the failure mode is a route-level
 * decision, and it is "the chart stops ticking", never "the request errors".
 */
export async function getQuote(symbol) {
    // Read before fetching. A symbol the user holds is already priced by the mark loop, and the
    // chart ticking on it should not buy a second copy of the same number. TOLERANCE IS THE
    // CHART'S: it repaints the live bar, so a few seconds is fine and a stale minute is not — the
    // caller states the bound, the feed never assumes one (services/priceFeed.service.js).
    const cheap = readMark(symbol, { maxAgeMs: QUOTE_MAX_AGE_MS })
    if (cheap != null) return { symbol, price: cheap, fromFeed: true }

    try {
        const q = await getFmpQuoteFull(symbol)
        if (!q) return { symbol, price: null }
        // Pay once, share it. A chart open on a symbol nobody holds now subsidises the mark loop
        // instead of duplicating it — the reciprocity that makes the feed worth having.
        publish(symbol, q.price)
        return { symbol, price: q.price, dayHigh: q.dayHigh, dayLow: q.dayLow, tsSec: q.tsSec }
    } catch (err) {
        logger.warn(LOG, `getQuote soft-fail for ${symbol}: ${err.message}`)
        return { symbol, price: null }
    }
}

/**
 * OHLCV history for the price chart. FMP-first (real-time intraday on this key) with the unified
 * candle router (Massive/Yahoo) as the fallback for what FMP doesn't serve on this plan: futures /
 * index CFDs / broker symbols and weekly / monthly bars. See candleFetch.service.
 *
 * `spec` is the already-parsed interval ({ timeSpan, multiplier }) — the controller validates it,
 * because an unsupported interval is a 400 and that is a transport decision.
 */
export async function getCandles(symbol, intervalRaw, spec, { fromMs, toMs } = {}) {
    const { timeSpan, multiplier } = spec
    const explicit = fromMs != null || toMs != null

    const now  = Date.now()
    const from = fromMs ?? (now - defaultLookbackDays(timeSpan, multiplier) * DAY_MS)
    const to   = toMs   ?? now

    const cache     = _cacheFor(timeSpan)
    const windowKey = explicit ? `${fromMs ?? ''}-${toMs ?? ''}` : 'default'
    const cacheKey  = `${symbol}|${timeSpan}|${multiplier}|${windowKey}`

    const cached = cache.get(cacheKey)
    if (cached) return cached

    const candles = await fetchMarketCandles(symbol, { timeSpan, multiplier, from, to })
    const payload = { symbol, interval: intervalRaw, timeSpan, multiplier, candles }
    cache.set(cacheKey, payload)
    return payload
}
