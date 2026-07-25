import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    streamAnalyst,
    listCoverage, getCoverageOne, initiateCoverage, updateCoverage, retireCoverage,
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
router.delete('/coverage/:id',     log, retireCoverage)

export const analystRoutes = router
