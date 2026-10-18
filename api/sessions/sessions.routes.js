import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { agentLimiter } from '../../middleware/rateLimit.middleware.js'
import { getActiveSession, startNewSession, listSessions, getSessionMessages, postSessionTurn, editInSession, continueSession, actInSession, editSessionState, deleteSession } from './sessions.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/',              log, listSessions)
// Declared BEFORE /:id/messages so 'active' is never read as a session id.
router.get('/active',        log, getActiveSession)
router.post('/new',          log, startNewSession)
router.get('/:id/messages',  log, getSessionMessages)
// History's delete — an archived session and its rows (the live one is refused).
router.delete('/:id',        log, deleteSession)
// A turn spends model calls — the same per-session budget as every desk's /stream (agentLimiter).
router.post('/:id/turn',     agentLimiter, log, postSessionTurn)
router.post('/:id/edit',     log, editInSession)
// A tap on a decision may run the next chain step — the same model budget as a turn.
router.post('/:id/continue', agentLimiter, log, continueSession)
// A desk's commit (Generate, Arm, Update…) and a direct edit of its work — no model call (plan phase 8).
router.post('/:id/act',      log, actInSession)
router.patch('/:id/state',   log, editSessionState)

export const sessionsRoutes = router
