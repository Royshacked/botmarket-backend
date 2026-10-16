// HTTP handlers for the unified chat's sessions (docs/design/unified-chat.md §3.5, plan phase 3).
//
// Read-only plus "new session" in this phase: turns arrive through the session turn endpoint in
// phase 5. Every read is owner-scoped by the service; the admin desks' scopes ('strategy', 'aether')
// are refused to a trader here, the same gate their routes keep.

import { sessionService } from '../../services/session.service.js'
import { isScope, ADMIN_SCOPES } from '../../services/session.util.js'
import { makeHandle } from '../_shared/handle.util.js'
import { httpError }  from '../../services/httpError.util.js'

const handle = makeHandle('[sessions:controller]')

/** The scope a request asks for — 'main' when absent. Throws 400 / 403 for a bad or forbidden one. */
export function _scopeOf(req, raw) {
    const scope = raw == null || raw === '' ? 'main' : raw
    if (!isScope(scope)) throw httpError(400, 'invalid scope')
    if (ADMIN_SCOPES.includes(scope) && req.user?.role !== 'admin') throw httpError(403, 'admin only')
    return scope
}

export const getActiveSession = handle('getActiveSession', async (req, res) => {
    const scope = _scopeOf(req, req.query?.scope)
    res.json({ session: await sessionService.getActive({ userId: req.user._id, scope }) })
})

export const startNewSession = handle('startNewSession', async (req, res) => {
    const scope = _scopeOf(req, req.body?.scope)
    res.json({ session: await sessionService.startNew({ userId: req.user._id, scope }) })
})

export const listSessions = handle('listSessions', async (req, res) => {
    const scope = _scopeOf(req, req.query?.scope)
    res.json({ sessions: await sessionService.list({ userId: req.user._id, scope }) })
})

export const getSessionMessages = handle('getSessionMessages', async (req, res) => {
    const messages = await sessionService.messagesSince({
        sessionId: req.params.id,
        userId:    req.user._id,
        afterSeq:  req.query?.after,
        limit:     req.query?.limit,
    })
    if (!messages) throw httpError(404, 'Session not found')
    res.json({ messages })
})
