// Axl's SUBAGENTS (docs/design/modes-and-builders.md §3, Roy 2026-11-20) — the roles that answer, called as a tool.
//
// Before: Axl ROUTED to the event analyst, who then held the floor — "show me the hotlist" went to it too, and it saw
// only its own segment (a bare "ANT" read as Ant Group). Now Axl calls `ask_specialist`: the role runs its own desk —
// its prompt, its tools, its earlier exchanges in this session — inside Axl's turn, and its reply is kept as ITS row in its
// segment. Since 2026-11-21 (axl-one-voice.md §5) that row is Axl's hidden MATERIAL: Axl writes the answer. The floor
// never moves; the next message is Axl's.
//
//   append the question to the role's segment (hidden: an opening) → run the role's desk headless → append its reply
//   (`ref.via: 'axl'`, so Axl's own next turn reads it too) → hand Axl the reply as the tool result.
//
// A role's routes do not move anyone: a hand-back ("not mine") or an offer to take the user to a builder comes back to
// Axl as words in the tool result, and Axl decides. Built as a factory so the tests run it on memDb with a stub desk.

import { sessionService } from '../session.service.js'
import { toolError } from '../toolResult.util.js'
import { logger } from '../logger.service.js'
import { DESK_DEFS } from './index.js'
import { DESKS, SUBAGENTS, RECEPTION } from './registry.js'
import { deskCommon } from './common.js'
import { buildConversation } from './context.js'
import { chartLine } from './chartLine.js'

const LOG = '[subagent]'
const MAX_QUESTION = 2000
const MAX_CONTEXT = 4000
const MAX_COMPANIES = 12

/**
 * The question as the role reads it: the user's ask, written to stand alone, the companies by name, what Axl already
 * found. Pure; exported for tests.
 */
export function composeQuestion({ question, companies = [], context = '' }) {
    const q = String(question ?? '').trim().slice(0, MAX_QUESTION)
    const named = (Array.isArray(companies) ? companies : []).slice(0, MAX_COMPANIES)
        .map(c => ({ ticker: String(c?.ticker ?? '').trim().toUpperCase(), name: String(c?.name ?? '').trim() }))
        .filter(c => c.ticker || c.name)
        .map(c => (c.ticker && c.name ? `${c.ticker} (${c.name})` : c.ticker || c.name))
    const ctx = String(context ?? '').trim().slice(0, MAX_CONTEXT)
    return [q, named.length ? `Companies: ${named.join(', ')}.` : '', ctx ? `What is already known: ${ctx}` : ''].filter(Boolean).join('\n\n')
}

/** What Axl's tool result says beyond the reply: a hand-back, or an offer to take the user somewhere. Exported for tests. */
export function routeNote(result, roleWord) {
    if (!result?.route) return ''
    if (result.route === RECEPTION) {
        return `The ${roleWord} says this question is not its own${result.opening ? ` ("${result.opening}")` : ''} — answer it yourself, or send the user where it belongs.`
    }
    const to = Object.values(DESKS).find(d => d.desk === result.route)
    const where = to?.role ? `the ${to.role}` : result.route
    return `The ${roleWord} offered to take the user to ${where}${result.routeSymbol ? ` on ${result.routeSymbol}` : ''}${result.opening ? `: "${result.opening}"` : ''}. ` +
        `Only if that is what the user asked for, end your reply with that route (<route>${result.route}${result.routeSymbol ? ` ${result.routeSymbol}` : ''}</route> and the <open>).`
}

