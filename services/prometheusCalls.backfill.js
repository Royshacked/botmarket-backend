// The scorecard's SEED (Roy, 2026-10-27: "seed and mark") — Prometheus's calls from before the scorecard, rebuilt from each
// coverage document's revision trail. The trail is append-only and each revision keeps what it changed as `{ from, to }`,
// so walking it back from today's document gives every state the call was in, and each change of rating, target or
// horizon is a call (prometheusCalls.isNewCall). Logged as `source: 'backfill'`, shown apart from the forward record.
//
// Pure: a coverage document in, its calls out.

import { isNewCall } from './prometheusCalls.service.js'
import { RERATE_KIND } from './ratingBands.js'

/**
 * A coverage document → its calls, oldest first: `[{ state, prev, at }]`, `state` the call (a coverage-shaped object:
 * id, symbol, sector, rating, price_target), `prev` the state before it (null for the first), `at` when it was made — the
 * first call at its target's `set_at` (else the document's `created_at`), each later one at its revision's `at`. Pure.
 */
export function callsFromTrail(cov) {
    const base = { id: cov.id, symbol: cov.symbol, sector: cov.sector ?? null }
    // Walk back from today: the state BEFORE each revision is today's with that revision's `from` values put back.
    let state = { ...base, rating: cov.rating ?? null, price_target: cov.price_target ?? null }
    const steps = []
    for (const rev of cov.revisions ?? []) { // newest first
        const ch = rev?.changed ?? {}
        if (!ch.rating && !ch.price_target) continue
        const before = { ...state, ...(ch.rating ? { rating: ch.rating.from ?? null } : {}), ...(ch.price_target ? { price_target: ch.price_target.from ?? null } : {}) }
        // A RELABEL (the house's rating bands, RERATE_KIND) is undone like any change — the states before it are his —
        // but it is not a call: no step for it.
        if (rev.kind !== RERATE_KIND) steps.unshift({ state, at: rev.at })
        state = before
    }
    const out = []
    let prev = null
    const first = state
    const firstAt = first.price_target?.set_at ?? cov.created_at
    if (isNewCall(null, first) && firstAt) { out.push({ state: first, prev: null, at: firstAt }); prev = first }
    for (const s of steps) {
        if (!s.at || !isNewCall(prev, s.state)) continue
        out.push({ state: s.state, prev, at: s.at })
        prev = s.state
    }
    return out
}
