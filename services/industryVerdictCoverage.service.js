// WHEN PYTHIA CHANGES HER MIND, PROMETHEUS HEARS (Roy, 2026-11-22). An assessment that changes her near-term verdict or
// her long-term call re-models the live coverage on names in that sub-industry — only where her STANCE on the name's
// own book moved (pythiaStance: a 3m / 6m target is the swing book, 12m+ the long term), so a swing ↔ watch week
// does not re-research a 24-month thesis. The re-model is queued, never run here: `monitor.pending_revision`
// ('industry_verdict', coverage.service queueRevision), and the coverage monitor's cap, cooldown and card do the rest.
//
// Industries only — a theme's verdict reaches many sub-industries, each with its own assessment. Never throws: the
// assessment is published whatever happens here.

import { readCompaniesBySymbol } from '../api/strategy/industryData.service.js'
import { coverageService, COLLECTION } from '../api/analyst/coverage.service.js'
import { LEGACY_VERDICTS, longTermOf, VERDICTS } from '../api/strategy/industryAssessment.service.js'
import { getDb } from '../providers/mongodb.provider.js'
import { stanceFor, bookOf } from './pythiaStance.js'
import { logger } from './logger.service.js'

const LOG = '[industryVerdictCoverage]'
export const REVISION_STATE = 'industry_verdict'

const _near = (v) => { const w = LEGACY_VERDICTS[v] ?? v ?? null; return w === 'long_term' ? 'no_case' : w }

/**
 * What she said before this publish and what she says now, from the published document and its `changed` →
 * `{ before, after }` (each `{ verdict, long_term }`), or null when neither verdict changed. Pure.
 */
export function verdictChange(doc, changed) {
    if (!changed?.verdict && !changed?.long_term) return null
    const after = { verdict: _near(doc?.verdict), long_term: longTermOf(doc)?.call ?? null }
    const before = {
        verdict: changed.verdict ? _near(changed.verdict.from) : after.verdict,
        long_term: changed.long_term ? (changed.long_term.from ?? null) : after.long_term,
    }
    return { before, after }
}

const _words = (s) => (s ? s.toUpperCase() : 'no stance')

/**
 * The coverages to re-model → `[{ id, symbol, reason }]` — those whose stance on their own book changed. `covs` —
 * live coverage documents in the sub-industry. Pure.
 */
export function coveragesToRevise(covs, change, industry) {
    const out = []
    for (const c of covs ?? []) {
        const horizon = c.price_target?.horizon ?? '12m'
        const from = stanceFor(change.before, horizon), to = stanceFor(change.after, horizon)
        if (from === to) continue
        const book = bookOf(horizon) === 'swing' ? 'swing' : 'long-term'
        const now = bookOf(horizon) === 'swing' ? (VERDICTS[change.after.verdict] ?? change.after.verdict ?? 'none') : `long-term call ${change.after.long_term ?? 'none'}`
        out.push({ id: c.id, symbol: c.symbol, reason: `${industry}: her ${book} stance ${_words(from)} → ${_words(to)} (now ${now})` })
    }
    return out
}

const _deps = {
    liveCoverage: async () => (await getDb()).collection(COLLECTION).find({ status: { $ne: 'retired' } }, { projection: { _id: 0, id: 1, symbol: 1, 'price_target.horizon': 1 } }).toArray(),
    companies: (symbols) => readCompaniesBySymbol(symbols),
    queue: (id, opts) => coverageService.queueRevision(id, opts),
    now: () => new Date().toISOString(),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

/** After an assessment is published → `{ queued, symbols }`. Never throws. */
export async function onAssessmentPublished(doc, changed, deps = _deps) {
    try {
        if (doc?.subject?.kind !== 'industry' || !doc.subject.code) return { queued: 0, symbols: [] }
        const change = verdictChange(doc, changed)
        if (!change) return { queued: 0, symbols: [] }
        const covs = await deps.liveCoverage()
        const companies = await deps.companies(covs.map(c => c.symbol))
        const inIndustry = covs.filter(c => companies[String(c.symbol).toUpperCase()]?.sub_code === doc.subject.code)
        const todo = coveragesToRevise(inIndustry, change, doc.subject.name ?? doc.subject.code)
        const at = deps.now(), symbols = []
        for (const t of todo) if (await deps.queue(t.id, { state: REVISION_STATE, reason: t.reason, at })) symbols.push(t.symbol)
        if (todo.length) logger.info(LOG, 'industry verdict changed — coverage re-models queued', { code: doc.subject.code, queued: symbols.length, of: todo.length, symbols })
        return { queued: symbols.length, symbols }
    } catch (err) {
        logger.warn(LOG, 'coverage not queued for the verdict change (the assessment is published)', { code: doc?.subject?.code, error: err.message })
        return { queued: 0, symbols: [], error: err.message }
    }
}
