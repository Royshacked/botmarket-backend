// Step 8d — insiders, funds and government in front of Pythia (docs/design/pythia-money-flows.md): the facts an
// assessment freezes, the tool's text, the weekly scan's three legs, and that a theme or an assessment made before
// step 8 is never flagged by them.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { flowFacts, formatFlows, readAllFlows, readFlowNodes, _setIndustryIO } from '../../api/strategy/industryData.service.js'
import { flowChanges, scanIndustry, scanTheme, SCAN } from '../../api/strategy/changeScan.service.js'
import { industryAssessmentService, _setAssessmentIO } from '../../api/strategy/industryAssessment.service.js'
import { scanWeek } from '../../services/pythiaWeekly.service.js'
import { memDb } from '../helpers/memDb.js'

const CODE = '40101015'
const NOW = '2026-10-12T12:00:00.000Z'

const INS = (over = {}) => ({ asof: '2026-10-12', level: 'sub_industry', code: CODE, name: 'Regional Banks', n_companies: 256,
    insiders: { companies_buying: 51, share_buying: 0.2, vs_universe: 1.6, cluster: true, value: 17.5e6, new: 4,
        top: [{ symbol: 'ABC', title: 'CEO', value: 2e6, traded: '2026-10-01' }], ...over } })
const FUN = (over = {}) => ({ quarter: '2026-06-30', level: 'sub_industry', code: CODE, name: 'Regional Banks',
    funds: { share: 0.62, relative_share: 0.9, flow: 0.05, flow_vs_universe: 0.011, percentile: 1, history_quarters: 7, ...over } })
const GOV = (over = {}) => ({ asof: '2026-10-12', level: 'sub_industry', code: CODE, name: 'Regional Banks',
    quarters: ['2026-03-31', '2026-06-30'], government: { now: 3e9, change: 0.4, prev_change: 0.05,
        lines: [{ naics: '522110', name: 'Commercial Banking', dollars: 3e9 }], ...over } })

// ── the facts ────────────────────────────────────────────────────────────────

test('no insider\'s personal name is frozen on an assessment', () => {
    const f = flowFacts({ insiders: INS({ top: [{ symbol: 'ABC', name: 'DOE JANE', title: 'CEO', value: 2e6, traded: '2026-10-01' }] }) })
    assert.deepEqual(f.insiders.top, [{ symbol: 'ABC', title: 'CEO', value: 2e6, traded: '2026-10-01' }])
})

test('flowFacts keeps the compact facts and is null when nothing is measured', () => {
    const f = flowFacts({ insiders: INS(), funds: FUN(), government: GOV() })
    assert.equal(f.insiders.cluster, true)
    assert.equal(f.insiders.n_companies, 256)
    assert.equal(f.funds.percentile, 1)
    assert.equal(f.government.through, '2026-06-30')
    assert.equal(f.government.change, 0.4)
    assert.equal(flowFacts({}), null)
    assert.equal(flowFacts({ funds: FUN() }).insiders, null)
})

