import { test } from 'node:test'
import assert from 'node:assert/strict'
import { benchmarkTicker, buildFingerprint } from '../../services/portfolioReview.util.js'

// Pure review-lifecycle helpers. benchmarkTicker maps a mandate's free-text benchmark to a
// priceable ETF proxy; buildFingerprint captures the compact "then" the next review deltas against.

// ─── benchmarkTicker ────────────────────────────────────────────────────────
test('benchmark: common phrasings → ETF proxy', () => {
    assert.equal(benchmarkTicker('S&P 500'), 'SPY')
    assert.equal(benchmarkTicker('sp500'), 'SPY')
    assert.equal(benchmarkTicker('the S & P 500 index'), 'SPY')
    assert.equal(benchmarkTicker('Nasdaq 100'), 'QQQ')
    assert.equal(benchmarkTicker('Dow Jones'), 'DIA')
    assert.equal(benchmarkTicker('Russell 2000'), 'IWM')
    assert.equal(benchmarkTicker('60/40'), 'AOR')
    assert.equal(benchmarkTicker('MSCI World'), 'ACWI')
})

test('benchmark: bare ticker passes through, unpriceable → null', () => {
    assert.equal(benchmarkTicker('QQQ'), 'QQQ')
    assert.equal(benchmarkTicker('vti'), 'VTI')
    assert.equal(benchmarkTicker('absolute return'), null)
    assert.equal(benchmarkTicker('cash'), null)
    assert.equal(benchmarkTicker('my custom blend'), null)
    assert.equal(benchmarkTicker(''), null)
    assert.equal(benchmarkTicker(null), null)
    assert.equal(benchmarkTicker(undefined), null)
})

// ─── buildFingerprint ───────────────────────────────────────────────────────
test('fingerprint: full state → all fields captured', () => {
    const state = {
        totalNotional: 100000, totalPnl: 5000, totalPnlPct: 5.26,
        ideas: [
            { asset: 'NVDA', allocationRatio: 0.3, actualWeight: 0.32, conviction: { level: 'high', score: 0.8 } },
            { asset: 'XLV',  allocationRatio: 0.2, actualWeight: 0.18, conviction: { level: 'medium', score: 0.5 } },
        ],
    }
    const macroRaw = { asOf: '2026-07-16', spread2s10s: 0.41, fedFunds: 4.09, inflation: 2.29, leaders: ['Tech', 'Health', 'Energy'] }
    const fp = buildFingerprint({ reason: 'review', state, macroRaw, benchmark: { ticker: 'SPY', price: 600 }, now: 1_700_000_000_000 })

    assert.equal(fp.reason, 'review')
    assert.equal(fp.capturedAt, 1_700_000_000_000)
    assert.equal(fp.bookValue, 100000)
    assert.equal(fp.totalPnl, 5000)
    assert.equal(fp.totalPnlPct, 5.26)
    assert.deepEqual(fp.benchmark, { ticker: 'SPY', price: 600 })
    assert.equal(fp.regime.spread2s10s, 0.41)
    assert.equal(fp.regime.fedFunds, 4.09)
    assert.deepEqual(fp.regime.leaders, ['Tech', 'Health', 'Energy'])
    assert.equal(fp.holdings.length, 2)
    assert.deepEqual(fp.holdings[0], { asset: 'NVDA', allocationRatio: 0.3, actualWeight: 0.32, convictionScore: 0.8, convictionLevel: 'high' })
})

test('fingerprint: empty inputs → safe defaults', () => {
    const fp = buildFingerprint({ reason: 'construction', now: 1 })
    assert.equal(fp.bookValue, 0)
    assert.equal(fp.totalPnl, null)
    assert.equal(fp.benchmark, null)
    assert.equal(fp.regime, null)
    assert.deepEqual(fp.holdings, [])
})

test('fingerprint: benchmark with no price kept as {ticker, price:null}', () => {
    const fp = buildFingerprint({ reason: 'review', benchmark: { ticker: 'SPY', price: null } })
    assert.deepEqual(fp.benchmark, { ticker: 'SPY', price: null })
    const fp2 = buildFingerprint({ reason: 'review', benchmark: { ticker: 'SPY', price: NaN } })
    assert.equal(fp2.benchmark.price, null)
})
