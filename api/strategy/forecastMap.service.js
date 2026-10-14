// The Forecasts heat map (Roy, 2026-10-14) — every GICS sub-industry as one tile, coloured by how far its price
// has moved against the market, with Pythia's verdict laid on top; an opened tile lists its companies, marked where
// Prometheus covers them.
//
// DATA, not judgment: this module JOINS what three owners already hold — the engine's latest weekly price run
// (screenerData, the same numbers the change scan reads), Pythia's standing verdicts (industry_assessment), and the
// house coverage book — and decides nothing. The moves are the LATEST run's, not the ones frozen on an assessment:
// a map coloured by a price weeks old would mislead exactly where it is read for (what is moving now).

import { getDb } from '../../providers/mongodb.provider.js'
import { listSubIndustries, readCompaniesBySymbol, readCompanies, readSubIndustry, MIN_OWN_COMPANIES, companiesQuery, COMPANIES } from './industryData.service.js'
import { latestRun, readRun } from './screenerData.service.js'
import { COLLECTION as ASSESSMENTS, ROW_PROJECTION, assessmentRow, factsFor, LEGACY_VERDICTS } from './industryAssessment.service.js'
import { getEngineDb } from '../../services/engineDb.js'
import { coverageService } from '../analyst/coverage.service.js'

/** How many companies an opened tile lists, largest first (Roy, 2026-10-14) — covered names are added past it. */
export const COMPANY_LIMIT = 25

const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The moves a tile is coloured by, from one engine timing row (factsFor's `moved`, trimmed). Pure. */
export function tileMoves(row) {
    const m = factsFor(row).moved
    if (!m) return null
    return {
        asof: m.asof, rel_1m: _num(m.rel_1m), rel_3m: _num(m.rel_3m), excess_12m: _num(m.excess_12m),
        excess_24m: _num(m.excess_24m), hype: m.hype === true,
    }
}

/**
 * The map → `{ asof, tiles, unmapped, covered_at }`. Pure. `subs` are listSubIndustries rows (the hierarchy and names), `timing`
 * the latest run's rows, `assessments` the industry assessment documents (light), `placed` each covered symbol's
 * GICS assignment (readCompaniesBySymbol), `covered` every covered symbol. A tile carries the light assessment row
 * the board already renders (so an opened tile reads its detail through the board's own route) plus `confidence`.
 * `unmapped` are covered symbols with no GICS sub-industry — reachable nowhere on the map, so listed beside it;
 * `covered_at` maps each placed one to its tile, so a card naming a ticker can open it inside its industry.
 */
export function buildMap({ subs = [], timing = [], assessments = [], placed = {}, covered = [], asof = null }) {
    const moves = new Map(timing.filter(r => r?.code).map(r => [r.code, tileMoves(r)]))
    const views = new Map(assessments.filter(a => a?.subject?.kind === 'industry' && a.subject.code).map(a => [a.subject.code, a]))
    const counts = new Map()
    const unmapped = [], coveredAt = {}
    for (const sym of covered) {
        const code = placed[sym]?.sub_code
        if (code) { counts.set(code, (counts.get(code) ?? 0) + 1); coveredAt[sym] = code }
        else unmapped.push(sym)
    }
    const tiles = subs.filter(s => s?.code).map(s => {
        const a = views.get(s.code)
        return {
            code: s.code, name: s.name ?? null, sector: s.sector ?? null,
            industry_group: s.industry_group ?? null, industry: s.industry ?? null,
            moves: moves.get(s.code) ?? null,
            assessment: a ? { ...assessmentRow({ ...a, verdict: LEGACY_VERDICTS[a.verdict] ?? a.verdict }), confidence: a.confidence ?? null } : null,
            covered: counts.get(s.code) ?? 0,
        }
    })
    return { asof, tiles, unmapped: unmapped.sort(), covered_at: coveredAt }
}

const _io = {
    subs: () => listSubIndustries(),
    timing: async () => {
        const run = await latestRun()
        return run ? { asof: run.asof, rows: (await readRun(run.asof)).rows } : { asof: null, rows: [] }
    },
    assessments: async () => (await getDb()).collection(ASSESSMENTS)
        .find({ 'subject.kind': 'industry' }, { projection: { ...ROW_PROJECTION, confidence: 1 } }).toArray(),
    // The live book only: a retired thesis is not "covered" on the map (Roy, 2026-10-14).
    covered: () => coverageService.listSymbols({ live: true }),
    placed: (symbols) => readCompaniesBySymbol(symbols),
    companies: (level, code, opts) => readCompanies(level, code, opts),
    coveredIn: async (field, code, symbols) => (await getEngineDb()).collection(COMPANIES)
        .find({ ...companiesQuery(field, code), symbol: { $in: symbols } },
            { projection: { _id: 0, symbol: 1, name: 1, market_cap: 1, sub_industry: 1 } }).toArray(),
    sub: (code) => readSubIndustry(code),
}
/** Test seam. */
export function _setForecastMapIO(io) { Object.assign(_io, io) }

/** The whole map, read in one pass of each source. */
async function readMap() {
    const [subs, timing, assessments, covered] = await Promise.all([_io.subs(), _io.timing(), _io.assessments(), _io.covered()])
    const placed = covered.length ? await _io.placed(covered) : {}
    return buildMap({ subs, timing: timing.rows, assessments, placed, covered, asof: timing.asof })
}

const FIELD = { sub_industry: 'sub_code', industry: 'industry_code', industry_group: 'group_code', sector: 'sector_code' }

/**
 * One sub-industry's companies, largest first, each marked `covered` → `{ code, name, level, level_name, companies }`,
 * or null for an unknown code. A thin sub-industry (under MIN_OWN_COMPANIES) lists the level that answers it — the
 * rule its numbers and its graded basket follow (industryData.largestCompanies) — and says so in `level`. Covered
 * names below the top COMPANY_LIMIT are added at the end, so no thesis is unreachable from its industry.
 */
async function readCompaniesFor(code) {
    const bundle = await _io.sub(code)
    if (!bundle) return null
    const { sub } = bundle
    let level = 'sub_industry', at = sub.code, levelName = sub.name
    let top = await _io.companies(level, at, { limit: COMPANY_LIMIT })
    const up = sub.answered_at
    if (top.length < MIN_OWN_COMPANIES && up && up.level !== 'sub_industry' && FIELD[up.level]) {
        level = up.level; at = up.code; levelName = up.name ?? null
        top = await _io.companies(level, at, { limit: COMPANY_LIMIT })
    }
    const covered = new Set(await _io.covered())
    const listed = new Set(top.map(c => c.symbol))
    const missing = [...covered].filter(s => !listed.has(s))
    const extra = missing.length ? await _io.coveredIn(FIELD[level], at, missing) : []
    const companies = [...top, ...extra.sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0))].map(c => ({
        symbol: c.symbol, name: c.name ?? null, market_cap: _num(c.market_cap), covered: covered.has(c.symbol),
    }))
    return { code: sub.code, name: sub.name, level, level_name: levelName, companies }
}

export const forecastMapService = { readMap, readCompaniesFor }
