import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getNewsFeed, streamNewsFeed, getAssetNews, getAssetNewsSentiment } from './newsFeed.controller.js'

const router = express.Router()

// The shared feed + its SSE stream stay public (cheap, cached). The per-asset
// endpoints hit external provider APIs and (sentiment) run an LLM per request,
// so they're authed to avoid an unauthenticated cost/abuse vector.
router.get('/', log, getNewsFeed)
router.get('/stream', streamNewsFeed)
router.get('/asset/:symbol', requireAuth, log, getAssetNews)
router.get('/asset/:symbol/sentiment', requireAuth, log, getAssetNewsSentiment)

export const newsFeedRoutes = router
