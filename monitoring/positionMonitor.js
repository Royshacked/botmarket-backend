import { evaluateTree, evaluateConditions } from './monitor.orchestrator.js'
import { logger }                            from '../services/logger.service.js'
import { brokerService }                     from '../api/broker/broker.service.js'
import { collectSymbols }                     from '../services/conditionTree.service.js'
import {
    buildSymbolMap, buildVolumeCtx, brokerCandleCtx, persistConditionStates,
    round, remainingForAccount, resolveEntryTimeframe, resolveStopTimeframe, resolveTpTimeframe,
} from './monitorUtils.js'
import { buildExitOrder, exitOrderRecord } from './exitOrders.util.js'
import { notifyManualExit, exitLegFromIdea } from '../services/manualNotify.service.js'
import { entityRepo }                       from '../services/entity/entityRepo.service.js'
import { kindForDoc }                       from '../services/entity/envelope.js'
import { deferIfClosed }                    from '../services/pendingAction/executionGate.js'

const LOG = '[positionMonitor]'

/**
 * The collaborators, injectable — the same shape Talos, coverage and the market-open sweep use.
 *
 * This module SENDS ORDERS TO A BROKER, and every branch that decides whether to send one, how big
 * it is, and whether to send it at all was unreachable from a test: the evaluators, the broker, the
 * entity writes and the off-hours gate were all module imports. It sat dormant for weeks while its
 * only caller was deleted, and went live again with no test covering a single one of those paths.
 *
 * ONLY THE IO BOUNDARY IS HERE. The pure helpers — `collectSymbols`, `buildExitOrder`,
 * `exitOrderRecord`, `remainingForAccount`, `round`, `kindForDoc`, the timeframe resolvers — stay
 * direct imports. Injecting them would let a test assert against its own arithmetic rather than the
 * real thing, which is worse than not testing them.
 */
const _deps = {
    evaluateTree,
    evaluateConditions,
    buildSymbolMap,
    buildVolumeCtx,
    // `persistConditionStates` still takes a leading `db` it does not use — the write funnels
    // through entityRepo. Absorbed here rather than threaded through the call sites so no caller
    // has to carry a handle for a parameter nobody reads.
    persistStates:  (idea, phase, states) => persistConditionStates(null, idea, phase, states),
    closePosition:  (broker, userId, accountId, positionId) => brokerService.closePosition(broker, userId, accountId, positionId),
    placeOrder:     (broker, userId, accountId, order) => brokerService.placeOrder(broker, userId, accountId, order),
    patch:          (id, fields) => entityRepo.patch(id, fields),
    update:         (id, updateDoc) => entityRepo.update(id, updateDoc),
    getById:        (id) => entityRepo.getById(id),
    notifyManualExit,
    deferIfClosed,
}
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * Check both exit legs and any additional entries for an in-position idea.
 *
 * This is the SOFTWARE exit tier: the residual leg that could not be left resting at the broker —
 * a structured candle-close compare, an indicator/chart/news/time leaf, a cross-asset reference, a
 * nested group. `protectionPlan.routeExits` decides which legs land here and which rest natively.
 *
 * It owns no schedule of its own: the loop that drives it decides when a position is due, fetches
 * the candles for each leg's timeframe, and passes them in. (The original driver was the `idea`
 * kind's monitor, deleted 2026-08-18.)
 *
 * @param {Function} onClose  callback(id, reason) — invoked for alert-only closes, meaning there is
 *                            no live broker position to send anything to. Supplied by the caller so
 *                            it can flip the entity closed and drop any per-entity scheduling state
 *                            it keeps. Everything with a real position exits through the broker (or
 *                            the off-hours queue) inside this function instead.
 */
