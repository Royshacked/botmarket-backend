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
import { normalizeBuild, activeName, putName, reopenForRedraw, stageOf } from '../mentorBuild.util.js'
import { PRE_ENTRY } from '../entity/vocabulary.js'
import { readFor, readTarget } from '../mentorReads.service.js'

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
        ...(result.scenarioOffer ? { scenarioOffer: result.scenarioOffer } : {}),
        // The setup this turn closed: the page's list re-reads.
        ...(result.closedSetup ? { closedSetup: result.closedSetup } : {}),
        // Done — the chain runner's go step generates and arms it (argus-rework.md §2.2).
        ...(result.go ? { go: result.go } : {}),
        // Cut short by the tool budget — the runner carries the build on (argus-rework.md §2.2).
        ...(result.cutShort ? { cut_short: true } : {}),
        // route / routeSymbol / opening are appended by the caller (routing.util).
    }
}

/**
 * Where Prometheus's read stands for the name and confirmed horizon on Mentor's ledger (mentorReads; argus-rework.md
 * step 3) → readFor's answer with `{ symbol, horizon }`, or null (no name, no confirmed horizon, or one that needs none).
 */
async function _prometheusRead(state, sessionId = null) {
    const t = readTarget(state)
    if (!t) return null
    return { ...t, ...(await readFor(t.symbol, t.horizon, undefined, { sessionId })) }
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
    // The setup it was editing is closed: nothing is left on the table, and no Update to press.
    if (result.closedSetup) return null
    const draft = result.setup ?? prev?.draft ?? null
    // The pencil's offer stands until they take it (the ledger reopens): the turn that takes it needs what it says.
    const offer = prev?.redraw?.offer && draft?.build && stageOf(activeName(normalizeBuild(draft.build))) === null ? { redraw: prev.redraw } : {}
    return {
        ...offer,
        active_asset: draft?.asset || input.seed?.ticker || prev?.active_asset || '',
        draft,
        coverage:     result.coverage ?? prev?.coverage ?? [],
        drafts:       result.drafts ?? {},
        // The user's position size, risk and R:R (argus-rework.md §2.2), KEPT — a redraw or a later turn reads them
        // here, never from the chat. A go held for a read keeps the accounts it was asked with (`go_pending`, runner).
        ...(result.go ?? prev?.risk_plan ? { risk_plan: result.go ?? prev.risk_plan } : {}),
        ...(prev?.go_pending ? { go_pending: prev.go_pending } : {}),
        view: {
            gate:      result.gate ?? null,
            readiness: result.setup ? (result.readiness ?? null) : (prev?.view?.readiness ?? null),
            setups:    result.setups ?? null,
            // Only on the turn that asks: the next turn clears it unless it asks again.
            offer:     result.scenarioOffer ?? null,
        },
    }
}

/**
 * The working state to EDIT a saved setup from the document alone: its stored draft when it has one
 * (the ledger rides on it), else a draft rebuilt from the setup's own fields — the fallback the client
 * built for setups saved before the draft was stored (MainPage.handleEditSetup), moved here.
 */
export function mentorStateFromEntity(setup, opts = {}) {
    const stored = setup?.chat_state?.draft ?? null
    const redraw = redrawOf(setup)
    // Talos's card (`opts.redraw`) reopens a setup that ran away or broke with its LEVELS open (reopenForRedraw) — a
    // finished ledger told Mentor nothing was outstanding, and the re-draw never happened (redraw drive, 2026-11-03).
    // The pencil on the same setup opens it as it is, and Mentor offers the redraw (Roy, 2026-11-05).
    const fromCard = opts?.redraw === true
    const reopened = !!(fromCard && stored && redraw && stored.build)
    const draft = reopened ? _reopenedDraft(stored) : stored ?? {
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
        // ONE TURN's: mentorNextState keeps no unknown key, so the marker is read by the re-draw turn and gone after —
        // the reopened ledger is what carries on. `reopened` — whether there WAS a ledger to reopen (CR: an older setup has
        // none, and the turn must not be told the entries stage is open when it is not).
        ...(redraw ? { redraw: { ...redraw, reopened, ...(fromCard ? {} : { offer: true }) } } : {}),
    }
}

