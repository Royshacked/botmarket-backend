/**
 * Paper (simulation) broker adapter — the TRADING half of a virtual venue.
 *
 * A broker with no venue: it fills against the LIVE price feed and tracks a virtual
 * per-user account, so the existing monitor + reconciler run unchanged. Paper trades
 * the app's CANONICAL asset symbols directly (no CFD aliasing — there is no paper
 * entry in brokerSymbol.service), so order.symbol is fed straight to the OHLCV feed.
 *
 * The reads (account, trading accounts, positions, single-position lookup) are the shared
 * VirtualAdapter's; this class owns what makes paper PAPER: market orders fill instantly
 * through paperExecution, limit/stop orders rest in paperOrders for the fill engine
 * (monitoring/paperFill.service), and the cost model (spread / commission / advisory
 * leverage cap) lives on the account's settings. See docs/architecture/paper-trading-simulation.md.
 *
 * N user-named accounts per user; equity = cashBalance + Σ unrealized (open positions
 * marked to the live price). Cash moves only by realized P&L and commission, so equity is
 * always cash + unrealized with no notional bookkeeping.
 */

import { randomUUID }         from 'crypto'
import { NO_PRICE }           from './broker.interface.js'
import { VirtualAdapter }     from './virtual.adapter.js'
import { paperBrokerService } from '../paperBroker.service.js'
import { openPosition,
         reducePosition,
         addToPaperPosition,
         exitMarkPrice,
         entryMarkPrice }     from '../paperExecution.service.js'
import { round2 }             from '../../../services/number.util.js'
import { logger }             from '../../../services/logger.service.js'

const LOG = '[paper.adapter]'

/**
 * The refusal that means "our own price feed had nothing", as opposed to a venue declining the
 * trade. On a real broker those are the same event; here they are not — this venue has no book,
 * so a "rejection" is only ever us being unable to read a price. Tagging it lets the order layer
 * answer with that fact instead of reporting a data outage as a broker rejection.
 */
function noPriceError(symbol) {
    const err = new Error(`paper: no live price for ${symbol}`)
    err.code   = NO_PRICE
    err.symbol = symbol
    return err
}

export class PaperAdapter extends VirtualAdapter {

    brokerType  = 'paper'
    brokerLabel = 'Paper'

    // ── Connection ───────────────────────────────────────────────────────────────

    /**
     * Paper is "connected" when paper MODE is on — the toggle on the default paper account — not
     * merely when an account exists (VirtualAdapter's default, which manual keeps). This is the
     * flag `connections.paper` carries and resolveWorkspace keys on: paper-connected IS the
     * workspace switch, so a user who owns a paper account but has the mode off is standing in
     * live or manual, and this must say so.
     */
    async isConnected(userId) {
        return paperBrokerService.isEnabled(userId)
    }

    // ── Account ──────────────────────────────────────────────────────────────────

    /**
     * Exposure model: marginUsed = Σ notional. A buying-power cap (settings.maxLeverage) is
     * ADVISORY — freeMargin/marginLevel reflect it for display, but a fill is never blocked
     * (see computeEquity). This is the one venue with a leverage readout; manual has none.
     */
    _leverageFields(acct, eq) {
        const maxLeverage = Number(acct.settings?.maxLeverage) || 0
        return {
            marginLevel: eq.marginUsed > 0 ? round2((eq.equity / eq.marginUsed) * 100) : null,
            leverage:    maxLeverage || null,
        }
    }

    /** The same cap, on the account list: cash × maxLeverage, or null when the cap is off. */
    _buyingPower(acct) {
        const maxLeverage = Number(acct.settings?.maxLeverage) || 0
        return maxLeverage > 0 ? round2(acct.cashBalance * maxLeverage) : null
    }

    // ── Trading ──────────────────────────────────────────────────────────────────

    capabilities() {
        // Exits rest as positionId closing orders (nativeProtection:false), matching
        // the live design — the Phase 2 fill engine watches and fills them.
        return {
            trading:          true,
            nativeProtection: false,
            modifyProtection: false,
            closePosition:    true,
            cancelOrder:      true,
            listOrders:       true,
            amendOrder:       true,
            ohlcv:            false,
            selfExecuted:     false,
        }
    }

