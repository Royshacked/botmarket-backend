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

import { getFmpCandles, getFmpQuoteFull, etPeriodKey, etCalendarDate, fmpDateToEpochSec } from '../providers/fmp.price.provider.js'
import { getTickerAggregates } from '../providers/candles.provider.js'
import { logger } from './logger.service.js'

const LOG = '[candleFetch]'

/** The bar specs built from END-OF-DAY rows, and therefore the ones that can be missing today. */
const EOD_SPANS = ['day', 'week', 'month']

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
 * TODAY'S BAR, WHICH THE EOD FEED DOES NOT HAVE YET.
 *
 * `/historical-price-eod/full` publishes the running day LATE. Measured on Mon 2026-08-17 (AVGO):
 * at 14:59Z — ~90 minutes into the session — the newest row was still Friday's, while `/quote` was
 * live and correct; by ~17:00Z today's row had appeared. So the gap is the EARLY session and it
 * heals itself later in the day, which is exactly why the period gate below has to decide this per
 * request rather than a flag being set once. Intraday endpoints carry their forming bar, which is
 * why this is scoped to the EOD-derived spans (day/week/month at multiplier 1; a higher multiplier
 * is an aggregate whose group alignment a lone extra bar would break).
 *
 * The damage was not the missing bar, it was what filled the gap: the chart patches the live price
 * onto its LAST bar, so Friday's candle was rendering with Monday's close — a closed candle
 * silently falsified. Building the real bar is what makes that patch land where it belongs.
 *
 * THE GATE IS THE QUOTE'S OWN TRADE TIME, not a clock and not market hours. On Saturday the quote
 * still reads Friday's last print, which files under Friday's period — the same period as the last
 * bar — so nothing is fabricated over a weekend or a holiday, without this module knowing a single
 * session rule. A provider that already includes today (Yahoo's daily feed does) fails the same
 * test and is left untouched.
 *
 * The bar is stamped at TODAY's ET midnight for all three spans, which is not a shortcut: this only
 * fires when the period has no bar at all, so today is necessarily that period's first trading day,
 * and `groupOhlcByPeriod` stamps a period at its first day. For the same reason the quote's `open`
 * IS the period's open.
 *
 * Pure — exported for testing. Returns the bar, or null when nothing should be added.
 *
 * Takes the NEWEST BAR rather than the series: it is all the decision needs, and the two callers
 * hold their candles in different units — the chart surface in canonical ms, the agent tool path in
 * the provider's seconds. One bar is cheap to convert at the boundary; a whole series is not.
 *
 * @param {object|null} last           the newest candle, MS-stamped (null/absent → no history)
 * @param {{timeSpan:string, multiplier:number}} spec
 * @param {object|null} quote          normalizeFmpQuote shape (price/open/dayHigh/dayLow/volume/tsSec)
 * @param {{ toMs?: number }} [window] the caller's upper bound, when it asked for one
 */
export function buildFormingBar(last, { timeSpan, multiplier } = {}, quote, { toMs } = {}) {
    if (!EOD_SPANS.includes(timeSpan) || multiplier !== 1) return null
    // No history is not a gap to fill — it means the symbol is uncovered, and a chart made of one
    // synthetic bar would look like data where there is none.
    if (!Number.isFinite(last?.timestamp)) return null

    const px    = Number(quote?.price)
    const tsSec = Number(quote?.tsSec)
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(tsSec) || tsSec <= 0) return null

    const quoteMs = tsSec * 1000
    if (etPeriodKey(quoteMs, timeSpan) === etPeriodKey(last.timestamp, timeSpan)) return null

    const startSec = fmpDateToEpochSec(etCalendarDate(quoteMs))
    if (startSec == null) return null
    const timestamp = startSec * 1000
    // Ordering, and the historical scroll. A quote is always "now", so a window that ENDS in the
    // past must not gain a bar dated today — and a series whose last bar is somehow newer than the
    // quote is a provider anomaly to leave alone, not to append to.
    if (timestamp <= last.timestamp) return null
    if (toMs != null && timestamp > toMs) return null

    const open = Number.isFinite(quote.open) && quote.open > 0 ? quote.open : px
    const hi   = Number.isFinite(quote.dayHigh) ? quote.dayHigh : px
    const lo   = Number.isFinite(quote.dayLow)  ? quote.dayLow  : px
    const vol  = Number(quote.volume)
    return {
        timestamp,
        open,
        // The extremes include open and close: a degenerate quote (h/l defaulted to price) must
        // still produce a coherent candle rather than a wick that cuts through its own body.
        high:  Math.max(hi, open, px),
        low:   Math.min(lo, open, px),
        close: px,
        volume: Number.isFinite(vol) && vol > 0 ? vol : 0,
    }
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
    const quote  = _deps.getFmpQuoteFull || getFmpQuoteFull

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
    const candles = toMsCandles(raw)

    // The forming bar (see buildFormingBar). Bought on the ~3s quote cache the chart's own 5s poll
    // already keeps warm, so on the interactive surface this is usually free; a symbol FMP cannot
    // price answers null and the series is returned exactly as fetched. A failure here is never
    // allowed to cost the caller its history — a chart missing today's bar is the bug we started
    // with, a chart missing ALL its bars is worse.
    if (!EOD_SPANS.includes(timeSpan) || multiplier !== 1 || candles.length === 0) return candles
    // A window that ends at or before the newest bar cannot gain a newer one, so the quote is not
    // worth buying — the same ordering rule buildFormingBar enforces, applied before we spend a
    // request on it. This is what keeps a historical scroll from paying for a quote it will discard.
    if (to != null && to <= candles[candles.length - 1].timestamp) return candles
    try {
        const bar = buildFormingBar(candles[candles.length - 1], { timeSpan, multiplier }, await quote(sym), { toMs: to })
        return bar ? [...candles, bar] : candles
    } catch (err) {
        logger.warn(LOG, `forming bar skipped for ${sym} (${timeSpan}) — history stands: ${err.message}`)
        return candles
    }
}
