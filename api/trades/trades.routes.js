/**
 * Trades analytics routes — the route table only; handlers live in trades.controller.js.
 *
 * Route map (all requireAuth):
 *   GET /api/trades        ?mode=&status=&symbol=&origin=&portfolioId=&callId=&accountId=
 *                          &fromMs=&toMs=&limit=   → { trades } (newest first; omit mode = all modes)
 *   GET /api/trades/stats  (same filters, minus status — always closed trades)
 *                          → { stats: { overall, byMode, byOrigin, bySymbol } }
 */

import { Router }      from 'express'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { log }         from '../../middleware/logger.middleware.js'
import { listTrades, tradeStats } from './trades.controller.js'

export const tradesRoutes = Router()

tradesRoutes.use(requireAuth)

// `/stats` before nothing else here, but keep it first by habit: a later `/:id` route added above
// it would otherwise swallow the literal.
tradesRoutes.get('/stats', log, tradeStats)
tradesRoutes.get('/',      log, listTrades)
