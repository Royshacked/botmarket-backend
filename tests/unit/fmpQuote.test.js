import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFmpQuote } from '../../providers/fmp.price.provider.js'

// normalizeFmpQuote maps an FMP /quote row → { price, dayHigh, dayLow, name }. This is the
// piece the paper mark/fill path relies on to replace the stale-day-candle price that
// caused a false TP fill (project_timestamp_ideas Issue 1). Network fetch isn't unit-tested.

test('valid row → price + day high/low + name', () => {
    const q = normalizeFmpQuote({ symbol: 'SNDK', name: 'Sandisk Corporation', price: 1672.8, dayHigh: 1800, dayLow: 1658.2 })
    assert.deepEqual(q, { price: 1672.8, dayHigh: 1800, dayLow: 1658.2, name: 'Sandisk Corporation' })
})

test('missing/degenerate high-low fall back to price', () => {
    const q = normalizeFmpQuote({ price: 100 })
    assert.deepEqual(q, { price: 100, dayHigh: 100, dayLow: 100, name: null })
    const q2 = normalizeFmpQuote({ price: 100, dayHigh: 0, dayLow: -5 })
    assert.equal(q2.dayHigh, 100)
    assert.equal(q2.dayLow, 100)
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
