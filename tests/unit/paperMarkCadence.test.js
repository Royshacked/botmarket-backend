// The mark loop is paced by a QUOTE BUDGET, not by its tick. At 3s over 45 held symbols it spent
// ~900 quotes a minute around the clock against a plan that allows a few hundred, and the 429s it
// caused starved every other FMP read in the app — a Prometheus sizing came back "no forward
// revenue" while it ran (2026-09-21). The tick still fires every 3s; the SWEEP waits its turn.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweepIntervalMs, sweepDue } from '../../monitoring/paperMark.service.js'
import { config } from '../../services/config.js'

const TICK   = config.paperMarkIntervalMs          // 3s
const CLOSED = config.paperMarkClosedIntervalMs    // 60s
const BUDGET = config.paperMarkQuoteBudgetPerMin   // 120/min

test('in session, a handful of symbols sweeps every tick — the budget only bites when it is spent', () => {
    assert.equal(sweepIntervalMs(1, true), TICK)
    assert.equal(sweepIntervalMs(5, true), TICK)                        // 5/120 min = 2.5s < 3s
    assert.equal(sweepIntervalMs(45, true), 45 / BUDGET * 60_000)       // 22.5s
    assert.ok(sweepIntervalMs(45, true) > TICK)
})

test('the in-session spend never exceeds the budget, whatever the book size', () => {
    for (const n of [1, 10, 45, 120, 400]) {
        const perMinute = n / (sweepIntervalMs(n, true) / 60_000)
        assert.ok(perMinute <= BUDGET + 1e-9, `${n} symbols → ${perMinute}/min`)
    }
})

test('off-session, one sweep a minute — and slower still if the book is bigger than the budget allows', () => {
    assert.equal(sweepIntervalMs(1, false), CLOSED)
    assert.equal(sweepIntervalMs(45, false), CLOSED)                    // 22.5s by budget < 60s
    assert.equal(sweepIntervalMs(400, false), 400 / BUDGET * 60_000)    // 200s by budget > 60s
})

test('a sweep is due once its interval has passed since the last one, and not before', () => {
    const now = 1_000_000
    assert.equal(sweepDue(45, { now, open: true, last: now - 22_000 }), false)
    assert.equal(sweepDue(45, { now, open: true, last: now - 22_500 }), true)
    assert.equal(sweepDue(45, { now, open: false, last: now - 59_000 }), false)
    assert.equal(sweepDue(45, { now, open: false, last: now - 60_000 }), true)
    // A process that has never swept sweeps now.
    assert.equal(sweepDue(45, { now, open: false, last: 0 }), true)
})

test('the positions read trusts a stored mark for longer than the slowest sweep', () => {
    assert.ok(config.paperMarkFreshMs > sweepIntervalMs(45, false))
    assert.ok(config.paperMarkFreshMs > sweepIntervalMs(45, true))
})
