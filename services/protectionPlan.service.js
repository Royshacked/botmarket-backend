/**
 * Protection planner — decides which of an idea's stop / take-profit (and entry)
 * conditions can be offloaded to the broker as resting orders versus left on the
 * software monitor.
 *
 * The leaf TYPE is the single source of truth: only a `touch` leaf — a pure price
 * level the assistant marked as an intra-candle trigger — rests at the broker (a
 * closing STOP/LIMIT for exits, a stop-market for entry). Everything else
 * (structured candle-close compares, indicator/chart/news/time, cross-asset
 * references, nested groups) stays on the monitor, the only thing that can evaluate
 * it. This replaces the old heuristic that inspected the parsed operator/subject/
 * confirmation — the assistant now decides touch-vs-close explicitly.
 *
 * Per the unified-broker design this module is broker-agnostic: it only computes
 * the price levels. The capability to rest orders comes from the adapter; callers
 * gate on that and place the closing orders themselves.
 */

import { parseCondition }                       from '../monitoring/parsers/condition.parser.js'
import { extractLeaves, resolveConditionTree }   from './conditionTree.service.js'
import { getCandles }                            from '../providers/ohlcv.provider.js'
import { logger }                                from './logger.service.js'

const LOG = '[protectionPlan]'

/**
 * Detect the native-offloadable price level for an idea's ENTRY — the trigger
 * price for a broker-native stop-market entry. A single `touch` leaf rests at the
 * broker; anything richer (extra conditions, indicator/chart/news, cross-asset)
 * stays on the monitor. Returns the numeric level, or null when not offloadable.
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
 * Route an idea's stop and TP exits into buckets per leg:
 *   • single      always null. Retained in the shape for callers; touches no longer
 *                 ride an attached SL/TP (unreliable on a hedging account) — every
 *                 touch is a positionId closing order via nativeOrders.
 *   • nativeOrders[{level, quantity}]  every `touch` level in the leg (single OR
 *                 multi) → each becomes its own broker closing order (LIMIT for tp,
 *                 STOP for stop) placed when the position opens. Quantities are in the
 *                 idea's own units (main-account scale); callers scale them per account.
 *   • monitorTree the residual OR-group of leaves that AREN'T touches (structured
 *                 candle-close compares, indicator/chart/news/time, cross-asset, or
 *                 nested groups) → stay on the software monitor, which sends the close
 *                 order itself when one of them triggers. `object | null`.
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

    // Every `touch` leaf rests at the broker as its OWN closing order — single or
    // multi, treated identically. Each non-touch leaf/group stays on the software
    // monitor. Each child gets a quantity (its own, or an equal split of the total)
    // so the broker-rested + monitored slices together exit the full position.
    // `single` is kept in the shape for callers but is always null now: touches no
    // longer ride an attached SL/TP (unreliable on a hedging account) — they are
    // always positionId closing orders, like the multi-level case always was.
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
 * Return the price level of an offloadable single-leaf exit (a lone `touch` leg),
 * or null if the leg has more than one condition or its sole leaf isn't a touch.
 */
async function _barePriceLevel(tree, flat) {
    const leaves = extractLeaves(tree)
    const conds  = leaves.length ? leaves : (Array.isArray(flat) ? flat : [])
    if (conds.length !== 1) return null                 // must be a single condition
    return _leafBareLevel(conds[0])
}

/**
 * The price level of a leaf when it is a `touch` — a pure price level the broker can
 * rest as a native order (a closing STOP/LIMIT for exits, a stop-market for entry).
 * The leaf type is the single source of truth: the assistant decides touch (intra-
 * candle trigger) vs structured (candle-close comparison). Only the broker symbol,
 * a numeric level, and the absence of a cross-asset reference are still required.
 * Anything that isn't a touch returns null and stays on the monitor.
 */
async function _leafBareLevel(leaf) {
    const type = typeof leaf === 'string' ? 'structured' : (leaf?.type ?? 'structured')
    if (type !== 'touch') return null                   // structured/indicator/chart/news/time → monitor
    if (leaf?.symbol) return null                       // cross-asset reference can't close THIS position

    const text = typeof leaf === 'string' ? leaf : leaf?.condition
    if (!text || typeof text !== 'string') return null

    // The parser turns "price touches 505" into a numeric level in `value`. A string
    // value (indicator-vs-indicator) can't be a price level, so it can't be a touch.
    const parsed = await parseCondition(text)
    if (typeof parsed.value === 'string') return null
    const level = Number(parsed.value)
    return Number.isFinite(level) ? level : null
}
