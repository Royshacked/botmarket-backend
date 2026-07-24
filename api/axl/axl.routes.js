import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamAxl, routeAxl } from './axl.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/stream', log, streamAxl)
router.post('/route',  log, routeAxl)

export const axlRoutes = router
