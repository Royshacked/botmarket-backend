import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveBars, moveStarts, facts, count, FACT_WORDS, MOVE } from '../../scripts/lab-proteus-moves.mjs'

// proteus.md §10.5: find the moves, then what was true on the bar each began.

const bar = (i, c, { h = c * 1.005, l = c * 0.995, o = c, v = 1e6 } = {}) => ({ timestamp: 1_600_000_000 + i * 86_400, open: o, high: h, low: l, close: c, volume: v })

test('moveBars: +4 ATR on a high before a close 1 ATR under → true; the stop first → false; no room ahead → null', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100))
    const atrs = bars.map(() => 1)
    bars[3] = bar(3, 100, { h: 104.5 })
    let f = moveBars(bars, atrs)
    assert.equal(f[0], true)
    assert.equal(f[29], null)
    bars[2] = bar(2, 98.5)   // a close 1.5 ATR under bar 0's close, before the high
    f = moveBars(bars, atrs)
    assert.equal(f[0], false)
})

test('moveStarts: qualifying bars within 20 of each other are one move, starting at the lowest close', () => {
    const bars = Array.from({ length: 80 }, (_, i) => bar(i, 100 - (i === 5 ? 2 : 0)))
    const flags = bars.map((_, i) => [3, 5, 8, 60].includes(i) ? true : false)
    assert.deepEqual(moveStarts(bars, flags), [5, 60])
})

test('facts: null in the warm-up, every declared fact on a later bar; SPY facts null without SPY', () => {
    const bars = Array.from({ length: 260 }, (_, i) => bar(i, 100 + Math.sin(i / 7) * 5))
    const f = facts(bars, bars.map(() => 1))
    assert.equal(f[100], null)
    assert.deepEqual(Object.keys(f[250]).sort(), Object.keys(FACT_WORDS).sort())
    assert.equal(f[250].spy_over_200, null)
})

test('count: splits older / recent and counts the starts on each side', () => {
    let s = 7
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    let p = 100
    const bars = Array.from({ length: 900 }, (_, i) => { const o = p; p *= 1 + (rnd() - 0.5) * 0.05; return bar(i, p, { o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99 }) })
    const { res, starts, cut } = count(bars)
    assert.equal(cut, Math.floor(900 * (1 - MOVE.recentShare)))
    assert.ok(starts.length > 0)
    assert.ok(res.older._starts.every(i => i < cut) && res.recent._starts.every(i => i >= cut))
    const r = res.older.over_200
    assert.ok(r.atStarts <= r.starts && r.onBars <= r.bars && r.fwdWith <= r.nWith)
})

import { windows, gate } from '../../scripts/lab-proteus-moves-event.mjs'

// proteus.md §10.6: the windows around a report, and the pullback gate.
test('windows: the 20 bars before a report are BEFORE (its own bar left out), it and the 19 after are AFTER', () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({ timestamp: Date.parse('2026-01-01T00:00:00Z') / 1000 + i * 86_400 }))
    const { where, report } = windows(bars, ['2026-01-31'])   // bar 30
    assert.equal(where[9], null)
    assert.equal(where[10], 'before')
    assert.equal(where[29], 'before')
    assert.equal(where[30], 'after')
    assert.equal(where[49], 'after')
    assert.equal(where[50], null)
    assert.equal(report[10], 0)
})

test('gate: any one of the three pullback facts opens it; none, or no facts, keeps it shut', () => {
    assert.equal(gate({ down_3_plus: false, deep_pullback: true, new_60_low: false }), true)
    assert.equal(gate({ down_3_plus: false, deep_pullback: false, new_60_low: false }), false)
    assert.equal(gate(null), false)
})

import { chainAt } from '../../scripts/lab-proteus-moves-chain.mjs'

// proteus.md §10.7: links 2 and 3 of one move.
test('chainAt: the pullback from the 60-bar high, and a breakout over the prior 60-bar high that closed back under it', () => {
    const closes = Array.from({ length: 400 }, () => 100)
    closes[340] = 110                                  // the high: over every prior close → a breakout
    closes[341] = 99                                   // back under the prior 60-bar high next bar → failed
    for (let i = 342; i <= 380; i++) closes[i] = 95    // the pullback; the move starts at 380
    const bars = closes.map((c, i) => ({ timestamp: 1_600_000_000 + i * 86_400, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1e6 }))
    const r = chainAt(bars, bars.map(() => 1), 380)
    assert.equal(r.high, 340)
    assert.equal(r.bars, 40)
    assert.ok(Math.abs(r.drop_pct - (95 / 110 - 1) * 100) < 1e-9)
    assert.equal(r.failed_breakout, true)
    assert.equal(r.hard_start, true)                   // 110 → 99 is an 11-ATR down day
    assert.equal(chainAt(bars, bars.map(() => 1), 100), null)   // too little history behind it
})

import { breakoutAt } from '../../scripts/lab-proteus-moves-chain.mjs'

