import { axlAgentService } from '../../services/agents/axl.agent.service.js'
import { resolveModel }    from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages } from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { getMarketBrief } from '../../services/marketBrief.service.js'

// The desks a reply may hand the user to. Validated here rather than trusted from the model: an
// unknown key would leave the client trying to navigate to a tab that doesn't exist, so it becomes
// null and the user simply stays with Axl.
export const VALID_PIPELINES = new Set(['trade', 'portfolio', 'scan', 'assist', 'research', 'strategy'])
const LOG = '[axl:controller]'

// The ticker a reply may hand over with the desk (`<route>research NVDA</route>`). Sanitized on the
// same principle as the desk key: it becomes the desk's OPENING TURN, so a hallucinated "the" or a
// company name would put an agent to work on nothing. Anything that isn't a plausible symbol is
// dropped and the desk simply opens empty — the old behaviour, never a broken one.
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}$/
export function _sanitizeRouteSymbol(raw) {
    if (typeof raw !== 'string') return null
    const symbol = raw.trim().toUpperCase()
    return SYMBOL_RE.test(symbol) ? symbol : null
}

// The kinds `<edit>` may reopen. Same gate as the desks above and for the same reason — a kind the
// client has no opener for would leave it mid-hand-off with nothing to show.
//
// A BOOK is the one whose edit is not free: reopening a plan in Atlas takes every holding back to
// `waiting` until the user re-activates it. That is the existing pencil's behaviour, not something
// this hand-off invents — the same click, reached by sentence — but it is why the prompt has Axl
// say so before it hands over, rather than letting a live book quietly go unmonitored.
export const EDIT_KINDS = new Set(['call', 'setup', 'coverage', 'scan', 'portfolio'])

// The handle Axl quotes back from get_watched_items: an item id (a UUID), or — when it has none to
// hand — a bare ticker the client can match on instead. Deliberately permissive about WHICH of the
// two: this is used to look something up in a list the client already holds, so a wrong or invented
// ref finds nothing and opens nothing. It can never reach another user's data. The gate is only
// here to keep junk (a sentence, a quoted phrase) from travelling as if it were a handle.
const EDIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export function _sanitizeEditRef(raw) {
    if (typeof raw !== 'string') return null
    const ref = raw.trim()
    return EDIT_REF_RE.test(ref) ? ref : null
}

/** The whole edit hand-off, or null — kind, desk and ref all have to survive for it to mean anything. */
export function _validateEdit(edit) {
    if (!edit || !EDIT_KINDS.has(edit.kind) || !VALID_PIPELINES.has(edit.desk)) return null
    const ref = _sanitizeEditRef(edit.ref)
    return ref ? { kind: edit.kind, ref, desk: edit.desk } : null
}

// SSE chat with Axl — the one Axl surface. It answers, remembers the thread, docks charts, and
// routes to a desk when the user wants one (`route` + optional `routeSymbol` in the `done` payload,
// the desk and the name it should open on). There is deliberately no
// second endpoint: a separate one-shot `/route` doorman used to answer the landing box with no
// history and no app knowledge, which meant confident wrong answers and follow-ups that couldn't
// resolve. Model routing follows the user's shared AI-mode (agent 'axl' is phaseless → auto/
// classifier fall back to the default route).
export async function streamAxl(req, res) {
    const { messages, model, reasoningEffort, routingMode } = req.body ?? {}

    const validated = parseChatMessages(messages)
    if (validated.error) return res.status(400).json({ error: validated.error })

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const lastMessage = messages.at(-1)?.content ?? ''
            const routing = await resolveModel({ routingMode, agent: 'axl', phase: null, model, reasoningEffort, lastMessage })

            const result = await axlAgentService.chatStream({
                messages,
                audience: await getExperienceLevel(req.user._id),
                model:           routing.model,
                reasoningEffort: routing.reasoningEffort,
                userId:  req.user._id,
                signal:  signal,
                onToken:     (text)  => sendEvent('token',     { text }),
                onToolStart: (tool)  => sendEvent('status',    { tool }),
                onReasoning: (text)  => sendEvent('reasoning', { text }),
                onChart:     (chart) => sendEvent('chart',     chart),
            })

            const route = VALID_PIPELINES.has(result.route) ? result.route : null
            return {
                reply: result.reply,
                route,
                // A symbol only rides along WITH a desk — with no route it has nowhere to land.
                routeSymbol: route ? _sanitizeRouteSymbol(result.routeSymbol) : null,
                // Reopen an item the user already has, in the desk that owns it, instead of opening
                // that desk on a blank page. Independent of `route` — it carries its own desk.
                edit: _validateEdit(result.edit),
                // The desk's opening turn, in the user's own words — the whole hand-off. Gated on a
                // real route for the same reason the symbol is: with nowhere to land it is a message
                // sent to no one. The service has already collapsed and capped it.
                opening: route ? (result.opening ?? null) : null,
                chart: result.chart ?? null,
            }
        },
    })
}

/**
 * Today's market brief, streamed into the Axl chat panel — the CONFIRM half of the daily offer
 * card. The offer is posted by the notifier; nothing is written until the user asks for it here,
 * which is the point: a broadcast nobody wanted is spam.
 *
 * ── WHY A STREAM AND NOT A POSTED CARD ───────────────────────────────────────
 * The brief used to be posted back into the social chat as a second message, which put a wall of
 * market prose in a surface built for one-line notifications — and left the user reading it with
 * nobody to ask about it. It belongs in Axl's chat: the brief lands as Axl's turn, so "what does
 * that mean for my book?" is the next thing the user types, not a new journey.
 *
 * It is a DELIVERY dressed as a turn, so it does NOT go through /stream: nothing is said to Axl,
 * no model turn runs here, and the reply is fixed text. The client still consumes it with the same
 * SSE handlers as a real turn, which is what makes the waiting chip and the typewriter work for
 * free.
 *
 * The whole brief goes out as ONE token event. There is nothing to stream progressively — the text
 * is already complete by the time it exists (getMarketBrief builds it in one model turn behind the
 * shared cache, or returns the copy every other reader that hour got). The pacing the user sees is
 * the client's typewriter, which is where pacing has always lived.
 *
 * Resolving the offer card is deliberately NOT done here: the client resolves its own copy, the way
 * every other card in the social chat is resolved, so it collapses immediately rather than staying
 * pending until a reload.
 */
export async function streamBrief(req, res, { fetchBrief = getMarketBrief } = {}) {
    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            // Writing a stale brief is a live model turn with web searches behind it — the chip is
            // the only thing standing between the user and a silent minute.
            sendEvent('status', { tool: 'market_brief' })

            const { text, asOf, cached } = await fetchBrief()
            if (signal.aborted) return {}

            sendEvent('token', { text })
            return { reply: text, asOf, cached }
        },
    })
}
