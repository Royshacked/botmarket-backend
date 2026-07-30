import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPerformance, toPct, toSummaryPct } from '../../services/performance.service.js'

// The closed-trade record — and above all, THE UNIT TRAP.
//
// Both upstream sources hand back a win rate as a fraction 0–1: computeTradeStats does
// `wins / count`, and computeKairosPerformance's `win_rate` is documented "fraction 0–1". Passed
// through unchanged, a model reports 0.62 to the user as "0.62%". These tests exist so that bug
// cannot ship quietly, and so nobody "tidies away" the conversion later.

const NOW = 1_700_000_000_000

const summary = (over = {}) => ({
    count: 100, wins: 62, losses: 30, breakeven: 8,
    winRate: 0.62, netPnl: 1234.5, profitFactor: 1.8, expectancy: 12.3, ...over,
})

const deps = (over = {}) => ({
    now: NOW,
    stats: async () => ({
        overall: summary(),
        byMode: { paper: summary({ winRate: 0.5, count: 40 }) },
        byOrigin: { call: summary({ winRate: 0.75, count: 20 }) },
        bySymbol: { NVDA: summary({ winRate: 1, count: 3 }) },
    }),
    callPerf: async () => ({ ok: true, performance: { closed: 20, wins: 13, losses: 7, win_rate: 0.65, avg_r: 1.4, total_pnl: 900 } }),
    ...over,
})

test('a fraction becomes a percentage', () => {
    assert.equal(toPct(0.62), 62)
    assert.equal(toPct(1), 100)
    assert.equal(toPct(0), 0)
    assert.equal(toPct(0.3333), 33.33)
})

test('no data stays null — "no trades yet" is not "0%"', () => {
    assert.equal(toPct(null), null)
    assert.equal(toPct(undefined), null)
    assert.equal(toPct(NaN), null)
})

test('the raw winRate is REPLACED, not kept alongside', () => {
    // Two names for one number is exactly how the wrong one gets read downstream.
    const s = toSummaryPct(summary())
    assert.equal(s.winRatePct, 62)
    assert.equal('winRate' in s, false)
    assert.equal(s.count, 100, 'everything else survives untouched')
})

test('EVERY nested summary is converted, not just the headline', async () => {
    // byMode/byOrigin/bySymbol are where a partial conversion would hide.
    const res = await getPerformance('u1', {}, deps())
    assert.equal(res.realized.overall.winRatePct, 62)
    assert.equal(res.realized.byMode.paper.winRatePct, 50)
    assert.equal(res.realized.byOrigin.call.winRatePct, 75)
    assert.equal(res.realized.bySymbol.NVDA.winRatePct, 100)
    const serialized = JSON.stringify(res.realized)
    assert.doesNotMatch(serialized, /"winRate"/, 'no fraction survives anywhere under a bare name')
})

test("the Kairos call record is converted too — it has the same trap", async () => {
    const res = await getPerformance('u1', {}, deps())
    assert.equal(res.calls.winRatePct, 65)
    assert.equal(res.calls.avgR, 1.4, 'R is a multiple, not a rate — left alone')
})

test('money and R multiples are NOT rescaled', async () => {
    const res = await getPerformance('u1', {}, deps())
    assert.equal(res.realized.overall.netPnl, 1234.5)
    assert.equal(res.realized.overall.profitFactor, 1.8)
})

test('the two records are reported side by side, never averaged together', async () => {
    // Money and R answer different questions; a blended number would mean nothing.
    const res = await getPerformance('u1', {}, deps())
    assert.ok(res.realized && res.calls)
    assert.notEqual(res.realized.overall.winRatePct, res.calls.winRatePct)
})

test('a failed source is named rather than reported as zero', async () => {
    const res = await getPerformance('u1', {}, deps({ stats: async () => { throw new Error('down') } }))
    assert.deepEqual(res.unavailable, ['realized'])
    assert.equal(res.realized, null)
    assert.ok(res.calls, 'the other record still answers')
})

test('a Kairos record that comes back not-ok is absent, not an error', async () => {
    const res = await getPerformance('u1', {}, deps({ callPerf: async () => ({ ok: false }) }))
    assert.equal(res.calls, null)
    assert.deepEqual(res.unavailable, [])
})

test('the window rides along, so a number can be stated with what it covers', async () => {
    const res = await getPerformance('u1', { mode: 'paper', symbol: 'nvda' }, deps())
    assert.equal(res.filter.mode, 'paper')
})

test('filters reach the trade store in its own vocabulary', async () => {
    let seen = null
    await getPerformance('u1', { mode: 'live', symbol: 'NVDA', from: 1000, to: 2000 },
        deps({ stats: async (_u, f) => { seen = f; return {} } }))
    assert.deepEqual(seen, { mode: 'live', symbol: 'NVDA', fromMs: 1000, toMs: 2000 })
})

test('no user means no numbers, without querying', async () => {
    let touched = 0
    const res = await getPerformance(null, {}, deps({ stats: async () => { touched++; return {} } }))
    assert.equal(touched, 0)
    assert.equal(res.realized, null)
})
