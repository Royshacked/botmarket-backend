import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    saveDraftThread, linkThread, pinThread, listThreads, getThread, discardThread,
} from './threads.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/',                 log, listThreads)
router.post('/draft',           log, saveDraftThread)
router.get('/:threadId',        log, getThread)
router.post('/:threadId/link',  log, linkThread)
router.post('/:threadId/pin',   log, pinThread)
router.delete('/:threadId',     log, discardThread)

export const threadsRoutes = router
