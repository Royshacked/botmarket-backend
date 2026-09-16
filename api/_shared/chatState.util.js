// Shared get/delete chat-state Express handlers. Both the scanner and portfolio
// chat controllers expose the same get/delete shape over their chat service; they
// differ only in the key (scanner: userId only; portfolio: portfolioId + userId
// from req.params). The save handlers stay per-controller because their bodies
// diverge (portfolio persists mandate + thesis).
//
// `service`      — the chat service ({ getChatState, deleteChatState, ... }).
// `keyArgs(req)` — returns the argument array passed to the service methods.
// `log`          — the controller's log tag, so a failure still reads as the caller's.
// `requireKey(req)` (delete only, optional) — returns an error string when a
//                  required key is missing (portfolio guards a missing portfolioId).

import { makeHandle } from './handle.util.js'
import { httpError }  from '../../services/httpError.util.js'

export function makeGetChatState({ service, keyArgs, log }) {
    return makeHandle(log)('getChatState', async (req, res) => {
        const chatState = await service.getChatState(...keyArgs(req))
        res.json({ chatState: chatState ?? null })
    })
}

export function makeDeleteChatState({ service, keyArgs, log, requireKey = null }) {
    return makeHandle(log)('deleteChatState', async (req, res) => {
        const missing = requireKey?.(req)
        if (missing) throw httpError(400, missing)
        await service.deleteChatState(...keyArgs(req))
        res.json({ ok: true })
    })
}
