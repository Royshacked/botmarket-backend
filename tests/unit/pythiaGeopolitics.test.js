// Step 4d — geopolitics in front of Pythia (docs/design/pythia-geopolitics.md): the reading, the facts an assessment
// freezes, the tool's text (attention, not impact; the map's directions failed T3), the scan's leg against FROZEN
// facts only, and the run's tolerance of a failed read.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { latestReading, geoFacts, formatGeo, readAllGeo, _setGeoIO } from '../../api/strategy/geopoliticsData.service.js'
import { geoChanges, scanIndustry } from '../../api/strategy/changeScan.service.js'
import { industryAssessmentService, _setAssessmentIO } from '../../api/strategy/industryAssessment.service.js'
import { assessIndustry } from '../../services/industryAssessmentRun.service.js'
import { scanWeek } from '../../services/pythiaWeekly.service.js'
import { memDb } from '../helpers/memDb.js'

const SEMIS = '45301020', AD = '20101010'
const NOW = '2026-10-12T12:00:00.000Z'

const READING = (over = {}) => ({
    _id: '2026-10-12', asof: '2026-10-12', monthly_through: '2026-09-01',
    global: { level: 147, z: 0.7, trend: -0.3, elevated: false },
    daily: { through: '2026-10-05', ma7: 178, ma30: 167, ma7_percentile: 0.92 },
    risks: [
        { id: 'gulf_hormuz', name: 'Gulf and the Strait of Hormuz', z: 2.2, trend: 0.1, elevated: true, hottest: 'SAU',
            hurts: [], helps: [{ code: AD, strength: 1, why: 'munitions and missile defence demand' }] },
        { id: 'taiwan_strait', name: 'Taiwan Strait', z: 0.7, trend: 0.2, elevated: false, hottest: 'CHN',
            hurts: [{ code: SEMIS, strength: 1, why: 'TSMC makes most leading-edge chips' }],
            helps: [{ code: AD, strength: 1, why: 'defence spending rises' }] },
    ],
    ...over,
})

function engine(reading = READING()) {
    const m = memDb()
    m.rows('geopolitical_risk_runs').push({ asof: '2026-10-05', complete: true }, { asof: '2026-10-12', complete: true }, { asof: '2026-10-19', complete: false })
    m.rows('geopolitical_risk').push({ ...READING({ _id: '2026-10-05', asof: '2026-10-05' }) }, reading, { ...READING({ _id: '2026-10-19', asof: '2026-10-19' }) })
    _setGeoIO({ db: async () => m.db })
    return m
}

test('the latest COMPLETE reading is read, never one being written', async () => {
    engine()
    assert.equal((await latestReading()).asof, '2026-10-12')
    _setGeoIO({ db: async () => memDb().db })
    assert.equal(await latestReading(), null)
})

test('an industry\'s facts: the world, and only the risks touching it, hottest first, with side and why', () => {
    const f = geoFacts(READING(), AD)
    assert.equal(f.global.z, 0.7)
    assert.equal(f.global.week_percentile, 0.92)
    assert.deepEqual(f.risks.map(r => [r.id, r.side, r.elevated]), [['gulf_hormuz', 'helps', true], ['taiwan_strait', 'helps', false]])
    assert.equal(geoFacts(READING(), SEMIS).risks[0].side, 'hurts')
    assert.deepEqual(geoFacts(READING(), '10101010').risks, [])
    assert.equal(geoFacts(null, AD), null)
})

test('the text says attention not impact, and that the map failed its test', () => {
    const t = formatGeo(READING(), geoFacts(READING(), SEMIS))
    assert.match(t, /ATTENTION, not impact/)
    assert.match(t, /HYPOTHESES — they FAILED a 40-year test/)
    assert.match(t, /Taiwan Strait: \+0\.7 .* HURTS this industry directly: TSMC/)
    assert.match(formatGeo(READING()), /Gulf and the Strait of Hormuz: \+2\.2 ELEVATED/)
    assert.match(formatGeo(READING(), geoFacts(READING(), '10101010')), /No mapped risk touches this industry/)
    assert.match(formatGeo(null), /not measured yet/)
})

test('a touching risk turning elevated is a change; already elevated, or no frozen facts, is not', () => {
    const now = geoFacts(READING(), AD)
    const calm = geoFacts(READING({ risks: READING().risks.map(r => ({ ...r, elevated: false })) }), AD)
    assert.deepEqual(geoChanges(now, calm).map(c => c.key), ['geo_elevated'])
    assert.match(geoChanges(now, calm)[0].detail, /Gulf .*helps it/)
    assert.deepEqual(geoChanges(now, now), [])
    assert.deepEqual(geoChanges(now, null), [], 'an assessment made before step 4')
    const a = { verdict: 'swing', moved: null, money: null, flows: null, geopolitics: null, expires_at: '2027-01-01T00:00:00Z' }
    assert.equal(scanIndustry({ code: AD, name: 'A&D', now: { geopolitics: now }, assessment: a, at: NOW }), null)
})

test('the weekly scan reads today\'s geopolitics beside the rest', async () => {
    engine()
    const geo = await readAllGeo()
    const calm = geoFacts(READING({ risks: READING().risks.map(r => ({ ...r, elevated: false })) }), AD)
    const { flags } = await scanWeek('2026-10-09', {
        readRun: async () => ({ rows: [{ asof: '2026-10-09', code: AD, name: 'Aerospace & Defense', raw: {} }], regime: null }),
        readMoney: async () => new Map(), readFlows: async () => new Map(), readGeo: async () => geo,
        listAssessments: async () => [{ subject: { kind: 'industry', code: AD }, verdict: 'swing', moved: { asof: '2026-10-09' },
            money: null, flows: null, geopolitics: calm, expires_at: '2027-01-01T00:00:00Z' }],
        listThemes: async () => [], now: () => NOW,
    })
    assert.deepEqual(flags.map(f => f.reasons.map(r => r.key)), [['geo_elevated']])
})

test('a published industry assessment freezes its geopolitics; a failed read never fails the run', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const block = { industry: AD, verdict: 'avoid', horizon: 'months', thesis: 'Budget fight delays awards.',
        evidence: { news: 'CR extended to December.', price: 'Flat.' }, cause: { kind: 'news', text: 'continuing resolution (Oct 2026)' },
        second_order: 'Suppliers wait.', risks: ['a supplemental'], change_view_if: ['a budget passes'], confidence: 'low', confidence_reason: 'one source' }
    const r = await industryAssessmentService.publishAssessment(block, { sub: { code: AD, name: 'Aerospace & Defense' }, row: null,
        geopolitics: geoFacts(READING(), AD), now: NOW })
    assert.ok(r.ok, r.detail)
    assert.equal(r.doc.geopolitics.risks[0].id, 'gulf_hormuz')

    let given = 'unset'
    const out = await assessIndustry(AD, { deps: {
        readSub: async () => ({ sub: { code: AD, name: 'Aerospace & Defense' } }), readRow: async () => ({ row: null }),
        readView: async () => null, run: async () => ({ reply: 'ok', assessments: [block] }),
        publish: async (b, opts) => { given = opts.geopolitics; return { ok: true, doc: { verdict: b.verdict }, call: null } },
        readGeo: async () => { throw new Error('engine down') }, spend: async () => 0, settle: async () => {}, now: () => NOW,
        basket: async () => [],
    } })
    assert.equal(out.outcome, 'published')
    assert.equal(given, null)
})
