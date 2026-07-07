/**
 * Paper Broker Store
 *
 * Persistence for the simulation ("paper") broker — and, ahead of it, the future
 * broker-less MANUAL mode (same virtual-account plumbing, different fill source). The
 * paper adapter is a broker with no socket: instead of a real venue it reads/writes
 * virtual state here, so the existing monitor + reconciler drive it unchanged (see
 * docs/architecture/paper-trading-simulation.md).
 *
 * Accounts are MULTI-INSTANCE: a user owns N user-named virtual accounts per mode
 * ("Scalping", "Swing", "My Chase account"), each with its own balance, realized P&L,
 * cost settings, equity curve and trade history. The account is keyed by a generated,
 * stable `accountId` (`<mode>-<userId>-<short>`); the `name` is a mutable label. The
 * `<mode>-` prefix keeps `isPaperIdea`/mode-derivation working — the mode is derived
 * from the prefix, the account is the sub-dimension.
 *
 * Positions/orders/equity already carry `accountId`, so per-account scoping is a filter.
 *
 * Collections:
 *   paperAccounts   N per user — { mode, name, balance, cost settings }
 *   paperPositions  virtual open/closed positions (carry accountId)
 *   paperOrders     virtual working/filled/cancelled orders (carry accountId)
 *   paperEquity     per-account equity-curve points
 *
 * TRANSITIONAL: the routing fork (global paper toggle) and the legacy `/api/paper/*`
 * routes still assume a single account — they resolve `getOrCreateDefaultAccount`
 * until the per-idea account picker replaces the toggle (next step). `setEnabled`/
 * `isEnabled` likewise ride the default account for now.
 */

import { randomUUID } from 'crypto'
import { getDb }      from '../../providers/mongodb.provider.js'
import { logger }     from '../../services/logger.service.js'

const ACCOUNTS  = 'paperAccounts'
const POSITIONS = 'paperPositions'
const ORDERS    = 'paperOrders'
const EQUITY    = 'paperEquity'
const LOG       = '[paperBroker.service]'

/** Modes that share this virtual-account store. Paper = simulated fills; manual = user-reported. */
export const VIRTUAL_MODES = ['paper', 'manual']

/** Default account size + cost settings applied when an account is created. */
const DEFAULTS = {
    currency:        'USD',
    startingBalance: 100_000,
    settings: {
        spreadBps:          2,   // fill at mid ± spread/2 (paper only; manual reports real fills)
        commissionPerTrade: 0,   // flat per-fill commission
        maxLeverage:        0,   // buying-power cap = equity × maxLeverage; 0 = off (advisory, warn-not-block)
    },
}

// ─── Id helpers (pure) ────────────────────────────────────────────────────────

/**
 * Generate a stable virtual-account id: `<mode>-<userId>-<short>`. The `<mode>-`
 * prefix is what mode-derivation (`isPaperIdea` / `accountMode`) keys on; the short
 * suffix makes it unique so a user can hold several accounts per mode. userId is NOT
 * parsed back out of the id (it's stored on the doc), so a hyphenated userId is fine.
 * @param {'paper'|'manual'} mode
 * @param {string} userId
 * @returns {string}
 */
export function makeAccountId(mode, userId) {
    return `${mode}-${userId}-${randomUUID().slice(0, 8)}`
}

/**
 * The virtual mode an accountId belongs to, by prefix — 'paper' | 'manual' | null
 * (null = not a virtual account, e.g. a real broker account id).
 * @param {string} accountId
 * @returns {'paper'|'manual'|null}
 */
export function accountMode(accountId) {
    const id = String(accountId ?? '')
    return VIRTUAL_MODES.find(m => id.startsWith(`${m}-`)) ?? null
}

