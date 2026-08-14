import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    streamPortfolio,
    savePortfolioChatState,
    getPortfolioChatState,
    deletePortfolioChatState,
    getPendingReviews,
    getPortfolios,
    getPortfolioItems,
    completeReview,
    applyPortfolioRebalance,
    createAdoptionDraft,
    refreshAdoptionDraft,
    commitAdoptionDraft,
    listAdoptionDrafts,
    discardAdoptionDraft,
    correctAdoptedHolding,
    removeAdoptedHolding,
} from './portfolio.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/stream',                        log, streamPortfolio)
router.get('/',                               log, getPortfolios)       // the user's books
router.get('/pending-reviews',                log, getPendingReviews)
router.post('/chat-state',                    log, savePortfolioChatState)
router.get('/chat-state/:portfolioId',        log, getPortfolioChatState)
router.delete('/chat-state/:portfolioId',     log, deletePortfolioChatState)
router.get('/:portfolioId/items',             log, getPortfolioItems)   // the book's holdings — the portfolio's GET /:id
router.post('/:portfolioId/complete-review',  log, completeReview)
router.post('/:portfolioId/rebalance',        log, applyPortfolioRebalance)

// Adopting a book that already exists at a bank (docs/design/adopted-book.md). The draft is staged
// and confirmed before anything is real; the repair pair exists because the numbers come from a
// human retyping a bank screen, and a live leg is delete-locked everywhere else.
// Declared BEFORE the :portfolioId routes above would ever be reached for these paths — 'adopt' is a
// literal segment, so no collision, but keep them grouped.
router.post('/adopt/draft',                   log, createAdoptionDraft)
router.get('/adopt/drafts',                   log, listAdoptionDrafts)
router.patch('/adopt/draft/:draftId',          log, refreshAdoptionDraft)
router.post('/adopt/:draftId/commit',         log, commitAdoptionDraft)
router.delete('/adopt/draft/:draftId',        log, discardAdoptionDraft)
router.patch('/adopt/holding/:id',            log, correctAdoptedHolding)
router.delete('/adopt/holding/:id',           log, removeAdoptedHolding)

export const portfolioRoutes = router
