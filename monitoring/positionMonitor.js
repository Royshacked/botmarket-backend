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

const LOG = '[positionMonitor]'

/**
 * Check both exit legs and any additional entries for an in-position idea.
 * @param {Function} onClose  callback(id, reason) — invoked for alert-only closes
 *                            (no live broker position); provided by minos.monitor.service.js
 *                            so it can clean up `_lastChecked`.
 */
export async function checkPosition(db, idea, stopCandles, tpCandles, aeCandles, onClose) {
    const { id, asset } = idea

    // Manual idea already alerted for a close — waiting on the user's reported exit price.
    // Don't re-evaluate exits (which would re-alert every poll) until they confirm.
    if (idea.orderState === 'awaiting_manual_close') {
        logger.info(LOG, `[${id}] Awaiting user manual close — skipping exit checks`)
        return
    }

    const stopTf  = resolveStopTimeframe(idea)
    const tpTf    = resolveTpTimeframe(idea)
    const entryTf = resolveEntryTimeframe(idea)

    // Per-tick manual-exit alert guard, tracked EXPLICITLY (not via a mutation on the shared
    // `idea` object) so it fires once across all exit legs/slices this tick even if the idea
    // ref stops being shared in a future refactor. Cross-tick is the persisted orderState above.
    const exitCtx = { alerted: false }

    const stopFired = await _evaluateExit(db, idea, {
        phase: 'stop', candles: stopCandles, timeframe: stopTf,
        reason: 'stop', label: 'Stop', emoji: '🛑', native: idea.monitorStop,
    }, onClose, exitCtx)
    if (stopFired) return

    const tpFired = await _evaluateExit(db, idea, {
        phase: 'tp', candles: tpCandles, timeframe: tpTf,
        reason: 'tp', label: 'TP', emoji: '🎯', native: idea.monitorTp,
    }, onClose, exitCtx)
    if (tpFired) return

    logger.info(LOG, `💤 No exit triggered for idea ${id} (${asset}) — still in position`)

    await _checkAdditionalEntries(db, idea, aeCandles, entryTf)
}

async function _evaluateExit(db, idea, { phase, candles, timeframe, reason, label, emoji, native }, onClose, exitCtx) {
    const { id, asset } = idea

    if (native === false) {
        logger.info(LOG, `[${id}] ${label} handled natively by broker — skipping monitor ${reason} check`)
        return false
    }

    const residual   = idea[`${phase}MonitorTree`] ?? null
    const tree       = residual ?? idea[`${phase}_condition_tree`]
    const conditions = idea[`${phase}_conditions`]
    const crossSyms  = collectSymbols(tree, conditions)
    const symbolMap  = await buildSymbolMap(id, asset, candles, timeframe, crossSyms)
    const floorAt    = idea.activatedAt ?? null
    const volCtx     = await buildVolumeCtx(id, asset, idea.asset_class, tree, conditions, brokerCandleCtx(idea))

    if (residual) {
        return _evaluateResidual(db, idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx }, onClose, exitCtx)
    }

    let triggered = false
    let which
    const states = []
    if (tree) {
        logger.info(LOG, `[${id}] Evaluating ${reason} condition tree`)
        ;({ triggered, which } = await evaluateTree(tree, symbolMap, asset, floorAt, [], states, volCtx))
    } else if (Array.isArray(conditions) && conditions.length > 0) {
        const logic = idea[`${phase}_logic`] ?? 'OR'
        ;({ triggered, which } = await evaluateConditions(conditions, logic, symbolMap, asset, floorAt, states))
    } else {
        logger.info(LOG, `[${id}] No ${reason} conditions defined — skipping ${reason} check`)
        return false
    }

    await persistConditionStates(db, idea, phase, states)

    if (triggered) {
        logger.info(LOG, `${emoji} ${label} triggered for idea ${id}: "${(which ?? '').slice(0, 60)}"`)
        await _exitNow(db, idea, { leg: phase, reason, quantity: null }, onClose, exitCtx)
        return true
    }
    return false
}

