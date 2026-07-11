/**
 * Trades analytics routes — the unified read surface over the `trades` ledger.
 *
 * Where the paper trade routes are paper-scoped, these expose EVERY mode (paper + live +
 * manual) for reports, graphs and (later) the Axl performance layer over MCP. Read-only.
 *
 * Route map (all requireAuth):
 *   GET /api/trades        ?mode=&status=&symbol=&origin=&portfolioId=&callId=&accountId=
 *                          &fromMs=&toMs=&limit=   → { trades } (newest first; omit mode = all modes)
 *   GET /api/trades/stats  (same filters, minus status — always closed trades)
 *                          → { stats: { overall, byMode, byOrigin, bySymbol } }
 */

import { Router }              from 'express'
import { tradeCaptureService } from '../../services/tradeCapture.service.js'
import { requireAuth }         from '../../middleware/auth.middleware.js'
import { log }                 from '../../middleware/logger.middleware.js'
import { logger }              from '../../services/logger.service.js'

const LOG = '[trades.routes]'

export const tradesRoutes = Router()

/** Map the query string to a listTrades/tradeStats filter (only present keys are set). */
function _filter(q = {}) {
    const f = {}
    if (q.mode)        f.mode        = q.mode
    if (q.status)      f.status      = q.status
    if (q.symbol)      f.symbol      = q.symbol
    if (q.origin)      f.originType  = q.origin
    if (q.portfolioId) f.portfolioId = q.portfolioId
    if (q.callId)      f.callId      = q.callId
    if (q.accountId)   f.accountId   = q.accountId
    if (q.fromMs != null) f.fromMs = Number(q.fromMs)
    if (q.toMs   != null) f.toMs   = Number(q.toMs)
    if (q.limit  != null) f.limit  = Number(q.limit)
    return f
}

tradesRoutes.get('/', requireAuth, log, async (req, res) => {
    try {
        const trades = await tradeCaptureService.listTrades(req.user._id, _filter(req.query))
        res.json({ trades })
    } catch (err) {
        logger.error(LOG, 'list trades error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})

tradesRoutes.get('/stats', requireAuth, log, async (req, res) => {
    try {
        const stats = await tradeCaptureService.tradeStats(req.user._id, _filter(req.query))
        res.json({ stats })
    } catch (err) {
        logger.error(LOG, 'trade stats error:', err.message)
        res.status(err.status ?? 500).json({ error: err.message })
    }
})
