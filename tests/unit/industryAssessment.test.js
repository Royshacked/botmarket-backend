import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    checkAssessment, factsFor, formatFacts, industryAssessmentService, _setAssessmentIO, VERDICTS, EXPIRY_DAYS, ordinal, NO_CASE_EXPIRY_DAYS,
} from '../../api/strategy/industryAssessment.service.js'
import {
    shouldLog, gradeCall, summarise, pythiaCallsService, _setCallsIO, REAFFIRM_DAYS, BENCHMARKS,
} from '../../api/strategy/pythiaCalls.service.js'
import { assessIndustry, structureOf, deskSpend } from '../../services/industryAssessmentRun.service.js'
import { _tick } from '../../monitoring/pythiaCalls.monitor.service.js'
import { memDb } from '../helpers/memDb.js'
import { _parseStrategyResponse, _buildTurnContext, TOOLS } from '../../services/agents/strategy.agent.service.js'

// Pythia's assessment (docs/design/pythia-assessment.md, build step 1): the guardrails, the facts the code
// attaches, the forward log and its grader, the headless run — all through their seams.

const CODE = '45301020'
const NOW = '2026-10-10T12:00:00.000Z'
// A watch names its deciding date within six weeks — ten days from the clock the check runs on, and from NOW.
const IN_TEN_DAYS = (from = Date.now()) => new Date(Date.parse(new Date(from).toISOString()) + 10 * 86_400_000).toISOString().slice(0, 10)
const BLOCK = (over = {}) => ({
    industry: CODE, verdict: 'watch', horizon: 'months', decides_by: IN_TEN_DAYS(), question: 'Will hyperscalers hold 2027 capex guidance?',
    thesis: 'AI capex still rising; the group is up a lot and stretched.',
    evidence: { news: 'Hyperscalers raised capex guidance (2026-07-30).', price: 'Up 180% in two years, 92nd percentile stretched.' },
    cause: { kind: 'money', text: 'hyperscaler capex guidance raised in July' },
    second_order: 'Power equipment and utilities serving data centres benefit next.',
    risks: ['capex pause'], change_view_if: ['a hyperscaler cuts 2027 capex guidance'],
    confidence: 'medium', ...over,
})
const ROW = (raw = {}) => ({
    asof: '2026-10-07', code: CODE, basket_name: 'Semiconductors',
    raw: { ret_12m: 0.6, spy_12m: 0.15, ret_24m: 1.8, spy_24m: 0.4, rel_1m: 0.02, rel_3m: 0.08, ext_50: 0.07, ext_percentile: 0.92, hype: true, ...raw },
})

// ── the guardrails ───────────────────────────────────────────────────────────

test('an assessment with every guardrail is accepted; the inputs not built yet become gaps', () => {
    const c = checkAssessment(BLOCK())
    assert.equal(c.ok, true)
    assert.deepEqual(c.gaps, ['money', 'regime', 'geopolitics'])
    assert.equal(c.assessment.verdict, 'watch')
    assert.deepEqual(c.assessment.cause, { kind: 'money', text: 'hyperscaler capex guidance raised in July' })
})

test('an assessment that is a story, not a judgment, is refused with every reason', () => {
    const c = checkAssessment(BLOCK({ cause: {}, second_order: '', risks: [], change_view_if: [], confidence: 'sure' }))
    assert.equal(c.ok, false)
    for (const bit of ['cause.kind', 'cause.text', 'second_order', 'risks', 'change_view_if', 'confidence']) assert.match(c.detail, new RegExp(bit.replace('.', '\\.')))
    assert.match(checkAssessment(BLOCK({ evidence: { price: 'x' } })).detail, /evidence\.news is missing/, 'news is always required')
    assert.match(checkAssessment(BLOCK({ verdict: 'buy' })).detail, /verdict must be one of/)
    assert.match(checkAssessment(BLOCK({ industry: 'Semis' })).detail, /8-digit/)
})

test('"none" is an allowed cause — a move with nothing behind it is a finding', () => {
    assert.equal(checkAssessment(BLOCK({ cause: { kind: 'none', text: 'no news, no money — the hype pattern' } })).ok, true)
})

test('"unverified" is its own cause — a failed search is not the hype finding', () => {
    const c = checkAssessment(BLOCK({ cause: { kind: 'unverified', text: 'the news search hit its daily limit' } }))
    assert.equal(c.ok, true)
    assert.equal(c.assessment.cause.kind, 'unverified')
})

