import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFmpQuote, toYfQuote } from '../../providers/fmp.price.provider.js'

// normalizeFmpQuote maps an FMP /quote row → { price, dayHigh, dayLow, name }. This is the
// piece the paper mark/fill path relies on to replace the stale-day-candle price that
// caused a false TP fill (project_timestamp_ideas Issue 1). Network fetch isn't unit-tested.

test('full row → all fields mapped', () => {
    const q = normalizeFmpQuote({
        symbol: 'AAPL', name: 'Apple Inc.', price: 317.31, dayHigh: 323.45, dayLow: 315.78,
        open: 317.015, previousClose: 315.32, changePercentage: 0.6311, timestamp: 1783972801,
    })
    assert.deepEqual(q, {
        symbol: 'AAPL', name: 'Apple Inc.', price: 317.31, dayHigh: 323.45, dayLow: 315.78,
        open: 317.015, previousClose: 315.32, changePercent: 0.6311, tsSec: 1783972801,
    })
})

test('missing fields → null (except h/l default to price)', () => {
    const q = normalizeFmpQuote({ price: 100 })
    assert.deepEqual(q, { symbol: null, name: null, price: 100, dayHigh: 100, dayLow: 100, open: null, previousClose: null, changePercent: null, tsSec: null })
    const q2 = normalizeFmpQuote({ price: 100, dayHigh: 0, dayLow: -5 })
    assert.equal(q2.dayHigh, 100)
    assert.equal(q2.dayLow, 100)
})

test('toYfQuote maps to yahoo field names (tsSec kept as epoch seconds)', () => {
    const yf = toYfQuote(normalizeFmpQuote({ symbol: 'AAPL', name: 'Apple Inc.', price: 317.31, dayHigh: 323.45, dayLow: 315.78, open: 317, previousClose: 315.32, changePercentage: 0.63, timestamp: 1783972801 }))
    assert.equal(yf.symbol, 'AAPL')
    assert.equal(yf.shortName, 'Apple Inc.')
    assert.equal(yf.regularMarketPrice, 317.31)
    assert.equal(yf.regularMarketOpen, 317)
    assert.equal(yf.regularMarketDayHigh, 323.45)
    assert.equal(yf.regularMarketPreviousClose, 315.32)
    assert.equal(yf.regularMarketChangePercent, 0.63)
    assert.equal(yf.regularMarketTime, 1783972801)
    assert.equal(toYfQuote(null), null)
})

test('no usable price → null (never a false 0 that could trigger a fill)', () => {
    assert.equal(normalizeFmpQuote({ price: 0 }), null)
    assert.equal(normalizeFmpQuote({ price: -1 }), null)
    assert.equal(normalizeFmpQuote({ price: 'x' }), null)
    assert.equal(normalizeFmpQuote({}), null)
    assert.equal(normalizeFmpQuote(null), null)
    assert.equal(normalizeFmpQuote(undefined), null)
    assert.equal(normalizeFmpQuote([]), null)
})

test('string-numeric fields are coerced', () => {
    const q = normalizeFmpQuote({ price: '250.5', dayHigh: '252', dayLow: '249' })
    assert.equal(q.price, 250.5)
    assert.equal(q.dayHigh, 252)
    assert.equal(q.dayLow, 249)
})
