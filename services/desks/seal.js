// Sealing and editing (unified-chat.md §6.2, plan phase 4 §6.1 step 6).
//
// SEAL — when work ends in an entity, the agent's turns move OUT of the session onto that entity:
//   its segment since its last seal → agent_contexts (with its summary, when the summary covers those
//   turns); its own rows leave the timeline (hand-offs stay — they are the sender's turns too); one
//   `sealed` line takes their place ("Mentor built AMD setup", ref → the entity); the session links the
//   entity; the agent's working state and summary are cleared, and its seal point recorded. One
//   conversation that produced several entities at once (Generate all) seals the same turns onto each.
//   Nothing to seal → nothing happens (no line).
//
// EDIT — reopening an entity puts its desk's working state back from the document, marks it as editing
// (so the sealed context is read on every turn — context.buildConversation), shows a collapsed card line,
// and hands that agent the floor. The next seal on the entity APPENDS to the context it reopened. It is
// REFUSED while the agent holds other unsealed work — that work would be overwritten; the busy-agent rule
// (phase 5) asks the user first and passes `force` once they choose.

import { sessionService } from '../session.service.js'
import { agentContextService } from '../agentContext.service.js'
import { contextRole } from '../session.util.js'
import { deskOf, agentForKind } from './registry.js'
import { DESK_DEFS, hasWork } from './index.js'
import { withSessionLock } from './turnLock.js'
import { logger } from '../logger.service.js'

const LOG       = '[seal]'
const LABEL_MAX = 60
const VERB = { setup: 'built', scan: 'saved', coverage: 'wrote coverage on', portfolio: 'built', industry_view: 'published' }

const _cut = (s) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s)

