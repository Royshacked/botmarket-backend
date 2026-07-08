/**
 * Paper (simulation) broker adapter.
 *
 * A broker with no venue: it fills against the LIVE price feed and tracks a virtual
 * per-user account, so the existing monitor + reconciler run unchanged. Paper trades
 * the app's CANONICAL asset symbols directly (no CFD aliasing — there is no paper
 * entry in brokerSymbol.service), so order.symbol is fed straight to the OHLCV feed.
 *
 * Build status (docs/architecture/paper-trading-simulation.md):
 *   Phase 1 — account + adapter skeleton: market fills, close, list/cancel/amend.  DONE
 *   Phase 2 (this) — fill engine triggers resting entries + closing exits; this
 *                    adapter delegates position mutation to paperExecution.service.  DONE
 *   Phase 3 — costs (spread/commission) + margin model.
 *
 * One simulated account per user; equity = cashBalance + Σ unrealized (open positions
 * marked to the live price). Cash moves only by realized P&L, so equity is always
 * cash + unrealized with no notional bookkeeping.
 */

import { randomUUID }         from 'crypto'
import { BrokerAdapter }      from './broker.interface.js'
import { paperBrokerService } from '../paperBroker.service.js'
import { openPosition,
         reducePosition,
         computeEquity,
         latestPrice,
         latestMarkPrice,
         dirSign, round2 }    from '../paperExecution.service.js'
import { logger }             from '../../../services/logger.service.js'

const LOG = '[paper.adapter]'

export class PaperAdapter extends BrokerAdapter {

    brokerType  = 'paper'
    brokerLabel = 'Paper'

    // ── Connection ───────────────────────────────────────────────────────────────
    // No OAuth / socket — the account IS the connection. It's created on first use.

    async isConnected(userId) {
        return (await paperBrokerService.listAccounts(userId, { mode: 'paper' })).length > 0
    }

    // ── Account ──────────────────────────────────────────────────────────────────
    // `accountId` picks a specific paper account; callers that don't carry one (the
    // generic broker dispatch) resolve the user's DEFAULT paper account.

    async getAccount(userId, accountId) {
        const acct = accountId
            ? await paperBrokerService.getAccount(userId, accountId)
            : await paperBrokerService.getOrCreateDefaultAccount(userId, 'paper')
        if (!acct) throw Object.assign(new Error(`paper account ${accountId} not found`), { status: 404 })
        const eq = await computeEquity(userId, acct.accountId)

        // Exposure model: marginUsed = Σ notional. A buying-power cap (settings.maxLeverage)
        // is ADVISORY — freeMargin/marginLevel reflect it for display, but a fill is never
        // blocked (see computeEquity). maxLeverage 0 = off → buyingPower null, freeMargin == equity.
        const maxLeverage = Number(acct.settings?.maxLeverage) || 0
        return {
            id:          acct.accountId,
            login:       acct.accountId,
            broker:      'Paper',
            currency:    eq.currency,
            balance:     eq.cashBalance,
            equity:      eq.equity,
            margin:      eq.marginUsed,
            freeMargin:  eq.buyingPower != null ? Math.max(0, round2(eq.buyingPower - eq.marginUsed)) : eq.equity,
            marginLevel: eq.marginUsed > 0 ? round2((eq.equity / eq.marginUsed) * 100) : null,
            leverage:    maxLeverage || null,
        }
    }

    async getTradingAccounts(userId) {
        let accts = await paperBrokerService.listAccounts(userId, { mode: 'paper' })
        if (!accts.length) accts = [await paperBrokerService.getOrCreateDefaultAccount(userId, 'paper')]
        return accts.map(acct => ({
            id:       acct.accountId,
            login:    acct.accountId,
            name:     acct.name,
            currency: acct.currency,
            balance:  round2(acct.cashBalance),
            broker:   'Paper',
            isLive:   false,
        }))
    }

    // ── Positions ────────────────────────────────────────────────────────────────

    async getPositions(userId, accountId) {
        // Scope to one account when the caller names it (a user may own several paper
        // accounts); otherwise return every PAPER position — filter by account mode so a
        // manual position (same store, different mode) never leaks into the paper view.
        const all       = await paperBrokerService.listPositions(userId, { status: 'open', accountId })
        const positions = accountId ? all : all.filter(p => paperBrokerService.accountMode(p.accountId) === 'paper')
        const priceBy   = await this._priceMap(positions.map(p => p.symbol))
        return positions.map(p => this._toBrokerPosition(p, priceBy.get(p.symbol)))
    }