test('the verdict words are the four Roy kept', () => {
    assert.deepEqual(Object.keys(VERDICTS).slice(0, 4), ['swing', 'long_term', 'watch', 'avoid'])
})

// ── the facts the code attaches ──────────────────────────────────────────────

test('the moves and the hype base rate come from the engine row, never from the agent', () => {
    const f = factsFor(ROW())
    assert.ok(Math.abs(f.moved.excess_24m - 1.4) < 1e-12 && Math.abs(f.moved.excess_12m - 0.45) < 1e-12)
    assert.equal(f.moved.hype, true)
    assert.equal(f.base_rates.length, 1)
    assert.match(f.base_rates[0].text, /22% fell 40%\+/)
    assert.deepEqual(f.not_measured, ['value_trap', 'customer_demand', 'momentum_at_turns'])
    assert.deepEqual(factsFor(ROW({ hype: false })).base_rates, [], 'a base rate is attached only when it applies')
    assert.equal(factsFor(ROW({ hype: undefined, ret_24m: undefined })).moved.hype, null)
    assert.equal(factsFor(null).moved, null)
})

test('ordinals read like English', () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 92, 100].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '92nd', '100th'])
})

test('the agent reads the facts with the base rate and what is not measured', () => {
    const t = formatFacts(ROW(), { regime: 'green' })
    assert.match(t, /24 months \+180% vs SPY \+40% → \+140% over the market/)
    assert.match(t, /HYPE FLAG: YES/)
    assert.match(t, /92nd percentile of its own two years/)
    assert.match(t, /NOT MEASURED YET/)
    assert.match(t, /MARKET REGIME .*GREEN/)
    assert.match(formatFacts(null), /No price measurements/)
})

// ── publishing ───────────────────────────────────────────────────────────────

test('publishing writes the verdict with the code facts, a revision, and logs a call', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const calls = []
    const sub = { code: CODE, name: 'Semiconductors', sector: 'Information Technology' }
    const r = await industryAssessmentService.publishAssessment(BLOCK({ moved: { hype: false } }),
        { sub, row: ROW(), structure: { demand: 'growing' }, recordCall: async (doc) => { calls.push(doc.verdict); return { logged: true } }, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.doc.moved.hype, true, 'the agent\'s own "moved" is ignored')
    assert.equal(r.doc.revisions.length, 1)
    assert.equal(r.doc.revisions[0].kind, 'assessment')
    assert.equal(r.doc.expires_at, new Date(Date.parse(NOW) + EXPIRY_DAYS.months * 86_400_000).toISOString())
    assert.deepEqual(calls, ['watch'])
    const again = await industryAssessmentService.publishAssessment(BLOCK({ verdict: 'avoid' }), { sub, row: ROW(), now: NOW })
    assert.deepEqual(again.changed.verdict, { from: 'watch', to: 'avoid' })
    assert.equal(again.doc.revisions[0].kind, 'reassessment')
    assert.equal(again.doc.trigger, null, "an admin's own run carries no trigger")
})

test('a weekly run publishes WHY it ran: the change scan reasons ride on the assessment', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const r = await industryAssessmentService.publishAssessment(BLOCK(), { sub: { code: CODE, name: 'Semiconductors' }, row: ROW(), now: NOW,
        source: 'weekly', trigger: [{ key: 'hype_new', text: 'the hype flag turned on', detail: '24m +190%', weight: 5 }] })
    assert.equal(r.doc.source, 'weekly')
    assert.deepEqual(r.doc.trigger, [{ key: 'hype_new', text: 'the hype flag turned on', detail: '24m +190%' }])
})

test('a call that fails to log does not unpublish the assessment', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const r = await industryAssessmentService.publishAssessment(BLOCK(),
        { sub: { code: CODE, name: 'Semiconductors' }, row: ROW(), recordCall: async () => { throw new Error('quotes down') }, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.call, null)
})

test('an assessment for another industry than the one measured is refused', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const r = await industryAssessmentService.publishAssessment(BLOCK(), { sub: { code: '10101010', name: 'Drilling' }, row: null, now: NOW })
    assert.equal(r.reason, 'unknown_industry')
})

// ── the forward log ──────────────────────────────────────────────────────────

test('a call is logged on a new verdict, or a reaffirmation after the window — not every week', () => {
    assert.equal(shouldLog(null, 'watch', NOW), true)
    const prev = { verdict: 'watch', called_at: '2026-10-01T00:00:00.000Z' }
    assert.equal(shouldLog(prev, 'avoid', NOW), true)
    assert.equal(shouldLog(prev, 'watch', NOW), false)
    assert.equal(shouldLog(prev, 'watch', new Date(Date.parse(prev.called_at) + REAFFIRM_DAYS * 86_400_000).toISOString()), true)
})

