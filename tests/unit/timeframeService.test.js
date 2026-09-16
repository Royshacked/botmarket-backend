import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    normalizeTimeframe, parseTimeframe, isIntradayTimeframe, isIntradaySpan,
    getCheckGap, barDurationSeconds, barSpecCacheKey, VALID_TIMEFRAMES,
} from '../../services/timeframe.service.js'

// The pure timeframe vocabulary every candle read passes through — free-form → canonical, canonical
// → provider bar spec, and the derived durations. No test until §10.

test('normalizeTimeframe: free-form spellings collapse to canonical', () => {
    for (const [inp, out] of [
        ['15m', '15min'], ['15 min', '15min'], ['15-minutes', '15min'],
        ['4h', '4hr'], ['4 hr', '4hr'], ['4-hours', '4hr'],
        ['daily', 'day'], ['weekly', 'week'], ['monthly', 'month'],
        ['day', 'day'], ['1min', '1min'],
    ]) assert.equal(normalizeTimeframe(inp), out, inp)
})

test('normalizeTimeframe: empty is null, an unknown string is kept as-is (not silently lost)', () => {
    assert.equal(normalizeTimeframe(''), null)
    assert.equal(normalizeTimeframe(null), null)
    assert.equal(normalizeTimeframe(42), null)
    assert.equal(normalizeTimeframe('fortnight'), 'fortnight')
})

test('every canonical timeframe normalises to itself and parses to a spec', () => {
    for (const tf of VALID_TIMEFRAMES) {
        assert.equal(normalizeTimeframe(tf), tf, tf)
        assert.ok(parseTimeframe(tf), `${tf} parses`)
    }
})

test('parseTimeframe: canonical, legacy, falsy → daily, unknown → null', () => {
    assert.deepEqual(parseTimeframe('5min'), { timeSpan: 'minute', multiplier: 5 })
    assert.deepEqual(parseTimeframe('4hr'), { timeSpan: 'hour', multiplier: 4 })
    assert.deepEqual(parseTimeframe('day'), { timeSpan: 'day', multiplier: 1 })
    assert.deepEqual(parseTimeframe('daily'), { timeSpan: 'day', multiplier: 1 })
    assert.deepEqual(parseTimeframe('minutes'), { timeSpan: 'minute', multiplier: 5 })
    assert.deepEqual(parseTimeframe(''), { timeSpan: 'day', multiplier: 1 })
    assert.deepEqual(parseTimeframe(null), { timeSpan: 'day', multiplier: 1 })
    assert.equal(parseTimeframe('fortnight'), null)
})

test('isIntraday: sub-daily string / span', () => {
    assert.equal(isIntradayTimeframe('15min'), true)
    assert.equal(isIntradayTimeframe('4hr'), true)
    assert.equal(isIntradayTimeframe('day'), false)
    assert.equal(isIntradayTimeframe(null), false)
    assert.equal(isIntradaySpan('minute'), true)
    assert.equal(isIntradaySpan('hour'), true)
    assert.equal(isIntradaySpan('day'), false)
})

test('getCheckGap: sub-hour = bar width, day/week/month = 4h/24h/24h, unknown = 4h', () => {
    assert.equal(getCheckGap('15min'), 15 * 60 * 1000)
    assert.equal(getCheckGap('2hr'), 2 * 3600 * 1000)
    assert.equal(getCheckGap('day'), 4 * 3600 * 1000)
    assert.equal(getCheckGap('week'), 24 * 3600 * 1000)
    assert.equal(getCheckGap('daily'), 4 * 3600 * 1000)
    assert.equal(getCheckGap(''), 4 * 3600 * 1000)
    assert.equal(getCheckGap('fortnight'), 4 * 3600 * 1000)
})

test('barDurationSeconds: per span, with a floored multiplier', () => {
    assert.equal(barDurationSeconds('minute', 5), 300)
    assert.equal(barDurationSeconds('hour', 4), 4 * 3600)
    assert.equal(barDurationSeconds('day', 1), 86400)
    assert.equal(barDurationSeconds('week', 1), 7 * 86400)
    assert.equal(barDurationSeconds('minute', 0), 60, 'a bad multiplier floors to 1')
    assert.equal(barDurationSeconds('nonsense', 2), 2 * 60, 'unknown span → minute')
})

test('barSpecCacheKey: multiplier + span suffix, defaulting a bad span to day', () => {
    assert.equal(barSpecCacheKey({ timeSpan: 'minute', multiplier: 15 }), '15m')
    assert.equal(barSpecCacheKey({ timeSpan: 'hour', multiplier: 1 }), '1h')
    assert.equal(barSpecCacheKey({ timeSpan: 'day', multiplier: 1 }), '1d')
    assert.equal(barSpecCacheKey({ timeSpan: 'week', multiplier: 1 }), '1w')
    assert.equal(barSpecCacheKey({ timeSpan: 'month', multiplier: 1 }), '1mo')
    assert.equal(barSpecCacheKey({ timeSpan: 'bogus', multiplier: 3 }), '3d')
})
