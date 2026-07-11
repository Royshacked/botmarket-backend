/**
 * Manual (broker-less real-money) adapter.
 *
 * For a user who trades REAL money at an institution that can't be wired to the app. The
 * app can't place orders or read fills, so this adapter is DATA-ONLY: it surfaces the
 * user's manual accounts + positions from the shared virtual store (the same store paper
 * uses, `mode:'manual'`) so the normal positions view and mark-to-market work unchanged.
 *
 * It reuses PaperAdapter's read plumbing (_toBrokerPosition / _priceMap / findOpenPosition
 * / resolveSymbol) but overrides the mode-specific reads and GUARDS every trading op — the
 * manual lifecycle never places or closes through a broker. Instead the two user
 * confirmations (entry fill, exit fill) drive manualExecution.service directly. See
 * docs/architecture/manual-mode.md.
 */

import { PaperAdapter }       from './paper.adapter.js'
import { paperBrokerService } from '../paperBroker.service.js'
import { computeEquity, round2 } from '../paperExecution.service.js'

const MANUAL = 'manual'

export class ManualAdapter extends PaperAdapter {

    brokerType  = 'manual'
    brokerLabel = 'Manual'

    // The account IS the connection — connected when the user owns ≥1 manual account.
    async isConnected(userId) {
        return (await paperBrokerService.listAccounts(userId, { mode: MANUAL })).length > 0
    }

    // Data-only: nothing is placed, reconciled or protected through this adapter.
    capabilities() {
        return {
            trading:          false,
            nativeProtection: false,
            modifyProtection: false,
            closePosition:    false,
            cancelOrder:      false,
            listOrders:       false,
            amendOrder:       false,
            ohlcv:            false,
        }
    }

    // `accountId` picks a specific manual account; the generic dispatch (no id) resolves the
    // user's oldest manual account. Never auto-creates (manual accounts are explicit).
    async getAccount(userId, accountId) {
        const acct = accountId
            ? await paperBrokerService.getAccount(userId, accountId)
            : (await paperBrokerService.listAccounts(userId, { mode: MANUAL }))[0]
        if (!acct) throw Object.assign(new Error(`manual account ${accountId ?? ''} not found`), { status: 404 })
        const eq = await computeEquity(userId, acct.accountId)
        // No cost model / leverage cap → no margin bookkeeping (free margin == equity).
        return {
            id:          acct.accountId,
            login:       acct.accountId,
            broker:      'Manual',
            currency:    eq.currency,
            balance:     eq.cashBalance,
            equity:      eq.equity,
            margin:      eq.marginUsed,
            freeMargin:  eq.equity,
            marginLevel: null,
            leverage:    null,
        }
    }

    async getTradingAccounts(userId) {
        const accts = await paperBrokerService.listAccounts(userId, { mode: MANUAL })
        return accts.map(acct => ({
            id:       acct.accountId,
            login:    acct.accountId,
            name:     acct.name,
            currency: acct.currency,
            balance:  round2(acct.cashBalance),
            broker:   'Manual',
            isLive:   false,
        }))
    }

    // Manual positions only — the shared core (PaperAdapter) filters by this adapter's mode
    // so paper and manual positions never leak into each other's view.
    async getPositions(userId, accountId) {
        return this._getPositionsForMode(userId, accountId, MANUAL)
    }

    // ── Trading guards — the manual lifecycle is user-confirmed, never broker-placed ──
    async placeOrder()   { throw new Error('manual mode: orders are confirmed by the user, not placed through a broker') }
    async closePosition(){ throw new Error('manual mode: exits are confirmed by the user, not closed through a broker') }
    async cancelOrder()  { throw new Error('manual mode: no broker orders to cancel') }
    async amendOrder()   { throw new Error('manual mode: no broker orders to amend') }
    async setProtection(){ throw new Error('manual mode: no native protection') }
    async listOrders()   { return [] }
}
