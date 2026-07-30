import { mentorAgentService, emptyMentorState } from '../../services/mentor.agent.service.js'
import { resolveModel }        from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseIdeaAccounts, parseChatMessages } from '../_shared/parse.util.js'
import { getOpenObjective } from '../../services/objective.service.js'

const LOG = '[mentor:controller]'
const MAX_RECENT_CHAT_TURNS = 4

/**
 * Mentor's build conversation (Pipeline F). Streams tokens / chart / status / coverage; the
 * agent returns a DRAFT setup in `done`. Nothing persists until the user presses Generate.
 *
 * No `currentPhase` is threaded through: Mentor has no phases, so `resolveModel` gets no phase
 * and AUTO falls through to DEFAULT_ROUTE. The intended routing mode here is CLASSIFIER, which
 * picks from the last user message rather than a step number (docs/setup-entity.md §8).
 */
export async function streamMentor(req, res) {
    const parsed = parseStreamBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const { routingMode, model, reasoningEffort } = req.body ?? {}
            const lastMessage = parsed.messages?.at(-1)?.content ?? parsed.userPrompt ?? ''
            const routing = await resolveModel({ routingMode, agent: 'mentor', model, reasoningEffort, lastMessage })

            // The user's live book across paper/live/manual — so Mentor can say "this stacks the
            // same name" before it sizes. Best-effort: a broker hiccup just drops the block.

            const result = await mentorAgentService.chatStream({
                objective:     await getOpenObjective(req.user._id),
                messages:      parsed.messages,
                userPrompt:    parsed.userPrompt,
                chatState:     parsed.chatState ?? emptyMentorState(),
                accounts:      parsed.accounts,
                mainAccountId: parsed.mainAccountId,
                clientTime:    parsed.clientTime,
                model:           routing.model,
                reasoningEffort: routing.reasoningEffort,
                userId:          req.user._id,
                signal,
                onToken:     (text)     => sendEvent('token',     { text }),
                onAsset:     (symbol)   => sendEvent('asset',     { symbol }),
                onInterval:  (interval) => sendEvent('interval',  { interval }),
                onChart:     (chart)    => sendEvent('chart',     chart),
                onToolStart: (tool)     => sendEvent('status',    { tool }),
                onReasoning: (text)     => sendEvent('reasoning', { text }),
                onCoverage:  (coverage) => sendEvent('coverage',  { coverage }),
            })

            // `setup` is a DRAFT for preview; `setups` is the 2–3 candidate offer the user picks
            // from. They're mutually exclusive by contract — the agent enforces it.
            return {
                reply:    result.reply,
                coverage: result.coverage,
                ...(result.setup     ? { setup: result.setup, readiness: result.readiness } : {}),
                ...(result.setups    ? { setups: result.setups } : {}),
            }
        },
    })
}

function parseStreamBody(body) {
    const { messages, userPrompt, chatState, accounts } = body ?? {}
    const trimmedPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : ''
    const mainAccountId = body?.mainAccountId != null ? String(body.mainAccountId) : null

    let priorState = null
    if (chatState !== undefined && chatState !== null) {
        if (typeof chatState !== 'object' || Array.isArray(chatState)) {
            return { error: 'chatState must be an object' }
        }
        priorState = chatState
    }

    const base = {
        chatState:     priorState,
        accounts:      parseIdeaAccounts(accounts),
        mainAccountId,
        clientTime:    parseClientTime(body),
    }

    if (messages !== undefined && messages !== null) {
        if (!Array.isArray(messages)) return { error: 'messages must be an array' }
        // An empty array with a prompt to fall back on is fine; empty with nothing is not.
        if (messages.length === 0) {
            return trimmedPrompt
                ? { ...base, userPrompt: trimmedPrompt }
                : { error: 'messages must be a non-empty array' }
        }
        const validated = parseChatMessages(messages)
        if (validated.error) return { error: validated.error }
        return {
            ...base,
            userPrompt: trimmedPrompt || undefined,
            messages:   validated.messages.slice(-MAX_RECENT_CHAT_TURNS * 2),
        }
    }

    if (trimmedPrompt) return { ...base, userPrompt: trimmedPrompt }

    return { error: 'Request must include messages or userPrompt' }
}

// Browser-supplied local time ({ clientNow: ms, clientTz: IANA }) so Mentor resolves "through
// Friday" against the user's calendar and stores active_from / valid_until as absolute UTC.
// Each field is validated independently — a bad value is dropped, never fatal.
function parseClientTime(body) {
    const now = Number(body?.clientNow)
    const tz  = typeof body?.clientTz === 'string' ? body.clientTz.trim() : ''
    const clientTime = {}
    if (Number.isFinite(now) && now > 0) clientTime.clientNow = now
    if (tz) clientTime.clientTz = tz
    return (clientTime.clientNow || clientTime.clientTz) ? clientTime : null
}
