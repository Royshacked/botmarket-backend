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
import { deskAct } from '../../services/desks/act.js'
import { DESK_DEFS } from '../../services/desks/index.js'
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

// With the agents' working state (plan phase 8, K4): the drawer's surfaces paint from it before the socket's
// replay arrives. The list stays header-only.
export const getActiveSession = handle('getActiveSession', async (req, res) => {
    const scope   = _scopeOf(req, req.query?.scope)
    const active  = await sessionService.getActive({ userId: req.user._id, scope })
    const session = active ? await sessionService.get({ sessionId: active.sessionId, userId: req.user._id }) : null
    res.json({ session: session ?? active })
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
    const { text, agent = null, turnId = null, ops, seed, accounts, mainAccountId, clientTime, brief, radarBoard } = req.body ?? {}
    if (agent != null && !AGENT_KEYS.includes(agent)) throw httpError(400, 'invalid agent')
    const input = {
        ...(Array.isArray(ops) ? { ops } : {}),
        ...(seed && typeof seed === 'object' ? { seed } : {}),
        // Today's market brief, asked of Axl (plan phase 7, J4) — only Axl's desk reads it.
        ...(brief === true ? { brief: true } : {}),
        // The Floor's radar board for Argus's cut — shape-checked and capped by the scanner desk (prepareInput).
        ...(radarBoard && typeof radarBoard === 'object' ? { radarBoard } : {}),
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
    const { kind, id, name = null, force = false, reviewMode = false } = req.body ?? {}
    const found = await lookupForEdit({ kind, id, user: req.user })
    if (!found.ok) return sendReason(res, found.reason, { overrides: EDIT_REASONS, fallback: 404 })
    // Under the session lock, like every turn: it writes the agent's state, a card line and the floor.
    const out = await withSessionLock(req.params.id, () => sealing.openForEdit({ userId: req.user._id, sessionId: req.params.id, kind, entity: found.doc, name, force: force === true, opts: { reviewMode: reviewMode === true } }))
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

// A desk's commit (plan phase 8, K2): the draft comes from the session, the meaning from the desk. The session's own
// refusals come first — they mean the same on every desk — then the desk's words (Mentor → the setup routes' table).
const ACT_REASONS = {
    no_such_action:    [400, 'That is not something this desk does'],
    nothing_to_commit: [409, 'There is nothing to save yet'],
    nothing_to_edit:   [409, 'There is nothing to change yet'],
    nothing_saved:     [409, 'Nothing could be saved — see failed'],
    not_new:           [409, 'This is already saved — update it instead'],
    too_many:          [400, 'Too many to save in one press'],
    invalid_edit:      [400, 'That change is not valid'],
    not_editable:      [400, 'Nothing here is edited by hand'],
    // Discard is for unsaved work — a saved item being edited is left with Later (phase 8e CR).
    editing_use_later: [409, 'This is a saved item being edited — leave it with Later'],
    // Pressed on a state a turn has since replaced (plan phase 8a CR D2) — the client redraws, then asks again.
    stale_state:       [409, 'That changed while you were looking — check it and try again'],
    // A desk action that answered nothing is the server's bug, not the client's request.
    action_failed:     [500, 'That did not go through'],
}

/** A reason's [status, message] for this agent's presses: the session's table, then the desk's (a table or a lookup). */
export function _reasonsFor(agent) {
    const own = DESK_DEFS[agent]?.reasons
    return (reason) => ACT_REASONS[reason]
        ?? (typeof own === 'function' ? own(reason) : own?.[reason])
        ?? null
}

export const actInSession = handle('actInSession', async (req, res) => {
    const { agent, action, args, rev } = req.body ?? {}
    if (!AGENT_KEYS.includes(agent)) throw httpError(400, 'invalid agent')
    const out = await deskAct.act({ user: req.user, sessionId: req.params.id, agent, action, args, rev })
    if (out.reason) return sendReason(res, out.reason, { overrides: _reasonsFor(agent), fallback: 400, extra: out.extra ?? null })
    // `rev` is what the next press names. Saved but the state not written (`stateWritten: false`): the client refetches
    // rather than trusting what it holds.
    res.json({ ...out.result, rev: out.rev, ...(out.stateWritten === false ? { stateWritten: false } : {}) })
})

// A direct edit (plan phase 8, K3): validated by the desk, written to its state, pushed on the channel.
export const editSessionState = handle('editSessionState', async (req, res) => {
    const { agent, edit, rev } = req.body ?? {}
    if (!AGENT_KEYS.includes(agent)) throw httpError(400, 'invalid agent')
    const out = await deskAct.editState({ user: req.user, sessionId: req.params.id, agent, edit, rev })
    if (out.reason) return sendReason(res, out.reason, { overrides: _reasonsFor(agent), fallback: 400, extra: out.extra ?? null })
    res.json({ ok: true, rev: out.rev })
})

// History's resume (Roy, 2026-10-19): an archived session becomes the live one; the live one is put away.
export const resumeSession = handle('resumeSession', async (req, res) => {
    const out = await sessionService.resume({ sessionId: req.params.id, userId: req.user._id })
    if (out.reason) return sendReason(res, out.reason)
    res.json({ session: out.session })
})

// History's delete (Roy, 2026-10-18): an ARCHIVED session and its rows. The live one ends with "New session".
export const deleteSession = handle('deleteSession', async (req, res) => {
    const out = await sessionService.remove({ sessionId: req.params.id, userId: req.user._id })
    if (out.reason) {
        return sendReason(res, out.reason, { overrides: { active_session: [409, 'This is the live session — start a new one to put it away'] } })
    }
    res.json({ ok: true })
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
