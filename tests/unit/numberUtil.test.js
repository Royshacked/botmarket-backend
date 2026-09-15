import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundTo, round2, round4, round8, roundOrNull, roundOrZero } from '../../services/number.util.js'

// Twelve modules kept a private rounding helper in one of four flavours. This pins the flavours so
// a caller picking one gets the edge behaviour it asked for — the reason they are separate names.

test('plain rounding at each precision', () => {
    assert.equal(round2(1.234567), 1.23)
    assert.equal(round2(1.235),    1.24)
    assert.equal(round4(0.123456), 0.1235)
    assert.equal(round8(994.430953846), 994.43095385)
    assert.equal(roundTo(1234.5678, 0), 1235)
    assert.equal(roundTo(-1.005, 2), -1)   // Math.round toward +∞ on .5, as the old helpers did
})

test('plain rounding lets a non-number through as NaN — the caller checks', () => {
    assert.ok(Number.isNaN(round2(NaN)))
    assert.ok(Number.isNaN(round2(undefined)))
})

test('roundOrNull: a display value that may be "not reported"', () => {
    assert.equal(roundOrNull(12.345), 12.35)
    assert.equal(roundOrNull(12.3456, 3), 12.346)
    assert.equal(roundOrNull(null), null)
    assert.equal(roundOrNull(undefined), null)
    assert.equal(roundOrNull(NaN), null)
    assert.equal(roundOrNull(Infinity), null)
    assert.equal(roundOrNull('7.891'), 7.89, 'a numeric string is a number')
    assert.equal(roundOrNull('abc'), null)
})

test('roundOrZero: an accumulator or quantity — nothing counts as zero', () => {
    assert.equal(roundOrZero(12.345), 12.35)
    assert.equal(roundOrZero(0.00004, 4), 0)
    assert.equal(roundOrZero(0.00005, 4), 0.0001)
    assert.equal(roundOrZero(null), 0)
    assert.equal(roundOrZero(undefined), 0)
    assert.equal(roundOrZero(NaN), 0)
    assert.equal(roundOrZero('x'), 0)
})

test('sub-cent instruments survive at 8dp and die at 2dp — why storage uses round8', () => {
    assert.equal(round8(0.000012), 0.000012)
    assert.equal(round2(0.000012), 0)
})
