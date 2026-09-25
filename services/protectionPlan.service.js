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
import { toNum }                                 from './format.util.js'
import { logger }                                from './logger.service.js'
// The ONE rule for what price a leg acts at — shared with `stopEdge` and the journal, so the
// working stop, the order that rests and the line the record reports can never be three answers.
import { legPrice }                              from './setup.schema.js'
import { round4 }                                from './number.util.js'

const LOG = '[protectionPlan]'

/**
 * A bare price level → the single `touch` leaf that expresses it. The WRITER paired with
 * `_leafBareLevel` below (the reader): both live here so the phrasing the parser must
 * understand and the phrasing we emit can never drift apart. Callers that already hold a
 * number — a confirmed Kairos call, a discretionary ticket — use this instead of hand-
 * rolling the sentence, which is how a leaf came to be typed `structured` by accident and
 * silently routed to the software monitor rather than resting at the broker.
 *
 * A LADDER states how much comes off at each rung; a single level does not have to, and an
 * absent `quantity` is the claim "this rung is the whole position" — which is what
 * _assignSlotQuantities then splits across the rungs that didn't say. Writing a 0 or a null
 * would be a different claim entirely, so only a real slice is stamped.
 *
 * @param {number} level
 * @param {number} [quantity]  the slice this rung closes; omitted = share of the remainder
 * @returns {{ condition: string, type: 'touch', timeframe: null, quantity?: number }}
 */
