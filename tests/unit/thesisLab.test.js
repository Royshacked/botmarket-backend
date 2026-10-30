import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mirror, atr, swings, reversalSignals, controlSignals, baselineSignals, plan, play, inR, summarize, DEFAULTS } from '../../services/thesisLab.service.js'

// The THESIS lens's test 1 (Roy, 2026-10-30) — the reversal thesis as fixed rules (docs/design/stock-playbook.md §Test 1).

/** Bars from closes: each `{ open, high, low, close }`, the range ±`w` around the close unless given. */
const bar = (c, { o = c, h = c + 0.5, l = c - 0.5 } = {}) => ({ open: o, high: h, low: l, close: c })
const flat = (n, c = 100) => Array.from({ length: n }, () => bar(c))

test('atr: the mean true range of the last n sessions, null before', () => {
    const rows = [bar(10, { h: 11, l: 9 }), bar(10, { h: 12, l: 10 }), bar(10, { h: 10.5, l: 7 })]
    const a = atr(rows, 2)
    assert.equal(a[0], null)
    assert.equal(a[1], (2 + 2) / 2)
    assert.equal(a[2], (2 + 3.5) / 2, 'the true range reaches back to the previous close')
})

test('mirror: prices negated, high and low swapped — a short read as a long', () => {
    assert.deepEqual(mirror([{ open: 10, high: 12, low: 9, close: 11, x: 1 }]), [{ open: -10, high: -9, low: -12, close: -11, x: 1 }])
})

test('swings: a low is known only on the bar that rises k × ATR off it — never on its own bar', () => {
    // 20 flat bars (ATR 1), a dip to 95 at bar 22, then up: confirmed on the first bar whose high is ≥ 95 + 1.5.
    const rows = [...flat(20), bar(98), bar(96), bar(95.5, { l: 95 }), bar(96, { h: 96.4 }), bar(97, { h: 97.6 }), bar(99)]
    const pv = swings(rows, atr(rows, 20), 1.5)
    const low = pv.find(p => p.type === 'L' && p.price === 95)
    assert.ok(low, 'the dip is a swing low')
    assert.equal(low.j, 22)
    assert.equal(low.at, 24, 'bar 23 rose only 1.4 off it; bar 24 rose 2.6')
    for (const p of pv) assert.ok(p.at > p.j, 'a swing is never confirmed on its own bar')
})

test('swings: the next swing starts after the swing bar — no flip on one wide bar', () => {
    const rows = [...flat(20), bar(100, { h: 104, l: 90 }), bar(95), bar(97), bar(99), bar(101)]
    const pv = swings(rows, atr(rows, 20), 1.5)
    const keys = pv.map(p => `${p.type}${p.j}`)
    assert.equal(new Set(keys).size, keys.length, 'each swing once')
})

/** A V: flat at 100, a fast fall to 80, a bounce to 86 (AR), a dip to 83, a close over the AR. */
function vShape() {
    const fall = [98, 95, 92, 89, 86, 83, 81].map(c => bar(c))
    const climax = bar(80.5, { l: 80, h: 81 })
    const up = [82, 84, 86].map(c => bar(c)), ar = bar(86, { h: 86.6 })
    const back = [85, 84, 83.6].map(c => bar(c)), test = bar(83.5, { l: 83 })
    const sos = [84.5, 86, 87.5].map(c => bar(c))
    return [...flat(105), ...fall, climax, ...up, ar, ...back, test, ...sos]
}

test('reversalSignals: the fall, the climax low, the AR, then the first close over it', () => {
    const rows = vShape(), a = atr(rows), pv = swings(rows, a, 1.5)
    const sigs = reversalSignals(rows, a, pv)
    assert.equal(sigs.length, 1, 'one signal per climax low')
    const [s] = sigs
    assert.equal(s.low, 80)
    assert.equal(s.ar, 86.6)
    assert.ok(rows[s.i].close > 86.6 && rows[s.i - 1].close <= 86.6, 'the first close over the AR')
    assert.equal(s.stopBase, 83, 'the last sellers’ swing, not the climax')
    assert.equal(s.h0, 100.5, 'the start of the fall')
})

