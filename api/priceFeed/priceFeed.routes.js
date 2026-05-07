import express from 'express'

import { log } from '../../middlewares/logger.middleware.js'

import { getPriceFeed } from './priceFeed.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.get('/:ticker', log, getPriceFeed)
export const priceFeedRoutes = router