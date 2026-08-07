import { test } from 'node:test'
import assert from 'node:assert/strict'
import { benchmarkTicker, buildFingerprint, computeReviewDelta, computeReviewTriggers } from '../../services/portfolioReview.util.js'
import { _formatReviewDelta } from '../../services/agents/portfolio.agent.service.js'

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
    const macroRaw = { asOf: '2026-07-16', spread2s10s: 0.41, fedFunds: 4.09, inflation: 2.29 }
    const tilt = { id: 'tilt1', tilts: [{ sector: 'Energy', stance: 'under', active_bp: -150, rationale: 'ignored here' }] }
    const fp = buildFingerprint({ reason: 'review', state, macroRaw, tilt, benchmark: { ticker: 'SPY', price: 600 }, now: 1_700_000_000_000 })

    assert.equal(fp.reason, 'review')
    assert.equal(fp.capturedAt, 1_700_000_000_000)
    assert.equal(fp.bookValue, 100000)
    assert.equal(fp.totalPnl, 5000)
    assert.equal(fp.totalPnlPct, 5.26)
    assert.deepEqual(fp.benchmark, { ticker: 'SPY', price: 600 })
    assert.equal(fp.regime.spread2s10s, 0.41)
    assert.equal(fp.regime.fedFunds, 4.09)
    // The house view as it stood — the baseline the NEXT review diffs against. Only the three
    // fields a stance is judged by; the day's sector ranking is deliberately not captured at all.
    assert.deepEqual(fp.tilt, { id: 'tilt1', stances: [{ sector: 'Energy', stance: 'under', active_bp: -150 }] })
    assert.equal(fp.regime.leaders, undefined, 'a daily sector ranking is not a baseline')
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
test('delta: benchmark-relative + regime shift (no rotation legs)', () => {
    const fingerprint = {
        capturedAt: 1_700_000_000_000, reason: 'review', totalPnlPct: 3.0,
        benchmark: { ticker: 'SPY', price: 600 },
        regime: { spread2s10s: -0.2, fedFunds: 4.5, inflation: 3.0 },
    }
    const state    = { totalPnlPct: 5.0 }
    const macroNow = { spread2s10s: 0.3, fedFunds: 4.09, inflation: 2.29 }
    const now      = fingerprint.capturedAt + 30 * 86400000
    const d = computeReviewDelta({ fingerprint, state, benchmarkNowPrice: 630, macroNow, now })

    assert.equal(d.windowDays, 30)
    assert.equal(d.benchmark.returnPct, 5)          // (630-600)/600
    assert.equal(d.benchmark.bookDeltaPnlPct, 2)    // 5.0 - 3.0
    assert.equal(d.benchmark.relativePct, -3)       // 2 - 5 → BEHIND
    assert.equal(d.regime.inversionFlip, true)      // -0.2 → +0.3
    // Diffing two single-day sector rankings produced a "rotation" on nearly every comparison, so
    // the legs are gone entirely rather than left computed-but-unused.
    assert.equal(d.regime.rotatedIn, undefined)
    assert.equal(d.regime.rotatedOut, undefined)
    assert.equal(d.regime.leadersNow, undefined)
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

test('triggers: daily sector rotation NEVER fires — it was pure noise', () => {
    // It compared the top 3 sectors by ONE day's move against the 3 stored at the last review,
    // weeks earlier. Three from eleven, twice: ≥2 differ ~85% of the time under a random model, so
    // it notified almost daily and said nothing. Removed 2026-08-06.
    const t = computeReviewTriggers({ state: null, delta: { regime: { inversionFlip: false, rotatedIn: ['Healthcare', 'Utilities'] } } })
    assert.equal(t.length, 0)
})

test('triggers: the HOUSE SECTOR VIEW changing is what earns a look', () => {
    const fingerprint = { tilt: { id: 't1', stances: [{ sector: 'Energy', stance: 'under', active_bp: -150 }] } }
    const tilt = { id: 't2', tilts: [{ sector: 'Energy', stance: 'over', active_bp: 150 }] }
    const t = computeReviewTriggers({ state: null, fingerprint, tilt })
    assert.equal(t.length, 1)
    assert.equal(t[0].kind, 'sector_view')
    assert.match(t[0].label, /Energy under→over/)
})

test('triggers: a republished but UNCHANGED view is not news', () => {
    // The ratchet the rotation trigger never had: publishing again with the same stances is silent.
    const stances = [{ sector: 'Energy', stance: 'under', active_bp: -150 }]
    const t = computeReviewTriggers({
        state: null,
        fingerprint: { tilt: { id: 't1', stances } },
        tilt: { id: 't2', tilts: stances },
    })
    assert.equal(t.length, 0)
})

test('triggers: the view trigger is NOT gated on what the book holds', () => {
    // A sector we own nothing in turning overweight is exactly when a swap is worth considering, so
    // filtering to holdings would hide the most actionable case.
    const t = computeReviewTriggers({
        state: { ideas: [{ asset: 'NVDA' }] },
        fingerprint: { tilt: { id: 't1', stances: [] } },
        tilt: { id: 't2', tilts: [{ sector: 'Utilities', stance: 'over', active_bp: 200 }] },
    })
    assert.ok(t.some(x => x.kind === 'sector_view' && /Utilities/.test(x.label)))
})

test('triggers: no view at all on either side is silent', () => {
    assert.equal(computeReviewTriggers({ state: null }).length, 0)
    assert.equal(computeReviewTriggers({ state: null, tilt: { id: 't', tilts: [] } }).length, 0)
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
    assert.doesNotMatch(text, /sector leaders/, 'the daily ranking is no longer shown as a delta')
    assert.equal(_formatReviewDelta(null), null)
})

// ─── the coverage gate: our own PT vs the basis we bought on ────────────────
// Research has no invalidation of its own — a thesis whose price fell is cheaper, not wrong. What
// earns a portfolio look is OUR price target moving against a position we actually hold.

const covTriggers = (coverage) =>
    computeReviewTriggers({ state: { ideas: [] }, fingerprint: {}, delta: null, coverage })
        .filter(t => t.kind === 'coverage')

test('coverage gate: a revised PT at or below our entry is HIGH — no upside left on our own numbers', () => {
    const t = covTriggers([{ symbol: 'TSM', currentPt: 380, basisPt: 702, entryPrice: 404 }])
    assert.equal(t.length, 1)
    assert.equal(t[0].severity, 'high')
    assert.match(t[0].label, /at or below our entry/)
})

test('coverage gate: a material PT cut that still clears cost is MEDIUM', () => {
    const t = covTriggers([{ symbol: 'TSM', currentPt: 516, basisPt: 702, entryPrice: 404 }])
    assert.equal(t.length, 1)
    assert.equal(t[0].severity, 'medium')
    assert.match(t[0].label, /cut 26% since entry \(702 → 516\)/)
})

test('coverage gate: a trim inside the noise band is silent', () => {
    assert.deepEqual(covTriggers([{ symbol: 'TSM', currentPt: 650, basisPt: 702, entryPrice: 404 }]), [])  // -7%
})

test('coverage gate: the harder finding does not double-report the softer one', () => {
    // PT below entry AND a big cut — one trigger, the high one.
    const t = covTriggers([{ symbol: 'X', currentPt: 100, basisPt: 300, entryPrice: 200 }])
    assert.equal(t.length, 1)
    assert.equal(t[0].severity, 'high')
})

test('coverage gate: a missing PT / basis / entry is silent, never a zero', () => {
    // The Number(null) === 0 shape: a null PT must not read as "0 ≤ our entry" and ring on every name.
    assert.deepEqual(covTriggers([{ symbol: 'X', currentPt: null, basisPt: 300, entryPrice: 200 }]), [])
    assert.deepEqual(covTriggers([{ symbol: 'X', currentPt: 250, basisPt: null, entryPrice: null }]), [])
    assert.deepEqual(covTriggers([{ symbol: 'X' }]), [])
    // A zero/unknown entry price can't produce a HIGH — but the PT cut is still real on its own.
    const noEntry = covTriggers([{ symbol: 'X', currentPt: 250, basisPt: 300, entryPrice: 0 }])
    assert.equal(noEntry.every(t => t.severity !== 'high'), true)
    assert.match(noEntry[0].label, /cut 17% since entry/)
})

test('coverage gate: an unheld name contributes nothing (no basis, no entry)', () => {
    assert.deepEqual(covTriggers([{ symbol: 'NEW', currentPt: 500, basisPt: null, entryPrice: null }]), [])
})

test('coverage gate: a DELIBERATE thesis_broken is still honoured', () => {
    // Nothing deterministic sets it any more, so its presence means the analyst tier or the user did.
    const t = covTriggers([{ symbol: 'X', status: 'thesis_broken', currentPt: 500, basisPt: 500, entryPrice: 100 }])
    assert.equal(t.length, 1)
    assert.equal(t[0].severity, 'high')
    assert.match(t[0].label, /research thesis broken/)
})

test('coverage gate: target_hit stays a medium "worth a deliberate look"', () => {
    const t = covTriggers([{ symbol: 'X', status: 'target_hit', currentPt: 500, basisPt: 500, entryPrice: 100 }])
    assert.equal(t[0].severity, 'medium')
})
