/**
 * Paper fill engine.
 *
 * The one piece a real broker provides that the simulation must supply itself: a loop
 * that watches the LIVE price feed and triggers resting paper orders — stop/limit
 * ENTRIES (open a position) and positionId CLOSING exits (stop-loss / take-profit).
 * On a fill it delegates to paperExecution.service, which mutates the virtual position
 * and emits the normalized execution event the reconciler already consumes.
 *
 * Global (not per-account): one loop sweeps every user's working paper orders, like
 * monitorService. Fills use the trigger price (slippage/gaps deferred to Phase 3).
 *
 * See docs/architecture/paper-trading-simulation.md (Phase 2).
 */

import { getDb }                 from '../providers/mongodb.provider.js'
import { paperBrokerService }    from '../api/broker/paperBroker.service.js'
import { openPosition,
         reducePosition,
         latestPrice }           from '../api/broker/paperExecution.service.js'
import { logger }                from '../services/logger.service.js'

const LOG              = '[paperFill.service]'
const ORDERS           = 'paperOrders'
const POLL_INTERVAL_MS = Number(process.env.PAPER_FILL_INTERVAL_MS) || 30_000

let _timer   = null
let _running = false

export const paperFillService = { start, stop, _tick }

function start() {
    if (_timer) return
    _timer = setInterval(() => { _tick().catch(err => logger.error(LOG, 'tick error:', err.message)) }, POLL_INTERVAL_MS)
    logger.info(LOG, `Paper fill engine started (every ${POLL_INTERVAL_MS / 1000}s)`)
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null }
}

/**
 * Whether a resting order is triggered by the current price.
 *   stop  → long fills at/above the trigger, short at/below (breakout/breakdown).
 *   limit → long fills at/below the trigger, short at/above (better-price fill).
 * Holds for both entries and closing exits because an exit carries the closing side
 * as its direction (a long position's stop is a short stop, its TP a short limit).
 */
export function isTriggered(order, price) {
    const t = order.triggerPrice
    if (t == null || price == null) return false
    if (order.type === 'stop')  return order.direction === 'long' ? price >= t : price <= t
    if (order.type === 'limit') return order.direction === 'long' ? price <= t : price >= t
    return false
}

async function _tick() {
    if (_running) return   // never overlap a slow sweep
    _running = true
    try {
        const db     = await getDb()
        const orders = await db.collection(ORDERS).find({ status: 'working' }, { projection: { _id: 0 } }).toArray()
        if (!orders.length) return

        // One price lookup per distinct symbol.
        const symbols = [...new Set(orders.map(o => o.symbol))]
        const priceBy = new Map(await Promise.all(symbols.map(async s => [s, await latestPrice(s)])))

        for (const order of orders) {
            const price = priceBy.get(order.symbol)
            if (!isTriggered(order, price)) continue
            await _fill(order, order.triggerPrice).catch(err =>
                logger.error(LOG, `fill failed (order ${order.orderId}): ${err.message}`))
        }
    } finally {
        _running = false
    }
}

/** Fill a triggered order at `fillPrice`: open a position (entry) or reduce one (exit). */
async function _fill(order, fillPrice) {
    const { userId, accountId, orderId, positionId } = order

    // Mark filled first so a slow tick can't double-fill it.
    await paperBrokerService.updateOrder(userId, orderId, { status: 'filled', filledAt: Date.now(), fillPrice })

    if (positionId != null) {
        // Closing exit (stop-loss / take-profit) — reduce/close the position.
        const reason = order.type === 'limit' ? 'tp' : 'stop'
        await reducePosition({ userId, positionId, qty: order.qty, price: fillPrice, reason, orderId })
        logger.info(LOG, `Exit filled: ${reason} ${order.qty} ${order.symbol} @ ${fillPrice} (closes ${positionId})`)
        return
    }

    // Resting entry — open a new position. The position.opened event (carrying orderId)
    // is what flips the idea resting → long/short in the reconciler.
    const newPositionId = await openPosition({
        userId, accountId, symbol: order.symbol,
        direction: order.direction, qty: order.qty, price: fillPrice, orderId,
    })
    await paperBrokerService.updateOrder(userId, orderId, { positionId: newPositionId })
    logger.info(LOG, `Entry filled: ${order.direction} ${order.qty} ${order.symbol} @ ${fillPrice} → position ${newPositionId}`)
}
