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
 * minosService. Fills use the trigger price (slippage/gaps deferred to Phase 3).
 *
 * See docs/architecture/paper-trading-simulation.md (Phase 2).
 */

import { getDb }                 from '../providers/mongodb.provider.js'
import { paperBrokerService }    from '../api/broker/paperBroker.service.js'
import { openPosition,
         reducePosition,
         quoteMapForSymbols }    from '../api/broker/paperExecution.service.js'
import { logger }                from '../services/logger.service.js'
import { createPollLoop }        from './monitorUtils.js'

const LOG              = '[paperFill.service]'
const ORDERS           = 'paperOrders'
// Paper stop/limit entries and stop-loss/take-profit exits don't rest on a real venue —
// this loop IS the matching engine, so it re-checks the live price every few seconds via
// latestMarkPrice (FMP real-time /quote on a ~3s cache; intraday-candle fallback for
// symbols FMP can't price — never a stale day candle). A touched level fills at the next
// sweep. Point-sampling means a spike that reverts inside the interval can be missed —
// accepted for a forward sim.
const POLL_INTERVAL_MS = Number(process.env.PAPER_FILL_INTERVAL_MS) || 3_000

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, log: LOG, name: 'paper fill' })

export const paperFillService = { start: _loop.start, stop: _loop.stop, _tick, selectFills }

/**
 * Whether a resting order is triggered by the latest sampled price.
 *   stop  → long fills at/above the trigger, short at/below (breakout/breakdown).
 *   limit → long fills at/below the trigger, short at/above (better-price fill).
 * Holds for both entries and closing exits because an exit carries the closing side
 * as its direction (a long position's stop is a short stop, its TP a short limit).
 *
 * `price` is the latest last-traded quote (latestMarkPrice) — a single point sample, so
 * the order fills on the first sweep where the sampled price has crossed the level. This
 * is a touch approximation: unlike a real resting order it can miss a spike that reverts
 * between two ~3s samples (candle high/low would catch it, but a delayed last-price feed
 * can't) — an accepted trade-off for the forward sim.
 */
export function isTriggered(order, price) {
    const t = order.triggerPrice
    if (t == null || price == null) return false
    if (order.type === 'stop')  return order.direction === 'long' ? price >= t : price <= t
    if (order.type === 'limit') return order.direction === 'long' ? price <= t : price >= t
    return false
}

/**
 * Choose which triggered orders to actually fill this sweep, resolving the intrabar
 * stop-vs-TP ambiguity ADVERSELY: when a position has BOTH its stop and its take-profit
 * triggered in the same window (price ranged through both levels), a touch feed can't
 * know which printed first — so assume the STOP filled first and DROP that position's TP.
 * Otherwise the sim flatters itself by always booking the favorable exit. Entries and
 * single-sided exits pass through unchanged.
 *
 * @param {object[]} triggered  orders that isTriggered() this sweep
 * @returns {object[]} the subset to fill
 */
export function selectFills(triggered) {
    const stoppedPositions = new Set(
        triggered
            .filter(o => o.positionId != null && o.type === 'stop')
            .map(o => String(o.positionId))
    )
    if (stoppedPositions.size === 0) return triggered
    return triggered.filter(o =>
        !(o.positionId != null && o.type === 'limit' && stoppedPositions.has(String(o.positionId))))
}

async function _tick() {
    const db     = await getDb()
    const orders = await db.collection(ORDERS).find({ status: 'working' }, { projection: { _id: 0 } }).toArray()
    if (!orders.length) return

    // One price lookup per distinct symbol (Yahoo last quote / candle-close fallback).
    const priceBy = await quoteMapForSymbols(orders.map(o => o.symbol))

    const triggered = orders.filter(o => isTriggered(o, priceBy.get(o.symbol)))
    for (const order of selectFills(triggered)) {
        await _fill(order, order.triggerPrice).catch(err =>
            logger.error(LOG, `fill failed (order ${order.orderId}): ${err.message}`))
    }
}

/** Fill a triggered order at `fillPrice`: open a position (entry) or reduce one (exit). */
async function _fill(order, fillPrice) {
    const { userId, accountId, orderId, positionId } = order

    // Mark filled first — this CLAIMS the order so a slow/overlapping tick can't double-fill
    // it (openPosition isn't idempotent, so re-processing would open a duplicate position).
    await paperBrokerService.updateOrder(userId, orderId, { status: 'filled', filledAt: Date.now(), fillPrice })

    try {
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
        // Position exists now; link the id back onto the order (best-effort — the reconciler
        // also matches via the position.opened event's orderId, so a miss here isn't fatal).
        await paperBrokerService.updateOrder(userId, orderId, { positionId: newPositionId })
            .catch(err => logger.error(LOG, `link positionId failed (order ${orderId}): ${err.message}`))
        logger.info(LOG, `Entry filled: ${order.direction} ${order.qty} ${order.symbol} @ ${fillPrice} → position ${newPositionId}`)
    } catch (err) {
        // The position mutation failed AFTER we claimed the order. Revert the order to 'working'
        // so the next tick retries it — otherwise it would sit 'filled' with no position change
        // (a lost entry, or an exit that never closes its position).
        await paperBrokerService.updateOrder(userId, orderId, { status: 'working', filledAt: null, fillPrice: null })
            .catch(e => logger.error(LOG, `revert after failed fill also failed (order ${orderId}): ${e.message}`))
        throw err
    }
}