export async function checkPosition(idea, stopCandles, tpCandles, aeCandles, onClose, deps = _deps) {
    const { id, asset } = idea

    // A close is ALREADY pending on this position — either the user has been asked to report a
    // manual exit, or the venue was shut when it tripped and the close is queued for the open.
    // Either way the decision is made and waiting on someone; re-evaluating would re-fire it every
    // poll, and could queue a SECOND leg (a stop and a target both look true on a stale candle).
    if (idea.orderState === 'awaiting_manual_close' || idea.orderState === 'awaiting_market_close') {
        logger.info(LOG, `[${id}] Close already pending (${idea.orderState}) — skipping exit checks`)
        return
    }

    const stopTf  = resolveStopTimeframe(idea)
    const tpTf    = resolveTpTimeframe(idea)
    const entryTf = resolveEntryTimeframe(idea)

    // Per-tick manual-exit alert guard, tracked EXPLICITLY (not via a mutation on the shared
    // `idea` object) so it fires once across all exit legs/slices this tick even if the idea
    // ref stops being shared in a future refactor. Cross-tick is the persisted orderState above.
    const exitCtx = { alerted: false }

    const stopFired = await _evaluateExit(idea, {
        phase: 'stop', candles: stopCandles, timeframe: stopTf,
        reason: 'stop', label: 'Stop', emoji: '🛑', native: idea.monitorStop,
    }, onClose, exitCtx, deps)
    if (stopFired) return

    const tpFired = await _evaluateExit(idea, {
        phase: 'tp', candles: tpCandles, timeframe: tpTf,
        reason: 'tp', label: 'TP', emoji: '🎯', native: idea.monitorTp,
    }, onClose, exitCtx, deps)
    if (tpFired) return

    logger.info(LOG, `💤 No exit triggered for idea ${id} (${asset}) — still in position`)

    await _checkAdditionalEntries(idea, aeCandles, entryTf, deps)
}

async function _evaluateExit(idea, { phase, candles, timeframe, reason, label, emoji, native }, onClose, exitCtx, deps) {
    const { id, asset } = idea

    if (native === false) {
        logger.info(LOG, `[${id}] ${label} handled natively by broker — skipping monitor ${reason} check`)
        return false
    }

    const residual   = idea[`${phase}MonitorTree`] ?? null
    const tree       = residual ?? idea[`${phase}_condition_tree`]
    const conditions = idea[`${phase}_conditions`]
    const crossSyms  = collectSymbols(tree, conditions)
    const symbolMap  = await deps.buildSymbolMap(id, asset, candles, timeframe, crossSyms)
    const floorAt    = idea.activatedAt ?? null
    const volCtx     = await deps.buildVolumeCtx(id, asset, idea.asset_class, tree, conditions, brokerCandleCtx(idea))

    if (residual) {
        return _evaluateResidual(idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx }, onClose, exitCtx, deps)
    }

    let triggered = false
    let which
    const states = []
    if (tree) {
        logger.info(LOG, `[${id}] Evaluating ${reason} condition tree`)
        ;({ triggered, which } = await deps.evaluateTree(tree, symbolMap, asset, floorAt, [], states, volCtx))
    } else if (Array.isArray(conditions) && conditions.length > 0) {
        const logic = idea[`${phase}_logic`] ?? 'OR'
        ;({ triggered, which } = await deps.evaluateConditions(conditions, logic, symbolMap, asset, floorAt, states))
    } else {
        logger.info(LOG, `[${id}] No ${reason} conditions defined — skipping ${reason} check`)
        return false
    }

    await deps.persistStates(idea, phase, states)

    if (triggered) {
        logger.info(LOG, `${emoji} ${label} triggered for idea ${id}: "${(which ?? '').slice(0, 60)}"`)
        await _exitNow(idea, { leg: phase, reason, quantity: null }, onClose, exitCtx, deps)
        return true
    }
    return false
}

async function _evaluateResidual(idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx }, onClose, exitCtx, deps) {
    const children = Array.isArray(residual.children) ? residual.children : []
    const fired    = new Set(idea.firedExits ?? [])
    let any = false

    for (let i = 0; i < children.length; i++) {
        const tag = `${phase}:${i}`
        if (fired.has(tag)) continue

        const child = children[i]
        const { triggered, which } = await deps.evaluateTree(child, symbolMap, asset, floorAt, [], null, volCtx)
        if (!triggered) continue

        const qty = Number(child.quantity) || null
        logger.info(LOG, `${emoji} ${label} slice ${i} triggered for idea ${idea.id}: "${(which ?? child.condition ?? '').slice(0, 60)}" (qty ${qty ?? 'full'})`)
        await _exitNow(idea, { leg: phase, reason, quantity: qty, tag }, onClose, exitCtx, deps)
        any = true
    }
    return any
}

