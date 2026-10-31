import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    checkAssessment, checkLongTerm, longTermOf, longTermYes, houseIndustriesFor, assessmentRow, industryAssessmentService, _setAssessmentIO,
    LONG_TERM_REVIEW_DAYS, LONG_TERM_STALE_DAYS,
} from '../../api/strategy/industryAssessment.service.js'
import { pythiaCallsService, _setCallsIO } from '../../api/strategy/pythiaCalls.service.js'
import { scanIndustry, longTermDue } from '../../api/strategy/changeScan.service.js'
import { bookSends, asBook, pythiaContext } from '../../services/houseScan.service.js'
import { longTermResult, engineAge, engineStaleCard, checkEngine, runWeekly, _setDeps as setWeekly, _resetActive, ENGINE_STALE_DAYS } from '../../services/pythiaWeekly.service.js'
import { _tick, _setDeps as setMonitor, _resetDuePass } from '../../monitoring/pythiaWeekly.monitor.service.js'
import { verdictLine } from '../../services/tools/industryViews.tools.js'
import { memDb } from '../helpers/memDb.js'

// Pythia's TWO VERDICTS (docs/design/pythia-two-verdicts.md; Roy, 2026-10-31: "Industry can hold two verdicts"): the near
// term as before, the long term its own call — reviewed monthly for every industry (D2), never denied by hype (D1) — and
// the engine's stall said out loud (D3).

const CODE = '45301020'
const NOW = '2026-10-31T12:00:00.000Z'
const DAY = 86_400_000
const plus = (iso, d) => new Date(Date.parse(iso) + d * DAY).toISOString()
const BLOCK = (over = {}) => ({
    industry: CODE, verdict: 'swing', horizon: 'months', thesis: 'HBM orders sold out through 2027.',
    evidence: { news: 'SK hynix record Q3 (2026-10-28).', price: '+46% vs SPY over 12 months.' },
    cause: { kind: 'news', text: 'record memory results' }, second_order: 'Equipment makers next.',
    risks: ['capex pause'], change_view_if: ['a hyperscaler cuts capex'], confidence: 'medium', ...over,
})
const GOOD = { demand: 'growing', economics: 'good', cycle: 'peak' }

test('the block: a near-term verdict AND a long-term call; the old long-term verdict reads as a yes', () => {
    const a = checkAssessment(BLOCK({ long_term: { call: 'yes', thesis: 'AI demand for a decade; 35% ROIC.' } }), { structure: GOOD }).assessment
    assert.equal(a.verdict, 'swing')
    assert.deepEqual(a.long_term, { call: 'yes', thesis: 'AI demand for a decade; 35% ROIC.', why: null, override_reason: null })
    assert.match(checkAssessment(BLOCK({ verdict: 'long_term' })).assessment ? '' : 'refused', /^$/, 'an old block is not refused')
    const old = checkAssessment(BLOCK({ verdict: 'long_term', horizon: 'years' })).assessment
    assert.deepEqual([old.verdict, old.long_term.call, old.long_term.thesis], ['no_case', 'yes', 'HBM orders sold out through 2027.'])
    assert.equal(checkAssessment(BLOCK()).assessment.long_term, null, 'no long_term: the stored call stands')
})

test('the long-term call: a yes needs its thesis; outside the structure it needs her argument, else it is a no', () => {
    assert.equal(checkLongTerm({ call: 'maybe' }), null)
    assert.deepEqual(checkLongTerm({ call: 'no', why: 'demand in line with the market' }), { call: 'no', thesis: null, why: 'demand in line with the market', override_reason: null })
    assert.deepEqual(checkLongTerm({ call: 'yes' }), { call: 'no', thesis: null, why: 'no thesis for the long-term case', override_reason: null, downgraded: 'no thesis for the long-term case' })
    const flat = { demand: 'in_line', economics: 'good' }
    const noArg = checkLongTerm({ call: 'yes', thesis: 'x' }, { structure: flat })
    assert.equal(noArg.call, 'no')
    assert.match(noArg.downgraded, /outside the measured structure \(demand in_line, economics good\) with no argument/)
    const arg = checkLongTerm({ call: 'yes', thesis: 'x', override_reason: 'GLP-1 demand the ten-year history cannot see' }, { structure: flat })
    assert.deepEqual([arg.call, arg.override_reason], ['yes', 'GLP-1 demand the ten-year history cannot see'])
    assert.equal(checkLongTerm({ call: 'yes', thesis: 'x', override_reason: 'not needed' }, { structure: GOOD }).override_reason, null, 'inside the structure no argument is stored')
    assert.equal(checkLongTerm({ call: 'yes', thesis: 'x' }).call, 'yes', 'a theme has no structure, and needs none')
})

