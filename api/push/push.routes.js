import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getConfig, list, subscribe, unsubscribe } from './push.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/config',           log, getConfig)
router.get('/subscriptions',    log, list)
router.post('/subscriptions',   log, subscribe)
// A DELETE with a body: the endpoint is a long opaque URL, not something to put in a path.
router.delete('/subscriptions', log, unsubscribe)

export const pushRoutes = router