test('reversalSignals: a slow drift is not a fall — no signal', () => {
    const rows = [...flat(105), ...Array.from({ length: 40 }, (_, i) => bar(100 - i * 0.1)), ...[97, 98, 97, 99, 100].map(c => bar(c))]
    const a = atr(rows)
    assert.equal(reversalSignals(rows, a, swings(rows, a, 1.5)).length, 0)
})

test('plan: the stop under the base by the buffer, the target, the entry level at the R:R; rule A refuses a wide stop', () => {
    const atrs = [2]
    const p = plan({ i: 0, stopBase: 90, h0: 110 }, atrs, { ...DEFAULTS, buffer: 0.5, rr: 1.5 })
    assert.equal(p.S, 89)
    assert.equal(p.T, 110)
    assert.ok(Math.abs((p.T - p.E) / (p.E - p.S) - 1.5) < 1e-9, 'R:R 1.5 at E')
    assert.equal(plan({ i: 0, stopBase: 60, h0: 110 }, atrs), null, 'a 15%+ risk is past rule A')
})

test('plan by the risk limit: the entry level is the price the limit above the stop; the R:R only a check', () => {
    const o = { ...DEFAULTS, buffer: 0, entryBy: 'risk', riskPct: 5, minRR: 1.5 }
    const p = plan({ i: 0, stopBase: 95, h0: 120 }, [1], o)
    assert.equal(p.E, 100, '95 / 0.95 — the stop 5% under the entry')
    assert.equal(plan({ i: 0, stopBase: 95, h0: 106 }, [1], o), null, 'R:R 1.2 at the level — under the check')
    assert.ok(plan({ i: 0, stopBase: 95, h0: 106 }, [1], { ...o, minRR: 0 }), 'no check → a plan')
    const short = plan({ i: 0, stopBase: -105, h0: -80 }, [1], o)
    assert.ok(Math.abs((short.E - short.S) / Math.abs(short.E) - 0.05) < 1e-12, 'the mirrored short: the same 5% of its entry')
})

test('plan with stopAt low60: the stop under the whole down move’s low, never above the last swing low', () => {
    const o = { ...DEFAULTS, buffer: 0, stopAt: 'low60' }
    assert.equal(plan({ i: 0, stopBase: 95, low60: 90, h0: 110 }, [1], o).S, 90)
    assert.equal(plan({ i: 0, stopBase: 95, low60: 97, h0: 110 }, [1], o).S, 95, 'the lower of the two')
    assert.equal(plan({ i: 0, stopBase: 95, low60: 90, h0: 110 }, [1], { ...o, stopAt: undefined }).S, 95)
})

const P = { S: 90, T: 115, E: 100 }

test('play: already under the level at the signal — in at its close; out at the target', () => {
    const rows = [bar(99), bar(105), bar(112, { h: 115.5 })]
    assert.deepEqual(play(rows, 0, P), { m: 0, entry: 99, k: 2, exit: 115, reason: 'target' })
})

test('play: a signal closing at or under the stop is no trade; a touch-entry gapping under the stop neither', () => {
    assert.equal(play([bar(89.5), bar(99)], 0, P), null)
    assert.equal(play([bar(104), bar(88, { o: 89 })], 0, P, { ...DEFAULTS, strength: false }), null)
})

test('play: a touch of the stop zone before strength cancels the plan', () => {
    const rows = [bar(104), bar(95, { l: 89.5 }), bar(99, { o: 97, l: 96 })]
    assert.equal(play(rows, 0, P), null)
})

test('play: strength at the level — up on its open, the upper half, within the drift — in at its close', () => {
    const weak = bar(99, { o: 101, l: 98 })                 // touched E, closed down — no
    const strong = bar(100.5, { o: 99, h: 101, l: 98.5 })   // up, upper half, 100.5 ≤ 100 + 0.1 × 10
    const rows = [bar(104), weak, strong, bar(103), bar(90, { o: 95, l: 89 })]
    assert.deepEqual(play(rows, 0, P), { m: 2, entry: 100.5, k: 4, exit: 90, reason: 'stop' })
})

test('play: a gap through the stop fills at the open; a session touching both is the stop', () => {
    const gap = play([bar(99), bar(85, { o: 86, h: 87, l: 84 })], 0, P)
    assert.deepEqual([gap.exit, gap.reason], [86, 'stop'])
    const both = play([bar(99), bar(100, { h: 116, l: 89 })], 0, P)
    assert.deepEqual([both.exit, both.reason], [90, 'stop'])
})