test('publishing stores the long-term call on its own clock, the hype flag the code\'s; a block without one keeps the stored call', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const sub = { code: CODE, name: 'Semiconductors', sector: 'Information Technology' }
    const row = { asof: '2026-10-27', code: CODE, raw: { ret_12m: 0.6, spy_12m: 0.15, hype: true } }
    const first = await industryAssessmentService.publishAssessment(BLOCK({ long_term: { call: 'yes', thesis: 'durable' } }), { sub, row, structure: GOOD, now: NOW })
    assert.deepEqual(first.doc.long_term, { call: 'yes', thesis: 'durable', why: null, override_reason: null, hype: true,
        reviewed_at: NOW, expires_at: plus(NOW, LONG_TERM_REVIEW_DAYS), previous: null })
    assert.deepEqual(first.changed.long_term, { from: null, to: 'yes' })
    const later = plus(NOW, 3)
    const second = await industryAssessmentService.publishAssessment(BLOCK({ verdict: 'avoid' }), { sub, row, structure: GOOD, now: later })
    assert.equal(second.doc.long_term.reviewed_at, NOW, 'no long_term in the block: the stored call stands')
    assert.equal(second.changed.long_term, undefined)
    const third = await industryAssessmentService.publishAssessment(BLOCK({ long_term: { call: 'no', why: 'capex peaking' } }), { sub, row, structure: GOOD, now: plus(NOW, 4) })
    assert.deepEqual([third.doc.long_term.call, third.doc.long_term.previous], ['no', 'yes'])
})

test('reading a document: the old long-term verdict is a yes; a yes speaks for the house for 60 days', () => {
    assert.equal(longTermOf({ verdict: 'swing' }), null)
    assert.deepEqual(longTermOf({ verdict: 'interesting_invest', thesis: 't', assessed_at: NOW, moved: { hype: true } }),
        { call: 'yes', thesis: 't', hype: true, reviewed_at: NOW, expires_at: null, legacy: true })
    const yes = { long_term: { call: 'yes', reviewed_at: NOW } }
    assert.ok(longTermYes(yes, plus(NOW, LONG_TERM_STALE_DAYS - 1)))
    assert.equal(longTermYes(yes, plus(NOW, LONG_TERM_STALE_DAYS + 1)), null)
    assert.equal(longTermYes({ long_term: { call: 'no', reviewed_at: NOW } }, NOW), null)
    const row = assessmentRow({ id: 'x', verdict: 'swing', long_term: { call: 'yes', hype: true, reviewed_at: NOW, expires_at: plus(NOW, 30), thesis: 'heavy' } })
    assert.deepEqual(row.long_term, { call: 'yes', hype: true, reviewed_at: NOW, expires_at: plus(NOW, 30) })
})

