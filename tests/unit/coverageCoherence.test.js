import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ratingCoherence } from '../../api/analyst/coverage.service.js'

// The rating/target coherence gate — a rating is a claim about the PRICE, the gap is a claim about the
// STREET, and until this existed nothing compared the two before the daily monitor did. The case that
// produced it: ZTS rated `sell` with a target of 85.15 while the stock traded at 77.29 (+10% of our own
// upside), stamped `target_hit` 26 minutes after initiation.

const pt = value => ({ value, horizon: '12m', basis: 'x' })

// ── the contradictions ───────────────────────────────────────────────────────
test('bearish rating with a target ABOVE spot is rejected (the ZTS case)', () => {
    const r = ratingCoherence({ rating: 'sell', price_target: pt(85.15), price: 77.29 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'rating_contradicts_target')
    assert.match(r.detail, /needs downside/)
    assert.match(r.detail, /\+10\.2%/)          // the implied return, signed and named
    assert.equal(ratingCoherence({ rating: 'strong_sell', price_target: pt(120), price: 100 }).ok, false)
})

test('bullish rating with a target BELOW spot is rejected (the mirror)', () => {
    const r = ratingCoherence({ rating: 'buy', price_target: pt(90), price: 100 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'rating_contradicts_target')
    assert.match(r.detail, /needs upside/)
    assert.match(r.detail, /-10%/)
    assert.equal(ratingCoherence({ rating: 'strong_buy', price_target: pt(50), price: 51 }).ok, false)
})

test('a target sitting exactly ON spot supports neither direction', () => {
    assert.equal(ratingCoherence({ rating: 'buy',  price_target: pt(100), price: 100 }).ok, false)
    assert.equal(ratingCoherence({ rating: 'sell', price_target: pt(100), price: 100 }).ok, false)
})

// ── the coherent theses ──────────────────────────────────────────────────────
test('a rating that agrees with its target passes, however far it sits from the Street', () => {
    assert.equal(ratingCoherence({ rating: 'buy',         price_target: pt(120), price: 100 }).ok, true)
    assert.equal(ratingCoherence({ rating: 'strong_buy',  price_target: pt(101), price: 100 }).ok, true)
    assert.equal(ratingCoherence({ rating: 'sell',        price_target: pt(80),  price: 100 }).ok, true)
    assert.equal(ratingCoherence({ rating: 'strong_sell', price_target: pt(99),  price: 100 }).ok, true)
})

// ── where the gate ABSTAINS ──────────────────────────────────────────────────
// It is a contradiction detector, not a data requirement: anything it can't judge, it passes.
test('hold / no rating claims no direction → nothing to contradict', () => {
    assert.equal(ratingCoherence({ rating: 'hold', price_target: pt(85), price: 77 }).ok, true)
    assert.equal(ratingCoherence({ rating: null,   price_target: pt(85), price: 77 }).ok, true)
    assert.equal(ratingCoherence({ price_target: pt(85), price: 77 }).ok, true)
})

test('no target, no price, or a junk price → abstain (market data must never block research)', () => {
    assert.equal(ratingCoherence({ rating: 'sell', price_target: null,   price: 77 }).ok, true)
    assert.equal(ratingCoherence({ rating: 'sell', price_target: pt(85), price: null }).ok, true)
    assert.equal(ratingCoherence({ rating: 'sell', price_target: pt(85), price: 0 }).ok, true)
    assert.equal(ratingCoherence({ rating: 'sell', price_target: pt(85), price: -3 }).ok, true)
    assert.equal(ratingCoherence().ok, true)
})

test('a bare numeric target is accepted alongside the {value} shape', () => {
    assert.equal(ratingCoherence({ rating: 'sell', price_target: 85.15, price: 77.29 }).ok, false)
    assert.equal(ratingCoherence({ rating: 'sell', price_target: '80',  price: 100 }).ok, true)
})
