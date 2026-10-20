import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { saveDraftThread, linkThread, discardThread } from './threads.controller.js'

const router = express.Router()

router.use(requireAuth)

// Pythia's and Aether's own chats (phase 8e, D1) — the rest went with the desk panels (phase 9).
router.post('/draft',           log, saveDraftThread)
router.post('/:threadId/link',  log, linkThread)
router.delete('/:threadId',     log, discardThread)

export const threadsRoutes = router
