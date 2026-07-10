import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamKairos, generateKairosCall, actOnKairosCall, listKairos, deleteKairos } from './kairos.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/',            log, listKairos)           // list the user's calls
router.post('/',           log, generateKairosCall)   // Generate → persist a drafted call
router.post('/stream',     log, streamKairos)         // build conversation (SSE)
router.post('/:id/action', log, actOnKairosCall)      // confirm | edit | dismiss a readiness card
router.delete('/:id',      log, deleteKairos)         // remove a call

export const kairosRoutes = router
