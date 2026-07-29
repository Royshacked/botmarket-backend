import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { generateSetup, listSetups, getSetup, patchSetup, deleteSetup } from './setups.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/generate', log, generateSetup)
router.get('/',          log, listSetups)
router.get('/:id',       log, getSetup)
router.patch('/:id',     log, patchSetup)
router.delete('/:id',    log, deleteSetup)

export const setupsRoutes = router
