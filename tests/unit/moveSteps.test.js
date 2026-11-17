import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runOf, zigzag, fiveWaves, abcPullback, volumeProfile, stepFact, STEPS, STEP_WORDS } from '../../services/moveSteps.engine.js'
import { movesProfile } from '../../services/behaviourProfile.engine.js'
import { stepsWords, rowProfile, formatProfile } from '../../services/tools/behaviourProfile.tools.js'

// M. What sits at every step of a move (docs/design/proteus.md §10.11, Roy 2026-11-17).

const DAY = 86_400
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }
function walk(n, seed = 7) {
    const rnd = rng(seed)
    let p = 100
    return Array.from({ length: n }, (_, i) => {
        const o = p
        p = Math.max(1, p * (1 + (rnd() - 0.495) * 0.04))
        return { timestamp: 1451916000 + i * DAY, open: o, high: Math.max(o, p) * (1 + rnd() * 0.01), low: Math.min(o, p) * (1 - rnd() * 0.01), close: p, volume: 1e6 * (0.5 + rnd()) }
    })
}
const ATR_ATR = (c) => c.map(() => 1)   // closes in ATR units: an ATR of 1 everywhere

test('runOf: the top is the highest close of the 60 before, its run from the lowest of the 60 before that', () => {
    const c = Array.from({ length: 200 }, (_, i) => (i === 150 ? 50 : i === 100 ? 1 : 10))
    assert.deepEqual(runOf(c, 180), { h: 150, lo: 100 })
    assert.equal(runOf(c, 100), null)            // no room for a top and a run
})

test('zigzag / Elliott: five legs keeping the rules count; a wave 4 into wave 1, or three legs, do not; an A-B-C pullback', () => {
    const path = (pts) => pts.flatMap((v, i) => (i ? Array.from({ length: 5 }, (_, k) => pts[i - 1] + (v - pts[i - 1]) * (k + 1) / 5) : [v]))
    const five = path([0, 4, 2, 9, 6, 12])
    assert.deepEqual(zigzag(five, ATR_ATR(five), 0, five.length - 1, 1).map(i => five[i]), [0, 4, 2, 9, 6, 12])
    assert.equal(fiveWaves(five, ATR_ATR(five), 0, five.length - 1), true)
    const overlap = path([0, 4, 2, 9, 3.5, 12])             // wave 4 (3.5) under wave 1's top (4)
    assert.equal(fiveWaves(overlap, ATR_ATR(overlap), 0, overlap.length - 1), false)
    const short3 = path([0, 6, 3, 5, 4, 12])                // wave 3 the shortest
    assert.equal(fiveWaves(short3, ATR_ATR(short3), 0, short3.length - 1), false)
    const three = path([0, 6, 3, 10])
    assert.equal(fiveWaves(three, ATR_ATR(three), 0, three.length - 1), false)
    const abc = path([10, 6, 8, 3.5])                       // A 4, B to 8, C 4.5 past A's end
    assert.equal(abcPullback(abc, ATR_ATR(abc), 0, abc.length - 1), true)
    const shallowC = path([10, 6, 8, 7])                    // C not past A's end
    assert.equal(abcPullback(shallowC, ATR_ATR(shallowC), 0, shallowC.length - 1), false)
    const longC = path([10, 9, 9.8, 1])                     // C 8.8 ≫ 1.618 × A
    assert.equal(abcPullback(longC, ATR_ATR(longC), 0, longC.length - 1), false)
})

test('volumeProfile: the POC at the busiest price, the value area around it; null without volume', () => {
    const bars = Array.from({ length: 130 }, (_, i) => {
        const busy = i % 2 === 0
        const mid = busy ? 50 : 40 + (i % 20)
        return { high: mid + 0.5, low: mid - 0.5, volume: busy ? 10_000 : 100 }
    })
    const vp = volumeProfile(bars, 125)
    assert.ok(Math.abs(vp.poc - 50) < 1, `POC ${vp.poc}`)   // the busy bars span 49.5–50.5
    assert.ok(vp.val <= 50 && vp.vah >= 50)
    assert.ok(vp.level(50) > STEPS.hvn && vp.level(42) < STEPS.lvn)
    assert.equal(volumeProfile(bars.map(b => ({ ...b, volume: 0 })), 125), null)
    assert.equal(volumeProfile(bars, 30), null)          // too few bars before
})

