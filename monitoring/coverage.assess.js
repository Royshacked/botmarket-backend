// Coverage monitor — the deterministic gap-classification core (P5 of the Analyst). PURE, no I/O.
//
// The key insight: monitoring a research thesis is NOT "did price hit the target." It's tracking THE GAP
// between OUR view and the Street as the world updates — is the Street converging to us (thesis playing
// out, edge closing) or diverging (we're increasingly contrarian)? These pure functions classify that
// movement from fresh price + fresh consensus vs the coverage's stored target + last-seen consensus.
// The monitor service (coverage.monitor.service.js) fetches the fresh data and applies the verdict; the
// full re-model + text-kill-criteria judgment is the LLM tier on top of this.

const BULLISH = new Set(['buy', 'strong_buy'])
const BEARISH = new Set(['sell', 'strong_sell'])

// A consensus PT move below this (%) is noise, not a signal.
export const CONSENSUS_MOVE_PCT = 2

const _num = v => (Number.isFinite(Number(v)) ? Number(v) : null)
const _round2 = x => Math.round(x * 100) / 100

/** Recompute the gap (our PT vs the Street's). Pure. null when either side is missing. */
export function recomputeGap(ourPt, consensusPt) {
    const o = _num(ourPt), c = _num(consensusPt)
    if (o === null || c === null || c === 0) return null
    return { our_pt: o, consensus_pt: c, pct: _round2((o - c) / c * 100) }
}

/**
 * Classify how a coverage thesis is tracking, from fresh { price, consensus_pt }. Returns
 * { state, reason, edge_gone }:
 *   target_hit    — price reached our PT (edge_gone if the Street has also caught up = the market agrees)
 *   thesis_broken — price fell through the invalidation edge (bear for a long / bull for a short)
 *   validating    — the Street's PT is moving TOWARD ours (they're catching up; thesis playing out)
 *   diverging     — the Street's PT is moving AWAY from ours (we're increasingly contrarian)
 *   stable        — no material change
 * Direction comes from OUR rating (buy → bullish, sell → bearish; hold → neutral, only bounds fire).
 */
export function classifyGapState(coverage, fresh = {}) {
    const ourPt  = _num(coverage?.price_target?.value)
    const price  = _num(fresh.price)
    const freshC = _num(fresh.consensus_pt)
    const oldC   = _num(coverage?.gap?.consensus_pt)
    const rr     = coverage?.risk_reward || {}
    const bull   = _num(rr.bull), bear = _num(rr.bear)
    const bullish = BULLISH.has(coverage?.rating)
    const bearish = BEARISH.has(coverage?.rating)

    // 1. Price through the invalidation edge → thesis broken (deterministic kill).
    if (bullish && bear !== null && price !== null && price <= bear) return { state: 'thesis_broken', reason: `price ${price} ≤ bear case ${bear}`, edge_gone: false }
    if (bearish && bull !== null && price !== null && price >= bull) return { state: 'thesis_broken', reason: `price ${price} ≥ bull case ${bull}`, edge_gone: false }

    // 2. Target hit — edge_gone when the Street has also arrived (nothing differentiated left).
    if (ourPt !== null && price !== null) {
        if (bullish && price >= ourPt) return { state: 'target_hit', reason: `price ${price} reached PT ${ourPt}`, edge_gone: freshC !== null && freshC >= ourPt }
        if (bearish && price <= ourPt) return { state: 'target_hit', reason: `price ${price} reached PT ${ourPt}`, edge_gone: freshC !== null && freshC <= ourPt }
    }

    // 3. Consensus movement — is the Street catching up to us, or moving away?
    if (freshC !== null && oldC !== null && oldC !== 0) {
        const movePct = (freshC - oldC) / oldC * 100
        if (Math.abs(movePct) >= CONSENSUS_MOVE_PCT) {
            const up = movePct > 0
            const note = `Street PT ${oldC}→${freshC}`
            if (bullish) return up ? { state: 'validating', reason: `${note} (catching up)`, edge_gone: false } : { state: 'diverging', reason: `${note} (moving away)`, edge_gone: false }
            if (bearish) return up ? { state: 'diverging', reason: `${note} (moving away)`, edge_gone: false } : { state: 'validating', reason: `${note} (catching down)`, edge_gone: false }
        }
    }

    return { state: 'stable', reason: 'no material change', edge_gone: false }
}

// A classified state → the coverage `status` it should move to (null = leave status unchanged; the
// gap/revision still get written). validating/diverging keep the thesis ACTIVE — they're signals, not
// terminal. target_hit / thesis_broken are terminal-but-kept-for-the-record.
export function statusForState(state) {
    if (state === 'target_hit')    return 'target_hit'
    if (state === 'thesis_broken') return 'thesis_broken'
    return null   // validating / diverging / stable → status stays as-is
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When to check this coverage next (ISO), from a base time. Terminal states stop (null). Active theses
 * check daily; a catalyst within 3 days pulls the next check to ~daily too (already daily) — kept simple:
 * a dated catalyst that is imminent flags a sooner wake at the day boundary. Pure.
 */
export function nextCheckAt(coverage, state, baseMs) {
    if (state === 'target_hit' || state === 'thesis_broken') return null   // terminal — stop watching
    return new Date(baseMs + DAY_MS).toISOString()
}
