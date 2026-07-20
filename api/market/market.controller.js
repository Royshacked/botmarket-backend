import { getMarketStatus } from '../../services/market.service.js'
import { fetchMarketCandles } from '../../services/candleFetch.service.js'
import { getFmpQuoteFull } from '../../providers/fmp.price.provider.js'
import { createTtlCache } from '../../services/ttlCache.util.js'
import { parseChartInterval, defaultLookbackDays } from '../../services/candleInterval.util.js'
import { logger } from '../../services/logger.service.js'

const LOG = '[market:controller]'
const DAY_MS = 86_400_000

export async function getStatus(req, res) {
    try {
        const symbol     = req.query.symbol ?? ''
        const assetClass = req.query.assetClass ?? req.query.asset_class ?? undefined
        res.send(getMarketStatus(symbol, assetClass))
    } catch (err) {
        logger.error(LOG, 'getStatus failed', err)
        res.status(500).send({ error: 'Failed to get market status' })
    }
}

// ─── Chart candles ──────────────────────────────────────────────────────────────
// GET /api/market/candles?symbol=AAPL&interval=5min[&from=<ms>&to=<ms>]
// OHLCV history for the price chart. FMP-first (real-time intraday on this key) with the
// unified candle router (Massive/Yahoo) as the fallback for what FMP doesn't serve on this
// plan: futures / index CFDs / broker symbols and weekly / monthly bars.
//
// Closed bars are immutable, so the response is cached in a module-level (shared across all
// viewers) TTL cache — N users on AAPL/5min collapse to one upstream fetch per window. The
// default (live) window keys on 'default' so repeated polls hit the cache within the TTL;
// explicit from/to (historical scrolls) key on the exact window.

const _intradayCache = createTtlCache({ ttlMs: Number(process.env.CANDLE_CACHE_INTRADAY_MS) || 30_000,  max: 300 })
const _dailyCache    = createTtlCache({ ttlMs: Number(process.env.CANDLE_CACHE_DAILY_MS)    || 300_000, max: 300 })
const _cacheFor = timeSpan => (timeSpan === 'minute' || timeSpan === 'hour') ? _intradayCache : _dailyCache

/** Parse a from/to query value (epoch ms, epoch sec, or ISO date) to epoch ms, or undefined. */
function _parseWhenMs(v) {
    if (v == null || v === '') return undefined
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n   // treat < 1e12 as seconds
    const d = Date.parse(v)
    return Number.isFinite(d) ? d : undefined
}

// ─── Real-time quote ─────────────────────────────────────────────────────────────
// GET /api/market/quote?symbol=AAPL
// The live last price for the chart's current-bar tick. Historical candles alone freeze the
// price until a bar closes (all session on a daily/4h chart), so the chart patches the current
// bar's close from this. FMP `/quote` is ~3s-fresh and covers equities/ETF/crypto/forex; it
// returns null for what it can't price (futures/index) — the client then keeps candle-only.
// Soft-fails to { price: null } so a transient upstream blip is a skipped tick, not a 500 storm.
export async function getQuote(req, res) {
    const symbol = String(req.query.symbol ?? '').toUpperCase().trim()
    if (!symbol) return res.status(400).send({ error: 'symbol is required' })
    try {
        const q = await getFmpQuoteFull(symbol)
        if (!q) return res.send({ symbol, price: null })
        res.send({ symbol, price: q.price, dayHigh: q.dayHigh, dayLow: q.dayLow, tsSec: q.tsSec })
    } catch (err) {
        logger.warn(LOG, `getQuote soft-fail for ${symbol}: ${err.message}`)
        res.send({ symbol, price: null })
    }
}

export async function getCandles(req, res) {
    try {
        const symbol = String(req.query.symbol ?? '').toUpperCase().trim()
        if (!symbol) return res.status(400).send({ error: 'symbol is required' })

        const intervalRaw = String(req.query.interval ?? 'day')
        const spec = parseChartInterval(intervalRaw)
        if (!spec) return res.status(400).send({ error: `unsupported interval: ${intervalRaw}` })
        const { timeSpan, multiplier } = spec

        const fromMs = _parseWhenMs(req.query.from)
        const toMs   = _parseWhenMs(req.query.to)
        const explicit = fromMs != null || toMs != null

        const now  = Date.now()
        const from = fromMs ?? (now - defaultLookbackDays(timeSpan, multiplier) * DAY_MS)
        const to   = toMs   ?? now

        const cache    = _cacheFor(timeSpan)
        const windowKey = explicit ? `${fromMs ?? ''}-${toMs ?? ''}` : 'default'
        const cacheKey  = `${symbol}|${timeSpan}|${multiplier}|${windowKey}`

        const cached = cache.get(cacheKey)
        if (cached) return res.send(cached)

        // FMP-first (real-time intraday) with the unified router as fallback — see candleFetch.service.
        const candles = await fetchMarketCandles(symbol, { timeSpan, multiplier, from, to })

        const payload = { symbol, interval: intervalRaw, timeSpan, multiplier, candles }
        cache.set(cacheKey, payload)
        res.send(payload)
    } catch (err) {
        logger.error(LOG, 'getCandles failed', err)
        res.status(500).send({ error: 'Failed to get candles' })
    }
}
