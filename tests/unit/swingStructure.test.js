import { test } from 'node:test'
import assert from 'node:assert/strict'
import { structureFacts, entryLevel, toWeekly, mirror, atr, swings, STRUCTURE, controlReplay, rangeTarget, lowestLow, lastTradedUnder } from '../../services/swingStructure.service.js'
import { unmirrorFacts } from '../../services/tools/thesisStructure.tools.js'

// The THESIS lens's shared mechanism (docs/design/stock-playbook.md): the facts Mentor judges the stop and targets from,
// and the entry arithmetic. The swings and ATR themselves are covered by thesisLab.test.js (the lab re-exports them).

/** Weekday-dated bars from closes: `{ date, open, high, low, close, volume }`, range ±0.5 unless given. */
function bars(closes, { from = '2026-01-05', vol = 1e6, over = {} } = {}) {
    const out = []
    for (let t = Date.parse(`${from}T12:00:00Z`), i = 0; out.length < closes.length; t += 86_400_000) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const c = closes[i], o = over[i] ?? {}
        out.push({ date: new Date(t).toISOString().slice(0, 10), open: o.o ?? c, high: o.h ?? c + 0.5, low: o.l ?? c - 0.5, close: c, volume: o.v ?? vol })
        i++
    }
    return out
}

/** Flat at 100, a fast fall to 80 on heavy volume, a rally to 86, a test at 83, a close over the rally. */
function reversal() {
    const closes = [...Array(60).fill(100), 98, 96, 97, 99, 100, ...Array(30).fill(100), 98, 95, 92, 89, 86, 83, 81, 80.5, 82, 84, 86, 86, 85, 84, 83.6, 83.5, 84.5, 86, 87.5]
    const climax = closes.indexOf(80.5)
    return bars(closes, { over: { [climax]: { l: 80, h: 81, v: 4e6 }, [climax + 6]: { h: 86.6 }, [closes.length - 4]: { l: 83 } } })
}

test('structureFacts: under 60 bars → null', () => {
    assert.equal(structureFacts(bars(Array(59).fill(10))), null)
})

test('structureFacts: a reversal — buyers in control after sellers, the stop under the last sellers’ swing, the target the start of the fall', () => {
    const f = structureFacts(reversal())
    assert.equal(f.control, 'buyers')
    assert.equal(f.last_break.context, 'reversal')
    assert.equal(f.last_swing_low.price, 83, 'the last sellers’ swing, not the climax')
    assert.ok(f.candidates.stop < 83 && f.candidates.stop > 82.5, 'under it by the buffer')
    assert.equal(f.candidates.deep_stop < 80, true, 'the deep option: under the whole fall')
    assert.equal(f.fall.low.price, 80)
    assert.equal(f.fall.from.price, 100.5)
    assert.equal(f.candidates.target, 100.5)
    assert.ok(f.heavy_days.some(d => d.volume_x >= 3.9), 'the climax day')
    for (const s of f.swings) assert.ok(s.confirmed > s.date, 'a swing is dated, and confirmed after it')
})

test('structureFacts: the deep stop carries the last date price traded under it — null when the history has none', () => {
    const rows = reversal()
    assert.equal(structureFacts(rows).candidates.deep_stop_last_traded, null, 'flat at 100 before the fall: never under it')
    rows[10] = { ...rows[10], low: 70 }
    rows[12] = { ...rows[12], low: 71 }
    const f = structureFacts(rows)
    assert.equal(f.candidates.deep_stop_last_traded, rows[12].date, 'the LAST visit under it, not the first')
    assert.ok(f.candidates.deep_stop > 71, 'the visits were under the deep stop')
})

test('structureFacts on a short’s mirrored bars: the last time over the deep stop is the same field', () => {
    const rows = reversal().map(b => ({ ...b }))
    rows[10] = { ...rows[10], low: 70 }
    const f = structureFacts(mirror(rows.map(b => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }))))
    assert.equal(f.candidates.deep_stop_last_traded, rows[10].date, 'a short\'s chart turned the right way up reads the same visit')
})

test('lastTradedUnder: the LAST bar whose low went under the level, at or before the bar asked — null when none', () => {
    const rows = bars([100, 90, 100, 95, 100])
    assert.equal(lastTradedUnder(rows, 96), 3)
    assert.equal(lastTradedUnder(rows, 96, 2), 1, 'from an earlier bar back')
    assert.equal(lastTradedUnder(rows, 80), null)
})

test('structureFacts: the break candidate — the nearest high over the price, an assumed stop one swing under it, the next high as target', () => {
    const rows = reversal()
    const f = structureFacts(rows.slice(0, -1))   // the day before the close over the swing high
    assert.equal(f.control, 'sellers')
    const b = f.break_candidate
    assert.deepEqual([b.swing_to_break.price, b.higher_swing.price, b.fall_low.price], [86.6, 83, 80])
    assert.equal(b.stop_is, 'assumed')
    assert.ok(Math.abs(b.stop - (86.6 - (STRUCTURE.k + STRUCTURE.buffer) * f.atr)) < 0.02, 'one swing of the normal move under the line, then the noise buffer')
    assert.ok(b.target >= b.swing_to_break.price + (b.swing_to_break.price - b.stop) - 0.02, 'at least a stop\'s distance over the line, or no level could pass the limits')
    assert.equal(b.context, 'reversal', 'sellers in control, inside the range')
})

test('structureFacts: the break candidate needs no printed higher low', () => {
    const f = structureFacts(reversal().slice(0, -2))
    assert.ok(f.break_candidate.swing_to_break.price > f.close, 'the higher low not yet confirmed: the line and the assumed stop still stand')
})

