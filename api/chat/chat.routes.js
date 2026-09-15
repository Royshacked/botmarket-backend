import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    listConversations,
    listMessages,
    postMessage,
    markConversationRead,
    resolveMessageHandler,
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
// ONE resolution route. A second — POST …/:msgId/dismiss — stood beside it from before the card
// lifecycle was unified, and nothing called it: the client posts here with status 'dismissed', and
// even its own dismissMessage helper was an alias that did. Removed in §5 with its handler and the
// service alias behind it.
router.post('/conversations/:id/messages/:msgId/resolve', log, resolveMessageHandler)
router.get('/users/search',                      log, searchUsersHandler)

export const chatRoutes = router
