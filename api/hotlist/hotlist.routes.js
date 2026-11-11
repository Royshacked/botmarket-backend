import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getToday, getBoard, getOutcomes, getReads, requestRead, getBook, getScorecard, getDayBoards } from './hotlist.controller.js'

const router = express.Router()

router.use(requireAuth)
router.get('/',           log, getToday)      // ?day=YYYY-MM-DD
router.get('/boards/:id', log, getBoard)
router.get('/day',        log, getDayBoards)   // ?day=YYYY-MM-DD — the day boards (09:20 · 10:30 · 14:30 ET), their own collection
router.get('/outcomes',   log, getOutcomes)
router.get('/reads',      log, getReads)       // the catalyst reads — short-swing targets
router.post('/reads',     log, requestRead)    // a user asks for one on a This week row
router.get('/book',       log, getBook)        // the house's Swing and Long term names (coverage, by target horizon)
router.get('/scorecard',  log, getScorecard)   // Prometheus's calls vs SPY: coverage marks, catalyst reads vs passes

export const hotlistRoutes = router
