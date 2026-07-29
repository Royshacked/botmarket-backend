import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamAxl } from './axl.controller.js'

const router = express.Router()

router.use(requireAuth)

// One endpoint: Axl converses, charts and routes on the same turn. (`/route` was the one-shot
// doorman behind the landing box — folded into this one, history and all.)
router.post('/stream', log, streamAxl)

export const axlRoutes = router
