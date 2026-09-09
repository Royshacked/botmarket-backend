import express        from 'express'
import { log }        from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import { streamAether, getState, getPredictedState, getAetherForecasts, getExposureByTicker, getShockFeed, getCandidates, startDiscovery, getDiscoveryStatus } from './aether.controller.js'

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
// Event pipeline — the list the desk actually shows now.
router.get('/candidates',        log, getCandidates)

// Discovery is MANUAL and ADMIN-ONLY. It is the one leg of the engine that spends real
// money per press — an Opus call with web search per event, plus several hundred SEC
// requests — so it is not on the scheduler and not reachable by a signed-in user. The
// candidates it produces stay readable by everyone, above.
router.post('/discover',         log, requireAdmin, startDiscovery)
router.get('/discover',          log, requireAdmin, getDiscoveryStatus)

export const aetherRoutes = router
