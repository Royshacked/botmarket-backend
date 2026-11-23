import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { gate, getAccess, getLatest, getRun, getNodeHistory, getScorecard, postOverride } from './situation.controller.js'

// The situation network's board (docs/design/situation-network.md §11.6): allow-listed users only (gate → 404 off it).
const router = express.Router()

// The client's "may I see it?" — answered for every signed-in user (a 404 here was a console error on every page load
// for everyone off the list); everything else is behind the gate.
router.get('/access',             requireAuth, getAccess)
router.use(requireAuth, gate)
router.get('/',                   log, getLatest)        // the latest run, whole, + the run list
router.get('/runs/:id',           log, getRun)
router.get('/nodes/:id/history',  log, getNodeHistory)
router.get('/scorecard',          log, getScorecard)
router.post('/nodes/:id/override', log, postOverride)    // Roy's numbers → a new run (admin only)

export const situationRoutes = router
