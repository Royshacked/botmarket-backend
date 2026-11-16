import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge, wyckoffTest, fibPullbackTest, falseBreaks, driftOutcomes, shuffledBars, seededRandom, PROFILE } from '../../services/behaviourProfile.engine.js'
import { stopHits, anchors, ANCHORS } from '../../scripts/lab-proteus-stops.mjs'
import { combos, TESTS } from '../../scripts/lab-proteus-combos.mjs'
import { weakest, atrsOf } from '../../scripts/lab-proteus.shared.mjs'

// The Proteus labs (docs/design/proteus.md §10.2 ten combinations, §10.3 lines as stops). The engine's judge decides;
// these check what the labs feed it.

const bar = (close, { open = close, high = close + 0.5, low = close - 0.5, t = 0 } = {}) => ({ open, high, low, close, volume: 1000, timestamp: t })

function randomWalk(n, seed, start = 100) {
    let s = seed >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    const out = []
    let p = start
    for (let i = 0; i < n; i++) {
        const o = p
        p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04))
        const hi = Math.max(o, p) * (1 + rnd() * 0.01), lo = Math.min(o, p) * (1 - rnd() * 0.01)
        out.push({ open: o, high: hi, low: lo, close: p, volume: 1e6 * (0.5 + rnd()), timestamp: 1_600_000_000 + i * 86_400 })
    }
    return out
}

const opts = { ...PROFILE, horizon: 3 }
const flat = (n, L) => new Array(n).fill(L)

test('a stop hit: the close before over the line, this low under line − 0.2 ATR; good = 1 ATR more before a close back over', () => {
    const atrs = new Array(8).fill(1)
    // Line at 100, ATR 1: the stop is 99.8, "for real" is 98.8.
    const good = [bar(101), bar(101), bar(99.5, { low: 99.5 }), bar(98.9, { low: 98.7 }), bar(98), bar(98), bar(98), bar(98)]
    assert.deepEqual(stopHits(good, atrs, flat(8, 100), opts), [{ i: 2, out: 'win' }])
    // Swept and closed back over the line on the hit bar itself: a whipsaw, checked first.
    const swept = [bar(101), bar(101), bar(100.5, { low: 98.5 }), bar(101), bar(101), bar(101), bar(101), bar(101)]
    assert.deepEqual(stopHits(swept, atrs, flat(8, 100), opts), [{ i: 2, out: 'loss' }])
    // Dipped under the line but not to the stop: no hit.
    const nearMiss = [bar(101), bar(101), bar(100, { low: 99.9 }), bar(101), bar(101), bar(101), bar(101), bar(101)]
    assert.deepEqual(stopHits(nearMiss, atrs, flat(8, 100), opts), [])
    // Below the line already (the close before under it): not a stop being hit.
    const under = [bar(99), bar(99), bar(98, { low: 97 }), bar(98), bar(98), bar(98), bar(98), bar(98)]
    assert.deepEqual(stopHits(under, atrs, flat(8, 100), opts), [])
    // The bars run out before the window: not counted.
    assert.deepEqual(stopHits(good.slice(0, 4), atrs, flat(4, 100), opts), [])
})

test('the anchor is the one known BEFORE the bar: a line that jumps on the hit bar is not used', () => {
    const atrs = new Array(8).fill(1)
    const b = [bar(101), bar(101), bar(99.5, { low: 99.5 }), bar(98.9, { low: 98.7 }), bar(98), bar(98), bar(98), bar(98)]
    const anc = [100, 100, 90, 90, 90, 90, 90, 90]   // the bar-2 value (90) must not decide bar 2
    assert.deepEqual(stopHits(b, atrs, anc, opts), [{ i: 2, out: 'win' }])
})

test('the weakest verdict counts: a combination must beat every baseline', () => {
    assert.equal(weakest(['respects', 'respects', 'respects']), 'respects')
    assert.equal(weakest(['respects', 'no', 'respects']), 'no')
    assert.equal(weakest(['respects', 'faded', 'thin']), 'thin')
    assert.equal(weakest(['unconfirmed', 'respects']), 'unconfirmed')
})

test('the engine hands the labs its ranges, springs, pullbacks and sweep break bars — and stores none of them', () => {
    const b = randomWalk(1500, 11)
    const atrs = atrsOf(b), cut = 1000, drift = driftOutcomes(b, atrs)
    const fb = falseBreaks(b, atrs, cut, drift)
    const wy = wyckoffTest(b, atrs, cut, drift, fb.sweeps)
    const fib = fibPullbackTest(b, atrs, cut)
    assert.ok(wy.range_list.length > 0 && wy.range_list.every(r => r.known <= r.until && r.low <= r.high))
    assert.ok(wy.spring_events.every(s => typeof s.light === 'boolean' && s.dip <= s.i))
    assert.ok(fib.pullbacks.length > 0 && fib.pullbacks.every(p => p.start <= p.end && p.low < p.high))
    assert.ok(fb.sweeps.every(s => Number.isInteger(s.at) && s.at <= s.i))
    for (const k of ['range_list', 'spring_events']) assert.ok(!(k in JSON.parse(JSON.stringify(wy))))
    assert.ok(!('pullbacks' in JSON.parse(JSON.stringify(fib))))
})

test('the shuffle the labs use is the engine\'s own: same seed → same bars; the moves kept, the order gone', () => {
    const b = randomWalk(400, 5)
    const a1 = shuffledBars(b, seededRandom(42)), a2 = shuffledBars(b, seededRandom(42))
    assert.deepEqual(a1, a2)
    assert.equal(a1.length, b.length)
    assert.notDeepEqual(a1.map(x => x.close), b.map(x => x.close))
})

test('every anchor is built, each level only where it exists; VWAP only intraday', () => {
    const b = randomWalk(1200, 21)
    const { levels } = anchors(b)
    for (const t of ANCHORS.filter(x => !x.intradayOnly)) assert.equal(levels[t.key].length, b.length, t.key)
    assert.ok(!('vwap' in levels))
    assert.ok(levels.swing.some(Number.isFinite) && levels.range.some(Number.isFinite) && levels.fib618.some(Number.isFinite))
    assert.equal(levels.sma200[150], null, 'no 200 SMA before 200 bars')
    // The OB anchor sits under the close wherever it is set.
    assert.ok(levels.ob.every((v, i) => v == null || v < b[i].close))
})

test('on random walks the labs flag almost nothing — the noise control works the same way (z 3)', () => {
    let flagged = 0, tests = 0
    for (let k = 0; k < 6; k++) {
        const b = randomWalk(1100, 901 + k)
        const { out, drift, cut } = combos(b)
        for (const t of TESTS) {
            const g = out[t.key]
            tests++
            if (weakest([judge(g.event, g.A, cut).verdict, judge(g.event, g.B, cut).verdict, judge(g.event, drift, cut).verdict]) === 'respects') flagged++
        }
        const { levels, atrs, cut: c2, atrPct } = anchors(b)
        for (const t of ANCHORS.filter(x => !x.intradayOnly)) {
            const lv = levels[t.key]
            const base = PROFILE.shifts.flatMap(s => stopHits(b, atrs, lv.map(v => (Number.isFinite(v) ? v * (1 + s * atrPct / 100) : null))))
            tests++
            if (judge(stopHits(b, atrs, lv), base, c2).verdict === 'respects') flagged++
        }
    }
    assert.ok(flagged <= 2, `${flagged} of ${tests} flagged on noise`)
    // …and the shuffle runs through the same pipeline without breaking.
    assert.ok(combos(shuffledBars(randomWalk(600, 3), seededRandom(1))).out.c1)
})