/**
 * WHAT TALOS SAID about a saved setup, when it is a reason to re-draw: a scenario that RAN AWAY unfilled (drifting) or
 * BROKE (fired), read off the per-scenario latches and the document's roll-up, or the map going STALE (edge 'time', whose
 * card asks for a re-draw too). → `{ event: 'ran_away' | 'broken' | 'stale', reason, scenarios: [names] }`, or null when
 * nothing is latched. A broken premise outranks a missed one.
 *
 * Only BEFORE ENTRY (CR 2026-11-03): a filled setup keeps its other scenario's latch, and a live position must never be
 * told it "ran away without filling" and have its levels reopened. A miss the user said to let go (`on_away: pass`) is
 * no reason either — they answered that edge at build time. Pure.
 */
export function redrawOf(setup) {
    if (!setup || !PRE_ENTRY.includes(setup.status)) return null
    const states = setup.monitor_state?.scenarios ?? {}
    const byId = new Map((setup.scenarios ?? []).map(sc => [sc.id, sc]))
    const hit = (status) => Object.entries(states).filter(([id, s]) => s?.invalidation_status === status
        && !(status === 'drifting' && byId.get(id)?.validity?.on_away === 'pass'))
    const fired = hit('fired'), drifting = hit('drifting')
    // Talos's stale-map stamp, unless a scenario has already broken: that is the thing to say (code review).
    if (setup.invalidation_edge === 'time' && !fired.length) return { event: 'stale', reason: setup.invalidation_reason ?? null, scenarios: [] }
    const pick = fired.length ? { event: 'broken', rows: fired } : drifting.length ? { event: 'ran_away', rows: drifting } : null
    // The document's roll-up alone speaks only for an older doc with no per-scenario latches — otherwise a roll-up of
    // let-go misses would come back as a re-draw.
    if (!pick && Object.keys(states).length) return null
    if (!pick) {
        if (setup.invalidation_status === 'fired') return { event: 'broken', reason: setup.invalidation_reason ?? null, scenarios: [] }
        if (setup.invalidation_status === 'drifting') return { event: 'ran_away', reason: setup.invalidation_reason ?? null, scenarios: [] }
        return null
    }
    return {
        event:     pick.event,
        reason:    pick.rows[0][1]?.invalidation_reason ?? setup.invalidation_reason ?? null,
        scenarios: pick.rows.map(([id]) => byId.get(id)?.name ?? id),
    }
}

/** The build with its ACTIVE name reopened for a re-draw. */
// THE REOPEN HAS TO LAST THE TURN (2026-11-05, NXST). The old spans and entries left on the draft were claimed again on the
// redraw turn, and a build the user once told to "go all the way" settled them by itself: the ledger was finished again
// before Mentor had drawn anything. So the reopened stages lose their content, as an `unsettle` does, and "go all the way"
// goes with them. It answered the old build; this one comes back to the user.
function _reopenedDraft(stored) {
    const { spans: _spans, entries: _entries, ...rest } = stored
    const build = normalizeBuild(stored.build)
    const name = activeName(build)
    return { ...rest, build: name ? putName({ ...build, waiver: false, delegated: [] }, reopenForRedraw(name).name) : build }
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
    // A setup closed in the chat keeps the conversation that closed it (sessionTurn).
    sealAfterTurn: (result) => (result.closedSetup
        ? { kind: 'setup', entityIds: [result.closedSetup.id], name: result.closedSetup.asset ? `${result.closedSetup.asset} setup` : null }
        : null),
    run: async ({ state, input, emit, common, sessionId }) => mentorAgentService.chatStream({
        ...common,
        // Prometheus's read on the build's name for its confirmed horizon — checked by code every turn (step 3).
        prometheusRead: await _prometheusRead(state, sessionId),
        // …and again after the turn, when the turn itself confirmed the horizon (CR 2026-11-11: Generate lit, then refused).
        readNow: (target) => readFor(target.symbol, target.horizon, undefined, { sessionId }),
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
    stateFields: ['setup', 'setups', 'scenarioOffer', 'drafts', 'gate', 'readiness', 'coverage', 'build'],
}
