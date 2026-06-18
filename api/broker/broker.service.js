/**
 * Broker Service
 *
 * Orchestration layer between routes and adapters.
 * Routes call this; this calls the right adapter via the factory.
 *
 * No broker-specific logic here — all of that lives in the adapters.
 */

import jwt                         from 'jsonwebtoken'
import { getBrokerAdapter,
         SUPPORTED_BROKERS }       from './broker.factory.js'
import { brokerConnectionService } from './brokerConnection.service.js'
import { logger }                  from '../../services/logger.service.js'

const LOG = '[broker.service]'

export const brokerService = {
    getConnectUrl,
    handleCallback,
    listConnections,
    isConnected,
    getAccount,
    getPositions,
    getCandles,
    getTradingAccounts,
    setSelectedAccount,
    capabilities,
    placeOrder,
    cancelOrder,
    listOrders,
    amendOrder,
    setProtection,
    closePosition,
    startExecutionFeed,
    disconnect,
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Build the OAuth authorization URL for a broker.
 * Encodes userId + brokerType in a short-lived JWT state param so the callback
 * route knows which user to save tokens for — no session or cookie needed.
 *
 * @param {string} brokerType
 * @param {string} userId
 * @returns {string} URL to redirect the browser to
 */
function getConnectUrl(brokerType, userId) {
    const adapter = getBrokerAdapter(brokerType)  // throws 400 for unknown type
    const state   = jwt.sign(
        { userId, brokerType },
        process.env.JWT_SECRET,
        { expiresIn: '10m' }
    )
    logger.info(LOG, `OAuth start: ${brokerType} for user ${userId}`)
    return adapter.getAuthUrl(state)
}

/**
 * Handle the OAuth callback: verify state, exchange code, persist tokens.
 * @param {string} brokerType
 * @param {string} code
 * @param {string} userId
 */
async function handleCallback(brokerType, code, userId) {
    const adapter = getBrokerAdapter(brokerType)
    await adapter.handleCallback(code, userId)
    logger.info(LOG, `${brokerType} connected for user ${userId}`)
}

// ─── Connection status ────────────────────────────────────────────────────────

/**
 * Return a map of { brokerType → isConnected } for all supported brokers.
 * @param {string} userId
 * @returns {Promise<Record<string, boolean>>}  e.g. { ctrader: true, ibkr: false }
 */
async function listConnections(userId) {
    // Base: all supported types default to false
    const result = Object.fromEntries(SUPPORTED_BROKERS.map(t => [t, false]))

    // Merge with what's actually in the DB
    const saved = await brokerConnectionService.listConnections(userId)
    return { ...result, ...saved }
}

/**
 * @param {string} brokerType
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isConnected(brokerType, userId) {
    return getBrokerAdapter(brokerType).isConnected(userId)
}

// ─── Account data ─────────────────────────────────────────────────────────────

/** @returns {Promise<import('./adapters/broker.interface.js').BrokerAccount>} */
async function getAccount(brokerType, userId) {
    return getBrokerAdapter(brokerType).getAccount(userId)
}

/** @returns {Promise<import('./adapters/broker.interface.js').BrokerPosition[]>} */
async function getPositions(brokerType, userId) {
    return getBrokerAdapter(brokerType).getPositions(userId)
}

// ─── Market data ──────────────────────────────────────────────────────────────

/**
 * Get OHLCV bars from the broker's API.
 * Returns null if the broker doesn't support it (caller should fall back to Massive).
 * @param {string} brokerType
 * @param {string} symbol
 * @param {string} timeframe
 * @param {number} count
 * @param {string} userId
 * @returns {Promise<import('./adapters/broker.interface.js').OHLCVBar[]|null>}
 */
async function getCandles(brokerType, symbol, timeframe, count, userId) {
    return getBrokerAdapter(brokerType).getCandles(symbol, timeframe, count, userId)
}

// ─── Trading accounts ─────────────────────────────────────────────────────────

/**
 * Return all trading accounts for the user + which one is currently selected.
 * @param {string} brokerType
 * @param {string} userId
 * @returns {Promise<{ accounts: TradingAccount[], selectedAccountId: string|null }>}
 */
async function getTradingAccounts(brokerType, userId) {
    const [accounts, selectedAccountId] = await Promise.all([
        getBrokerAdapter(brokerType).getTradingAccounts(userId),
        brokerConnectionService.getAccountId(userId, brokerType),
    ])
    return { accounts, selectedAccountId }
}

/**
 * Persist the user's chosen trading account for a broker.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 */
async function setSelectedAccount(brokerType, userId, accountId) {
    await brokerConnectionService.setAccountId(userId, brokerType, accountId)
    logger.info(LOG, `${brokerType} selected account → ${accountId} for user ${userId}`)
}

// ─── Trading ──────────────────────────────────────────────────────────────────

/**
 * Report what a broker can do. Static per broker — no userId needed.
 * Consumers branch on these flags, never on the broker name.
 * @param {string} brokerType
 * @returns {import('./adapters/broker.interface.js').BrokerCapabilities}
 */
function capabilities(brokerType) {
    return getBrokerAdapter(brokerType).capabilities()
}

/**
 * Place an order on a specific trading account.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @param {import('./adapters/broker.interface.js').BrokerOrder} order
 * @returns {Promise<{ orderId: string, positionId?: string }>}
 */
async function placeOrder(brokerType, userId, accountId, order) {
    return getBrokerAdapter(brokerType).placeOrder(userId, accountId, order)
}

/**
 * Cancel a working (not-yet-filled) order — e.g. a resting stop-market entry.
 * Requires `capabilities().cancelOrder`.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @param {string} orderId
 * @returns {Promise<void>}
 */
async function cancelOrder(brokerType, userId, accountId, orderId) {
    return getBrokerAdapter(brokerType).cancelOrder(userId, accountId, orderId)
}

/**
 * List the account's working (pending) LIMIT/STOP orders. Requires
 * `capabilities().listOrders`.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @returns {Promise<object[]>}
 */
async function listOrders(brokerType, userId, accountId) {
    return getBrokerAdapter(brokerType).listOrders(userId, accountId)
}

/**
 * Change a working order's price. Requires `capabilities().amendOrder`.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @param {string} orderId
 * @param {{ limitPrice?: number, stopPrice?: number }} fields
 * @returns {Promise<void>}
 */
async function amendOrder(brokerType, userId, accountId, orderId, fields) {
    return getBrokerAdapter(brokerType).amendOrder(userId, accountId, orderId, fields)
}

/**
 * Set / amend protective SL/TP on an open position.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @param {string} positionId
 * @param {import('./adapters/broker.interface.js').BrokerProtection} protection
 * @returns {Promise<void>}
 */
async function setProtection(brokerType, userId, accountId, positionId, protection) {
    return getBrokerAdapter(brokerType).setProtection(userId, accountId, positionId, protection)
}

/**
 * Close (or partially close) an open position.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @param {string} positionId
 * @param {{ quantity?: number }} [opts]
 * @returns {Promise<void>}
 */
async function closePosition(brokerType, userId, accountId, positionId, opts) {
    return getBrokerAdapter(brokerType).closePosition(userId, accountId, positionId, opts)
}

/**
 * Start streaming an account's execution events onto the executionBus (idempotent).
 * Returns false for brokers that don't push executions, so the reconciler can skip.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
async function startExecutionFeed(brokerType, userId, accountId) {
    return getBrokerAdapter(brokerType).startExecutionFeed(userId, accountId)
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

async function disconnect(brokerType, userId) {
    // Validate broker type first
    getBrokerAdapter(brokerType)
    await brokerConnectionService.deleteConnection(userId, brokerType)
    logger.info(LOG, `${brokerType} disconnected for user ${userId}`)
}
