import { test } from 'node:test'
import assert from 'node:assert/strict'

import { houseIndustriesFor, industryAssessmentService, _setAssessmentIO, BOOKS } from '../../api/strategy/industryAssessment.service.js'
import { memDb } from '../helpers/memDb.js'

// The house's industries for a book (docs/design/argus-on-pythia.md §3.1): where Argus and the sleeve screen look
// FIRST. A preference read — these tests pin what is listed, what is left out, and the order.

const NOW = '2026-10-13T12:00:00.000Z'
const LATER = '2026-11-30T00:00:00.000Z'
const EARLIER = '2026-10-01T00:00:00.000Z'

const IND = (code, name, sector, verdict, over = {}) => ({
    id: `ia_ind_${code}`, subject: { kind: 'industry', code, name, sector }, verdict, horizon: verdict === 'long_term' ? 'years' : 'weeks',
    thesis: `${name} thesis`, risks: [`${name} risk`, 'second risk'], expires_at: LATER, moved: { hype: false, excess_12m: 0.1 }, ...over,
})
const THEME_ROW = (id, verdict, over = {}) => ({
    id: `ia_${id}`, subject: { kind: 'theme', id, name: id, sector: null }, verdict, horizon: 'months', thesis: `${id} theme thesis`,
    risks: ['theme risk'], expires_at: LATER, moved: { kind: 'theme', hype: false, links: [] }, ...over,
})
const THEME = (id, links, status = 'approved') => ({ id, name: id, status, links })
const LINK = (code, name, sector, order) => ({ code, name, sector, order })

const SEMIS = IND('45301020', 'Semiconductors', 'Information Technology', 'swing', { moved: { hype: true, excess_12m: 0.5 } })
const SOFT  = IND('45103010', 'Application Software', 'Information Technology', 'long_term')
const BANKS = IND('40101015', 'Regional Banks', 'Financials', 'swing', { moved: { hype: false, excess_12m: 0.2 } })
const COAL  = IND('10102050', 'Coal & Consumable Fuels', 'Energy', 'avoid')

