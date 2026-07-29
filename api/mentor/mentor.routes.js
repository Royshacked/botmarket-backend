import express from 'express'

import { log }          from '../../middleware/logger.middleware.js'
import { requireAuth }  from '../../middleware/auth.middleware.js'
import { streamMentor } from './mentor.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/stream', log, streamMentor)

export const mentorRoutes = router