test('stepsProfile: a random walk — nothing stands out; every fact stored compact, on every step', () => {
    const m = movesProfile(walk(2500, 11), 'day')
    assert.ok(m.steps.moves >= STEPS.minMoves && m.steps.other_lows > 0 && m.steps.shuffled_moves > 0)
    for (const [step, words] of Object.entries(STEP_WORDS)) {
        for (const k of Object.keys(words)) {
            const f = stepFact(m.steps[step][k])
            assert.ok(f && Array.isArray(m.steps[step][k]), `${step}.${k}`)
            assert.notEqual(f.verdict, 'stands_out', `${step}.${k} stood out on a random walk`)
        }
    }
    assert.equal(movesProfile(walk(200), 'day'), null)
})

test('stepsProfile: a planted trait IS found — every rally starts at a hammer', () => {
    // Bar by bar from the last close, GAPPING at the open as stocks do (opening every bar at the last close makes any up
    // bar after a red one a "bullish engulfing" — on half its lows). Every 50 bars: a hammer at the lowest close around
    // (a long lower wick, a small body near the high), then ten up bars (+1.5% each, ~5 ATR).
    const rnd = rng(23), bars = []
    let p = 100, rally = 0
    for (let i = 0; i < 2500; i++) {
        const o = p * (1 + (rnd() - 0.5) * 0.012)
        let c, hi, lo
        if (i >= 150 && i % 50 === 0 && i < 2485) { c = p * 0.97; hi = Math.max(o, c) * 1.001; lo = c * 0.97; rally = 10; bars.push({ open: c * 0.998, close: c, high: c * 1.001, low: lo }) }
        else if (rally > 0) { rally--; c = p * 1.015; bars.push({ open: p, close: c, high: c * 1.003, low: p * 0.998 }) }
        else { c = Math.max(1, p * (1 + (rnd() - 0.495) * 0.04)); hi = Math.max(o, c) * (1 + rnd() * 0.01); lo = Math.min(o, c) * (1 - rnd() * 0.01); bars.push({ open: o, close: c, high: hi, low: lo }) }
        Object.assign(bars.at(-1), { timestamp: 1451916000 + i * DAY, volume: 1e6 * (0.5 + rnd()) })
        p = c
    }
    const m = movesProfile(bars, 'day')
    const f = stepFact(m.steps.low.hammer)
    assert.ok(f.older > f.any_older && f.older > f.shuffled_older, JSON.stringify(f))
    assert.equal(f.verdict, 'stands_out', JSON.stringify(f))
    assert.match(stepsWords(m.steps), /Stands out: .*a hammer at the low/)
})

test('the words: nothing stands out names the count; the row shows each timeframe\'s steps; the tool text lists every fact', () => {
    const m = movesProfile(walk(2500, 11), 'day')
    assert.match(stepsWords(m.steps), /^\d+ moves: Nothing stands out — of \d+ patterns/)
    assert.match(stepsWords(m.steps, { full: true }), /No difference: .*a bullish order block \(first touch\) at the low/)
    assert.match(stepsWords({ ...m.steps, low: { ...m.steps.low, fib: [0.5, 0.5, 0.1, 0.1, 0.1, 0.1, 5, 5, 'thin'] } }), /^too few moves to say/)
    assert.equal(stepsWords(null), null)
    const tf = { bars: 300, from: '2020', to: '2026', atr_pct: 2, drift: { rate: 0.5 }, indicators: {}, false_breaks: { breaks: 0, after_sweep: {}, recent: {} }, order_blocks: { blocks: 0 } }
    const p = { symbol: 'ZZZ', timeframes: { day: tf, week: tf }, moves: { day: m, week: null }, computed_at: '2026-11-17', suitability: { day_trade: { fits: false, why: 'x', edges: [] }, swing: { fits: true, why: 'y', edges: [] } } }
    assert.ok(rowProfile(p, 'swing').lines.some(([k, v]) => k === 'Daily at the steps' && /Nothing stands out/.test(v)))
    assert.match(formatProfile(p), /AT THE STEPS OF ITS MOVES[\s\S]*DAILY: \d+ moves: Nothing stands out/)
})
