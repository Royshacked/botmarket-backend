import { test } from 'node:test'
import assert from 'node:assert/strict'
import { values, chooseValue, FAMILIES } from '../../scripts/lab-proteus-values.mjs'

// proteus.md §10.4: per name, the older part picks a value per family; only the picked one's verdict counts.

function randomWalk(n, seed, start = 100) {
    let s = seed >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    const out = []
    let p = start
    for (let i = 0; i < n; i++) {
        const o = p
        p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04))
        const hi = Math.max(o, p) * (1 + rnd() * 0.01), lo = Math.min(o, p) * (1 - rnd() * 0.01)
        out.push({ open: o, high: hi, low: lo, close: p, volume: 1e6 * (0.5 + rnd()), timestamp: 1_600_000_000 + i * 86_400 })
    }
    return out
}

test('the value with the largest older edge among the non-thin is chosen, and its verdict counts', () => {
    const j = (verdict, edge) => ({ j: { verdict, edge } })
    assert.deepEqual(chooseValue({ a: j('no', 0.02), b: j('respects', 0.15), c: j('thin', 0.5) }).value, 'b')
    assert.equal(chooseValue({ a: j('no', 0.2), b: j('respects', 0.15) }).verdict, 'no', 'the biggest edge, not the best verdict')
    assert.deepEqual(chooseValue({ a: j('thin', 0.3) }), { value: null, verdict: 'thin' })
})

test('every family and value is judged on one series', () => {
    const v = values(randomWalk(1500, 3))
    for (const f of FAMILIES) assert.deepEqual(Object.keys(v[f.key]).sort(), [...f.values].sort(), f.key)
})

test('on random walks the search over values flags almost nothing at z 3', () => {
    let flagged = 0, tries = 0
    for (let k = 0; k < 6; k++) {
        const v = values(randomWalk(2500, 71 + k))
        for (const f of FAMILIES) { tries++; if (chooseValue(v[f.key]).verdict === 'respects') flagged++ }
    }
    assert.ok(flagged <= 2, `${flagged} of ${tries} families flagged on noise`)
})
