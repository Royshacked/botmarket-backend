// The scorecard — what the names did.
//
// Every candidate is a falsifiable claim, graded once at its expiry by the engine's nightly
// refresh and written as ONE document. Node reads it; it does not reproduce the tally. What
// is guarded here is the shape the screen relies on, the two empty states staying
// distinguishable, and the route being a broadcast like the list it grades.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shapeScorecard } from '../../api/aether/aether.service.js'

const DOC = {
    _id: 'latest',
    computed_at: '2026-10-29T22:31:00Z',
    overall: { n: 12, hit: 7, miss: 4, flat: 1, unpriced: 0, hit_rate: 0.636, avg_signed_pct: 0.014 },
    by_verdict: { quantified: { n: 5, hit: 4, miss: 1, flat: 0, unpriced: 0, hit_rate: 0.8, avg_signed_pct: 0.02 } },
    pending: 170,
    next_expiry: '2026-11-03',
}

test('the engine document is the card, minus its Mongo id', () => {
    const card = shapeScorecard(DOC)
    assert.equal(card._id, undefined)
    assert.equal(card.overall.hit_rate, 0.636)
    assert.equal(card.by_verdict.quantified.hit, 4)
    assert.equal(card.pending, 170)
    assert.equal(card.next_expiry, '2026-11-03')
})

test('no document is null — the nightly has not run, which is not an empty card', () => {
    assert.equal(shapeScorecard(null), null)
    assert.equal(shapeScorecard(undefined), null)
})

test('a document missing a split still yields every key the screen reads', () => {
    const card = shapeScorecard({ _id: 'latest', overall: { n: 0 } })
    for (const k of ['by_verdict', 'by_tier', 'by_category', 'by_survived', 'by_side', 'by_run']) {
        assert.deepEqual(card[k], {})
    }
    assert.equal(card.pending, 0)
    assert.equal(card.next_expiry, '')
})

test('an empty card keeps pending and next_expiry, so "no edge yet" and "nothing expired yet" differ', () => {
    const card = shapeScorecard({ _id: 'latest', overall: { n: 0, hit_rate: null }, pending: 182, next_expiry: '2026-09-27' })
    assert.equal(card.overall.n, 0)
    assert.equal(card.pending, 182)
    assert.equal(card.next_expiry, '2026-09-27')
})

test('the route is a broadcast read, not admin-gated', () => {
    const src = readFileSync(new URL('../../api/aether/aether.routes.js', import.meta.url), 'utf8')
    const line = src.split('\n').find(l => l.includes("'/scorecard'"))
    assert.ok(line, 'the scorecard route exists')
    assert.ok(!line.includes('requireAdmin'), 'a desk whose record only its admin can see is a desk on trust')
})
