import express        from 'express'
import { log }        from '../../middleware/logger.middleware.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'
import { streamAether, getCandidates, getCandidatesByTicker, getScorecardRead, startDiscovery, getDiscoveryStatus } from './aether.controller.js'

const router = express.Router()

router.use(requireAuth)

// Chat stream — admin-only.
router.post('/stream', log, requireAdmin, streamAether)

// The list the desk shows — broadcast, same for all authenticated users (Pythia tilt
// pattern). Five sibling reads went with the channel engine on 2026-09-09: /state,
// /predicted-state, /forecasts, /exposure/:ticker and /shock-feed were all still serving
// signed-in users from collections nothing had written in months.
router.get('/candidates',        log, getCandidates)
// One name, every event that reached it — "why is this here", asked from anywhere in the
// app. Declared AFTER the bare /candidates so the literal path is never shadowed by the
// parameter, and readable by any signed-in user like the list it drills into.
router.get('/candidates/:ticker', log, getCandidatesByTicker)
// What the names did — graded at expiry by the engine's nightly refresh. Broadcast, like
// the list it grades: a desk whose record only its admin can see is a desk on trust.
router.get('/scorecard',          log, getScorecardRead)

// Discovery is MANUAL and ADMIN-ONLY. It is the one leg of the engine that spends real
// money per press — an Opus call with web search per event, plus several hundred SEC
// requests — so it is not on the scheduler and not reachable by a signed-in user. The
// candidates it produces stay readable by everyone, above.
router.post('/discover',         log, requireAdmin, startDiscovery)
router.get('/discover',          log, requireAdmin, getDiscoveryStatus)

export const aetherRoutes = router