test('the long-term book reads the long-term call — beside a swing or an avoid — and the swing book the near term', () => {
    const doc = (code, verdict, lt, o = {}) => ({ subject: { kind: 'industry', code, name: code, sector: 'IT' }, verdict, horizon: 'months', thesis: `${code} near`,
        expires_at: plus(NOW, 10), long_term: lt, moved: { hype: false, excess_12m: 0.1 }, ...o })
    const rows = [
        doc('SEMI', 'swing', { call: 'yes', thesis: 'SEMI durable', reviewed_at: NOW }),
        doc('HCD', 'avoid', { call: 'yes', thesis: 'HCD durable', reviewed_at: NOW }),
        doc('BANK', 'swing', { call: 'no', why: 'x', reviewed_at: NOW }),
        // Its near term expired; its long-term yes keeps its own clock.
        doc('PAY', 'no_case', { call: 'yes', thesis: 'PAY durable', reviewed_at: NOW }, { expires_at: plus(NOW, -1) }),
    ]
    const lt = houseIndustriesFor(rows, [], { book: 'long_term', now: NOW })
    assert.deepEqual(lt.map(e => e.code).sort(), ['HCD', 'PAY', 'SEMI'])
    const hcd = lt.find(e => e.code === 'HCD')
    assert.deepEqual([hcd.thesis, hcd.horizon, hcd.near_term, hcd.avoid], ['HCD durable', 'years', 'avoid', true])
    assert.equal(lt.find(e => e.code === 'PAY').near_term, null)
    assert.deepEqual(houseIndustriesFor(rows, [], { book: 'swing', now: NOW }).map(e => e.code).sort(), ['BANK', 'SEMI'])
})

test('the call log: a long-term yes made in this publish is its own call, against its own last', async () => {
    const m = memDb()
    const prices = { AAA: 10, BBB: 20, CCC: 30, SPY: 500, QQQ: 400, RSP: 150 }
    _setCallsIO({ db: async () => m.db, companies: async () => [{ symbol: 'AAA' }, { symbol: 'BBB' }, { symbol: 'CCC' }], price: async (s) => prices[s] ?? null })
    const doc = { subject: { kind: 'industry', code: CODE, name: 'Semis' }, verdict: 'swing', horizon: 'months', thesis: 'near', assessed_at: NOW,
        long_term: { call: 'yes', thesis: 'durable', reviewed_at: NOW } }
    const r = await pythiaCallsService.recordCall(doc, { now: NOW })
    assert.deepEqual([r.call.verdict, r.long_term_call.verdict, r.long_term_call.horizon, r.long_term_call.thesis], ['swing', 'long_term', 'years', 'durable'])
    assert.match(r.long_term_call.id, /_lt$/)
    // A week later the near term flips; the long-term yes is the same call, reaffirmed within the window: not logged again.
    const later = plus(NOW, 7)
    const r2 = await pythiaCallsService.recordCall({ ...doc, verdict: 'avoid', assessed_at: later, long_term: { ...doc.long_term, reviewed_at: later } }, { now: later })
    assert.equal(r2.call.verdict, 'avoid')
    assert.equal(r2.long_term_call, undefined)
    // A publish that made no long-term call (the stored one is older): only the near term is considered.
    const r3 = await pythiaCallsService.recordCall({ ...doc, verdict: 'watch', assessed_at: plus(NOW, 8) }, { now: plus(NOW, 8) })
    assert.equal(r3.long_term_call, undefined)
})

test('the change scan: a long-term call never made, or past its review, is due', () => {
    assert.deepEqual(longTermDue({}, NOW), { key: 'long_term_due', detail: 'never made' })
    assert.equal(longTermDue({ long_term: { call: 'no', reviewed_at: NOW, expires_at: plus(NOW, 1) } }, NOW), null)
    assert.match(longTermDue({ long_term: { call: 'yes', reviewed_at: '2026-09-20T00:00:00Z', expires_at: '2026-10-20T00:00:00Z' } }, NOW).detail, /reviewed 2026-09-20/)
    const moved = { asof: '2026-10-27', ret_24m: 0.3, spy_24m: 0.4, excess_12m: 0.05, rel_1m: 0.01, ext_percentile: 0.5, hype: false }
    const f = scanIndustry({ code: CODE, name: 'Semis', now: { moved, money: null }, assessment: { verdict: 'swing', moved, money: null, expires_at: plus(NOW, 10) }, at: NOW })
    assert.deepEqual(f.reasons.map(r => r.key), ['long_term_due'])
})

