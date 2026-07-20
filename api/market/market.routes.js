import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getStatus, getCandles, getQuote } from './market.controller.js'

const router = express.Router()

router.use(requireAuth)
router.get('/status', log, getStatus)
router.get('/candles', log, getCandles)
router.get('/quote', log, getQuote)

export const marketRoutes = router
