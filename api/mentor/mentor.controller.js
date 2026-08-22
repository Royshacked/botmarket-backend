import { mentorAgentService, emptyMentorState } from '../../services/agents/mentor.agent.service.js'
import { streamAgentResponse, sseAgentCallbacks } from '../_shared/sse.util.js'
import { parseStreamBody, parseClientTime } from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'

const LOG = '[mentor:controller]'

/**
 * Mentor's build conversation (Pipeline F). Streams tokens / chart / status / coverage; the
 * agent returns a DRAFT setup in `done`. Nothing persists until the user presses Generate.
 *
 * The model is the user's own pick, passed straight through. There is no routing layer: choosing
 * a cheaper model per turn cost more in invalidated prompt cache than it ever saved.
 */
export async function streamMentor(req, res) {
    const parsed = parseStreamBody(req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    // Mentor's own extra: the browser clock, so `active_from` / `valid_until` resolve against the
    // user's calendar rather than the server's.
    const clientTime = parseClientTime(req.body)
    // Argus hand-off: the validated name, its read, and the lens Argus recommends. Absent for a
    // user who opened Mentor on their own, which is the ordinary path.
    const seed = sanitizeScanSeed(req.body?.seed)

    await streamAgentResponse(req, res, {
        log: LOG,
        handler: async ({ sendEvent, signal }) => {
            const { model } = req.body ?? {}

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
                seed,
                model,
                userId:          req.user._id,
                signal,
                ...sseAgentCallbacks(sendEvent),
                onAsset:     (symbol)   => sendEvent('asset',     { symbol }),
                onInterval:  (interval) => sendEvent('interval',  { interval }),
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
