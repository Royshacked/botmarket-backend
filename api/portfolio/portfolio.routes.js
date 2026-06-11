import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamPortfolio, savePortfolioChatState, getPortfolioChatState } from './portfolio.controller.js'

const router = express.Router()

router.post('/stream',                   log, requireAuth, streamPortfolio)
router.post('/chat-state',               log, requireAuth, savePortfolioChatState)
router.get('/chat-state/:portfolioId',   log, requireAuth, getPortfolioChatState)

export const portfolioRoutes = router
