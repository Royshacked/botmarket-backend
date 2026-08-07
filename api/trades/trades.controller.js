/**
 * Trades analytics handlers — the unified read surface over the `trades` ledger.
 *
 * Where the paper routes are paper-scoped, these expose EVERY mode (paper + live + manual) for
 * reports, graphs and (later) the Axl performance layer over MCP. Read-only.
 *
 * Split out of trades.routes.js, which held both handlers and the query mapper inline.
 */

import { tradeCaptureService } from '../../services/tradeCapture.service.js'
import { logger }              from '../../services/logger.service.js'

const LOG = '[trades:controller]'

/**
 * Map the query string to a listTrades/tradeStats filter. Only keys actually present are set, so an
 * omitted filter never narrows the read — `?mode=paper` alone must not also pin symbol or origin.
 * Pure.
 */
export function _filter(q = {}) {
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

export async function listTrades(req, res, next) {
    try {
        const trades = await tradeCaptureService.listTrades(req.user._id, _filter(req.query))
        res.json({ trades })
    } catch (err) {
        logger.error(LOG, 'list trades error:', err.message)
        next(err)
    }
}

export async function tradeStats(req, res, next) {
    try {
        const stats = await tradeCaptureService.tradeStats(req.user._id, _filter(req.query))
        res.json({ stats })
    } catch (err) {
        logger.error(LOG, 'trade stats error:', err.message)
        next(err)
    }
}
