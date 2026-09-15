import { brokerService } from '../api/broker/broker.service.js'
import { logger }        from './logger.service.js'

const LOG = '[restingOrders]'

/**
 * Pull an entity's WORKING ENTRY orders off the broker — the orders it placed that have not become
 * a position yet.
 *
 * ONE MECHANISM, THREE CALLERS, and they had three copies of this loop: an idea going
 * `resting → waiting` or being deleted (tradeIdeas), a setup's limit order being disarmed by Talos,
 * and the same disarm asked for by hand (talos.handoff). The loop is identical in all of them
 * because the question is: which `brokerOrders` links are an order and not yet a position.
 *
 * SHARE THE PIPE, NOT THE JUDGMENT. WHEN there is an order worth cancelling is each caller's own
 * call — an idea asks its status, a setup asks its `orderState` — and stays with the caller. What
 * lives here is the cancel itself.
 *
 * `positionId != null` is the whole test for "this one filled". An entry order that became a
 * position must never be cancelled: on a hedging venue the cancel is a no-op, but on a netting one
 * a stray opposite order is how a closed position comes back the other way.
 *
 * BEST-EFFORT, DELIBERATELY. A cancel that fails is logged and the next link is still tried: the
 * caller is on its way to a state where the entity no longer tracks these orders, and giving up
 * halfway leaves MORE orphans than carrying on. The caller decides whether to proceed regardless —
 * every one of them does, because the alternative is an entity stuck in a state the user asked to
 * leave.
 *
 * @param {{ brokerOrders?: Array<{broker,accountId,orderId,positionId}>, id?: string }} entity
 * @param {string} userId
 * @param {{ cancelOrder?: Function, log?: string }} [deps]
 * @returns {Promise<{ cancelled: number, failed: number }>}
 */
export async function cancelRestingEntryOrders(entity, userId, { cancelOrder = brokerService.cancelOrder, log = LOG } = {}) {
    const links = Array.isArray(entity?.brokerOrders) ? entity.brokerOrders : []
    let cancelled = 0, failed = 0

    for (const link of links) {
        if (!link?.orderId || link.positionId != null) continue
        try {
            await cancelOrder(link.broker, userId, link.accountId, link.orderId)
            cancelled++
            logger.info(log, `resting order cancelled`, { id: entity?.id, broker: link.broker, accountId: link.accountId, orderId: link.orderId })
        } catch (err) {
            failed++
            logger.warn(log, `resting order cancel failed`, { id: entity?.id, orderId: link.orderId, error: err.message })
        }
    }
    return { cancelled, failed }
}
