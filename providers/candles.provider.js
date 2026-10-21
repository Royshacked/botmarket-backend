// Candle-source router for the shared price seam.
//
// FMP-first (real-time, verified timestamp parity with the current provider, and CORRECT
// 2hr/4hr aggregation) with the existing Massive/Yahoo provider as the fallback for anything
// FMP doesn't serve on this plan: futures / index CFDs / broker symbols (uncovered → FMP
// returns empty). Week/month bars used to fall through here too; fmp.price aggregates them from daily
// now (groupOhlcByPeriod), so FMP serves those as well — verified 2026-09-27 at day/hour/15m/5m/week/
// month, current to the last session and byte-identical to Massive on dailies.
//
// THE FLAG WAS OFF UNTIL 2026-09-27, which is the thing to know about this file. It is opt-in, nobody
// had ever set it, and no boot log in a month of runs carried the "USE_FMP_CANDLES on" line — so every
// candle read in the app (price action, indicators, charts, the monitors' fallback) went to Massive's
// free tier. That tier blocks same-day intraday and rate-limits hard: a single Argus radar cut asking
// for price action across a twenty-name shortlist got HTTP 429 on fourteen of them.
//
// Same signature and return shape as massive.getTickerAggregates, so it is a drop-in for
// price.service. Guarded by USE_FMP_CANDLES so the cutover is reversible: with the flag off
// it is byte-for-byte the current behaviour (straight to Massive). See reference_fmp_pricing.

import { getFmpCandles }                              from './fmp.price.provider.js'
import { getTickerAggregates as getMassiveAggregates } from './massive.provider.js'
import { logger }                                     from '../services/logger.service.js'
import { config } from '../services/config.js'
import { aggregateCandles } from '../services/candleInterval.util.js'
import { barBucketOf } from '../services/market.service.js'

const LOG = '[candles.provider]'

if (config.useFmpCandles) logger.info(LOG, 'USE_FMP_CANDLES on — FMP-first candle sourcing (Massive/Yahoo fallback)')

/**
 * Test seam. The flag is read PER CALL rather than captured at module load: config.js is built on
 * live getters precisely so a test can override process.env, and freezing one here defeats that for
 * the only module the flag exists to control. The boot log above still reads it once, which is the
 * one place a snapshot is what you want.
 */
export const _deps = {
    getFmpCandles,
    getMassiveAggregates,
    get useFmp() { return config.useFmpCandles },
}

/**
 * OHLCV candles for the price service. FMP-first when USE_FMP_CANDLES is on, else the current
 * Massive/Yahoo seam unchanged.
 *
 * @param {string} ticker
 * @param {{ timeSpan?: string, multiplier?: number, from?: number, to?: number }} options
 * @returns {Promise<Array<{timestamp,open,high,low,close,volume}>>}
 */
export async function getTickerAggregates(ticker, options = {}, deps = _deps) {
    if (!deps.useFmp) return _fallback(ticker, options, deps)

    try {
        const fmp = await deps.getFmpCandles(ticker, options)
        // Non-empty → FMP serves it. null (week/month/odd multiplier) or [] (uncovered symbol /
        // no bars in window) → fall through to the existing provider.
        if (Array.isArray(fmp) && fmp.length > 0) return fmp
    } catch (err) {
        logger.warn(LOG, `FMP candles failed for ${ticker} (${options.timeSpan}x${options.multiplier}) — falling back: ${err.message}`)
    }
    return _fallback(ticker, options, deps)
}

/**
 * The fallback, holding it to the bar it was asked for. Intraday hours go to Yahoo, which has no
 * 2hr or 4hr interval and answers both with 1h bars (`_toInterval`: "1h is closest") — so a caller
 * asking for 4hr got hourlies LABELLED 4hr, and anything reading "the last closed bar" judged an
 * hourly close (code review 2026-10-21). Folded here, once, into the instrument's own bars
 * (market.service barBucketOf — 09:30-anchored for an equity), so every caller of the router gets
 * the same 4hr bar FMP serves natively.
 */
async function _fallback(ticker, options, deps) {
    const rows = await deps.getMassiveAggregates(ticker, options)
    const mult = Number(options.multiplier) || 1
    if (options.timeSpan !== 'hour' || mult <= 1 || !Array.isArray(rows)) return rows
    return aggregateCandles(rows, mult, barBucketOf(ticker, null, mult * 60))
}
