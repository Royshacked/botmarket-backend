import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamAxl, streamBrief } from './axl.controller.js'

const router = express.Router()

router.use(requireAuth)

// One endpoint: Axl converses, charts and routes on the same turn. (`/route` was the one-shot
// doorman behind the landing box — folded into this one, history and all.)
router.post('/stream', log, streamAxl)

// The market brief, streamed into the Axl chat panel. Separate from /stream because it is a
// DELIVERY, not a turn: nothing is said to Axl and no model runs. Same SSE shape, so the client
// reads it with the handlers it already has. It is the confirm handler behind the daily offer card.
// Wrapped rather than mounted bare: the handler's third parameter is its test seam (the brief
// fetcher), and Express would hand it `next`.
router.post('/brief/stream', log, (req, res) => streamBrief(req, res))

export const axlRoutes = router
