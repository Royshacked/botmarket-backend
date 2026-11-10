// Argus — finds ONE name for Mentor to build a trade on. Since 2026-11-09 that is all the desk does: the
// list-building chat, the saved lists and the radar cut are archived (archive/README.md), and the full desk as it
// was is archive/services/desks/scanner.desk.js. Working state: the hand-off mode only (scannerMode.js).
// Reached only by Mentor's route (registry: routedFrom) — Axl and the other desks cannot send anyone here.

import { scannerAgentService } from '../agents/scanner.agent.service.js'
import { scannerMode as _scannerMode } from './scannerMode.js'

// Kept under its old name for the callers that import it from the desk.
export { _scannerMode }

/** The working state after a turn: the mode, and nothing else — a pick is handed on by the chain, never held. */
export function scannerNextState() {
    return _scannerMode()
}

export const scannerDesk = {
    agent: 'scanner',
    log:   '[scanner:desk]',
    nextState: scannerNextState,
    // A route LANDS here (Mentor's, the only one there is): always the single pick for Mentor.
    onRouted: () => _scannerMode(),
    run: ({ common, emit }) => scannerAgentService.chatStream({
        ...common,
        ..._scannerMode(),
        onTicker: (symbol) => emit('ticker', { symbol }),
        onPhase:  (phase)  => emit('phase',  { phase }),
    }),
    // `argus_pick` → the single ticker Argus recommends back to Mentor. The chain (services/chain/rules.js) reads it by this name; the client reads neither name.
    done: (result) => ({ reply: result.reply, phase: result.phase ?? null, ...(result.pick ? { argus_pick: result.pick } : {}) }),
}