    /**
     * Authoritative single-position lookup (broker-authoritative reconciler contract):
     * the open position, or null when it's gone. Never throws on "not found".
     */
    async findOpenPosition(userId, accountId, positionId) {
        const pos = await paperBrokerService.getPosition(userId, positionId)
        if (!pos || pos.status !== 'open') return null
        const price = await latestMarkPrice(pos.symbol)
        return this._toBrokerPosition(pos, price)
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
        }
    }

    /**
     * Paper trades the app's canonical asset directly (no CFD aliasing), so the symbol
     * resolves to itself. found:true = paper is a valid venue for this instrument.
     */
    async resolveSymbol(userId, accountId, symbol) {
        return { symbol, found: true }
    }

    /**
     * Place an order. MARKET orders fill instantly at the live price (opening a new
     * position, or reducing one when positionId is set). LIMIT/STOP orders — resting
     * entries and positionId closing exits — are stored working and filled by the
     * paper fill engine (paperFill.service).
     * @returns {Promise<{ orderId: string, positionId?: string, accountId: string }>}
     */
    async placeOrder(userId, accountId, order) {
        // The chosen account is passed by the dispatch (an idea binds to exactly one
        // paper account) — orders/positions are stamped with it, not a derived id.
        const acctId  = accountId
        const orderId = randomUUID()

        if (order.type === 'market') {
            const price = await latestPrice(order.symbol)
            if (price == null) throw new Error(`paper: no price for ${order.symbol}`)

            // Closing market order (monitor close / reduce) → apply against the position.
            if (order.positionId != null) {
                await paperBrokerService.insertOrder(this._orderDoc({
                    userId, accountId: acctId, orderId, order, status: 'filled', fillPrice: price,
                }))
                await reducePosition({ userId, positionId: order.positionId, qty: order.quantity, price, reason: 'manual', orderId })
                return { orderId, accountId: acctId }
            }

            // Opening market order → new position.
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

    async listOrders(userId, accountId) {
        const orders = await paperBrokerService.listOrders(userId, { status: 'working' })
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

    async cancelOrder(userId, accountId, orderId) {
        await paperBrokerService.updateOrder(userId, orderId, { status: 'cancelled', cancelledAt: Date.now() })
        logger.info(LOG, `Cancelled working order ${orderId}`)
    }

    async amendOrder(userId, accountId, orderId, { limitPrice, stopPrice } = {}) {
        const price = limitPrice ?? stopPrice
        if (price == null) throw new Error('paper: amendOrder requires a new limitPrice or stopPrice')
        await paperBrokerService.updateOrder(userId, orderId, { triggerPrice: price })
        return { orderId }
    }

    /**
     * Close (or partially close) a position at the live price — the reduce/close events
     * are emitted by reducePosition so the reconciler reacts as for a real broker.
     */
    async closePosition(userId, accountId, positionId, opts = {}) {
        const pos = await paperBrokerService.getPosition(userId, positionId)
        if (!pos || pos.status !== 'open') throw new Error(`paper: position ${positionId} not open`)
        const price = await latestPrice(pos.symbol)
        if (price == null) throw new Error(`paper: no price for ${pos.symbol}`)
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

    _toBrokerPosition(p, currentPrice = null) {
        // Prefer this call's live price; when the fetch missed, fall back to the last
        // mark stamped by the paperMark loop so P&L doesn't blank out between ticks.
        const markPrice = currentPrice ?? p.currentPrice ?? null
        const pnl = markPrice != null
            ? (markPrice - p.avgPrice) * p.qty * dirSign(p.direction)
            : null
        return {
            id:           p.positionId,
            symbol:       p.symbol,
            direction:    p.direction,
            volume:       p.qty,
            entryPrice:   p.avgPrice,
            currentPrice: markPrice,
            pnl:          pnl != null ? round2(pnl) : null,
            pnlPips:      null,
            swap:         null,
            openedAt:     p.openedAt,
            accountId:    p.accountId,
            accountNo:    p.accountId,
            currency:     'USD',
        }
    }

    /** Map of symbol → mark price for the distinct symbols given (real-time quote for
     *  equities, candle-close fallback otherwise). Used to price P&L, not to fill. */
    async _priceMap(symbols) {
        const distinct = [...new Set(symbols)]
        const entries  = await Promise.all(distinct.map(async s => [s, await latestMarkPrice(s)]))
        return new Map(entries)
    }
}
