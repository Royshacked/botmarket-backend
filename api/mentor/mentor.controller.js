import { mentorAgentService, emptyMentorState } from '../../services/agents/mentor.agent.service.js'
import { makeDeskStream } from '../_shared/deskStream.util.js'
import { parseClientTime } from '../_shared/parse.util.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'
import { houseLabels, formatHouseLabel } from '../../services/houseLabel.service.js'

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
export function _mentorResponse(result) {
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
        // route / routeSymbol / opening are appended by makeDeskStream (routing.util).
    }
}

/**
 * Mentor's build conversation (Pipeline F). Streams tokens / chart / status / coverage; the
 * agent returns a DRAFT setup in `done`. Nothing persists until the user presses Generate.
 *
 * The model is the user's own pick, passed straight through. There is no routing layer: choosing
 * a cheaper model per turn cost more in invalidated prompt cache than it ever saved.
 */
export const streamMentor = makeDeskStream({
    log: LOG,
    parse: async (req) => {
        // Argus hand-off: the validated name, its read, and the lens Argus recommends. Absent for a
        // user who opened Mentor on their own, which is the ordinary path.
        const seed = sanitizeScanSeed(req.body?.seed)
        // The house's label on the handed-over name, worked out HERE from the ticker — never read off
        // the request body (argus-on-pythia.md §3.4). No label, or a failed read, leaves it null.
        if (seed) seed.house = formatHouseLabel((await houseLabels([seed.ticker], { books: ['swing', 'long_term'] })).get(seed.ticker)) || null
        // The browser clock, so `active_from` / `valid_until` resolve against the user's calendar
        // rather than the server's.
        return { seed, clientTime: parseClientTime(req.body) }
    },
    run: ({ turn, extras, sendEvent, common }) => mentorAgentService.chatStream({
        ...common,
        chatState:     turn.chatState ?? emptyMentorState(),
        accounts:      turn.accounts,
        mainAccountId: turn.mainAccountId,
        clientTime:    extras.clientTime,
        seed:          extras.seed,
        onAsset:     (symbol)   => sendEvent('asset',     { symbol }),
        onInterval:  (interval) => sendEvent('interval',  { interval }),
        onCoverage:  (coverage) => sendEvent('coverage',  { coverage }),
    }),
    done: (result) => _mentorResponse(result),
})
