/**
 * Protection planner — decides which of an idea's stop / take-profit exits can be
 * offloaded to a broker's NATIVE order protection (an SL/TP attached to the order)
 * versus left on the software monitor.
 *
 * Native protection is only safe for a *bare price level*: a single structured
 * condition comparing price (close) to a constant on the current candle. Anything
 * richer — an indicator, a chart/news condition, a confirmation window, a
 * cross-asset reference, or more than one condition — stays on the monitor, the
 * only thing that can evaluate it.
 *
 * Per the unified-broker design this module is broker-agnostic: it only computes
 * the price levels. The *capability* to protect natively comes from the adapter
 * (`capabilities().nativeProtection`); callers gate on that flag.
 */

import { parseCondition }    from '../monitoring/parsers/condition.parser.js'
import { extractLeaves }     from './conditionTree.service.js'
import { getCandles }        from '../providers/ohlcv.provider.js'
import { logger }            from './logger.service.js'

const LOG = '[protectionPlan]'

// Operators whose comparison value is a plain price LEVEL we can hand a broker as
// a native SL/TP. A native stop/TP is a touch trigger at a price, so every
// level-style test maps cleanly: a threshold (gt/gte/lt/lte), a level cross
// ("drops below"/"breaks above" → crossBelow/crossAbove), or an exact touch
// ("hits"/"take profit at" → eq). Non-level tests (isBetween, indicator-vs-
// indicator) never reach here because their subject/value2 fail the guards below.
const PRICE_LEVEL_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'crossAbove', 'crossBelow'])

// Cross/threshold conditions are single-point events the parser tags confirmation
// 0 or 1; a broker touch trigger reproduces them. A longer hold ("stays below for
// 3 candles", confirmation ≥ 2) is NOT a touch — it must stay on the monitor.
const MAX_NATIVE_CONFIRMATION = 1

/**
 * Detect the native-offloadable price levels for an idea's stop and TP exits.
 * Broker-agnostic: returns each level (or null) plus whether the exit has any
 * conditions at all. Callers attach the levels only for brokers whose
 * `capabilities().nativeProtection` is true.
 *
 * @param {object} idea
 * @returns {Promise<{ stopLevel: number|null, tpLevel: number|null, hasStop: boolean, hasTp: boolean }>}
 */
export async function detectNativeLevels(idea) {
    const hasStop = _hasConditions(idea.stop_condition_tree, idea.stop_conditions)
    const hasTp   = _hasConditions(idea.tp_condition_tree,   idea.tp_conditions)
    const [stopLevel, tpLevel] = await Promise.all([
        hasStop ? _barePriceLevel(idea.stop_condition_tree, idea.stop_conditions) : null,
        hasTp   ? _barePriceLevel(idea.tp_condition_tree,   idea.tp_conditions)   : null,
    ])
    return { stopLevel, tpLevel, hasStop, hasTp }
}

/**
 * Detect the native-offloadable price level for an idea's ENTRY — the trigger
 * price for a broker-native stop-market entry. Same bare-price-level rule as the
 * exits: a single structured price-vs-constant touch. Returns the numeric level,
 * or null when the entry is too rich to rest at the broker (must stay monitored).
 *
 * @param {object} idea
 * @returns {Promise<number|null>}
 */
export async function detectNativeEntryLevel(idea) {
    if (!_hasConditions(idea.entry_condition_tree, idea.entry_conditions)) return null
    return _barePriceLevel(idea.entry_condition_tree, idea.entry_conditions)
}

/**
 * Best-effort current price for a symbol — the reference a native SL/TP attached
 * to a MARKET order is measured from. Returns null on any failure, so callers
 * leave that exit on the monitor rather than risk a malformed order.
 *
 * @param {string} asset
 * @param {string} [timeframe]
 * @returns {Promise<number|null>}
 */
export async function currentReferencePrice(asset, timeframe = 'day') {
    try {
        const candles = await getCandles(asset, timeframe, 2)
        const last = candles?.[candles.length - 1]
        return Number.isFinite(last?.c) ? last.c : null
    } catch (err) {
        logger.warn(LOG, `reference price unavailable for ${asset}/${timeframe}: ${err.message}`)
        return null
    }
}

// ─── internals ──────────────────────────────────────────────────────────────

function _hasConditions(tree, flat) {
    if (extractLeaves(tree).length > 0) return true
    return Array.isArray(flat) && flat.length > 0
}

/**
 * Return the price level of a *bare price-level* exit, or null if the exit is too
 * rich to offload (more than one condition, an indicator/chart/news leaf, a
 * cross-asset reference, a confirmation window, or a non price-vs-constant test).
 */
async function _barePriceLevel(tree, flat) {
    const leaves = extractLeaves(tree)
    const conds  = leaves.length ? leaves : (Array.isArray(flat) ? flat : [])
    if (conds.length !== 1) return null                 // must be a single condition

    const leaf = conds[0]
    const type = typeof leaf === 'string' ? 'structured' : (leaf?.type ?? 'structured')
    if (type !== 'structured') return null              // indicator/chart/news stay monitored
    if (leaf?.symbol) return null                       // cross-asset reference stays monitored

    const text = typeof leaf === 'string' ? leaf : leaf?.condition
    if (!text || typeof text !== 'string') return null

    const parsed = await parseCondition(text)
    if (!PRICE_LEVEL_OPS.has(parsed.operator))         return null
    if (parsed.subject !== 'close')                    return null   // price only (not an indicator)
    if (parsed.value2 != null)                         return null   // isBetween → a range, monitor it
    if ((parsed.confirmation ?? 0) > MAX_NATIVE_CONFIRMATION) return null   // multi-candle hold → monitor

    // An indicator-vs-indicator compare carries a subject string in `value`; only a
    // numeric price level can become a native SL/TP.
    if (typeof parsed.value === 'string') return null
    const level = Number(parsed.value)
    return Number.isFinite(level) ? level : null
}