async function _evaluateResidual(db, idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx }, onClose, exitCtx) {
    const children = Array.isArray(residual.children) ? residual.children : []
    const fired    = new Set(idea.firedExits ?? [])
    let any = false

    for (let i = 0; i < children.length; i++) {
        const tag = `${phase}:${i}`
        if (fired.has(tag)) continue

        const child = children[i]
        const { triggered, which } = await evaluateTree(child, symbolMap, asset, floorAt, [], null, volCtx)
        if (!triggered) continue

        const qty = Number(child.quantity) || null
        logger.info(LOG, `${emoji} ${label} slice ${i} triggered for idea ${idea.id}: "${(which ?? child.condition ?? '').slice(0, 60)}" (qty ${qty ?? 'full'})`)
        await _exitNow(db, idea, { leg: phase, reason, quantity: qty, tag }, onClose, exitCtx)
        any = true
    }
    return any
}

async function _exitNow(db, idea, { leg, reason, quantity, tag }, onClose, exitCtx = { alerted: false }) {
    // Manual (broker-less): don't close through a broker — alert the user to close at their
    // broker and report the exit price (confirmManualExit books it). Alert ONCE, not every poll /
    // every residual slice this tick: `exitCtx.alerted` is the same-tick guard (explicit, so it
    // holds even if the idea ref stops being shared); the persisted orderState guards later ticks.
    if (idea.broker === 'manual') {
        if (exitCtx.alerted || idea.orderState === 'awaiting_manual_close') return
        exitCtx.alerted     = true
        idea.orderState     = 'awaiting_manual_close'   // keep the in-memory doc consistent with the DB write
        await entityRepo.patch(idea.id, { orderState: 'awaiting_manual_close', pendingCloseReason: reason })
        await notifyManualExit(idea.userId, { legs: [exitLegFromIdea(idea)], reason })
        logger.info(LOG, `[${idea.id}] Manual exit alert sent (${reason}) — awaiting user close`)
        return
    }

    const links = (idea.brokerOrders ?? []).filter(b => b.positionId != null)

    if (links.length === 0) {
        await onClose(idea.id, reason)
        return
    }

    if (quantity == null) {
        for (const link of links) {
            try {
                await brokerService.closePosition(link.broker, idea.userId, link.accountId, link.positionId)
                logger.info(LOG, `[${idea.id}] Monitor close sent — ${leg} full position (acct ${link.accountId})`)
            } catch (err) {
                logger.error(LOG, `[${idea.id}] Monitor full close failed (acct ${link.accountId}): ${err.message}`)
            }
        }
        const update = { $set: { pendingCloseReason: reason } }
        if (tag) update.$addToSet = { firedExits: tag }
        await entityRepo.update(idea.id, update)
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
            const res = await brokerService.placeOrder(link.broker, idea.userId, link.accountId, buildExitOrder(idea, {
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
    if (Object.keys(update).length) await entityRepo.update(idea.id, update)
}

async function _checkAdditionalEntries(db, idea, candles, entryTf) {
    const entries = idea.additional_entries
    if (!Array.isArray(entries) || entries.length === 0) return

    for (let i = 0; i < entries.length; i++) {
        const ae = entries[i]

        if (ae.filledAt) continue
        if (ae.triggeredAt) break

        const crossSyms = collectSymbols(ae.condition_tree, ae.conditions)
        const symbolMap = await buildSymbolMap(idea.id, idea.asset, candles, entryTf, crossSyms)

        let triggered = false
        if (ae.condition_tree) {
            ;({ triggered } = await evaluateTree(ae.condition_tree, symbolMap, idea.asset, idea.activatedAt ?? null))
        } else if (Array.isArray(ae.conditions) && ae.conditions.length > 0) {
            ;({ triggered } = await evaluateConditions(ae.conditions, ae.logic ?? 'AND', symbolMap, idea.asset, idea.activatedAt ?? null))
        } else {
            break
        }

        if (triggered) {
            logger.info(LOG, `📈 Additional entry ${i + 1} triggered for idea ${idea.id} — qty: ${ae.quantity}`)
            await entityRepo.patch(idea.id, { [`additional_entries.${i}.triggeredAt`]: Date.now() })
        }
        break
    }
}
