import express from 'express'

import { log } from '../../middleware/logger.middleware.js'

import { getOrchestration, streamOrchestration } from './orchestrator.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.post('/',       log, getOrchestration)
router.post('/stream', log, streamOrchestration)
export const orchestratorRoutes = router