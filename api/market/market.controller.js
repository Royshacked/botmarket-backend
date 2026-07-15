import { getMarketStatus } from '../../services/market.service.js'
import { getFmpCandles } from '../../providers/fmp.price.provider.js'
import { getTickerAggregates } from '../../providers/candles.provider.js'
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

/** Providers emit epoch SECONDS; the chart (KLineCharts) wants milliseconds. Guarded convert. */
function _toMsCandles(candles) {
    return (Array.isArray(candles) ? candles : []).map(c => ({
        timestamp: c.timestamp < 1e12 ? c.timestamp * 1000 : c.timestamp,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
        volume: c.volume ?? 0,
    }))
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

        // FMP-first (real-time intraday). null → week/month/odd multiplier; [] → uncovered
        // symbol (futures/index/broker) — either way fall back to the unified router.
        let raw = null
        try {
            raw = await getFmpCandles(symbol, { timeSpan, multiplier, from, to })
        } catch (err) {
            logger.warn(LOG, `FMP candles failed for ${symbol} (${timeSpan}x${multiplier}) — falling back: ${err.message}`)
        }
        if (!Array.isArray(raw) || raw.length === 0) {
            raw = await getTickerAggregates(symbol, { timeSpan, multiplier, from, to })
        }

        const payload = { symbol, interval: intervalRaw, timeSpan, multiplier, candles: _toMsCandles(raw) }
        cache.set(cacheKey, payload)
        res.send(payload)
    } catch (err) {
        logger.error(LOG, 'getCandles failed', err)
        res.status(500).send({ error: 'Failed to get candles' })
    }
}
