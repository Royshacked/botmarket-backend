/**
 * Shared exit-order construction.
 *
 * An exit order is a CLOSING broker order on the opposite side of the idea's
 * direction. Three shapes converge here:
 *   • native resting exits (reconciler)  — leg 'stop'|'tp' → STOP|LIMIT at a level
 *   • monitor market close (positionMonitor) — type 'market', no price
 *
 * All of them share the same idioms: close-side = opposite of idea.direction,
 * symbol = idea.brokerSymbol ?? idea.asset, a conditional positionId spread that
 * makes the order a position-reducing close, and a persisted exitOrders record.
 *
 * These helpers construct the payload + record ONLY. Quantity is computed by the
 * caller (each site keeps its own scaling/clamping), and the actual placeOrder call
 * + orderId capture stays with the caller so error handling is unchanged.
 */

/** Symbol used for broker orders — broker-specific alias falls back to the asset. */
export const orderSymbol = idea => idea.brokerSymbol ?? idea.asset

/** Closing side for a direction — the opposite of the position's direction. */
export const closeSide = direction => (direction === 'long' ? 'short' : 'long')

/**
 * Build the broker placeOrder payload for one exit leg.
 *
 * @param {object}      idea
 * @param {object}      p
 * @param {'stop'|'tp'|'market'} p.type   'stop'/'tp' → native STOP/LIMIT; 'market' → market close
 * @param {number|null} p.level           price level for stop/tp legs (ignored for market)
 * @param {number}      p.qty
 * @param {string|number|null} p.positionId  when set, spreads positionId so the order
 *                                            reduces exactly this position (closing order)
 * @param {number|null} [p.referenceQuote]    optional broker reference quote
 * @returns {object} broker order payload
 */
export function buildExitOrder(idea, { type, level = null, qty, positionId = null, referenceQuote = null }) {
    const order = {
        symbol:    orderSymbol(idea),
        direction: closeSide(idea.direction),
        quantity:  qty,
        type:      type === 'tp' ? 'limit' : type === 'stop' ? 'stop' : 'market',
        ...(positionId != null && { positionId }),   // closing order: reduces this position only
    }
    if (type === 'tp')        order.limitPrice = level
    else if (type === 'stop') order.stopPrice  = level
    if (referenceQuote != null) order.referenceQuote = referenceQuote
    return order
}

/**
 * Build the persisted `exitOrders` record for a placed exit leg.
 *
 * @param {object} p
 * @param {string}      p.accountId
 * @param {string}      p.broker
 * @param {'stop'|'tp'} p.leg          the plan leg this exit belongs to
 * @param {'stop'|'limit'|'market'} p.type
 * @param {number|null} p.price        level for native exits; null for market
 * @param {number}      p.quantity
 * @param {string|number|null} p.positionId
 * @param {string|null} p.orderId
 * @returns {object}
 */
export function exitOrderRecord({ accountId, broker, leg, type, price, quantity, positionId, orderId }) {
    return {
        accountId, broker, leg, type, price, quantity,
        positionId: positionId ?? null,
        orderId,
        status:  'working',
        placedAt: Date.now(),
    }
}
