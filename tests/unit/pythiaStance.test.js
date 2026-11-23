import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookOf, verdictAt, stanceFor, pythiaOnCall, agreement } from '../../services/pythiaStance.js'
import { verdictChange, coveragesToRevise, onAssessmentPublished, REVISION_STATE } from '../../services/industryVerdictCoverage.service.js'
import { formatIndustryCase } from '../../services/tools/industryCase.tools.js'
import { remodelDecision, REVISE_STATES } from '../../monitoring/coverage.remodel.js'

// Roy, 2026-11-22: "pythia analyse the industries — is prometheus looking at its analysis and data it brings?" → her
// case as his tool, a re-model when her stance changes, and her stance frozen on every call.

// Today avoid → swing on 11-08 (long term no → yes), swing since 10-20 before an avoid on 11-01.
const DOC = {
    subject: { kind: 'industry', code: '45301010', name: 'Semiconductor Materials & Equipment', sector: 'Information Technology' },
    verdict: 'swing', expires_at: '2026-12-20T00:00:00.000Z', assessed_at: '2026-11-08T06:00:00.000Z',
    long_term: { call: 'yes', reviewed_at: '2026-11-08T06:00:00.000Z' },
    revisions: [
        { at: '2026-11-08T06:00:00.000Z', changed: { verdict: { from: 'avoid', to: 'swing' }, long_term: { from: 'no', to: 'yes' } } },
        { at: '2026-11-01T06:00:00.000Z', changed: { verdict: { from: 'swing', to: 'avoid' } } },
        { at: '2026-10-20T06:00:00.000Z', changed: { verdict: { from: null, to: 'swing' } } },
    ],
}

test('the book: a 3m / 6m target is swing, anything longer (or none) long term', () => {
    assert.equal(bookOf('3m'), 'swing')
    assert.equal(bookOf('6m'), 'swing')
    assert.equal(bookOf('12m'), 'long_term')
    assert.equal(bookOf(null), 'long_term')
})

test('what she said on a day, walked back from today’s document', () => {
    assert.equal(verdictAt(DOC, '2026-10-01T00:00:00.000Z'), null, 'before her first assessment')
    assert.deepEqual(verdictAt(DOC, '2026-10-25T00:00:00.000Z'), { verdict: 'swing', long_term: 'no', assessed_at: '2026-10-20T06:00:00.000Z' })
    assert.equal(verdictAt(DOC, '2026-11-03T00:00:00.000Z').verdict, 'avoid')
    assert.deepEqual(verdictAt(DOC, '2026-11-10T00:00:00.000Z'), { verdict: 'swing', long_term: 'yes', assessed_at: '2026-11-08T06:00:00.000Z' })
    assert.equal(verdictAt(DOC, '2026-12-21T00:00:00.000Z').verdict, null, 'today’s near term past its expiry speaks no more')
})

test('her stance on the call’s book, and a call with her or against her', () => {
    const avoid = { verdict: 'avoid', long_term: 'no' }, swing = { verdict: 'swing', long_term: 'no' }, watch = { verdict: 'watch', long_term: 'yes' }
    assert.equal(stanceFor(swing, '6m'), 'for')
    assert.equal(stanceFor(avoid, '3m'), 'against')
    assert.equal(stanceFor(watch, '6m'), 'neutral')
    assert.equal(stanceFor(watch, '12m'), 'for', 'the long book reads her long-term call')
    assert.equal(stanceFor(avoid, '24m'), 'against', 'a near-term avoid counts against the long book too')
    assert.equal(stanceFor(swing, '12m'), 'neutral')
    assert.equal(stanceFor(null, '6m'), null)
    assert.equal(agreement(1, 'for'), 'with')
    assert.equal(agreement(-1, 'for'), 'against')
    assert.equal(agreement(-1, 'against'), 'with')
    assert.equal(agreement(1, 'neutral'), 'neutral')
    assert.equal(agreement(0, 'for'), null, 'a hold has no side')
})

test('the frozen record on a call', () => {
    const company = { sub_code: '45301010', sub_industry: 'Semiconductor Materials & Equipment' }
    assert.deepEqual(pythiaOnCall({ company, doc: DOC, horizon: '6m', at: '2026-11-03T00:00:00.000Z' }),
        { code: '45301010', industry: 'Semiconductor Materials & Equipment', book: 'swing', verdict: 'avoid', long_term: 'no', stance: 'against', assessed_at: '2026-11-01T06:00:00.000Z' })
    assert.equal(pythiaOnCall({ company: null, horizon: '6m', at: 'x' }).why, 'not classified')
    assert.equal(pythiaOnCall({ company, doc: DOC, horizon: '6m', at: '2026-10-01T00:00:00.000Z' }).why, 'not assessed then')
})

