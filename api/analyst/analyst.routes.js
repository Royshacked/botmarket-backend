import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    streamAnalyst,
    listCoverage, getCoverageOne, initiateCoverage, updateCoverage, retireCoverage, deleteCoverage,
} from './analyst.controller.js'

const router = express.Router()

router.use(requireAuth)

// Streaming research agent (P3).
router.post('/stream',             log, streamAnalyst)

// Coverage CRUD (P1).
router.get('/coverage',            log, listCoverage)
router.post('/coverage',           log, initiateCoverage)
router.get('/coverage/:id',        log, getCoverageOne)
router.put('/coverage/:id',        log, updateCoverage)
// Retire ARCHIVES (status change, trail kept); delete REMOVES. Two operations, two verbs — retire
// used to answer the DELETE route, so the API claimed a removal that never happened.
router.post('/coverage/:id/retire', log, retireCoverage)
router.delete('/coverage/:id',     log, deleteCoverage)

export const analystRoutes = router
