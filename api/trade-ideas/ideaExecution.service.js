import { getDb, stripId }       from '../../providers/mongodb.provider.js'
import { logger }               from '../../services/logger.service.js'
import { brokerService }        from '../broker/broker.service.js'
import { buildOrderPlanForIdea } from '../../services/orderPlan.service.js'
import { isAssetOpen }          from '../../services/market.service.js'
import { routeExits, detectNativeEntryLevel } from '../../services/protectionPlan.service.js'
import { toBrokerSymbol }       from '../../services/brokerSymbol.service.js'
import { executionReconciler }  from '../../monitoring/execution.reconciler.js'
import { orderSymbol }          from '../../monitoring/exitOrders.util.js'
import { exitFields, basisReferenceQuote } from './exitOrders.service.js'
import { entityRepo }          from '../../services/entity/entityRepo.service.js'
import { ownsEntity }          from '../../services/entity/entityCrud.service.js'
import { AWAITING_CONFIRM, isRestingEntry } from '../../services/entity/vocabulary.js'
import { coverageService }     from '../analyst/coverage.service.js'
import { NO_PRICE }            from '../broker/adapters/broker.interface.js'

const LOG = '[ideaExecution]'


// Kind-blind placement gate: an idea reaches here as 'hit', a setup as 'ready' — same meaning,
// different kind vocabularies. Hard-coding 'hit' here silently refused every setup confirm.
const PLACEABLE = new Set(AWAITING_CONFIRM)

const ORDER_EXEC_TYPES = new Set(['market', 'limit', 'stop'])
const toExecType = t => (ORDER_EXEC_TYPES.has(t) ? t : 'market')

/**
 * WHICH price field a resting entry carries. The adapters read `limitPrice` for a limit and
 * `stopPrice` for a stop and ignore the other, so sending the wrong one is not an error — the
 * order simply arrives with no trigger at all. Pure, so the mapping is testable without a broker.
 *
 * @param {'limit'|'stop'} entryOrderType
 * @param {number} price  already shifted into broker price space by the caller
 * @returns {{ limitPrice: number }|{ stopPrice: number }}
 */
export function restingEntryPrice(entryOrderType, price) {
    return entryOrderType === 'limit' ? { limitPrice: price } : { stopPrice: price }
}

/**
 * Place broker orders for a triggered ('hit') idea after the user confirms.
 * On at least one success the idea advances to long/short so stop/TP monitoring begins.
 */
