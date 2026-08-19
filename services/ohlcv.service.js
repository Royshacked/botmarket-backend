/**
 * OHLCV candles in the compact { t, o, h, l, c, v } shape the evaluators read.
 *
 * Thin wrapper around priceService — no new data source, no duplicate cache; it only relabels the
 * timeframe and renames the fields.
 *
 * WAS providers/ohlcv.provider.js, which put it in the one layer it does not belong to: providers/
 * are the thin clients for EXTERNAL systems, and this module reaches nothing outside the process —
 * it calls a service, which is the arrow pointing the wrong way. Nothing about the code changed.
 *
 * Timeframe format (new): "5min" | "15min" | "30min" | "1hr" | "2hr" | "4hr" | "day" | "week" | "month"
 * Legacy format still supported: "minutes" | "hours" | "daily" | "weekly" | "monthly"
 */

import { priceService } from './price.service.js'
import { logger }       from './logger.service.js'
import { parseTimeframe, isIntradaySpan, barDurationSeconds } from './timeframe.service.js'

const LOG = '[ohlcv]'

/** Never ask for less than this, so a small `count` behaves exactly as it always did. */
const MIN_WINDOW_DAYS = 30

/**
 * CALENDAR time per bar of MARKET time, by span — the reason `count` bars is not `count` durations.
 *
 * A day bar costs more than a day: markets keep five days in seven and take about nine holidays a
 * year. An intraday bar costs far more, because a regular session is 6.5 hours of the 24 the clock
 * offers, so 5-minute bars arrive at roughly a fifth of the rate the arithmetic suggests.
 *
 * Deliberately GENEROUS, and asymmetric on purpose: over-asking costs nothing (it is one request
 * either way, the provider returns what exists, and the caller slices to `count`), while
 * under-asking returns a short series that reads as real data and silently starves every long
 * indicator. Crypto and FX run 24/7 and will over-fetch here — also harmless, for the same reason.
 */
const CALENDAR_SLACK = { minute: 6, hour: 5, day: 1.7, week: 1.15, month: 1.1 }

/**
 * The earliest second a request for `count` bars needs to reach back to. Pure; exported for tests.
 */
export function windowStartSec({ timeSpan, multiplier }, count) {
    const bars  = Math.max(1, Number(count) || 1)
    const slack = CALENDAR_SLACK[timeSpan] ?? 3
    const span  = barDurationSeconds(timeSpan, multiplier) * bars * slack
    const floor = MIN_WINDOW_DAYS * 86400
    return Math.floor(Date.now() / 1000) - Math.max(span, floor)
}

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
        result = await priceService.getCandles(symbol, {
            ...opts, format: 'object', refresh: isIntraday,
            // ASK FOR ENOUGH BARS TO ANSWER WITH. Without this the window was a flat 30 days, so a
            // caller asking for 300 daily candles — which the monitor does, CANDLE_COUNT — got the
            // ~22 trading days that fit, and every indicator with a longer lookback than that read
            // n/a forever. Nothing failed: the series was simply short, and a condition written on
            // SMA-200 could never come true. indicator.evaluator's SMA-200 warmup warning is that
            // symptom, seen from the other end.
            fromSec: windowStartSec(opts, count),
        })
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
