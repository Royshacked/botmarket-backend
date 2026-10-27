import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNewCall, callFromCoverage, marksFor, entryDay, gradeCall, coverageRecord, catalystRecord, summarise, MIN_JUDGE } from '../../services/prometheusCalls.service.js'
import { callsFromTrail } from '../../services/prometheusCalls.backfill.js'
import { windowMark } from '../../services/catalystRead.service.js'
import { _tick } from '../../monitoring/prometheusScorecard.monitor.service.js'

// Prometheus's scorecard (Roy, 2026-10-27: "do the scorecard") — every call frozen, graded vs SPY.

const cov = (rating, value, horizon = '12m', extra = {}) => ({ id: 'cov_X_1', symbol: 'X', rating, price_target: value == null ? null : { value, horizon }, ...extra })
// Daily bars, one per weekday from `from` for `n` days, close by index; ms timestamps at 16:00 ET (20:00Z).
function bars(from, n, close, { high = null, low = null } = {}) {
    const out = []
    let t = Date.parse(`${from}T20:00:00Z`)
    while (out.length < n) {
        const d = new Date(t).getUTCDay()
        if (d !== 0 && d !== 6) { const k = out.length; const c = close(k); out.push({ timestamp: t, close: c, high: high ? high(k) : c, low: low ? low(k) : c }) }
        t += 86_400_000
    }
    return out
}

test('a call is a new rating, target value or horizon — not a re-stated one', () => {
    assert.equal(isNewCall(null, cov('buy', 100)), true)
    assert.equal(isNewCall(null, cov(null, null)), false, 'nothing to grade')
    assert.equal(isNewCall(cov('buy', 100), cov('buy', 100)), false)
    assert.equal(isNewCall(cov('buy', 100), cov('strong_buy', 100)), true)
    assert.equal(isNewCall(cov('buy', 100), cov('buy', 110)), true)
    assert.equal(isNewCall(cov('buy', 100), cov('buy', 100, '6m')), true)
})

test('the frozen row: direction by rating, the marks by horizon, entry the first close after the call', () => {
    assert.equal(callFromCoverage(cov('strong_sell', 50), { madeAt: 'x' }).direction, -1)
    assert.equal(callFromCoverage(cov('hold', 50), { madeAt: 'x' }).direction, 0)
    assert.deepEqual(marksFor('6m'), ['1m', '3m', '6m'])
    assert.deepEqual(marksFor('24m'), ['1m', '3m', '6m', '12m', '18m', '24m'])
    assert.equal(entryDay('2026-03-02T15:00:00.000Z'), '2026-03-02', '10:00 ET — that day’s close')
    assert.equal(entryDay('2026-03-02T22:00:00.000Z'), '2026-03-03', '17:00 ET — the next')
})

test('graded at each mark vs SPY, signed by direction; the target reached inside the horizon', () => {
    const call = { ...callFromCoverage(cov('buy', 115, '3m'), { madeAt: '2026-01-05T15:00:00.000Z' }), marks: {} }
    const own = bars('2026-01-05', 80, k => 100 + k * 0.25, { high: k => 100 + k * 0.25 + (k === 50 ? 10 : 0) })
    const spy = bars('2026-01-05', 80, () => 400)
    const g = gradeCall(call, own, spy, '2026-04-30')
    assert.deepEqual(g.entry, { day: '2026-01-05', price: 100, spy: 400 })
    assert.equal(g.marks['1m'].day, '2026-02-05')
    assert.ok(g.marks['1m'].vs_spy > 0 && g.marks['1m'].signed === g.marks['1m'].vs_spy)
    assert.ok(g.marks['3m'])
    assert.equal(g.done, true)
    assert.ok(g.target_reached, 'the spike on the 51st session reached 115')
    // A sell on the same path: the same vs SPY, signed the other way, its target a LOW.
    const sell = gradeCall({ ...call, rating: 'sell', direction: -1, pt: 90 }, own, spy, '2026-04-30')
    assert.equal(sell.marks['1m'].signed, -sell.marks['1m'].vs_spy)
    assert.equal(sell.target_reached, null)
})

test('a mark not yet due, or not yet priced, waits — and is closed unpriced after GIVE_UP_DAYS', () => {
    const call = { ...callFromCoverage(cov('buy', 200, '3m'), { madeAt: '2026-01-05T15:00:00.000Z' }), marks: {} }
    const own = bars('2026-01-05', 15, () => 100), spy = bars('2026-01-05', 15, () => 400)
    const early = gradeCall(call, own, spy, '2026-01-20')
    assert.ok(early.entry && !early.marks['1m'] && early.done === false)
    const stale = gradeCall(call, own, spy, '2026-02-10')
    assert.equal(stale.marks['1m'], undefined, 'the bars stop on Jan 23 — not late yet')
    assert.equal(gradeCall(call, own, spy, '2026-02-20').marks['1m'].basis, 'unpriced')
    // A graded mark is never rewritten.
    const kept = gradeCall({ ...call, entry: early.entry, marks: { '1m': { day: 'd', signed: 5 } } }, own, spy, '2026-02-20')
    assert.deepEqual(kept.marks['1m'], { day: 'd', signed: 5 })
})

