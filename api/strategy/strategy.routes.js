import express                    from 'express'
import { log }                    from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import {
    streamStrategy,
    listIndustries, getIndustry, publishIndustry,
} from './strategy.controller.js'

const router = express.Router()

router.use(requireAuth)

// THE WHOLE DESK IS ADMIN-ONLY (2026-09-14). Pythia's chat, the drafts it emits and the views it
// publishes are the house layer — the input the pipeline is steered from, not a view a trader
// consumes. The reads used to be broadcast ("the house view answers the same to everyone") while
// only the writes were gated; that left the Forecasts board and this stream open to any signed-in
// user, so the client hid the desk for traders and the server still answered them. Gating every
// route here makes the served set equal to the visible set, the same rule industryNotify
// applies to the cards (`listAdminUserIds`). Traders reach nothing under /api/strategy — the
// monitors and the other desks (Atlas, Axl) read the views in-process, not through these routes, so they are
// unaffected.
router.use(requireAdmin)

// Streaming industry-desk agent — emits <industry_view> drafts for preview.
router.post('/stream',        log, streamStrategy)

// The industry views (Pythia, rebuilt 2026-10-05): every GICS sub-industry with the house's answer to
// the three questions beside the engine's measurements; one sub-industry by its 8-digit code; publish
// a reviewed draft.
router.get('/industries',        log, listIndustries)
router.get('/industries/:code',  log, getIndustry)
router.post('/industries/:code', log, publishIndustry)

export const strategyRoutes = router