async function _exitNow(idea, { leg, reason, quantity, tag }, onClose, exitCtx = { alerted: false }, deps = _deps) {
    // Manual (broker-less): don't close through a broker — alert the user to close at their
    // broker and report the exit price (confirmManualExit books it). Alert ONCE, not every poll /
    // every residual slice this tick: `exitCtx.alerted` is the same-tick guard (explicit, so it
    // holds even if the idea ref stops being shared); the persisted orderState guards later ticks.
    if (idea.broker === 'manual') {
        if (exitCtx.alerted || idea.orderState === 'awaiting_manual_close') return
        exitCtx.alerted     = true
        idea.orderState     = 'awaiting_manual_close'   // keep the in-memory doc consistent with the DB write
        await deps.patch(idea.id, { orderState: 'awaiting_manual_close', pendingCloseReason: reason })
        // Kind-blind loop, so the SENDER has to come from the entity: this same path closes a
        // setup, a call and a holding, and each one's exit card belongs to its own desk. `kind`
        // only picks the bot — `portfolioId` stays unset, since that field is the card's BASKET
        // (an N-leg portfolio exit), and this is always one leg.
        await deps.notifyManualExit(idea.userId, { legs: [exitLegFromIdea(idea)], reason, kind: idea.kind ?? kindForDoc(idea) })
        logger.info(LOG, `[${idea.id}] Manual exit alert sent (${reason}) — awaiting user close`)
        return
    }

    const links = (idea.brokerOrders ?? []).filter(b => b.positionId != null)

    if (links.length === 0) {
        // Bookkeeping close — there is no broker position to send anything to, so hours don't
        // gate it. The entity is simply marked closed.
        await onClose(idea.id, reason)
        return
    }

    // NOTHING EXECUTES OFF-HOURS, paper included (2026-08-07). A stop that trips while the venue is
    // shut cannot fill: a real broker would reject it, and the paper venue would "fill" it at the
    // last close, which is a price nobody could have traded.
    //
    // Same-tick + persisted guards as the manual branch above, for the same reason: the condition
    // stays true every tick until the position is gone, so without them the monitor would re-fire
    // this on every poll. (The queue's enqueue dedupe would absorb it, but a guard here means we
    // don't ask.)
    if (idea.orderState !== 'awaiting_market_close') {
        const gate = await deps.deferIfClosed({
            userId:     idea.userId,
            asset:      idea.asset,
            assetClass: idea.asset_class ?? null,
            direction:  idea.direction ?? null,
            origin: {
                kind:     idea.kind ?? kindForDoc(idea),
                entityId: idea.id,
                ref:      idea.portfolioId ?? idea.callId ?? null,
                label:    _exitLabel(reason),
            },
            // Everything needed to replay this exact close at the open — the leg it belongs to, the
            // slice size (null = the whole position) and the fired-exit tag that stops it repeating.
            action:   { type: 'exit', reason, quantity: quantity ?? null, leg: leg ?? null, tag: tag ?? null },
            // A MONITOR's decision, not the user's: it is the mechanical consequence of a stop they
            // already set, so the list does not offer to cancel it (you change it by moving the
            // stop, not by dropping the row — dropping it would just re-queue on the next tick).
            queuedBy: 'monitor',
        })
        if (gate.deferred) {
            idea.orderState = 'awaiting_market_close'
            await deps.patch(idea.id, { orderState: 'awaiting_market_close', pendingCloseReason: reason })
            logger.info(LOG, `[${idea.id}] ${leg} close deferred — market shut, queued for the open`)
            return
        }
    }

    await _closeAtBroker(idea, { leg, reason, quantity, tag }, links, deps)
}

/** How the row reads in the list. The REASON is the whole story for a monitor exit. */
function _exitLabel(reason) {
    return { stop: 'Stop hit', tp: 'Target hit', trail: 'Trailing stop' }[reason] ?? 'Monitor exit'
}

/**
 * Send the close to the broker. Split out of `_exitNow` so the queue can replay exactly this at the
 * open — one implementation, whether the stop fires in hours or waits overnight.
 */
