import express from 'express'

import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { generateSetup, hydrateBlueprint, validateDraft, listSetups, getSetup, patchSetup, deleteSetup, actOnSetup, disarmSetupEntry } from './setups.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/generate', log, generateSetup)
// Read-only despite the verb: a blueprint is a body, not an id, so it cannot be a GET. Nothing is
// written — it turns a portable plan into a draft the form can render. Above `/:id` so the literal
// segment is never swallowed by the id route.
router.post('/blueprint', log, hydrateBlueprint)
// The same gate the Generate button reads, asked on demand. Also read-only, also a body not an id.
router.post('/validate',  log, validateDraft)
router.get('/',          log, listSetups)
router.get('/:id',       log, getSetup)
router.post('/:id/action', log, actOnSetup)   // accept / dismiss Talos's in-position card
router.post('/:id/disarm', log, disarmSetupEntry)   // cancel a pending limit order
router.patch('/:id',     log, patchSetup)
router.delete('/:id',    log, deleteSetup)

export const setupsRoutes = router
