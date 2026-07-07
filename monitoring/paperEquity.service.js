/**
 * Paper equity-curve snapshotter.
 *
 * Periodically marks every paper account that holds an open position to market and
 * appends an equity point, so the simulation has a mark-to-market curve (not just
 * realized steps at trade close). While an account is flat its equity is constant —
 * the last realized point — so we only snapshot users with open positions and let the
 * frontend hold the last value across the gaps.
 *
 * See docs/architecture/paper-trading-simulation.md (Phase 3).
 */

import { paperBrokerService }   from '../api/broker/paperBroker.service.js'
import { computeEquity }        from '../api/broker/paperExecution.service.js'
import { logger }               from '../services/logger.service.js'

const LOG          = '[paperEquity.service]'
const INTERVAL_MS  = Number(process.env.PAPER_EQUITY_SNAPSHOT_MS) || 300_000   // 5 min

let _timer   = null
let _running = false

export const paperEquityService = { start, stop, snapshotAccount, _tick }

function start() {
    if (_timer) return
    _timer = setInterval(() => { _tick().catch(err => logger.error(LOG, 'tick error:', err.message)) }, INTERVAL_MS)
    logger.info(LOG, `Equity snapshotter started (every ${INTERVAL_MS / 1000}s)`)
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null }
}

/** Snapshot one account's current equity into its curve. */
async function snapshotAccount(userId, accountId) {
    const eq = await computeEquity(userId, accountId)
    await paperBrokerService.insertEquitySnapshot({
        userId,
        accountId,
        ts:            Date.now(),
        equity:        eq.equity,
        cashBalance:   eq.cashBalance,
        realizedPnl:   eq.realizedPnl,
        unrealized:    eq.unrealized,
        openPositions: eq.openPositions,
    })
    return eq
}

async function _tick() {
    if (_running) return
    _running = true
    try {
        const accounts = await paperBrokerService.listActiveAccounts()
        for (const { userId, accountId } of accounts) {
            await snapshotAccount(userId, accountId).catch(err =>
                logger.error(LOG, `snapshot failed (account ${accountId}): ${err.message}`))
        }
        if (accounts.length) logger.info(LOG, `Snapshotted equity for ${accounts.length} active account(s)`)
    } finally {
        _running = false
    }
}
