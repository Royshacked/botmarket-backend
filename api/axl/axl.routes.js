import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamAxl, deliverBrief } from './axl.controller.js'

const router = express.Router()

router.use(requireAuth)

// One endpoint: Axl converses, charts and routes on the same turn. (`/route` was the one-shot
// doorman behind the landing box — folded into this one, history and all.)
router.post('/stream', log, streamAxl)

// The market brief, posted into the user's own Axl conversation. Separate from /stream because it
// is a DELIVERY, not a turn: nothing is said to Axl and no history is written on the user's side.
// It is the confirm handler behind the daily offer card.
router.post('/brief', log, deliverBrief)

export const axlRoutes = router
