import express                    from 'express'
import { log }                    from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import {
    streamStrategy,
    listIndustries, getIndustry, publishIndustry,
} from './strategy.controller.js'

const router = express.Router()

router.use(requireAuth)

// READ FOR EVERYONE, AUTHOR FOR ADMINS (Roy, 2026-10-05). The industry views are a broadcast — the
// house's description of each industry, the same for every user — so the Forecasts board and one
// industry's detail are open to any signed-in user. Chatting with Pythia and publishing an answer
// change the house layer, so those two stay admin-only, each gated where it is mounted.
//
// (2026-09-14 to 2026-10-05 the whole desk was admin-only: the tilt was the input the pipeline was
// steered from, not a view a trader consumed.)

// The industry views: every GICS sub-industry with the house's answer to the three questions beside
// the engine's measurements; one sub-industry by its 8-digit code.
router.get('/industries',        log, listIndustries)
router.get('/industries/:code',  log, getIndustry)

// Authoring: the streaming desk (emits <industry_view> drafts) and publishing a reviewed draft.
router.post('/stream',           requireAdmin, log, streamStrategy)
router.post('/industries/:code', requireAdmin, log, publishIndustry)

export const strategyRoutes = router
