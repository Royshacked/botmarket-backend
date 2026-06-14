import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamPortfolio, savePortfolioChatState, getPortfolioChatState, deletePortfolioChatState } from './portfolio.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/stream',                   log, streamPortfolio)
router.post('/chat-state',               log, savePortfolioChatState)
router.get('/chat-state/:portfolioId',   log, getPortfolioChatState)
router.delete('/chat-state/:portfolioId', log, deletePortfolioChatState)

export const portfolioRoutes = router
