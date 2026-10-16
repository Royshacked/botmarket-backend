// Sealing and editing (unified-chat.md §6.2, plan phase 4 §6.1 step 6).
//
// SEAL — when work ends in an entity, the agent's turns move OUT of the session onto that entity:
//   its segment since its last seal → agent_contexts (with its summary); its own rows leave the timeline
//   (hand-offs stay — they are the sender's turns too); one `sealed` line takes their place ("Mentor
//   built AMD setup", ref → the entity); the session links the entity; the agent's working state and
//   summary are cleared. One conversation that produced several entities at once (Generate all) seals
//   the same turns onto each.
//
// EDIT — reopening an entity puts its desk's working state back from the document, marks it as editing
// (so the sealed context is read on every turn — context.buildConversation), shows a collapsed card line,
// and hands that agent the floor. The next seal on the entity APPENDS to the context it reopened.

import { sessionService } from '../session.service.js'
import { agentContextService } from '../agentContext.service.js'
import { segmentOf } from '../session.util.js'
import { deskOf, agentForKind } from './registry.js'
import { DESK_DEFS } from './index.js'
import { logger } from '../logger.service.js'

const LOG  = '[seal]'
const PAGE = 500

const VERB = { setup: 'built', scan: 'saved', coverage: 'wrote coverage on', portfolio: 'built', industry_view: 'published' }

export function makeSealing({ sessions = sessionService, contexts = agentContextService, desks = DESK_DEFS } = {}) {

    async function allMessages(sessionId, userId) {
        const out = []
        let after = 0
        for (;;) {
            const page = await sessions.messagesSince({ sessionId, userId, afterSeq: after, limit: PAGE })
            if (!page?.length) break
            out.push(...page)
            if (page.length < PAGE) break
            after = page.at(-1).seq
        }
        return out
    }

    /**
     * Seal an agent's turns onto the entity (or entities) its work produced.
     * @param {{ userId: string, sessionId: string, agent: string, kind: string, entityIds: string[], name?: string }} p
     */
    async function sealFromSession({ userId, sessionId, agent, kind, entityIds, name = null }) {
        const ids = (Array.isArray(entityIds) ? entityIds : []).filter(Boolean).map(String)
        if (!ids.length || !deskOf(agent)) return { reason: 'invalid_seal' }
        const session = await sessions.get({ sessionId, userId })
        if (!session || session.status !== 'active') return { reason: 'not_found' }

        const all = await allMessages(sessionId, userId)
        // Since this agent's last seal: its previous `sealed` line is the boundary.
        const boundary = all.filter(m => m.kind === 'sealed' && m.agent === agent).at(-1)?.seq ?? 0
        const segment  = segmentOf(all.filter(m => m.seq > boundary), agent)
        const turns    = segment.map(m => ({
            role: m.kind === 'handoff' && m.to === agent && m.agent !== agent ? 'user' : m.role,
            content: m.content, at: m.at,
        }))
        const summary = session.summaries?.[agent]?.text || null

        for (const entityId of ids) {
            await contexts.seal({ userId, kind, entityId, agent, messages: turns, summary, artifacts: [{ kind, id: entityId }] })
        }

        // The agent's OWN rows leave; hand-offs it received stay in the sender's segment.
        const own = segment.filter(m => m.agent === agent).map(m => m.seq)
        await sessions.removeMessages({ sessionId, userId, seqs: own })

        const brand = deskOf(agent).brand
        const label = name || `${ids.length > 1 ? `${ids.length} ` : ''}${kind.replace('_', ' ')}${ids.length > 1 ? 's' : ''}`
        const line  = await sessions.append({ sessionId, userId, message: {
            agent, role: 'assistant', kind: 'sealed', content: `${brand} ${VERB[kind] ?? 'made'} ${label}`,
            ref: { kind, ids },
        } })
        for (const id of ids) await sessions.addLink({ sessionId, userId, link: { kind, id, agent } })
        await sessions.setAgentState({ sessionId, userId, agent, state: null })
        if (line?.message) await sessions.setSummary({ sessionId, userId, agent, summary: { text: '', throughSeq: line.message.seq } })
        return { sealed: ids.length, turns: turns.length, line: line?.message ?? null }
    }

    /**
     * Reopen an entity for editing in the live session. The caller resolves the entity (owner-checked).
     * @param {{ userId: string, sessionId: string, kind: string, entity: object, name?: string }} p
     */
    async function openForEdit({ userId, sessionId, kind, entity, name = null }) {
        const agent = agentForKind(kind)
        const desk  = agent ? desks[agent] : null
        const entityId = entity?.id ? String(entity.id) : null
        if (!desk?.stateFromEntity || !entityId) return { reason: 'not_editable' }
        const session = await sessions.get({ sessionId, userId })
        if (!session || session.status !== 'active') return { reason: 'not_found' }

        const state   = desk.stateFromEntity(entity)
        const context = await contexts.load({ userId, kind, entityId, agent })
        await sessions.setAgentState({ sessionId, userId, agent, state: { ...state, editing: { kind, entityId } } })

        // The collapsed card: what this agent already knows about the item, before the user types.
        const last  = (context?.messages ?? []).slice(-3).map(m => `${m.role === 'user' ? 'You' : deskOf(agent).brand}: ${m.content}`)
        const card  = [`${deskOf(agent).brand} · ${name ?? `${kind.replace('_', ' ')} ${entityId}`}`, context?.summary, ...last].filter(Boolean).join('\n')
        const line  = await sessions.append({ sessionId, userId, message: {
            agent, role: 'assistant', kind: 'sealed', content: card, ref: { kind, ids: [entityId], reopened: true },
        } })
        await sessions.setFloor({ sessionId, userId, agent })
        return { agent, line: line?.message ?? null, hasContext: !!context }
    }

    /**
     * The Generate endpoints' hook: seal when the request carries a sessionId, never fail the Generate.
     * Without a sessionId (today's frontend) it does nothing.
     */
    function sealAfterGenerate(req, { kind, entityIds, name = null }) {
        const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null
        if (!sessionId) return Promise.resolve(null)
        const agent = agentForKind(kind)
        return sealFromSession({ userId: req.user._id, sessionId, agent, kind, entityIds, name })
            .catch(err => { logger.warn(LOG, 'seal after generate failed (the entity is saved)', err.message); return null })
    }

    return { sealFromSession, openForEdit, sealAfterGenerate }
}

export const sealing = makeSealing()
