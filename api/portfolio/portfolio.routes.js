import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { streamPortfolio } from './portfolio.controller.js'

const router = express.Router()

router.post('/stream', log, requireAuth, streamPortfolio)

export const portfolioRoutes = router
