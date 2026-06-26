import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    listConversations,
    listMessages,
    postMessage,
    markConversationRead,
    searchUsersHandler,
    startConversation,
} from './chat.controller.js'

const router = express.Router()

router.use(requireAuth)

router.get('/conversations',                     log, listConversations)
router.post('/conversations',                    log, startConversation)
router.get('/conversations/:id/messages',        log, listMessages)
router.post('/conversations/:id/messages',       log, postMessage)
router.post('/conversations/:id/read',           log, markConversationRead)
router.get('/users/search',                      log, searchUsersHandler)

export const chatRoutes = router
