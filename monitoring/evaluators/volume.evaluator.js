/**
 * Volume condition evaluator.
 *
 * Volume is its own leaf type because the cumulative reading needs a mechanism the
 * candle-comparison engine doesn't share — a session boundary and summing 1-min
 * sub-bars — much like `time` is evaluated off the wall clock. Two modes:
 *
 *   • mode 'bar'        — a volume threshold on the stated timeframe bar, evaluated
 *                         at candle CLOSE. Delegates to the structured engine
 *                         (subject 'volume' → c.v); no new math, full rising-edge
 *                         semantics so a level breached before the floor doesn't refire.
 *
 *   • mode 'cumulative' — the running total volume since the session start, evaluated
 *                         INTRABAR. `candles` here are 1-min bars; we sum v for bars
 *                         at/after `sessionStartMs`, then compare that current total to
 *                         the threshold. SNAPSHOT semantics: the total is a state, not
 *                         a rising edge, so a pass is "the accumulated total meets the
 *                         threshold right now" and is timestamped now (always ≥ floor).
 *
 * Candle format: { o, h, l, c, v, t } — array newest-last.
 */

import { evaluate }        from './structured.evaluator.js'
import { parseCondition }  from '../parsers/condition.parser.js'
import { logger }          from '../../services/logger.service.js'

const LOG = '[volume.evaluator]'

/** Candle timestamps may arrive in seconds; floors/sessions are ms. Normalise to ms. */
function _candleMs(t) {
    return t < 1e12 ? t * 1000 : t
}

/**
 * Evaluate a volume leaf.
 *
 * @param {object}        leaf     { condition, type:'volume', mode:'bar'|'cumulative', ... }
 * @param {Candle[]}      candles  bar mode: phase candles; cumulative mode: 1-min bars (newest-last)
 * @param {object}        ctx      { sessionStartMs?: number }  — required for cumulative mode
 * @param {number|null}   floorAt  ms timestamp; only events at/after this count (bar mode)
 * @returns {Promise<{ pass: boolean, triggerAt?: number, reason?: string }>}
 */
export async function evaluateVolume(leaf, candles, ctx = {}, floorAt = null) {
    const text = typeof leaf === 'string' ? leaf : leaf?.condition
    if (!text || typeof text !== 'string' || !text.trim()) {
        return { pass: false, reason: 'no_condition' }
    }

    const parsed = await parseCondition(text)
    const mode   = leaf?.mode === 'cumulative' ? 'cumulative' : 'bar'

    // ── bar mode — per-bar volume threshold at candle close (structured engine) ──
    if (mode === 'bar') {
        return evaluate(parsed, candles, floorAt)
    }

    // ── cumulative mode — running total since session start, snapshot compare ────
    if (!candles || candles.length === 0) return { pass: false, reason: 'insufficient_data' }

    const sessionStart = Number(ctx?.sessionStartMs)
    if (!Number.isFinite(sessionStart)) return { pass: false, reason: 'no_session_start' }

    let total = 0
    let counted = 0
    for (const c of candles) {
        if (c == null || c.v == null) continue
        if (_candleMs(c.t) < sessionStart) continue
        total += Number(c.v) || 0
        counted++
    }
    if (counted === 0) return { pass: false, reason: 'no_bars_in_session' }

    const pass = _compareTotal(parsed, total)
    logger.info(LOG, `cumulative volume since ${sessionStart}: ${total} over ${counted} bar(s) — "${text.slice(0, 50)}" → ${pass ? 'YES' : 'NO'}`)
    return pass ? { pass: true, triggerAt: Date.now() } : { pass: false }
}

/**
 * Compare a cumulative total against a parsed threshold. Volume conditions are
 * threshold compares (gt/gte/lt/lte/eq/isBetween); an unparseable/non-numeric
 * threshold can't be evaluated and fails closed.
 */
function _compareTotal(parsed, total) {
    const { operator, value, value2 } = parsed ?? {}
    const lo = Number(value)
    switch (operator) {
        case 'gt':  return Number.isFinite(lo) && total >  lo
        case 'gte': return Number.isFinite(lo) && total >= lo
        case 'lt':  return Number.isFinite(lo) && total <  lo
        case 'lte': return Number.isFinite(lo) && total <= lo
        case 'eq':  return Number.isFinite(lo) && Math.abs(total - lo) < 1e-9
        case 'isBetween': {
            const hi = Number(value2)
            return Number.isFinite(lo) && Number.isFinite(hi) && total > lo && total < hi
        }
        // crossAbove/crossBelow don't apply to a monotonic intraday total; treat
        // "crossAbove N" as "total > N" (the cumulative crossed the level today).
        case 'crossAbove': return Number.isFinite(lo) && total >  lo
        case 'crossBelow': return Number.isFinite(lo) && total <  lo
        default: return false
    }
}
