/**
 * Paper Broker Store
 *
 * Persistence for the simulation ("paper") broker. The paper adapter is a broker
 * with no socket: instead of a real venue it reads/writes virtual state here, so
 * the existing monitor + reconciler drive it unchanged (see
 * docs/architecture/paper-trading-simulation.md).
 *
 * One simulated account per user. Positions and working orders are persisted (not
 * in-memory) so findOpenPosition / listOrders survive a restart.
 *
 * Collections:
 *   paperAccounts   one per user — virtual balance + cost settings
 *   paperPositions  virtual open/closed positions
 *   paperOrders     virtual working/filled/cancelled orders
 */

import { getDb }  from '../../providers/mongodb.provider.js'
import { logger } from '../../services/logger.service.js'

const ACCOUNTS  = 'paperAccounts'
const POSITIONS = 'paperPositions'
const ORDERS    = 'paperOrders'
const EQUITY    = 'paperEquity'
const LOG       = '[paperBroker.service]'

/** Default account size + cost settings applied when a user first enables paper mode. */
const DEFAULTS = {
    currency:          'USD',
    startingBalance:   100_000,
    enabled:           false,   // paper MODE off until the user toggles it on
    settings: {
        spreadBps:           2,   // fill at mid ± spread/2
        commissionPerTrade:  0,   // flat per-fill commission
    },
}

/** Stable per-user account id — one simulated account per user. */
export function paperAccountId(userId) {
    return `paper-${userId}`
}

export const paperBrokerService = {
    paperAccountId,
    getAccount,
    getOrCreateAccount,
    setEnabled,
    isEnabled,
    updateSettings,
    adjustBalance,
    resetAccount,
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
    listActiveUserIds,
    insertEquitySnapshot,
    listEquityCurve,
}

// ─── Accounts ───────────────────────────────────────────────────────────────

/** @returns {Promise<object|null>} the user's paper account, or null if not enabled. */
async function getAccount(userId) {
    const db = await getDb()
    return db.collection(ACCOUNTS).findOne({ userId }, { projection: { _id: 0 } })
}

/**
 * Return the user's paper account, creating it with defaults on first use.
 * @param {string} userId
 * @param {{ startingBalance?: number, currency?: string }} [opts]
 */
async function getOrCreateAccount(userId, opts = {}) {
    const db       = await getDb()
    const existing = await db.collection(ACCOUNTS).findOne({ userId }, { projection: { _id: 0 } })
    if (existing) return existing

    const startingBalance = opts.startingBalance ?? DEFAULTS.startingBalance
    const doc = {
        userId,
        accountId:       paperAccountId(userId),
        currency:        opts.currency ?? DEFAULTS.currency,
        startingBalance,
        cashBalance:     startingBalance,
        realizedPnl:     0,
        enabled:         DEFAULTS.enabled,
        settings:        { ...DEFAULTS.settings },
        createdAt:       Date.now(),
        updatedAt:       Date.now(),
    }
    await db.collection(ACCOUNTS).insertOne({ ...doc })
    logger.info(LOG, `Created paper account for user ${userId} (${doc.currency} ${startingBalance})`)
    return doc
}

/** Turn paper MODE on/off (creates the account on first enable). When on, new ideas route to paper. */
async function setEnabled(userId, enabled) {
    const db = await getDb()
    await getOrCreateAccount(userId)
    await db.collection(ACCOUNTS).updateOne(
        { userId },
        { $set: { enabled: !!enabled, updatedAt: Date.now() } }
    )
    logger.info(LOG, `Paper mode ${enabled ? 'ENABLED' : 'disabled'} for user ${userId}`)
}

/** Whether paper mode is on for this user (no account → off). */
async function isEnabled(userId) {
    const acct = await getAccount(userId)
    return !!acct?.enabled
}

/** Patch the account's cost settings (spreadBps / commissionPerTrade). */
async function updateSettings(userId, settings = {}) {
    const db  = await getDb()
    const set = {}
    if (settings.spreadBps          != null) set['settings.spreadBps']          = settings.spreadBps
    if (settings.commissionPerTrade != null) set['settings.commissionPerTrade'] = settings.commissionPerTrade
    if (!Object.keys(set).length) return
    set.updatedAt = Date.now()
    await db.collection(ACCOUNTS).updateOne({ userId }, { $set: set })
}

/**
 * Move cash and/or realized P&L on the account (atomic). Negative `cash` debits.
 * @param {string} userId
 * @param {{ cash?: number, realizedPnl?: number }} delta
 */
async function adjustBalance(userId, { cash = 0, realizedPnl = 0 } = {}) {
    const db = await getDb()
    await db.collection(ACCOUNTS).updateOne(
        { userId },
        { $inc: { cashBalance: cash, realizedPnl }, $set: { updatedAt: Date.now() } }
    )
}

/** Wipe positions/orders and restore balance — used to reset a simulation run. */
async function resetAccount(userId, { startingBalance } = {}) {
    const db   = await getDb()
    const acct = await getOrCreateAccount(userId, { startingBalance })
    const base = startingBalance ?? acct.startingBalance
    await Promise.all([
        db.collection(POSITIONS).deleteMany({ userId }),
        db.collection(ORDERS).deleteMany({ userId }),
        db.collection(ACCOUNTS).updateOne(
            { userId },
            { $set: { startingBalance: base, cashBalance: base, realizedPnl: 0, updatedAt: Date.now() } }
        ),
    ])
    logger.info(LOG, `Reset paper account for user ${userId} → ${base}`)
}

// ─── Positions ──────────────────────────────────────────────────────────────

/** @param {{ status?: 'open'|'closed' }} [filter] */
async function listPositions(userId, filter = {}) {
    const db = await getDb()
    const q  = { userId }
    if (filter.status) q.status = filter.status
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

/** @param {{ status?: 'working'|'filled'|'cancelled' }} [filter] */
async function listOrders(userId, filter = {}) {
    const db = await getDb()
    const q  = { userId }
    if (filter.status) q.status = filter.status
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

/** Distinct userIds that currently hold an open position (snapshot targets). */
async function listActiveUserIds() {
    const db = await getDb()
    return db.collection(POSITIONS).distinct('userId', { status: 'open' })
}

/** Append one equity-curve point. @param {{userId,ts,equity,cashBalance,realizedPnl,unrealized,openPositions}} point */
async function insertEquitySnapshot(point) {
    const db = await getDb()
    await db.collection(EQUITY).insertOne({ ...point })
}

/** Equity-curve points for a user, oldest first. @param {{ fromMs?: number, limit?: number }} [opts] */
async function listEquityCurve(userId, { fromMs, limit = 5000 } = {}) {
    const db = await getDb()
    const q  = { userId }
    if (fromMs != null) q.ts = { $gte: fromMs }
    return db.collection(EQUITY)
        .find(q, { projection: { _id: 0 } })
        .sort({ ts: 1 })
        .limit(limit)
        .toArray()
}
