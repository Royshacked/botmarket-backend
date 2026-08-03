import { axlAgentService } from '../../services/axl.agent.service.js'
import { resolveModel }    from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseChatMessages } from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { getMarketBrief } from '../../services/marketBrief.service.js'
import { postCard } from '../../services/notifyCard.js'
import { logger } from '../../services/logger.service.js'

// The desks a reply may hand the user to. Validated here rather than trusted from the model: an
// unknown key would leave the client trying to navigate to a tab that doesn't exist, so it becomes
// null and the user simply stays with Axl.
export const VALID_PIPELINES = new Set(['trade', 'portfolio', 'scan', 'assist', 'research'])
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
                // Unlike routeSymbol this stands alone: an objective captured on a turn that does
                // NOT route is the normal case (intake first, hand-off once they're ready), and the
                // client shows it back to the user so they can see what was understood — and correct
                // it if we got it wrong. Built by us from the stored record, not from model output,
                // so there is nothing here to re-validate.
                objective: result.objective ?? null,
                chart: result.chart ?? null,
            }
        },
    })
}

/**
 * Deliver today's market brief into the user's Axl conversation — the CONFIRM half of the daily
 * offer card. The offer is posted by the notifier; nothing is written until the user asks for it
 * here, which is the point: a broadcast nobody wanted is spam.
 *
 * The brief itself comes from the shared service, so what lands here is the same text Axl relays in
 * chat. Resolving the offer card is deliberately NOT done here: the client resolves it on a
 * successful response, the way every other card in the social chat is resolved, so its local copy
 * collapses immediately instead of staying pending until a reload. A failure therefore leaves the
 * card actionable, which is the behaviour we want — the user can just press it again.
 */
export async function deliverBrief(req, res) {
    const userId = req.user._id

    try {
        const { text, asOf, cached } = await getMarketBrief()

        const posted = await postCard(
            { userId, content: text, type: 'market_brief', payload: { asOf } },
            { tag: 'Market brief', log: LOG },
        )
        // postCard never throws — it returns null when delivery failed. Reporting success then would
        // be a lie the user discovers by looking at an empty chat.
        if (!posted) return res.status(502).json({ error: 'Could not deliver the brief to your chat.' })

        return res.json({ ok: true, messageId: posted.id, asOf, cached })
    } catch (err) {
        logger.error(LOG, 'deliverBrief failed', err)
        return res.status(502).json({ error: 'Could not write the market brief right now.' })
    }
}