async function _closeAtBroker(idea, { leg, reason, quantity, tag }, links, deps = _deps) {
    if (quantity == null) {
        for (const link of links) {
            try {
                await deps.closePosition(link.broker, idea.userId, link.accountId, link.positionId)
                logger.info(LOG, `[${idea.id}] Monitor close sent — ${leg} full position (acct ${link.accountId})`)
            } catch (err) {
                logger.error(LOG, `[${idea.id}] Monitor full close failed (acct ${link.accountId}): ${err.message}`)
            }
        }
        const update = { $set: { pendingCloseReason: reason } }
        if (tag) update.$addToSet = { firedExits: tag }
        await deps.update(idea.id, update)
        return
    }

    const totalQty  = Number(idea.quantity) || 0
    const newOrders = []
    for (const link of links) {
        const entryQty  = Number(link.quantity) || 0
        const factor    = (entryQty > 0 && totalQty > 0) ? entryQty / totalQty : 1
        const remaining = remainingForAccount(idea, link.accountId)
        let qty = round(quantity * factor)
        if (qty > remaining) qty = remaining
        if (!(qty > 0)) continue
        try {
            const res = await deps.placeOrder(link.broker, idea.userId, link.accountId, buildExitOrder(idea, {
                type:       'market',
                qty,
                positionId: link.positionId,
            }))
            newOrders.push(exitOrderRecord({
                accountId: String(link.accountId), broker: link.broker, leg,
                type: 'market', price: null, quantity: qty, positionId: link.positionId ?? null,
                orderId: res?.orderId != null ? String(res.orderId) : null,
            }))
            logger.info(LOG, `[${idea.id}] Monitor close sent — ${leg} ${qty} market (acct ${link.accountId})`)
        } catch (err) {
            logger.error(LOG, `[${idea.id}] Monitor close failed (acct ${link.accountId}): ${err.message}`)
        }
    }

    const update = {}
    if (newOrders.length) update.$push     = { exitOrders: { $each: newOrders } }
    if (tag)              update.$addToSet = { firedExits: tag }
    if (Object.keys(update).length) await deps.update(idea.id, update)
}

/**
 * Replay a close that was queued because its venue was shut — the queued list's Execute.
 *
 * Goes through the SAME `_closeAtBroker` the live path uses, so an overnight stop and an in-hours
 * stop place identical orders. Re-reads the entity rather than trusting the queued snapshot: hours
 * passed, and the position may have been closed, partly filled or reconciled since.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function executeDeferredClose(entityId, userId, { leg = null, reason = 'manual', quantity = null, tag = null } = {}, deps = _deps) {
    const idea = await deps.getById(entityId)
    if (!idea || (idea.userId && idea.userId !== userId)) return { ok: false, reason: 'not_found' }

    const links = (idea.brokerOrders ?? []).filter(b => b.positionId != null)
    // Closed in the meantime — by the user, by the reconciler, by the broker. Not a failure: the
    // thing the queued row asked for has already happened.
    if (links.length === 0) {
        await deps.patch(entityId, { orderState: null })
        return { ok: true, reason: 'already_closed' }
    }

    await _closeAtBroker(idea, { leg, reason, quantity, tag }, links, deps)
    await deps.patch(entityId, { orderState: null })
    return { ok: true }
}

async function _checkAdditionalEntries(idea, candles, entryTf, deps) {
    const entries = idea.additional_entries
    if (!Array.isArray(entries) || entries.length === 0) return

    for (let i = 0; i < entries.length; i++) {
        const ae = entries[i]

        if (ae.filledAt) continue
        if (ae.triggeredAt) break

        const crossSyms = collectSymbols(ae.condition_tree, ae.conditions)
        const symbolMap = await deps.buildSymbolMap(idea.id, idea.asset, candles, entryTf, crossSyms)

        let triggered = false
        if (ae.condition_tree) {
            ;({ triggered } = await deps.evaluateTree(ae.condition_tree, symbolMap, idea.asset, idea.activatedAt ?? null))
        } else if (Array.isArray(ae.conditions) && ae.conditions.length > 0) {
            ;({ triggered } = await deps.evaluateConditions(ae.conditions, ae.logic ?? 'AND', symbolMap, idea.asset, idea.activatedAt ?? null))
        } else {
            break
        }

        if (triggered) {
            logger.info(LOG, `📈 Additional entry ${i + 1} triggered for idea ${idea.id} — qty: ${ae.quantity}`)
            await deps.patch(idea.id, { [`additional_entries.${i}.triggeredAt`]: Date.now() })
        }
        break
    }
}
