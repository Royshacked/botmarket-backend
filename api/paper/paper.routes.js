/**
 * Paper trading routes (the simulation account).
 *
 * The paper BROKER (orders/positions/account) is served generically under
 * /api/broker/paper/* like any adapter. These routes own the paper-specific surface:
 * the global mode toggle, account config, the equity curve, and trade history.
 *
 * Route map (all requireAuth):
 *   Per-account (multi-account):
 *   GET    /api/paper/accounts                      → list all paper accounts (+ live equity)
 *   POST   /api/paper/accounts                      { name?, startingBalance?, currency? } → create
 *   PATCH  /api/paper/accounts/:accountId           { name?, spreadBps?, commissionPerTrade? } → rename + settings
 *   DELETE /api/paper/accounts/:accountId           → delete (409 if it holds an open position)
 *   POST   /api/paper/accounts/:accountId/reset     { startingBalance? } → wipe + restore balance
 *   GET    /api/paper/accounts/:accountId/equity-curve ?fromMs=
 *   GET    /api/paper/accounts/:accountId/trades       ?status=&limit=
 *
 *   Legacy single-account (TRANSITIONAL — operate on the default paper account):
 *   GET  /api/paper/state          { enabled, account: {...}, settings }
 *   PUT  /api/paper/mode           { enabled } → turn paper mode on/off
 *   PUT  /api/paper/settings       { spreadBps?, commissionPerTrade? } → cost settings
 *   POST /api/paper/reset          { startingBalance? } → wipe positions/orders, restore balance
 *   GET  /api/paper/trades         ?status=&limit= → trade history (paper)
 *   GET  /api/paper/equity-curve   ?fromMs= → equity points
 */

import { Router }      from 'express'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { log }         from '../../middleware/logger.middleware.js'
import * as ctrl       from './paper.controller.js'

export const paperRoutes = Router()
paperRoutes.use(requireAuth)

// Per-account (multi-account)
paperRoutes.get   ('/accounts',                       log, ctrl.listAccounts)
paperRoutes.post  ('/accounts',                       log, ctrl.createAccount)
paperRoutes.patch ('/accounts/:accountId',            log, ctrl.patchAccount)
paperRoutes.delete('/accounts/:accountId',            log, ctrl.deleteAccount)
paperRoutes.post  ('/accounts/:accountId/reset',      log, ctrl.resetAccount)
paperRoutes.get   ('/accounts/:accountId/equity-curve', log, ctrl.accountEquityCurve)
paperRoutes.get   ('/accounts/:accountId/trades',     log, ctrl.accountTrades)

// Legacy single-account (transitional)
paperRoutes.get ('/state',        log, ctrl.getState)
paperRoutes.put ('/mode',         log, ctrl.setMode)
paperRoutes.put ('/settings',     log, ctrl.updateSettings)
paperRoutes.post('/reset',        log, ctrl.resetDefault)
paperRoutes.get ('/trades',       log, ctrl.getTrades)
paperRoutes.get ('/equity-curve', log, ctrl.getEquityCurve)
