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
import { getCandles }                            from './ohlcv.service.js'
import { toNum }                                 from './format.util.js'
import { logger }                                from './logger.service.js'
import { isSelfExecuted }                        from './venue.resolve.service.js'

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
    // A `setup` states its exits as ZONES, not condition trees, so there are no leaves to inspect
    // and nothing to leave on the monitor — every zone edge is a price, which is precisely what
    // rests at the broker. Routing it through the tree path returned an empty plan, which is how a
    // confirmed setup came to place a NAKED entry: no nativeExit, no monitorStop/Tp, and
    // placeExits no-opping because `idea.nativeExit` was undefined.
    //
    // Dispatched HERE rather than at the call site so the execution path stays kind-blind — it asks
    // one function for a routing and gets the same shape back whatever authored the exits.
    if (idea?.kind === 'setup') return _warnUnmonitored(idea, routeSetupZones(idea))

    const totalQty = Number(idea.quantity) || 0
    const [stop, tp] = await Promise.all([
        _routeLeg(idea.stop_condition_tree, idea.stop_conditions, totalQty),
        _routeLeg(idea.tp_condition_tree,   idea.tp_conditions,   totalQty),
    ])
    return _warnUnmonitored(idea, { stop, tp })
}

/**
 * WHICH EDGE of a zone becomes the order price: **the edge FURTHER FROM ENTRY**, on both legs.
 *
 *   long  → stop `lower`, tp `upper`     short → mirrored.
 *
 * The stop takes the far side so the zone has room to be a zone rather than a hair trigger. The tp
 * takes the far side because THE FAR SIDE IS THE TARGET THE USER NAMED — a tp zone is not a fuzzy
 * area the target lives somewhere inside, it is that target plus a stretch of price beneath it in
 * which Talos may propose taking something off (docs/desks/mentor-talos.md §"Exits — the TP window",
 * setup.schema.targetWindows).
 *
 * THIS USED TO REST THE TP ON THE NEAR EDGE, which is the same edge `setup.schema.targetEdges` wakes
 * Talos on — so the limit filled at the exact instant the `scale_out` gate tripped, and "sell only
 * half" was always a proposal about a position that was already flat. The window between the two is
 * the whole feature.
 *
 * R:R is deliberately NOT re-based to match. `computeRR` still prices the reward to the near edge —
 * now the level where Talos ASKS rather than where the trade exits — because that is the honest
 * worst case if the user banks at the first ask every time, and an R:R must never flatter.
 */
export function zoneExitLevel(zone, isLong, which = 'stop') {
    const takeLower = which === 'tp' ? !isLong : isLong
    const level     = takeLower ? zone?.lower : zone?.upper
    return Number.isFinite(level) ? level : null
}

/**
 * A setup's stop/tp ZONES → the same LegRouting shape the tree path returns, so `exitFields`,
 * `placeExits` and the reconciler consume it untouched.
 *
 * `monitorTree` is always null: there is no residual software-monitored condition, because a zone
 * IS a price. Every leg rests at the broker, which is what protects a position nobody is watching.
 *
 * Quantities come from the SAME rule the tree path uses (`_assignSlotQuantities`): an explicit
 * per-zone quantity wins, and the rest split the remainder equally with the residue going to the
 * first defaulted slot. So multi-target scale-outs behave identically whichever kind authored them.
 * Pure — no IO, unlike the tree path which may fetch candles to resolve a leaf.
 */
export function routeSetupZones(setup) {
    const isLong   = setup?.direction === 'long'
    const totalQty = Number(setup?.quantity) || 0

    const leg = (zones, which) => {
        const list = (Array.isArray(zones) ? zones : []).filter(z => Number.isFinite(zoneExitLevel(z, isLong, which)))
        if (!list.length) return { single: null, nativeOrders: [], monitorTree: null, hasAny: false }

        const quantities = _assignSlotQuantities(list, totalQty)
        const nativeOrders = list
            .map((z, i) => ({ level: zoneExitLevel(z, isLong, which), quantity: quantities[i] }))
            // A zero-quantity leg would be sent to the broker as an order for nothing.
            .filter(o => o.quantity > 0)
        return { single: null, nativeOrders, monitorTree: null, hasAny: nativeOrders.length > 0 }
    }

    return { stop: leg(setup?.stop_zones, 'stop'), tp: leg(setup?.tp_zones, 'tp') }
}