const CALL = (over = {}) => ({
    verdict: 'swing', basket: ['AAA', 'BBB', 'CCC', 'DDD'],
    entry: { AAA: 10, BBB: 10, CCC: 10, DDD: 10 }, bench_entry: { SPY: 100, QQQ: 100, RSP: 100 }, ...over,
})

test('a grade: the basket against SPY, QQQ and the equal-weight market; a missing name is left out', () => {
    const g = gradeCall(CALL(), { AAA: 12, BBB: 11, CCC: 9, SPY: 105, QQQ: 110, RSP: 103 }, NOW)
    assert.equal(g.n, 3)
    assert.equal(g.missing, 1)
    assert.ok(Math.abs(g.basket_return - (0.2 + 0.1 - 0.1) / 3) < 1e-12)
    assert.ok(Math.abs(g.share_beat_spy - 2 / 3) < 1e-12)
    assert.ok(Math.abs(g.vs_spy - (g.basket_return - 0.05)) < 1e-12)
    assert.equal(g.right, true)
    assert.equal(gradeCall(CALL({ verdict: 'avoid' }), { AAA: 12, BBB: 11, CCC: 9, SPY: 105, QQQ: 110, RSP: 103 }, NOW).right, false, 'avoid is right only when the basket lagged')
    assert.equal(gradeCall(CALL({ verdict: 'watch' }), { AAA: 12, BBB: 11, CCC: 9, SPY: 105, QQQ: 110, RSP: 103 }, NOW).right, null)
    assert.equal(gradeCall(CALL({ verdict: 'no_case' }), { AAA: 12, BBB: 11, CCC: 9, SPY: 105, QQQ: 110, RSP: 103 }, NOW).right, null, 'no case makes no directional call')
    assert.equal(gradeCall(CALL(), { AAA: 12, BBB: 11, CCC: 9, SPY: 105, QQQ: 110 }, NOW), null, 'no grade without every benchmark')
    assert.equal(gradeCall(CALL(), { AAA: 12, SPY: 105, QQQ: 110, RSP: 103 }, NOW), null, 'too few names priced')
})

test('the track record averages by verdict and horizon', () => {
    const s = summarise([
        { verdict: 'avoid', status: 'closed', grades: { '3m': { vs_spy: -0.1, share_beat_spy: 0.2, right: true }, '12m': { vs_spy: 0.05, share_beat_spy: 0.5, right: false } } },
        { verdict: 'avoid', status: 'open', grades: { '3m': { vs_spy: -0.02, share_beat_spy: 0.4, right: true } } },
        { verdict: 'watch', status: 'open', grades: {} },
    ])
    assert.equal(s.total, 3)
    assert.equal(s.open, 2)
    const a3 = s.by_verdict.avoid['3m']
    assert.equal(a3.n, 2)
    assert.equal(a3.right, 1)
    assert.ok(Math.abs(a3.avg_vs_spy + 0.06) < 1e-12 && Math.abs(a3.avg_share_beat_spy - 0.3) < 1e-12)
    assert.equal(s.by_verdict.avoid['12m'].right, 0)
})

test('recording a call freezes the basket and benchmark prices; a repeat inside the window is skipped', async () => {
    const m = memDb()
    const prices = { AAA: 10, BBB: 20, CCC: 30, SPY: 500, QQQ: 400, RSP: 150 }
    _setCallsIO({ db: async () => m.db, companies: async () => [{ symbol: 'AAA' }, { symbol: 'BBB' }, { symbol: 'CCC' }, { symbol: 'ZZZ' }],
        price: async (s) => prices[s] ?? null })
    const doc = { subject: { kind: 'industry', code: CODE, name: 'Semiconductors' }, verdict: 'watch', horizon: 'months', assessed_at: NOW }
    const r = await pythiaCallsService.recordCall(doc, { now: NOW })
    assert.equal(r.logged, true)
    assert.deepEqual(r.call.basket, ['AAA', 'BBB', 'CCC'], 'an unpriced name is not in the basket')
    assert.deepEqual(r.call.bench_entry, { SPY: 500, QQQ: 400, RSP: 150 })
    assert.equal((await pythiaCallsService.recordCall(doc, { now: '2026-10-17T00:00:00.000Z' })).logged, false)
    _setCallsIO({ price: async () => null })
    await assert.rejects(() => pythiaCallsService.recordCall({ ...doc, verdict: 'avoid' }, { now: NOW }), /could not price/)
})

