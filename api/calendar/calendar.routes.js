import express from 'express'
import { log } from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getEarnings, getFed, getIpo, getCounts, getDay } from './calendar.controller.js'

const router = express.Router()

router.use(requireAuth)
router.get('/earnings', log, getEarnings)
router.get('/fed',      log, getFed)
router.get('/ipo',      log, getIpo)
router.get('/counts',   log, getCounts)   // ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/day/:date', log, getDay)

export const calendarRoutes = router