test('the chain: a swing sends to the swing book, a NEW long-term yes to the long-term book — a reaffirmed yes sends nothing', () => {
    const sends = bookSends([
        { code: 'A', outcome: 'published', verdict: 'swing', long_term: 'yes', long_term_new: true },
        { code: 'B', outcome: 'published', verdict: 'no_case', long_term: 'yes', long_term_new: false },
        { code: 'C', outcome: 'refused', verdict: 'swing' },
        { code: 'D', outcome: 'published', verdict: 'long_term' },
    ])
    assert.deepEqual(sends.map(s => `${s.r.code}:${s.book}`), ['A:swing', 'A:long_term', 'D:long_term'])
    const a = { id: 'ia', subject: { name: 'Semis', kind: 'industry' }, verdict: 'swing', horizon: 'months', thesis: 'near', long_term: { call: 'yes', thesis: 'durable', reviewed_at: new Date().toISOString() } }
    const view = asBook(a, 'long_term')
    assert.deepEqual([view.verdict, view.horizon, view.thesis], ['long_term', 'years', 'durable'])
    assert.equal(pythiaContext(view).verdict, 'long_term', "Prometheus's target horizon reads the book")
    assert.equal(asBook({ ...a, verdict: 'avoid' }, 'swing'), null, 're-assessed since: the swing is gone')
    assert.equal(asBook({ ...a, long_term: { call: 'no' } }, 'long_term'), null)
    assert.deepEqual(longTermResult({ assessed_at: NOW, long_term: { call: 'yes', previous: 'no', reviewed_at: NOW } }), { long_term: 'yes', long_term_new: true })
    assert.deepEqual(longTermResult({ assessed_at: NOW, long_term: { call: 'yes', previous: 'yes', reviewed_at: NOW } }), { long_term: 'yes', long_term_new: false })
    assert.deepEqual(longTermResult({ assessed_at: NOW, long_term: { call: 'yes', reviewed_at: '2026-10-01' } }), {}, 'a call from an earlier publish is not this run\'s')
})

test('the stale engine: one card per stale run to every admin, never twice', async () => {
    assert.deepEqual(engineAge({ asof: '2026-10-27' }, NOW), { stale: false, days: 4, asof: '2026-10-27' })
    assert.deepEqual(engineAge({ asof: '2026-10-07' }, NOW), { stale: true, days: 24, asof: '2026-10-07' })
    assert.equal(engineAge({ asof: '2026-10-22' }, NOW).stale, ENGINE_STALE_DAYS < 9, 'nine days is stale')
    assert.match(engineStaleCard(engineAge({ asof: '2026-10-07' }, NOW), 'u1').content, /last industry price run is 2026-10-07, finished 24 days ago/)
    // Counted from the finish: a Sunday run prices Friday, so the next Sunday morning is 9 days by asof — not stale.
    const sunday = { asof: '2026-10-23', run: { finished_at: '2026-10-25T05:00:00Z' } }
    assert.deepEqual(engineAge(sunday, '2026-11-01T03:00:00Z'), { stale: false, days: 6, asof: '2026-10-23' })
    assert.equal(engineAge({ ...sunday, run: { finished_at: new Date('2026-10-25T05:00:00Z') } }, '2026-11-03T06:00:00Z').stale, true, 'a Date reads too')
    const m = memDb()
    await m.db.collection('pythia_weekly').insertOne({ id: 'pw_2026-10-07', asof: '2026-10-07', status: 'done' })
    const posted = []
    const deps = { latestRun: async () => ({ asof: '2026-10-07' }), db: async () => m.db, now: () => NOW,
        adminUserIds: async () => ['roy', 'marce'], post: async (card) => { posted.push(card.userId); return card } }
    assert.equal((await checkEngine(deps)).carded, true)
    assert.equal((await checkEngine(deps)).carded, false)
    assert.deepEqual(posted, ['roy', 'marce'])
    assert.deepEqual(await checkEngine({ ...deps, latestRun: async () => ({ asof: '2026-10-27' }) }), { stale: false, days: 4, asof: '2026-10-27' })
})

