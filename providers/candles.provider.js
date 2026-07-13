// Candle-source router for the shared price seam.
//
// FMP-first (real-time, verified timestamp parity with the current provider, and CORRECT
// 2hr/4hr aggregation) with the existing Massive/Yahoo provider as the fallback for anything
// FMP doesn't serve on this plan: futures / index CFDs / broker symbols (uncovered → FMP
// returns empty) and weekly / monthly bars (getFmpCandles returns null → native Massive).
//
// Same signature and return shape as massive.getTickerAggregates, so it is a drop-in for
// price.service. Guarded by USE_FMP_CANDLES so the cutover is reversible: with the flag off
// it is byte-for-byte the current behaviour (straight to Massive). See reference_fmp_pricing.

import { getFmpCandles }                              from './fmp.price.provider.js'
import { getTickerAggregates as getMassiveAggregates } from './massive.provider.js'
import { logger }                                     from '../services/logger.service.js'

const LOG     = '[candles.provider]'
const USE_FMP = ['true', '1', 'yes'].includes(String(process.env.USE_FMP_CANDLES ?? '').toLowerCase())

if (USE_FMP) logger.info(LOG, 'USE_FMP_CANDLES on — FMP-first candle sourcing (Massive/Yahoo fallback)')

/**
 * OHLCV candles for the price service. FMP-first when USE_FMP_CANDLES is on, else the current
 * Massive/Yahoo seam unchanged.
 *
 * @param {string} ticker
 * @param {{ timeSpan?: string, multiplier?: number, from?: number, to?: number }} options
 * @returns {Promise<Array<{timestamp,open,high,low,close,volume}>>}
 */
export async function getTickerAggregates(ticker, options = {}) {
    if (!USE_FMP) return getMassiveAggregates(ticker, options)

    try {
        const fmp = await getFmpCandles(ticker, options)
        // Non-empty → FMP serves it. null (week/month/odd multiplier) or [] (uncovered symbol /
        // no bars in window) → fall through to the existing provider.
        if (Array.isArray(fmp) && fmp.length > 0) return fmp
    } catch (err) {
        logger.warn(LOG, `FMP candles failed for ${ticker} (${options.timeSpan}x${options.multiplier}) — falling back: ${err.message}`)
    }
    return getMassiveAggregates(ticker, options)
}