/**
 * WHICH LEGS OF THIS ROUTING NOTHING WILL EVALUATE.
 *
 * Routing a leg to "the software monitor" is a promise, and right now the app cannot keep it:
 * `positionMonitor.checkPosition` — the only code that evaluates a stop/TP condition tree for an
 * entity already in a position — has NO CALLER. Minos was its only one, and Minos was deleted on
 * 2026-08-18 (server.js). Nothing replaced it for the `idea` kind; Talos polls `setup` only, and a
 * setup is protected by broker-resting orders built from its zones, not by a tree.
 *
 * So a user can author a stop that isn't a plain price level, have it accepted, stored, and shown
 * as protection — and have it never once evaluated. THE AUTHORING PATH IS VERY MUCH ALIVE: every
 * placement call site runs `routeExits`, and it will happily hand back a `monitorTree`.
 *
 * TWO WAYS A LEG ENDS UP HERE:
 *   • `monitorTree` — the residual non-touch leaves (structured candle-close compares, indicator /
 *     chart / news / time, cross-asset, nested groups). The broker cannot rest these; the monitor
 *     was the only thing that could read them.
 *   • MANUAL, non-portfolio — a manual position has no venue to rest ANYTHING at, so
 *     `confirmManualEntry` puts the WHOLE leg on the monitor (`monitorStop = hasAny`) and writes no
 *     residual tree. Touch or not, the monitor owns it. Portfolio legs are excluded because manual
 *     mode §4b puts their exits in the user's hands deliberately, not by accident.
 *
 * This is a SIGNAL, not a refusal. Refusing the placement would leave a position open at the broker
 * with its exits rejected, which is worse than the hole it reports. The fix is an owner for
 * checkPosition — a kind-blind exit loop, the way `marketOpen` is kind-blind. Until that ships this
 * turns a silent failure into a loud one. DELETE THIS GUARD WHEN THAT LOOP LANDS.
 *
 * Exported so the condition can be asserted directly in tests. No I/O — the one thing it reads
 * beyond its arguments is the venue's capability table, which is a static registry lookup.
 *
 * @param {object} idea
 * @param {{stop: object, tp: object}} routing
 * @returns {{leg: string, why: 'residual'|'manual'}[]}
 */
export function unmonitoredExitLegs(idea, routing) {
    // A self-executed PORTFOLIO leg is monitor-less on purpose (manualIdea.service: `monitored`), so
    // it is not a hole. Mirrored here rather than re-derived, or this warns on every portfolio add.
    const manualOwned = isSelfExecuted(idea?.broker) && !idea?.portfolioId
    const out = []
    for (const leg of ['stop', 'tp']) {
        const r = routing?.[leg]
        if (!r) continue
        if (r.monitorTree)                out.push({ leg, why: 'residual' })
        else if (manualOwned && r.hasAny) out.push({ leg, why: 'manual' })
    }
    return out
}

/** Log the above and pass the routing straight through, so it can wrap a `return`. */
function _warnUnmonitored(idea, routing) {
    const orphaned = unmonitoredExitLegs(idea, routing)
    if (orphaned.length) {
        logger.error(LOG, 'UNWATCHED EXIT — nothing evaluates the software monitor (checkPosition has no caller). ' +
            `entity=${idea?.id ?? '?'} kind=${idea?.kind ?? 'idea'} asset=${idea?.asset ?? '?'} ` +
            `broker=${idea?.broker ?? 'none'} legs=${orphaned.map(o => o.leg + ':' + o.why).join(',')}`)
    }
    return routing
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
        const take = _round4(Math.min(out[i], left))
        if (take < out[i]) {
            logger.warn(LOG, `exit leg over-allocated — slot ${i} asked ${out[i]} of a ${cap} position, ${left} left; trimmed to ${take}`)
        }
        out[i] = take
        left   = _round4(left - take)
    }

    // Whatever the explicit rungs left over is shared equally by the rungs that didn't say, with
    // the residue going to the first — the assistant's own "divide equally, residue first" rule.
    const defaultIdx = out.map((q, i) => (q == null ? i : -1)).filter(i => i >= 0)
    if (defaultIdx.length > 0) {
        const base  = Math.floor((left / defaultIdx.length) * 10000) / 10000
        let residue = _round4(left - base * defaultIdx.length)
        for (const i of defaultIdx) {
            out[i]  = _round4(base + residue)
            residue = 0
        }
    }
    return out.map(q => q ?? 0)
}

const _round4 = (n) => Math.round(n * 10000) / 10000

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
