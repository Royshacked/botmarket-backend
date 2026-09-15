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
 *   POST   /api/paper/accounts/:accountId/cash      { amount, reason? }  → a dividend / deposit / fee
 *   GET    /api/paper/accounts/:accountId/equity-curve ?fromMs=
 *   GET    /api/paper/accounts/:accountId/trades       ?status=&limit=
 *
 *   Default-account (the paper toggle — the header badge and resolveWorkspace key on it):
 *   GET  /api/paper/state          { enabled, account: {...}, settings }
 *   PUT  /api/paper/mode           { enabled } → turn paper mode on/off
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
paperRoutes.post  ('/accounts/:accountId/cash',       log, ctrl.adjustAccountCash)
paperRoutes.get   ('/accounts/:accountId/equity-curve', log, ctrl.accountEquityCurve)
paperRoutes.get   ('/accounts/:accountId/trades',     log, ctrl.accountTrades)

// Default-account: the paper toggle. `enabled` on the oldest paper account is the flag
// resolveWorkspace reads, so these two are load-bearing. The other four single-account routes
// (settings / reset / trades / equity-curve) had no caller left and were removed — the
// per-account forms above replaced them.
paperRoutes.get ('/state',        log, ctrl.getState)
paperRoutes.put ('/mode',         log, ctrl.setMode)
