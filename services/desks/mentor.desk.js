// Mentor — builds ONE trade setup with the user (Pipeline F). Working state: the chat state —
// `{ active_asset, draft (carrying the build ledger), coverage, drafts }`.
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).
//
// Streams tokens / chart / status / coverage; the agent returns a DRAFT setup in `done`. Nothing
// persists until the user presses Generate.

import { mentorAgentService, emptyMentorState } from '../agents/mentor.agent.service.js'
import { parseClientTime } from '../../api/_shared/parse.util.js'
import { sanitizeScanSeed } from '../scanSeed.util.js'
import { hotlistSeed } from '../hotlist.service.js'
import { bookSeed } from '../houseBook.service.js'
import { houseLabels, formatHouseLabel } from '../houseLabel.service.js'
import { mentorActions, mentorApplyEdit } from './actions/mentor.actions.js'
import { setupReason } from '../../api/setups/setupReasons.js'

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
    // A HOTLIST hand-off (daily-names.md §8) names a board and a column; what it says about the name —
    // the horizon, the grade, the free range, the catalyst, Argus's pick note — is read back from the
    // stored board, never taken off the request. A board that is gone leaves an ordinary seed.
    if (seed?.hotlist) {
        const h = await hotlistSeed(seed.hotlist).catch(() => null)
        if (h) {
            seed.horizon            = h.horizon
            seed.hotlist_facts      = h.hotlist_facts
            seed.catalyst_facts     = h.catalyst_facts ?? null
            seed.hotlist_unverified = h.unverified
            seed.thesis           ??= h.thesis ?? null
            seed.caution            = h.caution ?? null
        }
    }
    // A hand-off off the Hotlist's SWING / LONG TERM lists (the house's coverage, 2026-10-24): the name's coverage is
    // read back by code — its book (the target's horizon) sets the trade's horizon; the thesis in numbers rides along.
    if (seed?.book) {
        const b = await bookSeed(seed.book).catch(() => null)
        if (b) {
            seed.horizon    = b.horizon
            seed.book_name  = b.book
            seed.book_facts = b.book_facts
            seed.thesis   ??= b.thesis ?? null
            seed.caution  ??= b.caution ?? null
        }
    }
    return seed
}

/**
 * The working state after a turn — the fold the client did on every `done` (MentorPanel `_applyDone`),
 * done once, on the server. The draft carries the build ledger; `drafts` is the multi-name build (kept —
 * the old client persistence dropped it); `view` is what the panel draws its cards from (the open gate,
 * readiness, the candidate offer), kept so a reload can redraw them. `ops` is never stored: one-shot.
 */
export function mentorNextState(prev, result, input = {}) {
    const draft = result.setup ?? prev?.draft ?? null
    return {
        active_asset: draft?.asset || input.seed?.ticker || prev?.active_asset || '',
        draft,
        coverage:     result.coverage ?? prev?.coverage ?? [],
        drafts:       result.drafts ?? {},
        view: {
            gate:      result.gate ?? null,
            readiness: result.setup ? (result.readiness ?? null) : (prev?.view?.readiness ?? null),
            setups:    result.setups ?? null,
        },
    }
}

/**
 * The working state to EDIT a saved setup from the document alone: its stored draft when it has one
 * (the ledger rides on it), else a draft rebuilt from the setup's own fields — the fallback the client
 * built for setups saved before the draft was stored (MainPage.handleEditSetup), moved here.
 */
export function mentorStateFromEntity(setup) {
    const draft = setup?.chat_state?.draft ?? {
        asset:       setup?.asset,
        asset_class: setup?.asset_class ?? null,
        direction:   setup?.direction   ?? null,
        type:        setup?.type        ?? null,
        trade_mode:  setup?.trade_mode  ?? null,
        timeframe:   setup?.timeframe   ?? null,
        ladder:      setup?.ladder      ?? [],
        thesis:      setup?.thesis      ?? null,
        watch:       setup?.watch       ?? [],
        entry_legs:  setup?.entry_legs  ?? [],
        stop_legs:   setup?.stop_legs   ?? [],
        target_legs: setup?.target_legs ?? [],
        quantity:    setup?.quantity    ?? null,
        rr:          setup?.rr          ?? null,
        conviction:  setup?.conviction  ?? null,
        active_from: setup?.active_from ?? null,
        valid_until: setup?.valid_until ?? null,
    }
    return {
        active_asset: draft?.asset ?? setup?.asset ?? '',
        draft,
        coverage:     setup?.chat_state?.coverage ?? [],
        drafts:       {},
        view:         { gate: null, readiness: null, setups: null },
    }
}

export const mentorDesk = {
    agent: 'mentor',
    log:   '[mentor:desk]',
    emptyState: emptyMentorState,
    stateFromEntity: mentorStateFromEntity,
    // Unsealed work: a setup in the making.
    hasWork: (state) => !!state?.draft,
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
    // A session turn hands its input in already parsed; the seed still needs its house label.
    prepareInput: async (input = {}) => ({ ...input, seed: await _labelSeed(sanitizeScanSeed(input.seed)) }),
    nextState: mentorNextState,
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
    // The session's commits and direct edits (plan phase 8, K2/K3) — services/desks/act.js runs them.
    actions:   mentorActions,
    applyEdit: mentorApplyEdit,
    // A refused commit answers in the setup routes' own words.
    reasons:   setupReason,
    // What a turn's `done` carries that the state already holds — dropped from the live frame (K4), read from
    // agentState instead. The chain still reads the full payload.
    stateFields: ['setup', 'setups', 'drafts', 'gate', 'readiness', 'coverage', 'build'],
}
