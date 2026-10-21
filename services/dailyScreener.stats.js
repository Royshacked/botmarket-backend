// DailyScreener's ARITHMETIC — what one name's daily bars say, computed once a night
// (docs/design/daily-names.md §2, §6 "Two passes"). Pure: bars in, numbers out, no IO, no clock.
//
// What is here is what the checkpoint pass (phase 3) cannot afford to compute live for a whole
// universe: the liquidity and range gates (§2.1), relative strength (§2.5), the structure flags
// (§2.4), the OVERHEAD LEVELS free range is measured to (§5), and the cycle position (§4). What is
// NOT here is anything that needs today's price — gap, relative volume, free range itself — which
// is phase 3's, against the pre-market quote.
//
// Bars are the provider's: ascending, `{ timestamp (epoch s), open, high, low, close, volume }`.

import { atr } from './priceStats.util.js'
import { findExtrema, cycleStats } from './cycleAnalysis.service.js'

/** Fewer than this many sessions and the 50-day numbers would be guesses. */
export const MIN_BARS = 60

const round = (n, d = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const maxOf = (bars, key) => bars.reduce((m, b) => Math.max(m, b[key]), -Infinity)
const minOf = (bars, key) => bars.reduce((m, b) => Math.min(m, b[key]), Infinity)
const mean  = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** Return over `n` sessions, from the close `n` bars back to the last. Pure. */
function _ret(closes, n) {
    if (closes.length <= n) return null
    const from = closes[closes.length - 1 - n]
    return from > 0 ? closes[closes.length - 1] / from - 1 : null
}

/**
 * Return over `n` sessions for the benchmark, ENDING ON THE SAME SESSION as the stock — matched by
 * timestamp, not by position, so a stock missing a session (a halt, a late listing) is not compared
 * against a different week of SPY. Null when the benchmark lacks that session.
 */
function _benchRet(bench, lastTs, n) {
    const i = bench.findIndex(b => b.timestamp === lastTs)
    if (i < n) return null
    const from = bench[i - n].close
    return from > 0 ? bench[i].close / from - 1 : null
}

/**
 * One name's overnight stats, or null when there are too few bars to say anything.
 *
 * @param {object[]} bars   the name's daily bars, ascending
 * @param {object[]} bench  SPY's daily bars, ascending (relative strength); may be empty
 */
export function screenerStats(bars, bench = []) {
    const rows = (Array.isArray(bars) ? bars : []).filter(b =>
        Number.isFinite(b?.high) && Number.isFinite(b?.low) && Number.isFinite(b?.close) && b.close > 0)
    if (rows.length < MIN_BARS) return null

    const last   = rows.at(-1)
    const prev   = rows.at(-2)
    const closes = rows.map(b => b.close)
    const last20 = rows.slice(-20)
    const atr14  = atr(rows, 14)

    // Structure flags (§2.4). NR7: the narrowest range of the last seven sessions — compression
    // before expansion. Inside day: today's range inside yesterday's.
    const ranges = rows.slice(-7).map(b => b.high - b.low)
    const nr7    = ranges.length === 7 && ranges.at(-1) <= Math.min(...ranges.slice(0, -1))
    const inside = last.high <= prev.high && last.low >= prev.low

    // The cycle position (§4, the user's "price-cycle window"): days since the last daily trough
    // against the mean trough-to-trough length. Fits the days/week columns, not the session.
    const { troughs } = findExtrema(closes, 5)
    const cyc         = cycleStats(troughs)
    const sinceTrough = troughs.length ? closes.length - 1 - troughs.at(-1) : null

    const ret5 = _ret(closes, 5), ret20 = _ret(closes, 20)
    const b5   = _benchRet(bench, last.timestamp, 5), b20 = _benchRet(bench, last.timestamp, 20)
    const sma20 = mean(closes.slice(-20)), sma50 = mean(closes.slice(-50))

    return {
        last_date:   new Date(last.timestamp * 1000).toISOString().slice(0, 10),
        close:       round(last.close),
        // §2.1 gates
        adv20_usd:   round(mean(last20.map(b => b.close * (b.volume || 0))), 0),
        avg_vol20:   round(mean(last20.map(b => b.volume || 0)), 0),
        atr14:       round(atr14),
        atr_pct:     round(atr14 != null ? (atr14 / last.close) * 100 : null, 2),
        // §2.5 relative strength — return minus SPY's over the same sessions, in percentage points
        rs5:         round(ret5 != null && b5 != null ? (ret5 - b5) * 100 : null, 2),
        rs20:        round(ret20 != null && b20 != null ? (ret20 - b20) * 100 : null, 2),
        ret5:        round(ret5 != null ? ret5 * 100 : null, 2),
        ret20:       round(ret20 != null ? ret20 * 100 : null, 2),
        sma20:       round(sma20),
        sma50:       round(sma50),
        above_sma20: sma20 != null ? last.close > sma20 : null,
        // §5 OVERHEAD LEVELS, highest high over the window INCLUDING today: what price meets above it
        // tomorrow. day_high is tomorrow's "prior-day high".
        day_high:    round(last.high),
        day_low:     round(last.low),
        high5:       round(maxOf(rows.slice(-5), 'high')),
        high20:      round(maxOf(last20, 'high')),
        high50:      round(maxOf(rows.slice(-50), 'high')),
        high52w:     round(maxOf(rows.slice(-252), 'high')),
        low20:       round(minOf(last20, 'low')),
        low52w:      round(minOf(rows.slice(-252), 'low')),
        // §2.4 structure
        nr7,
        inside_day:  inside,
        // §4 cycle
        cycle: cyc ? {
            mean_days:   round(cyc.mean, 1),
            consistency: round(cyc.consistency, 2),
            since_trough: sinceTrough,
        } : null,
        bars: rows.length,
    }
}

/** Breadth (§2.8): the share of the universe closing above its 20-day average, in percent. Pure. */
export function breadthAboveSma20(statsList) {
    const known = (statsList ?? []).filter(s => typeof s?.above_sma20 === 'boolean')
    if (!known.length) return null
    return round((known.filter(s => s.above_sma20).length / known.length) * 100, 1)
}
