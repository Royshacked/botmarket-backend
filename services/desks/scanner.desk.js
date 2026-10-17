// Argus — scans the market for a ranked watchlist, or validates one name for a trade. Working state:
// the conversation-long mode (`profile`, `handoff`, `handoffTo`, `radar`, `radarBoard`) and the list
// being edited (`editList`).
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { scannerAgentService } from '../agents/scanner.agent.service.js'

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
 */
export function scannerNextState(prev, result) {
    const pendingScan   = result.scan ?? prev?.pendingScan ?? null
    const editingScanId = prev?.editingScanId ?? null
    return {
        ..._scannerMode(prev),
        pendingScan,
        editingScanId,
        editList: editingScanId ? pendingScan : null,
    }
}

export const scannerDesk = {
    agent: 'scanner',
    log:   '[scanner:desk]',
    parse: (body) => ({ state: _scannerMode(body) }),
    nextState: scannerNextState,
    // A route LANDS here: new work, so the mode is the route's own (the trade desk's single-pick preset,
    // or a plain list) — never what a previous route left behind. The lens (profile) is the user's and stays.
    onRouted: (prev, preset) => ({ ..._scannerMode({ profile: prev?.profile, ...(preset ?? {}) }), pendingScan: null, editingScanId: null }),
    // Refining a saved list: its fields are the list in progress, and the next turn refines it.
    stateFromEntity: (scan) => {
        const pendingScan = { period: scan?.period, thesis: scan?.thesis, direction: scan?.direction, candidates: scan?.candidates ?? [] }
        return { ..._scannerMode({ profile: scan?.profile }), pendingScan, editingScanId: scan?.id ?? null, editList: pendingScan }
    },
    run: ({ state, emit, common }) => scannerAgentService.chatStream({
        ...common,
        ..._scannerMode(state),
        onTicker: (symbol) => emit('ticker', { symbol }),
        onPhase:  (phase)  => emit('phase',  { phase }),
    }),
    // `kairos_pick` (hand-off mode) → the single ticker Argus recommends back to the build desk.
    // The wire name outlived the desk it was written for; the client reads it by this name.
    done: (result) => ({ reply: result.reply, scan: result.scan ?? null, phase: result.phase ?? null, ...(result.pick ? { kairos_pick: result.pick } : {}) }),
}
