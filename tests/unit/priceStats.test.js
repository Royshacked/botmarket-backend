import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stdev, pearson, correlationMatrix } from '../../services/priceStats.util.js'

test('stdev: sample standard deviation', () => {
    assert.ok(Math.abs(stdev([1, 2, 3, 4]) - 1.2909944487358056) < 1e-9)
})

test('pearson: perfectly correlated series → 1, anti-correlated → -1', () => {
    assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-9)
    assert.ok(Math.abs(pearson([1, 2, 3], [3, 2, 1]) + 1) < 1e-9)
})

test('correlationMatrix: 1 on the diagonal', () => {
    const m = correlationMatrix([[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]])
    assert.equal(m[0][0], 1)
    assert.equal(m[1][1], 1)
    // symmetric off-diagonal
    assert.ok(Math.abs(m[0][1] - m[1][0]) < 1e-12)
})
