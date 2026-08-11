import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    saveDraftThread, linkThread, pinThread, listThreads, listUnfinishedThreads, getThread, discardThread,
} from './threads.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/',                 log, listThreads)
router.post('/draft',           log, saveDraftThread)
// Declared BEFORE /:threadId, or 'unfinished' is parsed as a thread id.
router.get('/unfinished',       log, listUnfinishedThreads)
router.get('/:threadId',        log, getThread)
router.post('/:threadId/link',  log, linkThread)
router.post('/:threadId/pin',   log, pinThread)
router.delete('/:threadId',     log, discardThread)

export const threadsRoutes = router