const PRICES = { AAA: 11, BBB: 11, CCC: 11, DDD: 11, SPY: 101, QQQ: 102, RSP: 101 }

test('the grader grades a horizon that just fell due, voids one graded far too late, and closes the call', async () => {
    const m = memDb()
    // called 374.5 days before NOW: 12m fell due 9.5 days ago (in time); 3m fell due 284 days ago (too late)
    m.rows('pythia_calls').push({ id: 'pc_1', status: 'open', called_at: '2025-10-01T00:00:00.000Z', grades: {}, ...CALL() })
    m.rows('pythia_calls').push({ id: 'pc_2', status: 'open', called_at: '2026-09-01T00:00:00.000Z', grades: {}, ...CALL() })
    _setCallsIO({ db: async () => m.db, price: async (s) => PRICES[s] })
    const r = await pythiaCallsService.gradeDue({ now: NOW })
    assert.deepEqual(r, { graded: 1, voided: 1, failed: 0 })
    const [a, b] = m.rows('pythia_calls')
    assert.equal(a.grades['3m'].void, true, "today's prices are not the 3-month result")
    assert.match(a.grades['3m'].reason, /284 days after/)
    assert.equal(a.grades['12m'].late_days, 10)
    assert.equal(a.status, 'closed')
    assert.deepEqual(b.grades, {}, 'not yet three months')
    assert.equal(b.status, 'open')
})

test('a horizon that cannot be priced is retried within the grace, then voided so the call closes', async () => {
    const m = memDb()
    m.rows('pythia_calls').push({ id: 'pc_3', status: 'open', called_at: '2026-07-05T00:00:00.000Z', grades: {}, ...CALL() })
    _setCallsIO({ db: async () => m.db, price: async (s) => ({ SPY: 101, QQQ: 102, RSP: 101 }[s]) })   // every name gone
    assert.deepEqual(await pythiaCallsService.gradeDue({ now: '2026-10-08T00:00:00.000Z' }), { graded: 0, voided: 0, failed: 1 }, 'inside the grace: retried')
    assert.deepEqual(await pythiaCallsService.gradeDue({ now: '2026-10-25T00:00:00.000Z' }), { graded: 0, voided: 1, failed: 0 }, 'past it: voided')
    assert.equal(m.rows('pythia_calls')[0].grades['3m'].void, true)
})

test('a grade that lost much of its basket is flagged incomplete, and the record counts voids apart', () => {
    const g = gradeCall(CALL(), { AAA: 12, BBB: 11, CCC: 9, SPY: 105, QQQ: 110, RSP: 103 }, NOW)
    assert.equal(g.missing_share, 0.25)
    assert.equal(g.incomplete, true)
    const s = summarise([{ verdict: 'watch', status: 'closed', grades: { '3m': { void: true }, '12m': { ...g, right: null } } }])
    assert.deepEqual(s.by_verdict.watch['3m'], { n: 0, right: null, avg_vs_spy: null, avg_share_beat_spy: null, incomplete: 0, void: 1 })
    assert.equal(s.by_verdict.watch['12m'].incomplete, 1)
})

test('the grader monitor runs one pass', async () => {
    assert.deepEqual(await _tick({ grade: async () => ({ graded: 0, voided: 0, failed: 0 }) }), { graded: 0, voided: 0, failed: 0 })
})

// ── the desk ─────────────────────────────────────────────────────────────────

test('the desk emits <industry_assessment>, stripped from the reply, and an ASSESSMENT turn says so', () => {
    const raw = `Reasoning.\n<industry_assessment>${JSON.stringify(BLOCK())}</industry_assessment>`
    const p = _parseStrategyResponse(raw)
    assert.equal(p.assessments.length, 1)
    assert.equal(p.assessments[0].industry, CODE)
    assert.doesNotMatch(p.reply, /industry_assessment/)
    assert.match(_buildTurnContext({ assess: CODE }), /ASSESSMENT of GICS sub-industry 45301020/)
    assert.ok(TOOLS.some(t => t.name === 'get_industry_moves'))
    assert.equal(TOOLS.at(-1).name, 'consult', 'consult stays last')
})

// ── the headless run ─────────────────────────────────────────────────────────

