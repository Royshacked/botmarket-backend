import { paperBrokerService, VIRTUAL_MODES } from '../broker/paperBroker.service.js'
import { computeEquity }       from '../broker/paperExecution.service.js'
import { tradeCaptureService } from '../../services/tradeCapture.service.js'
import { logger }              from '../../services/logger.service.js'

const LOG = '[paper:controller]'

/** The virtual account mode for a list/create request — 'paper' (default) or 'manual'.
 *  The per-account routes are mode-agnostic (the accountId encodes its mode); only
 *  list + create need to say which mode's accounts they operate on. */
const _mode = raw => (VIRTUAL_MODES.includes(raw) ? raw : 'paper')

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

// Shared error responder for these handlers (paper uses status-carrying errors).
function _fail(res, err, label) {
    logger.error(LOG, `${label}:`, err.message)
    res.status(err.status ?? 500).json({ error: err.message })
}

// ── Per-account (multi-account) ───────────────────────────────────────────────

export async function listAccounts(req, res) {
    try {
        const accts    = await paperBrokerService.listAccounts(req.user._id, { mode: _mode(req.query.mode) })
        const accounts = await Promise.all(accts.map(a => _accountState(req.user._id, a)))
        res.json({ accounts })
    } catch (err) { _fail(res, err, 'list accounts error') }
}

export async function createAccount(req, res) {
    try {
        const { name, startingBalance, currency, mode } = req.body ?? {}
        const acct = await paperBrokerService.createAccount(req.user._id, { mode: _mode(mode), name, startingBalance, currency })
        res.status(201).json(await _accountState(req.user._id, acct))
    } catch (err) { _fail(res, err, 'create account error') }
}

export async function patchAccount(req, res) {
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
    } catch (err) { _fail(res, err, 'patch account error') }
}

export async function deleteAccount(req, res) {
    try {
        await paperBrokerService.deleteAccount(req.user._id, req.params.accountId)
        res.json({ ok: true })
    } catch (err) { _fail(res, err, 'delete account error') }
}

export async function resetAccount(req, res) {
    try {
        const { accountId } = req.params
        const startingBalance = req.body?.startingBalance != null ? Number(req.body.startingBalance) : undefined
        await paperBrokerService.resetAccount(req.user._id, accountId, { startingBalance })
        const acct = await paperBrokerService.getAccount(req.user._id, accountId)
        res.json(await _accountState(req.user._id, acct))
    } catch (err) { _fail(res, err, 'reset account error') }
}

export async function accountEquityCurve(req, res) {
    try {
        const { accountId } = req.params
        await _requireAccount(req.user._id, accountId)
        const points = await paperBrokerService.listEquityCurve(req.user._id, {
            accountId,
            fromMs: req.query.fromMs != null ? Number(req.query.fromMs) : undefined,
        })
        res.json({ points })
    } catch (err) { _fail(res, err, 'account equity-curve error') }
}

export async function accountTrades(req, res) {
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
    } catch (err) { _fail(res, err, 'account trades error') }
}

// ── Legacy single-account (transitional) ──────────────────────────────────────

export async function getState(req, res) {
    try {
        res.json(await _state(req.user._id))
    } catch (err) { _fail(res, err, 'state error') }
}

export async function setMode(req, res) {
    try {
        await paperBrokerService.setEnabled(req.user._id, !!req.body?.enabled)
        res.json(await _state(req.user._id))
    } catch (err) { _fail(res, err, 'mode error') }
}

export async function updateSettings(req, res) {
    try {
        const { spreadBps, commissionPerTrade } = req.body ?? {}
        const acct = await paperBrokerService.getOrCreateDefaultAccount(req.user._id, 'paper')
        await paperBrokerService.updateSettings(req.user._id, acct.accountId, { spreadBps, commissionPerTrade })
        res.json(await _state(req.user._id))
    } catch (err) { _fail(res, err, 'settings error') }
}

export async function resetDefault(req, res) {
    try {
        const startingBalance = req.body?.startingBalance != null ? Number(req.body.startingBalance) : undefined
        const acct = await paperBrokerService.getOrCreateDefaultAccount(req.user._id, 'paper')
        await paperBrokerService.resetAccount(req.user._id, acct.accountId, { startingBalance })
        res.json(await _state(req.user._id))
    } catch (err) { _fail(res, err, 'reset error') }
}

export async function getTrades(req, res) {
    try {
        const trades = await tradeCaptureService.listTrades(req.user._id, {
            mode:   'paper',
            status: req.query.status,
            limit:  req.query.limit != null ? Number(req.query.limit) : undefined,
        })
        res.json({ trades })
    } catch (err) { _fail(res, err, 'trades error') }
}

export async function getEquityCurve(req, res) {
    try {
        const acct   = await paperBrokerService.getOrCreateDefaultAccount(req.user._id, 'paper')
        const points = await paperBrokerService.listEquityCurve(req.user._id, {
            accountId: acct.accountId,
            fromMs:    req.query.fromMs != null ? Number(req.query.fromMs) : undefined,
        })
        res.json({ points })
    } catch (err) { _fail(res, err, 'equity-curve error') }
}
