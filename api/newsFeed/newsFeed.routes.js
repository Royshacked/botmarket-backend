import express from 'express'

import { log } from '../../middlewares/logger.middleware.js'

import { getNewsFeed } from './newsFeed.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.get('/', log, getNewsFeed)
export const newsFeedRoutes = router