const DEPS = (over = {}) => {
    let spend = 1.0
    return {
        readSub: async (code) => (code === CODE ? { sub: { code: CODE, name: 'Semiconductors' } } : null),
        readRow: async () => ({ row: ROW(), regime: { regime: 'green' } }),
        readView: async () => ({ status: 'answered', demand: { grade: 'growing' }, economics: { grade: 'good' }, cycle: { grade: 'peak' } }),
        run: async () => { spend += 0.42; return { reply: 'ok', assessments: [BLOCK()] } },
        publish: async (block, opts) => ({ ok: true, doc: { verdict: block.verdict, structure: opts.structure }, call: { logged: true } }),
        recordCall: async () => ({ logged: true }),
        spend: async () => spend, settle: async () => {}, now: () => NOW, basket: async () => ["NVDA", "AMD", "AVGO"],
        ...over,
    }
}

test('Assess now publishes and reports what the run cost', async () => {
    const r = await assessIndustry(CODE, { userId: 'admin', deps: DEPS() })
    assert.equal(r.outcome, 'published')
    assert.ok(Math.abs(r.cost_usd - 0.42) < 1e-9)
    assert.deepEqual(r.doc.structure, { demand: 'growing', economics: 'good', cycle: 'peak' })
})

test('Assess now publishes without flows when they cannot be read, and freezes them when they can (QA 2026-10-12)', async () => {
    let given
    const publish = async (block, opts) => { given = opts.flows; return { ok: true, doc: { verdict: block.verdict }, call: null } }
    const failed = await assessIndustry(CODE, { deps: DEPS({ publish, readFlows: async () => { throw new Error('engine down') } }) })
    assert.equal(failed.outcome, 'published')
    assert.equal(given, null)
    await assessIndustry(CODE, { deps: DEPS({ publish, readFlows: async () => ({ insiders: { cluster: true } }) }) })
    assert.deepEqual(given, { insiders: { cluster: true } })
})

test('Assess now: an unknown industry, no block, a refused block, an error', async () => {
    assert.equal((await assessIndustry('99999999', { deps: DEPS() })).outcome, 'unknown_industry')
    assert.equal((await assessIndustry(CODE, { deps: DEPS({ run: async () => ({ reply: 'no', assessments: [] }) }) })).outcome, 'no_block')
    assert.equal((await assessIndustry(CODE, { deps: DEPS({ publish: async () => ({ ok: false, detail: 'x' }) }) })).outcome, 'refused')
    assert.equal((await assessIndustry(CODE, { deps: DEPS({ run: async () => { throw new Error('model down') } }) })).outcome, 'error')
})

test('the structure rides along only for an answered industry; the spend sums the desk and its sidecar', () => {
    assert.equal(structureOf({ status: 'pending' }), null)
    assert.equal(structureOf(null), null)
    assert.equal(deskSpend({ strategyAgent: { cost: 1.5 }, 'consult:strategyAgent': { cost: 0.5 }, analystAgent: { cost: 9 } }), 2.0)
    assert.equal(deskSpend(undefined), 0)
})

test('the benchmarks are SPY, QQQ and the equal-weight RSP', () => {
    assert.deepEqual([...BENCHMARKS], ['SPY', 'QQQ', 'RSP'])
})

// ── the news input (FMP basket through the one news pipe) ─────────────────────

test('one busy name cannot fill a basket digest — at most three per ticker, newest first', async () => {
    const { capPerSymbol } = await import('../../services/tools/news.tools.js')
    const a = (sym, t) => ({ related: [sym], datetime: t, headline: `${sym} ${t}` })
    const out = capPerSymbol([a('NVDA', 5), a('NVDA', 4), a('NVDA', 3), a('NVDA', 2), a('AMD', 1)], 3)
    assert.deepEqual(out.map(x => x.headline), ['NVDA 5', 'NVDA 4', 'NVDA 3', 'AMD 1'])
})

test('largest companies roll up to the answering level when a sub-industry is thin — the one shared rule', async () => {
    const { largestCompanies, _setIndustryIO } = await import('../../api/strategy/industryData.service.js')
    const m = memDb()
    const co = (symbol, sub_code, industry_code, market_cap) => ({ symbol, sub_code, industry_code, market_cap, stale: false, duplicate_of: null })
    m.rows('gics_companies').push(co('NVDA', CODE, '453010', 9), co('AMD', '45301010', '453010', 5), co('AVGO', '45301010', '453010', 7))
    _setIndustryIO({ db: async () => m.db })
    const thin = { code: CODE, answered_at: { level: 'industry', code: '453010' } }
    assert.deepEqual((await largestCompanies(thin)).map(c => c.symbol), ['NVDA', 'AVGO', 'AMD'], 'one own company: its industry answers, largest first')
    assert.deepEqual((await largestCompanies({ code: CODE, answered_at: { level: 'sub_industry', code: CODE } })).map(c => c.symbol), ['NVDA'])
    assert.deepEqual(await largestCompanies(null), [])
})