test('the tool text says the insider cluster has no tested edge, funds are crowding, contracts are read as change', () => {
    const t = formatFlows({ insiders: INS(), funds: FUN(), government: GOV() })
    assert.match(t, /CLUSTER: YES/)
    assert.match(t, /NO TESTED EDGE/)
    assert.match(t, /CROWDING, a FACT about who is already in/)
    assert.match(t, /: 62% of the industry's market value held/, 'a level, not a signed change')
    assert.match(t, /\$17\.5M in all/)
    assert.match(t, /CEO \$2\.0M/)
    assert.match(t, /100th percentile of its own last 7 quarters/)
    assert.match(formatFlows({ funds: FUN({ percentile: 0.43 }) }), /43rd percentile/)
    assert.doesNotMatch(formatFlows({ funds: FUN({ history_quarters: 2 }) }), /percentile/, 'too short a history to rank against')
    assert.match(t, /not a tested warning/)
    assert.match(t, /\+40% on the four before/)
    assert.match(formatFlows({}), /not measured/)
    assert.match(formatFlows({ government: GOV({ now: 0, before: 0, change: null }) }), /no federal contract lines map/)
    assert.match(formatFlows({ government: GOV({ now: 0, before: 2e9, change: -1 }) }), /\$0, -100% on the four before/, 'a fall to zero is read as one')
})

// ── reading the engine ───────────────────────────────────────────────────────

function engine() {
    const m = memDb()
    m.rows('industry_insiders_runs').push({ asof: '2026-10-05', complete: true }, { asof: '2026-10-12', complete: true }, { asof: '2026-10-19', complete: false })
    m.rows('industry_insiders').push(INS({ cluster: false }), { ...INS(), asof: '2026-10-05' }, { ...INS(), asof: '2026-10-19' })
    m.rows('industry_funds').push({ quarter: '2026-06-30', level: 'universe', code: 'all' }, FUN(), { ...FUN(), quarter: '2026-03-31' })
    m.rows('industry_government_runs').push({ asof: '2026-10-12', complete: true })
    m.rows('industry_government').push(GOV())
    _setIndustryIO({ db: async () => m.db })
    return m
}

test('the latest COMPLETE run of each is read — never a half-written one', async () => {
    engine()
    const n = await readFlowNodes(CODE)
    assert.equal(n.insiders.asof, '2026-10-12')
    assert.equal(n.insiders.insiders.cluster, false, 'the complete run of the 12th, not the running one of the 19th')
    assert.equal(n.funds.quarter, '2026-06-30')
    assert.equal(n.government.asof, '2026-10-12')
    const all = await readAllFlows()
    assert.equal(all.get(CODE).insiders.cluster, false)
    assert.equal(all.get(CODE).funds.quarter, '2026-06-30')
})

test('a funds quarter whose universe document landed before its nodes is not read yet', async () => {
    const m = engine()
    m.rows('industry_funds').push({ quarter: '2026-09-30', level: 'universe', code: 'all' })
    assert.equal((await readFlowNodes(CODE)).funds.quarter, '2026-06-30')
    assert.equal((await readAllFlows()).get(CODE).funds.quarter, '2026-06-30')
})

test('no runs yet → nothing, not an error', async () => {
    _setIndustryIO({ db: async () => memDb().db })
    assert.deepEqual(await readFlowNodes(CODE), { insiders: null, funds: null, government: null })
    assert.equal((await readAllFlows()).size, 0)
})

// ── the scan's legs ──────────────────────────────────────────────────────────

const F = (i = {}, f = {}, g = {}) => flowFacts({ insiders: INS(i), funds: FUN(f), government: GOV(g) })

test('an insider cluster STARTING is a change; one ending buys no run (QA 2026-10-12: no tested edge)', () => {
    const ins = (now, then) => flowChanges(now, then).map(c => c.key).filter(k => k.startsWith('insider'))
    assert.deepEqual(ins(F({ cluster: true }), F({ cluster: false })), ['insider_cluster'])
    assert.deepEqual(ins(F({ cluster: false }), F({ cluster: true })), [])
    assert.deepEqual(ins(F({ cluster: true }), F({ cluster: true })), [])
})

test('crowding is not scanned yet — the fact is shown, the trigger waits for a longer history', () => {
    assert.equal(SCAN.CROWDED_SCANNED, false)
    assert.deepEqual(flowChanges(F({}, { percentile: 1 }), F({}, { percentile: 0.2 })).filter(c => c.key === 'crowded'), [])
})

test('once on, crowding is flagged on crossing into the top of its range, with enough quarters behind it', () => {
    const on = { ...SCAN, CROWDED_SCANNED: true }
    const keys = (now, then) => flowChanges(now, then, on).map(c => c.key).filter(k => k === 'crowded')
    assert.deepEqual(keys(F({}, { percentile: 1 }), F({}, { percentile: 0.5 })), ['crowded'])
    assert.deepEqual(keys(F({}, { percentile: 1 }), F({}, { percentile: 0.95 })), [], 'already there when assessed')
    assert.deepEqual(keys(F({}, { percentile: 1, history_quarters: SCAN.CROWD_MIN_QUARTERS - 1 }), F({}, { percentile: 0.2 })), [], 'too short a history')
})

test('contract money shifting 25%+ on at least $1B is a change; a small line or a shift already seen is not', () => {
    const keys = (now, then) => flowChanges(now, then).map(c => c.key).filter(k => k === 'contracts_shift')
    assert.deepEqual(keys(F({}, {}, { change: 0.4 }), F({}, {}, { change: 0.05 })), ['contracts_shift'])
    assert.deepEqual(keys(F({}, {}, { change: -0.3 }), F({}, {}, { change: 0.3 })), ['contracts_shift'], 'it turned')
    assert.deepEqual(keys(F({}, {}, { change: 0.4 }), F({}, {}, { change: 0.3 })), [], 'already shifting this way')
    assert.deepEqual(keys(F({}, {}, { change: 0.9, now: 2e8, before: 1e8 }), F({}, {}, { change: 0 })), [], 'under $1B both years')
})

test('QA 2026-10-12: revisions near 25% do not re-fire, and a fall below $1B counts', () => {
    const keys = (now, then) => flowChanges(now, then).map(c => c.key).filter(k => k === 'contracts_shift')
    assert.deepEqual(keys(F({}, {}, { change: 0.26 }), F({}, {}, { change: 0.24 })), [], 'frozen at 24%: inside the gap')
    assert.deepEqual(keys(F({}, {}, { change: 0.26 }), F({}, {}, { change: 0.10 })), ['contracts_shift'], 'frozen at 10%: a real shift')
    assert.deepEqual(keys(F({}, {}, { now: 0.9e9, before: 1.6e9, change: -0.44 }), F({}, {}, { change: 0.02 })), ['contracts_shift'])
})

test('no frozen flows → no flow legs: an assessment made before step 8 is not flagged for crowding every week', () => {
    assert.deepEqual(flowChanges(F(), null), [])
    const a = { verdict: 'swing', moved: null, money: null, flows: null, expires_at: '2027-01-01T00:00:00Z', long_term: { call: 'no', reviewed_at: '2027-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z' } }
    assert.equal(scanIndustry({ code: CODE, name: 'Regional Banks', now: { moved: null, money: null, flows: F() }, assessment: a, at: NOW }), null)
    const frozen = { ...a, flows: F({ cluster: false }) }
    const flag = scanIndustry({ code: CODE, name: 'Regional Banks', now: { moved: null, money: null, flows: F({ cluster: true }) }, assessment: frozen, at: NOW })
    assert.deepEqual(flag.reasons.map(r => r.key), ['insider_cluster'])
})

test('a theme is never flagged by its links\' flows (its links freeze companies\' money only)', () => {
    const theme = { id: 'th_x', name: 'X', status: 'approved', links: [{ code: CODE, name: 'Regional Banks', order: 1 }] }
    const assessment = { verdict: 'swing', moved: { links: [{ code: CODE }] }, money: { links: [{ code: CODE }] }, expires_at: '2027-01-01T00:00:00Z', long_term: { call: 'no', reviewed_at: '2027-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z' } }
    const now = new Map([[CODE, { moved: null, money: null, flows: F({ cluster: true }, { percentile: 1 }) }]])
    assert.equal(scanTheme({ theme, nowByCode: now, assessment, at: NOW }), null)
})

// ── wired end to end ─────────────────────────────────────────────────────────

test('a published industry assessment freezes the flows it was given; a theme does not', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const block = { industry: CODE, verdict: 'avoid', horizon: 'months', thesis: 'Deposit costs rising faster than loan yields.',
        evidence: { news: 'Q3 margins guided down.', price: 'Flat on the year.' }, cause: { kind: 'news', text: 'NIM guidance cut (Oct 2026)' },
        second_order: 'Fintech lenders take share.', risks: ['Rate cuts'], change_view_if: ['Deposit betas fall'], confidence: 'medium', confidence_reason: 'two banks guided' }
    const r = await industryAssessmentService.publishAssessment(block, { sub: { code: CODE, name: 'Regional Banks' }, row: null, flows: F(), now: NOW })
    assert.ok(r.ok, r.detail)
    assert.equal(r.doc.flows.insiders.cluster, true)
    assert.equal(r.doc.flows.funds.history_quarters, 7)
})

test('the weekly scan reads today\'s flows beside the price and the money', async () => {
    const row = { asof: '2026-10-09', code: CODE, name: 'Regional Banks', raw: {} }
    const assessment = { subject: { kind: 'industry', code: CODE }, verdict: 'swing', moved: { asof: '2026-10-09' }, money: null,
        flows: F({ cluster: false }), expires_at: '2027-01-01T00:00:00Z', long_term: { call: 'no', reviewed_at: '2027-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z' } }
    const { flags } = await scanWeek('2026-10-09', {
        readRun: async () => ({ rows: [row], regime: null }), readMoney: async () => new Map(),
        readFlows: async () => new Map([[CODE, F({ cluster: true })]]),
        listAssessments: async () => [assessment], listThemes: async () => [], now: () => NOW,
    })
    assert.deepEqual(flags.map(f => f.reasons.map(r => r.key)), [['insider_cluster']])
})
