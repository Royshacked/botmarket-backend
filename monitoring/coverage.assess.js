// Coverage monitor — the deterministic gap-classification core (P5 of the Analyst). PURE, no I/O.
//
// The key insight: monitoring a research thesis is NOT "did price hit the target." It's tracking THE GAP
// between OUR view and the Street as the world updates — is the Street converging to us (thesis playing
// out, edge closing) or diverging (we're increasingly contrarian)? These pure functions classify that
// movement from fresh price + fresh consensus vs the coverage's stored target + last-seen consensus.
// The monitor service (coverage.monitor.service.js) fetches the fresh data and applies the verdict; the
// full re-model + text-kill-criteria judgment is the LLM tier on top of this.

import { toNum as _num } from '../services/format.util.js'

const BULLISH = new Set(['buy', 'strong_buy'])
const BEARISH = new Set(['sell', 'strong_sell'])

// A consensus PT move below this (%) is noise, not a signal.
export const CONSENSUS_MOVE_PCT = 2

const _round2 = x => Math.round(x * 100) / 100

/**
 * A PRICE, or null — the stricter read the terminal verdicts below demand. Only a positive finite
 * number is a price: a missing quote and a zero are both the ABSENCE of information, never evidence
 * that a name collapsed. Reading them as the number 0 is what fired `thesis_broken` on every covered
 * name at once ("price 0 ≤ bear case 597"), because zero compares below any bear case ever written.
 */
const _price = v => {
    const n = _num(v)
    return (n !== null && n > 0) ? n : null
}

/**
 * Recompute the gap — our PT against the Street's whole DISTRIBUTION. Pure. null when either side is
 * missing. `street` accepts the provider's {consensus, high, low, median} or a bare number (then only
 * the mean leg is known).
 *
 * `pctile` — where our PT sits within the Street's own low→high range — is the measure that actually
 * says whether we hold a variant view. A percentage gap to the mean does not: against targets
 * spanning 500–700, being 12% under the mean still leaves us inside everyone else's range.
 */
export function recomputeGap(ourPt, street) {
    const o = _price(ourPt)
    const s = (street && typeof street === 'object') ? street : { consensus: street }
    const c = _price(s.consensus)
    if (o === null || c === null) return null   // _price already excludes 0 (no divide-by-zero)

    const low = _price(s.low), high = _price(s.high), median = _price(s.median)
    const pctile = (low !== null && high !== null && high > low)
        ? _round2(Math.min(100, Math.max(0, (o - low) / (high - low) * 100)))
        : null
    return { our_pt: o, consensus_pt: c, pct: _round2((o - c) / c * 100), low, high, median, pctile }
}

/**
 * Classify how a coverage thesis is tracking, from fresh { price, consensus_pt }. Returns
 * { state, reason, edge_gone }:
 *   target_hit    — price reached our PT (edge_gone if the Street has also caught up = the market agrees)
 *   validating    — the Street's PT is moving TOWARD ours (they're catching up; thesis playing out)
 *   diverging     — the Street's PT is moving AWAY from ours (we're increasingly contrarian)
 *   stable        — no material change
 * Direction comes from OUR rating (buy → bullish, sell → bearish; hold → neutral).
 *
 * There is deliberately NO price-based `thesis_broken` here. Research is not a position: price
 * falling doesn't invalidate a buy thesis, it makes the name CHEAPER. The rule this replaces read
 * `risk_reward.bear` as a stop level, but that band is a ±15% sensitivity around our multiple with
 * EPS held constant (valuation.engine) — for a bullish name it routinely sits ABOVE spot, so the
 * "invalidation edge" was above the market on day one and every thesis broke on its first check.
 * Invalidation belongs where the risk is: the position. A held name's revised PT vs its entry basis
 * is Themis's gate; the text `kill_criteria` are the research-side judgment, for the LLM tier.
 */
export function classifyGapState(coverage, fresh = {}) {
    const ourPt  = _price(coverage?.price_target?.value)
    const price  = _price(fresh.price)
    const freshC = _price(fresh.consensus_pt)
    const oldC   = _price(coverage?.gap?.consensus_pt)
    const bullish = BULLISH.has(coverage?.rating)
    const bearish = BEARISH.has(coverage?.rating)

    // 1. Target hit — edge_gone when the Street has also arrived (nothing differentiated left).
    if (ourPt !== null && price !== null) {
        if (bullish && price >= ourPt) return { state: 'target_hit', reason: `price ${price} reached PT ${ourPt}`, edge_gone: freshC !== null && freshC >= ourPt }
        if (bearish && price <= ourPt) return { state: 'target_hit', reason: `price ${price} reached PT ${ourPt}`, edge_gone: freshC !== null && freshC <= ourPt }
    }

    // 2. Consensus movement — is the Street catching up to us, or moving away?
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
// gap/revision still get written). Only target_hit moves the status: reaching OUR OWN number is a fact
// about our own thesis. validating/diverging are signals, not verdicts. `thesis_broken` is no longer
// reachable deterministically — it stays in the STATUSES vocabulary for the LLM tier (judging the text
// kill_criteria) and for the user, neither of which this pure function speaks for.
export function statusForState(state) {
    if (state === 'target_hit') return 'target_hit'
    return null   // validating / diverging / stable → status stays as-is
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When to check this coverage next (ISO), from a base time. Pure.
 *
 * ALWAYS a next check: a thesis is living until the user retires it, so no verdict stops the loop.
 * (`retired` is enforced at due-selection, not here — it is a decision, not a classification.) This
 * used to return null on a terminal state, which silently froze a name forever: reaching our target
 * ended the research rather than prompting the next question, and a mistaken verdict was unrecoverable
 * without a manual write.
 */
export function nextCheckAt(coverage, state, baseMs) {
    return new Date(baseMs + DAY_MS).toISOString()
}
