import express from 'express'

import { log } from '../../middlewares/logger.middleware.js'

import { getNewsFeeds } from './news.controller.js'

const router = express.Router()

// We can add a middleware for the entire router:
// router.use(requireAuth)

router.get('/feed', log, getNewsFeeds)
export const newsRoutes = router