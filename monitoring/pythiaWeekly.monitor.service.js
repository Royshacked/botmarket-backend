// Pythia's weekly monitor — runs the change scan and its assessments when the engine has a new price run
// (docs/design/pythia-assessment.md §8; replaced the industry-screen monitor, 2026-10-11).
//
// The engine's screener job writes the price run weekly (aether-engine render.yaml, Sunday 08:00 UTC). Rather
// than a second clock that must stay in step with that one, this loop watches for the RESULT: every
// CHECK_INTERVAL_MS it asks whether the latest complete run has a finished week, and when it does not, runs
// (or resumes) one. A run the engine marked PARTIAL is never scanned (latestRun reads complete runs only).
// Opt-in (PYTHIA_WEEKLY): off, no week is scanned or assessed.
//
// THE PICK-UP RUNS EITHER WAY (2026-10-28). A finished week's names are researched whether or not the switch is on: on
// prod a week run by hand (2026-10-20, PYTHIA_WEEKLY unset) handed its 30 names on once, found a run going, left them
// "to the monitor's next tick" — and the tick, off, never came: eight days queued, never claimed. The switch gates
// starting Pythia's weeks (her assessments' spend); the names of a week someone already ran are inside the research
// budget (HOUSE_RESEARCH_MAX_USD) like any other.

import { createPollLoop } from './pollLoop.js'
import { runWeekly, resumeResearch, checkEngine } from '../services/pythiaWeekly.service.js'
import { config } from '../services/config.js'

const LOG = '[pythiaWeeklyMonitor]'
export const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000

// THE ENGINE CAN STALL (docs/design/pythia-two-verdicts.md §3; 2026-10: three weeks on the 10-07 run, nobody told). Each
// tick also asks how old the latest run is: stale, every admin gets one card (checkEngine), and — at most once a day —
// a DUE pass assesses what is due by the clock (long-term reviews, expired assessments) on the old prices, so the
// long-term book is never left unreviewed while the engine is down.
export const DUE_PASS_EVERY_MS = 24 * 60 * 60 * 1000
let _duePassAt = 0
/** Test seam. */
export function _resetDuePass() { _duePassAt = 0 }

const _deps = { enabled: () => config.pythiaWeekly, run: () => runWeekly(), resume: () => resumeResearch(),
    engine: () => checkEngine(), runDue: () => runWeekly({ dueOnly: true }), now: () => Date.now() }
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * One check. → the run's result (with the research pick-up's as `research`), or `{ outcome: 'off', research }`. Never
 * throws (neither callee does). After the week, the recent done weeks' research is picked up (house-research-chain.md
 * step 6): names a dead run left, or a budget that waited on a busy run — the switch off too (above).
 */
export async function _tick(deps = _deps) {
    if (!deps.enabled()) return { outcome: 'off', research: await deps.resume() }
    const week = await deps.run()
    const engine = await (deps.engine?.() ?? null)
    let due = null
    if (engine?.stale && deps.runDue && deps.now() - _duePassAt >= DUE_PASS_EVERY_MS) {
        _duePassAt = deps.now()
        due = await deps.runDue()
    }
    const research = await deps.resume()
    return { ...week, research, ...(engine ? { engine } : {}), ...(due ? { due } : {}) }
}

const _loop = createPollLoop({ intervalMs: CHECK_INTERVAL_MS, tick: () => _tick(), eager: false, log: LOG, name: 'pythia weekly' })

export const pythiaWeeklyMonitorService = { start: () => _loop.start(), stop: () => _loop.stop() }
