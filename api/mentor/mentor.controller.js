import { mentorAgentService, emptyMentorState } from '../../services/agents/mentor.agent.service.js'
import { resolveModel }        from '../../services/modelRouter.service.js'
import { streamAgentResponse } from '../_shared/sse.util.js'
import { parseStreamBody, parseClientTime } from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'

const LOG = '[mentor:controller]'

/**
 * Mentor's build conversation (Pipeline F). Streams tokens / chart / status / coverage; the
 * agent returns a DRAFT setup in `done`. Nothing persists until the user presses Generate.
 *
 * No `currentPhase` is threaded through: Mentor has no phases, so `resolveModel` gets no phase
 * and AUTO falls through to DEFAULT_ROUTE. The intended routing mode here is CLASSIFIER, which
 * picks from the last user message rather than a step number (docs/desks/mentor-talos.md).
 */
export async function streamMentor(req, res) {
    const parsed = parseStreamBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    // Mentor's own extra: the browser clock, so `active_from` / `valid_until` resolve against the
    // user's calendar rather than the server's.
    const clientTime = parseClientTime(req.body)

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const { routingMode, model, reasoningEffort } = req.body ?? {}
            const lastMessage = parsed.messages?.at(-1)?.content ?? parsed.userPrompt ?? ''
            const routing = await resolveModel({ routingMode, agent: 'mentor', model, reasoningEffort, lastMessage })

            // The user's live book across paper/live/manual — so Mentor can say "this stacks the
            // same name" before it sizes. Best-effort: a broker hiccup just drops the block.

            const result = await mentorAgentService.chatStream({
                audience:      await getExperienceLevel(req.user._id),
                messages:      parsed.messages,
                userPrompt:    parsed.userPrompt,
                chatState:     parsed.chatState ?? emptyMentorState(),
                accounts:      parsed.accounts,
                mainAccountId: parsed.mainAccountId,
                clientTime,
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

