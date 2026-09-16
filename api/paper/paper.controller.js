import { paperBrokerService, VIRTUAL_MODES } from '../broker/paperBroker.service.js'
import { computeEquity }       from '../broker/paperExecution.service.js'
import { tradeCaptureService } from '../../services/tradeCapture.service.js'
import { makeHandle }          from '../_shared/handle.util.js'
import { httpError }           from '../../services/httpError.util.js'

const LOG     = '[paper:controller]'
const _handle = makeHandle(LOG)

/** The virtual account mode for a list/create request — 'paper' (default) or 'manual'.
 *  The per-account routes are mode-agnostic (the accountId encodes its mode); only
 *  list + create need to say which mode's accounts they operate on. */
const _mode = raw => (VIRTUAL_MODES.includes(raw) ? raw : 'paper')

/**
 * Reports the user's DEFAULT (oldest) paper account, because that is where the paper toggle lives:
 * `enabled` on it is what resolveWorkspace and the header badge read. Reshapes the shared
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
    if (!acct) throw httpError(404, `account ${accountId} not found`)
    return acct
}

// ── Per-account (multi-account) ───────────────────────────────────────────────

export const listAccounts = _handle('listAccounts', async (req, res) => {
    const accts    = await paperBrokerService.listAccounts(req.user._id, { mode: _mode(req.query.mode) })
    const accounts = await Promise.all(accts.map(a => _accountState(req.user._id, a)))
    res.json({ accounts })
})

export const createAccount = _handle('createAccount', async (req, res) => {
    const { name, startingBalance, currency, mode } = req.body ?? {}
    const acct = await paperBrokerService.createAccount(req.user._id, { mode: _mode(mode), name, startingBalance, currency })
    res.status(201).json(await _accountState(req.user._id, acct))
})

export const patchAccount = _handle('patchAccount', async (req, res) => {
    const { accountId } = req.params
    await _requireAccount(req.user._id, accountId)
    const { name, spreadBps, commissionPerTrade, maxLeverage } = req.body ?? {}
    if (name != null) await paperBrokerService.renameAccount(req.user._id, accountId, name)
    if (spreadBps != null || commissionPerTrade != null || maxLeverage != null) {
        await paperBrokerService.updateSettings(req.user._id, accountId, { spreadBps, commissionPerTrade, maxLeverage })
    }
    const acct = await paperBrokerService.getAccount(req.user._id, accountId)
    res.json(await _accountState(req.user._id, acct))
})

export const deleteAccount = _handle('deleteAccount', async (req, res) => {
    await paperBrokerService.deleteAccount(req.user._id, req.params.accountId)
    res.json({ ok: true })
})

export const resetAccount = _handle('resetAccount', async (req, res) => {
    const { accountId } = req.params
    const startingBalance = req.body?.startingBalance != null ? Number(req.body.startingBalance) : undefined
    await paperBrokerService.resetAccount(req.user._id, accountId, { startingBalance })
    const acct = await paperBrokerService.getAccount(req.user._id, accountId)
    res.json(await _accountState(req.user._id, acct))
})

/**
 * Record a cash movement that happened outside any trade — a dividend, a deposit, a withdrawal, a fee.
 *
 * The drift ritual for a book we cannot read (docs/design/adopted-book.md §8): the bank pays a
 * dividend, we never see it, and the account's equity drifts a little further from the user's real one
 * every quarter. Signed amount; the store refuses an overdraw and never counts this as P&L.
 */
export const adjustAccountCash = _handle('adjustAccountCash', async (req, res) => {
    const { accountId } = req.params
    const { amount, reason } = req.body ?? {}
    await paperBrokerService.adjustCash(req.user._id, accountId, { amount, reason })
    const acct = await paperBrokerService.getAccount(req.user._id, accountId)
    res.json(await _accountState(req.user._id, acct))
})

export const accountEquityCurve = _handle('accountEquityCurve', async (req, res) => {
    const { accountId } = req.params
    await _requireAccount(req.user._id, accountId)
    const points = await paperBrokerService.listEquityCurve(req.user._id, {
        accountId,
        fromMs: req.query.fromMs != null ? Number(req.query.fromMs) : undefined,
    })
    res.json({ points })
})

export const accountTrades = _handle('accountTrades', async (req, res) => {
    const { accountId } = req.params
    await _requireAccount(req.user._id, accountId)
    const trades = await tradeCaptureService.listTrades(req.user._id, {
        mode:      'paper',
        accountId,
        status:    req.query.status,
        limit:     req.query.limit != null ? Number(req.query.limit) : undefined,
    })
    res.json({ trades })
})

// ── Default-account: the paper toggle ────────────────────────────────────────

export const getState = _handle('getState', async (req, res) => {
    res.json(await _state(req.user._id))
})

export const setMode = _handle('setMode', async (req, res) => {
    await paperBrokerService.setEnabled(req.user._id, !!req.body?.enabled)
    res.json(await _state(req.user._id))
})
