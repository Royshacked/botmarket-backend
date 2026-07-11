import { Router } from 'express'
import { signup, signin, signout, me } from './authentication.controller.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { log } from '../../middleware/logger.middleware.js'

const router = Router()

router.post('/signup',  log, signup)
router.post('/signin',  log, signin)
router.post('/signout', log, signout)
router.get('/me',       requireAuth, log, me)

export const authRoutes = router
