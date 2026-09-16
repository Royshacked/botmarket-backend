// THE last-price read — quote first, a 1-minute-candle fallback second. The input to every zone
// gate, every baseline stamp and every coherence check in the app.
//
// It lived in monitoring/monitorUtils.js, which meant two services (coverage, tilt) reached UP into
// the monitor tier for it through a dynamic import — the §6 review's carried layering item — and a
// tool handler (valuation) imported the monitor tier statically. A price read is a service; the
// monitors are one of its callers, not its home.

import { getNumericQuote }     from '../providers/yahoofinance.provider.js'
import { getTickerAggregates } from '../providers/candles.provider.js'
import { toNum }               from './format.util.js'

/**
 * The last traded price for a symbol — the input to every zone gate.
 *
 * Quote first, then a 1-minute-candle fallback when the quote is missing or throws. Both layers
 * matter: providers vary in which field carries the price (`price` / `regularMarketPrice` /
 * `last` / `c`), and a monitor that reads `null` here simply never fires, silently and forever.
 *
 * Reads getNumericQuote, NOT getQuote — the latter is the LLM-display formatter and returns a
 * human-readable STRING, off which every `q?.price` lookup is undefined. That mistake cost the
 * coverage monitor its price feed entirely; here the candle fallback was quietly masking it.
 *
 * A non-positive price is treated as NO price: zero is never a real print, and letting it through
 * hands every downstream gate a number that compares below any stop, target or bear case.
 *
 * Shared by Talos, the coverage and tilt monitors, the baseline stamps and the valuation tool, so
 * a fix to the quote-shape fallback chain reaches every gate. Returns null only when BOTH sources
 * fail.
 */
export async function fetchLastPrice(asset) {
    const symbol = String(asset ?? '').toUpperCase()
    if (!symbol) return null
    try {
        const q = await getNumericQuote(asset)
        const p = toNum(q?.price ?? q?.regularMarketPrice ?? q?.last ?? q?.c)
        if (p !== null && p > 0) return p
    } catch { /* fall through to candles */ }
    try {
        const rows = await getTickerAggregates(symbol, { timeSpan: 'minute', multiplier: 1, from: Date.now() - 3 * 24 * 60 * 60 * 1000 })
        const last = rows?.at(-1)
        if (Number.isFinite(last?.close)) return last.close
    } catch { /* give up */ }
    return null
}
