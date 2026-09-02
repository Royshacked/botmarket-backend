import express        from 'express'
import { log }        from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import { streamAether, getState, getPredictedState, getAetherForecasts, getExposureByTicker, getShockFeed } from './aether.controller.js'

const router = express.Router()

router.use(requireAuth)

// Chat stream — admin-only.
router.post('/stream', log, requireAdmin, streamAether)

// Read endpoints — broadcast, same for all authenticated users (Pythia tilt pattern).
router.get('/state',             log, getState)
router.get('/predicted-state',   log, getPredictedState)
router.get('/forecasts',         log, getAetherForecasts)
router.get('/exposure/:ticker',  log, getExposureByTicker)
router.get('/shock-feed',        log, getShockFeed)

export const aetherRoutes = router