// `desks` resolves at call time: index.js → axl.desk → here → index.js is a cycle, and DESK_DEFS is not yet defined while
// this module evaluates.
export function makeAskSpecialist({ sessions = sessionService, desks = null } = {}) {
    /**
     * The `ask_specialist` handler for ONE Axl turn.
     * @param {{ user: object, sessionId: string, emit: Function, signal?: AbortSignal, audience?: object|null }} turn
     * @returns {(args: { specialist: string, question: string, companies: object[], context?: string }) => Promise<string|object>}
     */
    return function forTurn({ user, sessionId, emit = () => {}, signal, audience = null }) {
        return async function askSpecialist(args = {}) {
            const agent = SUBAGENTS[args.specialist]
            const desk  = agent ? (desks ?? DESK_DEFS)[agent] : null
            if (!desk) return toolError(`specialist must be one of: ${Object.keys(SUBAGENTS).join(', ')}`)
            if (!String(args.question ?? '').trim()) return toolError('question is required — the user\'s ask, written to stand alone')
            if (!Array.isArray(args.companies)) return toolError('companies is required — ticker and name for each company (empty only when none is listed)')
            const roleWord = DESKS[agent].role
            const text = composeQuestion(args)

            // Hidden on screen (the user's words already show as theirs to Axl), kept in the role's segment so a
            // follow-up reaches it with the earlier exchange.
            const asked = await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'user', content: text, ref: { opening: true, via: 'axl' } } })
            if (asked?.reason) return toolError(`the ${roleWord} could not be asked (${asked.reason})`)

            const session  = await sessions.get({ sessionId, userId: user._id })
            const summary  = session?.summaries?.[agent] ?? null
            const messages = await sessions.messagesForAgent({ sessionId, userId: user._id, agent, afterSeq: summary?.throughSeq ?? 0 })
            // ONE VOICE (docs/design/axl-one-voice.md §5, Roy 2026-11-21): its tokens are Axl's material, not the chat's —
            // only its tool status (and a chart it draws) reach the screen, as Axl's working.
            const emitAs = (type, data) => (type === 'token' ? undefined : emit(type, data))
            const common = deskCommon({ messages: buildConversation({ messages: messages ?? [], agent, summary }), user, signal, emit: emitAs, audience })
            let chart = null
            const deskOnChart = common.onChart
            common.onChart = (row) => {
                if (row?.symbol) chart = { ticker: row.symbol, timeframe: row.timeframe ?? null }
                return deskOnChart?.(row)
            }
            const tools = []
            const deskOnToolStart = common.onToolStart
            common.onToolStart = (tool, extra) => {
                if (typeof tool === 'string' && tool && !tools.includes(tool)) tools.push(tool)
                return deskOnToolStart?.(tool, extra)
            }

            // A builder Axl may ask (the analyst) answers through its own `ask`: a question, not its build — no draft,
            // no state. A subagent's desk is only ever asked, so its `run` is the answer.
            let result
            try {
                const answer = desk.ask ?? desk.run
                result = await answer({ user, state: session?.agentState?.[agent] ?? null, input: {}, signal, emit: emitAs, common, sessionId, asked: args })
            } catch (err) {
                logger.warn(LOG, 'specialist failed', { agent, message: err.message })
                return toolError(`the ${roleWord} failed (${err.message}) — say so; do not answer from memory`)
            }
            if (!result || signal?.aborted) return toolError('stopped')

            const reply = String(result.reply ?? '').trim()
            const note  = routeNote(result, roleWord)
            if (reply) {
                // Kept in its segment (a follow-up keeps its thread; Axl's next turn reads it), hidden from the chat (`material`).
                await sessions.append({ sessionId, userId: user._id, message: { agent, role: 'assistant', content: reply, ref: { via: 'axl', material: true }, tools } })
            }
            // A chart it drew is the chat's, not material: its own row, as Axl's — the row a chart-only reply gets (chartLine),
            // so it is still on screen after a reload.
            if (chart) await sessions.append({ sessionId, userId: user._id, message: { agent: 'axl', role: 'assistant', content: chartLine(chart), ref: { chart } } })
            logger.info(LOG, 'specialist answered', { agent, replyLength: reply.length, route: result.route ?? null, tools })
            if (!reply) return note || `The ${roleWord} had nothing to say. Answer the user yourself.`
            return `THE ${roleWord.toUpperCase()}'S ANSWER — your MATERIAL; nothing of it is on screen. Write the answer yourself, in your ` +
                `own voice: the ${roleWord}'s findings said as the house's, your own reading as yours.${note ? `\n${note}` : ''}\n\n--- the ${roleWord}'s answer ---\n${reply}`
        }
    }
}

export const askSpecialist = makeAskSpecialist()
