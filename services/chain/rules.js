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

// How many names of an investing list go to research — the client's RESEARCH_TOP_N, moved.
export const RESEARCH_TOP_N = 4

/** An artifact the reply hands on, or null. */
export function emitted(agent, payload, state) {
    // Argus in single-pick mode names ONE ticker for the build desk.
    if (agent === 'scanner' && state?.handoff && payload?.kairos_pick?.ticker) {
        const pick = payload.kairos_pick
        return makeArtifact({
            kind:  KIND.CANDIDATE_LIST,
            items: [{
                ticker:           pick.ticker,
                direction:        pick.direction === 'short' ? 'short' : 'long',
                thesis:           pick.thesis ?? null,
                analysis:         pick.analysis ?? pick.thesis ?? null,
                recommended_mode: pick.recommended_mode ?? null,
            }],
            from: { agent: 'scanner', label: 'Scan' },
        })
    }
    return null
}

/** A finished chain: nothing left to tap — its choices, its pending step and its in-flight step all go. */
export const endedChain = (chain) => ({ ...chain, status: 'done', awaiting: null, next: null, current: null, pending: null, pauseRequested: false })

/** The research queue an investing list becomes when the user says "research the top N". */
export function researchQueueFrom(scan) {
    const names = (scan?.candidates ?? []).map(c => c?.ticker).filter(Boolean)
    const queue = names.slice(0, RESEARCH_TOP_N)
    if (!queue.length) return null
    const sector = scan?.thesis ?? scan?.sector ?? null
    return makeArtifact({
        kind:    KIND.CANDIDATE_LIST,
        items:   queue.map(ticker => ({ ticker, ...(scan.candidates.find(c => c?.ticker === ticker) ?? {}) })),
        context: { queued: true, pool: names, sector, bySector: [{ sector, names: queue }] },
        from:    { agent: 'scanner', label: 'Screen' },
    })
}

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
    if (agent === 'scanner' && payload.scan && !state?.handoff) {
        const investing = payload.scan.profile === 'investing' || state?.profile === 'investing'
        const n = Math.min(RESEARCH_TOP_N, payload.scan.candidates?.length ?? 0)
        return investing && n
            ? { question: 'Argus has a list', choices: [{ id: 'research', label: `Research the top ${n}` }, { id: 'keep', label: 'Just keep the list' }] }
            : { question: 'Argus has a list', choices: [] }
    }
    if (agent === 'analyst' && payload.coverage) {
        const q = chain?.queue
        const more = q && q.index + 1 < q.artifact.items.length
        return { question: 'Prometheus has a draft', choices: q ? [{ id: 'next', label: more ? 'Next name' : 'Finish the run' }] : [] }
    }
    return null
}
