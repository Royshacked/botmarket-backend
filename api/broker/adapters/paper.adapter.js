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
import { BrokerAdapter, NO_PRICE } from './broker.interface.js'
import { paperBrokerService } from '../paperBroker.service.js'
import { openPosition,
         reducePosition,
         addToPaperPosition,
         computeEquity,
         committedByAccount,
         deployable,
         latestMarkPrice,
         exitMarkPrice,
         entryMarkPrice,
         dirSign, round2 }    from '../paperExecution.service.js'
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
        // blocked (see computeEquity).
        // With leverage OFF this used to report freeMargin = equity, which counts the value of what
        // the account already holds as though it were spendable. Deployable cash is cash not yet
        // committed (see `deployable`) — equity is what the account is WORTH, not what it can buy.
        const maxLeverage = Number(acct.settings?.maxLeverage) || 0
        return {
            id:          acct.accountId,
            login:       acct.accountId,
            broker:      'Paper',
            currency:    eq.currency,
            balance:     eq.cashBalance,
            equity:      eq.equity,
            margin:      eq.marginUsed,
            freeMargin:  deployable(eq),
            marginLevel: eq.marginUsed > 0 ? round2((eq.equity / eq.marginUsed) * 100) : null,
            leverage:    maxLeverage || null,
        }
    }

    async getTradingAccounts(userId) {
        let accts = await paperBrokerService.listAccounts(userId, { mode: 'paper' })
        if (!accts.length) accts = [await paperBrokerService.getOrCreateDefaultAccount(userId, 'paper')]
        // Cash minus what is already committed to open positions. A virtual account's cash does NOT
        // drop when a position opens (see committedByAccount), so balance alone tells an agent it has
        // capital that is in fact invested. One query for all accounts, no quotes.
        const committed = await committedByAccount(userId)
        return accts.map(acct => ({
            id:       acct.accountId,
            login:    acct.accountId,
            name:     acct.name,
            currency: acct.currency,
            balance:  round2(acct.cashBalance),
            freeMargin: deployable({
                cashBalance: acct.cashBalance,
                marginUsed:  committed.get(String(acct.accountId)) ?? 0,
                buyingPower: Number(acct.settings?.maxLeverage) > 0
                    ? round2(acct.cashBalance * Number(acct.settings.maxLeverage))
                    : null,
            }),
            broker:   'Paper',
            isLive:   false,
        }))
    }

    // ── Positions ────────────────────────────────────────────────────────────────

    async getPositions(userId, accountId) {
        return this._getPositionsForMode(userId, accountId, this.brokerType)
    }

    // Shared getPositions core (paper + manual). Scope to one account when the caller names
    // it (a user may own several accounts); otherwise return every open position whose account
    // is in THIS adapter's mode, so paper and manual positions never leak into each other's
    // view. Prices and per-account currency are each resolved once.
    async _getPositionsForMode(userId, accountId, mode) {
        const all        = await paperBrokerService.listPositions(userId, { status: 'open', accountId })
        const positions  = accountId ? all : all.filter(p => paperBrokerService.accountMode(p.accountId) === mode)
        const priceBy    = await this._priceMap(positions.map(p => p.symbol))
        const currencyBy = await this._currencyMap(userId, positions.map(p => p.accountId))
        return positions.map(p => this._toBrokerPosition(p, priceBy.get(p.symbol), currencyBy.get(p.accountId)))
    }

    /**
     * Authoritative single-position lookup (broker-authoritative reconciler contract):
     * the open position, or null when it's gone. Never throws on "not found".
     */
    async findOpenPosition(userId, accountId, positionId) {
        const pos = await paperBrokerService.getPosition(userId, positionId)
        if (!pos || pos.status !== 'open') return null
        const price    = await latestMarkPrice(pos.symbol)
        const currency = (await paperBrokerService.getAccount(userId, pos.accountId))?.currency ?? 'USD'
        return this._toBrokerPosition(pos, price, currency)
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

    _toBrokerPosition(p, currentPrice = null, currency = 'USD') {
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
            currency,
        }
    }

    /** Map of symbol → mark price for the distinct symbols given (real-time quote for
     *  equities, candle-close fallback otherwise). Used to price P&L, not to fill. */
    async _priceMap(symbols) {
        const distinct = [...new Set(symbols)]
        const entries  = await Promise.all(distinct.map(async s => [s, await latestMarkPrice(s)]))
        return new Map(entries)
    }

    /** Map of accountId → account currency for the distinct accounts given, so a position
     *  reports its OWN account's currency (a user may hold non-USD virtual accounts). */
    async _currencyMap(userId, accountIds) {
        const distinct = [...new Set(accountIds)]
        const entries  = await Promise.all(distinct.map(async id => [id, (await paperBrokerService.getAccount(userId, id))?.currency ?? 'USD']))
        return new Map(entries)
    }
}
