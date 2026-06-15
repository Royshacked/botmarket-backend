/**
 * Broker Adapter Interface
 *
 * Every broker adapter MUST extend BrokerAdapter and implement all methods.
 * This file is the source of truth for the contract every broker must fulfil.
 *
 * @typedef {Object} BrokerTokens
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresIn      seconds until access token expires
 *
 * @typedef {Object} BrokerAccount
 * @property {string}      id
 * @property {string}      login
 * @property {string}      broker
 * @property {string}      currency
 * @property {number|null} balance
 * @property {number|null} equity
 * @property {number|null} margin
 * @property {number|null} freeMargin
 * @property {number|null} marginLevel
 * @property {number|null} leverage
 *
 * @typedef {Object} BrokerPosition
 * @property {string}         id
 * @property {string}         symbol
 * @property {'long'|'short'} direction
 * @property {number|null}    volume
 * @property {number|null}    entryPrice
 * @property {number|null}    currentPrice
 * @property {number|null}    pnl
 * @property {number|null}    pnlPips
 * @property {number|null}    swap
 * @property {number|null}    openedAt    unix ms
 *
 * @typedef {Object} OHLCVBar
 * @property {number} t   timestamp ms
 * @property {number} o   open
 * @property {number} h   high
 * @property {number} l   low
 * @property {number} c   close
 * @property {number} v   volume
 *
 * @typedef {Object} TradingAccount
 * @property {string}      id
 * @property {string|null} login
 * @property {string|null} currency
 * @property {number|null} balance
 * @property {string|null} broker
 * @property {boolean}     isLive
 *
 * @typedef {Object} BrokerCapabilities
 * @property {boolean} trading           can place orders at all
 * @property {boolean} nativeProtection  can attach SL/TP to an order/position natively
 * @property {boolean} modifyProtection  can amend SL/TP on an open position
 * @property {boolean} closePosition     can close a position programmatically
 * @property {boolean} ohlcv             can serve candles via getCandles()
 *
 * @typedef {Object} BrokerOrder
 * @property {string}                   symbol
 * @property {'long'|'short'}           direction
 * @property {number}                   quantity
 * @property {'market'|'limit'|'stop'}  type
 * @property {number} [limitPrice]      required for limit orders
 * @property {number} [stopPrice]       required for stop orders
 * @property {number} [stopLoss]        absolute protective stop price (native SL)
 * @property {number} [takeProfit]      absolute protective take-profit price (native TP)
 * @property {number} [referencePrice]  expected entry price; required to attach native SL/TP
 *                                      to a market order (brokers that take a relative SL/TP
 *                                      distance derive it from here). Ignored for limit/stop
 *                                      orders, where the limit/stop price is the reference.
 * @property {string} [clientOrderId]   caller-supplied id for idempotency / correlation
 *
 * @typedef {Object} BrokerProtection
 * @property {number} [stopLoss]    absolute stop-loss price   (omit to leave unchanged)
 * @property {number} [takeProfit]  absolute take-profit price (omit to leave unchanged)
 *
 * Normalised execution push event — the shape every broker translates its native
 * fills/updates into, so the unified backend→frontend channel is broker-agnostic.
 * @typedef {Object} BrokerExecution
 * @property {'order.accepted'|'order.filled'|'order.cancelled'|'order.rejected'|'position.opened'|'position.closed'|'position.updated'} type
 * @property {string}            broker
 * @property {string}            accountId
 * @property {string} [orderId]
 * @property {string} [positionId]
 * @property {string} [symbol]
 * @property {'long'|'short'} [direction]
 * @property {number} [quantity]
 * @property {number} [price]       fill / close price
 * @property {number} [stopLoss]
 * @property {number} [takeProfit]
 * @property {number} [pnl]         realised pnl on close
 * @property {'stop'|'tp'|'manual'|null} [reason]  why a position closed
 * @property {number}            at  unix ms
 */

export class BrokerAdapter {
    /**
     * Return the URL to redirect the user to for OAuth consent.
     * @param {string} state  JWT-signed context token (userId + brokerType)
     * @returns {string}
     */
    // eslint-disable-next-line no-unused-vars
    getAuthUrl(state) {
        throw new Error(`${this.constructor.name}: getAuthUrl() not implemented`)
    }