export function touchLeaf(level, quantity) {
    const leaf = { condition: `price touches ${level}`, type: 'touch', timeframe: null }
    if (Number(quantity) > 0) leaf.quantity = Number(quantity)
    return leaf
}

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
 * Route an idea's stop and TP exits into buckets per leg:
 *   • nativeOrders[{level, quantity}]  every `touch` level in the leg (one or many) → each
 *                 becomes its own broker closing order (LIMIT for tp,
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
 *   LegRouting = { nativeOrders:{level:number,quantity:number}[],
 *                  monitorTree:object|null, hasAny:boolean }
 */
export async function routeExits(idea) {
    // A `setup` states its exits as PRICED LEGS, not condition trees, so there are no leaves to
    // inspect and nothing to leave on the monitor — a leg IS the price that rests at the broker.
    // Routing it through the tree path returned an empty plan, which is how a
    // confirmed setup came to place a NAKED entry: no nativeExit, no monitorStop/Tp, and
    // placeExits no-opping because `idea.nativeExit` was undefined.
    //
    // Dispatched HERE rather than at the call site so the execution path stays kind-blind — it asks
    // one function for a routing and gets the same shape back whatever authored the exits.
    if (idea?.kind === 'setup') return routeSetupLegs(idea)

    const totalQty = Number(idea.quantity) || 0
    const [stop, tp] = await Promise.all([
        _routeLeg(idea.stop_condition_tree, idea.stop_conditions, totalQty),
        _routeLeg(idea.tp_condition_tree,   idea.tp_conditions,   totalQty),
    ])
    return { stop, tp }
}

/**
 * A setup's stop/tp ZONES → the same LegRouting shape the tree path returns, so `exitFields`,
 * `placeExits` and the reconciler consume it untouched.
 *
 * `monitorTree` is always null, and stays null now that a leg may carry CONDITIONS. An exit
 * condition is a SENTENCE the model judges on its next read — the same thing an entry condition is
 * — not a tree for software to resolve. Nothing here evaluates it and nothing here should: this
 * function's whole job is the order that rests at the broker.
 *
 * ── THE RULE A CONDITION MAY NOT BEND ────────────────────────────────────────
 * **A stop ALWAYS rests, conditions or not.** A condition on a stop is a DISCRETIONARY exit —
 * "out if it closes below the 4hr VWAP" — and it may only ever tighten the exit, never replace it.
 * Talos proposes and never fires (every verdict is a card the user confirms), so a conditional stop
 * that was the only protection would leave a live position naked whenever the model is late, the
 * process is down, the market gaps, or the user is simply asleep. The broker order is what makes
 * that impossible rather than merely unlikely.
 *
 * ── …AND THE MIRROR RULE, WHICH POINTS THE OTHER WAY ─────────────────────────
 * **A CONDITIONAL TP DOES NOT REST.** Resting a limit at the target makes its condition dead
 * letter: the order fills the moment price prints there, whatever the condition said, so
 * "take 330 only if volume confirms" would take 330 on no volume at all. A conditional target is a
 * DISCRETIONARY exit the model proposes and the user confirms; there is nothing for the broker to
 * hold.
 *
 * The two rules look contradictory and are the same rule — **fail in the safe direction**. For a
 * stop the safe failure is exiting anyway, so the order always rests. For a target the safe failure
 * is NOT exiting, so it must not. The position is protected by the stop either way, which is what
 * makes the target's the cheaper mistake.
 *
 * Quantities come from the SAME rule the tree path uses (`_assignSlotQuantities`): an explicit
 * per-leg quantity wins, and the rest split the remainder equally with the residue going to the
 * first defaulted slot. So multi-target scale-outs behave identically whichever kind authored them.
 * Pure — no IO, unlike the tree path which may fetch candles to resolve a leaf.
 */
export function routeSetupLegs(setup) {
    const totalQty = Number(setup?.quantity) || 0

    const route = (legs, which) => {
        const all = (Array.isArray(legs) ? legs : []).filter(z => Number.isFinite(legPrice(z)))
        // Quantities are assigned over EVERY authored leg, before any are held back: a conditional
        // target still owns its share of the position. Splitting only the resting ones would hand
        // the whole size to whichever targets happened to be unconditional.
        const quantities = _assignSlotQuantities(all, totalQty)

        const list = all
            .map((z, i) => ({ level: legPrice(z), quantity: quantities[i], conditions: z?.conditions ?? [] }))
            // THE ASYMMETRY, in one line. A stop rests whatever it carries; a target with conditions
            // is the model's to propose and must not be pre-empted by its own limit order.
            .filter(o => which === 'stop' || !o.conditions.length)
            // A zero-quantity leg would be sent to the broker as an order for nothing.
            .filter(o => o.quantity > 0)

        const nativeOrders = list.map(({ level, quantity }) => ({ level, quantity }))
        return { nativeOrders, monitorTree: null, hasAny: nativeOrders.length > 0 }
    }

    return { stop: route(setup?.stop_legs, 'stop'), tp: route(setup?.target_legs, 'tp') }
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
    if (!group) return { nativeOrders: [], monitorTree: null, hasAny: false }

    const children = group.children

    // Every `touch` leaf rests at the broker as its OWN closing order — single or
    // multi, treated identically. Each non-touch leaf/group stays on the software
    // monitor. Each child gets a quantity (its own, or an equal split of the total)
    // so the broker-rested + monitored slices together exit the full position.
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
    return { nativeOrders, monitorTree, hasAny: true }
}

/**
 * Resolve a quantity for each top-level child of an exit leg. A child's explicit
 * `quantity` wins; the remaining children share the leftover equally, with any
 * residue going to the first defaulted slot — mirroring the assistant's
 * "divide total equally, residue to the first leaf" rule.
 */
function _assignSlotQuantities(children, totalQty) {
    const out  = children.map(c => Number(c?.quantity) || null)
    const cap  = Math.max(0, Number(totalQty) || 0)
    let   left = cap

    // THE LEG CAN NEVER ASK FOR MORE THAN THE POSITION. Its slots are alternatives that each close
    // part of ONE position, so they sum to it at most: three 50-lot stops behind a 100-lot position
    // would close 150, and on a hedging account the excess does not bounce off — it OPENS a
    // position the other way, which is the opposite of what a stop is for.
    //
    // It has to be caught here, at allocation. The reconciler's _resyncExits asks whether ONE order
    // is bigger than what remains, and every one of those three is comfortably under; a ladder that
    // over-sums is invisible to it. Slots claim in the order they were authored and each takes what
    // is left, so a rung that would overrun is trimmed to the rest of the position (or to nothing,
    // and placeExits drops a zero) rather than the whole leg being refused — a stop is more useful
    // partially sized than not placed.
    for (let i = 0; i < out.length; i++) {
        if (out[i] == null) continue
        const take = round4(Math.min(out[i], left))
        if (take < out[i]) {
            logger.warn(LOG, `exit leg over-allocated — slot ${i} asked ${out[i]} of a ${cap} position, ${left} left; trimmed to ${take}`)
        }
        out[i] = take
        left   = round4(left - take)
    }

    // Whatever the explicit rungs left over is shared equally by the rungs that didn't say, with
    // the residue going to the first — the assistant's own "divide equally, residue first" rule.
    const defaultIdx = out.map((q, i) => (q == null ? i : -1)).filter(i => i >= 0)
    if (defaultIdx.length > 0) {
        const base  = Math.floor((left / defaultIdx.length) * 10000) / 10000
        let residue = round4(left - base * defaultIdx.length)
        for (const i of defaultIdx) {
            out[i]  = round4(base + residue)
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
    // Defense-in-depth: only a PRICE subject can rest at the broker as a price level.
    // A non-price subject (volume, an indicator) parses to a finite number too, so
    // guard against a mis-typed leaf turning e.g. "volume > 2000000" into a $2M order.
    if (parsed.subject && !['close', 'open', 'high', 'low'].includes(parsed.subject)) return null
    // toNum, NOT Number(). `parsed.value` is null whenever the parse failed or came back `unknown`,
    // and `Number(null)` is 0 — which is finite, so the old guard PASSED it and this returned a
    // price level of ZERO. Nothing downstream questions it: the leaf is reported as offloadable and
    // a stop (or a stop-market ENTRY, via detectNativeEntryLevel) is built to rest at 0.
    //
    // The failure is silent end to end. parseCondition catches its own errors and returns `unknown`,
    // so an unreachable parser — a missing API key, a rate limit, a timeout — reads exactly like a
    // condition nobody could interpret, and the leg that should have fallen back to the software
    // monitor rests a nonsense order at the broker instead. `> 0` on top because a price level of
    // zero is never a real answer for anything this routes, however it was arrived at.
    const level = toNum(parsed.value)
    return (level !== null && level > 0) ? level : null
}
