import { test } from 'node:test'
import assert from 'node:assert/strict'
import { benchmarkTicker, buildFingerprint, computeReviewDelta, computeReviewTriggers } from '../../services/portfolioReview.util.js'
import { _formatReviewDelta } from '../../services/portfolio.agent.service.js'

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

// ─── computeReviewDelta ─────────────────────────────────────────────────────
test('delta: benchmark-relative + regime rotation', () => {
    const fingerprint = {
        capturedAt: 1_700_000_000_000, reason: 'review', totalPnlPct: 3.0,
        benchmark: { ticker: 'SPY', price: 600 },
        regime: { spread2s10s: -0.2, fedFunds: 4.5, inflation: 3.0, leaders: ['Technology', 'Energy', 'Financials'] },
    }
    const state    = { totalPnlPct: 5.0 }
    const macroNow = { spread2s10s: 0.3, fedFunds: 4.09, inflation: 2.29, leaders: ['Healthcare', 'Technology', 'Utilities'] }
    const now      = fingerprint.capturedAt + 30 * 86400000
    const d = computeReviewDelta({ fingerprint, state, benchmarkNowPrice: 630, macroNow, now })

    assert.equal(d.windowDays, 30)
    assert.equal(d.benchmark.returnPct, 5)          // (630-600)/600
    assert.equal(d.benchmark.bookDeltaPnlPct, 2)    // 5.0 - 3.0
    assert.equal(d.benchmark.relativePct, -3)       // 2 - 5 → BEHIND
    assert.equal(d.regime.inversionFlip, true)      // -0.2 → +0.3
    assert.deepEqual(d.regime.rotatedIn, ['Healthcare', 'Utilities'])
    assert.deepEqual(d.regime.rotatedOut, ['Energy', 'Financials'])
})

test('delta: null fingerprint or neither leg → null', () => {
    assert.equal(computeReviewDelta({ fingerprint: null }), null)
    assert.equal(computeReviewDelta({ fingerprint: { capturedAt: 1, benchmark: null, regime: null }, now: 2 }), null)
})

test('delta: benchmark unpriceable but regime present → regime-only', () => {
    const fp = { capturedAt: 1_700_000_000_000, benchmark: { ticker: 'SPY', price: null }, regime: { spread2s10s: 0.4, leaders: ['Tech'] } }
    const d  = computeReviewDelta({ fingerprint: fp, benchmarkNowPrice: 630, macroNow: { spread2s10s: 0.3, leaders: ['Tech'] }, now: fp.capturedAt })
    assert.equal(d.benchmark, null)
    assert.ok(d.regime)
    assert.equal(d.regime.inversionFlip, false)
})

test('delta: book P&L missing → benchmark return shown, book/relative null', () => {
    const fp = { capturedAt: 1, totalPnlPct: null, benchmark: { ticker: 'SPY', price: 100 }, regime: null }
    const d  = computeReviewDelta({ fingerprint: fp, state: { totalPnlPct: null }, benchmarkNowPrice: 110, now: 2 })
    assert.equal(d.benchmark.returnPct, 10)
    assert.equal(d.benchmark.bookDeltaPnlPct, null)
    assert.equal(d.benchmark.relativePct, null)
})

// ─── computeReviewTriggers ──────────────────────────────────────────────────
test('triggers: fire on conviction fall / drift / earnings / regime / benchmark lag, high first', () => {
    const now = 1_700_000_000_000
    const state = {
        ideas: [
            { asset: 'NVDA', actualWeight: 0.30, drift: 0.12, conviction: { level: 'medium' }, convictionPrev: { level: 'high' },
              upcomingEarnings: { date: new Date(now + 3 * 86400000).toISOString().slice(0, 10) } },
            { asset: 'XLV', actualWeight: 0.20, drift: 0.02, conviction: { level: 'high' }, convictionPrev: { level: 'high' } },
        ],
    }
    const delta = { benchmark: { ticker: 'SPY', relativePct: -4.2 }, regime: { inversionFlip: true, rotatedIn: [] } }
    const t = computeReviewTriggers({ state, fingerprint: {}, delta, now })
    const kinds = t.map(x => x.kind)

    assert.equal(t[0].severity, 'high')   // conviction/regime ahead of the mediums
    for (const k of ['conviction', 'regime', 'drift', 'benchmark', 'earnings']) assert.ok(kinds.includes(k), `missing ${k}`)
    assert.match(t.find(x => x.kind === 'conviction').label, /NVDA/)
    assert.match(t.find(x => x.kind === 'drift').label, /NVDA drifted \+12pt/)
    assert.match(t.find(x => x.kind === 'benchmark').label, /trailing SPY by 4\.2pt/)
})

test('triggers: quiet cycle → empty', () => {
    const state = { ideas: [{ asset: 'AAPL', actualWeight: 0.5, drift: 0.03, conviction: { level: 'high' }, convictionPrev: { level: 'high' } }] }
    assert.deepEqual(computeReviewTriggers({ state, delta: null }), [])
})

test('triggers: sector rotation (≥2 rotated in) fires a medium regime trigger', () => {
    const t = computeReviewTriggers({ state: null, delta: { regime: { inversionFlip: false, rotatedIn: ['Healthcare', 'Utilities'] } } })
    assert.equal(t.length, 1)
    assert.equal(t[0].kind, 'regime')
    assert.equal(t[0].severity, 'medium')
    assert.match(t[0].label, /Healthcare, Utilities now leading/)
})

// ─── _formatReviewDelta (display) ───────────────────────────────────────────
test('format: benchmark BEHIND + regime flip render as expected', () => {
    const text = _formatReviewDelta({
        windowDays: 30,
        benchmark: { ticker: 'SPY', returnPct: 5, bookDeltaPnlPct: 2, relativePct: -3 },
        regime: { spread2s10s: { then: -0.2, now: 0.3 }, fedFunds: { then: 4.5, now: 4.09 }, inflation: { then: 3.0, now: 2.29 }, inversionFlip: true, rotatedIn: ['Healthcare'], rotatedOut: ['Energy'] },
    })
    assert.match(text, /Performance vs SPY \(since last review, 30d\): SPY \+5\.0% \| book \+2\.0% \(Δ unrealized P&L\) → book BEHIND by 3\.0pt/)
    assert.match(text, /Regime shift since last review: 2s10s -0\.2→0\.3, Fed funds 4\.5%→4\.09%, inflation 3%→2\.29%/)
    assert.match(text, /inversion FLIPPED/)
    assert.match(text, /sector leaders \+\[Healthcare\] −\[Energy\]/)
    assert.equal(_formatReviewDelta(null), null)
})