test('industry news reads the largest companies as a basket keyed by the industry', async () => {
    const { industryNews } = await import('../../services/agents/strategy.agent.service.js')
    const fetched = []
    const deps = {
        readSub: async () => ({ sub: { code: CODE, name: 'Semiconductors', answered_at: { level: 'industry', code: '453010' } } }),
        largest: async () => [{ symbol: 'NVDA' }, { symbol: 'AMD' }, { symbol: 'AVGO' }],
        fetch: async (o) => { fetched.push(o); return { articles: [{ related: ['AMD'], datetime: Math.floor(Date.parse(NOW) / 1000) - 3600, headline: 'AMD wins a deal', summary: 's', source: 'Reuters' }] } },
    }
    const text = await industryNews({ industry: CODE }, deps)
    assert.deepEqual(fetched[0], { category: 'basket', subject: `gics_${CODE}`, query: 'AMD,AVGO,NVDA' })
    assert.match(text, /Semiconductors — its 3 largest companies/)
    assert.match(text, /AMD wins a deal/)
    assert.match(await industryNews({ industry: 'nope' }, { ...deps, readSub: async () => null }), /Unknown sub-industry/)
})

// ── companies' own money (step 2, pythia-assessment.md §4.3) ──────────────────

const MONEY_NODE = {
    name: 'Semiconductors', code: '45301020', asof: '2026-10-10',
    money: {
        companies: 40,
        capex: { now: 60e9, before: 40e9, change: 0.5, prev_change: 0.1, companies: 38, share_up: 0.71, intensity: 0.12, intensity_before: 0.09 },
        buybacks: { now: 30e9, before: 36e9, change: -0.1667, prev_change: 0.05, companies: 30, share_up: 0.4 },
        dividends: { now: 10e9, before: 9.5e9, change: 0.0526, prev_change: 0.03, companies: 25, share_up: 0.6 },
        acquisitions: { now: 2e9, before: 8e9, change: -0.75, prev_change: null, companies: 40, share_up: 0.2 },
        share_count_median_change: -0.012,
        top_spenders: [{ symbol: 'INTC', capex: 20e9, change: 0.3 }, { symbol: 'MU', capex: 12e9, change: 0.9 }],
    },
}

test('money facts and text come from the engine node; capex reads as the suppliers\' revenue', async () => {
    const { moneyFacts, formatMoney, formatMoneyLeaders } = await import('../../api/strategy/industryData.service.js')
    const f = moneyFacts(MONEY_NODE)
    assert.equal(f.capex_change, 0.5)
    assert.equal(f.capex_share_up, 0.71)
    assert.equal(f.buybacks_change, -0.1667)
    assert.equal(moneyFacts({ name: 'x' }), null)
    const t = formatMoney(MONEY_NODE)
    assert.match(t, /CAPEX\s+\$60\.0B over the last 4 quarters vs \$40\.0B the 4 before → \+50% \(a year earlier: \+10%\); 71% of 38 companies raised it/)
    assert.match(t, /capex intensity: 12% of revenue \(a year before: 9%\)/)
    assert.match(t, /top spenders: INTC \$20\.0B \(\+30%\), MU \$12\.0B \(\+90%\)/)
    assert.match(t, /follow the money to where it lands/)
    assert.match(formatMoney({ name: 'x' }), /No money measurements/)
    const l = formatMoneyLeaders({ asof: '2026-10-10', up: [{ name: 'Interactive Media', sector: 'Communication Services', now: 200e9, delta: 80e9, change: 0.67, prev_change: 0.4, share_up: 0.8 }], down: [] })
    assert.match(l, /Interactive Media \[Communication Services\]: capex \$200\.0B, \+\$80\.0B \(\+67%; a year earlier \+40%\), 80% of companies up/)
    assert.match(l, /none falling/)
})