    /**
     * Place an order. MARKET orders fill instantly at the live price (opening a new position,
     * reducing one when positionId is set, or GROWING one when increasePositionId is set).
     * LIMIT/STOP orders — resting entries and positionId closing exits — are stored working and
     * filled by the paper fill engine (paperFill.service).
     *
     * Paper NETS a scale-in (see addToPaperPosition): the echoed positionId is the one that was
     * grown, never a new one. That is the simulation being faithful to a netting venue rather than
     * to our own storage convenience — see the note on `increasePositionId` in broker.interface.
     * @returns {Promise<{ orderId: string, positionId?: string, accountId: string }>}
     */
    async placeOrder(userId, accountId, order) {
        // The chosen account is passed by the dispatch — orders/positions are stamped with it,
        // not a derived id. That is what lets ONE idea span several paper accounts: the order
        // plan carries a leg per account and each lands in its own book. (This used to read
        // "an idea binds to exactly one paper account"; that was a frontend selector rule, since
        // lifted, never a property of this store.)
        const acctId  = accountId
        const orderId = randomUUID()

        if (order.type === 'market') {
            // Closing market order (a monitor's stop/TP, a reduce) → apply against the position.
            // Priced like every other exit (see closePosition): an exit that has already been
            // DECIDED must not fail for want of a live quote — a stop that doesn't execute
            // because the 1-min feed 429'd is the worst failure this venue has.
            if (order.positionId != null) {
                const pos = await paperBrokerService.getPosition(userId, order.positionId)
                const { price, source } = await exitMarkPrice(order.symbol, pos?.currentPrice)
                if (price == null) throw new Error(`paper: no price for ${order.symbol}`)
                if (source !== 'live') {
                    logger.warn(LOG, `exit order on ${order.positionId} (${order.symbol}): no live quote — filling at the ${source === 'day' ? 'day close' : 'last stamped mark'} ${price}`)
                }
                await paperBrokerService.insertOrder(this._orderDoc({
                    userId, accountId: acctId, orderId, order, status: 'filled', fillPrice: price,
                }))
                await reducePosition({ userId, positionId: order.positionId, qty: order.quantity, price, reason: 'manual', orderId })
                return { orderId, accountId: acctId }
            }

            // Scale-in → grow the named position and blend its average, the way a netting venue
            // reports it. Checked AFTER the reduce branch on purpose: an order carrying both fields
            // is a caller bug, and reducing a position we were asked to grow is the recoverable
            // mistake of the two. Priced with the strict entry rule below, not the exit rule above —
            // it IS an entry, and a slice blended in at a stale close misstates the holding's cost
            // basis for the rest of its life.
            if (order.increasePositionId != null) {
                const { price, source } = await entryMarkPrice(order.symbol)
                if (price == null) throw noPriceError(order.symbol)
                if (source === 'retry') logger.info(LOG, `scale-in on ${order.symbol}: first quote blinked, filled at ${price} on the retry`)

                const grown = await addToPaperPosition({
                    userId, positionId: order.increasePositionId, addQty: order.quantity, price, orderId,
                })
                // The position was gone (closed between the decision and the fill). Refuse rather
                // than fall through to opening a new one: the caller asked to grow a holding, and
                // silently opening a fresh position instead is how an exited name comes back to life.
                if (!grown) throw new Error(`paper: position ${order.increasePositionId} is not open — nothing to scale into`)

                await paperBrokerService.insertOrder(this._orderDoc({
                    // The SLICE's price, not the position's blended average — this row is what this
                    // order paid, and the blend lives on the position.
                    userId, accountId: acctId, orderId, order, status: 'filled', fillPrice: grown.fillPrice,
                    positionId: grown.positionId,
                }))
                return { orderId, positionId: grown.positionId, accountId: acctId }
            }

            // Opening market order → new position. This one KEEPS the strict live-price rule:
            // an entry filled at a stale day close would misstate the trade's basis for its whole
            // life, and refusing to open is recoverable in a way a wrong entry price isn't. So
            // entryMarkPrice never degrades — it just asks a second time, past the poll cache,
            // before believing that the price is genuinely unavailable rather than that we asked
            // at a bad instant.
            const { price, source } = await entryMarkPrice(order.symbol)
            if (price == null) throw noPriceError(order.symbol)
            if (source === 'retry') logger.info(LOG, `entry on ${order.symbol}: first quote blinked, filled at ${price} on the retry`)

            const positionId = await openPosition({
                userId, accountId: acctId, symbol: order.symbol,
                direction: order.direction, qty: order.quantity, price, orderId,
            })
            await paperBrokerService.insertOrder(this._orderDoc({
                userId, accountId: acctId, orderId, order, status: 'filled', fillPrice: price, positionId,
            }))
            return { orderId, positionId, accountId: acctId }
        }

        // Working order (limit/stop): rests until the fill engine triggers it.
        await paperBrokerService.insertOrder(this._orderDoc({
            userId, accountId: acctId, orderId, order, status: 'working',
        }))
        logger.info(LOG, `Working ${order.type} order rested: ${order.direction} ${order.quantity} ${order.symbol} @ ${order.stopPrice ?? order.limitPrice}${order.positionId != null ? ` (closes ${order.positionId})` : ''}`)
        return { orderId, accountId: acctId }
    }