export async function placeOrdersForIdea(id, orders, userId) {
    try {
        const db   = await getDb()   // retained solely for executionReconciler.placeExits(db, …)
        const idea = await entityRepo.getById(id)
        if (!idea) return { ok: false, reason: 'not_found' }
        if (!ownsEntity(idea, userId)) return { ok: false, reason: 'forbidden' }
        if (!PLACEABLE.has(idea.status)) return { ok: false, reason: 'not_hit' }
        if (idea.ordersPlacedAt)         return { ok: false, reason: 'already_placed' }
        // A MARKET order into a shut market cannot fill — the broker rejects it, and the user is
        // left reading a broker error for something the app already knew. The dialog blocks this
        // client-side, but the endpoint is the only place that actually holds: a stale tab, a retry
        // that crosses the close, or any direct caller reaches here without passing that check.
        // The market-open sweep is what brings these back (monitoring/marketOpen.monitor.js).
        //
        // Entry-type-aware on purpose: a RESTING limit/stop entry is a working order the broker is
        // meant to hold until price comes to it, so it is not gated here — placeRestingEntryForIdea
        // owns that path, and its own venue rules apply.
        if (!isAssetOpen(idea.asset, idea.asset_class)) return { ok: false, reason: 'market_closed' }

        const plan = (idea.pendingOrder?.plan?.length) ? idea.pendingOrder.plan : orders
        if (!Array.isArray(plan) || plan.length === 0) return { ok: false, reason: 'no_orders' }

        if (plan[0]?.broker) idea.brokerSymbol = toBrokerSymbol(plan[0].broker, idea.asset)

        const route = await routeExits(idea)

        const results      = []
        const brokerOrders = []
        for (const order of plan) {
            const type = toExecType(order.type)
            const brokerOrder = { symbol: orderSymbol(idea), direction: idea.direction, quantity: order.quantity, type }

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
                results.push({ accountId: order.accountId, ok: false, error: err.message, code: err.code ?? null })
            }
        }

        const anyPlaced = results.some(r => r.ok)
        if (!anyPlaced) {
            // "Every broker rejected you" and "we couldn't read a price" are different events and
            // deserve different answers — the first is the venue's verdict on the trade, the second
            // is our own data layer being briefly unavailable and is worth retrying in a moment.
            // Only when EVERY leg failed for want of a price is that the honest report.
            if (results.every(r => r.code === NO_PRICE)) {
                return { ok: false, reason: 'no_price', symbol: idea.asset, results }
            }
            return { ok: false, reason: 'all_failed', results }
        }

        const now    = Date.now()
        const status = idea.direction === 'short' ? 'short' : 'long'
        // The research we're opening ON, frozen for the life of the position (see the service doc).
        const basis  = await coverageService.captureResearchBasis({ symbol: idea.asset })
        const set    = {
            status, ordersPlacedAt: now, activatedAt: now, orderState: 'placed', brokerOrders,
            brokerSymbol: idea.brokerSymbol,
            ...(basis ? { research_basis: basis } : {}),
            ...(await exitFields(idea, route)),
        }
        let updated = await entityRepo.patchAndGet(id, set)

        if (updated?.nativeExit) {
            const exitAccts = [...new Set(brokerOrders.filter(b => b.positionId != null).map(b => String(b.accountId)))]
            for (const acct of exitAccts) {
                await executionReconciler.placeExits(db, updated, acct)
            }
            if (exitAccts.length) updated = await entityRepo.getById(id)
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
 * Force-trigger an idea's entry now — the "Buy now" pre-flight action, taken when
 * the entry level is already held so the monitor's rising edge would never fire.
 *
 * Mirrors the monitor's on-trigger transition (monitor.service _checkEntry): flips
 * a 'looking' idea to 'hit', builds the per-account order plan and sets orderState,
 * so the normal order-confirm dialog surfaces. It does NOT place at the broker —
 * the user still confirms (which routes through placeOrdersForIdea). A closed market parks the
 * plan at 'awaiting_market'; the market-open sweep brings it back.
 */
export async function triggerEntryNow(id, userId) {
    try {
        const idea = await entityRepo.getById(id)
        if (!idea) return { ok: false, reason: 'not_found' }
        if (!ownsEntity(idea, userId)) return { ok: false, reason: 'forbidden' }
        if (idea.status !== 'looking') return { ok: false, reason: 'not_looking' }

        // Explicit user action → not a "triggered while waiting" event.
        const patch = { status: 'hit', entryTriggeredAt: Date.now(), triggeredWhileWaiting: false, triggerEventAt: null }

        const plan = await buildOrderPlanForIdea(idea)
        if (plan.length > 0) {
            const open = isAssetOpen(idea.asset, idea.asset_class)
            patch.pendingOrder = { plan, builtAt: Date.now() }
            patch.orderState   = open ? 'awaiting_confirm' : 'awaiting_market'
        }

        const updated = await entityRepo.patchAndGet(id, patch)
        logger.info(LOG, 'Entry force-triggered (buy now)', { id, orderState: patch.orderState ?? 'none' })
        return { ok: true, idea: stripId(updated) }
    } catch (err) {
        logger.error(LOG, 'Failed to force-trigger entry', err)
        return { ok: false, error: err }
    }
}

/**
 * Activate a resting (broker-native) entry: place a working order at the trigger price on
 * each account. The idea moves to 'resting'.
 *
 * The order type is the idea's own `entryOrderType` — a STOP for a breakout entry (trigger
 * beyond the current price) or a LIMIT for a pullback entry (trigger back through it). Both
 * are the same gesture, "leave this level with the broker"; only the side of the market the
 * trigger sits on differs, and the broker is the one that knows which it is.
 */
export async function placeRestingEntryForIdea(id, userId) {
    try {
        const idea = await entityRepo.getById(id)
        if (!idea) return { ok: false, reason: 'not_found' }
        if (!ownsEntity(idea, userId)) return { ok: false, reason: 'forbidden' }
        if (!isRestingEntry(idea.entryOrderType))         return { ok: false, reason: 'not_resting' }
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
            // Shift authored (real) price → broker space by the fork-measured offset (0 for all
            // but aliased index futures). Persisted entryTriggerPrice below stays the real level
            // (app display); only the order carries the shift.
            const brokerPrice = triggerPrice + (Number(idea.basisOffset) || 0)
            const brokerOrder = {
                symbol:    orderSymbol(idea),
                direction: idea.direction,
                quantity:  order.quantity,
                type:      idea.entryOrderType,
                ...restingEntryPrice(idea.entryOrderType, brokerPrice),
                ...(referenceQuote != null && { referenceQuote }),
            }
            try {
                const result = await brokerService.placeOrder(order.broker, userId, order.accountId, brokerOrder)
                logger.info(LOG, 'Resting entry placed', { id, broker: order.broker, accountId: order.accountId, type: idea.entryOrderType, triggerPrice, orderId: result?.orderId })
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
        const updated = await entityRepo.patchAndGet(id, set)

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
