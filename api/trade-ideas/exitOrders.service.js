import { brokerService }        from '../broker/broker.service.js'
import { logger }                from '../../services/logger.service.js'

const LOG = '[exitOrders]'

/**
 * Arm an idea's exits against its ALREADY-OPEN position(s) — used when a stop/TP is
 * added or edited while in a position. Each bare-price level is placed as a cTrader
 * CLOSING order (LIMIT for tp / STOP for stop, opposite side, tagged with positionId).
 * Any prior working exit orders are cancelled first. Non-price exits stay on the monitor.
 */
export async function armExitsInPosition(idea, route) {
    const totalQty       = Number(idea.quantity) || 0
    const referenceQuote = await basisReferenceQuote(idea)

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
            const rawLevels = (spec.levels ?? []).map(l => ({ level: l.level, quantity: Math.round((Number(l.quantity) || 0) * factor * 10000) / 10000 }))
            const levels = [...new Map(rawLevels.map(l => [l.level, l])).values()]
            for (const lvl of levels) {
                if (!(lvl.quantity > 0)) continue
                const order = {
                    symbol:     idea.brokerSymbol ?? idea.asset,
                    direction:  idea.direction === 'long' ? 'short' : 'long',
                    quantity:   lvl.quantity,
                    type:       spec.type,
                    positionId: link.positionId,
                    ...(referenceQuote != null && { referenceQuote }),
                }
                if (spec.leg === 'tp') order.limitPrice = lvl.level
                else                   order.stopPrice  = lvl.level
                try {
                    const res = await brokerService.placeOrder(link.broker, idea.userId, link.accountId, order)
                    placed.push({
                        accountId: String(link.accountId), broker: link.broker, leg: spec.leg,
                        type: spec.type, price: lvl.level, quantity: lvl.quantity, positionId: link.positionId,
                        orderId: res?.orderId != null ? String(res.orderId) : null,
                        status: 'working', placedAt: Date.now(),
                    })
                    logger.info(LOG, `In-position exit placed for idea ${idea.id}: ${spec.leg} ${lvl.quantity} @ ${lvl.level} (pos ${link.positionId})`)
                } catch (err) {
                    logger.error(LOG, `In-position exit place failed (idea ${idea.id}, ${spec.leg} @ ${lvl.level}): ${err.message}`)
                }
            }
        }
    }
    return { exitOrders: [...kept, ...placed], referenceQuote }
}

/**
 * Build the exit-handling $set fields for an idea whose entry order(s) were just placed.
 * Touch levels → stored in nativeExit (placed as positionId closing orders when position opens).
 * Residual monitor tree → stored as {leg}MonitorTree for the software monitor.
 */
export async function exitFields(idea, route, referenceQuote) {
    const out = {}

    for (const leg of ['stop', 'tp']) {
        const r       = route[leg]
        const flagKey = leg === 'stop' ? 'monitorStop'     : 'monitorTp'
        const treeKey = leg === 'stop' ? 'stopMonitorTree' : 'tpMonitorTree'
        out[flagKey] = r.monitorTree != null
        if (r.monitorTree) out[treeKey] = r.monitorTree
    }

    const nativeExit = { stop: route.stop.nativeOrders, tp: route.tp.nativeOrders }
    if (nativeExit.stop.length || nativeExit.tp.length) {
        const refQuote = referenceQuote !== undefined ? referenceQuote : await basisReferenceQuote(idea)
        out.nativeExit = { ...nativeExit, referenceQuote: refQuote ?? null }
    }
    return out
}

/**
 * Broker reference quote for the LEGACY adapter price-shift. NEUTRALISED: the basis is now
 * measured ONCE at fork (idea.basisOffset) and applied to order prices at build time
 * (buildExitOrder / resting entry). Returning null keeps the adapter's referenceQuote shift
 * OFF, so the basis is never applied twice. Kept as an exported no-op so callers that still
 * pass its result see the (correct) null.
 */
export async function basisReferenceQuote() {
    return null
}
