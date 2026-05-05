import express from 'express'

import { log } from '../../middlewares/logger.middleware.js'

import { getNewsFeeds } from './newsFeed.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.get('/news/feed', log, getNewsFeeds)
export const newsFeedRoutes = router