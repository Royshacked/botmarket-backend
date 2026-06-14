import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getOrchestration, streamOrchestration } from './orchestrator.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/',       log, getOrchestration)
router.post('/stream', log, streamOrchestration)
export const orchestratorRoutes = router