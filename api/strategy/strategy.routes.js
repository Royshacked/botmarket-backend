import express                    from 'express'
import { log }                    from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import {
    streamStrategy,
    getCurrentTilt, listTilts, getTilt, publishTilt, updateTilt, retireTilt,
} from './strategy.controller.js'

const router = express.Router()

router.use(requireAuth)

// THE WHOLE DESK IS ADMIN-ONLY (2026-09-14). Pythia's chat, the draft it emits and the tilt log it
// publishes into are the house layer — the input the pipeline is steered from, not a view a trader
// consumes. The reads used to be broadcast ("the house view answers the same to everyone") while
// only the writes were gated; that left the Forecasts board and this stream open to any signed-in
// user, so the client hid the desk for traders and the server still answered them. Gating every
// route here makes the served set equal to the visible set, the same rule tiltNotify already
// applies to the cards (`listAdminUserIds`). Traders reach nothing under /api/strategy — the
// monitors and the other desks read the tilt in-process, not through these routes, so they are
// unaffected.
router.use(requireAdmin)

// Streaming top-down agent — emits a <tilt> draft for preview.
router.post('/stream',        log, streamStrategy)

// The tilt publication log.
router.get('/tilt/current',     log, getCurrentTilt)
router.get('/tilt',             log, listTilts)
router.post('/tilt',            log, publishTilt)
router.get('/tilt/:id',         log, getTilt)
router.put('/tilt/:id',         log, updateTilt)
// Retiring ARCHIVES (status change, trail kept). There is deliberately no delete: a published view
// is the record the desk is graded on, and a desk that can erase its own calls has no track record.
router.post('/tilt/:id/retire', log, retireTilt)

export const strategyRoutes = router
