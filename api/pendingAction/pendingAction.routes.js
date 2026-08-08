import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { getPendingActions, executePendingAction, cancelPendingAction } from './pendingAction.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/',             log, getPendingActions)
router.post('/:id/execute', log, executePendingAction)
router.post('/:id/cancel',  log, cancelPendingAction)

export const pendingActionRoutes = router
