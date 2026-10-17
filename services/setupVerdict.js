// A setup draft's verdict — normalised, its readiness, and the build gate open on it.
//
// ONE function for the two callers that ask it: the validate route (a reopened conversation, a keystroke in the
// form) and Mentor's session edit (unified-chat plan phase 8, K3 — the user changed the draft by hand, so the
// gate and readiness the surface draws from are recomputed from the same functions a turn uses).

import { normalizeSetup, setupReadiness } from './setup.schema.js'
import { gateView, normalizeBuild } from './mentorBuild.util.js'

/**
 * @param {object} raw          the draft as the user or the agent left it (may carry its build ledger)
 * @param {boolean} hasAccounts  whether a trading account is marked — part of readiness
 * @returns {{ setup: object, readiness: object, gate: object|null } | null}  null when it is not a usable draft
 */
export function draftVerdict(raw, hasAccounts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const setup = normalizeSetup(raw)
    if (!setup) return null
    return {
        setup,
        readiness: setupReadiness(setup, hasAccounts === true),
        // A Mentor draft carries its build ledger; the gate open on it is what the surface draws its card from.
        gate:      raw.build ? gateView(normalizeBuild(raw.build)) : null,
    }
}
