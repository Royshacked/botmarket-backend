/**
 * Manual execution primitives — the Layer B swap for broker-less real-money mode.
 *
 * Where paperExecution SIMULATES a fill (cost model + executionBus emit → reconciler),
 * manualExecution RECORDS a fill the user actually made off-platform: it writes the
 * position to the shared virtual store (the same `paperPositions`/account store, keyed by
 * a `manual-…` accountId) at the user-REPORTED price, with NO cost model (a real fill
 * already includes real spread/commission) and NO executionBus emit (nothing to reconcile
 * — the confirm endpoint flips the idea status directly).
 *
 * See docs/architecture/manual-mode.md.
 */

import { randomUUID }         from 'crypto'
import { paperBrokerService } from './paperBroker.service.js'
import { dirSign, round2 }    from './paperExecution.service.js'
import { logger }             from '../../services/logger.service.js'

const LOG = '[manualExecution]'

/**
 * Record a manual position the user opened off-platform, at the price/size they report.
 * No spread/commission is applied — the reported price is the effective entry. Emits
 * nothing (the manual lifecycle is driven by the user's confirmations, not a reconciler).
 * @returns {Promise<string>} the new positionId
 */
export async function openManualPosition({ userId, accountId, symbol, direction, qty, price }) {
    const acct = await paperBrokerService.getAccount(userId, accountId)
    if (!acct) throw new Error(`manual openPosition: account ${accountId} not found`)
    if (!(qty > 0))    throw new Error(`manual openPosition: quantity must be > 0 (got ${qty})`)
    if (!(price > 0))  throw new Error(`manual openPosition: price must be > 0 (got ${price})`)

    const positionId = randomUUID()
    await paperBrokerService.insertPosition({
        userId, accountId, positionId,
        symbol, direction, qty,
        avgPrice:        price,   // reported fill — no cost adjustment
        entryCommission: 0,
        openedAt:        Date.now(),
        status:          'open',
    })
    logger.info(LOG, `Manual position ${positionId} opened: ${direction} ${qty} ${symbol} @ ${price} (acct ${accountId})`)
    return positionId
}

/**
 * Record a manual position the user closed off-platform, at the exit price they report.
 * Banks the (gross) realized P&L to the account — no commission. v1 closes in full.
 * @returns {Promise<{ positionId: string, pnl: number, exitPrice: number }|null>} null if not open
 */
export async function closeManualPosition({ userId, positionId, price, reason = 'manual' }) {
    const pos = await paperBrokerService.getPosition(userId, positionId)
    if (!pos || pos.status !== 'open') {
        logger.warn(LOG, `closeManualPosition: position ${positionId} not open — skipping`)
        return null
    }
    if (!(price > 0)) throw new Error(`manual closePosition: price must be > 0 (got ${price})`)

    const net = round2((price - pos.avgPrice) * pos.qty * dirSign(pos.direction))
    await paperBrokerService.adjustBalance(userId, pos.accountId, { cash: net, realizedPnl: net })
    await paperBrokerService.updatePosition(userId, positionId, {
        status: 'closed', closedAt: Date.now(), exitPrice: price, realizedPnl: net,
    })
    logger.info(LOG, `Manual position ${positionId} closed @ ${price} (pnl ${net}, ${reason})`)
    return { positionId, pnl: net, exitPrice: price }
}

/**
 * Record a PARTIAL manual close (a trim) at the user-reported price: bank the realized P&L on the
 * closed size and shrink the position, or fully close it when the reported size meets/exceeds what's
 * open. Same shared-store + no-emit contract as closeManualPosition (the confirm endpoint updates the
 * idea directly). `qty` is the size the user reports they closed.
 * @returns {Promise<{ positionId, pnl, exitPrice, closedQty, remainingQty, closed }|null>} null if not open
 */
export async function reduceManualPosition({ userId, positionId, qty, price, reason = 'manual' }) {
    const pos = await paperBrokerService.getPosition(userId, positionId)
    if (!pos || pos.status !== 'open') {
        logger.warn(LOG, `reduceManualPosition: position ${positionId} not open — skipping`)
        return null
    }
    if (!(price > 0)) throw new Error(`manual reducePosition: price must be > 0 (got ${price})`)
    const closeQty = Math.min(Number(qty), pos.qty)
    if (!(closeQty > 0)) throw new Error(`manual reducePosition: quantity must be > 0 (got ${qty})`)

    // Realized P&L banks on the closed slice only; the remaining size keeps its original avg price.
    const net = round2((price - pos.avgPrice) * closeQty * dirSign(pos.direction))
    await paperBrokerService.adjustBalance(userId, pos.accountId, { cash: net, realizedPnl: net })

    const remainingQty = round2(pos.qty - closeQty)
    if (remainingQty > 0) {
        await paperBrokerService.updatePosition(userId, positionId, { qty: remainingQty })
        logger.info(LOG, `Manual position ${positionId} trimmed by ${closeQty} @ ${price} (pnl ${net}, ${remainingQty} left)`)
        return { positionId, pnl: net, exitPrice: price, closedQty: closeQty, remainingQty, closed: false }
    }
    await paperBrokerService.updatePosition(userId, positionId, {
        status: 'closed', closedAt: Date.now(), exitPrice: price, realizedPnl: net,
    })
    logger.info(LOG, `Manual position ${positionId} fully closed via trim @ ${price} (pnl ${net}, ${reason})`)
    return { positionId, pnl: net, exitPrice: price, closedQty: closeQty, remainingQty: 0, closed: true }
}

/**
 * Record an ADD to an existing manual position (scale-in) at the user-reported price: grow the size
 * and blend the average entry (size-weighted). No balance change (manual has no cost model — P&L banks
 * on close against the blended avg). Same shared-store + no-emit contract as the others.
 * @returns {Promise<{ positionId, qty, avgPrice, addedQty }|null>} null if not open
 */
export async function addToManualPosition({ userId, positionId, addQty, price }) {
    const pos = await paperBrokerService.getPosition(userId, positionId)
    if (!pos || pos.status !== 'open') {
        logger.warn(LOG, `addToManualPosition: position ${positionId} not open — skipping`)
        return null
    }
    const add = Number(addQty)
    if (!(add > 0))   throw new Error(`manual addPosition: quantity must be > 0 (got ${addQty})`)
    if (!(price > 0)) throw new Error(`manual addPosition: price must be > 0 (got ${price})`)

    const newQty = round2(pos.qty + add)
    const newAvg = round2((pos.avgPrice * pos.qty + price * add) / newQty)   // size-weighted blend
    await paperBrokerService.updatePosition(userId, positionId, { qty: newQty, avgPrice: newAvg })
    logger.info(LOG, `Manual position ${positionId} added ${add} @ ${price} → ${newQty} @ ${newAvg}`)
    return { positionId, qty: newQty, avgPrice: newAvg, addedQty: add }
}

export const manualExecutionService = { openManualPosition, closeManualPosition, reduceManualPosition, addToManualPosition }