test('a changed verdict re-models only the coverage whose book it moved', () => {
    const changed = DOC.revisions[0].changed
    const change = verdictChange(DOC, changed)
    assert.deepEqual(change, { before: { verdict: 'avoid', long_term: 'no' }, after: { verdict: 'swing', long_term: 'yes' } })
    assert.equal(verdictChange(DOC, { horizon: { from: 'weeks', to: 'months' } }), null, 'no verdict changed')
    const todo = coveragesToRevise([
        { id: 'a', symbol: 'AMAT', price_target: { horizon: '6m' } },
        { id: 'b', symbol: 'LRCX', price_target: { horizon: '12m' } },
    ], change, 'Semis')
    assert.deepEqual(todo.map(t => t.symbol), ['AMAT', 'LRCX'])
    assert.match(todo[0].reason, /swing stance AGAINST → FOR/)
    assert.match(todo[1].reason, /long-term stance AGAINST → FOR/)
    // swing → watch moves the swing book only.
    const watch = verdictChange({ ...DOC, verdict: 'watch' }, { verdict: { from: 'swing', to: 'watch' } })
    assert.deepEqual(coveragesToRevise([{ id: 'a', symbol: 'AMAT', price_target: { horizon: '6m' } }, { id: 'b', symbol: 'LRCX', price_target: { horizon: '24m' } }], watch, 'Semis').map(t => t.symbol), ['AMAT'])
})

test('after a publish: the names in that sub-industry queued, the rest left alone; a failure never throws', async () => {
    const queued = []
    const deps = {
        liveCoverage: async () => [{ id: 'a', symbol: 'AMAT', price_target: { horizon: '6m' } }, { id: 'n', symbol: 'NVDA', price_target: { horizon: '6m' } }],
        companies: async () => ({ AMAT: { sub_code: '45301010' }, NVDA: { sub_code: '45301020' } }),
        queue: async (id, opts) => { queued.push([id, opts.state]); return true },
        now: () => '2026-11-08T07:00:00.000Z',
    }
    const r = await onAssessmentPublished(DOC, DOC.revisions[0].changed, deps)
    assert.deepEqual(r, { queued: 1, symbols: ['AMAT'] })
    assert.deepEqual(queued, [['a', REVISION_STATE]])
    assert.equal((await onAssessmentPublished({ ...DOC, subject: { kind: 'theme', id: 't' } }, DOC.revisions[0].changed, deps)).queued, 0, 'themes: not here')
    const bad = await onAssessmentPublished(DOC, DOC.revisions[0].changed, { ...deps, liveCoverage: async () => { throw new Error('db down') } })
    assert.equal(bad.queued, 0)
    assert.equal(bad.error, 'db down')
})

test('the queued revision is a verdict the monitor re-models under the short cooldown', () => {
    assert.ok(REVISE_STATES.has(REVISION_STATE))
    const d = remodelDecision({ monitor: { pending_revision: { state: REVISION_STATE, reason: 'Semis: her swing stance AGAINST → FOR', at: '2026-11-08T07:00:00.000Z' } } }, { nowMs: Date.parse('2026-11-08T08:00:00.000Z') })
    assert.equal(d.due, true)
    assert.match(d.reason, /industry strategist changed her stance.*Semis: her swing stance/)
})

test('her case as Prometheus reads it: the verdicts, the thesis, the stance on his book', () => {
    const text = formatIndustryCase({ symbol: 'AMAT', company: { sub_code: '45301010', sub_industry: 'Semiconductor Materials & Equipment', sector: 'Information Technology' },
        doc: { ...DOC, thesis: 'Capex is rising.', risks: ['Margins at a 10-year high.'], change_view_if: ['Capex turns negative.'], horizon: 'months', confidence: 'medium',
            moved: { asof: '2026-11-06', excess_12m: 0.57, hype: false }, money: { capex_change: 0.39 } },
        view: { status: 'answered', demand: { grade: 'growing' }, economics: { grade: 'good' }, cycle: { grade: 'peak' } },
        horizon: '6m', now: '2026-11-10T00:00:00.000Z' })
    assert.match(text, /Near-term verdict: For swing \(months\) · confidence medium/)
    assert.match(text, /stance on the SWING book \(a 6m target\): FOR/)
    assert.match(text, /Thesis: Capex is rising\./)
    assert.match(text, /She changes her view if: Capex turns negative\./)
    assert.match(text, /12m vs SPY \+57%/)
    assert.match(text, /capex \+39%/)
    assert.match(text, /Long-term call: YES/)
    assert.match(text, /Structure: demand growing · economics good · cycle peak/)
    assert.match(formatIndustryCase({ symbol: 'ZZZ', company: null }), /not classified/)
    assert.match(formatIndustryCase({ symbol: 'AMAT', company: { sub_code: '1', sub_industry: 'X' }, doc: null }), /not assessed this industry yet/)
    assert.match(formatIndustryCase({ symbol: 'AMAT', company: { sub_code: '1', sub_industry: 'X' }, doc: DOC, now: '2026-12-25T00:00:00.000Z' }), /EXPIRED 2026-12-20/)
})
