import { getDb, stripId }       from '../../providers/mongodb.provider.js'
import { logger }               from '../../services/logger.service.js'
import { brokerService }        from '../broker/broker.service.js'
import { buildOrderPlanForIdea } from '../../services/orderPlan.service.js'
import { routeExits, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'
import { toBrokerSymbol }       from '../../services/brokerSymbol.service.js'
import { executionReconciler }  from '../../monitoring/execution.reconciler.js'
import { armExitsInPosition, exitFields, basisReferenceQuote } from './exitOrders.service.js'

const LOG        = '[ideaExecution]'
const COLLECTION = 'ideas'

const ORDER_EXEC_TYPES = new Set(['market', 'limit', 'stop'])
const toExecType = t => (ORDER_EXEC_TYPES.has(t) ? t : 'market')

/**
 * Place broker orders for a triggered ('hit') idea after the user confirms.
 * On at least one success the idea advances to long/short so stop/TP monitoring begins.
 */
export async function placeOrdersForIdea(id, orders, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const idea = await db.collection(COLLECTION).findOne({ id })
        if (!idea) return { ok: false, reason: 'not_found' }
        if (idea.userId && idea.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        if (idea.status !== 'hit')  return { ok: false, reason: 'not_hit' }
        if (idea.ordersPlacedAt)    return { ok: false, reason: 'already_placed' }

        const plan = (idea.pendingOrder?.plan?.length) ? idea.pendingOrder.plan : orders
        if (!Array.isArray(plan) || plan.length === 0) return { ok: false, reason: 'no_orders' }

        if (plan[0]?.broker) idea.brokerSymbol = toBrokerSymbol(plan[0].broker, idea.asset)

        const route = await routeExits(idea)

        const results      = []
        const brokerOrders = []
        for (const order of plan) {
            const type = toExecType(order.type)
            const brokerOrder = { symbol: idea.brokerSymbol ?? idea.asset, direction: idea.direction, quantity: order.quantity, type }

            try {
                const result = await brokerService.placeOrder(order.broker, userId, order.accountId, brokerOrder)
                logger.info(LOG, 'Order placed', { id, broker: order.broker, accountId: order.accountId, direction: idea.direction, quantity: order.quantity, orderId: result?.orderId })
                results.push({ accountId: order.accountId, ok: true, orderId: result?.orderId ?? null })
                brokerOrders.push({
                    broker:     order.broker,
                    accountId:  result?.accountId ?? order.accountId,
                    orderId:    result?.orderId    ?? null,
                    positionId: result?.positionId ?? null,
                    quantity:   order.quantity,
                })
            } catch (err) {
                logger.error(LOG, 'Order failed', { id, broker: order.broker, accountId: order.accountId, error: err.message })
                results.push({ accountId: order.accountId, ok: false, error: err.message })
            }
        }

        const anyPlaced = results.some(r => r.ok)
        if (!anyPlaced) return { ok: false, reason: 'all_failed', results }

        const now    = Date.now()
        const status = idea.direction === 'short' ? 'short' : 'long'
        const set    = {
            status, ordersPlacedAt: now, activatedAt: now, orderState: 'placed', brokerOrders,
            brokerSymbol: idea.brokerSymbol,
            ...(await exitFields(idea, route)),
        }
        let updated = await db.collection(COLLECTION).findOneAndUpdate(
            { id },
            { $set: set },
            { returnDocument: 'after' }
        )

        if (updated?.nativeExit) {
            const exitAccts = [...new Set(brokerOrders.filter(b => b.positionId != null).map(b => String(b.accountId)))]
            for (const acct of exitAccts) {
                await executionReconciler.placeExits(db, updated, acct)
            }
            if (exitAccts.length) updated = await db.collection(COLLECTION).findOne({ id })
        }

        for (const { broker, accountId } of brokerOrders) {
            brokerService.startExecutionFeed(broker, userId, accountId)
                .catch(err => logger.warn(LOG, `startExecutionFeed failed (${broker}/${accountId}):`, err.message))
        }
        logger.info(LOG, 'Orders confirmed & placed', { id, status, placed: results.filter(r => r.ok).length })
        return { ok: true, idea: stripId(updated), results }
    } catch (err) {
        logger.error(LOG, 'Failed to place orders for idea', err)
        return { ok: false, error: err }
    }
}

/**
 * Activate a resting (broker-native stop-market) entry: place a working STOP order
 * at the trigger price on each account. The idea moves to 'resting'.
 */
export async function placeRestingEntryForIdea(id, userId, isAdmin = false) {
    try {
        const db   = await getDb()
        const idea = await db.collection(COLLECTION).findOne({ id })
        if (!idea) return { ok: false, reason: 'not_found' }
        if (idea.userId && idea.userId !== userId && !isAdmin) return { ok: false, reason: 'forbidden' }
        if (idea.entryOrderType !== 'stop')              return { ok: false, reason: 'not_resting' }
        if (idea.ordersPlacedAt || idea.restingPlacedAt) return { ok: false, reason: 'already_placed' }

        const triggerPrice = idea.entryTriggerPrice ?? await detectNativeEntryLevel(idea)
        if (triggerPrice == null) return { ok: false, reason: 'no_trigger_price' }

        const plan = await buildOrderPlanForIdea(idea)
        if (!Array.isArray(plan) || plan.length === 0) return { ok: false, reason: 'no_accounts' }

        if (plan[0]?.broker) idea.brokerSymbol = toBrokerSymbol(plan[0].broker, idea.asset)

        const route          = await routeExits(idea)
        const referenceQuote = await basisReferenceQuote(idea)

        const results      = []
        const brokerOrders = []
        for (const order of plan) {
            const brokerOrder = {
                symbol:    idea.brokerSymbol ?? idea.asset,
                direction: idea.direction,
                quantity:  order.quantity,
                type:      'stop',
                stopPrice: triggerPrice,
                ...(referenceQuote != null && { referenceQuote }),
            }
            try {
                const result = await brokerService.placeOrder(order.broker, userId, order.accountId, brokerOrder)
                logger.info(LOG, 'Resting entry placed', { id, broker: order.broker, accountId: order.accountId, stopPrice: triggerPrice, orderId: result?.orderId })
                results.push({ accountId: order.accountId, ok: true, orderId: result?.orderId ?? null })
                brokerOrders.push({
                    broker:     order.broker,
                    accountId:  result?.accountId ?? order.accountId,
                    orderId:    result?.orderId    ?? null,
                    positionId: null,
                    quantity:   order.quantity,
                })
            } catch (err) {
                logger.error(LOG, 'Resting entry failed', { id, broker: order.broker, accountId: order.accountId, error: err.message })
                results.push({ accountId: order.accountId, ok: false, error: err.message })
            }
        }

        if (!results.some(r => r.ok)) return { ok: false, reason: 'all_failed', results }

        const now = Date.now()
        const set = {
            status:            'resting',
            orderState:        'resting',
            restingPlacedAt:   now,
            entryTriggerPrice: triggerPrice,
            brokerOrders,
            brokerSymbol:      idea.brokerSymbol,
            ...(await exitFields(idea, route, referenceQuote)),
        }
        const updated = await db.collection(COLLECTION).findOneAndUpdate({ id }, { $set: set }, { returnDocument: 'after' })

        for (const { broker, accountId } of brokerOrders) {
            brokerService.startExecutionFeed(broker, userId, accountId)
                .catch(err => logger.warn(LOG, `startExecutionFeed failed (${broker}/${accountId}):`, err.message))
        }
        logger.info(LOG, 'Resting entry order(s) working at broker', { id, placed: results.filter(r => r.ok).length })
        return { ok: true, idea: stripId(updated), results }
    } catch (err) {
        logger.error(LOG, 'Failed to place resting entry', err)
        return { ok: false, error: err }
    }
}
