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

import { priceService } from '../../services/price.service.js'
import { logger }       from '../../services/logger.service.js'

const LOG = '[ohlcv.provider]'

/**
 * Parse a timeframe string into priceService options.
 * Supports both new format ("5min", "4hr", "day") and legacy ("minutes", "hours", "daily").
 *
 * @param {string} tf
 * @returns {{ timeSpan: string, multiplier: number }}
 */
export function parseTimeframe(tf) {
    if (!tf) return { timeSpan: 'day', multiplier: 1 }

    // New format: Xmin
    const minMatch = tf.match(/^(\d+)min$/)
    if (minMatch) return { timeSpan: 'minute', multiplier: parseInt(minMatch[1], 10) }

    // New format: Xhr
    const hrMatch = tf.match(/^(\d+)hr$/)
    if (hrMatch) return { timeSpan: 'hour', multiplier: parseInt(hrMatch[1], 10) }

    // New format: day / week / month
    if (tf === 'day')   return { timeSpan: 'day',   multiplier: 1 }
    if (tf === 'week')  return { timeSpan: 'week',  multiplier: 1 }
    if (tf === 'month') return { timeSpan: 'month', multiplier: 1 }

    // Legacy format support
    if (tf === 'minutes') return { timeSpan: 'minute', multiplier: 5 }
    if (tf === 'hours')   return { timeSpan: 'hour',   multiplier: 1 }
    if (tf === 'daily')   return { timeSpan: 'day',    multiplier: 1 }
    if (tf === 'weekly')  return { timeSpan: 'week',   multiplier: 1 }
    if (tf === 'monthly') return { timeSpan: 'month',  multiplier: 1 }

    logger.warn(LOG, `Unknown timeframe "${tf}" — falling back to daily`)
    return { timeSpan: 'day', multiplier: 1 }
}

/**
 * Get the last `count` OHLCV candles for a symbol.
 * Uses priceService cache (file-based, 1-hour TTL) — no Finnhub calls.
 *
 * @param {string} symbol     e.g. 'AAPL'
 * @param {string} timeframe  new: "5min"|"4hr"|"day" etc. — legacy also accepted
 * @param {number} count      candles to return (newest last)
 * @returns {Promise<Array<{t,o,h,l,c,v}>>}
 */
export async function getCandles(symbol, timeframe, count = 50) {
    const opts = parseTimeframe(timeframe)

    // For sub-hour bars always request fresh data — cache is stale within one bar
    const isIntraday = opts.timeSpan === 'minute' || (opts.timeSpan === 'hour' && opts.multiplier <= 1)
    const refresh = isIntraday

    let result
    try {
        result = await priceService.getCandles(symbol, { ...opts, format: 'object', refresh })
    } catch (err) {
        logger.error(LOG, `priceService.getCandles failed for ${symbol}/${timeframe}:`, err.message)
        return []
    }

    const candles = result?.candles
    if (!Array.isArray(candles) || candles.length === 0) {
        logger.warn(LOG, `No candles returned for ${symbol}/${timeframe} (cached: ${result?.meta?.cached})`)
        return []
    }

    // Normalise from { timestamp, open, high, low, close, volume } → { t, o, h, l, c, v }
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
