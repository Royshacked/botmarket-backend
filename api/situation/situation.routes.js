import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { gate, getLatest, getRun, getNodeHistory, getScorecard, postOverride } from './situation.controller.js'

// The situation network's board (docs/design/situation-network.md §11.6): allow-listed users only (gate → 404 off it).
const router = express.Router()

router.use(requireAuth, gate)
router.get('/',                   log, getLatest)        // the latest run, whole, + the run list
router.get('/runs/:id',           log, getRun)
router.get('/nodes/:id/history',  log, getNodeHistory)
router.get('/scorecard',          log, getScorecard)
router.post('/nodes/:id/override', log, postOverride)    // Roy's numbers → a new run (admin only)

export const situationRoutes = router
