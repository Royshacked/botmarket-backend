// The chain's two declared tables (unified-chat plan phase 5c, G4) — read from the `done` payload, never
// from the model's say-so:
//
//   emitted(agent, payload, state)   what in a reply is an artifact to hand on, or null
//   decisionFor(...)                 what makes a turn the USER's call, or null
//
// A decision wins over an emit: a turn that needs the user stops the chain even if it also produced
// something. A route (the user asked for another desk) stops the chain without a decision — the floor
// moves and the user's next message is the next turn.

import { KIND, makeArtifact } from './artifact.js'

/** An artifact the reply hands on, or null. */
export function emitted(agent, payload, state) {
    // Argus in single-pick mode names ONE ticker for the build desk.
    if (agent === 'scanner' && state?.handoff && payload?.argus_pick?.ticker) {
        const pick = payload.argus_pick
        return makeArtifact({
            kind:  KIND.CANDIDATE_LIST,
            items: [{
                ticker:           pick.ticker,
                direction:        pick.direction === 'short' ? 'short' : 'long',
                thesis:           pick.thesis ?? null,
                analysis:         pick.analysis ?? pick.thesis ?? null,
            }],
            from: { agent: 'scanner', label: 'Scan' },
        })
    }
    return null
}

/** A finished chain: nothing left to tap — its choices, its pending step and its in-flight step all go. */
export const endedChain = (chain) => ({ ...chain, status: 'done', awaiting: null, next: null, current: null, pending: null, pauseRequested: false })

/**
 * The user's call, or null. `choices` are the taps the decision offers (ids the continue route takes);
 * none means the user answers by typing, or with the desk's own card in the side pane.
 * @returns {{ question: string, choices: { id: string, label: string }[] } | null}
 */
export function decisionFor(agent, payload, state, chain = null) {
    if (!payload) return null
    if (agent === 'mentor' && (payload.gate || payload.setups || (payload.setup && payload.readiness?.ready))) {
        return { question: 'Mentor needs your call', choices: [] }
    }
    if (agent === 'portfolio' && (payload.plan || payload.update || payload.mandate)) {
        return { question: 'Atlas has a proposal for you', choices: [] }
    }
    if (agent === 'analyst' && payload.coverage) {
        const q = chain?.queue
        const more = q && q.index + 1 < q.artifact.items.length
        return { question: 'Prometheus has a draft', choices: q ? [{ id: 'next', label: more ? 'Next name' : 'Finish the run' }] : [] }
    }
    return null
}
