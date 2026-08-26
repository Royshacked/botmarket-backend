import express                    from 'express'
import { log }                    from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import {
    streamStrategy,
    getCurrentTilt, listTilts, getTilt, publishTilt, updateTilt, retireTilt,
} from './strategy.controller.js'

const router = express.Router()

router.use(requireAuth)

// Streaming top-down agent — emits a <tilt> draft for preview (all authenticated users).
router.post('/stream',        log, streamStrategy)

// The tilt publication log. Reads are broadcast — the house view answers the same to everyone.
// Writes are admin-only: Pythia's forecast is the house-layer input that triggers the pipeline.
router.get('/tilt/current',     log, getCurrentTilt)
router.get('/tilt',             log, listTilts)
router.post('/tilt',            log, requireAdmin, publishTilt)
router.get('/tilt/:id',         log, getTilt)
router.put('/tilt/:id',         log, requireAdmin, updateTilt)
// Retiring ARCHIVES (status change, trail kept). There is deliberately no delete: a published view
// is the record the desk is graded on, and a desk that can erase its own calls has no track record.
router.post('/tilt/:id/retire', log, requireAdmin, retireTilt)

export const strategyRoutes = router
