import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    checkNames, resolveNames, normalizeSymbol, NAMES_MAX, checkAssessment, industryAssessmentService, _setAssessmentIO,
} from '../../api/strategy/industryAssessment.service.js'
import { memDb } from '../helpers/memDb.js'

// Pythia names companies (docs/design/pythia-names.md): an optional list on an assessment, checked for shape, resolved
// against our universe, first or second order worked out by code — a bad name is dropped with its reason, never a refusal.

const CODE = '45201020'
const NOW = '2026-10-13T12:00:00.000Z'
const IN_TEN_DAYS = new Date(Date.parse(NOW) + 10 * 86_400_000).toISOString().slice(0, 10)
const BLOCK = (over = {}) => ({
    industry: CODE, verdict: 'swing', horizon: 'months', thesis: 'Optical capacity sold out into 2029.',
    evidence: { news: 'Lumentum sold out (Oct 8).', price: 'Up 50% over SPY in 12 months.' },
    cause: { kind: 'news', text: 'capacity reports' }, second_order: 'power and cooling next',
    risks: ['a capex pause'], change_view_if: ['a hyperscaler cuts capex'], confidence: 'medium', decides_by: IN_TEN_DAYS, ...over,
})
const KNOWN = {
    LITE: { sub_code: CODE, sub_industry: 'Communications Equipment' },
    VRT: { sub_code: '20104010', sub_industry: 'Electrical Components & Equipment' },
    'BRK-B': { sub_code: '40201030', sub_industry: 'Multi-Sector Holdings' },
}

test('a ticker is spelled as the universe spells it', () => {
    assert.equal(normalizeSymbol(' brk.b '), 'BRK-B')
    assert.equal(normalizeSymbol('lite'), 'LITE')
    assert.equal(normalizeSymbol(null), '')
})

test('the shape: each name needs a ticker and a why; duplicates collapse; more than six are dropped, never refused', () => {
    const many = Array.from({ length: NAMES_MAX + 2 }, (_, i) => ({ symbol: `T${i}`, why: 'evidence' }))
    const r = checkNames([{ symbol: 'lite', why: 'sold out' }, { symbol: 'LITE', why: 'again' }, { symbol: '12$', why: 'x' }, { symbol: 'VRT' }, ...many])
    assert.deepEqual(r.names.slice(0, 1), [{ symbol: 'LITE', why: 'sold out' }])
    assert.equal(r.names.length, NAMES_MAX)
    assert.deepEqual(r.dropped.map(d => d.reason.split(' ')[0]), ['not', 'no', 'over', 'over', 'over'])
    assert.deepEqual(checkNames(undefined), { names: [], dropped: [] })
    assert.deepEqual(checkNames('LITE'), { names: [], dropped: [] })
})

test('optional: an assessment with no names is accepted as before', () => {
    const c = checkAssessment(BLOCK())
    assert.equal(c.ok, true)
    assert.deepEqual(c.assessment.names, [])
    assert.deepEqual(c.names_dropped, [])
})

test('first order inside the subject, second order elsewhere; outside the universe dropped', () => {
    const r = resolveNames([{ symbol: 'LITE', why: 'a' }, { symbol: 'VRT', why: 'b' }, { symbol: 'TSM', why: 'c' }], KNOWN, new Set([CODE]))
    assert.deepEqual(r.names, [
        { symbol: 'LITE', why: 'a', order: 'first', sub_code: CODE, industry: 'Communications Equipment' },
        { symbol: 'VRT', why: 'b', order: 'second', sub_code: '20104010', industry: 'Electrical Components & Equipment' },
    ])
    assert.deepEqual(r.dropped, [{ symbol: 'TSM', reason: 'not in our universe (US, $300M+)' }])
    assert.equal(resolveNames([{ symbol: 'VRT', why: 'b' }], KNOWN, new Set(['20104010', CODE])).names[0].order, 'first', "a theme's link is inside")
})

test('publishing stores the resolved names and every dropped one with its reason', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db, companies: async () => KNOWN })
    const sub = { code: CODE, name: 'Communications Equipment', sector: 'Information Technology' }
    const r = await industryAssessmentService.publishAssessment(BLOCK({
        names: [{ symbol: 'LITE', why: 'sold out' }, { symbol: 'vrt', why: 'power next' }, { symbol: 'TSM', why: 'foundry' }, { symbol: 'X1' }],
    }), { sub, row: null, now: NOW })
    assert.equal(r.ok, true)
    assert.deepEqual(r.doc.names.map(n => `${n.symbol}:${n.order}`), ['LITE:first', 'VRT:second'])
    assert.deepEqual(r.doc.names_dropped.map(d => d.symbol), ['X1', 'TSM'])
    const none = await industryAssessmentService.publishAssessment(BLOCK(), { sub, row: null, now: NOW })
    assert.deepEqual(none.doc.names, [])
    assert.equal(none.doc.names_dropped, null)
})

