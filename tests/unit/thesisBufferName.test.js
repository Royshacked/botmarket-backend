import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depthVerdict, DEPTHS, BAR } from '../../scripts/lab-thesis-buffer-name.mjs'

// Test 5 (docs/design/stock-playbook.md): per name, the older two-thirds choose a stop depth, the recent third checks it.

/** Signals with R per depth: `gain` added to depth `d` over the reference, a little noise so the paired z is finite. */
const sigs = (n, from, d, gain) => Array.from({ length: n }, (_, k) => {
    const base = (k % 3) - 1
    const r = DEPTHS.map(() => base)
    r[d] = base + gain + ((k % 2) ? 0.02 : -0.02)
    return { i: from + k, r }
})

test('too few older signals: thin', () => {
    assert.equal(depthVerdict(sigs(BAR.minN - 1, 0, 2, 1), 1000).verdict, 'thin')
})

test('a depth clearly better on the older part AND the recent third: respects, and it is named', () => {
    const v = depthVerdict([...sigs(30, 0, 2, 0.5), ...sigs(10, 1000, 2, 0.5)], 1000)
    assert.equal(v.verdict, 'respects')
    assert.equal(DEPTHS[v.best].id, '1 ATR')
})

test('better on the older part, not on the recent third: faded; too few recent: unconfirmed', () => {
    assert.equal(depthVerdict([...sigs(30, 0, 3, 0.5), ...sigs(10, 1000, 3, -0.2)], 1000).verdict, 'faded')
    assert.equal(depthVerdict([...sigs(30, 0, 3, 0.5), ...sigs(3, 1000, 3, 0.5)], 1000).verdict, 'unconfirmed')
})

test('the reference (0.2 ATR) best, or a gain under the bar: no', () => {
    assert.equal(depthVerdict(sigs(30, 0, 1, -0.3), 1000).verdict, 'no')
    assert.equal(depthVerdict([...sigs(30, 0, 1, 0.05), ...sigs(10, 1000, 1, 0.05)], 1000).verdict, 'no')
})
