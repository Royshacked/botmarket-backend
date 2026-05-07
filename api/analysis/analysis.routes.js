import express from 'express'

import { log } from '../../middlewares/logger.middleware.js'

import { getAnalysis } from './analysis.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.post('/', log, getAnalysis)
export const analysisRoutes = router