/**
 * Paper trading routes (the simulation account).
 *
 * The paper BROKER (orders/positions/account) is served generically under
 * /api/broker/paper/* like any adapter. These routes own the paper-specific surface:
 * the global mode toggle, account config, the equity curve, and trade history.
 *
 * Route map (all requireAuth):
 *   Per-account (multi-account):
 *   GET    /api/paper/accounts                      → list all paper accounts (+ live equity)
 *   POST   /api/paper/accounts                      { name?, startingBalance?, currency? } → create
 *   PATCH  /api/paper/accounts/:accountId           { name?, spreadBps?, commissionPerTrade? } → rename + settings
 *   DELETE /api/paper/accounts/:accountId           → delete (409 if it holds an open position)
 *   POST   /api/paper/accounts/:accountId/reset     { startingBalance? } → wipe + restore balance
 *   GET    /api/paper/accounts/:accountId/equity-curve ?fromMs=
 *   GET    /api/paper/accounts/:accountId/trades       ?status=&limit=
 *
 *   Legacy single-account (TRANSITIONAL — operate on the default paper account):
 *   GET  /api/paper/state          { enabled, account: {...}, settings }
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

/**
 * Full paper state: mode flag + account config + live mark-to-market.
 * TRANSITIONAL: reports the user's DEFAULT paper account until the per-idea account
 * picker + per-account UI replace these single-account endpoints. Reshapes the shared
 * per-account DTO (_accountState) into the legacy `{ enabled, settings, account }` shape.
 */
async function _state(userId) {
    const acct = await paperBrokerService.getOrCreateDefaultAccount(userId, 'paper')
    const s    = await _accountState(userId, acct)
    return {
        enabled:  s.enabled,
        settings: s.settings,
        account: {
            accountId:       s.accountId,
            name:            s.name,
            currency:        s.currency,
            startingBalance: s.startingBalance,
            equity:          s.equity,
            cashBalance:     s.cashBalance,
            realizedPnl:     s.realizedPnl,
            unrealized:      s.unrealized,
            openPositions:   s.openPositions,
        },
    }
}

/** Per-account DTO: config + live mark-to-market. */
async function _accountState(userId, acct) {
    const eq = await computeEquity(userId, acct.accountId)
    return {
        accountId:       acct.accountId,
        name:            acct.name,
        mode:            acct.mode,
        enabled:         !!acct.enabled,
        settings:        acct.settings ?? {},
        currency:        eq.currency,
        startingBalance: acct.startingBalance,
        equity:          eq.equity,
        cashBalance:     eq.cashBalance,
        realizedPnl:     eq.realizedPnl,
        unrealized:      eq.unrealized,
        openPositions:   eq.openPositions,
        marginUsed:      eq.marginUsed,
        buyingPower:     eq.buyingPower,
        overLeveraged:   eq.overLeveraged,
    }
}

/** Resolve an owned account or throw 404 (guards the :accountId routes). */
async function _requireAccount(userId, accountId) {
    const acct = await paperBrokerService.getAccount(userId, accountId)
    if (!acct) throw Object.assign(new Error(`account ${accountId} not found`), { status: 404 })
    return acct
}

// ── Per-account (multi-account) ───────────────────────────────────────────────

paperRoutes.get('/accounts', requireAuth, async (req, res) => {
    try {
        const accts    = await paperBrokerService.listAccounts(req.user._id, { mode: 'paper' })
        const accounts = await Promise.all(accts.map(a => _accountState(req.user._id, a)))
        res.json({ accounts })
    } catch (err) {
        logger.error(LOG, 'list accounts error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.post('/accounts', requireAuth, async (req, res) => {
    try {
        const { name, startingBalance, currency } = req.body ?? {}
        const acct = await paperBrokerService.createAccount(req.user._id, { mode: 'paper', name, startingBalance, currency })
        res.status(201).json(await _accountState(req.user._id, acct))
    } catch (err) {
        logger.error(LOG, 'create account error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.patch('/accounts/:accountId', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params
        await _requireAccount(req.user._id, accountId)
        const { name, spreadBps, commissionPerTrade, maxLeverage } = req.body ?? {}
        if (name != null) await paperBrokerService.renameAccount(req.user._id, accountId, name)
        if (spreadBps != null || commissionPerTrade != null || maxLeverage != null) {
            await paperBrokerService.updateSettings(req.user._id, accountId, { spreadBps, commissionPerTrade, maxLeverage })
        }
        const acct = await paperBrokerService.getAccount(req.user._id, accountId)
        res.json(await _accountState(req.user._id, acct))
    } catch (err) {
        logger.error(LOG, 'patch account error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.delete('/accounts/:accountId', requireAuth, async (req, res) => {
    try {
        await paperBrokerService.deleteAccount(req.user._id, req.params.accountId)
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'delete account error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.post('/accounts/:accountId/reset', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params
        const startingBalance = req.body?.startingBalance != null ? Number(req.body.startingBalance) : undefined
        await paperBrokerService.resetAccount(req.user._id, accountId, { startingBalance })
        const acct = await paperBrokerService.getAccount(req.user._id, accountId)
        res.json(await _accountState(req.user._id, acct))
    } catch (err) {
        logger.error(LOG, 'reset account error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.get('/accounts/:accountId/equity-curve', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params
        await _requireAccount(req.user._id, accountId)
        const points = await paperBrokerService.listEquityCurve(req.user._id, {
            accountId,
            fromMs: req.query.fromMs != null ? Number(req.query.fromMs) : undefined,
        })
        res.json({ points })
    } catch (err) {
        logger.error(LOG, 'account equity-curve error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.get('/accounts/:accountId/trades', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params
        await _requireAccount(req.user._id, accountId)
        const trades = await tradeCaptureService.listTrades(req.user._id, {
            mode:      'paper',
            accountId,
            status:    req.query.status,
            limit:     req.query.limit != null ? Number(req.query.limit) : undefined,
        })
        res.json({ trades })
    } catch (err) {
        logger.error(LOG, 'account trades error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

// ── Legacy single-account (transitional) ──────────────────────────────────────

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
        const acct = await paperBrokerService.getOrCreateDefaultAccount(req.user._id, 'paper')
        await paperBrokerService.updateSettings(req.user._id, acct.accountId, { spreadBps, commissionPerTrade })
        res.json(await _state(req.user._id))
    } catch (err) {
        logger.error(LOG, 'settings error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

paperRoutes.post('/reset', requireAuth, async (req, res) => {
    try {
        const startingBalance = req.body?.startingBalance != null ? Number(req.body.startingBalance) : undefined
        const acct = await paperBrokerService.getOrCreateDefaultAccount(req.user._id, 'paper')
        await paperBrokerService.resetAccount(req.user._id, acct.accountId, { startingBalance })
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
        const acct   = await paperBrokerService.getOrCreateDefaultAccount(req.user._id, 'paper')
        const points = await paperBrokerService.listEquityCurve(req.user._id, {
            accountId: acct.accountId,
            fromMs:    req.query.fromMs != null ? Number(req.query.fromMs) : undefined,
        })
        res.json({ points })
    } catch (err) {
        logger.error(LOG, 'equity-curve error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})
