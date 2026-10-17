import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { agentLimiter } from '../../middleware/rateLimit.middleware.js'
import { getActiveSession, startNewSession, listSessions, getSessionMessages, postSessionTurn, editInSession } from './sessions.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/',              log, listSessions)
// Declared BEFORE /:id/messages so 'active' is never read as a session id.
router.get('/active',        log, getActiveSession)
router.post('/new',          log, startNewSession)
router.get('/:id/messages',  log, getSessionMessages)
// A turn spends model calls — the same per-session budget as every desk's /stream (agentLimiter).
router.post('/:id/turn',     agentLimiter, log, postSessionTurn)
router.post('/:id/edit',     log, editInSession)

export const sessionsRoutes = router
