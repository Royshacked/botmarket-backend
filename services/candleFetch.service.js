/**
 * Shared OHLCV candle fetch — the FMP-first → Massive/Yahoo fallback → seconds→ms pipeline that
 * used to live inline in market.controller.js. Extracted so BOTH the HTTP /api/market/candles
 * endpoint and the headless chart renderer draw from ONE code path (same data the monitor
 * evaluates against).
 *
 * FMP serves real-time intraday on this key; it returns null for specs it can't serve
 * (week/month/odd multiplier) and [] for symbols it doesn't cover (futures/index/broker) — either
 * way we fall back to the unified router (Massive → Yahoo). Providers emit epoch SECONDS; callers
 * (KLineCharts + the renderer) want milliseconds.
 */

import { getFmpCandles } from '../providers/fmp.price.provider.js'
import { getTickerAggregates } from '../providers/candles.provider.js'
import { logger } from './logger.service.js'

const LOG = '[candleFetch]'

/** Normalise a candle list to millisecond timestamps (guarded: leaves ms values untouched). */
export function toMsCandles(candles) {
    return (Array.isArray(candles) ? candles : []).map(c => ({
        timestamp: c.timestamp < 1e12 ? c.timestamp * 1000 : c.timestamp,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
        volume: c.volume ?? 0,
    }))
}

/**
 * Fetch OHLCV candles as the canonical millisecond-timestamped list. FMP-first with the unified
 * router as fallback. Never throws for a normal miss — returns [] when nothing is available.
 *
 * Named fetchMarketCandles (not fetchCandles) to stay distinct from monitorUtils.fetchCandles, the
 * monitor's broker-candle router. `_deps` is a test seam (inject fake providers); production callers
 * pass only the first two args.
 *
 * @param {string} symbol
 * @param {{ timeSpan: string, multiplier: number, from?: number, to?: number }} spec  from/to = epoch ms
 * @returns {Promise<Array<{timestamp,open,high,low,close,volume}>>}
 */
export async function fetchMarketCandles(symbol, { timeSpan, multiplier, from, to } = {}, _deps = {}) {
    const fmp    = _deps.getFmpCandles || getFmpCandles
    const router = _deps.getTickerAggregates || getTickerAggregates

    const sym = String(symbol || '').toUpperCase().trim()
    if (!sym) return []

    let raw = null
    try {
        raw = await fmp(sym, { timeSpan, multiplier, from, to })
    } catch (err) {
        logger.warn(LOG, `FMP candles failed for ${sym} (${timeSpan}x${multiplier}) — falling back: ${err.message}`)
    }
    if (!Array.isArray(raw) || raw.length === 0) {
        raw = await router(sym, { timeSpan, multiplier, from, to })
    }
    return toMsCandles(raw)
}
