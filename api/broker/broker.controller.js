/**
 * Broker request handlers.
 *
 * Split out of broker.routes.js, which carried twelve inline `async (req, res)` bodies and was the
 * last feature (with `trades`) not following the routes / controller / service split every other
 * one uses. Nothing here is new — the handlers are the same, and every one of them still delegates
 * to brokerService, which is the broker-agnostic entry point.
 *
 * ERROR SHAPE. Every data handler is wrapped in `_handle` (api/_shared/handle.util) so a throw is
 * logged with its route and formatted by the one global error handler in server.js.
 *
 * The two OAuth routes are deliberately NOT wrapped: they answer a browser NAVIGATION, so a failure
 * has to redirect back to the app with a reason in the query string. Handing those to the JSON
 * error handler would render a raw `{"error":…}` in the user's address bar.
 */

import jwt               from 'jsonwebtoken'
import { brokerService } from './broker.service.js'
import { ideaService }   from '../trade-ideas/tradeIdeas.service.js'
import { logger }        from '../../services/logger.service.js'
import { makeHandle }    from '../_shared/handle.util.js'
import { config } from '../../services/config.js'

const LOG          = '[broker:controller]'
const FRONTEND_URL = config.clientUrl
const _handle      = makeHandle(LOG)

/** Fall back to the broker's selected trading account when a caller omits accountId. */
async function _selectedAccountId(type, userId) {
    const { selectedAccountId } = await brokerService.getTradingAccounts(type, userId)
    return selectedAccountId
}

// ─── OAuth ────────────────────────────────────────────────────────────────────
// Start: redirect the browser to the broker's consent page. requireAuth reads the JWT cookie —
// which works because this is a browser navigation, so cookies are sent automatically.

export function connect(req, res) {
    try {
        const url = brokerService.getConnectUrl(req.params.type, req.user._id)
        logger.info(LOG, `OAuth start — type=${req.params.type} user=${req.user._id}`)
        res.redirect(url)
    } catch (err) {
        logger.error(LOG, 'getConnectUrl error:', err.message)
        res.redirect(`${FRONTEND_URL}/?broker=error&reason=unknown_type`)
    }
}

// Callback: the broker redirects here after consent. This route is UNAUTHENTICATED — the browser
// arrives from the broker's domain, so there is no session to read. User identity is recovered from
// the JWT-signed `state` param instead, which is why `state` is verified before anything else.
export async function callback(req, res) {
    const { code, state } = req.query
    if (!code || !state) {
        logger.warn(LOG, 'OAuth callback: missing code or state')
        return res.redirect(`${FRONTEND_URL}/?broker=error&reason=missing_params`)
    }

    let userId, brokerType
    try {
        const payload = jwt.verify(state, config.jwtSecret)
        userId     = payload.userId
        brokerType = payload.brokerType
    } catch {
        logger.warn(LOG, 'OAuth callback: invalid or expired state token')
        return res.redirect(`${FRONTEND_URL}/?broker=error&reason=invalid_state`)
    }

    try {
        await brokerService.handleCallback(brokerType, code, userId)
        logger.info(LOG, `OAuth success — type=${brokerType} user=${userId}`)
        res.redirect(`${FRONTEND_URL}/?broker=connected&type=${brokerType}`)
    } catch (err) {
        logger.error(LOG, `OAuth callback error (${brokerType}):`, err.message)
        res.redirect(`${FRONTEND_URL}/?broker=error&reason=callback_failed&type=${brokerType}`)
    }
}

// ─── Connections ──────────────────────────────────────────────────────────────

export const listConnections = _handle('listConnections', async (req, res) => {
    const connections = await brokerService.listConnections(req.user._id)
    res.json({ connections })
})

export const disconnect = _handle('disconnect', async (req, res) => {
    await brokerService.disconnect(req.params.type, req.user._id)
    res.json({ ok: true })
})

// ─── Trading accounts ─────────────────────────────────────────────────────────

export const listTradingAccounts = _handle('getTradingAccounts', async (req, res) => {
    res.json(await brokerService.getTradingAccounts(req.params.type, req.user._id))
})

export const setSelectedAccount = _handle('setSelectedAccount', async (req, res) => {
    const { accountId } = req.body ?? {}
    if (!accountId) return res.status(400).json({ error: 'accountId required' })
    await brokerService.setSelectedAccount(req.params.type, req.user._id, accountId)
    res.json({ ok: true })
})

