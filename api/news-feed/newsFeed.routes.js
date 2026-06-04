import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { getNewsFeed, streamNewsFeed, getAssetNews } from './newsFeed.controller.js'

const router = express.Router()

router.get('/', log, getNewsFeed)
router.get('/stream', streamNewsFeed)
router.get('/asset/:symbol', log, getAssetNews)

export const newsFeedRoutes = router
