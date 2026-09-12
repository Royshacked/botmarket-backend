import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import {
    streamAnalyst,
    listCoverage, getCoverageOne, getCoverageBySymbol, deduplicateCoverage,
    initiateCoverage, updateCoverage, retireCoverage, deleteCoverage,
    listResearchQueue, enqueueResearch, startResearch, completeResearch, rejectResearch,
    startResearchRun, getResearchRun, stopResearchRun, requeueStalledResearch,
} from './analyst.controller.js'

const router = express.Router()

router.use(requireAuth)

// Streaming research agent (P3).
router.post('/stream',             log, streamAnalyst)

// Coverage — reads open to all users; writes admin-only (house coverage is a broadcast artifact).
router.get('/coverage',                         log, listCoverage)
router.get('/coverage/by-symbol/:symbol',       log, getCoverageBySymbol)
router.get('/coverage/:id',                     log, getCoverageOne)
router.post('/coverage',                        log, requireAdmin, initiateCoverage)
router.post('/coverage/deduplicate',            log, requireAdmin, deduplicateCoverage)
router.put('/coverage/:id',                     log, requireAdmin, updateCoverage)
router.post('/coverage/:id/retire',             log, requireAdmin, retireCoverage)
router.delete('/coverage/:id',                  log, requireAdmin, deleteCoverage)

// Research queue — the Argus→Prometheus pipeline. Admin-only: all endpoints gate on role.
router.get('/research-queue',                   log, requireAdmin, listResearchQueue)
router.post('/research-queue',                  log, requireAdmin, enqueueResearch)
// The headless run over the whole queue (researchRun.service). Registered ahead of the `:id`
// routes so `run` is never read as an id.
router.get('/research-queue/run',               log, requireAdmin, getResearchRun)
router.post('/research-queue/run',              log, requireAdmin, startResearchRun)
router.post('/research-queue/run/stop',         log, requireAdmin, stopResearchRun)
// Every claimed (in_research) name back to queued — off the queue's own state, so it works after
// a restart took the run's memory. Leaves the name a running batch is mid-turn on.
router.post('/research-queue/requeue',          log, requireAdmin, requeueStalledResearch)
router.post('/research-queue/:id/start',        log, requireAdmin, startResearch)
router.post('/research-queue/:id/complete',     log, requireAdmin, completeResearch)
router.post('/research-queue/:id/reject',       log, requireAdmin, rejectResearch)

export const analystRoutes = router
