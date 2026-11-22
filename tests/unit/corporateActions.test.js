import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { _setClientFactory, closeDb } from '../../providers/mongodb.provider.js'
import { splitRatio, perShare, splitsAfter, splitsSince, _setCorporateActionsIO, LOOKBACK_DAYS } from '../../services/corporateActions.service.js'
import { coverageService, splitAdjustment, SPLIT_KIND } from '../../api/analyst/coverage.service.js'
import { splitAdjustedCall, prometheusCallsService } from '../../services/prometheusCalls.service.js'
import { _catchSplits } from '../../monitoring/coverage.monitor.service.js'
import { remodelDecision, REVISE_STATES } from '../../monitoring/coverage.remodel.js'

// 2026-11-22 — a stock split caught on the coverage monitor's daily check (SNDK 8-for-1 on 2026-11-20).

const SNDK_SPLIT = { symbol: 'SNDK', date: '2026-11-20', numerator: 8, denominator: 1, splitType: 'stock-split' }

test('a split\'s ratio: 8-for-1 divides a per-share number by 8, a 1-for-5 reverse split by 0.2; junk is no split', () => {
    assert.equal(splitRatio(SNDK_SPLIT), 8)
    assert.equal(splitRatio({ numerator: 1, denominator: 5 }), 0.2)
    assert.equal(splitRatio({ numerator: 3, denominator: 3 }), null)
    assert.equal(splitRatio({ numerator: 0, denominator: 1 }), null)
    assert.equal(splitRatio(null), null)
    assert.equal(perShare(1710, 8), 213.75)
    assert.equal(perShare(10, 0.2), 50)
    assert.equal(perShare(null, 8), null)
    assert.equal(perShare('x', 8), 'x')
})

test('the splits of one name after a day, up to today, oldest first', () => {
    const rows = [SNDK_SPLIT, { ...SNDK_SPLIT, date: '2026-12-01' }, { ...SNDK_SPLIT, symbol: 'AAPL' },
        { ...SNDK_SPLIT, date: '2026-11-01', numerator: 2 }, { ...SNDK_SPLIT, date: '2026-11-10', numerator: 1, denominator: 1 }]
    const got = splitsAfter(rows, 'sndk', '2026-11-06', '2026-11-22')
    assert.deepEqual(got.map(s => [s.date, s.ratio]), [['2026-11-20', 8]], 'after the day only, not the future one, not a 1:1')
    assert.equal(splitsAfter(rows, 'SNDK', '2026-11-20', '2026-11-22').length, 0, 'the day itself is not "after"')
    assert.deepEqual(splitsAfter(rows, 'SNDK', null, '2026-11-22').map(s => s.date), ['2026-11-01', '2026-11-20'])
})

test('one calendar read serves every name; a failed read is no split, and is not retried by every name', async () => {
    let reads = 0, fail = false
    const now = Date.parse('2026-11-22T12:00:00Z')
    _setCorporateActionsIO({ now: () => now, calendar: async (from, to) => {
        reads++
        if (fail) throw new Error('fmp down')
        assert.equal(to, '2026-11-22')
        assert.equal(from, new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10))
        return [SNDK_SPLIT]
    } })
    assert.equal((await splitsSince('SNDK', '2026-11-06')).length, 1)
    assert.equal((await splitsSince('AAPL', '2026-11-06')).length, 0)
    assert.equal(reads, 1, 'cached')
    _setCorporateActionsIO({})   // clears the cache
    fail = true
    assert.deepEqual(await splitsSince('SNDK', '2026-11-06'), [])
    assert.deepEqual(await splitsSince('SNDK', '2026-11-06'), [])
    assert.equal(reads, 2, 'one failed read, then the wait')
})

