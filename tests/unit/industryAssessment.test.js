import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    checkAssessment, factsFor, formatFacts, industryAssessmentService, _setAssessmentIO, VERDICTS, EXPIRY_DAYS, ordinal,
} from '../../api/strategy/industryAssessment.service.js'
import {
    shouldLog, gradeCall, summarise, pythiaCallsService, _setCallsIO, REAFFIRM_DAYS, BENCHMARKS,
} from '../../api/strategy/pythiaCalls.service.js'
import { assessIndustry, structureOf, deskSpend } from '../../services/industryAssessmentRun.service.js'
import { _tick } from '../../monitoring/pythiaCalls.monitor.service.js'
import { _parseStrategyResponse, _buildTurnContext, TOOLS } from '../../services/agents/strategy.agent.service.js'

// Pythia's assessment (docs/design/pythia-assessment.md, build step 1): the guardrails, the facts the code
// attaches, the forward log and its grader, the headless run — all through their seams.

const CODE = '45301020'
const NOW = '2026-10-10T12:00:00.000Z'
const BLOCK = (over = {}) => ({
    industry: CODE, verdict: 'watch', horizon: 'months',
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

// ── a small in-memory Mongo, enough for these services ───────────────────────

function _get(o, path) { return path.split('.').reduce((x, k) => (x == null ? x : x[k]), o) }
function _setPath(o, path, v) { const ks = path.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = (x[k] ??= {}); x[ks.at(-1)] = v }
function _match(doc, q) { return Object.entries(q).every(([k, v]) => JSON.stringify(_get(doc, k)) === JSON.stringify(v)) }
function memDb() {
    const cols = {}
    const col = (name) => {
        const rows = (cols[name] ??= [])
        const cursor = (list) => {
            let out = [...list]
            const c = {
                sort: (spec) => { const [[k, dir]] = Object.entries(spec); out.sort((a, b) => (_get(a, k) > _get(b, k) ? 1 : -1) * dir); return c },
                limit: (n) => { out = out.slice(0, n); return c },
                next: async () => out[0] ?? null,
                toArray: async () => out,
            }
            return c
        }
        return {
            rows,
            findOne: async (q) => structuredClone(rows.find(r => _match(r, q)) ?? null),
            find: (q = {}) => cursor(rows.filter(r => _match(r, q)).map(r => structuredClone(r))),
            replaceOne: async (q, d, { upsert } = {}) => { const i = rows.findIndex(r => _match(r, q)); if (i >= 0) rows[i] = structuredClone(d); else if (upsert) rows.push(structuredClone(d)); return { matchedCount: i >= 0 ? 1 : 0 } },
            updateOne: async (q, u, { upsert } = {}) => {
                let doc = rows.find(r => _match(r, q))
                if (!doc && upsert) { doc = { ...q, ...(u.$setOnInsert ?? {}) }; rows.push(doc) }
                if (!doc) return { matchedCount: 0 }
                for (const [k, v] of Object.entries(u.$set ?? {})) _setPath(doc, k, structuredClone(v))
                for (const [k, v] of Object.entries(u.$push ?? {})) { const arr = (_get(doc, k) ?? []); arr.splice(v.$position ?? arr.length, 0, ...v.$each); _setPath(doc, k, arr) }
                return { matchedCount: 1 }
            },
            createIndex: async () => {},
        }
    }
    const db = { collection: (n) => col(n) }
    return { db, rows: (n) => col(n).rows }
}

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
    assert.deepEqual(Object.keys(VERDICTS), ['interesting_trade', 'interesting_invest', 'watch', 'avoid'])
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
    verdict: 'interesting_trade', basket: ['AAA', 'BBB', 'CCC', 'DDD'],
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

test('the grader grades a horizon once it is reached and closes the call after the last', async () => {
    const m = memDb()
    m.rows('pythia_calls').push({ id: 'pc_1', status: 'open', called_at: '2025-10-01T00:00:00.000Z', grades: {}, ...CALL() })
    m.rows('pythia_calls').push({ id: 'pc_2', status: 'open', called_at: '2026-09-01T00:00:00.000Z', grades: {}, ...CALL() })
    _setCallsIO({ db: async () => m.db, price: async (s) => ({ AAA: 11, BBB: 11, CCC: 11, DDD: 11, SPY: 101, QQQ: 102, RSP: 101 }[s]) })
    const r = await pythiaCallsService.gradeDue({ now: NOW })
    assert.deepEqual(r, { graded: 2, failed: 0 })
    const [a, b] = m.rows('pythia_calls')
    assert.ok(a.grades['3m'] && a.grades['12m'])
    assert.equal(a.status, 'closed')
    assert.deepEqual(b.grades, {}, 'not yet three months')
    assert.equal(b.status, 'open')
})

test('the grader monitor runs one pass', async () => {
    assert.deepEqual(await _tick({ grade: async () => ({ graded: 0, failed: 0 }) }), { graded: 0, failed: 0 })
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
        spend: async () => spend, settle: async () => {}, now: () => NOW,
        ...over,
    }
}

test('Assess now publishes and reports what the run cost', async () => {
    const r = await assessIndustry(CODE, { userId: 'admin', deps: DEPS() })
    assert.equal(r.outcome, 'published')
    assert.ok(Math.abs(r.cost_usd - 0.42) < 1e-9)
    assert.deepEqual(r.doc.structure, { demand: 'growing', economics: 'good', cycle: 'peak' })
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

test('industry news reads the largest companies as a basket keyed by the industry, and rolls up when thin', async () => {
    const { industryNews } = await import('../../services/agents/strategy.agent.service.js')
    const fetched = []
    const deps = {
        readSub: async () => ({ sub: { code: CODE, name: 'Semiconductors', answered_at: { level: 'industry', code: '453010' } } }),
        companies: async (level) => (level === 'sub_industry' ? [{ symbol: 'NVDA' }] : [{ symbol: 'NVDA' }, { symbol: 'AMD' }, { symbol: 'AVGO' }]),
        fetch: async (o) => { fetched.push(o); return { articles: [{ related: ['AMD'], datetime: Math.floor(Date.parse(NOW) / 1000) - 3600, headline: 'AMD wins a deal', summary: 's', source: 'Reuters' }] } },
    }
    const text = await industryNews({ industry: CODE }, deps)
    assert.deepEqual(fetched[0], { category: 'basket', subject: `gics_${CODE}`, query: 'AMD,AVGO,NVDA' }, 'one sub-industry name is too few: its industry answers')
    assert.match(text, /Semiconductors — its 3 largest companies/)
    assert.match(text, /AMD wins a deal/)
    assert.match(await industryNews({ industry: 'nope' }, { ...deps, readSub: async () => null }), /Unknown sub-industry/)
})
