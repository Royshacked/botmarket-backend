// Argus — scans the market for a ranked watchlist, or validates one name for a trade. Working state:
// the conversation-long mode (`profile`, `handoff`, `handoffTo`, `radar`, `radarBoard`) and the list
// being edited (`editList`).
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { scannerAgentService } from '../agents/scanner.agent.service.js'
import { scannerActions, scannerApplyEdit, scannerReason } from './actions/scanner.actions.js'

// A radar board rides on the session turn and is KEPT in the agent's state for the cut (and for the run ids the
// saved list is stamped with), so it is capped: the universe is a few dozen names, this is a guard, not a limit.
const RADAR_MAX = 200

/** A radar board from a session turn: an object with a candidate list, capped. Null otherwise. */
export function _radarBoard(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.candidates) || !raw.candidates.length) return null
    return { ...raw, candidates: raw.candidates.slice(0, RADAR_MAX), runIds: Array.isArray(raw.runIds) ? raw.runIds.slice(0, RADAR_MAX).map(String) : [] }
}

/** The mode fields, validated — the same whitelist whichever caller supplies them. */
export function _scannerMode(raw = {}) {
    const { editList, handoff, handoffTo, radar, radarBoard, profile } = raw ?? {}
    return {
        editList:   editList && typeof editList === 'object' ? editList : null,
        handoff:    handoff === true,
        // Which desk the pick goes back to. Whitelisted rather than passed through: this string lands
        // in the prompt, and an unknown value degrades to the generic phrasing instead of putting
        // whatever the body carried in front of the user.
        handoffTo:  handoffTo === 'mentor' ? handoffTo : null,
        // The Events radar handed over a universe: the mode flag, and the board it applies to. The
        // board is built server-side (aetherScanUniverse) and handed straight back, so the only thing
        // worth checking here is its shape — the prompt renders whatever it holds.
        radar:      radar === true,
        radarBoard: radarBoard && typeof radarBoard === 'object' ? radarBoard : null,
        profile:    profile === 'investing' ? 'investing' : 'trading',
    }
}

/**
 * The working state after a turn: the mode carries over unchanged, the list in progress is the newest
 * one Argus emitted, and while a saved scan is being edited that list is what the next turn refines.
 * A turn that brought a radar board puts Argus in radar mode for the cut (`prepared`, the turn's input).
 * A NEW LIST HAS NO VERDICT YET: the Prometheus read belongs to the list it ran on, so a re-emitted list clears it.
 */
export function scannerNextState(prev, result, prepared = {}) {
    const pendingScan   = result.scan ?? prev?.pendingScan ?? null
    const editingScanId = prev?.editingScanId ?? null
    return {
        ..._scannerMode(prev),
        ...(prepared?.radarBoard ? { radar: true, radarBoard: prepared.radarBoard } : {}),
        pendingScan,
        editingScanId,
        editList: editingScanId ? pendingScan : null,
        readCut: result.scan ? null : (prev?.readCut ?? null),
    }
}

export const scannerDesk = {
    agent: 'scanner',
    log:   '[scanner:desk]',
    parse: (body) => ({ state: _scannerMode(body) }),
    // The session turn's radar board (the Floor's "scan the radar") — validated and capped before it reaches the prompt.
    prepareInput: (input = {}) => ({ ...input, radarBoard: _radarBoard(input.radarBoard) }),
    nextState: scannerNextState,
    // Unsealed work: a list in progress, or a saved one being edited.
    hasWork: (state) => !!(state?.pendingScan || state?.editingScanId),
    // A route LANDS here: new work, so the mode is the route's own (the trade desk's single-pick preset,
    // or a plain list) — never what a previous route left behind. The lens (profile) is the user's and stays.
    onRouted: (prev, preset) => ({ ..._scannerMode({ profile: prev?.profile, ...(preset ?? {}) }), pendingScan: null, editingScanId: null }),
    // Refining a saved list: its fields are the list in progress, and the next turn refines it.
    stateFromEntity: (scan) => {
        const pendingScan = { period: scan?.period, thesis: scan?.thesis, direction: scan?.direction, candidates: scan?.candidates ?? [] }
        return { ..._scannerMode({ profile: scan?.profile }), pendingScan, editingScanId: scan?.id ?? null, editList: pendingScan }
    },
    run: ({ state, input = {}, emit, common }) => scannerAgentService.chatStream({
        ...common,
        ..._scannerMode(state),
        // The board this turn brought cuts in THIS turn, before nextState has folded it into the mode.
        ...(input.radarBoard ? { radar: true, radarBoard: input.radarBoard } : {}),
        onTicker: (symbol) => emit('ticker', { symbol }),
        onPhase:  (phase)  => emit('phase',  { phase }),
    }),
    // The session's commits and direct edits (plan phase 8, K2/K3) — services/desks/act.js runs them.
    actions:   scannerActions,
    applyEdit: scannerApplyEdit,
    reasons:   scannerReason,
    stateFields: ['scan'],
    // `kairos_pick` (hand-off mode) → the single ticker Argus recommends back to the build desk.
    // The wire name outlived the desk it was written for; the client reads it by this name.
    done: (result) => ({ reply: result.reply, scan: result.scan ?? null, phase: result.phase ?? null, ...(result.pick ? { kairos_pick: result.pick } : {}) }),
}
