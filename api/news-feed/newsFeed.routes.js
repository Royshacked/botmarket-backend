import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { getNewsFeed, streamNewsFeed } from './newsFeed.controller.js'

const router = express.Router()

router.get('/', log, getNewsFeed)
router.get('/stream', streamNewsFeed)

export const newsFeedRoutes = router