    /**
     * Exchange an OAuth code for tokens and persist them for the user.
     * @param {string} code
     * @param {string} userId
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async handleCallback(code, userId) {
        throw new Error(`${this.constructor.name}: handleCallback() not implemented`)
    }

    /**
     * Check whether this user has a valid (refreshable) connection.
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    // eslint-disable-next-line no-unused-vars
    async isConnected(userId) {
        throw new Error(`${this.constructor.name}: isConnected() not implemented`)
    }

    /**
     * Return normalised account summary.
     * @param {string} userId
     * @returns {Promise<BrokerAccount>}
     */
    // eslint-disable-next-line no-unused-vars
    async getAccount(userId) {
        throw new Error(`${this.constructor.name}: getAccount() not implemented`)
    }

    /**
     * Return list of open positions.
     * @param {string} userId
     * @returns {Promise<BrokerPosition[]>}
     */
    // eslint-disable-next-line no-unused-vars
    async getPositions(userId) {
        throw new Error(`${this.constructor.name}: getPositions() not implemented`)
    }

    /**
     * Return OHLCV bars. Optional — return null if this broker doesn't support it.
     * When implemented, the monitoring system will prefer this over Massive/Polygon.
     * @param {string} symbol
     * @param {'minutes'|'hours'|'daily'|'weekly'|'monthly'} timeframe
     * @param {number} count      number of bars to return
     * @param {string} userId
     * @returns {Promise<OHLCVBar[]|null>}
     */
    // eslint-disable-next-line no-unused-vars
    async getCandles(symbol, timeframe, count, userId) {
        return null   // default: unsupported, caller falls back to Massive
    }

    /**
     * Return all trading accounts for this user.
     * @param {string} userId
     * @returns {Promise<TradingAccount[]>}
     */
    // eslint-disable-next-line no-unused-vars
    async getTradingAccounts(userId) {
        throw new Error(`${this.constructor.name}: getTradingAccounts() not implemented`)
    }

    /**
     * Place an order (market/limit/stop), optionally with native SL/TP attached.
     * @param {string} userId
     * @param {string} accountId   the trading account to place the order on
     * @param {BrokerOrder} order
     * @returns {Promise<{ orderId: string, positionId?: string, accountId: string }>}
     *          accountId is the broker-CANONICAL account id (the one execution events
     *          carry), so callers persist it for reconciliation rather than the id
     *          they passed in.
     */
    // eslint-disable-next-line no-unused-vars
    async placeOrder(userId, accountId, order) {
        throw new Error(`${this.constructor.name}: placeOrder() not implemented`)
    }

    /**
     * Begin streaming this account's execution events onto the shared executionBus
     * as normalized BrokerExecution objects. Idempotent — calling twice for the same
     * account is a no-op. Brokers that don't push execution events leave the default,
     * which reports no feed so the reconciler simply skips them.
     * @param {string} userId
     * @param {string} accountId   broker-canonical account id
     * @returns {Promise<boolean>} true if a feed is active for this account
     */
    // eslint-disable-next-line no-unused-vars
    async startExecutionFeed(userId, accountId) {
        return false   // default: unsupported
    }

    /**
     * Describe what this broker can do. Consumers (order planner, frontend) branch on
     * these flags, never on the broker name. Override per adapter; the conservative
     * default reports nothing supported, so a new adapter degrades safely until wired.
     * @returns {BrokerCapabilities}
     */
    capabilities() {
        return {
            trading:          false,
            nativeProtection: false,
            modifyProtection: false,
            closePosition:    false,
            ohlcv:            false,
        }
    }

    /**
     * Set or amend protective stop-loss / take-profit on an open position.
     * Omitted fields are left unchanged. Requires `capabilities().modifyProtection`.
     * @param {string} userId
     * @param {string} accountId
     * @param {string} positionId
     * @param {BrokerProtection} protection
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async setProtection(userId, accountId, positionId, protection) {
        throw new Error(`${this.constructor.name}: setProtection() not implemented`)
    }

    /**
     * Close (or partially close) an open position. Requires `capabilities().closePosition`.
     * @param {string} userId
     * @param {string} accountId
     * @param {string} positionId
     * @param {{ quantity?: number }} [opts]   omit quantity to close in full
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async closePosition(userId, accountId, positionId, opts) {
        throw new Error(`${this.constructor.name}: closePosition() not implemented`)
    }
}
