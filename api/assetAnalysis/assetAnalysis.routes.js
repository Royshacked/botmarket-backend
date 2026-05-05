import express from 'express'

import { log } from '../../middlewares/logger.middleware.js'

import { getAssetAnalysis } from './assetAnalysis.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.get('/asset/:symbol', log, getAssetAnalysis)
export const assetAnalysisRoutes = router