test("a theme's names are first order on any of its links", async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db, companies: async () => KNOWN })
    const theme = { id: 'th_ai', name: 'AI', status: 'approved', links: [{ code: CODE, name: 'Comms', order: 1 }, { code: '20104010', name: 'Electrical', order: 2 }] }
    const r = await industryAssessmentService.publishAssessment(BLOCK({ industry: undefined, theme: 'th_ai', names: [{ symbol: 'VRT', why: 'cooling' }, { symbol: 'BRK.B', why: 'x' }] }),
        { theme, facts: { moved: { kind: 'theme', hype: null, links: [] }, base_rates: [], not_measured: [] }, now: NOW })
    assert.equal(r.ok, true)
    assert.deepEqual(r.doc.names.map(n => `${n.symbol}:${n.order}`), ['VRT:first', 'BRK-B:second'])
})

test('a failed universe read publishes the assessment without names, saying why', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db, companies: async () => { throw new Error('db down') } })
    const r = await industryAssessmentService.publishAssessment(BLOCK({ names: [{ symbol: 'LITE', why: 'sold out' }] }),
        { sub: { code: CODE, name: 'Comms' }, row: null, now: NOW })
    assert.equal(r.ok, true)
    assert.deepEqual(r.doc.names, [])
    assert.deepEqual(r.doc.names_dropped, [{ symbol: 'LITE', reason: 'could not be checked' }])
})

// ── the readers (pythia-names.md §4) ──────────────────────────────────────────

import { runHouseScan } from '../../services/houseScan.service.js'
import { researchOpening } from '../../services/researchRun.service.js'
import { formatHouseIndustries, formatIndustryCompanies, namesLine, makeHouseIndustriesHandlers } from '../../services/tools/houseIndustries.tools.js'
import { _wrapForGrounding } from '../../services/agents/scanner.agent.service.js'
import { makeGroundingLedger, groundingTier } from '../../services/scanner.grounding.js'

const NAMED = [
    { symbol: 'CIEN', why: 'record backlog (Sep 3)', order: 'first', industry: 'Communications Equipment' },
    { symbol: 'VRT', why: 'power and cooling next', order: 'second', industry: 'Electrical Components & Equipment' },
]

test('Argus sees the names on the book list, and an industry call lists them first, as grounded rows', async () => {
    assert.equal(namesLine(NAMED), 'CIEN (first), VRT (second — Electrical Components & Equipment)')
    const list = formatHouseIndustries('swing', [{ code: CODE, name: 'Communications Equipment', sector: 'IT', rated: true, horizon: 'months', thesis: 't', names: NAMED, themes: [] }])
    assert.match(list, /the house names: CIEN \(first\), VRT \(second — Electrical Components & Equipment\)/)
    const sub = { code: CODE, name: 'Communications Equipment', sector: 'IT' }
    const text = formatIndustryCompanies(sub, [{ symbol: 'CSCO', name: 'Cisco', market_cap: 4e11, sub_industry: 'Communications Equipment' }], new Set(['CIEN']), { verdict: 'swing' }, NAMED)
    assert.ok(text.indexOf('CIEN') < text.indexOf('CSCO'), 'the names come before the largest')
    assert.match(text, /CIEN {3}first order — record backlog \(Sep 3\) {2}\[OUR COVERAGE\]/)
    assert.match(text, /VRT {4}second order \(Electrical Components & Equipment\) — power and cooling next/)
    const ledger = makeGroundingLedger()
    await _wrapForGrounding({ get_house_industries: async () => text }, ledger).get_house_industries({ industry: CODE })
    for (const t of ['CIEN', 'VRT', 'CSCO']) assert.equal(groundingTier(t, ledger), 'sourced', t)
})

test("the tool shows a standing assessment's names only — an expired one shows none", async () => {
    const sub = { code: CODE, name: 'Communications Equipment', sector: 'IT' }
    const deps = (expires_at) => ({
        readSub: async () => ({ sub }), largest: async () => [], covered: async () => new Set(), verdicts: async () => new Map(),
        assessment: async () => ({ names: NAMED, expires_at }), now: () => NOW,
    })
    assert.match(await makeHouseIndustriesHandlers(deps('2026-11-01T00:00:00.000Z')).get_house_industries({ industry: CODE }), /CIEN/)
    assert.doesNotMatch(await makeHouseIndustriesHandlers(deps('2026-10-01T00:00:00.000Z')).get_house_industries({ industry: CODE }), /CIEN/)
})