test('play: without the strength check — in at the level on the first touch, the stop on that same session counts', () => {
    const rows = [bar(104), bar(95, { o: 101, h: 101, l: 89 })]
    assert.deepEqual(play(rows, 0, P, { ...DEFAULTS, strength: false }), { m: 1, entry: 100, k: 1, exit: 90, reason: 'stop' })
})

test('play: past the wait with no entry → null; held to maxHold → out at the close', () => {
    assert.equal(play([bar(104), ...Array.from({ length: 25 }, () => bar(104))], 0, P), null)
    const t = play([bar(99), bar(100), bar(101)], 0, P, { ...DEFAULTS, maxHold: 2 })
    assert.deepEqual([t.k, t.exit, t.reason], [2, 101, 'time'])
})

test('inR: the move over the risk, less the round-trip cost in R; the mirrored short gives the same R', () => {
    assert.equal(inR({ entry: 100, exit: 115 }, 90, 0), 1.5)
    assert.equal(inR({ entry: 100, exit: 90 }, 90, 0.5), -1.05)
    assert.equal(inR({ entry: -100, exit: -85 }, -110, 0), 1.5, 'short at 100, stop 110, covered at 85')
    assert.equal(inR({ entry: 95, exit: 115 }, 90, 0, 100), 2, 'the planned risk (E − S = 10), not the 5 actually taken')
})

test('summarize: hit rate, mean R, and a bootstrap range over months that holds the mean', () => {
    const trades = [...Array.from({ length: 6 }, (_, i) => ({ r: 1.5, win: true, days: 10, month: `2024-0${(i % 3) + 1}` })),
        ...Array.from({ length: 4 }, (_, i) => ({ r: -1, win: false, days: 4, month: `2024-0${(i % 3) + 4}` }))]
    const s = summarize(trades, { draws: 500 })
    assert.equal(s.n, 10)
    assert.equal(s.hit, 0.6)
    assert.equal(s.meanR, 0.5)
    assert.ok(s.lo <= s.meanR && s.meanR <= s.hi)
    assert.equal(summarize([]).n, 0)
})

test('controlSignals: a break up after sellers had control is a reversal; the next break up, a continuation', () => {
    // An earlier dip (a swing low the fall closes under — sellers take over), the V's rally and break (reversal), a
    // pullback that holds, a new break up.
    const dip = [...flat(60), ...[98, 96, 95, 96, 98, 100].map(c => bar(c)), ...flat(39)]
    const rows = [...dip, ...vShape().slice(105), ...[89, 90].map(c => bar(c)), ...[88.5, 87.5, 87.6].map(c => bar(c)), ...[89, 90.5, 92, 93].map(c => bar(c))]
    const a = atr(rows), sigs = controlSignals(rows, a, swings(rows, a, 1.5))
    const ctx = sigs.map(s => s.context)
    assert.ok(ctx.includes('reversal'), 'the V')
    assert.ok(ctx.includes('continuation'), 'the break after the pullback')
    for (const s of sigs) {
        assert.ok(s.stopBase < rows[s.i].close, 'the stop under the close')
        assert.ok(s.h0 > s.stopBase)
    }
    const rev = sigs.find(s => s.context === 'reversal')
    assert.equal(rev.h0, 100.5, 'the top of the fall')
})

test('controlSignals: a close over the 120-session high is a breakout, its target the measured move', () => {
    const rows = [...flat(125), ...[101, 102, 103, 102, 101.2, 100.6, 101, 102, 103.5, 105].map(c => bar(c))]
    const a = atr(rows), sigs = controlSignals(rows, a, swings(rows, a, 1.5))
    const b = sigs.find(s => s.context === 'breakout')
    assert.ok(b, 'a breakout')
    let top = -Infinity
    for (let j = b.i - 40; j < b.i; j++) top = Math.max(top, rows[j].high)
    assert.equal(b.h0, top + (top - b.stopBase))
})

test('baselineSignals: every 10th session with the close between the last swing low and the 40-session high', () => {
    const rows = vShape(), a = atr(rows)
    const sigs = baselineSignals(rows, a, swings(rows, a, 1.5))
    assert.ok(sigs.length > 0)
    for (const s of sigs) { assert.equal(s.i % 10, 0); assert.ok(s.stopBase < rows[s.i].close && s.h0 > rows[s.i].close) }
})
