import express from 'express'

import { log } from '../../middlewares/logger.middleware.js'

import { getAssetNews } from './assetNews.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.get('/news/analysis/:symbol', log, getAssetNews)
export const assetNewsRoutes = router