export function makeSealing({ sessions = sessionService, contexts = agentContextService, desks = DESK_DEFS, lock = withSessionLock } = {}) {

    /**
     * Seal an agent's turns onto the entity (or entities) its work produced.
     * `onlyIfEditing`: an UPDATE path — seal only when the agent is editing exactly this entity, so saving
     * a document never sweeps up the agent's unrelated work in progress.
     * @param {{ userId: string, sessionId: string, agent: string, kind: string, entityIds: string[],
     *           name?: string, onlyIfEditing?: boolean }} p
     */
    async function sealFromSession({ userId, sessionId, agent, kind, entityIds, name = null, onlyIfEditing = false }) {
        const ids = (Array.isArray(entityIds) ? entityIds : []).filter(Boolean).map(String)
        if (!ids.length || !deskOf(agent)) return { reason: 'invalid_seal' }
        const session = await sessions.get({ sessionId, userId })
        if (!session || session.status !== 'active') return { reason: 'not_found' }
        const editing = session.agentState?.[agent]?.editing ?? null
        if (onlyIfEditing && !(editing?.kind === kind && ids.includes(String(editing.entityId)))) return { reason: 'not_editing' }

        const boundary = session.seals?.[agent] ?? 0
        const segment  = (await sessions.messagesForAgent({ sessionId, userId, agent, afterSeq: boundary })) ?? []
        const sum      = session.summaries?.[agent]
        // The summary goes with the turns only when it covers turns since this seal's boundary — an older
        // summary belongs to work already sealed elsewhere.
        const summary  = sum?.text && Number.isFinite(sum.throughSeq) && sum.throughSeq > boundary ? sum.text : null
        if (!segment.length && !summary) return { sealed: 0, turns: 0, line: null }

        const turns = segment.map(m => ({ role: contextRole(m, agent), content: m.content, at: m.at }))
        for (const entityId of ids) {
            await contexts.seal({ userId, kind, entityId, agent, messages: turns, summary, artifacts: [{ kind, id: entityId }] })
        }

        // The agent's OWN rows leave; hand-offs it received stay in the sender's segment.
        await sessions.removeMessages({ sessionId, userId, seqs: segment.filter(m => m.agent === agent).map(m => m.seq) })

        const brand = deskOf(agent).brand
        const label = _cut(name || `${ids.length > 1 ? `${ids.length} ` : ''}${kind.replace('_', ' ')}${ids.length > 1 ? 's' : ''}`)
        const line  = await sessions.append({ sessionId, userId, message: {
            agent, role: 'assistant', kind: 'sealed', content: `${brand} ${VERB[kind] ?? 'made'} ${label}`, ref: { kind, ids },
        } })
        for (const id of ids) await sessions.addLink({ sessionId, userId, link: { kind, id, agent } })
        await sessions.setAgentState({ sessionId, userId, agent, state: null })
        if (line?.message) {
            await sessions.setSealedThrough({ sessionId, userId, agent, seq: line.message.seq })
            await sessions.setSummary({ sessionId, userId, agent, summary: { text: '', throughSeq: line.message.seq } })
        }
        return { sealed: ids.length, turns: turns.length, line: line?.message ?? null }
    }

    /**
     * Reopen an entity for editing in the live session. The caller resolves the entity (owner-checked).
     * Refused (`busy`) while the agent holds OTHER unsealed work, unless `force` — the user chose to drop it.
     * @param {{ userId: string, sessionId: string, kind: string, entity: object, name?: string, force?: boolean }} p
     */
    async function openForEdit({ userId, sessionId, kind, entity, name = null, force = false }) {
        const agent = agentForKind(kind)
        const desk  = agent ? desks[agent] : null
        const entityId = entity?.id ? String(entity.id) : null
        if (!desk?.stateFromEntity || !entityId) return { reason: 'not_editable' }
        const session = await sessions.get({ sessionId, userId })
        if (!session || session.status !== 'active') return { reason: 'not_found' }

        const current = session.agentState?.[agent] ?? null
        const sameItem = current?.editing?.kind === kind && String(current.editing.entityId) === entityId
        // Busy only over REAL unsealed work (the desk's hasWork) — a state that is just mode or markers (Argus's
        // landing mode, Atlas's carried mandate) is nothing to lose.
        if (hasWork(agent, current) && !sameItem && !force) return { reason: 'busy', agent }

        const state   = desk.stateFromEntity(entity)
        const context = await contexts.load({ userId, kind, entityId, agent })
        await sessions.setAgentState({ sessionId, userId, agent, state: { ...state, editing: { kind, entityId } } })

        // The collapsed card: what this agent already knows about the item, before the user types.
        const brand = deskOf(agent).brand
        const last  = (context?.messages ?? []).slice(-3).map(m => `${m.role === 'user' ? 'You' : brand}: ${m.content}`)
        const card  = [`${brand} · ${_cut(name ?? `${kind.replace('_', ' ')} ${entityId}`)}`, context?.summary, ...last].filter(Boolean).join('\n')
        const line  = await sessions.append({ sessionId, userId, message: {
            agent, role: 'assistant', kind: 'sealed', content: card, ref: { kind, ids: [entityId], reopened: true },
        } })
        await sessions.setFloor({ sessionId, userId, agent })
        return { agent, line: line?.message ?? null, hasContext: !!context }
    }

    /**
     * The Generate endpoints' hook: seal when the request carries a sessionId — IN THE BACKGROUND, never
     * awaited by the response and never failing the save (the sealed line reaches the client through the
     * session channel, phase 5). Without a sessionId (today's frontend) it does nothing. Returns the promise
     * for tests.
     */
    function sealAfterGenerate(req, { kind, entityIds, name = null, onlyIfEditing = false }) {
        const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null
        if (!sessionId) return Promise.resolve(null)
        const agent = agentForKind(kind)
        // Under the session lock, like every turn: a seal reads the agent's rows and clears its state, and a turn
        // writing at the same moment would either lose its state to the seal or rewrite state for sealed work.
        return lock(sessionId, () => sealFromSession({ userId: req.user._id, sessionId, agent, kind, entityIds, name, onlyIfEditing }))
            .catch(err => { logger.warn(LOG, 'seal after generate failed (the entity is saved)', err.message); return null })
    }

    return { sealFromSession, openForEdit, sealAfterGenerate }
}

export const sealing = makeSealing()
