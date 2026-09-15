/**
 * Virtual-venue adapter base — everything paper and manual READ the same way.
 *
 * Both venues keep their state in the one virtual store (paperBroker.service: accounts, positions,
 * orders, equity), scoped by `mode` — so account summary, trading-account list, positions, the
 * single-position lookup and symbol resolution are one implementation reading `this.brokerType`.
 * What differs is how a position gets INTO the store — paper simulates a fill, manual records one
 * the user made elsewhere — and that is exactly the part the subclasses keep:
 *
 *   PaperAdapter   trading methods → paperExecution (fills against the live feed)
 *   ManualAdapter  trading methods THROW (selfExecuted: the user places and confirms)
 *
 * This used to be `ManualAdapter extends PaperAdapter`: inheritance for code reuse, not is-a, and
 * it leaked — manual inherited paper's "there is an execution feed" answer, and getAccount /
 * getTradingAccounts were copied into manual with the mode string changed. The base holds the
 * shared reads; the venue-specific hooks are small and named.
 *
 * READS DO NOT CREATE. Paper's getTradingAccounts used to mint a default account when the user
 * had none, and a comment elsewhere (tradingContext) had to explain why a read with that side
 * effect was "safe despite" running on every chat turn. Every caller gates on `connections.paper`
 * first, which already means an account exists; a user with none gets an empty list, and the
 * account is created where it should be — when the toggle is flipped (setEnabled) or the user
 * creates one.
 */

import { BrokerAdapter }      from './broker.interface.js'
import { paperBrokerService } from '../paperBroker.service.js'
import { computeEquity,
         committedByAccount,
         deployable,
         latestMarkPrice,
         dirSign }            from '../paperExecution.service.js'
import { round2 }             from '../../../services/number.util.js'
import { config }             from '../../../services/config.js'

// How old a stored mark may be before a positions READ goes and buys a fresh quote.
//
// The mark loop stamps `currentPrice` / `markedAt` on every open position every
// PAPER_MARK_INTERVAL_MS (3s), in whichever process holds the instance lease. The positions read
// used to ignore that and re-price every symbol on every call — and the client polls it every 4s,
// one beat past the 3s quote cache, so every poll refetched every symbol: 13 open symbols was
// 195 FMP requests a minute from a process that was not even running the mark loop, most of the
// plan's quota, and the reason candles for a chart came back 429 and the chart fell back to
// chart-img. A mark a few seconds old is exactly the price this read would have bought.
//
// Five intervals, not one: a follower process cannot see the leader's tick, a leader mid-tick has
// marks up to one interval old by construction, and a leader that has just died should age past
// this and let the read start pricing again — which is what it always did, and now only then.
const MARK_FRESH_MS = config.paperMarkIntervalMs * 5

export class VirtualAdapter extends BrokerAdapter {

    // Subclasses set brokerType ('paper' | 'manual' — the store's `mode`) and brokerLabel.

    // ── Connection ───────────────────────────────────────────────────────────────
    // No OAuth / socket — the account IS the connection: connected when the user owns ≥1.

    async isConnected(userId) {
        return (await paperBrokerService.listAccounts(userId, { mode: this.brokerType })).length > 0
    }

    // ── Account ──────────────────────────────────────────────────────────────────

    /**
     * `accountId` picks a specific account; the generic dispatch (no id) resolves the user's
     * oldest account in this mode. Never creates.
     */
    async getAccount(userId, accountId) {
        const acct = accountId
            ? await paperBrokerService.getAccount(userId, accountId)
            : (await paperBrokerService.listAccounts(userId, { mode: this.brokerType }))[0]
        if (!acct) throw Object.assign(new Error(`${this.brokerType} account ${accountId ?? ''} not found`), { status: 404 })
        const eq = await computeEquity(userId, acct.accountId)

        // Free margin is cash NOT yet committed to open positions, not equity: equity is what the
        // account is WORTH, holdings included, so reporting it as deployable double-counts them.
        // (See `deployable`.) With leverage OFF this used to report freeMargin = equity.
        return {
            id:          acct.accountId,
            login:       acct.accountId,
            broker:      this.brokerLabel,
            currency:    eq.currency,
            balance:     eq.cashBalance,
            equity:      eq.equity,
            margin:      eq.marginUsed,
            freeMargin:  deployable(eq),
            ...this._leverageFields(acct, eq),
        }
    }

    /**
     * The venue's leverage readout on the account summary. Paper models an ADVISORY buying-power
     * cap (settings.maxLeverage) and reports marginLevel against it; manual has no cost or margin
     * model, so both are null there. Override per venue.
     * @returns {{ marginLevel: number|null, leverage: number|null }}
     */
    // eslint-disable-next-line no-unused-vars
    _leverageFields(acct, eq) {
        return { marginLevel: null, leverage: null }
    }

