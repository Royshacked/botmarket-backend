import express from 'express'
import { transcribeAudio } from './transcribe.controller.js'

const router = express.Router()

// Receive raw audio bytes — limit 25 MB
router.post('/', express.raw({ type: '*/*', limit: '25mb' }), transcribeAudio)

export const transcribeRoutes = router
