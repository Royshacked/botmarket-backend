import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactMoney, compactNumber } from '../../services/format.util.js'

test('compactMoney: T/B/M tiers with $ and 2 decimals', () => {
    assert.equal(compactMoney(2.5e12), '$2.50T')
    assert.equal(compactMoney(1.5e9),  '$1.50B')
    assert.equal(compactMoney(3.2e6),  '$3.20M')
})

test('compactMoney: values under 1M are not compacted', () => {
    assert.equal(compactMoney(450), '$450')
})

test('compactMoney: negatives keep the sign', () => {
    assert.equal(compactMoney(-1.5e9), '$-1.50B')
})

test('compactMoney/compactNumber: non-finite → null', () => {
    assert.equal(compactMoney(NaN), null)
    assert.equal(compactNumber(NaN), null)
})

test('compactNumber: no $ prefix', () => {
    assert.equal(compactNumber(1.23e9), '1.23B')
    assert.equal(compactNumber(4.5e6),  '4.50M')
    assert.equal(compactNumber(12345),  '12345')
})