test('breakoutAt: the first close over the prior 60-bar high in the 20 bars up to the high, and how far it got', () => {
    const closes = Array.from({ length: 400 }, () => 100)
    closes[200] = 105                                   // the old high (set 130 bars before the breakout)
    for (let i = 330; i <= 340; i++) closes[i] = 101 + (i - 330)   // first over 100 at 330 (the prior 60 bars are all 100)
    const bars = closes.map((c, i) => ({ timestamp: 1_600_000_000 + i * 86_400, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1e6 }))
    const k = breakoutAt(bars, bars.map(() => 1), 340)
    assert.equal(k.breakout, 330)
    assert.equal(k.reach_atr, 11)                       // best close 111 vs the old high 100
    assert.equal(breakoutAt(bars, bars.map(() => 1), 300), null)   // no close over the prior high in 280–300
})

import { summaryOf } from '../../scripts/lab-proteus-moves-chain.mjs'

test('summaryOf: the moves and the common facts per link, from a name\'s output', () => {
    const text = [
        'moves with 310 bars behind them: 26 of 31 · split 2023-06-26',
        '## What the moves share (common = on ≥ 67% of the moves, older AND recent)',
        '  a pullback of ≥ 2 ATR                  older  94% (of 18) · recent 100% (of 8)  ← common',
        '  a run of ≥ 3 ATR into the high         older  50% (of 18) · recent  50% (of 8)',
        '  a new 60-bar high that reversed        older  67% (of 18) · recent  75% (of 8)  ← common',
        '## Link 4 — what led to the breakout (the top a new 60-bar high; 18 moves)',
        '  over the 200 SMA                       older  92% (of 12) · recent 100% (of 6)  ← common',
    ].join('\n')
    assert.deepEqual(summaryOf(text), {
        moves: 26, link2: ['a pullback of ≥ 2 ATR (94/100%)'], link3: ['a new 60-bar high that reversed (67/75%)'],
        link4n: 18, link4: ['over the 200 SMA (92/100%)'],
    })
})

import { prepare, lowFacts, topFacts, breakoutFacts, WORDS } from '../../scripts/lab-proteus-moves-patterns.mjs'

test('the pattern facts: every declared fact on each link, true / false, and a double bottom found', () => {
    let s = 11
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    let p = 100
    const bars = Array.from({ length: 600 }, (_, i) => { const o = p; p *= 1 + (rnd() - 0.5) * 0.04; return { timestamp: 1_600_000_000 + i * 86_400, open: o, high: Math.max(o, p) * 1.005, low: Math.min(o, p) * 0.995, close: p, volume: 1e6 * (0.5 + rnd()) } })
    const d = prepare(bars)
    const lf = lowFacts(d, 500, 470), tf = topFacts(d, 470), bf = breakoutFacts(d, 460)
    assert.deepEqual(Object.keys(lf).filter(k => k !== 'depth').sort(), Object.keys(WORDS.low).sort())
    assert.deepEqual(Object.keys(tf).sort(), Object.keys(WORDS.top).sort())
    assert.deepEqual(Object.keys(bf).sort(), Object.keys(WORDS.breakout).sort())
    for (const v of [...Object.entries(lf).filter(([k]) => k !== 'depth'), ...Object.entries(tf), ...Object.entries(bf)].map(([, v]) => v)) assert.equal(typeof v, 'boolean')
    // A W: two lows 30 bars apart at the same price with a 3-ATR rise between → a double bottom on the second.
    const w = Array.from({ length: 300 }, (_, i) => ({ timestamp: 1_600_000_000 + i * 86_400, open: 100, high: 101, low: 99, close: 100, volume: 1e6 }))
    w[250] = { ...w[250], low: 95, close: 96 }; w[265] = { ...w[265], high: 110, close: 109 }; w[280] = { ...w[280], low: 95.2, close: 96 }
    const dw = prepare(w)
    assert.equal(lowFacts(dw, 280, 265).double_bottom, true)
})

import { setTight } from '../../scripts/lab-proteus-moves-patterns.mjs'

test('tight detectors fire on fewer bars than the loose ones (order blocks, double bottoms)', () => {
    let s = 23
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    let p = 100
    const bars = Array.from({ length: 700 }, (_, i) => { const o = p; p *= 1 + (rnd() - 0.5) * 0.04; return { timestamp: 1_600_000_000 + i * 86_400, open: o, high: Math.max(o, p) * 1.005, low: Math.min(o, p) * 0.995, close: p, volume: 1e6 } })
    const d = prepare(bars)
    const count = () => { let ob = 0, db = 0; for (let i = 400; i < 690; i += 3) { const f = lowFacts(d, i, i - 20); if (f.bull_ob) ob++; if (f.double_bottom) db++ } return { ob, db } }
    setTight(false); const loose = count()
    setTight(true); const tightC = count()
    setTight(false)
    assert.ok(tightC.ob < loose.ob, `order blocks ${tightC.ob} vs ${loose.ob}`)
    assert.ok(tightC.db < loose.db, `double bottoms ${tightC.db} vs ${loose.db}`)
})
