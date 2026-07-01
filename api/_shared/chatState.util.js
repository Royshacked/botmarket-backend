// Shared get/delete chat-state Express handlers. Both the scanner and portfolio
// chat controllers expose the same get/delete shape over their chat service; they
// differ only in the key (scanner: userId only; portfolio: portfolioId + userId
// from req.params). The save handlers stay per-controller because their bodies
// diverge (portfolio persists mandate + thesis).
//
// `service`      — the chat service ({ getChatState, deleteChatState, ... }).
// `keyArgs(req)` — returns the argument array passed to the service methods.
// `logger`/`log` — logger + tag for the failure line.
// `failMsg`      — exact log message prefix (so each controller keeps its wording).
// `requireKey(req)` (delete only, optional) — returns an error string when a
//                  required key is missing (portfolio guards a missing portfolioId).

export function makeGetChatState({ service, keyArgs, logger, log, failMsg = 'getChatState failed' }) {
    return async function getChatState(req, res) {
        try {
            const chatState = await service.getChatState(...keyArgs(req))
            res.json({ chatState: chatState ?? null })
        } catch (err) {
            logger.error(log, failMsg, err)
            res.status(500).json({ error: 'Failed to get chat state' })
        }
    }
}

export function makeDeleteChatState({ service, keyArgs, logger, log, failMsg = 'deleteChatState failed', requireKey = null }) {
    return async function deleteChatState(req, res) {
        try {
            if (requireKey) {
                const missing = requireKey(req)
                if (missing) return res.status(400).json({ error: missing })
            }
            await service.deleteChatState(...keyArgs(req))
            res.json({ ok: true })
        } catch (err) {
            logger.error(log, failMsg, err)
            res.status(500).json({ error: 'Failed to delete chat state' })
        }
    }
}
