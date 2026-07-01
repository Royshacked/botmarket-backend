import { evaluateTree, evaluateConditions } from './monitor.orchestrator.js'
import { logger }                            from '../services/logger.service.js'
import { brokerService }                     from '../api/broker/broker.service.js'
import { collectSymbols }                     from '../services/conditionTree.service.js'
import {
    buildSymbolMap, buildVolumeCtx, persistConditionStates,
    round, remainingForAccount, resolveEntryTimeframe, resolveStopTimeframe, resolveTpTimeframe,
} from './monitorUtils.js'

const LOG        = '[positionMonitor]'
const COLLECTION = 'ideas'

/**
 * Check both exit legs and any additional entries for an in-position idea.
 * @param {Function} onClose  callback(id, reason) — invoked for alert-only closes
 *                            (no live broker position); provided by monitor.service.js
 *                            so it can clean up `_lastChecked`.
 */
export async function checkPosition(db, idea, stopCandles, tpCandles, aeCandles, onClose) {
    const { id, asset } = idea
    const stopTf  = resolveStopTimeframe(idea)
    const tpTf    = resolveTpTimeframe(idea)
    const entryTf = resolveEntryTimeframe(idea)

    const stopFired = await _evaluateExit(db, idea, {
        phase: 'stop', candles: stopCandles, timeframe: stopTf,
        reason: 'stop', label: 'Stop', emoji: '🛑', native: idea.monitorStop,
    }, onClose)
    if (stopFired) return

    const tpFired = await _evaluateExit(db, idea, {
        phase: 'tp', candles: tpCandles, timeframe: tpTf,
        reason: 'tp', label: 'TP', emoji: '🎯', native: idea.monitorTp,
    }, onClose)
    if (tpFired) return

    logger.info(LOG, `💤 No exit triggered for idea ${id} (${asset}) — still in position`)

    await _checkAdditionalEntries(db, idea, aeCandles, entryTf)
}

async function _evaluateExit(db, idea, { phase, candles, timeframe, reason, label, emoji, native }, onClose) {
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
    const volCtx     = await buildVolumeCtx(id, asset, idea.asset_class, tree, conditions)

    if (residual) {
        return _evaluateResidual(db, idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx }, onClose)
    }

    let triggered = false
    let which
    const states = []
    if (tree) {
        logger.info(LOG, `[${id}] Evaluating ${reason} condition tree`)
        ;({ triggered, which } = await evaluateTree(tree, symbolMap, asset, floorAt, [], states, volCtx))
    } else if (Array.isArray(conditions) && conditions.length > 0) {
        const logic = idea[`${phase}_logic`] ?? 'OR'
        ;({ triggered, which } = await evaluateConditions(conditions, logic, symbolMap, asset, floorAt))
    } else {
        logger.info(LOG, `[${id}] No ${reason} conditions defined — skipping ${reason} check`)
        return false
    }

    await persistConditionStates(db, idea, phase, states, COLLECTION)

    if (triggered) {
        logger.info(LOG, `${emoji} ${label} triggered for idea ${id}: "${(which ?? '').slice(0, 60)}"`)
        await _exitNow(db, idea, { leg: phase, reason, quantity: null }, onClose)
        return true
    }
    return false
}

async function _evaluateResidual(db, idea, { phase, residual, symbolMap, asset, floorAt, reason, label, emoji, volCtx }, onClose) {
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
        await _exitNow(db, idea, { leg: phase, reason, quantity: qty, tag }, onClose)
        any = true
    }
    return any
}

async function _exitNow(db, idea, { leg, reason, quantity, tag }, onClose) {
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
        await db.collection(COLLECTION).updateOne({ id: idea.id }, update)
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
            const res = await brokerService.placeOrder(link.broker, idea.userId, link.accountId, {
                symbol:    idea.brokerSymbol ?? idea.asset,
                direction: idea.direction === 'long' ? 'short' : 'long',
                quantity:  qty,
                type:      'market',
                ...(link.positionId != null && { positionId: link.positionId }),
            })
            newOrders.push({
                accountId: String(link.accountId), broker: link.broker, leg,
                type: 'market', price: null, quantity: qty, positionId: link.positionId ?? null,
                orderId: res?.orderId != null ? String(res.orderId) : null,
                status: 'working', placedAt: Date.now(),
            })
            logger.info(LOG, `[${idea.id}] Monitor close sent — ${leg} ${qty} market (acct ${link.accountId})`)
        } catch (err) {
            logger.error(LOG, `[${idea.id}] Monitor close failed (acct ${link.accountId}): ${err.message}`)
        }
    }

    const update = {}
    if (newOrders.length) update.$push     = { exitOrders: { $each: newOrders } }
    if (tag)              update.$addToSet = { firedExits: tag }
    if (Object.keys(update).length) await db.collection(COLLECTION).updateOne({ id: idea.id }, update)
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
            await db.collection(COLLECTION).updateOne(
                { id: idea.id },
                { $set: { [`additional_entries.${i}.triggeredAt`]: Date.now() } }
            )
        }
        break
    }
}
