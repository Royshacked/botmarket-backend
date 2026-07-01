/**
 * Paper execution primitives.
 *
 * The two position-mutation operations shared by the paper adapter (market fills /
 * manual closes) and the paper fill engine (working-order triggers), so there is one
 * code path that mutates virtual positions, banks P&L, and emits the normalized
 * execution events the reconciler consumes.
 *
 * Cash moves only by realized P&L (Phase 3 adds spread/commission), so equity stays
 * cashBalance + Σ unrealized with no notional bookkeeping.
 */

import { randomUUID }        from 'crypto'
import { paperBrokerService } from './paperBroker.service.js'
import { getCandles }         from '../../providers/ohlcv.provider.js'
import { executionBus }       from '../../services/executionBus.js'
import { logger }             from '../../services/logger.service.js'

const LOG = '[paperExecution]'

/** long → +1, short → −1 (P&L sign). */
export const dirSign = dir => (dir === 'short' ? -1 : 1)
export const round2  = n => Math.round(n * 100) / 100
const round8 = n => Math.round(n * 1e8) / 1e8

/**
 * Cross the spread: a BUY fills at the ask (mid + half-spread), a SELL at the bid
 * (mid − half-spread). `spreadBps` is basis points of price; the caller passes the
 * mid (or trigger) price and gets the effective fill. Spread cost is thus baked into
 * the position's entry/exit price; commission is accounted separately as cash.
 */
export function applySpread(price, isBuy, spreadBps = 0) {
    if (!spreadBps) return price
    const half = price * (spreadBps / 10_000) / 2
    return isBuy ? price + half : price - half
}

/**
 * Latest live quote for a symbol from the most recent 1-min candle (day fallback):
 * `{ c, h, l }` — close for marking P&L, high/low for intrabar touch triggers. null
 * if no candle. h/l fall back to c for degenerate feeds.
 */
export async function latestQuote(symbol) {
    for (const tf of ['1min', 'day']) {
        try {
            const candles = await getCandles(symbol, tf, 1)
            const last    = candles?.at(-1)
            if (last?.c != null) return { c: last.c, h: last.h ?? last.c, l: last.l ?? last.c }
        } catch (err) {
            logger.warn(LOG, `latestQuote ${symbol}/${tf} failed: ${err.message}`)
        }
    }
    return null
}

/** Latest live price for a symbol (most recent candle close), or null. */
export async function latestPrice(symbol) {
    return (await latestQuote(symbol))?.c ?? null
}

/**
 * Open a new virtual position and emit position.opened. `orderId` must be the id of
 * the order that opened it (the market order, or the resting-entry working order) —
 * the reconciler matches a resting-entry fill on accountId + orderId.
 *
 * The emit is deferred (setImmediate) so it lands AFTER any synchronous caller
 * (placeOrdersForIdea) finishes stamping the idea — mirroring a real broker's async
 * socket push.
 * @returns {Promise<string>} the new positionId
 */
export async function openPosition({ userId, accountId, symbol, direction, qty, price, orderId }) {
    const acct = await paperBrokerService.getOrCreateAccount(userId)
    const { spreadBps = 0, commissionPerTrade = 0 } = acct.settings ?? {}
    const fillPrice = applySpread(price, direction === 'long', spreadBps)

    const positionId = randomUUID()
    await paperBrokerService.insertPosition({
        userId, accountId, positionId,
        symbol, direction, qty,
        avgPrice:        fillPrice,   // effective entry — entry spread baked in
        entryCommission: commissionPerTrade,
        openedAt:        Date.now(),
        status:          'open',
    })

    // Entry commission is a realized cost (spread is already captured via avgPrice).
    if (commissionPerTrade) {
        await paperBrokerService.adjustBalance(userId, { cash: -commissionPerTrade, realizedPnl: -commissionPerTrade })
    }

    setImmediate(() => executionBus.emit('execution', {
        broker:    'paper',
        type:      'position.opened',
        userId,
        accountId,
        orderId,
        positionId,
        symbol,
        direction,
        quantity:  qty,
        price:     fillPrice,
        at:        Date.now(),
    }))
    logger.info(LOG, `Opened position ${positionId}: ${direction} ${qty} ${symbol} @ ${fillPrice} (mid ${price}, comm ${commissionPerTrade})`)
    return positionId
}

