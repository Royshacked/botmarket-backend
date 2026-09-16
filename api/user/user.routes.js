import { Router } from 'express'
import { list, getOne, create, update, remove, getTokenUsage, getPreferences, updatePreferences } from './user.controller.js'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js'

const router = Router()

router.use(requireAuth)

// TWO AUDIENCES on one router. A trader reaches their OWN usage and preferences (the controller
// checks ownership, and lets an admin through). The accounts themselves — who exists, who is
// created, renamed, deleted — are the admin's. Until 2026-09-16 every route here sat behind
// requireAuth alone, so any signed-in trader could list every account with its role and budget,
// create one, rename anyone, or delete the admin. Nothing in the client called the five admin
// moves; the door was simply open, and two model headers cited it as a reason to keep data off
// the user document.
router.get('/:id/usage',         getTokenUsage)
router.get('/:id/preferences',   getPreferences)
router.put('/:id/preferences',   updatePreferences)

router.get('/',                  requireAdmin, list)
router.get('/:id',               requireAdmin, getOne)
router.post('/',                 requireAdmin, create)
router.patch('/:id',             requireAdmin, update)
router.delete('/:id',            requireAdmin, remove)

export const userRoutes = router
