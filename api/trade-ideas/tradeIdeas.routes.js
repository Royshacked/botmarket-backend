import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { createTradeIdea, getTradeIdeas, deleteTradeIdea, updateTradeIdea } from './tradeIdeas.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/',     log, createTradeIdea)
router.get('/',      log, getTradeIdeas)
router.patch('/:id', log, updateTradeIdea)
router.delete('/:id',log, deleteTradeIdea)

export const tradeIdeasRoutes = router
