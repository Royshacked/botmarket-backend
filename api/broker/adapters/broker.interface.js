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
     * Place a market or limit order on a specific trading account.
     * @param {string} userId
     * @param {string} accountId   the trading account to place the order on
     * @param {{ symbol: string, direction: 'long'|'short', quantity: number, type: 'market'|'limit', limitPrice?: number }} order
     * @returns {Promise<{ orderId: string }>}
     */
    // eslint-disable-next-line no-unused-vars
    async placeOrder(userId, accountId, order) {
        throw new Error(`${this.constructor.name}: placeOrder() not implemented`)
    }
}
