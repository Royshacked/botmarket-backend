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

import { parseCondition }                       from '../monitoring/parsers/condition.parser.js'
import { extractLeaves, resolveConditionTree }   from './conditionTree.service.js'
import { getCandles }                            from '../providers/ohlcv.provider.js'
import { logger }                                from './logger.service.js'

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

/**
 * Route an idea's stop and TP exits into three buckets per leg:
 *   • single      a lone bare price-touch leg → keep it on the entry order's native
 *                 SL/TP (the existing, live-verified path). `number | null`.
 *   • nativeOrders[{level, quantity}]  the bare price-touch levels of a MULTI-leaf
 *                 leg → each becomes its own broker order (LIMIT for tp, STOP for
 *                 stop) placed when the position opens. Quantities are in the idea's
 *                 own units (main-account scale); callers scale them per account.
 *   • monitorTree the residual OR-group of leaves that AREN'T bare price touches
 *                 (indicator/chart/news, ranges, multi-candle holds, cross-asset,
 *                 or nested groups) → stay on the software monitor, which now sends
 *                 the close order itself when one of them triggers. `object | null`.
 *
 * Order type is forced by geometry, not by leg: a TP rests as a LIMIT (profit side),
 * a stop as a STOP-market (loss side). Routing here is symmetric for stop and TP.
 *
 * @param {object} idea
 * @returns {Promise<{ stop: LegRouting, tp: LegRouting }>}
 *   LegRouting = { single:number|null, nativeOrders:{level:number,quantity:number}[],
 *                  monitorTree:object|null, hasAny:boolean }
 */
export async function routeExits(idea) {
    const totalQty = Number(idea.quantity) || 0
    const [stop, tp] = await Promise.all([
        _routeLeg(idea.stop_condition_tree, idea.stop_conditions, totalQty),
        _routeLeg(idea.tp_condition_tree,   idea.tp_conditions,   totalQty),
    ])
    return { stop, tp }
}

// ─── internals ──────────────────────────────────────────────────────────────

function _hasConditions(tree, flat) {
    if (extractLeaves(tree).length > 0) return true
    return Array.isArray(flat) && flat.length > 0
}

function _isLeaf(node) {
    return !!node && typeof node === 'object' && typeof node.condition === 'string'
}

/** Route one exit leg (stop or tp). See routeExits() for the bucket semantics. */
async function _routeLeg(tree, flat, totalQty) {
    const group = resolveConditionTree(tree, flat, 'OR')
    if (!group) return { single: null, nativeOrders: [], monitorTree: null, hasAny: false }

    const children = group.children

    // Single-leaf leg → preserve the attached-SL/TP path (a lone bare price level)
    // or leave a lone non-price leaf entirely on the monitor.
    if (children.length === 1) {
        const lvl = _isLeaf(children[0]) ? await _leafBareLevel(children[0]) : null
        if (lvl != null) return { single: lvl, nativeOrders: [], monitorTree: null, hasAny: true }
        return { single: null, nativeOrders: [], monitorTree: group, hasAny: true }
    }

    // Multi-leaf leg → route each top-level child independently. Each child gets a
    // quantity (its own, or an equal split of the total) so native + monitored
    // slices together exit the full position.
    const quantities   = _assignSlotQuantities(children, totalQty)
    const nativeOrders = []
    const monitored    = []
    for (let i = 0; i < children.length; i++) {
        const child = children[i]
        const lvl   = _isLeaf(child) ? await _leafBareLevel(child) : null
        if (lvl != null) {
            nativeOrders.push({ level: lvl, quantity: quantities[i] })
        } else {
            // Annotate the residual leaf/group with its resolved quantity so the
            // monitor knows how much to close when it fires.
            monitored.push({ ...child, quantity: quantities[i] })
        }
    }
    const monitorTree = monitored.length ? { operator: group.operator, children: monitored } : null
    return { single: null, nativeOrders, monitorTree, hasAny: true }
}

/**
 * Resolve a quantity for each top-level child of an exit leg. A child's explicit
 * `quantity` wins; the remaining children share the leftover equally, with any
 * residue going to the first defaulted slot — mirroring the assistant's
 * "divide total equally, residue to the first leaf" rule.
 */
function _assignSlotQuantities(children, totalQty) {
    const explicit    = children.map(c => Number(c?.quantity) || null)
    const assignedSum = explicit.reduce((s, q) => s + (q ?? 0), 0)
    const defaultIdx  = explicit.map((q, i) => (q == null ? i : -1)).filter(i => i >= 0)
    const out         = explicit.slice()

    if (defaultIdx.length > 0) {
        const remaining = Math.max(0, totalQty - assignedSum)
        const base      = Math.floor((remaining / defaultIdx.length) * 10000) / 10000
        let residue     = Math.round((remaining - base * defaultIdx.length) * 10000) / 10000
        for (const i of defaultIdx) {
            out[i] = Math.round((base + residue) * 10000) / 10000
            residue = 0
        }
    }
    return out.map(q => q ?? 0)
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
    return _leafBareLevel(conds[0])
}

/**
 * The price level of a single leaf when it is a *bare price touch* — a structured
 * close-vs-constant test (gt/gte/lt/lte/eq/cross) with confirmation ≤1, no
 * cross-asset symbol, no range, and a numeric level. Otherwise null: the leaf is
 * too rich for a touch trigger and must stay on the monitor.
 */
async function _leafBareLevel(leaf) {
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
