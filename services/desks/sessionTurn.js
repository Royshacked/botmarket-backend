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

const LOG  = '[sessionTurn]'
const PAGE = 500

export function makeSessionTurn({
    sessions   = sessionService,
    contexts   = agentContextService,
    desks      = DESK_DEFS,
    experience = getExperienceLevel,
    summarize  = defaultSummarize,
} = {}) {

    // Every message after `afterSeq`, across pages — an agent's segment can sit behind other agents' rows.
    async function allSince(sessionId, userId, afterSeq) {
        const out = []
        let after = afterSeq
        for (;;) {
            const page = await sessions.messagesSince({ sessionId, userId, afterSeq: after, limit: PAGE })
            if (!page?.length) break
            out.push(...page)
            if (page.length < PAGE) break
            after = page.at(-1).seq
        }
        return out
    }

    async function maybeSummarize({ user, sessionId, agent, messages, summary }) {
        const plan = foldPlan(messages, agent, summary, deskOf(agent)?.maxMessages)
        if (!plan) return
        const text = await summarize({ userId: user._id, agent, prior: summary?.text ?? null, turns: plan.fold })
        if (text) await sessions.setSummary({ sessionId, userId: user._id, agent, summary: { text, throughSeq: plan.throughSeq } })
    }

    /**
     * @param {{ user: { _id: string, role?: string }, sessionId: string, agent: string, text: string,
     *           input?: object, emit?: Function, signal?: AbortSignal, model?: string }} p
     * @returns {Promise<{ reason: string } | { stopped: true } | { payload: object, reply: object|null }>}
     */
    return async function sessionTurn({ user, sessionId, agent, text, input = {}, emit = () => {}, signal, model }) {
        const desk = desks[agent]
        if (!desk) return { reason: 'invalid_agent' }
        const session = await sessions.get({ sessionId, userId: user._id })
        if (!session || session.status !== 'active') return { reason: 'not_found' }

        const asked = await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'user', content: text } })
        if (asked.reason) return asked

        const summary  = session.summaries?.[agent] ?? null
        const messages = await allSince(sessionId, user._id, summary?.throughSeq ?? 0)
        const state    = session.agentState?.[agent] ?? desk.emptyState?.() ?? null
        const editing  = state?.editing ?? null
        const sealed   = editing ? await contexts.load({ userId: user._id, kind: editing.kind, entityId: editing.entityId, agent }) : null

        const ac       = signal ? null : new AbortController()
        const sig      = signal ?? ac.signal
        const prepared = desk.prepareInput ? await desk.prepareInput(input) : input
        const common   = deskCommon({
            messages: buildConversation({ messages, agent, summary, sealed }),
            model, user, audience: await experience(user._id).catch(() => null), signal: sig, emit,
        })

        const result = await desk.run({ user, state, input: prepared, signal: sig, emit, common })
        // Stopped: the user's message stays (it is theirs), and nothing the turn produced is kept.
        if (!result || sig.aborted) return { stopped: true }

        const routing = routeFields(result, user.role)
        const payload = { ...desk.done(result, { routing }), ...routing }

        // A reply that was only tags (a card, a route) has no prose to keep — the state still moves.
        const replied = result.reply?.trim()
            ? await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'assistant', content: result.reply } })
            : null

        const next = desk.nextState ? desk.nextState(state, result, prepared) : state
        await sessions.setAgentState({
            sessionId, userId: user._id, agent,
            state: next ? { ...next, ...(editing ? { editing } : {}) } : null,
        })

        // The floor follows the reply: a route hands the next message to the agent that desk ENTERS at —
        // for a composite (`trade`), Argus in single-pick mode, its mode preset on its working state;
        // otherwise the agent that answered keeps it. (Hand-offs and "@agent" join in phase 5.)
        const entry = routing.route ? entryOf(routing.route) : null
        if (entry?.state) {
            const theirs = entry.agent === agent ? next : (session.agentState?.[entry.agent] ?? null)
            await sessions.setAgentState({ sessionId, userId: user._id, agent: entry.agent, state: { ...(theirs ?? {}), ...entry.state } })
        }
        await sessions.setFloor({ sessionId, userId: user._id, agent: entry?.agent ?? agent })

        // In the background, after the reply is out: fold the oldest turns into the summary when the
        // segment is past the high-water mark. A failure leaves everything as it was.
        const all = replied?.message ? [...messages, replied.message] : messages
        maybeSummarize({ user, sessionId, agent, messages: all, summary })
            .catch(err => logger.warn(LOG, 'summary fold failed', err.message))

        return { payload, reply: replied?.message ?? null }
    }
}

export const sessionTurn = makeSessionTurn()
