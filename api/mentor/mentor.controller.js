import { mentorAgentService, emptyMentorState, buildExpressHandoffPrompt } from '../../services/agents/mentor.agent.service.js'
import { streamAgentResponse, sseAgentCallbacks } from '../_shared/sse.util.js'
import { parseStreamBody, parseClientTime } from '../_shared/parse.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'
import { normalizeTimeframe, VALID_TIMEFRAMES } from '../../services/timeframe.service.js'

const LOG = '[mentor:controller]'

/**
 * Mentor's build conversation (Pipeline F). Streams tokens / chart / status / coverage; the
 * agent returns a DRAFT setup in `done`. Nothing persists until the user presses Generate.
 *
 * The model is the user's own pick, passed straight through. There is no routing layer: choosing
 * a cheaper model per turn cost more in invalidated prompt cache than it ever saved.
 */
export async function streamMentor(req, res) {
    // THE EXPRESS FORM'S TURN IS BUILT HERE, NOT SENT BY THE CLIENT. The instruction is appended as
    // the final user message on the wire because the API needs one and `attachTurnContext` hangs the
    // venue block on it — but it is absent from the conversation the user sees and from the thread
    // that is saved. See buildExpressHandoffPrompt for why a fabricated user line was the wrong way.
    //
    // Appended to `messages` rather than passed as `userPrompt`: buildDeskMessages only falls back to
    // the prompt when there is NO history, so on a conversation that already has turns a userPrompt
    // would be silently dropped and Mentor would be asked nothing at all.
    const handoff = _parseExpressHandoff(req.body?.expressHandoff)
    const parsed  = parseStreamBody(handoff
        ? { ...req.body, userPrompt: buildExpressHandoffPrompt(handoff) }
        : req.body)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    if (handoff) {
        parsed.messages = [
            ...(parsed.messages ?? []),
            { role: 'user', content: buildExpressHandoffPrompt(handoff) },
        ]
    }
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
                // The express form opening on the user's screen (open_setup_form). A SURFACE event,
                // like `chart` — the panel acts on it during the turn rather than waiting for `done`,
                // because the point of the form is that it is already there when the sentence lands.
                onSetupForm: (form)     => sendEvent('setup_form', form),
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

/**
 * The express hand-off flag off the request body. Returns null when absent, so the ordinary chat
 * path is untouched — and returns an object (never a bare `true`) so the shape is the same whether
 * or not the user named more than one timeframe.
 *
 * Nothing here is trusted as text: only known timeframe STRINGS survive, and the instruction they
 * end up in is composed server-side. A client that could put arbitrary prose into a turn attributed
 * to the user is the thing this whole path exists to avoid.
 */
function _parseExpressHandoff(raw) {
    if (!raw) return null
    const list = Array.isArray(raw?.timeframes) ? raw.timeframes : []
    return {
        timeframes: list
            .filter(t => typeof t === 'string')
            .map(t => normalizeTimeframe(t))
            .filter(t => t && VALID_TIMEFRAMES.has(t))
            .slice(0, 6),
    }
}
