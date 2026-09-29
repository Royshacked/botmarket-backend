import { mentorAgentService, emptyMentorState } from '../../services/agents/mentor.agent.service.js'
import { streamAgentResponse, sseAgentCallbacks } from '../_shared/sse.util.js'
import { routeFields } from '../../services/routing.util.js'
import { parseStreamBody, parseClientTime } from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'

const LOG = '[mentor:controller]'

/**
 * WHAT REACHES THE PANEL. Pure, exported, and tested — because everything the desk computes for
 * the user has to be listed here by hand, and twice now something was not: `build` first, then
 * `gate`, which made both build gates vanish from the screen while the server happily went on
 * computing which one was open.
 *
 * `setup` is a DRAFT for preview; `setups` is the 2–3 candidate offer the user picks from. They
 * are mutually exclusive by contract — the agent enforces it.
 */
export function _mentorResponse(result, role) {
    return {
        reply:    result.reply,
        coverage: result.coverage,
        // The build ledger (services/mentorBuild.util.js). It travels on the draft, which is what
        // the client already round-trips; this copy is the seam for a frontend that carries it in
        // its own right.
        build:    result.build,
        // Every plan in a multi-name build, keyed by asset — absent on a one-name one.
        ...(result.drafts ? { drafts: result.drafts } : {}),
        // WHICH STAGE IS OPEN, and the values put to the user: the panel draws its gate cards
        // from this.
        ...(result.gate ? { gate: result.gate } : {}),
        ...(result.setup  ? { setup: result.setup, readiness: result.readiness } : {}),
        ...(result.setups ? { setups: result.setups } : {}),
        // route / routeSymbol / opening — the user asked to be sent to another desk (routing.util).
        ...routeFields(result, role),
    }
}

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

            return _mentorResponse(result, req.user.role)
        },
    })
}
