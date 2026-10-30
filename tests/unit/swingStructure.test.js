import { test } from 'node:test'
import assert from 'node:assert/strict'
import { structureFacts, entryLevel, toWeekly } from '../../services/swingStructure.service.js'

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
})

test('toWeekly: Monday-keyed weeks, the high, low, last close and summed volume', () => {
    const w = toWeekly(bars([10, 11, 12, 11, 13, 14, 12], { from: '2026-10-19' }))
    assert.equal(w.length, 2)
    assert.deepEqual([w[0].date, w[0].open, w[0].high, w[0].low, w[0].close, w[0].volume], ['2026-10-19', 10, 13.5, 9.5, 13, 5e6])
    assert.deepEqual([w[1].date, w[1].close], ['2026-10-26', 12])
})
