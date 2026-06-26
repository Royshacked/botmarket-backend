import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    streamPortfolio,
    savePortfolioChatState,
    getPortfolioChatState,
    deletePortfolioChatState,
    getPendingReviews,
    completeReview,
} from './portfolio.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/stream',                        log, streamPortfolio)
router.get('/pending-reviews',                log, getPendingReviews)
router.post('/chat-state',                    log, savePortfolioChatState)
router.get('/chat-state/:portfolioId',        log, getPortfolioChatState)
router.delete('/chat-state/:portfolioId',     log, deletePortfolioChatState)
router.post('/:portfolioId/complete-review',  log, completeReview)

export const portfolioRoutes = router
