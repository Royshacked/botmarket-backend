import { Router } from 'express'
import { list, getOne, create, update, remove, getTokenUsage } from './user.controller.js'
import { requireAuth } from '../../middleware/auth.middleware.js'

const router = Router()

router.use(requireAuth)

router.get('/',              list)
router.get('/:id',           getOne)
router.get('/:id/usage',     getTokenUsage)
router.post('/',             create)
router.patch('/:id',         update)
router.delete('/:id',        remove)

export const userRoutes = router
