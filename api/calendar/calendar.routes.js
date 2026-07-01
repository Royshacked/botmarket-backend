import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getEarnings, getFed, getIpo } from './calendar.controller.js'

const router = express.Router()

router.use(requireAuth)
router.get('/earnings', log, getEarnings)
router.get('/fed',      log, getFed)
router.get('/ipo',      log, getIpo)

export const calendarRoutes = router
