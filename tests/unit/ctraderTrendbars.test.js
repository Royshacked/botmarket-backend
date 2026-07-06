import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trendbarToOHLCV } from '../../providers/ctrader.session.provider.js'
import { toTrendbarPeriod } from '../../api/broker/adapters/ctrader.adapter.js'

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

test('toTrendbarPeriod maps supported cTrader bar widths', () => {
    assert.equal(toTrendbarPeriod('1min'),  1)
    assert.equal(toTrendbarPeriod('5min'),  5)
    assert.equal(toTrendbarPeriod('15min'), 7)
    assert.equal(toTrendbarPeriod('30min'), 8)
    assert.equal(toTrendbarPeriod('1hr'),   9)
    assert.equal(toTrendbarPeriod('4hr'),  10)
    assert.equal(toTrendbarPeriod('day'),  12)
    assert.equal(toTrendbarPeriod('week'), 13)
    assert.equal(toTrendbarPeriod('month'),14)
})

test('toTrendbarPeriod returns null for widths cTrader has no period for', () => {
    assert.equal(toTrendbarPeriod('2hr'), null)   // cTrader has H1/H4/H12, not H2
    assert.equal(toTrendbarPeriod('7min'), null)
    assert.equal(toTrendbarPeriod('garbage'), null)
})

test('toTrendbarPeriod defaults missing timeframe to daily', () => {
    // parseTimeframe(falsy) → daily; documents the fallback getCandles inherits.
    assert.equal(toTrendbarPeriod(undefined), 12)
})

test('trendbarToOHLCV reconstructs low + deltas at the 1e5 scale', () => {
    // low = 19678.00000 in 1/100000 units; deltas are non-negative above low.
    const raw = {
        low:        1967800000,
        deltaOpen:  50000,        // +0.5
        deltaHigh:  120000,       // +1.2
        deltaClose: 30000,        // +0.3
        volume:     1234,
        utcTimestampInMinutes: 29_000_000,
    }
    const bar = trendbarToOHLCV(raw, 2)

    approx(bar.l, 19678.0)
    approx(bar.o, 19678.5)
    approx(bar.h, 19679.2)
    approx(bar.c, 19678.3)
    assert.equal(bar.v, 1234)
    assert.equal(bar.t, 29_000_000 * 60_000)   // minutes → ms
})

test('trendbarToOHLCV tolerates missing deltas (bar = flat at low)', () => {
    const bar = trendbarToOHLCV({ low: 100_00000, utcTimestampInMinutes: 1 }, 2)
    approx(bar.l, 100)
    approx(bar.o, 100)
    approx(bar.h, 100)
    approx(bar.c, 100)
    assert.equal(bar.v, 0)
})
