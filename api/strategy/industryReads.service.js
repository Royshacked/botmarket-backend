// INDUSTRY READS — what each industry's own companies and its fund say, measured at industry level.
//
// Written by aether-engine/scripts/build_industry_reads.py (weekly) into `pythia_industry_reads`;
// this module only reads and formats. Pythia points at industries — Argus finds the names and
// Prometheus judges the companies — so every number here is an INDUSTRY number, never a pick.
//
// Two kinds of number, and the difference is the whole point of the read:
//
//   EVIDENCE — sized. beat (share of the industry's companies beating estimates), surprise (how big),
//   momentum (its fund's 12-1 month return over SPY), combined into one cross-sectional score
//   -0.5..+0.5. Tested since 2010 across 61 funds: rank IC +0.083 (t +2.2) against the next 26 weeks
//   over SPY, +0.115 on the tech funds alone — the only evidence that reaches tech, where no macro
//   channel moves the funds.
//
//   CONTEXT — shown, never sized. P/E against its own five years: INVERTED over 2010-2026 (cheap
//   industries kept lagging, IC -0.067), probably an era effect, so it moves no weight either way.
//   Trailing EPS and revenue growth: already priced (IC ~0).
//
// A STALE READ IS WORSE THAN A MISSING ONE, as with the channels: past STALE_DAYS it is headed stale.

import { getDb }  from '../../providers/mongodb.provider.js'
import { toNum }  from '../../services/format.util.js'

export const INDUSTRY_READS_COLLECTION = 'pythia_industry_reads'
export const FUND_EVIDENCE_COLLECTION  = 'pythia_fund_evidence'

/** A weekly job that has missed two runs has stopped. */
export const STALE_DAYS = 16

const DAY_MS = 24 * 60 * 60 * 1000

const _io = {
    reads: async () => (await getDb()).collection(INDUSTRY_READS_COLLECTION).find({}).toArray(),
}
export function _setIndustryIO(io) { Object.assign(_io, io) }

export async function readIndustryReads() {
    return _io.reads()
}

const _pct = (v, d = 0) => { const n = toNum(v); return n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(d)}%` }
const _num = (v, d = 2) => { const n = toNum(v); return n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}` }

/**
 * The reads → LLM-ready text, PURE. Sorted by evidence, best first; `sector` narrows to one sector.
 * Industries with no evidence (fewer than three companies reported recently) are listed apart, so
 * "no read" is never confused with "average".
 */
export function formatIndustryReads(docs, { sector = null, nowMs = Date.now() } = {}) {
    const all = (Array.isArray(docs) ? docs : []).filter(d => d?._id && (!sector || d.sector === sector))
    if (!all.length) {
        return sector
            ? `No industry reads for sector "${sector}". Check the spelling against the eleven sectors.`
            : 'Industry reads are not available — the engine has not written them. Do not argue from industry earnings or momentum as if measured; say they were unavailable.'
    }
    const newest = Math.max(...all.map(d => (d.computed_at instanceof Date ? d.computed_at.getTime() : Date.parse(d.computed_at ?? '')) || 0))
    const age = newest ? Math.floor((nowMs - newest) / DAY_MS) : null
    const scored = all.filter(d => toNum(d.evidence) !== null).sort((a, b) => toNum(b.evidence) - toNum(a.evidence))
    const unscored = all.filter(d => toNum(d.evidence) === null).map(d => d._id).sort()

    const line = (d) => `  ${String(d._id).padEnd(36)} ev ${_num(d.evidence)}   beat ${_pct(d.beat).padStart(5)} (n ${d.n ?? 0})   surprise ${_pct(d.surprise, 1).padStart(6)}   mom ${_pct(d.momentum).padStart(5)}${d.momentum_from ? ` [${d.momentum_from}]` : ''}   ‖ context: P/E ${d.pe ?? '—'} (${_num(d.pe_z, 1)}z vs 5y), EPS g ${_pct(d.eps_g)}, rev g ${_pct(d.rev_g)}`

    return [
        age === null || age > STALE_DAYS
            ? `⚠ STALE INDUSTRY READS — computed ${age === null ? 'at an unknown time' : `${age} days ago`}. Treat them as old and say so.`
            : `INDUSTRY READS — as of ${new Date(newest).toISOString().slice(0, 10)}${sector ? `, sector ${sector}` : ''}. ${scored.length} industries scored, best evidence first.`,
        '',
        'EVIDENCE (sized): ev = average cross-sectional rank of beat (share of the industry\'s companies > $2B that beat estimates last quarter), surprise (median size), mom (its fund\'s 12-1 month return over SPY; [fund] = which fund — an industry with none inherits its sector\'s), centred to -0.5..+0.5. Beat and surprise are pulled toward the middle when few companies reported (n): three companies count for about a quarter of fifty. Measured since 2010: IC +0.09 across funds, +0.15 on tech.',
        'CONTEXT (never sized): P/E z against its own 5 years (+ = expensive vs itself), trailing EPS/revenue growth. Cheapness did NOT pay in 2010-2026 and reported growth is priced — do not argue a stance from either.',
        '',
        ...scored.map(line),
        ...(unscored.length ? ['', `No read (too few recent reports among companies > $2B): ${unscored.join(', ')}.`] : []),
    ].join('\n')
}
