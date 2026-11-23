// PYTHIA'S STANCE ON A COVERAGE CALL (Roy, 2026-11-22: "pythia analyse the industries — is prometheus looking at its
// analysis?"). One pure home for the three readers that need it: the scorecard freezes it on every call (did the calls
// with her do better than the calls against her?), the backfill rebuilds it for the calls made before, and the coverage
// monitor re-models a name when it CHANGES on the name's own book.
//
// THE BOOK is the call's horizon read the way the house chain grades it (researchRun BOOK_PT_HORIZONS): a 3m / 6m target
// is the SWING book — her near-term verdict speaks for it; a 12m+ target (and none: the house's 12m) is LONG TERM — her
// long-term call does, and a near-term AVOID still counts against.
//
// HER VERDICT ON A DAY comes from the assessment's revision trail: each revision keeps `changed.verdict` /
// `changed.long_term` as `{ from, to }`, so walking back from today's document gives what stood then. The expiry is only
// known for today's state (`expires_at` is overwritten each publish): a past state is read as standing.

import { LEGACY_VERDICTS, longTermOf, longTermYes } from '../api/strategy/industryAssessment.service.js'

export const SWING_HORIZONS = Object.freeze(['3m', '6m'])
export const STANCES = Object.freeze(['for', 'against', 'neutral'])

/** A price-target horizon → the book Pythia grades it on: 'swing' | 'long_term'. Pure. */
export const bookOf = (horizon) => (SWING_HORIZONS.includes(String(horizon ?? '').trim().toLowerCase()) ? 'swing' : 'long_term')

/** A near-term verdict in today's words; the pre-split `long_term` verdict reads as no near-term case. Pure. */
const _near = (v) => { const w = LEGACY_VERDICTS[v] ?? v ?? null; return w === 'long_term' ? 'no_case' : w }

/**
 * What Pythia's assessment `doc` said at `iso` → `{ verdict, long_term, assessed_at }`, or null when she had not
 * assessed the industry yet. `verdict` the near term (null once today's has expired), `long_term` 'yes' | 'no' | null.
 * Pure.
 */
export function verdictAt(doc, iso) {
    if (!doc || !iso) return null
    const revs = [...(doc.revisions ?? [])].filter(r => r?.at).sort((a, b) => (a.at < b.at ? 1 : -1))
    const first = revs.at(-1)?.at ?? doc.assessed_at ?? doc.created_at
    if (!first || first > iso) return null
    let verdict = _near(doc.verdict)
    let long_term = longTermOf(doc)?.call ?? null   // a pre-split long-term VERDICT reads as a yes (longTermOf)
    let undone = false
    for (const r of revs) {
        if (r.at <= iso) break
        const ch = r.changed ?? {}
        if (ch.verdict) { verdict = _near(ch.verdict.from); if (ch.verdict.from === 'long_term' && !ch.long_term) long_term = 'yes' }
        if (ch.long_term) long_term = ch.long_term.from ?? null
        undone = true
    }
    // Today's state carries today's clocks: an expired near term no longer speaks; a long-term yes past its stale window
    // neither (longTermYes) — the same reading the house books take.
    if (!undone) {
        if (doc.expires_at && doc.expires_at <= iso) verdict = null
        if (long_term === 'yes' && !longTermYes(doc, iso)) long_term = null
    }
    const assessed = revs.find(r => r.at <= iso)?.at ?? first
    return { verdict, long_term, assessed_at: assessed }
}

/** Her stance on a book from what she said (`verdictAt`) → 'for' | 'against' | 'neutral', or null (nothing said). Pure. */
export function stanceFor(said, horizon) {
    if (!said) return null
    if (bookOf(horizon) === 'swing') {
        if (said.verdict === 'swing') return 'for'
        if (said.verdict === 'avoid') return 'against'
        return said.verdict ? 'neutral' : null
    }
    if (said.long_term === 'yes') return 'for'
    if (said.verdict === 'avoid') return 'against'
    return said.verdict || said.long_term ? 'neutral' : null
}

/**
 * The frozen record on a call: `{ code, industry, book, verdict, long_term, stance, assessed_at }`, or one with
 * `stance: null` and why (no classification, no assessment then). `company` — the name's GICS row (sub_code,
 * sub_industry). Pure.
 */
export function pythiaOnCall({ company = null, doc = null, horizon, at }) {
    const book = bookOf(horizon)
    if (!company?.sub_code) return { code: null, industry: null, book, stance: null, why: 'not classified' }
    const said = verdictAt(doc, at)
    const base = { code: company.sub_code, industry: company.sub_industry ?? doc?.subject?.name ?? null, book }
    if (!said) return { ...base, stance: null, why: 'not assessed then' }
    return { ...base, verdict: said.verdict, long_term: said.long_term, stance: stanceFor(said, horizon), assessed_at: said.assessed_at }
}

/** With her / against her / neither, for a call's DIRECTION (+1 buy, −1 sell) → 'with' | 'against' | 'neutral' | null. Pure. */
export function agreement(direction, stance) {
    if (!direction || !stance) return null
    if (stance === 'neutral') return 'neutral'
    return (stance === 'for') === (direction > 0) ? 'with' : 'against'
}
