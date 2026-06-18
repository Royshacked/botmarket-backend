import { brokerConnectionService } from '../brokerConnection.service.js'
import { logger }                  from '../../../services/logger.service.js'

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
 * @property {string}  [accountId]  trading account this position lives on (set when an
 *                                  adapter reports positions across multiple accounts);
 *                                  pass it back to closePosition() to close on the right one
 * @property {string|null} [accountNo]  human account number / login for that account
 * @property {string|null} [currency]   that account's deposit currency (for P&L display)
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
 * @property {boolean} cancelOrder       can cancel a working (unfilled) order
 * @property {boolean} listOrders        can list working (pending) orders
 * @property {boolean} amendOrder        can change a working order's price
 * @property {boolean} ohlcv             can serve candles via getCandles()
 *
 * @typedef {Object} BrokerOrder
 * @property {string}                   symbol
 * @property {'long'|'short'}           direction
 * @property {number}                   quantity   trade size in LOTS / contracts; the
 *                                                 adapter converts to the broker's native
 *                                                 units (e.g. cTrader volume = lots × lotSize)
 * @property {'market'|'limit'|'stop'}  type
 * @property {number} [limitPrice]      required for limit orders
 * @property {number} [stopPrice]       required for stop orders
 * @property {number} [stopLoss]        absolute protective stop price (native SL)
 * @property {number} [takeProfit]      absolute protective take-profit price (native TP)
 * @property {number} [referencePrice]  expected entry price; required to attach native SL/TP
 *                                      to a market order (brokers that take a relative SL/TP
 *                                      distance derive it from here). Ignored for limit/stop
 *                                      orders, where the limit/stop price is the reference.
 * @property {number} [referenceQuote]  the CANONICAL (app/Massive-feed) live price of the
 *                                      instrument at order time. Present only when the broker
 *                                      lists the instrument under an aliased symbol whose price
 *                                      basis differs (e.g. NQ future vs cTrader's US100 cash):
 *                                      the adapter shifts absolute prices (limit/stop entry) onto
 *                                      the broker's book by offset = brokerSpotMid − referenceQuote.
 * @property {string} [clientOrderId]   caller-supplied id for idempotency / correlation
 * @property {string} [positionId]      mark this order a CLOSING order for that position:
 *                                      it must only reduce/close the position, never open an
 *                                      opposite one. Required on hedging brokers (cTrader/MT5),
 *                                      where a plain opposite order would open a new position;
 *                                      netting brokers may ignore it (an opposite order nets the
 *                                      position anyway). Used for every exit order (TP/stop
 *                                      levels, monitor closes).
 *
 * @typedef {Object} BrokerProtection
 * @property {number} [stopLoss]    absolute stop-loss price   (omit to leave unchanged)
 * @property {number} [takeProfit]  absolute take-profit price (omit to leave unchanged)
 * @property {number} [referenceQuote]  canonical live price at amend time; see BrokerOrder —
 *                                      the adapter shifts absolute SL/TP onto the broker's book.
 *
 * Normalised execution push event — the shape every broker translates its native
 * fills/updates into, so the unified backend→frontend channel is broker-agnostic.
 * @typedef {Object} BrokerExecution
 * `position.reduced` is a PARTIAL close (the position is still open) — one slice of
 * a multi-level exit; the reconciler records it and re-syncs the remaining exit
 * orders, but does NOT close the idea. `position.closed` is a full close.
 * @property {'order.accepted'|'order.filled'|'order.cancelled'|'order.rejected'|'position.opened'|'position.closed'|'position.reduced'|'position.updated'} type
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
     * Broker type id used for DB lookups (e.g. 'ctrader'). Subclasses MUST set this
     * for the shared token helpers below to work.
     * @type {string}
     */
    brokerType = ''

    /**
     * Human-facing broker name used in error messages (e.g. 'cTrader').
     * Falls back to brokerType when a subclass doesn't override it.
     * @type {string}
     */
    brokerLabel = ''

    /**
     * Provider module (the broker's REST/OAuth client). Subclasses MUST set this
     * so the shared token helpers can call `provider.refreshTokens(conn)`.
     * @type {{ refreshTokens: (conn: object) => Promise<object> }}
     */
    provider = null

    /**
     * Return valid tokens for this user, refreshing if within 60s of expiry.
     * Shared across adapters — relies on `this.brokerType` and `this.provider`.
     * @param {string} userId
     * @returns {Promise<object>} a connection/tokens object
     */
    async _freshTokens(userId) {
        const label = this.brokerLabel || this.brokerType
        const conn  = await brokerConnectionService.getConnection(userId, this.brokerType)
        if (!conn) {
            throw Object.assign(new Error(`${label} not connected`), { status: 401 })
        }

        const bufferMs = 60_000
        if (Date.now() + bufferMs >= conn.expiresAt) {
            logger.info(`[${this.brokerType}.adapter]`, `Refreshing tokens for user ${userId}`)
            try {
                const fresh = await this.provider.refreshTokens(conn)
                await brokerConnectionService.updateTokens(userId, this.brokerType, fresh)
                return fresh
            } catch (err) {
                logger.error(`[${this.brokerType}.adapter]`, `Token refresh failed for user ${userId}:`, err.message)
                throw Object.assign(new Error(`${label} session expired — please reconnect`), { status: 401 })
            }
        }
        return conn
    }

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
            cancelOrder:      false,
            listOrders:       false,
            amendOrder:       false,
            ohlcv:            false,
        }
    }

    /**
     * Cancel a working (not-yet-filled) order, e.g. a resting stop-market entry.
     * Requires `capabilities().cancelOrder`.
     * @param {string} userId
     * @param {string} accountId
     * @param {string} orderId
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async cancelOrder(userId, accountId, orderId) {
        throw new Error(`${this.constructor.name}: cancelOrder() not implemented`)
    }

    /**
     * List the account's working (pending) orders. Requires `capabilities().listOrders`.
     * @param {string} userId
     * @param {string} accountId
     * @returns {Promise<Array<{ orderId, symbol, side, type, price, quantity, positionId, accountId }>>}
     */
    // eslint-disable-next-line no-unused-vars
    async listOrders(userId, accountId) {
        throw new Error(`${this.constructor.name}: listOrders() not implemented`)
    }

    /**
     * Change a working order's price (keeps its id). Requires `capabilities().amendOrder`.
     * @param {string} userId
     * @param {string} accountId
     * @param {string} orderId
     * @param {{ limitPrice?: number, stopPrice?: number }} fields
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async amendOrder(userId, accountId, orderId, fields) {
        throw new Error(`${this.constructor.name}: amendOrder() not implemented`)
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
