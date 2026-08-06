import express        from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    streamStrategy,
    getCurrentTilt, listTilts, getTilt, publishTilt, updateTilt, retireTilt,
} from './strategy.controller.js'

const router = express.Router()

router.use(requireAuth)

// Streaming top-down agent — emits a <tilt> draft for preview.
router.post('/stream',        log, streamStrategy)

// The tilt publication log. Unlike coverage these are NOT owner-scoped: the house view is a
// broadcast, so `/tilt/current` answers the same document to everyone.
router.get('/tilt/current',   log, getCurrentTilt)
router.get('/tilt',           log, listTilts)
router.post('/tilt',          log, publishTilt)
router.get('/tilt/:id',       log, getTilt)
router.put('/tilt/:id',       log, updateTilt)
// Retiring ARCHIVES (status change, trail kept). There is deliberately no delete: a published view
// is the record the desk is graded on, and a desk that can erase its own calls has no track record.
router.post('/tilt/:id/retire', log, retireTilt)

export const strategyRoutes = router
