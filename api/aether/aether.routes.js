import express        from 'express'
import { log }        from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamAether, getState, getAetherForecasts, getExposureByTicker } from './aether.controller.js'

const router = express.Router()

router.use(requireAuth)

// Admin guard — inline for now. Later: swap to `requireAdmin` (checks role === 'admin').
function requireRoyShacked(req, res, next) {
    if (req.user?.username !== 'roy_shacked') return res.status(403).json({ error: 'Forbidden' })
    next()
}

// Chat stream — admin-only.
router.post('/stream', log, requireRoyShacked, streamAether)

// Read endpoints — broadcast, same for all authenticated users (Pythia tilt pattern).
router.get('/state',             log, getState)
router.get('/forecasts',         log, getAetherForecasts)
router.get('/exposure/:ticker',  log, getExposureByTicker)

export const aetherRoutes = router
