import { axlAgentService } from '../../services/agents/axl.agent.service.js'
import { routeFields } from '../../services/routing.util.js'
import { streamAgentResponse, sseAgentCallbacks } from '../_shared/sse.util.js'
import { parseChatMessages } from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { getMarketBrief } from '../../services/marketBrief.service.js'

const LOG = '[axl:controller]'

// The desk key, the symbol, the edit handle and the opening are validated by the shared routing tier
// (routing.util — routeFields), the same gate every desk's controller applies. Until 2026-09-18 the
// validators lived here, because Axl was the only agent that routed.

// SSE chat with Axl — the one Axl surface. It answers, remembers the thread, docks charts, and
// routes to a desk when the user wants one (`route` + optional `routeSymbol` in the `done` payload,
// the desk and the name it should open on). There is deliberately no
// second endpoint: a separate one-shot `/route` doorman used to answer the landing box with no
// history and no app knowledge, which meant confident wrong answers and follow-ups that couldn't
// resolve. The model is the user's own pick, straight through — there is no per-turn routing layer
// any more (see docs: a model or reasoning change mid-conversation invalidates the prompt cache,
// which cost more than picking a cheaper model per turn ever saved).
export async function streamAxl(req, res) {
    const { messages, model } = req.body ?? {}

    const validated = parseChatMessages(messages)
    if (validated.error) return res.status(400).json({ error: validated.error })

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const result = await axlAgentService.chatStream({
                messages: validated.messages,
                audience: await getExperienceLevel(req.user._id),
                isAdmin:  req.user.role === 'admin',
                model,
                userId:  req.user._id,
                signal:  signal,
                ...sseAgentCallbacks(sendEvent),
            })

            // route / routeSymbol / edit / opening — validated for this user by the shared tier.
            const routing = routeFields(result, req.user.role)
            const { route } = routing
            return {
                reply: result.reply,
                ...routing,
                // The user already owns the book they want managed → the portfolio desk opens in
                // ADOPT mode instead of on a blank construction. Re-gated on a real portfolio route
                // for the same reason the symbol and the opening are: this tier is the contract.
                adopt: route === 'portfolio' && result.adopt === true,
                // Follow-up chips. Already empty on a routing turn (the agent guards it), and
                // re-gated here for the same reason `route` itself is validated rather than
                // trusted: this tier is the contract the client reads.
                suggestions: route ? [] : (Array.isArray(result.suggestions) ? result.suggestions : []),
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