const SNDK = () => ({
    id: 'cov_SNDK_1', symbol: 'SNDK', status: 'active', rating: 'strong_buy', thesis: 't',
    price_target: { value: 1710, low: 1550, high: 2000, horizon: '12m', set_at: '2026-11-06T16:23:51.365Z', ref_price: 835.06, sigma_pct: 40 },
    risk_reward: { bear: { value: 770, multiple: 7, forward_metric: 110 }, base: { value: 1710, multiple: 9, forward_metric: 190 }, bull: { value: 2760, multiple: 12, forward_metric: 230 } },
    estimates: { ours: { eps_fy1: 190, revenue_fy1: 12_000 }, consensus: { eps_fy1: 225.94902 }, revision_trend: 'improving' },
    gap: { our_pt: 1710, consensus_pt: 2271.43, pct: -24.72, low: 1550, high: 3050, median: 2175 },
    horizon_views: { swing: { target: { value: 1200, horizon: '6m', low: 1100, high: 1300 }, price_at_set: 900 } },
    monitor: { checks: 1 }, revisions: [],
})

test('a coverage restated for a split: every per-share number ÷ the ratio — never a %, a multiple, revenue or the clock', () => {
    const set = splitAdjustment(SNDK(), 8)
    assert.equal(set['price_target.value'], 213.75)
    assert.equal(set['price_target.ref_price'], 104.38)
    assert.equal(set['risk_reward.base.forward_metric'], 23.75, 'EPS is per share')
    assert.equal(set['risk_reward.bull.value'], 345)
    assert.equal(set['estimates.ours.eps_fy1'], 23.75)
    assert.equal(set['estimates.consensus.eps_fy1'], 28.24)
    assert.equal(set['gap.consensus_pt'], 283.93)
    assert.equal(set['horizon_views.swing.target.value'], 150)
    assert.equal(set['horizon_views.swing.price_at_set'], 112.5)
    for (const k of ['price_target.sigma_pct', 'price_target.set_at', 'risk_reward.base.multiple', 'estimates.ours.revenue_fy1', 'gap.pct']) assert.equal(k in set, false, k)
    // A legacy bare-number leg.
    assert.equal(splitAdjustment({ risk_reward: { bull: 240 } }, 2)['risk_reward.bull'], 120)
})

test('a call restated for a split: a pre-split target and entry ÷ the ratio, once; a call after it, or graded out, untouched', () => {
    const call = { id: 'pc1', made_at: '2026-11-06T16:23:51.685Z', pt: 1710, entry: { day: '2026-11-06', price: 835.06, spy: 735.29 }, done: false }
    assert.deepEqual(splitAdjustedCall(call, { date: '2026-11-20', ratio: 8 }), { splits_applied: ['2026-11-20'], pt: 213.75, 'entry.price': 104.38 })
    assert.equal(splitAdjustedCall({ ...call, splits_applied: ['2026-11-20'] }, { date: '2026-11-20', ratio: 8 }), null, 'once')
    assert.equal(splitAdjustedCall({ ...call, made_at: '2026-11-20T15:00:00.000Z' }, { date: '2026-11-20', ratio: 8 }), null, 'made on the split day: post-split already')
    assert.equal(splitAdjustedCall({ ...call, done: true }, { date: '2026-11-20', ratio: 8 }), null)
    // Made the evening before; its entry is the split day's close — already post-split: only the target moves.
    assert.deepEqual(splitAdjustedCall({ ...call, made_at: '2026-11-19T22:00:00.000Z', entry: { day: '2026-11-20', price: 104 } }, { date: '2026-11-20', ratio: 8 }), { splits_applied: ['2026-11-20'], pt: 213.75 })
    assert.equal(splitAdjustedCall({ ...call, entry: null }, { date: '2026-11-20', ratio: 8 })['entry.price'], undefined)
})

test('a split is a revision that needs Prometheus — the re-model is queued under the verdict rule', () => {
    assert.equal(REVISE_STATES.has('split'), true)
    const nowMs = Date.parse('2026-11-22T12:00:00Z')
    const cov = { ...SNDK(), monitor: { last_remodel_at: '2026-11-06T16:21:15.158Z', pending_revision: { state: 'split', reason: '8-for-1 split on 2026-11-20', at: '2026-11-22T11:00:00.000Z' } } }
    const d = remodelDecision(cov, { nowMs })
    assert.equal(d.due, true)
    assert.match(d.reason, /the stock split.*8-for-1 split on 2026-11-20/)
})

