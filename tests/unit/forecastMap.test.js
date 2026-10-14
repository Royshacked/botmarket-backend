import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildMap, tileMoves, forecastMapService, _setForecastMapIO, COMPANY_LIMIT } from '../../api/strategy/forecastMap.service.js'
import { getIndustryCompanies } from '../../api/strategy/strategy.controller.js'

// The Forecasts heat map (Roy, 2026-10-14): every sub-industry as a tile coloured by its LATEST move, Pythia's verdict
// on top, and an opened tile's companies marked where Prometheus covers them.

const SUBS = [
    { code: '45301020', name: 'Semiconductors', sector: 'Information Technology', industry_group: 'Semis & Equipment', industry: 'Semiconductors' },
    { code: '10102010', name: 'Integrated Oil & Gas', sector: 'Energy', industry_group: 'Energy', industry: 'Oil, Gas & Consumable Fuels' },
]
const TIMING = [{ code: '45301020', asof: '2026-10-10', raw: { rel_1m: 0.04, rel_3m: 0.12, ret_12m: 0.6, spy_12m: 0.15, ret_24m: 1.4, spy_24m: 0.3, hype: true } }]
const ASSESS = [
    { id: 'ia_ind_45301020', subject: { kind: 'industry', code: '45301020', name: 'Semiconductors', sector: 'Information Technology' },
        verdict: 'interesting_trade', horizon: 'months', thesis: 'AI capex still rising.', confidence: 'high', cause: { kind: 'money' },
        moved: { hype: true }, assessed_at: '2026-10-11T00:00:00Z', expires_at: '2026-11-22T00:00:00Z' },
]

test('tileMoves: the latest run in the tile\'s words — excess computed, hype a boolean', () => {
    const m = tileMoves(TIMING[0])
    assert.equal(m.rel_3m, 0.12)
    assert.ok(Math.abs(m.excess_12m - 0.45) < 1e-9)
    assert.ok(Math.abs(m.excess_24m - 1.1) < 1e-9)
    assert.equal(m.hype, true)
    assert.equal(m.asof, '2026-10-10')
    assert.equal(tileMoves(null), null)
})

test('buildMap: every sub-industry is a tile — verdict, confidence and coverage count where there are some', () => {
    const map = buildMap({ subs: SUBS, timing: TIMING, assessments: ASSESS, placed: { NVDA: { sub_code: '45301020' }, AMD: { sub_code: '45301020' } },
        covered: ['NVDA', 'AMD', 'ZZZ'], asof: '2026-10-10' })
    assert.equal(map.tiles.length, 2)
    const semi = map.tiles.find(t => t.code === '45301020')
    // A legacy word reads in today's.
    assert.equal(semi.assessment.verdict, 'swing')
    assert.equal(semi.assessment.confidence, 'high')
    assert.equal(semi.assessment.thesis, 'AI capex still rising.')
    assert.equal(semi.covered, 2)
    assert.equal(semi.moves.rel_3m, 0.12)
    const oil = map.tiles.find(t => t.code === '10102010')
    assert.equal(oil.assessment, null)
    assert.equal(oil.moves, null)
    assert.equal(oil.covered, 0)
    // A covered name with no GICS home is reachable nowhere on the map — it is listed beside it.
    assert.deepEqual(map.unmapped, ['ZZZ'])
    assert.deepEqual(map.covered_at, { NVDA: '45301020', AMD: '45301020' })
    assert.equal(map.asof, '2026-10-10')
})

test('buildMap: a theme assessment is not a tile', () => {
    const map = buildMap({ subs: SUBS, assessments: [{ subject: { kind: 'theme', id: 'th_ai', code: '45301020' }, verdict: 'avoid' }] })
    assert.equal(map.tiles.find(t => t.code === '45301020').assessment, null)
})

test('readMap: joins the sources and skips the placement read on an empty book', async () => {
    let placedCalls = 0
    _setForecastMapIO({
        subs: async () => SUBS, timing: async () => ({ asof: '2026-10-10', rows: TIMING }), assessments: async () => ASSESS,
        covered: async () => [], placed: async () => { placedCalls++; return {} },
    })
    const map = await forecastMapService.readMap()
    assert.equal(map.tiles.length, 2)
    assert.equal(placedCalls, 0)
})

const co = (symbol, cap) => ({ symbol, name: `${symbol} Inc`, market_cap: cap })

test('readCompaniesFor: largest first, covered marked, and a covered name past the cap still listed', async () => {
    const top = Array.from({ length: COMPANY_LIMIT }, (_, i) => co(`S${i}`, 1000 - i))
    let asked = null
    _setForecastMapIO({
        sub: async () => ({ sub: { code: '45301020', name: 'Semiconductors', answered_at: { level: 'sub_industry', code: '45301020' } } }),
        companies: async (level, code, { limit }) => { assert.equal(limit, COMPANY_LIMIT); return top },
        covered: async () => ['S3', 'TINY'],
        coveredIn: async (field, code, symbols) => { asked = { field, code, symbols }; return [co('TINY', 5)] },
    })
    const out = await forecastMapService.readCompaniesFor('45301020')
    assert.equal(out.level, 'sub_industry')
    assert.equal(out.companies.length, COMPANY_LIMIT + 1)
    assert.equal(out.companies.find(c => c.symbol === 'S3').covered, true)
    assert.equal(out.companies.find(c => c.symbol === 'S4').covered, false)
    assert.deepEqual(out.companies.at(-1), { symbol: 'TINY', name: 'TINY Inc', market_cap: 5, covered: true })
    // Only the covered names NOT already listed are looked for, at the listed level.
    assert.deepEqual(asked, { field: 'sub_code', code: '45301020', symbols: ['TINY'] })
})

test('readCompaniesFor: a thin sub-industry lists the level that answers it, and says so', async () => {
    const levels = []
    _setForecastMapIO({
        sub: async () => ({ sub: { code: '20106015', name: 'Tiny Sub', answered_at: { level: 'industry', code: '201060', name: 'Machinery' } } }),
        companies: async (level) => { levels.push(level); return level === 'sub_industry' ? [co('A', 1)] : [co('A', 1), co('B', 2), co('C', 3)] },
        covered: async () => [],
        coveredIn: async () => { throw new Error('not asked on an empty book') },
    })
    const out = await forecastMapService.readCompaniesFor('20106015')
    assert.deepEqual(levels, ['sub_industry', 'industry'])
    assert.equal(out.level, 'industry')
    assert.equal(out.level_name, 'Machinery')
    assert.equal(out.companies.length, 3)
})

test('GET /industries/:code/companies: an unknown code is a 404', async () => {
    _setForecastMapIO({ sub: async () => null })
    const res = { code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this }, send(b) { this.body = b; return this } }
    await getIndustryCompanies({ params: { code: '99999999' }, user: { role: 'user' } }, res)
    assert.equal(res.code, 404)
})
