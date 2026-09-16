import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { _deps, getRiskMetrics, getPriceAction, getCorrelations, getVolsAndCorrelationsRaw } from '../../services/priceAnalytics.service.js'

// The analytics that lived in the Yahoo provider by history — arithmetic over a candle series, from
// whichever source the router picks. They read through candles.provider now; `_deps` stands in for it
// here so nothing touches a network, which the provider-resident copy never allowed.

const real = _deps.getTickerAggregates
afterEach(() => { _deps.getTickerAggregates = real })

const DAY = 86_400
/** A deterministic daily series: a gentle uptrend with a fixed wiggle, `n` bars ending now. */
function series(n, { start = 100, step = 0.5, wiggle = 1, volume = 1_000 } = {}) {
    const now = Math.floor(Date.now() / 1000)
    return Array.from({ length: n }, (_, i) => {
        const close = start + i * step + (i % 2 ? wiggle : -wiggle)
        return { timestamp: now - (n - i) * DAY, open: close - 0.2, high: close + 1, low: close - 1, close, volume }
    })
}

test('risk metrics: one candle read, an annualised vol and an ATR in the sentence', async () => {
    const asked = []
    _deps.getTickerAggregates = async (sym, opts) => { asked.push({ sym, opts }); return series(260) }
    const out = await getRiskMetrics('nvda')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].sym, 'NVDA')
    assert.equal(asked[0].opts.timeSpan, 'day')
    assert.match(out, /^NVDA — risk \(1y daily\):/)
    assert.match(out, /Annualized volatility: \d+\.\d%/)
    assert.match(out, /ATR\(14\): \$\d/)
})

test('too little history is a sentence, not a crash or a fabricated number', async () => {
    _deps.getTickerAggregates = async () => series(5)
    assert.match(await getRiskMetrics('X'), /not enough price history/)
    assert.match(await getPriceAction('X'), /not enough price history/)
})

test('price action reads the change legs and the 1y range position off the series', async () => {
    _deps.getTickerAggregates = async () => series(260, { volume: 2_000 })
    const out = await getPriceAction('AAPL')
    assert.match(out, /AAPL — price action \(1y daily\):/)
    assert.match(out, /Change: 1d [-\d.]+% \| 5d [-\d.]+% \| 1m [-\d.]+% \| 3m [-\d.]+%/)
    assert.match(out, /1y range: \$[\d.]+ – \$[\d.]+ \(at \d+% of range\)/)
})

test('correlations: one fetch per distinct ticker, aligned on shared days', async () => {
    let fetches = 0
    _deps.getTickerAggregates = async (sym) => { fetches++; return series(120, { step: sym === 'A' ? 0.5 : -0.5 }) }
    const text = await getCorrelations(['a', 'b', 'A'])
    assert.equal(fetches, 2, 'A twice in the request is one fetch')
    assert.match(text, /Correlation matrix \(1y daily returns\):/)
    assert.match(text, /\s+A\s+B/)
})

test('vols + correlations in one pass: vols line up with the INPUT order, duplicates preserved', async () => {
    _deps.getTickerAggregates = async () => series(120)
    const { vols, corrData } = await getVolsAndCorrelationsRaw(['a', 'b', 'a'])
    assert.equal(vols.length, 3)
    assert.ok(vols.every(v => Number.isFinite(v)))
    assert.deepEqual(corrData.symbols, ['A', 'B'])
    assert.equal(corrData.matrix.length, 2)
})

test('a ticker the router cannot serve leaves its vol null and the rest intact', async () => {
    _deps.getTickerAggregates = async (sym) => { if (sym === 'BAD') throw new Error('no data'); return series(120) }
    const { vols } = await getVolsAndCorrelationsRaw(['GOOD', 'BAD'])
    assert.ok(Number.isFinite(vols[0]))
    assert.equal(vols[1], null)
})
