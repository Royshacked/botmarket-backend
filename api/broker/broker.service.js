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

// ─── Disconnect ───────────────────────────────────────────────────────────────

async function disconnect(brokerType, userId) {
    // Validate broker type first
    getBrokerAdapter(brokerType)
    await brokerConnectionService.deleteConnection(userId, brokerType)
    logger.info(LOG, `${brokerType} disconnected for user ${userId}`)
}
