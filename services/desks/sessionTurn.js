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
import { deskOf, entryOf, handBackOf } from './registry.js'
import { DESK_DEFS } from './index.js'
import { deskCommon } from './common.js'
import { buildConversation } from './context.js'
import { foldPlan, summarize as defaultSummarize } from './summarize.js'
import { logger } from '../logger.service.js'
import { keepMarkers } from './markers.js'

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

const MAX_TAP_OPTIONS = 6

/**
 * What a reply offered beside its prose, kept on its row (plan phase 7, J2): the tap options, the chart, the
 * "show me" offer — each only when present; null when there is none. Exported for tests.
 */
export function replyExtras(payload) {
    const out = {}
    const taps = Array.isArray(payload?.suggestions) ? payload.suggestions.filter(s => typeof s === 'string' && s.trim()) : []
    if (taps.length) out.suggestions = taps.slice(0, MAX_TAP_OPTIONS)
    if (payload?.chart) out.chart = payload.chart
    if (payload?.show) out.show = payload.show
    return Object.keys(out).length ? out : null
}

/**
 * A reply that was ONLY a `<show>` still offers its button, so it gets a row — one plain line saying what it
 * offers (the agent's memory then knows it offered it, too). Null when there is no show. Exported for tests.
 */
export function showLine(show) {
    if (!show?.kind) return null
    if (show.kind === 'ticket') return show.ref ? `Here's the order ticket for ${show.ref}.` : "Here's the order ticket."
    return 'Here it is.'
}

/**
 * A desk Axl hands the user to always speaks first (Roy, 2026-10-19). A route from Axl with no `<open>` used to land
 * the desk silent — "Mentor will take it from here", then nothing until the user typed. The user's own words become
 * the opening instead: the desk reads them exactly as if they had been typed there. Axl only — a desk's own route
 * is answered with "yes" as often as not, which is no opening for anyone. Exported for tests.
 */
export function ownWords(routing, agent, text) {
    const words = typeof text === 'string' ? text.trim() : ''
    if (agent !== 'axl' || !routing?.route || routing.opening || !words) return routing
    return { ...routing, opening: words }
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
    async function land({ user, session, routing, agent, next, hints = null }) {
        const entry = routing.route ? entryOf(routing.route) : null
        if (!entry || !canSpeak(entry.agent, session, user)) return agent
        const landing = desks[entry.agent]
        const theirs  = entry.agent === agent ? next : (session.agentState?.[entry.agent] ?? null)
        // `hints`: what the routing desk knows about the landing (Axl's adopt — the user already owns this book).
        // A sender that wants the result back presets the landing's mode too (Mentor → Argus: find ONE name).
        const back    = handBackOf(agent, entry.agent)
        const preset  = (hints || back) ? { ...(entry.state ?? {}), ...(back ?? {}), ...(hints ?? {}) } : entry.state
        const state   = landing?.onRouted ? landing.onRouted(theirs, preset)
            : entry.state ? { ...(theirs ?? {}), ...entry.state } : undefined
        if (state !== undefined) await sessions.setAgentState({ sessionId: session.sessionId, userId: user._id, agent: entry.agent, state })
        return entry.agent
    }

    /**
     * @param {{ user: { _id: string, role?: string }, sessionId: string, agent: string, text?: string, origin?: 'user'|'chain'|'opening',
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

        const result = await desk.run({ user, state, input: prepared, signal, emit, common, sessionId })
        // Stopped: the user's message stays (it is theirs), and nothing the turn produced is kept.
        if (!result || signal?.aborted) return { stopped: true }

        const routing = ownWords(routeFields(result, user.role), agent, text)
        const payload = { ...desk.done(result, { routing }), ...routing }

        // A reply that was only tags (a card, a route) has no prose to keep — the state still moves. One with
        // prose keeps what it offered beside it (its tap options, chart, "show me"), so a reload still has them.
        const extras  = replyExtras(payload)
        const prose   = result.reply?.trim() ? result.reply : showLine(extras?.show)
        const replied = prose
            ? await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'assistant', content: prose, ref: extras } })
            : null

        const next = desk.nextState ? desk.nextState(state, result, prepared) : state
        // The markers the desk's own fold knows nothing about survive it: what it is editing, and which chain
        // it is working for (the busy rule reads that).
        const kept = keepMarkers(next, state)
        await sessions.setAgentState({ sessionId, userId: user._id, agent, state: kept })

        // The floor follows the reply: a route lands on its desk's entry agent; otherwise the agent that
        // answered keeps it. (Hand-offs and "@agent" join in phase 5.)
        const floor = await land({ user, session, routing, agent, next: kept, hints: payload.adopt === true ? { adopt: true } : null })
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
