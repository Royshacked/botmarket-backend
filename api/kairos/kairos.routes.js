import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamKairos, generateKairosCall, updateKairosCall, actOnKairosCall, listKairos, getKairos, getKairosPerformance, deleteKairos } from './kairos.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/',            log, listKairos)           // list the user's calls
router.post('/',           log, generateKairosCall)   // Generate → persist a drafted call
router.post('/stream',     log, streamKairos)         // build conversation (SSE)
router.get('/performance', log, getKairosPerformance) // closed-calls track record (BEFORE /:id)
router.post('/:id/action', log, actOnKairosCall)      // confirm | edit | dismiss | manage a card
router.put('/:id',         log, updateKairosCall)     // edit in place (Update call / progressive chat_state)
router.get('/:id',         log, getKairos)            // one call + its monitor journal (pop-out polls this)
router.delete('/:id',      log, deleteKairos)         // remove a call

export const kairosRoutes = router
