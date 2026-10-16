// Mentor — builds ONE trade setup with the user (Pipeline F). Working state: the chat state —
// `{ active_asset, draft (carrying the build ledger), coverage, drafts }`.
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).
//
// Streams tokens / chart / status / coverage; the agent returns a DRAFT setup in `done`. Nothing
// persists until the user presses Generate.

import { mentorAgentService, emptyMentorState } from '../agents/mentor.agent.service.js'
import { parseClientTime } from '../../api/_shared/parse.util.js'
import { sanitizeScanSeed } from '../scanSeed.util.js'
import { houseLabels, formatHouseLabel } from '../houseLabel.service.js'

/**
 * WHAT REACHES THE PANEL. Pure and tested — because everything the desk computes for the user has to
 * be listed here by hand, and twice now something was not: `build` first, then `gate`, which made both
 * build gates vanish from the screen while the server happily went on computing which one was open.
 *
 * `setup` is a DRAFT for preview; `setups` is the 2–3 candidate offer the user picks from. They are
 * mutually exclusive by contract — the agent enforces it.
 */
export function _mentorResponse(result) {
    return {
        reply:    result.reply,
        coverage: result.coverage,
        // The build ledger (services/mentorBuild.util.js). It travels on the draft, which is what the
        // client already round-trips; this copy is the seam for a frontend that carries it in its own right.
        build:    result.build,
        // Every plan in a multi-name build, keyed by asset — absent on a one-name one.
        ...(result.drafts ? { drafts: result.drafts } : {}),
        // WHICH STAGE IS OPEN, and the values put to the user: the panel draws its gate cards from this.
        ...(result.gate ? { gate: result.gate } : {}),
        ...(result.setup  ? { setup: result.setup, readiness: result.readiness } : {}),
        ...(result.setups ? { setups: result.setups } : {}),
        // route / routeSymbol / opening are appended by the caller (routing.util).
    }
}

/**
 * The house's label on a handed-over name, worked out from the ticker — never read off a request
 * (argus-on-pythia.md §3.4). No label, or a failed read, leaves it null.
 */
async function _labelSeed(seed) {
    if (seed) seed.house = formatHouseLabel((await houseLabels([seed.ticker], { books: ['swing', 'long_term'] })).get(seed.ticker)) || null
    return seed
}

export const mentorDesk = {
    agent: 'mentor',
    log:   '[mentor:desk]',
    parse: async (body, turn) => ({
        state: turn.chatState ?? emptyMentorState(),
        input: {
            // Argus hand-off: the validated name, its read, and the lens Argus recommends. Absent for a
            // user who opened Mentor on their own, which is the ordinary path.
            seed:          await _labelSeed(sanitizeScanSeed(body.seed)),
            // The browser clock, so `active_from` / `valid_until` resolve against the user's calendar.
            clientTime:    parseClientTime(body),
            accounts:      turn.accounts,
            mainAccountId: turn.mainAccountId,
        },
    }),
    run: ({ state, input, emit, common }) => mentorAgentService.chatStream({
        ...common,
        // `ops` — what a card press decided — is ONE-SHOT: it rides this turn only. The HTTP client puts
        // it inside its chatState; a session turn hands it in as input.
        chatState:     input.ops ? { ...(state ?? emptyMentorState()), ops: input.ops } : (state ?? emptyMentorState()),
        accounts:      input.accounts ?? [],
        mainAccountId: input.mainAccountId ?? null,
        clientTime:    input.clientTime ?? null,
        seed:          input.seed ?? null,
        onAsset:     (symbol)   => emit('asset',     { symbol }),
        onInterval:  (interval) => emit('interval',  { interval }),
        onCoverage:  (coverage) => emit('coverage',  { coverage }),
    }),
    done: (result) => _mentorResponse(result),
}
