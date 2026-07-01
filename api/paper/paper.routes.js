/**
 * Paper trading routes (the simulation account).
 *
 * The paper BROKER (orders/positions/account) is served generically under
 * /api/broker/paper/* like any adapter. These routes own the paper-specific surface:
 * the global mode toggle, account config, the equity curve, and trade history.
 *
 * Route map (all requireAuth):
 *   GET  /api/paper/state          { enabled, account: {currency,startingBalance,equity,cash,realizedPnl,unrealized,openPositions}, settings }
 *   PUT  /api/paper/mode           { enabled } → turn paper mode on/off
 *   PUT  /api/paper/settings       { spreadBps?, commissionPerTrade? } → cost settings
 *   POST /api/paper/reset          { startingBalance? } → wipe positions/orders, restore balance
 *   GET  /api/paper/trades         ?status=&limit= → trade history (paper)
 *   GET  /api/paper/equity-curve   ?fromMs= → equity points
 */

import { Router }              from 'express'
import { paperBrokerService }  from '../broker/paperBroker.service.js'
import { computeEquity }       from '../broker/paperExecution.service.js'
import { tradeCaptureService } from '../../services/tradeCapture.service.js'
import { requireAuth }         from '../../middleware/auth.middleware.js'
import { logger }              from '../../services/logger.service.js'

const LOG = '[paper.routes]'

export const paperRoutes = Router()

/** Full paper state: mode flag + account config + live mark-to-market. */
async function _state(userId) {
    const [acct, eq] = await Promise.all([
        paperBrokerService.getOrCreateAccount(userId),
        computeEquity(userId),
    ])
    return {
        enabled:  !!acct.enabled,
        settings: acct.settings ?? {},
        account: {
            currency:        eq.currency,
            startingBalance: acct.startingBalance,
            equity:          eq.equity,
            cashBalance:     eq.cashBalance,
            realizedPnl:     eq.realizedPnl,
            unrealized:      eq.unrealized,
            openPositions:   eq.openPositions,
        },
    }
}

paperRoutes.get('/state', requireAuth, async (req, res) => {
    try {
        res.json(await _state(req.user._id))
    } catch (err) {
        logger.error(LOG, 'state error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.put('/mode', requireAuth, async (req, res) => {
    try {
        await paperBrokerService.setEnabled(req.user._id, !!req.body?.enabled)
        res.json(await _state(req.user._id))
    } catch (err) {
        logger.error(LOG, 'mode error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.put('/settings', requireAuth, async (req, res) => {
    try {
        const { spreadBps, commissionPerTrade } = req.body ?? {}
        await paperBrokerService.updateSettings(req.user._id, { spreadBps, commissionPerTrade })
        res.json(await _state(req.user._id))
    } catch (err) {
        logger.error(LOG, 'settings error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.post('/reset', requireAuth, async (req, res) => {
    try {
        const startingBalance = req.body?.startingBalance != null ? Number(req.body.startingBalance) : undefined
        await paperBrokerService.resetAccount(req.user._id, { startingBalance })
        res.json(await _state(req.user._id))
    } catch (err) {
        logger.error(LOG, 'reset error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.get('/trades', requireAuth, async (req, res) => {
    try {
        const trades = await tradeCaptureService.listTrades(req.user._id, {
            mode:   'paper',
            status: req.query.status,
            limit:  req.query.limit != null ? Number(req.query.limit) : undefined,
        })
        res.json({ trades })
    } catch (err) {
        logger.error(LOG, 'trades error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.get('/equity-curve', requireAuth, async (req, res) => {
    try {
        const points = await paperBrokerService.listEquityCurve(req.user._id, {
            fromMs: req.query.fromMs != null ? Number(req.query.fromMs) : undefined,
        })
        res.json({ points })
    } catch (err) {
        logger.error(LOG, 'equity-curve error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})
