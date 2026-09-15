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
 * @property {boolean} selfExecuted      the ACCOUNT HOLDER is the execution engine: the app
 *                                       monitors, decides and asks, and the user places and closes
 *                                       at their own institution. A consumer that sees this true
 *                                       must post its card and record the intent instead of
 *                                       calling ANY trading method here — every one of them throws.
 *                                       ORTHOGONAL to `trading:false`, which it is easy to mistake
 *                                       it for: IBKR is also `trading:false` today, but it is not
 *                                       self-executed — it is simply not wired yet, and the right
 *                                       answer there is to wait, not to ask the user to trade by
 *                                       hand. The two say different things and must stay separate.
 *
 * @typedef {Object} BrokerOrder
 * @property {string}                   symbol
 * @property {'long'|'short'}           direction
 * @property {number}                   quantity   trade size in LOTS / contracts; the
 *                                                 adapter converts to the broker's native
 *                                                 units (e.g. cTrader volume = lots × lotSize)
 * @property {'market'|'limit'|'stop'}  type
 * @property {number} [limitPrice]      required for limit orders. Already in the BROKER's price space:
 *                                      the caller shifts an authored level by the entity's fork-measured
 *                                      basisOffset (brokerPrice.applyOffset) — adapters round, never shift.
 * @property {number} [stopPrice]       required for stop orders (same price-space rule)
 * @property {number} [stopLoss]        absolute protective stop price (native SL)
 * @property {number} [takeProfit]      absolute protective take-profit price (native TP)
 * @property {number} [referencePrice]  expected entry price; required to attach native SL/TP
 *                                      to a market order (brokers that take a relative SL/TP
 *                                      distance derive it from here). Ignored for limit/stop
 *                                      orders, where the limit/stop price is the reference.
 * @property {string} [clientOrderId]   caller-supplied id for idempotency / correlation
 * @property {string} [positionId]      mark this order a CLOSING order for that position:
 *                                      it must only reduce/close the position, never open an
 *                                      opposite one. Required on hedging brokers (cTrader/MT5),
 *                                      where a plain opposite order would open a new position;
 *                                      netting brokers may ignore it (an opposite order nets the
 *                                      position anyway). Used for every exit order (TP/stop
 *                                      levels, monitor closes).
 * @property {string} [increasePositionId]  the mirror of `positionId`: a SAME-direction order that
 *                                      grows that position rather than opening a new one. Its own
 *                                      field because `positionId` on a market order already means
 *                                      "reduce", so overloading it would turn every scale-in into a
 *                                      trim. Adapters answer it in whichever way their venue really
 *                                      behaves, and the RETURN VALUE says which happened: a netting
 *                                      venue (paper, manual, IBKR) merges and echoes the SAME
 *                                      positionId; a hedging one (cTrader/MT5) cannot, so it ignores
 *                                      the field and returns a NEW positionId for the sibling
 *                                      position. Callers must branch on the id they get back, not on
 *                                      the broker's name — that is what keeps a holding's legs
 *                                      correctly tracked on either kind of venue.
 *
 * @typedef {Object} BrokerProtection
 * @property {number} [stopLoss]    absolute stop-loss price   (omit to leave unchanged)
 * @property {number} [takeProfit]  absolute take-profit price (omit to leave unchanged)
 *
 * Normalised execution push event — the shape every broker translates its native
 * fills/updates into, so the unified backend→frontend channel is broker-agnostic.
 *
 * `position.reduced` is a PARTIAL close (the position is still open) — one slice of
 * a multi-level exit; the reconciler records it and re-syncs the remaining exit
 * orders, but does NOT close the idea. `position.closed` is a full close.
 * @typedef {Object} BrokerExecution
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
 * @property {number} [commission]  per-fill commission COST (absolute, deposit currency);
 *                                  the trade ledger accumulates entry + exit into a round-trip total
 * @property {number} [spread]      per-fill spread COST (absolute) — for venues that bake the
 *                                  spread into the fill price (paper); omit where not modeled
 * @property {'stop'|'tp'|'manual'|null} [reason]  why a position closed
 * @property {number}            at  unix ms
 */

/**
 * `err.code` on a placeOrder rejection that came from OUR price feed, not from the venue.
 *
 * Part of the contract because it is the one refusal a venue can't express: a broker with a book
 * fills at its own price and never needs ours, so only a simulated venue can fail this way. It
 * lives here rather than in paper.adapter so the order layer can recognise it without importing
 * an adapter — and so a future venue that prices off our feed (manual mode) says it the same way.
 * Any other rejection is the venue's own and stays an opaque broker error.
 */
export const NO_PRICE = 'NO_PRICE'

/**
 * HTTP status a broker read/trade answers with when the BROKER session is missing or cannot be
 * refreshed: 424 Failed Dependency. Deliberately not 401 — that is the app's own login code, and
 * the client answers every 401 by clearing the session and leaving the page. See _freshTokens.
 */
