import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getEarnings, getFda } from './calendar.controller.js'

const router = express.Router()

router.use(requireAuth)
router.get('/earnings', log, getEarnings)
router.get('/fda',      log, getFda)

export const calendarRoutes = router