// ─── Capabilities ─────────────────────────────────────────────────────────────
// Static per broker — lets the frontend render generically (show SL/TP inputs only when
// nativeProtection, etc.) instead of branching on the broker name.

export const capabilities = _handle('capabilities', (req, res) => {
    res.json({ capabilities: brokerService.capabilities(req.params.type) })
})

// ─── Account + positions ──────────────────────────────────────────────────────

export const getAccount = _handle('getAccount', async (req, res) => {
    const account = await brokerService.getAccount(req.params.type, req.user._id)
    res.json({ account })
})

export const getPositions = _handle('getPositions', async (req, res) => {
    // The broker answers with positions; what the app AUTHORED about them — the declared asset class
    // and the owning call — is the trade tier's to add, and does it (ideaService.enrichPositions).
    // This join used to be written out here, which §1 flagged as a cross-feature enrichment sitting
    // in a controller with no home.
    const positions = await brokerService.getPositions(req.params.type, req.user._id)
    res.json({ positions: await ideaService.enrichPositions(req.user._id, req.params.type, positions) })
})

// Close an open position in full. A position can live on any of the user's trading accounts (an
// idea may be placed across several accounts of one broker), so the caller passes the position's
// own accountId; we hand it to the adapter, which maps it to the broker-native account id and looks
// up the live volume. Falls back to the selected account for single-account / legacy callers.
export const closePosition = _handle('closePosition', async (req, res) => {
    const accountId = req.query.accountId ?? await _selectedAccountId(req.params.type, req.user._id)
    await brokerService.closePosition(req.params.type, req.user._id, accountId, req.params.positionId)
    res.json({ ok: true })
})

// ─── Working orders (the "orders in the air") ─────────────────────────────────

// List an account's working (pending) LIMIT/STOP orders. accountId via query; falls back to the
// broker's selected account.
export const listOrders = _handle('listOrders', async (req, res) => {
    const accountId = req.query.accountId ?? await _selectedAccountId(req.params.type, req.user._id)
    const orders = await brokerService.listOrders(req.params.type, req.user._id, accountId)
    res.json({ orders })
})

// Place a new working order (e.g. add a TP limit / stop level to a position).
export const placeOrder = _handle('placeOrder', async (req, res) => {
    const { accountId, symbol, direction, type, quantity, limitPrice, stopPrice, positionId } = req.body ?? {}
    if (!symbol || !direction || !type || quantity == null) {
        return res.status(400).json({ error: 'symbol, direction, type and quantity are required' })
    }
    const acct = accountId ?? await _selectedAccountId(req.params.type, req.user._id)
    const order = {
        symbol, direction, type, quantity,
        ...(limitPrice != null && { limitPrice }),
        ...(stopPrice  != null && { stopPrice }),
        ...(positionId != null && { positionId }),   // closing order for that position
    }
    const result = await brokerService.placeOrder(req.params.type, req.user._id, acct, order)
    res.status(201).json({ ok: true, order: result })
})

// Change a working order's price (keeps its id). accountId + limitPrice/stopPrice in body.
export const amendOrder = _handle('amendOrder', async (req, res) => {
    const { accountId, limitPrice, stopPrice } = req.body ?? {}
    if (limitPrice == null && stopPrice == null) {
        return res.status(400).json({ error: 'limitPrice or stopPrice required' })
    }
    const acct = accountId ?? await _selectedAccountId(req.params.type, req.user._id)
    // amendOrder may return a NEW order id (brokers that amend by cancel-then-place, e.g. cTrader).
    // Surface it so the client retracks the live order.
    const result = await brokerService.amendOrder(req.params.type, req.user._id, acct, req.params.orderId, { limitPrice, stopPrice })
    res.json({ ok: true, orderId: result?.orderId ?? req.params.orderId })
})

// Cancel a working order. accountId via query; falls back to the selected account.
export const cancelOrder = _handle('cancelOrder', async (req, res) => {
    const accountId = req.query.accountId ?? await _selectedAccountId(req.params.type, req.user._id)
    await brokerService.cancelOrder(req.params.type, req.user._id, accountId, req.params.orderId)
    res.json({ ok: true })
})