test('the record: forward and backfill apart, holds apart from directional calls, too few flagged', () => {
    const row = (source, rating, direction, signed, vs) => ({ source, rating, direction, done: true, marks: { '1m': { signed, vs_spy: vs } }, target_reached: signed > 0 ? { day: 'd' } : null })
    const r = coverageRecord([row('forward', 'buy', 1, 2, 2), row('forward', 'sell', -1, -1, 1), row('forward', 'hold', 0, null, 3), row('backfill', 'buy', 1, 5, 5)])
    assert.deepEqual(r.forward.marks['1m'].calls, { n: 2, mean: 0.5, median: 0.5, beat: 50, judge: false })
    assert.equal(r.forward.marks['1m'].holds.n, 1)
    assert.deepEqual(r.forward.target, { settled: 2, reached: 1 })
    assert.equal(r.forward.by_rating.hold['1m'].mean, 3, 'a hold is shown by its raw vs SPY')
    assert.equal(r.backfill.calls, 1)
    assert.equal(summarise(Array(MIN_JUDGE).fill(1)).judge, true)
})

test('catalyst reads: the backed ones against the passes, each on its window mark', () => {
    const rd = (status, vs, reason = null) => ({ status, pass_reason: reason, window_mark: vs == null ? undefined : { vs_spy: vs } })
    const r = catalystRecord([rd('hit', 3), rd('expired', -1), rd('pass', -2, 'already_ran'), rd('pass', 0, 'too_small'), rd('active', null)])
    assert.deepEqual([r.backed.reads, r.backed.hit, r.backed.window.mean], [2, 1, 1])
    assert.deepEqual([r.passes.reads, r.passes.window.mean, r.passes.by_reason.already_ran.mean], [2, -1, -2])
    assert.equal(r.open, 1)
})

test('windowMark: held to the window’s last close vs SPY; no window, no prices, or not in yet', () => {
    const read = { set_at: '2026-03-02T15:00:00.000Z', valid_until: '2026-03-10T21:00:00.000Z', price_at_read: 50, spy_at_read: 400 }
    const now = Date.parse('2026-03-11T12:00:00Z')
    assert.deepEqual(windowMark(read, { close: 55, spy_close: 404 }, now), { return_pct: 10, spy_return_pct: 1, vs_spy: 9, basis: 'window', at: new Date(now).toISOString() })
    assert.equal(windowMark({ ...read, valid_until: read.set_at }, null, now).basis, 'no_window')
    assert.equal(windowMark({ ...read, price_at_read: null }, { close: 55, spy_close: 404 }, now).basis, 'unpriced')
    assert.equal(windowMark(read, null, now), null, 'bars not in — try again')
    assert.equal(windowMark(read, null, now + 5 * 86_400_000).basis, 'unpriced')
})

test('the seed: every call in a trail, oldest first, from today’s document walked back', () => {
    const doc = {
        id: 'cov_X_1', symbol: 'X', created_at: '2026-01-01T10:00:00.000Z', rating: 'buy', price_target: { value: 130, horizon: '12m', set_at: '2026-03-01T00:00:00.000Z' },
        revisions: [
            { at: '2026-03-01T00:00:00.000Z', changed: { price_target: { from: { value: 120, horizon: '12m', set_at: '2026-02-01T00:00:00.000Z' }, to: { value: 130, horizon: '12m' } } } },
            { at: '2026-02-15T00:00:00.000Z', changed: { status: { from: 'active', to: 'target_hit' } } },
            { at: '2026-02-01T00:00:00.000Z', changed: { rating: { from: 'hold', to: 'buy' }, price_target: { from: { value: 120, horizon: '12m', set_at: '2026-01-01T10:00:00.000Z' }, to: { value: 120, horizon: '12m' } } } },
            { at: '2026-01-01T10:00:00.000Z', kind: 'initiate' },
        ],
    }
    const calls = callsFromTrail(doc)
    assert.deepEqual(calls.map(c => [c.at.slice(0, 10), c.state.rating, c.state.price_target.value]), [['2026-01-01', 'hold', 120], ['2026-02-01', 'buy', 120], ['2026-03-01', 'buy', 130]])
    assert.equal(calls[1].prev.rating, 'hold')
    assert.deepEqual(callsFromTrail({ ...doc, revisions: [] }).map(c => c.at), ['2026-03-01T00:00:00.000Z'], 'no trail: today’s call at its set_at')
})

test('the grader runs both passes', async () => {
    const r = await _tick({ calls: async () => ({ graded: 1 }), windows: async () => ({ marked: 2 }) })
    assert.deepEqual(r, { calls: { graded: 1 }, windows: { marked: 2 } })
})
