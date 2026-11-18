import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { saveDraftThread, linkThread, discardThread } from './threads.controller.js'

const router = express.Router()

router.use(requireAuth)

// Pythia's own chat (phase 8e, D1; Aether's went 2026-11-18) — the rest went with the desk panels (phase 9).
router.post('/draft',           log, saveDraftThread)
router.post('/:threadId/link',  log, linkThread)
router.delete('/:threadId',     log, discardThread)

export const threadsRoutes = router