test('the books are swing and long term — watch is not a book', () => {
    assert.deepEqual([...BOOKS], ['swing', 'long_term'])
    assert.deepEqual(houseIndustriesFor([IND('1', 'X', 'S', 'watch')], [], { book: 'watch', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([SEMIS], [], { book: 'intraday', now: NOW }), [], 'no book for a session trade')
})

test("an industry rated the book is listed with its own thesis, horizon, top risk and hype; others are not", () => {
    const out = houseIndustriesFor([SEMIS, SOFT, BANKS, COAL], [], { book: 'swing', now: NOW })
    assert.deepEqual(out.map(e => e.code), ['45301020', '40101015'], 'biggest 12-month move first')
    const s = out[0]
    assert.equal(s.rated, true)
    assert.equal(s.thesis, 'Semiconductors thesis')
    assert.equal(s.top_risk, 'Semiconductors risk')
    assert.equal(s.horizon, 'weeks')
    assert.equal(s.hype, true)
    assert.equal(s.avoid, false)
    assert.deepEqual(s.themes, [])
    assert.deepEqual(houseIndustriesFor([SEMIS, SOFT, BANKS, COAL], [], { book: 'long_term', now: NOW }).map(e => e.code), ['45103010'])
})

test('an expired verdict never surfaces', () => {
    const stale = { ...SEMIS, expires_at: EARLIER }
    assert.deepEqual(houseIndustriesFor([stale, BANKS], [], { book: 'swing', now: NOW }).map(e => e.code), ['40101015'])
})

test("the old verdict words read as today's", () => {
    const old = IND('20106010', 'Industrial Machinery', 'Industrials', 'interesting_invest')
    assert.deepEqual(houseIndustriesFor([old], [], { book: 'long_term', now: NOW }).map(e => e.code), ['20106010'])
})

test('sector narrows, case-insensitively', () => {
    assert.deepEqual(houseIndustriesFor([SEMIS, BANKS], [], { book: 'swing', sector: 'financials', now: NOW }).map(e => e.code), ['40101015'])
})

test("a theme rated the book brings its direct and supplier links — not the suppliers' suppliers", () => {
    const theme = THEME('ai_power', [
        LINK('55105010', 'Independent Power Producers', 'Utilities', 1),
        LINK('20104010', 'Electrical Components', 'Industrials', 2),
        LINK('15104020', 'Copper', 'Materials', 3),
    ])
    const row = THEME_ROW('ai_power', 'swing', { moved: { kind: 'theme', hype: false, links: [
        { code: '55105010', excess_12m: 0.4, hype: true }, { code: '20104010', excess_12m: 0.3 },
    ] } })
    const out = houseIndustriesFor([row], [theme], { book: 'swing', now: NOW })
    assert.deepEqual(out.map(e => e.code), ['55105010', '20104010'])
    const ipp = out[0]
    assert.equal(ipp.rated, false, 'not rated on its own — it came through the theme')
    assert.equal(ipp.thesis, null)
    assert.equal(ipp.hype, true, "the link's own hype flag")
    assert.equal(ipp.excess_12m, 0.4)
    assert.deepEqual(ipp.themes, [{ id: 'ai_power', name: 'ai_power', order: 1, horizon: 'months', thesis: 'ai_power theme thesis' }])
})

test('an industry rated on its own AND through a theme is one entry carrying both', () => {
    const theme = THEME('ai', [LINK('45301020', 'Semiconductors', 'Information Technology', 1), LINK('45103010', 'Application Software', 'Information Technology', 1)])
    const out = houseIndustriesFor([SEMIS, THEME_ROW('ai', 'swing')], [theme], { book: 'swing', now: NOW })
    const semis = out.filter(e => e.code === '45301020')
    assert.equal(semis.length, 1)
    assert.equal(semis[0].rated, true)
    assert.equal(semis[0].thesis, 'Semiconductors thesis')
    assert.equal(semis[0].themes.length, 1)
    // Software is rated long term on its own, swing through the theme: listed for swing, from the theme only.
    const soft = out.find(e => e.code === '45103010')
    assert.equal(soft.rated, false)
    assert.equal(soft.horizon, null)
})

test('an industry the house rates AVOID can arrive through a theme — listed, marked', () => {
    const theme = THEME('power', [LINK('10102050', 'Coal & Consumable Fuels', 'Energy', 2), LINK('55105010', 'Independent Power Producers', 'Utilities', 1)])
    const coal = houseIndustriesFor([COAL, THEME_ROW('power', 'long_term')], [theme], { book: 'long_term', now: NOW }).find(e => e.code === '10102050')
    assert.equal(coal.avoid, true)
})

test('a retired theme, an unapproved one, or an expired theme verdict brings nothing', () => {
    const links = [LINK('55105010', 'Independent Power Producers', 'Utilities', 1)]
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing')], [THEME('t', links, 'retired')], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing')], [THEME('t', links, 'proposed')], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing', { expires_at: EARLIER })], [THEME('t', links)], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing')], [], { book: 'swing', now: NOW }), [], 'theme not in the approved list')
})

test("a theme's links are narrowed to the sector too", () => {
    const theme = THEME('ai_power', [LINK('55105010', 'Independent Power Producers', 'Utilities', 1), LINK('20104010', 'Electrical Components', 'Industrials', 2)])
    const out = houseIndustriesFor([THEME_ROW('ai_power', 'swing')], [theme], { book: 'swing', sector: 'Industrials', now: NOW })
    assert.deepEqual(out.map(e => e.code), ['20104010'])
})

test('no move sorts last; ties by name', () => {
    const a = IND('1', 'Beta', 'S', 'swing', { moved: {} })
    const b = IND('2', 'Alpha', 'S', 'swing', { moved: {} })
    const c = IND('3', 'Gamma', 'S', 'swing', { moved: { excess_12m: -0.3 } })
    assert.deepEqual(houseIndustriesFor([a, b, c], [], { book: 'swing', now: NOW }).map(e => e.name), ['Gamma', 'Alpha', 'Beta'])
})

test('empty input is an empty list', () => {
    assert.deepEqual(houseIndustriesFor([], [], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor(null, null, { book: 'swing', now: NOW }), [])
})

test('listForBook reads the stored assessments and the approved themes', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    for (const r of [SEMIS, SOFT, BANKS, THEME_ROW('ai_power', 'swing')]) await m.db.collection('industry_assessment').insertOne(structuredClone(r))
    const themes = async () => [THEME('ai_power', [LINK('20104010', 'Electrical Components', 'Industrials', 2)])]
    const out = await industryAssessmentService.listForBook('swing', { now: NOW }, { themes })
    assert.deepEqual(out.map(e => e.code), ['45301020', '40101015', '20104010'])
    assert.deepEqual(await industryAssessmentService.listForBook('long_term', { sector: 'Information Technology', now: NOW }, { themes }).then(o => o.map(e => e.code)), ['45103010'])
    assert.deepEqual(await industryAssessmentService.listForBook('watch', { now: NOW }, { themes }), [])
})
