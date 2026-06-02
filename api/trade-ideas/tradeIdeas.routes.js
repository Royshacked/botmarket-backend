import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { createTradeIdea, getTradeIdeas, deleteTradeIdea, updateTradeIdea } from './tradeIdeas.controller.js'

const router = express.Router()

router.post('/', log, createTradeIdea)
router.get('/', log, getTradeIdeas)
router.patch('/:id', log, updateTradeIdea)
router.delete('/:id', log, deleteTradeIdea)

export const tradeIdeasRoutes = router
