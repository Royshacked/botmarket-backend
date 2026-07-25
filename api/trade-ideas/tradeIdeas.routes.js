import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { createTradeIdea, createBatchIdeas, getTradeIdeas, getTradeIdea, deleteTradeIdea, updateTradeIdea, placeTradeIdeaOrders, triggerTradeIdeaEntry,
         confirmManualEntryOrder, confirmManualExitOrder, confirmManualAddOrder, activateManualPortfolioOrders, requestManualPortfolioExitOrders } from './tradeIdeas.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/batch', log, createBatchIdeas)
router.post('/',      log, createTradeIdea)
router.get('/',       log, getTradeIdeas)
router.get('/:id',    log, getTradeIdea)
router.patch('/:id',  log, updateTradeIdea)
router.post('/:id/orders',  log, placeTradeIdeaOrders)
router.post('/:id/trigger', log, triggerTradeIdeaEntry)
// Manual (broker-less) confirmations — the user reports the real fill / exit price.
router.post('/:id/manual-entry', log, confirmManualEntryOrder)
router.post('/:id/manual-exit',  log, confirmManualExitOrder)
router.post('/:id/manual-add',   log, confirmManualAddOrder)   // scale INTO a live manual position
router.post('/portfolio/:portfolioId/manual-activate', log, activateManualPortfolioOrders)
router.post('/portfolio/:portfolioId/manual-exit',     log, requestManualPortfolioExitOrders)
router.delete('/:id', log, deleteTradeIdea)

export const tradeIdeasRoutes = router
