import { test } from 'node:test'
import assert from 'node:assert/strict'

import { swings, detectFVG, detectLiquidity, detectStructure, premiumDiscount, detectOrderBlocks, priorLevels } from '../../services/smc.engine.js'
import { smcReadText } from '../../services/smc.tools.js'
import { _smcTools, _handleAssessToolUses } from '../../monitoring/hermes.assess.js'

// K2: the deterministic SMC engine (KAIROS_MODES.md). Pure OHLCV → exact monitorable levels.
const mk = (o, h, l, c, t = 0) => ({ open: o, high: h, low: l, close: c, volume: 100, timestamp: t })

// A clean uptrend zig-zag (lookback 1): swing highs at i1(12) i3(14), swing lows at i2(6) i4(8),
// last bar closes 15 (breaks above prior swing high 12).
const UPTREND = [
    mk(9, 10, 8, 9, 1),
    mk(9, 12, 9, 11, 2),   // i1 swing high 12
    mk(10, 9, 6, 7, 3),    // i2 swing low 6
    mk(10, 14, 10, 13, 4), // i3 swing high 14  (HH)
    mk(12, 11, 8, 9, 5),   // i4 swing low 8    (HL)
    mk(13, 16, 13, 15, 6), // i5 last — closes 15
]

test('swings: fractal finds the swing highs and lows', () => {
    const sw = swings(UPTREND, 1)
    const highs = sw.filter(s => s.type === 'high').map(s => s.price)
    const lows  = sw.filter(s => s.type === 'low').map(s => s.price)
    assert.deepEqual(highs, [12, 14])
    assert.deepEqual(lows, [6, 8])
})

test('detectStructure: HH+HL → uptrend, close above the LAST swing high → BOS up', () => {
    const s = detectStructure(UPTREND, { lookback: 1 })
    assert.equal(s.trend, 'up')
    assert.equal(s.lastSwingHigh, 14)
    assert.equal(s.lastSwingLow, 8)
    assert.equal(s.event.type, 'BOS')       // with the trend
    assert.equal(s.event.direction, 'up')
    assert.equal(s.event.level, 14)         // broke the most-recent swing high
})

test('detectStructure: uptrend that closes below the last swing low → CHoCH down', () => {
    // last swing low = 6 (i4); the break bar (i7) is NOT adjacent to it, so the swing survives.
    const bars = [
        mk(7, 8, 6, 7, 1), mk(9, 11, 7, 10, 2), mk(8, 7, 4, 5, 3),   // i2 swing low 4
        mk(9, 13, 8, 12, 4), mk(8, 9, 6, 7, 5),                       // i3 high 13, i4 swing low 6 (HL)
        mk(11, 15, 10, 14, 6), mk(12, 11, 8, 9, 7),                   // i5 high 15 (HH)
        mk(9, 13, 5, 5, 8),                                           // i7 last — closes 5, below last low 6
    ]
    const s = detectStructure(bars, { lookback: 1 })
    assert.equal(s.trend, 'up')
    assert.equal(s.event.type, 'CHoCH')     // against the trend
    assert.equal(s.event.direction, 'down')
    assert.equal(s.event.level, 6)
})

test('premiumDiscount: price above equilibrium → premium', () => {
    const pd = premiumDiscount(UPTREND, { lookback: 1 })
    assert.equal(pd.high, 14)
    assert.equal(pd.low, 8)
    assert.equal(pd.equilibrium, 11)
    assert.equal(pd.zone, 'premium')        // last close 15 > 11
})

test('detectFVG: bullish gap (low[i+1] > high[i-1]); mitigated when price returns into it', () => {
    const clean = [mk(9, 10, 8, 9, 1), mk(9, 14, 11, 13, 2), mk(12, 16, 12, 15, 3)]
    const [g] = detectFVG(clean)
    assert.equal(g.type, 'bullish')
    assert.equal(g.bottom, 10)   // prev.high
    assert.equal(g.top, 12)      // next.low
    assert.equal(g.mitigated, false)

    const filled = [...clean, mk(13, 13, 9, 10, 4)]   // dips to 9, back into [10,12]
    assert.equal(detectFVG(filled)[0].mitigated, true)
})

test('detectFVG: bearish gap (high[i+1] < low[i-1])', () => {
    const bars = [mk(9, 10, 8, 9, 1), mk(8, 6, 4, 5, 2), mk(6, 7, 5, 6, 3)]
    const [g] = detectFVG(bars)
    assert.equal(g.type, 'bearish')
    assert.equal(g.top, 8)       // prev.low
    assert.equal(g.bottom, 7)    // next.high
})

test('detectOrderBlocks: last bearish candle before a bullish FVG → bullish OB', () => {
    const bars = [mk(10, 10, 8, 8, 1), mk(9, 14, 11, 13, 2), mk(12, 16, 12, 15, 3)]   // i0 bearish, i1 impulse
    const [ob] = detectOrderBlocks(bars)
    assert.equal(ob.type, 'bullish')
    assert.equal(ob.top, 10)      // the origin candle's range
    assert.equal(ob.bottom, 8)
    assert.equal(ob.mitigated, false)
})

test('priorLevels: prior-day vs current-day high/low by UTC date', () => {
    const D1 = 1609459200, D2 = 1609545600   // 2021-01-01, 2021-01-02 (UTC)
    const bars = [
        mk(9, 10, 8, 9, D1), mk(9, 12, 7, 11, D1 + 3600),        // prior day: H12 L7
        mk(10, 15, 11, 13, D2), mk(12, 14, 12, 13, D2 + 3600),   // current day: H15 L11
    ]
    const lv = priorLevels(bars)
    assert.deepEqual(lv, { priorDayHigh: 12, priorDayLow: 7, currentDayHigh: 15, currentDayLow: 11 })
})

test('smcReadText: pure formatter renders each SMC read from bars (the wiring)', () => {
    assert.match(smcReadText('get_structure', 'AAPL', '5min', UPTREND), /AAPL 5min — structure:[\s\S]*trend:[\s\S]*premium\/discount:/)
    assert.match(smcReadText('get_liquidity', 'AAPL', '5min', UPTREND), /liquidity pools:/)
    assert.match(smcReadText('get_key_levels', 'AAPL', '5min', UPTREND), /key levels:[\s\S]*prior-day:/)
})

test('Hermes shares the SMC engine: _smcTools + dispatch (smc calls, no network)', async () => {
    assert.deepEqual(_smcTools(['5min']).map(t => t.name), ['get_structure', 'get_fvg', 'get_liquidity'])
    const content = [{ type: 'tool_use', id: 'x', name: 'get_structure', input: { timeframe: '5min' } }]
    const res = await _handleAssessToolUses({ asset: 'AAPL', mode: 'smc' }, content, ['5min'], { smcBars: async () => UPTREND })
    assert.match(String(res[0].content), /AAPL 5min — structure:/)   // same engine the call was built on
})

test('detectLiquidity: two near-equal swing highs → a buy-side pool', () => {
    const bars = [mk(9, 10, 8, 9, 1), mk(9, 13, 9, 11, 2), mk(10, 9, 6, 7, 3), mk(10, 13, 7, 11, 4), mk(11, 8, 5, 6, 5)]
    const liq = detectLiquidity(bars, { lookback: 1, tolPct: 0.01 })
    assert.equal(liq.buyside.length, 1)
    assert.equal(liq.buyside[0].count, 2)
    assert.ok(Math.abs(liq.buyside[0].price - 13) < 0.01)
})