test('the monitor\'s split check: since the last restated split, else the target\'s day; restates and goes on with the new doc', async () => {
    const asked = []
    const deps = {
        getSplits: async (sym, since) => { asked.push(since); return since < '2026-11-20' ? [{ ...SNDK_SPLIT, ratio: 8 }] : [] },
        applySplit: async (id, split) => ({ ok: true, outcome: 'restated', doc: { ...SNDK(), price_target: { value: 213.75 } }, calls: 1 }),
    }
    const out = await _catchSplits(SNDK(), deps)
    assert.equal(out.price_target.value, 213.75)
    assert.deepEqual(asked, ['2026-11-06'])
    await _catchSplits({ ...SNDK(), monitor: { split_through: '2026-11-20' } }, deps)
    assert.equal(asked[1], '2026-11-20')
    // A failed restate: checked as it was. A throwing read: the same. No deps (a test harness): nothing.
    assert.equal((await _catchSplits(SNDK(), { ...deps, applySplit: async () => ({ ok: false, reason: 'db' }) })).price_target.value, 1710)
    assert.equal((await _catchSplits(SNDK(), { ...deps, getSplits: async () => { throw new Error('x') } })).price_target.value, 1710)
    assert.equal((await _catchSplits(SNDK(), {})).price_target.value, 1710)
})

const { db, rows } = memDb()
const restore = _setClientFactory(() => ({ connect: async () => {}, db: () => db, close: async () => {} }))
process.env.MONGODB_URI ??= 'mongodb://fake.invalid/test'
await closeDb()
after(async () => { await closeDb(); restore?.() })

test('applySplit restates the coverage and its calls, says so on the trail, queues the re-model — and only once', async () => {
    rows('coverage').push(SNDK())
    rows('prometheus_calls').push(
        { id: 'pc_a', symbol: 'SNDK', coverage_id: 'cov_SNDK_1', made_at: '2026-11-06T16:23:51.685Z', pt: 1710, entry: { day: '2026-11-06', price: 835.06, spy: 735.29 }, marks: {}, done: false },
        { id: 'pc_b', symbol: 'SNDK', coverage_id: 'cov_SNDK_1', made_at: '2026-08-01T16:00:00.000Z', pt: 1000, entry: { day: '2026-08-01', price: 500, spy: 600 }, marks: {}, done: true },
    )
    const split = { ...SNDK_SPLIT, ratio: 8 }
    const res = await coverageService.applySplit('cov_SNDK_1', split)
    assert.deepEqual([res.ok, res.outcome, res.calls], [true, 'restated', 1])
    const doc = rows('coverage').find(d => d.id === 'cov_SNDK_1')
    assert.deepEqual([doc.price_target.value, doc.price_target.ref_price, doc.price_target.set_at], [213.75, 104.38, '2026-11-06T16:23:51.365Z'])
    assert.equal(doc.revisions[0].kind, SPLIT_KIND)
    assert.match(doc.revisions[0].note, /SNDK split 8-for-1 on 2026-11-20.*target 1710 → 213\.75/)
    assert.equal(doc.monitor.split_through, '2026-11-20')
    assert.equal(doc.monitor.pending_revision.state, 'split')
    assert.equal(res.doc.price_target.value, 213.75, 'the monitor goes on with the restated doc')
    const [a, b] = ['pc_a', 'pc_b'].map(id => rows('prometheus_calls').find(c => c.id === id))
    assert.deepEqual([a.pt, a.entry.price, a.entry.spy], [213.75, 104.38, 735.29])
    assert.deepEqual([b.pt, b.entry.price], [1000, 500], 'a graded-out call keeps its numbers')
    // Twice is once — the coverage by its stamp, the calls by theirs.
    assert.equal((await coverageService.applySplit('cov_SNDK_1', split)).outcome, 'done_already')
    assert.equal(await prometheusCallsService.adjustCallsForSplit({ coverageId: 'cov_SNDK_1', symbol: 'SNDK', split }), 0)
    assert.equal(rows('coverage').find(d => d.id === 'cov_SNDK_1').price_target.value, 213.75)
})
