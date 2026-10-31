import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import {
    listCoverage, getCoverageOne, getCoverageBySymbol,
    initiateCoverage, updateCoverage, retireCoverage, deleteCoverage,
} from './analyst.controller.js'

const router = express.Router()

router.use(requireAuth)

// Coverage — reads open to all users; writes admin-only (house coverage is a broadcast artifact).
router.get('/coverage',                         log, listCoverage)
router.get('/coverage/by-symbol/:symbol',       log, getCoverageBySymbol)
router.get('/coverage/:id',                     log, getCoverageOne)
router.post('/coverage',                        log, requireAdmin, initiateCoverage)
router.put('/coverage/:id',                     log, requireAdmin, updateCoverage)
router.post('/coverage/:id/retire',             log, requireAdmin, retireCoverage)
router.delete('/coverage/:id',                  log, requireAdmin, deleteCoverage)

// The research queue's routes and its Floor list were removed (Roy, 2026-10-31: "we dont need anymore the research
// queue mechanism and list"). The queue stays the house's own pipe — Pythia's week, the Hotlist's reads and Atlas's
// sleeves enqueue and research through it (researchQueue / researchRun / houseResearch), unseen.

export const analystRoutes = router