test('the capex leaders rank GICS industries by the dollar change, both ways', async () => {
    const { readMoneyLeaders, _setIndustryIO } = await import('../../api/strategy/industryData.service.js')
    const m = memDb()
    m.rows('industry_metrics_runs').push({ asof: '2026-10-10', complete: true })
    const node = (name, now, before) => ({ asof: '2026-10-10', level: 'industry', name, code: name, sector: 'S', money: { capex: { now, before, change: now / before - 1 } } })
    m.rows('industry_metrics').push(node('Up big', 300, 100), node('Up small', 110, 100), node('Down', 50, 100))
    _setIndustryIO({ db: async () => m.db })
    const r = await readMoneyLeaders({ n: 2 })
    assert.deepEqual(r.up.map(x => x.name), ['Up big', 'Up small'])
    assert.deepEqual(r.down.map(x => x.name), ['Down'])
})

test('a published assessment carries the money facts it was given', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const { moneyFacts } = await import('../../api/strategy/industryData.service.js')
    const r = await industryAssessmentService.publishAssessment(BLOCK(), { sub: { code: CODE, name: 'Semiconductors' }, row: ROW(), money: moneyFacts(MONEY_NODE), now: NOW })
    assert.equal(r.doc.money.capex_change, 0.5)
    assert.ok(TOOLS.some(t => t.name === 'get_industry_money') && TOOLS.some(t => t.name === 'get_capex_leaders'))
})

test('one run per industry at a time: a second Assess now while the first researches is refused, not paid for', async () => {
    const { assessIndustry: assess, _resetRunning } = await import('../../services/industryAssessmentRun.service.js')
    _resetRunning()
    let release
    const gate = new Promise(r => { release = r })
    const slow = DEPS({ run: async () => { await gate; return { reply: 'ok', assessments: [BLOCK()] } } })
    const first = assess(CODE, { userId: 'admin', deps: slow })
    const second = await assess(CODE, { userId: 'admin', deps: slow })
    assert.equal(second.outcome, 'already_running')
    release()
    assert.equal((await first).outcome, 'published')
    assert.equal((await assess(CODE, { userId: 'admin', deps: DEPS() })).outcome, 'published', 'free again once the first finished')
})

test('the controller answers a run\'s outcome with the right status, and hides retired themes\' verdicts', async () => {
    const { runStatus, visibleAssessments, themeForTraders } = await import('../../api/strategy/strategy.controller.js')
    assert.equal(runStatus({ ok: true }, 'x'), 200)
    assert.equal(runStatus({ outcome: 'already_running' }, 'x'), 409)
    assert.equal(runStatus({ outcome: 'unknown_theme' }, 'unknown_theme'), 404)
    assert.equal(runStatus({ outcome: 'refused' }, 'x'), 422)
    assert.equal(runStatus({ outcome: 'error' }, 'x'), 500)
    const all = [{ subject: { kind: 'industry', code: CODE } }, { subject: { kind: 'theme', id: 'th_live' } }, { subject: { kind: 'theme', id: 'th_retired' } }]
    assert.deepEqual(visibleAssessments(all, [{ id: 'th_live' }]).map(a => a.subject.code ?? a.subject.id), [CODE, 'th_live'])
    assert.deepEqual(themeForTraders({ id: 't', approved_by: 'roy', proposed_by: 'pythia', retired_by: null, name: 'n' }), { id: 't', name: 'n' })
})

test('untagged articles are each their own key under the per-company cap', async () => {
    const { capPerSymbol } = await import('../../services/tools/news.tools.js')
    const u = (i) => ({ related: [], url: `https://x/${i}`, datetime: i, headline: `h${i}` })
    assert.equal(capPerSymbol([u(1), u(2), u(3), u(4), u(5)], 3).length, 5)
})

test('the verdict names the book (Roy, 2026-10-11): old words are read as the new, and the book sets the horizon', () => {
    const ok = (over) => checkAssessment(BLOCK(over))
    assert.equal(ok({ verdict: 'interesting_trade', horizon: 'weeks' }).assessment.verdict, 'swing')
    // Two verdicts (pythia-two-verdicts.md, 2026-10-31): an old long-term verdict is a long-term YES with no near-term case.
    const inv = ok({ verdict: 'interesting_invest', horizon: 'years' }).assessment
    assert.deepEqual([inv.verdict, inv.long_term?.call], ['no_case', 'yes'])
    assert.equal(ok({ verdict: 'swing', horizon: 'years' }).assessment.horizon, 'months', 'a swing is weeks to months')
    assert.equal(ok({ verdict: 'swing', horizon: 'weeks' }).assessment.horizon, 'weeks')
    assert.deepEqual([ok({ verdict: 'long_term', horizon: 'months' }).assessment.verdict, ok({ verdict: 'long_term' }).assessment.long_term.call], ['no_case', 'yes'])
    assert.equal(ok({ verdict: 'avoid', horizon: 'weeks' }).assessment.horizon, 'weeks', 'watch and avoid take any horizon')
    assert.match(ok({ verdict: 'buy' }).detail, /verdict must be one of swing\/watch\/avoid\/no_case — the long term is its own call/)
})

