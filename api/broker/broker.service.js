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
import { paperBrokerService }      from './paperBroker.service.js'
import { logger }                  from '../../services/logger.service.js'

const LOG = '[broker.service]'

export const brokerService = {
    getConnectUrl,
    handleCallback,
    listConnections,
    isConnected,
    getAccount,
    getPositions,
    findOpenPosition,
    getCandles,
    resolveSymbol,
    getSpot,
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
    const merged = { ...result, ...saved }

    // Paper has no brokerConnections doc — it's "connected" when paper mode is enabled,
    // so resolveUserAccounts / the order-plan builder can resolve the paper account.
    try { merged.paper = await paperBrokerService.isEnabled(userId) } catch { /* non-fatal */ }
    // Manual has no toggle — it's "connected" whenever the user owns ≥1 manual account,
    // so an idea bound to a manual account resolves and its positions surface.
    try { merged.manual = (await paperBrokerService.listAccounts(userId, { mode: 'manual' })).length > 0 } catch { /* non-fatal */ }
    return merged
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

/**
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} [accountId]  optional: pick a specific account (paper manages several)
 * @returns {Promise<import('./adapters/broker.interface.js').BrokerAccount>}
 */
async function getAccount(brokerType, userId, accountId) {
    return getBrokerAdapter(brokerType).getAccount(userId, accountId)
}

/**
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} [accountId]  optional: scope to one account (paper manages several)
 * @returns {Promise<import('./adapters/broker.interface.js').BrokerPosition[]>}
 */
async function getPositions(brokerType, userId, accountId) {
    return getBrokerAdapter(brokerType).getPositions(userId, accountId)
}

/**
 * Authoritative single-position lookup: the open position, `null` when it's gone, or
 * `undefined` when the broker doesn't support the check (caller treats as "unknown" —
 * never close on it). Adapters that implement it THROW on a transport error so the
 * caller can distinguish "gone" from "unreachable".
 * @returns {Promise<object|null|undefined>}
 */
async function findOpenPosition(brokerType, userId, accountId, positionId) {
    const adapter = getBrokerAdapter(brokerType)
    if (typeof adapter.findOpenPosition !== 'function') return undefined
    return adapter.findOpenPosition(userId, accountId, positionId)
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

/**
 * Resolve an app symbol to the broker's tradable symbol ("getTicker"), confirming the
 * instrument exists on the account. See BrokerAdapter.resolveSymbol for the three-state
 * `found` contract (true/false/null). Throws on transport/session errors.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @param {string} symbol
 * @returns {Promise<{ symbol: string, found: boolean|null }>}
 */
async function resolveSymbol(brokerType, userId, accountId, symbol) {
    return getBrokerAdapter(brokerType).resolveSymbol(userId, accountId, symbol)
}

/**
 * Snapshot the broker's live spot quote for a symbol (bid/ask/mid). Used to measure the
 * basis offset for aliased instruments. Returns null when the broker has no spot feed.
 * @param {string} brokerType
 * @param {string} userId
 * @param {string} accountId
 * @param {string} symbol   the broker's tradable symbol
 * @returns {Promise<{ bid:number|null, ask:number|null, mid:number, at:number }|null>}
 */
async function getSpot(brokerType, userId, accountId, symbol) {
    return getBrokerAdapter(brokerType).getSpot(userId, accountId, symbol)
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
