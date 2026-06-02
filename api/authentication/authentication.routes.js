import { Router } from 'express'
import { signup, signin, signout, me } from './authentication.controller.js'
import { requireAuth } from '../../middleware/auth.middleware.js'

const router = Router()

router.post('/signup',  signup)
router.post('/signin',  signin)
router.post('/signout', signout)
router.get('/me',       requireAuth, me)

export const authRoutes = router