test('watch needs its deciding date within six weeks; without one it is published as no case (Roy, 2026-10-11)', () => {
    const now = '2026-10-11T12:00:00.000Z'
    const ok = (over) => checkAssessment(BLOCK(over), { now }).assessment
    const w = ok({ verdict: 'watch', decides_by: '2026-10-21' })
    assert.equal(w.verdict, 'watch')
    assert.equal(w.decides_by, '2026-10-21')
    assert.equal(w.watch_downgraded, undefined)
    assert.equal(ok({ verdict: 'watch', decides_by: '2026-11-22' }).verdict, 'watch', 'day 42 is inside')
    for (const [d, why] of [[undefined, /no decides_by/], ['2027-02-15', /more than 42 days out/], ['2026-10-01', /has passed/], ['soon', /not a date/]]) {
        const a = ok({ verdict: 'watch', decides_by: d })
        assert.equal(a.verdict, 'no_case')
        assert.match(a.watch_downgraded, why)
        assert.equal(a.decides_by, null)
    }
    assert.equal(ok({ verdict: 'no_case' }).verdict, 'no_case')
    assert.equal(ok({ verdict: 'avoid', decides_by: '2026-10-21' }).decides_by, null, 'only a watch carries a deciding date')
    assert.deepEqual(Object.keys(VERDICTS), ['swing', 'long_term', 'watch', 'avoid', 'no_case'])
})

test('a watch needs something moving it and the specific open question its date answers (2026-10-11)', () => {
    const now = '2026-10-11T12:00:00.000Z'
    const ok = (over) => checkAssessment(BLOCK({ verdict: 'watch', decides_by: '2026-10-28', question: 'Will hyperscalers hold 2027 capex guidance?', ...over }), { now }).assessment
    const w = ok({})
    assert.equal(w.verdict, 'watch')
    assert.equal(w.question, 'Will hyperscalers hold 2027 capex guidance?')
    const quiet = ok({ cause: { kind: 'none', text: 'nothing nameable' } })
    assert.equal(quiet.verdict, 'no_case')
    assert.match(quiet.watch_downgraded, /nothing nameable moved it/)
    assert.equal(quiet.question, null)
    assert.equal(quiet.decides_by, null)
    const vague = ok({ question: undefined })
    assert.equal(vague.verdict, 'no_case')
    assert.match(vague.watch_downgraded, /no open question/)
})

test('code review 2026-10-11: unverified watch, impossible dates, no case expiry, old words are not changes', async () => {
    const now = '2026-10-11T12:00:00.000Z'
    const ok = (over) => checkAssessment(BLOCK({ verdict: 'watch', decides_by: '2026-10-28', ...over }), { now }).assessment
    assert.equal(ok({ cause: { kind: 'unverified', text: 'search down' } }).verdict, 'no_case')
    assert.match(ok({ decides_by: '2026-02-30' }).watch_downgraded, /not a date/, 'Feb 30 does not roll into March')
    assert.equal(shouldLog({ verdict: 'interesting_trade', called_at: now }, 'swing', now), false, 'the same call in today\'s words')
    assert.equal(shouldLog({ verdict: 'interesting_trade', called_at: now }, 'avoid', now), true)
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const pub = await industryAssessmentService.publishAssessment(BLOCK({ verdict: 'no_case', horizon: 'weeks' }), { sub: { code: CODE, name: 'Semiconductors' }, row: ROW(), now: NOW })
    assert.equal(pub.doc.expires_at, new Date(Date.parse(NOW) + NO_CASE_EXPIRY_DAYS * 86_400_000).toISOString(), 'a fixed clock, not the horizon')
})

test('a web search citation is stored as its label, not as raw Markdown (live drive 2026-10-12)', () => {
    const r = checkAssessment(BLOCK({ evidence: { news: 'FDIC data ([ebs.publicnow.com](https://ebs.publicnow.com/view/06?utm_source=openai)).', price: 'Flat.' } }), { now: NOW })
    assert.ok(r.ok, r.detail)
    assert.equal(r.assessment.evidence.news, 'FDIC data (ebs.publicnow.com).')
})
