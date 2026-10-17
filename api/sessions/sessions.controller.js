// HTTP handlers for the unified chat's sessions (docs/design/unified-chat.md §3.5, plan phase 3).
//
// Read-only plus "new session" in this phase: turns arrive through the session turn endpoint in
// phase 5. Every read is owner-scoped by the service; the admin desks' scopes ('strategy', 'aether')
// are refused to a trader here, the same gate their routes keep.

import { sessionService } from '../../services/session.service.js'
import { isScope, ADMIN_SCOPES } from '../../services/session.util.js'
import { AGENT_KEYS } from '../../services/desks/registry.js'
import { startTurn, chain } from '../../services/desks/turns.js'
import { lookupForEdit } from '../../services/desks/entityLookup.js'
import { sealing } from '../../services/desks/seal.js'
import { withSessionLock } from '../../services/desks/turnLock.js'
import { hydrateCards } from '../../services/sessionCards.js'
import { parseIdeaAccounts, parseClientTime } from '../_shared/parse.util.js'
import { makeHandle } from '../_shared/handle.util.js'
import { httpError }  from '../../services/httpError.util.js'
import { sendReason } from '../_shared/reason.util.js'

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

// The reasons only these routes answer; `not_found` / `forbidden` ride the shared table (reason.util).
const TURN_REASONS = { empty: [400, 'text is required'] }
const EDIT_REASONS = {
    not_editable: [400, 'That item is not editable here'],
    // The agent holds other unsealed work — the client asks the user, then repeats with `force`.
    busy:         [409, 'That desk is in the middle of something else'],
    wrong_scope:  [409, 'That item opens in another chat'],
}

// A turn: accepted at once (202), run queued, streamed on the session channel (plan phase 5b, G2).
// `input` is the desk's per-turn extras (a card press's ops, a seed, the marked accounts, the clock).
export const postSessionTurn = handle('postSessionTurn', async (req, res) => {
    const { text, agent = null, turnId = null, ops, seed, accounts, mainAccountId, clientTime, brief } = req.body ?? {}
    if (agent != null && !AGENT_KEYS.includes(agent)) throw httpError(400, 'invalid agent')
    const input = {
        ...(Array.isArray(ops) ? { ops } : {}),
        ...(seed && typeof seed === 'object' ? { seed } : {}),
        // Today's market brief, asked of Axl (plan phase 7, J4) — only Axl's desk reads it.
        ...(brief === true ? { brief: true } : {}),
        accounts: parseIdeaAccounts(accounts),
        mainAccountId: mainAccountId != null ? String(mainAccountId) : null,
        clientTime: parseClientTime({ clientNow: clientTime?.clientNow, clientTz: clientTime?.clientTz }),
    }
    // Today's brief is Axl's to give, whoever holds the floor.
    const out = await startTurn({ user: req.user, sessionId: req.params.id, text, agent: input.brief ? 'axl' : agent, input, turnId })
    if (out.reason) return sendReason(res, out.reason, { overrides: TURN_REASONS, fallback: 404 })
    res.status(202).json(out)
})

// Reopen an entity for editing in the live session: its desk's state from the document, the sealed
// context, a card line, the floor. `busy` (the agent holds other unsealed work) answers 409 with the
// agent, so the client can ask the user and repeat with `force`.
export const editInSession = handle('editInSession', async (req, res) => {
    const { kind, id, name = null, force = false } = req.body ?? {}
    const found = await lookupForEdit({ kind, id, user: req.user })
    if (!found.ok) return sendReason(res, found.reason, { overrides: EDIT_REASONS, fallback: 404 })
    // Under the session lock, like every turn: it writes the agent's state, a card line and the floor.
    const out = await withSessionLock(req.params.id, () => sealing.openForEdit({ userId: req.user._id, sessionId: req.params.id, kind, entity: found.doc, name, force: force === true }))
    if (out.reason) return sendReason(res, out.reason, { overrides: EDIT_REASONS, fallback: 404, extra: out.agent ? { agent: out.agent } : null })
    res.json(out)
})

// A tap on a decision the chain is waiting on (plan phase 5c): continue a paused or interrupted chain, keep
// going past the step cap, research a list, the next name in a queue, finish / set aside for a busy agent.
const CONTINUE_REASONS = {
    no_such_choice:      [409, 'That choice is not open right now'],
    nothing_to_research: [409, 'There is no list to research'],
}
export const continueSession = handle('continueSession', async (req, res) => {
    const choice = typeof req.body?.choice === 'string' ? req.body.choice : null
    if (!choice) throw httpError(400, 'choice is required')
    const out = await chain.resume({ user: req.user, sessionId: req.params.id, choice })
    if (out.reason) return sendReason(res, out.reason, { overrides: CONTINUE_REASONS, fallback: 404 })
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
    res.json({ messages: await hydrateCards(messages) })
})