test('structureFacts: today\'s own wick is no line', () => {
    const rising = bars(Array.from({ length: 80 }, (_, i) => 100 + i)).map(b => ({ ...b, high: b.close }))
    rising[79] = { ...rising[79], high: rising[79].close + 0.4 }
    assert.equal(structureFacts(rising).break_candidate, null)
})

test('structureFacts: a break that would not flip control is not called a reversal', () => {
    const rows = reversal()
    assert.equal(structureFacts(rows.slice(0, -1)).break_candidate.context, 'reversal')
    // Each swing high breaks once, and the facts have to know it has: a close over it again flips nothing.
    const replay = (r) => controlReplay(r, swings(r, atr(r), STRUCTURE.k))
    assert.equal(replay(rows.slice(0, -1)).lastHBroken, false)
    assert.equal(replay(rows).lastHBroken, true)
})

test('structureFacts: with no high over the price there is no line, so no break candidate', () => {
    const rising = bars(Array.from({ length: 80 }, (_, i) => 100 + i)).map(b => ({ ...b, high: b.close }))
    assert.equal(structureFacts(rising).break_candidate, null)
})

test('structureFacts on a short’s mirrored bars: the normal move is still a positive percent', () => {
    const f = structureFacts(mirror(reversal()))
    assert.ok(f.close < 0, 'the mirror')
    assert.ok(f.atr_pct > 0)
})

test('controlReplay: the one rule the lab tested and Mentor reads — sellers, then a break up that is a reversal', () => {
    const rows = reversal(), a = atr(rows), pv = swings(rows, a, STRUCTURE.k), breaks = []
    const s = controlReplay(rows, pv, { onBreak: (b) => breaks.push(b) })
    assert.equal(s.control, 'buyers')
    assert.equal(s.lastBreak.context, 'reversal')
    assert.equal(breaks.at(-1).before, 'sellers')
    assert.equal(breaks.at(-1).i, s.lastBreak.i)
    assert.equal(rows[s.since].date, structureFacts(rows).since, 'the facts report the same replay')
})

test('rangeTarget and lowestLow: the start of the fall, or the measured move at the highs', () => {
    const rows = bars([10, 12, 11, 9, 10])
    assert.deepEqual(rangeTarget(rows, 4, 8.5, 40), { target: 12.5, kind: 'range_top' })
    const highs = bars([10, 11, 12, 13])
    assert.deepEqual(rangeTarget(highs, 3, 9.5, 40), { target: 12.5 + 3, kind: 'measured_move' })
    assert.equal(rangeTarget(highs, 3, null, 40).target, null)
    assert.deepEqual(lowestLow(rows, 4, 3), { price: 8.5, j: 3 })
})

test('entryLevel: the lower of the two ceilings — the risk limit and the reward to risk', () => {
    // MTG 2026-10-29 (Roy's levels): stop 26.9, target 31.6 — at R:R 1.5 the level is 28.78.
    const rr = entryLevel({ stop: 26.9, target: 31.6, minRR: 1.5 })
    assert.deepEqual([rr.level, rr.by], [28.78, 'reward_to_risk'])
    assert.equal(rr.rr_at_level, 1.5)
    const risk = entryLevel({ stop: 26.9, target: 31.6, riskPct: 5 })
    assert.deepEqual([risk.level, risk.by, risk.risk_pct_at_level], [28.32, 'risk_limit', 5])
    const both = entryLevel({ stop: 26.9, target: 31.6, riskPct: 8, minRR: 1.5 })
    assert.equal(both.by, 'reward_to_risk', '8% would allow 29.24 — the R:R is the tighter ceiling')
})

test('entryLevel: a short mirrors it; nonsense is a problem, not a number', () => {
    const s = entryLevel({ stop: 110, target: 90, minRR: 1, side: 'short' })
    assert.deepEqual([s.level, s.rr_at_level], [100, 1])
    assert.match(entryLevel({ stop: 30, target: 29, minRR: 1.5 }).problem, /over the stop/)
    assert.match(entryLevel({ stop: 26.9, target: 31.6 }).problem, /risk limit/)
    assert.match(entryLevel({ stop: 26.9, target: 31.6, riskPct: 100 }).problem, /between 0 and 100/)
    assert.match(entryLevel({ stop: 26.9, target: 31.6, riskPct: 0 }).problem, /between 0 and 100/)
    assert.match(entryLevel({ stop: 26.9, target: 31.6, minRR: 0 }).problem, /over 0/)
})

test('toWeekly: Monday-keyed weeks, the high, low, last close and summed volume', () => {
    const w = toWeekly(bars([10, 11, 12, 11, 13, 14, 12], { from: '2026-10-19' }))
    assert.equal(w.length, 2)
    assert.deepEqual([w[0].date, w[0].open, w[0].high, w[0].low, w[0].close, w[0].volume], ['2026-10-19', 10, 13.5, 9.5, 13, 5e6])
    assert.deepEqual([w[1].date, w[1].close], ['2026-10-26', 12])
})

test('the break floor: its stop when price is over it, else the low of the fall; mirrored on a short', () => {
    const f = structureFacts(reversal().slice(0, -1)).break_candidate
    assert.ok(Number.isFinite(f.floor))
    assert.ok(f.floor === f.stop || f.floor === f.fall_low.price)
    const close = structureFacts(reversal().slice(0, -1)).close
    assert.ok(f.floor < close, 'always under the close it was read at')
    const u = unmirrorFacts({ close: -100, swings: [], last_swing_low: null, last_swing_high: null, control: 'buyers', fall: null, candidates: {}, heavy_days: [],
        break_candidate: { swing_to_break: { type: 'high', price: -90 }, higher_swing: null, fall_low: { date: 'd', price: -120 }, stop: -95, stop_is: 'assumed', floor: -120, target: -80, context: 'reversal' } })
    assert.equal(u.break_candidate.floor, 120)
})