/**
 * Reduce a position by `qty` at `price`, bank realized P&L, and emit the matching
 * execution event. A full reduction closes the position (and cancels its resting
 * closing orders); a partial keeps it open and emits position.reduced.
 *
 * `orderId` (when the reduction came from a tracked closing order) is carried on the
 * event so the reconciler can match the exit slice and attribute the leg.
 */
export async function reducePosition({ userId, positionId, qty, price, reason = 'manual', orderId = null }) {
    const pos = await paperBrokerService.getPosition(userId, positionId)
    if (!pos || pos.status !== 'open') return
    const acct = await paperBrokerService.getOrCreateAccount(userId)
    const { spreadBps = 0, commissionPerTrade = 0 } = acct.settings ?? {}

    const closeQty  = Math.min(qty, pos.qty)
    // Closing trade side is the opposite of the position: close a long by SELLing (bid),
    // close a short by BUYing (ask). Spread + commission make the P&L honest.
    const exitPrice = applySpread(price, pos.direction === 'short', spreadBps)
    const gross     = (exitPrice - pos.avgPrice) * closeQty * dirSign(pos.direction)
    const net       = gross - commissionPerTrade
    await paperBrokerService.adjustBalance(userId, { cash: net, realizedPnl: net })

    const remaining = round8(pos.qty - closeQty)
    if (remaining > 0) {
        await paperBrokerService.updatePosition(userId, positionId, { qty: remaining })
        executionBus.emit('execution', {
            broker: 'paper', type: 'position.reduced', userId, accountId: pos.accountId,
            positionId, ...(orderId != null && { orderId }),
            symbol: pos.symbol, direction: pos.direction,
            quantity: closeQty, price: exitPrice, pnl: round2(net), reason, at: Date.now(),
        })
        logger.info(LOG, `Reduced position ${positionId} by ${closeQty} @ ${exitPrice} (net ${round2(net)}), ${remaining} left`)
        return
    }

    await paperBrokerService.updatePosition(userId, positionId, {
        status: 'closed', closedAt: Date.now(), exitPrice, realizedPnl: round2(net),
    })
    await _cancelClosingOrders(userId, positionId, orderId)
    executionBus.emit('execution', {
        broker: 'paper', type: 'position.closed', userId, accountId: pos.accountId,
        positionId, ...(orderId != null && { orderId }),
        symbol: pos.symbol, direction: pos.direction,
        price: exitPrice, pnl: round2(net), reason, at: Date.now(),
    })
    logger.info(LOG, `Closed position ${positionId} @ ${exitPrice} (net ${round2(net)})`)
}

/**
 * Mark-to-market the account: cash + Σ unrealized (open positions valued at the live
 * price). The single source of truth for equity, used by getAccount and the equity-
 * curve snapshotter. Identity: equity = startingBalance + realizedPnl + unrealized.
 * @returns {Promise<{currency,cashBalance,realizedPnl,unrealized,equity,openPositions}>}
 */
export async function computeEquity(userId) {
    const acct      = await paperBrokerService.getOrCreateAccount(userId)
    const positions = await paperBrokerService.listPositions(userId, { status: 'open' })

    let unrealized = 0
    if (positions.length) {
        const symbols = [...new Set(positions.map(p => p.symbol))]
        const priceBy = new Map(await Promise.all(symbols.map(async s => [s, await latestPrice(s)])))
        for (const p of positions) {
            const px = priceBy.get(p.symbol)
            if (px == null) continue
            unrealized += (px - p.avgPrice) * p.qty * dirSign(p.direction)
        }
    }
    return {
        currency:      acct.currency,
        cashBalance:   round2(acct.cashBalance),
        realizedPnl:   round2(acct.realizedPnl),
        unrealized:    round2(unrealized),
        equity:        round2(acct.cashBalance + unrealized),
        openPositions: positions.length,
    }
}

/** Cancel all working orders that close the given position (except the one that filled). */
async function _cancelClosingOrders(userId, positionId, exceptOrderId = null) {
    const working = await paperBrokerService.listOrders(userId, { status: 'working' })
    for (const o of working) {
        if (String(o.positionId) === String(positionId) && String(o.orderId) !== String(exceptOrderId)) {
            await paperBrokerService.updateOrder(userId, o.orderId, { status: 'cancelled', cancelledAt: Date.now() })
        }
    }
}

export const paperExecutionService = { openPosition, reducePosition, computeEquity, latestPrice, applySpread, dirSign, round2 }
