/**
 * OHLCV candle provider for the monitoring system.
 *
 * Thin wrapper around the existing priceService — no new data source,
 * no duplicate cache. Normalises the output format to { t, o, h, l, c, v }
 * for the evaluators.
 *
 * Timeframe format (new): "5min" | "15min" | "30min" | "1hr" | "2hr" | "4hr" | "day" | "week" | "month"
 * Legacy format still supported: "minutes" | "hours" | "daily" | "weekly" | "monthly"
 */

import { priceService } from '../services/price.service.js'
import { logger }       from '../services/logger.service.js'
import { parseTimeframe, isIntradaySpan } from '../services/timeframe.service.js'

const LOG = '[ohlcv.provider]'

/**
 * Get the last `count` OHLCV candles for a symbol.
 *
 * @param {string} symbol     e.g. 'AAPL'
 * @param {string} timeframe  e.g. "5min"|"4hr"|"day"
 * @param {number} count      candles to return (newest last)
 * @returns {Promise<Array<{t,o,h,l,c,v}>>}
 */
export async function getCandles(symbol, timeframe, count = 50) {
    let opts = parseTimeframe(timeframe)
    if (!opts) {
        logger.warn(LOG, `Unknown timeframe "${timeframe}" — falling back to daily`)
        opts = { timeSpan: 'day', multiplier: 1 }
    }

    // All intraday bars (minute or any hour multiplier) always request fresh data
    const isIntraday = isIntradaySpan(opts.timeSpan)

    let result
    try {
        result = await priceService.getCandles(symbol, { ...opts, format: 'object', refresh: isIntraday })
    } catch (err) {
        logger.error(LOG, `priceService.getCandles failed for ${symbol}/${timeframe}:`, err.message)
        return []
    }

    const candles = result?.candles
    if (!Array.isArray(candles) || candles.length === 0) {
        logger.warn(LOG, `No candles returned for ${symbol}/${timeframe} (cached: ${result?.meta?.cached})`)
        return []
    }

    const normalized = candles.map(c => ({
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume,
    }))

    logger.info(LOG, `${symbol}/${timeframe}: ${normalized.length} candles (cached: ${result.meta?.cached ?? '?'})`)
    return normalized.slice(-count)
}
