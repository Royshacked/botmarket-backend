// HTTP handlers for the unified chat's sessions (docs/design/unified-chat.md §3.5, plan phase 3).
//
// Read-only plus "new session" in this phase: turns arrive through the session turn endpoint in
// phase 5. Every read is owner-scoped by the service; the admin desks' scopes ('strategy', 'aether')
// are refused to a trader here, the same gate their routes keep.

import { sessionService } from '../../services/session.service.js'
import { isScope, ADMIN_SCOPES } from '../../services/session.util.js'
import { AGENT_KEYS } from '../../services/desks/registry.js'
import { startTurn } from '../../services/desks/startTurn.js'
import { lookupForEdit } from '../../services/desks/entityLookup.js'
import { sealing } from '../../services/desks/seal.js'
import { parseIdeaAccounts, parseClientTime } from '../_shared/parse.util.js'
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

// A turn: accepted at once (202), run queued, streamed on the session channel (plan phase 5b, G2).
// `input` is the desk's per-turn extras (a card press's ops, a seed, the marked accounts, the clock).
export const postSessionTurn = handle('postSessionTurn', async (req, res) => {
    const { text, agent = null, turnId = null, ops, seed, accounts, mainAccountId, clientTime } = req.body ?? {}
    if (agent != null && !AGENT_KEYS.includes(agent)) throw httpError(400, 'invalid agent')
    const input = {
        ...(Array.isArray(ops) ? { ops } : {}),
        ...(seed && typeof seed === 'object' ? { seed } : {}),
        accounts: parseIdeaAccounts(accounts),
        mainAccountId: mainAccountId != null ? String(mainAccountId) : null,
        clientTime: parseClientTime({ clientNow: clientTime?.clientNow, clientTz: clientTime?.clientTz }),
    }
    const out = await startTurn({ user: req.user, sessionId: req.params.id, text, agent, input, turnId })
    if (out.reason === 'empty')     throw httpError(400, 'text is required')
    if (out.reason === 'forbidden') throw httpError(403, 'that desk is not open to you here')
    if (out.reason)                 throw httpError(404, 'Session not found')
    res.status(202).json(out)
})

// Reopen an entity for editing in the live session: its desk's state from the document, the sealed
// context, a card line, the floor. `busy` (the agent holds other unsealed work) answers 409 with the
// agent, so the client can ask the user and repeat with `force`.
export const editInSession = handle('editInSession', async (req, res) => {
    const { kind, id, name = null, force = false } = req.body ?? {}
    const found = await lookupForEdit({ kind, id, user: req.user })
    if (!found.ok) {
        if (found.reason === 'forbidden')    throw httpError(403, 'admin only')
        if (found.reason === 'not_editable') throw httpError(400, 'not editable')
        throw httpError(404, 'Not found')
    }
    const out = await sealing.openForEdit({ userId: req.user._id, sessionId: req.params.id, kind, entity: found.doc, name, force: force === true })
    if (out.reason === 'busy') return res.status(409).json({ reason: 'busy', agent: out.agent })
    if (out.reason)            throw httpError(404, 'Session not found')
    res.json(out)
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
