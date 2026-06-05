import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { getNewsFeed, streamNewsFeed, getAssetNews, getAssetNewsSentiment } from './newsFeed.controller.js'

const router = express.Router()

router.get('/', log, getNewsFeed)
router.get('/stream', streamNewsFeed)
router.get('/asset/:symbol', log, getAssetNews)
router.get('/asset/:symbol/sentiment', log, getAssetNewsSentiment)

export const newsFeedRoutes = router
