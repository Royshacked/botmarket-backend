import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getToday, getBoard, getOutcomes, getReads, requestRead } from './hotlist.controller.js'

const router = express.Router()

router.use(requireAuth)
router.get('/',           log, getToday)      // ?day=YYYY-MM-DD
router.get('/boards/:id', log, getBoard)
router.get('/outcomes',   log, getOutcomes)
router.get('/reads',      log, getReads)       // the catalyst reads — short-swing targets
router.post('/reads',     log, requestRead)    // a user asks for one on a This week row

export const hotlistRoutes = router