export const paperBrokerService = {
    makeAccountId,
    accountMode,
    // accounts
    listAccounts,
    getAccount,
    createAccount,
    renameAccount,
    deleteAccount,
    getOrCreateDefaultAccount,
    updateSettings,
    adjustBalance,
    resetAccount,
    // mode toggle (transitional — rides the default account)
    setEnabled,
    isEnabled,
    // positions
    listPositions,
    getPosition,
    insertPosition,
    updatePosition,
    // orders
    listOrders,
    getOrder,
    insertOrder,
    updateOrder,
    // equity curve
    listActiveAccounts,
    insertEquitySnapshot,
    listEquityCurve,
}

// ─── Accounts ───────────────────────────────────────────────────────────────

/**
 * All of a user's virtual accounts, oldest first.
 * @param {string} userId
 * @param {{ mode?: 'paper'|'manual' }} [filter]
 * @returns {Promise<object[]>}
 */
async function listAccounts(userId, { mode } = {}) {
    const db = await getDb()
    const q  = { userId }
    if (mode) q.mode = mode
    return db.collection(ACCOUNTS).find(q, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray()
}

/**
 * A specific account by id, or — when `accountId` is omitted — the user's default
 * (oldest) paper account, or null. The default-when-omitted form preserves the old
 * single-account read for the transitional seams (routing toggle) that don't yet carry
 * a chosen account. Never creates.
 * @param {string} userId
 * @param {string|null} [accountId]
 * @returns {Promise<object|null>}
 */
async function getAccount(userId, accountId = null) {
    const db = await getDb()
    if (accountId != null) {
        return db.collection(ACCOUNTS).findOne({ userId, accountId: String(accountId) }, { projection: { _id: 0 } })
    }
    return db.collection(ACCOUNTS).findOne({ userId, mode: 'paper' }, { projection: { _id: 0 }, sort: { createdAt: 1 } })
}

/**
 * Create a new named virtual account.
 * @param {string} userId
 * @param {{ mode?: 'paper'|'manual', name?: string, startingBalance?: number, currency?: string }} [opts]
 * @returns {Promise<object>} the created account doc
 */
async function createAccount(userId, { mode = 'paper', name, startingBalance, currency } = {}) {
    if (!VIRTUAL_MODES.includes(mode)) throw new Error(`unknown account mode: ${mode}`)
    const db      = await getDb()
    const balance = startingBalance != null ? Number(startingBalance) : DEFAULTS.startingBalance
    const doc = {
        userId,
        accountId:       makeAccountId(mode, userId),
        mode,
        name:            (name?.trim()) || (mode === 'manual' ? 'Manual' : 'Paper'),
        currency:        currency ?? DEFAULTS.currency,
        startingBalance: balance,
        cashBalance:     balance,
        realizedPnl:     0,
        enabled:         false,   // toggle state (transitional); routing reads this on the default account
        settings:        { ...DEFAULTS.settings },
        createdAt:       Date.now(),
        updatedAt:       Date.now(),
    }
    await db.collection(ACCOUNTS).insertOne({ ...doc })
    logger.info(LOG, `Created ${mode} account "${doc.name}" (${doc.accountId}) for user ${userId} — ${doc.currency} ${balance}`)
    return doc
}

/**
 * The user's default (oldest) account for a mode, creating one on first use. Used by
 * the transitional single-account seams (routing toggle, legacy /api/paper routes) that
 * don't yet carry a user-chosen account.
 * @param {string} userId
 * @param {'paper'|'manual'} [mode]
 * @returns {Promise<object>}
 */
async function getOrCreateDefaultAccount(userId, mode = 'paper') {
    const db       = await getDb()
    const existing = await db.collection(ACCOUNTS).findOne(
        { userId, mode }, { projection: { _id: 0 }, sort: { createdAt: 1 } }
    )
    return existing ?? createAccount(userId, { mode })
}

/** Rename an account (the user-facing label). */
async function renameAccount(userId, accountId, name) {
    const db = await getDb()
    await db.collection(ACCOUNTS).updateOne(
        { userId, accountId: String(accountId) },
        { $set: { name: String(name ?? '').trim(), updatedAt: Date.now() } }
    )
}

/**
 * Delete an account and cascade its virtual state (positions/orders/equity). Guarded:
 * refuses when the account still holds an OPEN position OR a WORKING (resting) order —
 * either means a live idea is bound to it, and cascade-wiping would orphan the idea at a
 * dead accountId. Throws a 409-tagged error so the route surfaces it. Paper data is
 * otherwise disposable.
 * @param {string} userId
 * @param {string} accountId
 */
async function deleteAccount(userId, accountId) {
    const db  = await getDb()
    const aid = String(accountId)
    const [open, working] = await Promise.all([
        db.collection(POSITIONS).countDocuments({ userId, accountId: aid, status: 'open' }),
        db.collection(ORDERS).countDocuments({ userId, accountId: aid, status: 'working' }),
    ])
    if (open > 0 || working > 0) {
        const what = open > 0 ? 'open positions' : 'resting orders'
        throw Object.assign(new Error(`account has ${what} — close them before deleting`), { status: 409 })
    }
    await Promise.all([
        db.collection(ACCOUNTS).deleteOne({ userId, accountId: aid }),
        db.collection(POSITIONS).deleteMany({ userId, accountId: aid }),
        db.collection(ORDERS).deleteMany({ userId, accountId: aid }),
        db.collection(EQUITY).deleteMany({ userId, accountId: aid }),
    ])
    logger.info(LOG, `Deleted account ${aid} (+ virtual state) for user ${userId}`)
}

/** Patch an account's cost/risk settings (spreadBps / commissionPerTrade / maxLeverage). */
async function updateSettings(userId, accountId, settings = {}) {
    const db  = await getDb()
    const set = {}
    if (settings.spreadBps          != null) set['settings.spreadBps']          = settings.spreadBps
    if (settings.commissionPerTrade != null) set['settings.commissionPerTrade'] = settings.commissionPerTrade
    if (settings.maxLeverage        != null) set['settings.maxLeverage']        = Math.max(0, Number(settings.maxLeverage) || 0)
    if (!Object.keys(set).length) return
    set.updatedAt = Date.now()
    await db.collection(ACCOUNTS).updateOne({ userId, accountId: String(accountId) }, { $set: set })
}

/**
 * Move cash and/or realized P&L on an account (atomic). Negative `cash` debits.
 * @param {string} userId
 * @param {string} accountId
 * @param {{ cash?: number, realizedPnl?: number }} delta
 */
async function adjustBalance(userId, accountId, { cash = 0, realizedPnl = 0 } = {}) {
    const db = await getDb()
    await db.collection(ACCOUNTS).updateOne(
        { userId, accountId: String(accountId) },
        { $inc: { cashBalance: cash, realizedPnl }, $set: { updatedAt: Date.now() } }
    )
}

/** Wipe one account's positions/orders/equity and restore its balance — a fresh sim run. */
async function resetAccount(userId, accountId, { startingBalance } = {}) {
    const db   = await getDb()
    const aid  = String(accountId)
    const acct = await getAccount(userId, aid)
    if (!acct) throw Object.assign(new Error(`account ${aid} not found`), { status: 404 })
    const base = startingBalance != null ? Number(startingBalance) : acct.startingBalance
    await Promise.all([
        db.collection(POSITIONS).deleteMany({ userId, accountId: aid }),
        db.collection(ORDERS).deleteMany({ userId, accountId: aid }),
        db.collection(EQUITY).deleteMany({ userId, accountId: aid }),
        db.collection(ACCOUNTS).updateOne(
            { userId, accountId: aid },
            { $set: { startingBalance: base, cashBalance: base, realizedPnl: 0, updatedAt: Date.now() } }
        ),
    ])
    logger.info(LOG, `Reset account ${aid} for user ${userId} → ${base}`)
}

// ─── Mode toggle (transitional) ───────────────────────────────────────────────
// The global paper toggle rides the user's default paper account until the per-idea
// account picker replaces it. Kept minimal so routing/listConnections keep working.

/** Turn paper MODE on/off on the default paper account (creates it on first enable). */
async function setEnabled(userId, enabled) {
    const db   = await getDb()
    const acct = await getOrCreateDefaultAccount(userId, 'paper')
    await db.collection(ACCOUNTS).updateOne(
        { userId, accountId: acct.accountId },
        { $set: { enabled: !!enabled, updatedAt: Date.now() } }
    )
    logger.info(LOG, `Paper mode ${enabled ? 'ENABLED' : 'disabled'} for user ${userId}`)
}

/** Whether paper mode is on (default paper account enabled). */
async function isEnabled(userId) {
    const acct = await getAccount(userId)
    return !!acct?.enabled
}

// ─── Positions ──────────────────────────────────────────────────────────────

/** @param {{ status?: 'open'|'closed', accountId?: string }} [filter] */
async function listPositions(userId, { status, accountId } = {}) {
    const db = await getDb()
    const q  = { userId }
    if (status)    q.status    = status
    if (accountId) q.accountId = String(accountId)
    return db.collection(POSITIONS).find(q, { projection: { _id: 0 } }).toArray()
}

async function getPosition(userId, positionId) {
    const db = await getDb()
    return db.collection(POSITIONS).findOne(
        { userId, positionId: String(positionId) },
        { projection: { _id: 0 } }
    )
}

async function insertPosition(doc) {
    const db = await getDb()
    await db.collection(POSITIONS).insertOne({ ...doc })
    return doc
}

async function updatePosition(userId, positionId, fields) {
    const db = await getDb()
    await db.collection(POSITIONS).updateOne(
        { userId, positionId: String(positionId) },
        { $set: fields }
    )
}

// ─── Orders ─────────────────────────────────────────────────────────────────

/** @param {{ status?: 'working'|'filled'|'cancelled', accountId?: string }} [filter] */
async function listOrders(userId, { status, accountId } = {}) {
    const db = await getDb()
    const q  = { userId }
    if (status)    q.status    = status
    if (accountId) q.accountId = String(accountId)
    return db.collection(ORDERS).find(q, { projection: { _id: 0 } }).toArray()
}

async function getOrder(userId, orderId) {
    const db = await getDb()
    return db.collection(ORDERS).findOne(
        { userId, orderId: String(orderId) },
        { projection: { _id: 0 } }
    )
}

async function insertOrder(doc) {
    const db = await getDb()
    await db.collection(ORDERS).insertOne({ ...doc })
    return doc
}

async function updateOrder(userId, orderId, fields) {
    const db = await getDb()
    await db.collection(ORDERS).updateOne(
        { userId, orderId: String(orderId) },
        { $set: fields }
    )
}

// ─── Equity curve ─────────────────────────────────────────────────────────────

/**
 * Distinct { userId, accountId } pairs that currently hold an open position — the
 * per-account snapshot targets for the equity-curve loop.
 * @returns {Promise<{ userId: string, accountId: string }[]>}
 */
async function listActiveAccounts() {
    const db   = await getDb()
    const rows = await db.collection(POSITIONS).aggregate([
        { $match: { status: 'open' } },
        { $group: { _id: { userId: '$userId', accountId: '$accountId' } } },
    ]).toArray()
    return rows.map(r => ({ userId: r._id.userId, accountId: r._id.accountId }))
}

/** Append one equity-curve point. @param {{userId,accountId,ts,equity,cashBalance,realizedPnl,unrealized,openPositions}} point */
async function insertEquitySnapshot(point) {
    const db = await getDb()
    await db.collection(EQUITY).insertOne({ ...point })
}

/**
 * Equity-curve points for one account, oldest first.
 * @param {string} userId
 * @param {{ accountId?: string, fromMs?: number, limit?: number }} [opts]
 */
async function listEquityCurve(userId, { accountId, fromMs, limit = 5000 } = {}) {
    const db = await getDb()
    const q  = { userId }
    if (accountId) q.accountId = String(accountId)
    if (fromMs != null) q.ts = { $gte: fromMs }
    return db.collection(EQUITY)
        .find(q, { projection: { _id: 0 } })
        .sort({ ts: 1 })
        .limit(limit)
        .toArray()
}
