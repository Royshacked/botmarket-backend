/**
 * Manual (broker-less real-money) adapter.
 *
 * For a user who trades REAL money at an institution that can't be wired to the app. The
 * app can't place orders or read fills, so this adapter is DATA-ONLY: it surfaces the
 * user's manual accounts + positions from the shared virtual store (the same store paper
 * uses, `mode:'manual'`) so the normal positions view and mark-to-market work unchanged.
 *
 * Every read is the shared VirtualAdapter's, scoped by `brokerType`. What this class adds is
 * the GUARD on every trading op — the manual lifecycle never places or closes through a
 * broker. Instead the two user confirmations (entry fill, exit fill) drive
 * manualExecution.service directly. See docs/architecture/manual-mode.md.
 */

import { VirtualAdapter } from './virtual.adapter.js'

export class ManualAdapter extends VirtualAdapter {

    brokerType  = 'manual'
    brokerLabel = 'Manual'

    // Data-only: nothing is placed, reconciled or protected through this adapter.
    //
    // `selfExecuted` is the one that says WHY, and it is what every consumer branches on: the
    // account holder places and closes, so a caller must post its card and record the intent
    // rather than reach for a trading method (all of which throw, below). The other eight flags
    // only say what is missing; this one says who does it instead.
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
            selfExecuted:     true,
        }
    }

    // No leverage readout: manual has no cost model and no margin model (see VirtualAdapter's
    // default, which is exactly that) — stated here so the choice is visible beside the guards.

    // ── Trading guards — the manual lifecycle is user-confirmed, never broker-placed ──
    // startExecutionFeed is left at the base default (false): there is no feed, and saying
    // otherwise made the reconciler count one it could never hear.
    async placeOrder()   { throw new Error('manual mode: orders are confirmed by the user, not placed through a broker') }
    async closePosition(){ throw new Error('manual mode: exits are confirmed by the user, not closed through a broker') }
    async cancelOrder()  { throw new Error('manual mode: no broker orders to cancel') }
    async amendOrder()   { throw new Error('manual mode: no broker orders to amend') }
    async setProtection(){ throw new Error('manual mode: no native protection') }
    async listOrders()   { return [] }
}