    // Scoped to the account when the caller names one (a user may own several); the generic
    // dispatch passes none and gets every working order. It used to ignore accountId entirely.
    async listOrders(userId, accountId) {
        const orders = await paperBrokerService.listOrders(userId, { status: 'working', accountId })
        return orders.map(o => ({
            orderId:    o.orderId,
            symbol:     o.symbol,
            side:       o.direction,
            type:       o.type,
            price:      o.triggerPrice,
            quantity:   o.qty,
            positionId: o.positionId ?? null,
            accountId:  o.accountId,
        }))
    }

    /**
     * Cancel a WORKING order. Guarded on `status:'working'` (claimOrder), not an unconditional
     * `$set`: a cancel that lands after the fill engine claimed the order — a stale `exitOrders`
     * record, or the user's ✕ a beat after the fill — used to flip a FILLED row to 'cancelled' in
     * paperOrders, which is the ledger's source. A real venue rejects a cancel on a filled order
     * the same way; the throw carries the same message shape as cTrader's "order not found".
     */
    async cancelOrder(userId, accountId, orderId) {
        const won = await paperBrokerService.claimOrder(
            userId, orderId,
            { status: 'working' },
            { status: 'cancelled', cancelledAt: Date.now() },
        )
        if (!won) throw Object.assign(new Error(`paper: order ${orderId} is not working — nothing to cancel`), { status: 409 })
        logger.info(LOG, `Cancelled working order ${orderId}`)
    }

    /** Re-price a WORKING order in place. Same guard as cancelOrder, for the same reason. */
    async amendOrder(userId, accountId, orderId, { limitPrice, stopPrice } = {}) {
        const price = limitPrice ?? stopPrice
        if (price == null) throw new Error('paper: amendOrder requires a new limitPrice or stopPrice')
        // `amendedAt` makes the write a modification even when the price is unchanged — claimOrder
        // answers on modifiedCount, and a same-price amend must not read as "not working".
        const won = await paperBrokerService.claimOrder(userId, orderId, { status: 'working' }, { triggerPrice: price, amendedAt: Date.now() })
        if (!won) throw Object.assign(new Error(`paper: order ${orderId} is not working — nothing to amend`), { status: 409 })
        return { orderId }
    }

    /**
     * Close (or partially close) a position — the reduce/close events are emitted by
     * reducePosition so the reconciler reacts as for a real broker.
     *
     * Priced through exitMarkPrice, NOT latestMarkPrice: every caller here (the user's ✕, a
     * monitor's exit condition, a rebalance trim) has already decided to be out, so the price is
     * a bookkeeping detail, not the trigger. This used to throw when the 1-min feed was down —
     * a routine FMP 429 — and the user got a 500 on a market close with no way out of the
     * position. It now degrades to the day close, then to the last stamped mark, and only throws
     * when the symbol has no resolvable price at all.
     */
    async closePosition(userId, accountId, positionId, opts = {}) {
        const pos = await paperBrokerService.getPosition(userId, positionId)
        if (!pos || pos.status !== 'open') throw new Error(`paper: position ${positionId} not open`)
        const { price, source } = await exitMarkPrice(pos.symbol, pos.currentPrice)
        if (price == null) throw new Error(`paper: no price for ${pos.symbol}`)
        // A fill booked off a degraded price is still a fill, but it should never be silent —
        // the realized P&L it banks is only as good as the price it used.
        if (source !== 'live') {
            logger.warn(LOG, `closePosition ${positionId} (${pos.symbol}): no live quote — booking at the ${source === 'day' ? 'day close' : 'last stamped mark'} ${price}`)
        }
        await reducePosition({ userId, positionId, qty: opts.quantity ?? pos.qty, price, reason: opts.reason ?? 'manual' })
    }

    // ── Execution feed ─────────────────────────────────────────────────────────────
    // The working-order watch loop is the global paperFill.service (started in server.js),
    // not a per-account feed. Report active so the reconciler treats paper like any broker.
    async startExecutionFeed() {
        return true
    }

    // ── Internals ──────────────────────────────────────────────────────────────────

    _orderDoc({ userId, accountId, orderId, order, status, fillPrice = null, positionId = null }) {
        return {
            userId, accountId, orderId,
            positionId:   positionId ?? order.positionId ?? null,
            symbol:       order.symbol,
            direction:    order.direction,
            type:         order.type,
            qty:          order.quantity,
            triggerPrice: order.stopPrice ?? order.limitPrice ?? null,
            status,
            fillPrice,
            createdAt:    Date.now(),
            ...(status === 'filled' && { filledAt: Date.now() }),
        }
    }
}
