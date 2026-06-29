/**
 * Broker Connection Service
 *
 * Persists per-user broker OAuth tokens in MongoDB.
 * Each document represents one user ↔ broker connection.
 *
 * Collection: brokerConnections
 * Shape: {
 *   userId:       string,
 *   brokerType:   'ctrader' | 'ibkr' | …,
 *   accessToken:  string,
 *   refreshToken: string,
 *   expiresAt:    number,   unix ms when access token expires
 *   accountId:    string | null,   cached after first API call
 *   connectedAt:  number,   unix ms
 * }
 */

import { getDb } from '../../providers/mongodb.provider.js'

const COLLECTION = 'brokerConnections'

export const brokerConnectionService = {
    getConnection,
    saveConnection,
    saveGatewayConnection,
    updateTokens,
    getAccountId,
    setAccountId,
    listConnections,
    deleteConnection,
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get the stored connection for a user + broker, or null if not found.
 * @param {string} userId
 * @param {string} brokerType
 * @returns {Promise<object|null>}
 */
async function getConnection(userId, brokerType) {
    const db = await getDb()
    return db.collection(COLLECTION).findOne(
        { userId, brokerType },
        { projection: { _id: 0 } }
    )
}

/**
 * Return a map of { brokerType → connected } for all supported brokers.
 * Only includes broker types that have a saved refreshToken.
 * @param {string} userId
 * @returns {Promise<Record<string, boolean>>}
 */
async function listConnections(userId) {
    const db   = await getDb()
    const docs = await db.collection(COLLECTION)
        .find({ userId }, { projection: { brokerType: 1, refreshToken: 1, gateway: 1, _id: 0 } })
        .toArray()

    const result = {}
    for (const doc of docs) {
        // OAuth brokers connect via a refreshToken; socket/gateway brokers (IBKR via
        // IB Gateway) have no tokens — a stored gateway doc IS the connection.
        result[doc.brokerType] = !!doc.refreshToken || !!doc.gateway
    }
    return result
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Upsert a broker connection with fresh tokens.
 * @param {string} userId
 * @param {string} brokerType
 * @param {{ accessToken: string, refreshToken: string, expiresIn: number }} tokens
 */
async function saveConnection(userId, brokerType, tokens) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne(
        { userId, brokerType },
        {
            $set: {
                userId,
                brokerType,
                accessToken:  tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt:    Date.now() + (tokens.expiresIn ?? 3600) * 1000,
                connectedAt:  Date.now(),
            },
        },
        { upsert: true }
    )
}

/**
 * Upsert a socket/gateway connection (IBKR via IB Gateway). Unlike OAuth brokers
 * there are no tokens — the connection is just the gateway coordinates the adapter
 * dials. Paper vs live is encoded in the port.
 * @param {string} userId
 * @param {string} brokerType
 * @param {{ host: string, port: number, clientId: number }} coords
 */
async function saveGatewayConnection(userId, brokerType, { host, port, clientId }) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne(
        { userId, brokerType },
        {
            $set: {
                userId,
                brokerType,
                gateway:     true,
                host,
                port:        Number(port),
                clientId:    Number(clientId),
                connectedAt: Date.now(),
            },
        },
        { upsert: true }
    )
}

/**
 * Update only the token fields (called after a token refresh).
 * Preserves accountId and connectedAt.
 * @param {string} userId
 * @param {string} brokerType
 * @param {{ accessToken: string, refreshToken: string, expiresIn: number }} tokens
 */
async function updateTokens(userId, brokerType, tokens) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne(
        { userId, brokerType },
        {
            $set: {
                accessToken:  tokens.accessToken,
                refreshToken: tokens.refreshToken ?? undefined,
                expiresAt:    Date.now() + (tokens.expiresIn ?? 3600) * 1000,
            },
        }
    )
}

// ─── Account ID cache ─────────────────────────────────────────────────────────

/**
 * Return the cached primary account ID for this connection, or null.
 * @param {string} userId
 * @param {string} brokerType
 * @returns {Promise<string|null>}
 */
async function getAccountId(userId, brokerType) {
    const conn = await getConnection(userId, brokerType)
    return conn?.accountId ?? null
}

/**
 * Persist the primary account ID so future calls skip the accounts-list lookup.
 * @param {string} userId
 * @param {string} brokerType
 * @param {string} accountId
 */
async function setAccountId(userId, brokerType, accountId) {
    const db = await getDb()
    await db.collection(COLLECTION).updateOne(
        { userId, brokerType },
        { $set: { accountId } }
    )
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Remove a broker connection (disconnect).
 * @param {string} userId
 * @param {string} brokerType
 */
async function deleteConnection(userId, brokerType) {
    const db = await getDb()
    await db.collection(COLLECTION).deleteOne({ userId, brokerType })
}
