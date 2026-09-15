import { brokerService }        from '../broker/broker.service.js'
import { logger }                from '../../services/logger.service.js'
import { buildExitOrder, exitOrderRecord } from '../../monitoring/exitOrders.util.js'
import { round }                from '../../monitoring/monitorUtils.js'

const LOG = '[exitOrders]'

/**
 * Arm an idea's exits against its ALREADY-OPEN position(s) — used when a stop/TP is
 * added or edited while in a position. Each bare-price level is placed as a CLOSING order
 * (LIMIT for tp / STOP for stop, opposite side, tagged with positionId). Any prior working
 * exit orders are cancelled first. Non-price exits stay on the monitor.
 *
 * The order is built by `buildExitOrder` — the same constructor the reconciler's placement path
 * uses — so the level is shifted into the broker's price space by the idea's `basisOffset`
 * exactly once, in one place. This used to build the payload inline with the RAW level: a stop
 * edited while in position on a cTrader index CFD rested ~one futures basis (~227 pts on NQ/US100)
 * away from where the same stop set at placement would have.
 */
export async function armExitsInPosition(idea, route) {
    const totalQty       = Number(idea.quantity) || 0

    // Cancel prior working exit orders (we're replacing the setup); keep as history.
    const kept = []
    for (const o of (idea.exitOrders ?? [])) {
        if (o.status === 'working' && o.orderId) {
            try { await brokerService.cancelOrder(o.broker, idea.userId, o.accountId, o.orderId) }
            catch (err) { logger.warn(LOG, `arm-exits: cancel prior order failed (${o.orderId}): ${err.message}`) }
            kept.push({ ...o, status: 'cancelled', cancelledAt: Date.now() })
        } else {
            kept.push(o)
        }
    }

    const legSpecs = [
        { leg: 'stop', type: 'stop',  levels: route.stop.nativeOrders },
        { leg: 'tp',   type: 'limit', levels: route.tp.nativeOrders },
    ]
    const seen = new Set()
    const openLinks = (idea.brokerOrders ?? []).filter(b => {
        if (b.positionId == null) return false
        const key = `${b.accountId}:${b.positionId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
    const placed = []

    for (const link of openLinks) {
        const entryQty = Number(link.quantity) || totalQty
        const factor   = (entryQty > 0 && totalQty > 0) ? entryQty / totalQty : 1
        for (const spec of legSpecs) {
            const rawLevels = (spec.levels ?? []).map(l => ({ level: l.level, quantity: round((Number(l.quantity) || 0) * factor) }))
            const levels = [...new Map(rawLevels.map(l => [l.level, l])).values()]
            for (const lvl of levels) {
                if (!(lvl.quantity > 0)) continue
                const order = buildExitOrder(idea, {
                    type: spec.leg, level: lvl.level, qty: lvl.quantity, positionId: link.positionId,
                })
                try {
                    const res = await brokerService.placeOrder(link.broker, idea.userId, link.accountId, order)
                    // The RECORD keeps the authored level (what the app displays); only the order carried the shift.
                    placed.push(exitOrderRecord({
                        accountId: String(link.accountId), broker: link.broker, leg: spec.leg,
                        type: spec.type, price: lvl.level, quantity: lvl.quantity, positionId: link.positionId,
                        orderId: res?.orderId != null ? String(res.orderId) : null,
                    }))
                    logger.info(LOG, `In-position exit placed for idea ${idea.id}: ${spec.leg} ${lvl.quantity} @ ${lvl.level} (pos ${link.positionId})`)
                } catch (err) {
                    logger.error(LOG, `In-position exit place failed (idea ${idea.id}, ${spec.leg} @ ${lvl.level}): ${err.message}`)
                }
            }
        }
    }
    return { exitOrders: [...kept, ...placed] }
}

/**
 * Build the exit-handling $set fields for an idea whose entry order(s) were just placed.
 * Touch levels → stored in nativeExit (placed as positionId closing orders when position opens).
 * Residual monitor tree → stored as {leg}MonitorTree for the software monitor. Pure.
 *
 * Basis handling is NOT here: the offset is measured once at fork (`idea.basisOffset`) and applied
 * at every price boundary by `applyOffset` (buildExitOrder, the resting entry, an amend). This used
 * to also stamp a `referenceQuote` onto nativeExit for a second, adapter-side shift that had been
 * neutralised to always-null — two mechanisms for one basis, one of them dead and both wired.
 */
export function exitFields(route) {
    const out = {}

    for (const leg of ['stop', 'tp']) {
        const r       = route[leg]
        const flagKey = leg === 'stop' ? 'monitorStop'     : 'monitorTp'
        const treeKey = leg === 'stop' ? 'stopMonitorTree' : 'tpMonitorTree'
        out[flagKey] = r.monitorTree != null
        if (r.monitorTree) out[treeKey] = r.monitorTree
    }

    const nativeExit = { stop: route.stop.nativeOrders, tp: route.tp.nativeOrders }
    if (nativeExit.stop.length || nativeExit.tp.length) out.nativeExit = nativeExit
    return out
}