    async getTradingAccounts(userId) {
        const accts     = await paperBrokerService.listAccounts(userId, { mode: this.brokerType })
        // Cash minus what is already committed to open positions. A virtual account's cash does NOT
        // drop when a position opens (see committedByAccount), so balance alone tells an agent it has
        // capital that is in fact invested. One query for all accounts, no quotes.
        const committed = await committedByAccount(userId)
        return accts.map(acct => {
            const maxLeverage = Number(acct.settings?.maxLeverage) || 0
            return {
                id:       acct.accountId,
                login:    acct.accountId,
                name:     acct.name,
                currency: acct.currency,
                balance:  round2(acct.cashBalance),
                freeMargin: deployable({
                    cashBalance: acct.cashBalance,
                    marginUsed:  committed.get(String(acct.accountId)) ?? 0,
                    buyingPower: maxLeverage > 0 ? round2(acct.cashBalance * maxLeverage) : null,
                }),
                broker:   this.brokerLabel,
                isLive:   false,
            }
        })
    }

    // ── Positions ────────────────────────────────────────────────────────────────

    /**
     * Scope to one account when the caller names it (a user may own several); otherwise return
     * every open position whose account is in THIS adapter's mode, so paper and manual positions
     * never leak into each other's view. Prices and per-account currency are each resolved once.
     */
    async getPositions(userId, accountId) {
        const all       = await paperBrokerService.listPositions(userId, { status: 'open', accountId })
        const positions = accountId ? all : all.filter(p => paperBrokerService.accountMode(p.accountId) === this.brokerType)
        const priceBy   = await this._priceMap(positions)
        const acctBy    = await this._accountMap(userId, positions.map(p => p.accountId))
        return positions.map(p => this._toBrokerPosition(p, priceBy.get(p.symbol), acctBy.get(p.accountId)))
    }

    /**
     * Authoritative single-position lookup (broker-authoritative reconciler contract):
     * the open position, or null when it's gone. Never throws on "not found".
     */
    async findOpenPosition(userId, accountId, positionId) {
        const pos = await paperBrokerService.getPosition(userId, positionId)
        if (!pos || pos.status !== 'open') return null
        const price = await latestMarkPrice(pos.symbol)
        const acct  = await paperBrokerService.getAccount(userId, pos.accountId)
        return this._toBrokerPosition(pos, price, acct)
    }

    /**
     * A virtual venue trades the app's canonical asset directly (no CFD aliasing), so the symbol
     * resolves to itself. found:true = this venue is valid for the instrument.
     */
    async resolveSymbol(userId, accountId, symbol) {
        return { symbol, found: true }
    }

    // ── Internals ──────────────────────────────────────────────────────────────────

    _toBrokerPosition(p, currentPrice = null, account = null) {
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
            // A VIRTUAL account is one the user NAMED ("Momentum", "RAZ TEST"), so the name is what
            // it should be called wherever it is shown — `accountNo` carries the long generated id,
            // which is a key, not a label. Reported from the desk: the positions view identified a
            // paper account by 40 characters of uuid. Free to send: the account doc is already read
            // here for its currency. Live brokers have no equivalent (their accounts carry a login
            // NUMBER and nothing else), so this field is absent there and the readers fall back.
            accountName:  account?.name ?? null,
            currency:     account?.currency ?? 'USD',
        }
    }

    /**
     * Map of symbol → mark price for the positions given. Used to price P&L, not to fill.
     *
     * THE STORED MARK FIRST. The mark loop already paid for a price on every open symbol a few
     * seconds ago and wrote it on the position; a read that buys it again is the request storm
     * described at MARK_FRESH_MS. Only a symbol with no mark, or a mark older than the window, is
     * fetched — which is the case the old behaviour was right for (a leader that stopped, a
     * position opened between ticks) and the only case it now handles.
     *
     * Freshest mark per symbol, since several positions can share one: the newest is the one
     * the loop wrote last, and one stale row among fresh ones must not force a fetch.
     */
    async _priceMap(positions, { now = Date.now(), fetch = latestMarkPrice, freshMs = MARK_FRESH_MS } = {}) {
        const stored = new Map()   // symbol → { price, at }
        for (const p of positions) {
            if (p.currentPrice == null || !Number.isFinite(p.markedAt)) continue
            const cur = stored.get(p.symbol)
            if (!cur || p.markedAt > cur.at) stored.set(p.symbol, { price: p.currentPrice, at: p.markedAt })
        }
        const distinct = [...new Set(positions.map(p => p.symbol))]
        const entries  = await Promise.all(distinct.map(async s => {
            const m = stored.get(s)
            if (m && now - m.at <= freshMs) return [s, m.price]
            return [s, await fetch(s)]
        }))
        return new Map(entries)
    }

    /** Map of accountId → its account doc for the distinct accounts given, so a position reports
     *  its OWN account's currency (a user may hold non-USD virtual accounts) and its OWN name. One
     *  read serves both — it was a currency-only map until the name was needed beside it. */
    async _accountMap(userId, accountIds) {
        const distinct = [...new Set(accountIds)]
        const entries  = await Promise.all(distinct.map(async id => [id, await paperBrokerService.getAccount(userId, id)]))
        return new Map(entries)
    }
}