test('the weekly house scan queues the named companies first, inside the same count, with why on the row', async () => {
    const queued = []
    const a = { id: 'ia_ind_11', subject: { kind: 'industry', name: 'Comms' }, verdict: 'swing', horizon: 'months', thesis: 'sold out', risks: [], names: NAMED }
    const deps = {
        covered: async () => new Set(), largest: async () => ['CSCO', 'MSI', 'UI'], theme: async () => null,
        assessment: async () => a, enqueue: async (row) => { queued.push(row); return { ok: true } },
        perIndustry: () => 3, weeklyMax: () => 30,
    }
    await runHouseScan([{ kind: 'industry', code: '11', name: 'Comms', outcome: 'published', verdict: 'swing' }], deps)
    assert.deepEqual(queued.map(q => q.symbol), ['CIEN', 'VRT', 'CSCO'], 'two names, then the largest fill the three')
    assert.equal(queued[0].context.named_why, 'record backlog (Sep 3)')
    assert.equal(queued[2].context.named_why, undefined)
    assert.match(researchOpening(queued[1]), /Pythia's FOR SWING assessment of Comms \(months\) names it: power and cooling next/)
    assert.doesNotMatch(researchOpening(queued[1]), /its industry/, 'a second-order name is not in "its industry"')
})

test("a theme's names take their own count, ahead of its links", async () => {
    const queued = []
    const a = { id: 'ia_th_ai', subject: { kind: 'theme', name: 'AI' }, verdict: 'long_term', horizon: 'years', thesis: 'capex', risks: [], names: NAMED }
    const deps = {
        covered: async () => new Set(), largest: async (code) => ({ 31: ['NVDA', 'AVGO'], 32: ['LRCX', 'AMAT'] }[code] ?? []),
        theme: async () => ({ links: [{ code: '31', name: 'Semis', order: 1 }, { code: '32', name: 'Chip equipment', order: 2 }] }),
        assessment: async () => a, enqueue: async (row) => { queued.push(row); return { ok: true } },
        perIndustry: () => 2, weeklyMax: () => 30,
    }
    await runHouseScan([{ kind: 'theme', id: 'th_ai', name: 'AI', outcome: 'published', verdict: 'long_term' }], deps)
    assert.deepEqual(queued.map(q => q.symbol), ['CIEN', 'VRT', 'LRCX', 'AMAT', 'NVDA', 'AVGO'])
})

import { houseFirst, sourceSleeve, _resetSleeves } from '../../services/sleeveSource.service.js'
import { labelsFrom, formatHouseLabel, wireLabel } from '../../services/houseLabel.service.js'

test('the sleeve: a named company inside the screen joins the house-first slots wherever it is classified', async () => {
    const r = houseFirst(['A', 'B', 'VRT', 'C', 'CIEN'], { A: 'x', B: 'x', VRT: '20104010', C: 'x', CIEN: CODE }, new Set(), { hits: 3, max: 2, named: new Set(['VRT', 'CIEN']) })
    assert.deepEqual(r.house, ['VRT', 'CIEN'])
    assert.deepEqual(r.symbols, ['VRT', 'CIEN', 'A'])
    _resetSleeves()
    const enq = []
    const res = await sourceSleeve({ userId: 'u1', sector: 'Industrials', school: 'quality-value' }, {
        houseIndustries: async () => [{ code: CODE, names: NAMED }, { code: '99', avoid: true, names: [{ symbol: 'BAD' }] }],
        screen: async (f) => ['A', 'BAD', 'VRT', 'B'].slice(0, f.limit), industryOf: async () => ({}),
        coveredSymbols: async () => new Set(), enqueue: async (x) => { enq.push(x.symbol); return { ok: true } },
        startRun: async () => ({ ok: true, run: { id: 'r' } }), onRunSettled: () => {}, post: async () => ({}), listQueue: async () => [],
        houseMax: () => 6,
    })
    assert.deepEqual(res.sleeve.house, ['VRT'], "only an Avoid industry's name is left out")
    assert.deepEqual(enq.slice(0, 1), ['VRT'])
})

test('the label: a named company outside the listed industries carries "named by the house"', () => {
    const lists = { swing: [{ code: CODE, name: 'Communications Equipment', names: NAMED, themes: [] }] }
    const m = labelsFrom(['VRT', 'CIEN', 'ZZZ'], { VRT: '20104010', CIEN: CODE, ZZZ: '1' }, lists, ['swing'])
    assert.equal(m.get('CIEN').named, undefined, 'in the listed industry: the ordinary label')
    const v = m.get('VRT')
    assert.equal(v.named, true)
    assert.equal(formatHouseLabel(v), 'named by the house in its swing assessment of Communications Equipment — power and cooling next')
    assert.deepEqual(wireLabel(v), { book: 'swing', industry: 'Communications Equipment', hype: false, avoid: false, themes: [], named: true, why: 'power and cooling next' })
    assert.equal(m.has('ZZZ'), false)
    const avoided = labelsFrom(['VRT'], { VRT: '20104010' }, { swing: [{ code: CODE, name: 'C', avoid: true, names: NAMED, themes: [] }] }, ['swing'])
    assert.equal(avoided.has('VRT'), false, 'an Avoid industry lends no label')
})