test('the monitor: a stale engine gets one due pass a day; a fresh one none', async () => {
    _resetDuePass()
    let dues = 0, t = Date.parse(NOW)
    setMonitor({ enabled: () => true, run: async () => ({ outcome: 'exists' }), resume: async () => ({}), engine: async () => ({ stale: true, days: 24 }),
        runDue: async () => { dues++; return { outcome: 'done' } }, now: () => t })
    await _tick(); await _tick()
    assert.equal(dues, 1, 'once a day')
    t += DAY
    await _tick()
    assert.equal(dues, 2)
    setMonitor({ engine: async () => ({ stale: false }) })
    t += 2 * DAY
    await _tick()
    assert.equal(dues, 2)
})

test('a due pass re-opens a done week for what is due by the clock only, and hands on only its own results', async () => {
    _resetActive()
    const m = memDb()
    await m.db.collection('pythia_weekly').insertOne({ id: 'pw_2026-10-07', asof: '2026-10-07', status: 'done', results: [], started_at: '2026-10-11T00:00:00Z' })
    const moved = { asof: '2026-10-07', ret_24m: 0.3, spy_24m: 0.4, excess_12m: 0.05, rel_1m: 0.01, ext_percentile: 0.5, hype: false }
    const fresh = { call: 'no', why: 'x', reviewed_at: NOW, expires_at: plus(NOW, 20) }
    const assessed = [], handed = []
    setWeekly({
        latestRun: async () => ({ asof: '2026-10-07' }), readRun: async () => ({ rows: [
            { code: 'DUE', name: 'Due', raw: {} }, { code: 'OK', name: 'Ok', raw: {} }], regime: null }),
        readMoney: async () => new Map(), readFlows: async () => new Map(), readGeo: async () => () => null,
        listAssessments: async () => [
            { subject: { kind: 'industry', code: 'DUE' }, verdict: 'no_case', moved, money: null, expires_at: plus(NOW, 10) },
            { subject: { kind: 'industry', code: 'OK' }, verdict: 'no_case', moved, money: null, expires_at: plus(NOW, 10), long_term: fresh }],
        listThemes: async () => [], bookTo: async () => 'admin', cap: () => Infinity, maxUsd: () => 3, db: async () => m.db, now: () => NOW,
        assessIndustry: async (code) => { assessed.push(code); return { ok: true, outcome: 'published', doc: { verdict: 'no_case', assessed_at: NOW, long_term: { call: 'yes', previous: null, reviewed_at: NOW } }, cost_usd: 0.01 } },
        houseScan: async (results) => { handed.push(results.map(r => r.code)); return { queued: [] } }, research: async () => null,
    })
    assert.equal((await runWeekly()).outcome, 'exists', 'without the due pass, a done week is done')
    const r = await runWeekly({ dueOnly: true })
    assert.equal(r.outcome, 'done')
    assert.deepEqual(assessed, ['DUE'], 'only what is due by the clock — not a "change" read off the old prices')
    assert.deepEqual(handed, [['DUE']])
    const week = await m.db.collection('pythia_weekly').findOne({ id: 'pw_2026-10-07' })
    assert.deepEqual(week.results.map(x => [x.code, x.long_term, x.long_term_new]), [['DUE', 'yes', true]])

    // A week the regular run left open (failed, paused) is not the due pass's to close: the regular run finishes it.
    _resetActive()
    for (const status of ['failed', 'paused']) {
        await m.db.collection('pythia_weekly').updateOne({ id: 'pw_2026-10-07' }, { $set: { status } })
        assert.equal((await runWeekly({ dueOnly: true })).outcome, 'week_open', status)
        assert.equal((await m.db.collection('pythia_weekly').findOne({ id: 'pw_2026-10-07' })).status, status)
    }
    assert.equal(assessed.length, 1)
})

test('the tools say the long term beside the near term', () => {
    assert.match(verdictLine({ verdict: 'swing', long_term: { call: 'yes', hype: true } }), /FOR SWING · LONG TERM: yes \(stretched — a timing flag\)/)
    assert.match(verdictLine({ verdict: null, long_term: { call: 'yes' } }), /no near-term verdict · LONG TERM: yes/)
    assert.equal(verdictLine({ verdict: null }), '')
})
