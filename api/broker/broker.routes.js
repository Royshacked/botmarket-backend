/**
 * Broker Routes
 *
 * All data routes require authentication (requireAuth middleware).
 * The OAuth callback is the only unauthenticated route — user identity
 * is recovered from the JWT-signed `state` param instead.
 *
 * Route map:
 *   GET  /api/broker/connect/:type         start OAuth for broker
 *   GET  /api/broker/callback              OAuth callback (all brokers)
 *   GET  /api/broker/connections           list user's connected brokers
 *   DEL  /api/broker/connections/:type     disconnect a broker
 *   GET  /api/broker/:type/account         account summary
 *   GET  /api/broker/:type/positions       open positions
 */

import { Router }         from 'express'
import jwt                from 'jsonwebtoken'
import { brokerService }  from './broker.service.js'
import { requireAuth }    from '../../middleware/auth.middleware.js'
import { logger }         from '../../services/logger.service.js'

const LOG          = '[broker.routes]'
const FRONTEND_URL = process.env.CLIENT_URL ?? 'http://localhost:5173'

export const brokerRoutes = Router()

// ─── OAuth start ──────────────────────────────────────────────────────────────
// Redirect the browser to the broker's consent page.
// requireAuth reads the JWT cookie — works because this is a browser navigation,
// so cookies are sent automatically.

brokerRoutes.get('/connect/:type', requireAuth, (req, res) => {
    try {
        const url = brokerService.getConnectUrl(req.params.type, req.user._id)
        logger.info(LOG, `OAuth start — type=${req.params.type} user=${req.user._id}`)
        res.redirect(url)
    } catch (err) {
        logger.error(LOG, 'getConnectUrl error:', err.message)
        res.redirect(`${FRONTEND_URL}/?broker=error&reason=unknown_type`)
    }
})

// ─── OAuth callback ───────────────────────────────────────────────────────────
// Broker redirects here after user consent.
// User identity is recovered from the signed `state` param.

brokerRoutes.get('/callback', async (req, res) => {
    const { code, state } = req.query
    if (!code || !state) {
        logger.warn(LOG, 'OAuth callback: missing code or state')
        return res.redirect(`${FRONTEND_URL}/?broker=error&reason=missing_params`)
    }

    let userId, brokerType
    try {
        const payload = jwt.verify(state, process.env.JWT_SECRET)
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
})

// ─── List connections ─────────────────────────────────────────────────────────

brokerRoutes.get('/connections', requireAuth, async (req, res) => {
    try {
        const connections = await brokerService.listConnections(req.user._id)
        res.json({ connections })
    } catch (err) {
        logger.error(LOG, 'listConnections error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

// ─── Disconnect ───────────────────────────────────────────────────────────────

brokerRoutes.delete('/connections/:type', requireAuth, async (req, res) => {
    try {
        await brokerService.disconnect(req.params.type, req.user._id)
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, 'disconnect error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

// ─── Per-broker account data ──────────────────────────────────────────────────

// ─── Trading accounts ─────────────────────────────────────────────────────────

brokerRoutes.get('/:type/trading-accounts', requireAuth, async (req, res) => {
    try {
        const data = await brokerService.getTradingAccounts(req.params.type, req.user._id)
        res.json(data)
    } catch (err) {
        logger.error(LOG, `getTradingAccounts (${req.params.type}):`, err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

brokerRoutes.patch('/connections/:type/account', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.body
        if (!accountId) return res.status(400).json({ error: 'accountId required' })
        await brokerService.setSelectedAccount(req.params.type, req.user._id, accountId)
        res.json({ ok: true })
    } catch (err) {
        logger.error(LOG, `setSelectedAccount (${req.params.type}):`, err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

// ─── Per-broker account data ──────────────────────────────────────────────────

brokerRoutes.get('/:type/account', requireAuth, async (req, res) => {
    try {
        const account = await brokerService.getAccount(req.params.type, req.user._id)
        res.json({ account })
    } catch (err) {
        logger.error(LOG, `getAccount (${req.params.type}):`, err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

brokerRoutes.get('/:type/positions', requireAuth, async (req, res) => {
    try {
        const positions = await brokerService.getPositions(req.params.type, req.user._id)
        res.json({ positions })
    } catch (err) {
        logger.error(LOG, `getPositions (${req.params.type}):`, err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})