export const BROKER_DISCONNECTED = 424

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
     *
     * A missing or unrefreshable BROKER session throws `status: BROKER_DISCONNECTED` (424), NOT
     * 401. 401 is the APP's own auth code, and the client treats any 401 as "your login expired"
     * — clears the session and sends the user to the front page. An expired cTrader token on the
     * positions poll used to do exactly that (masked, until recently, by getPositions swallowing
     * the throw). The broker being unreachable is a failed dependency, which is what 424 says.
     * @param {string} userId
     * @returns {Promise<object>} a connection/tokens object
     */
    async _freshTokens(userId) {
        const label = this.brokerLabel || this.brokerType
        const conn  = await brokerConnectionService.getConnection(userId, this.brokerType)
        if (!conn) {
            throw Object.assign(new Error(`${label} not connected`), { status: BROKER_DISCONNECTED })
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
                throw Object.assign(new Error(`${label} session expired — please reconnect`), { status: BROKER_DISCONNECTED })
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
     * Return normalised account summary. `accountId` is optional: adapters that manage
     * several accounts under one user (e.g. paper) use it to pick the account; adapters
     * that resolve their own selected account (live brokers) may ignore it.
     * @param {string} userId
     * @param {string} [accountId]
     * @returns {Promise<BrokerAccount>}
     */
    // eslint-disable-next-line no-unused-vars
    async getAccount(userId, accountId) {
        throw new Error(`${this.constructor.name}: getAccount() not implemented`)
    }

    /**
     * Return list of open positions. `accountId` is optional (see getAccount): when
     * given, adapters that manage several accounts scope to it; otherwise all are returned.
     * @param {string} userId
     * @param {string} [accountId]
     * @returns {Promise<BrokerPosition[]>}
     */
    // eslint-disable-next-line no-unused-vars
    async getPositions(userId, accountId) {
        throw new Error(`${this.constructor.name}: getPositions() not implemented`)
    }

    /**
     * Return OHLCV bars. Optional — return null if this broker doesn't support it, AND for any
     * timeframe it has no bar width for: null means "use the app feed", and the monitor relies on
     * that fallback. Never substitute a coarser width — an intraday idea evaluated on daily bars
     * is a wrong answer, not a degraded one. When `capabilities().ohlcv` is true the monitor
     * prefers this over the app feed (Massive/Yahoo).
     * @param {string} symbol     the BROKER symbol (brokerSymbol), e.g. 'US100.cash'
     * @param {string} timeframe  the app timeframe the monitor speaks — '1min' | '5min' | '1hr' |
     *                            '4hr' | 'day' | 'week' | 'month' (legacy 'minutes' / 'daily'
     *                            still parse). Resolve it with services/timeframe.parseTimeframe,
     *                            as cTrader and IBKR do, so every adapter reads the one vocabulary.
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
            selfExecuted:     false,
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
     * Change a working order's price. Requires `capabilities().amendOrder`.
     * Returns the working order's id AFTER the amend: brokers that amend in place
     * echo the same id; brokers that amend by cancel-then-place (e.g. cTrader) return
     * a NEW id. Callers MUST retrack the returned id — the original may no longer exist.
     * @param {string} userId
     * @param {string} accountId
     * @param {string} orderId
     * @param {{ limitPrice?: number, stopPrice?: number }} fields
     * @returns {Promise<{ orderId?: string }>}
     */
    // eslint-disable-next-line no-unused-vars
    async amendOrder(userId, accountId, orderId, fields) {
        throw new Error(`${this.constructor.name}: amendOrder() not implemented`)
    }

    /**
     * Authoritative single-position lookup used by the broker-authoritative reconciler.
     * Three-state contract:
     *   - a position object → the position is still open at the broker
     *   - `null`            → confirmed gone (closed/liquidated)
     *   - `undefined`       → this broker can't check (caller treats as "unknown" and
     *                         must NOT close the idea on it)
     * Adapters that implement it MUST THROW on a transport/session error, so the caller
     * can distinguish "gone" (null) from "unreachable" (throw) and never close an idea on
     * a transient failure. The default reports unsupported.
     * @param {string} userId
     * @param {string} accountId
     * @param {string} positionId
     * @returns {Promise<BrokerPosition|object|null|undefined>}
     */
    // eslint-disable-next-line no-unused-vars
    async findOpenPosition(userId, accountId, positionId) {
        return undefined   // default: unsupported → caller treats as "unknown", never closes
    }

    /**
     * Resolve an app/canonical symbol to this broker's own tradable symbol, confirming
     * the instrument exists on the account ("getTicker"). Used at idea-build time so the
     * persisted brokerSymbol is the broker's real name (e.g. 'US100.cash') rather than a
     * static-map guess. Three-state `found`:
     *   - `true`  → resolved; `symbol` is the broker's tradable name.
     *   - `false` → the broker genuinely does not list this instrument.
     *   - `null`  → this broker can't resolve symbols (default) → caller falls back to the
     *              static alias map. Adapters SHOULD throw on a transport/session error so
     *              the caller can tell "not listed" (false) from "unreachable" (throw) and
     *              not treat a transient failure as a bad symbol.
     * @param {string} userId
     * @param {string} accountId
     * @param {string} symbol   app/canonical asset, e.g. 'NQ'
     * @returns {Promise<{ symbol: string, found: boolean|null }>}
     */
    // eslint-disable-next-line no-unused-vars
    async resolveSymbol(userId, accountId, symbol) {
        return { symbol, found: null }   // default: unsupported → caller uses the static map
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
