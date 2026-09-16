import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateTouch } from '../../monitoring/evaluators/touch.evaluator.js'
import { evaluateTime, toMs } from '../../monitoring/evaluators/time.evaluator.js'
import { evaluateVolume } from '../../monitoring/evaluators/volume.evaluator.js'

// The three pure leaf evaluators on the monitor's hot path — candle math and the wall clock, no
// model, no I/O. None had a unit test.

const T1 = 1_700_000_000_000, T2 = 1_700_000_060_000
const bar = (t, l, h, v = 1000) => ({ o: l, h, l, c: h, v, t })

// ── touch ─────────────────────────────────────────────────────────────────────

test('touch: the level within a bar range fires at that bar', () => {
    const candles = [bar(T1, 90, 100), bar(T2, 100, 110)]
    assert.deepEqual(evaluateTouch({ value: 95 }, candles), { pass: true, triggerAt: T1 })
    assert.deepEqual(evaluateTouch({ value: 105 }, candles), { pass: true, triggerAt: T2 })
    assert.equal(evaluateTouch({ value: 200 }, candles).pass, false)
})

test('touch is direction-agnostic — a touch from above and from below both fire', () => {
    assert.equal(evaluateTouch({ value: 100 }, [bar(1, 100, 110)]).pass, true) // from below
    assert.equal(evaluateTouch({ value: 100 }, [bar(1, 90, 100)]).pass, true)  // from above
})

test('touch: floorAt excludes a touch before it; the exact boundary counts', () => {
    const candles = [bar(T1, 90, 100), bar(T2, 100, 110)]
    assert.equal(evaluateTouch({ value: 95 }, candles, T1 + 1).pass, false)
    assert.deepEqual(evaluateTouch({ value: 105 }, candles, T2), { pass: true, triggerAt: T2 })
})

test('touch: no candles / no level fails with a reason, never throws', () => {
    assert.equal(evaluateTouch({ value: 95 }, []).reason, 'insufficient_data')
    assert.equal(evaluateTouch({ value: 'x' }, [bar(1, 90, 100)]).reason, 'no_level')
})

test('touch: seconds and ms timestamps are both understood (candleMs)', () => {
    assert.equal(evaluateTouch({ value: 95 }, [bar(1_700_000_000, 90, 100)]).triggerAt, 1_700_000_000_000)
    assert.equal(evaluateTouch({ value: 95 }, [bar(1_700_000_000_000, 90, 100)]).triggerAt, 1_700_000_000_000)
})

// ── time ────────────────────────────────────────────────────────────────────

test('time: empty bounds are ignored (always pass)', () => {
    assert.equal(evaluateTime({}), true)
    assert.equal(evaluateTime({ after: '', before: '' }), true)
})

test('time: after / before / a window, against a fixed now', () => {
    const now = Date.parse('2026-06-15T12:00:00Z')
    assert.equal(evaluateTime({ after:  '2026-01-01T00:00:00Z' }, now), true)
    assert.equal(evaluateTime({ after:  '2027-01-01T00:00:00Z' }, now), false)
    assert.equal(evaluateTime({ before: '2027-01-01T00:00:00Z' }, now), true)
    assert.equal(evaluateTime({ before: '2026-01-01T00:00:00Z' }, now), false)
    assert.equal(evaluateTime({ after: '2026-01-01T00:00:00Z', before: '2026-12-31T00:00:00Z' }, now), true)
})

test('time: an unparseable bound is ignored, not fatal', () => {
    const now = Date.parse('2026-06-15T12:00:00Z')
    assert.equal(evaluateTime({ after: 'not a date' }, now), true)
})

test('toMs: ISO, epoch ms, epoch seconds, empty', () => {
    assert.equal(toMs('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'))
    assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000)
    assert.equal(toMs(1_700_000_000), 1_700_000_000_000)
    assert.equal(toMs(''), null)
    assert.equal(toMs(null), null)
})

// ── volume (cumulative mode is offline; bar mode delegates to the structured engine) ──

test('volume cumulative: the deterministic guard paths (no data / no session / no bars in session)', async () => {
    // The pass path parses a threshold, which needs the model for anything but 'price touches N', so
    // this pins the offline guards: cumulative mode fails closed with a REASON, never a throw.
    const candles = [bar(T1, 1, 1, 500), bar(T2, 1, 1, 700)]
    assert.equal((await evaluateVolume({ mode: 'cumulative', condition: 'x' }, [], {})).reason, 'insufficient_data')
    assert.equal((await evaluateVolume({ mode: 'cumulative', condition: 'x' }, candles, {})).reason, 'no_session_start')
    // A session start AFTER every bar → nothing counted.
    assert.equal((await evaluateVolume({ mode: 'cumulative', condition: 'x' }, candles, { sessionStartMs: T2 + 60_000 })).reason, 'no_bars_in_session')
})

test('volume: an empty condition fails closed with a reason', async () => {
    assert.equal((await evaluateVolume({ mode: 'bar', condition: '' }, [], {})).reason, 'no_condition')
})
