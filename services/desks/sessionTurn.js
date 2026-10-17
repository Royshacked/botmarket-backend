// A desk turn run against the SESSION (unified-chat plan phase 4 §6.1 step 4).
//
// The same desk definition the HTTP stream uses (services/desks/<agent>.desk.js), with the two things
// the browser used to carry taken over by the server:
//   the conversation — built from the session for THIS agent only (context.buildConversation);
//   the working state — `agentState[agent]`, folded after the turn by the desk's own `nextState`.
//
//   append the user's message → build the agent's conversation → run the desk → append its reply →
//   store the next state → move the floor when the reply routes → fold old turns into the summary
//   (background, past the high-water mark).
//
// No HTTP here (plan E1): phase 5 puts the turn endpoint and the session channel on top of this, and
// `emit` is pointed at that channel. A turn the user stops keeps their message and stores no state.
//
// Built as a factory so the tests run it on memDb with a stub desk.

import { sessionService } from '../session.service.js'
import { agentContextService } from '../agentContext.service.js'
import { getExperienceLevel } from '../experience.service.js'
import { routeFields } from '../routing.util.js'
import { deskOf, entryOf } from './registry.js'
import { DESK_DEFS } from './index.js'
import { deskCommon } from './common.js'
import { buildConversation } from './context.js'
import { foldPlan, summarize as defaultSummarize } from './summarize.js'
import { logger } from '../logger.service.js'

const LOG = '[sessionTurn]'

/**
 * May this user run this agent in this session? An agent talks only in its own scope (the admin desks
 * keep their own panel and session — decision 16), and an admin desk only for an admin — the same gate
 * their HTTP routes keep.
 */
export function canSpeak(agent, session, user) {
    const d = deskOf(agent)
    if (!d) return false
    if (d.scope !== session.scope) return false
    if (d.admin && user?.role !== 'admin') return false
    return true
}

export function makeSessionTurn({
    sessions   = sessionService,
    contexts   = agentContextService,
    desks      = DESK_DEFS,
    experience = getExperienceLevel,
    summarize  = defaultSummarize,
} = {}) {

    async function maybeSummarize({ user, sessionId, agent, messages, summary }) {
        const plan = foldPlan(messages, agent, summary, deskOf(agent)?.maxMessages)
        if (!plan) return
        const text = await summarize({ userId: user._id, agent, prior: summary?.text ?? null, turns: plan.fold })
        // setSummary keeps only a NEWER summary, so a slow fold can never overwrite a later one or a seal's reset.
        if (text) await sessions.setSummary({ sessionId, userId: user._id, agent, summary: { text, throughSeq: plan.throughSeq } })
    }

    /**
     * A route landed: the agent its desk enters at takes the floor, starting in that route's mode. The
     * landing desk RESETS its mode to the route's (a desk's `onRouted`; without one, the preset is merged)
     * — so a `trade` preset never outlives the trade, and a later plain `scan` finds Argus listing again.
     * A route to a desk in another scope (an admin desk asked for from the main chat) moves nothing here:
     * that desk keeps its own panel.
     */
    async function land({ user, session, routing, agent, next }) {
        const entry = routing.route ? entryOf(routing.route) : null
        if (!entry || !canSpeak(entry.agent, session, user)) return agent
        const landing = desks[entry.agent]
        const theirs  = entry.agent === agent ? next : (session.agentState?.[entry.agent] ?? null)
        const state   = landing?.onRouted ? landing.onRouted(theirs, entry.state)
            : entry.state ? { ...(theirs ?? {}), ...entry.state } : undefined
        if (state !== undefined) await sessions.setAgentState({ sessionId: session.sessionId, userId: user._id, agent: entry.agent, state })
        return entry.agent
    }

    /**
     * @param {{ user: { _id: string, role?: string }, sessionId: string, agent: string, text?: string, origin?: 'user'|'chain',
     *           input?: object, emit?: Function, signal?: AbortSignal, model?: string }} p
     * @returns {Promise<{ reason: string } | { stopped: true } | { payload: object, reply: object|null }>}
     */
    return async function sessionTurn({ user, sessionId, agent, text, input = {}, origin = 'user', emit = () => {}, signal, model }) {
        const desk = desks[agent]
        if (!desk) return { reason: 'invalid_agent' }
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session || session.status !== 'active') return { reason: 'not_found' }
        if (!canSpeak(agent, session, user)) return { reason: 'forbidden' }

        // A chain turn has no user message: the hand-off the runner appended (addressed to this agent, in its
        // segment as a user turn) IS its prompt.
        if (origin !== 'chain') {
            const asked = await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'user', content: text } })
            if (asked.reason) return asked
        }

        const summary  = session.summaries?.[agent] ?? null
        // Only this agent's segment past its summary — never the whole timeline.
        const messages = await sessions.messagesForAgent({ sessionId, userId: user._id, agent, afterSeq: summary?.throughSeq ?? 0 })
        const state    = session.agentState?.[agent] ?? desk.emptyState?.() ?? null
        const editing  = state?.editing ?? null
        const sealed   = editing ? await contexts.load({ userId: user._id, kind: editing.kind, entityId: editing.entityId, agent }) : null

        const prepared = desk.prepareInput ? await desk.prepareInput(input) : input
        const common   = deskCommon({
            messages: buildConversation({ messages: messages ?? [], agent, summary, sealed }),
            model, user, audience: await experience(user._id).catch(() => null), signal, emit,
        })

        const result = await desk.run({ user, state, input: prepared, signal, emit, common })
        // Stopped: the user's message stays (it is theirs), and nothing the turn produced is kept.
        if (!result || signal?.aborted) return { stopped: true }

        const routing = routeFields(result, user.role)
        const payload = { ...desk.done(result, { routing }), ...routing }

        // A reply that was only tags (a card, a route) has no prose to keep — the state still moves.
        const replied = result.reply?.trim()
            ? await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'assistant', content: result.reply } })
            : null

        const next = desk.nextState ? desk.nextState(state, result, prepared) : state
        const kept = next ? { ...next, ...(editing ? { editing } : {}) } : null
        await sessions.setAgentState({ sessionId, userId: user._id, agent, state: kept })

        // The floor follows the reply: a route lands on its desk's entry agent; otherwise the agent that
        // answered keeps it. (Hand-offs and "@agent" join in phase 5.)
        const floor = await land({ user, session, routing, agent, next: kept })
        await sessions.setFloor({ sessionId, userId: user._id, agent: floor })

        // In the background, after the reply is out: fold the oldest turns into the summary when the
        // segment is past the high-water mark. A failure leaves everything as it was.
        const all = replied?.message ? [...(messages ?? []), replied.message] : (messages ?? [])
        maybeSummarize({ user, sessionId, agent, messages: all, summary })
            .catch(err => logger.warn(LOG, 'summary fold failed', err.message))

        return { payload, reply: replied?.message ?? null }
    }
}

export const sessionTurn = makeSessionTurn()
