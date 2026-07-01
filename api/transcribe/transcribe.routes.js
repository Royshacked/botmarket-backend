import express from 'express'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { transcribeAudio } from './transcribe.controller.js'

const router = express.Router()

// Receive raw audio bytes — limit 25 MB. Authed only: this proxies to a paid
// speech-to-text API, so leaving it open is a cost/abuse vector.
router.post('/', requireAuth, express.raw({ type: '*/*', limit: '25mb' }), transcribeAudio)

export const transcribeRoutes = router
