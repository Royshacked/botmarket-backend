import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    PROFILE, bracket, judge, levelTouches, levelTest, falseBreaks, driftOutcomes, eventOutcomes, sessionVwap,
    timeframeProfile, suitability, behaviourProfile, orderBlockTest,
} from '../../services/behaviourProfile.engine.js'

// Proteus's measured profile (docs/design/proteus.md §2): counted from candles, every rate against a baseline, the
// recent third must still hold. Long side only.

const bar = (close, { open = close, high = close + 0.5, low = close - 0.5, volume = 1000, t = 0 } = {}) =>
    ({ open, high, low, close, volume, timestamp: t })
const series = (closes, step = 86_400) => closes.map((c, i) => bar(c, { t: 1_700_000_000 + i * step }))

/** Seeded random walk — a stock that obeys nothing. */
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

test('the outcome: a high reaching the win level first is a win; a close under the loss level first is a loss', () => {
    const b = series([100, 100.5, 101, 102])
    assert.equal(bracket(b, 0, 101.4, 99, 3), 'win', 'the high of 101 + 0.5 reaches 101.4')
    assert.equal(bracket(series([100, 99, 98.4, 105]), 0, 104, 98.5, 3), 'loss', 'the close of 98.4 first')
    assert.equal(bracket(series([100, 100, 100, 100]), 0, 110, 90, 3), 'none')
    assert.equal(bracket(b, 1, 110, 90, 3), null, 'not enough bars left: not counted')
    // Inside one bar we cannot tell which came first: the loss wins (the conservative count).
    const both = [bar(100), bar(97, { high: 110, low: 96 })]
    assert.equal(bracket(both, 0, 105, 98, 1), 'loss')
})

const ev = (n, wins, from = 0) => Array.from({ length: n }, (_, k) => ({ i: from + k, out: k < wins ? 'win' : 'loss' }))

test('the verdict: found on the OLDER part alone, checked on the recent third it never saw', () => {
    const base = [...ev(60, 24, 0), ...ev(30, 12, 100)]            // 40% everywhere
    assert.equal(judge(ev(10, 9), base, 100).verdict, 'thin')
    assert.equal(judge(ev(40, 18), base, 100).verdict, 'no', '45% vs 40% is no edge')
    const strong = [...ev(30, 24, 0), ...ev(10, 8, 100)]           // 80%, and still 80% recently
    const s = judge(strong, base, 100)
    assert.equal(s.verdict, 'respects')
    assert.equal(s.n, 30, 'the sample the rule is found on: the older part only')
    assert.equal(s.base, 0.4)
    assert.equal(s.recent.rate, 0.8)
    const faded = [...ev(30, 29, 0), ...ev(10, 2, 100)]            // great early, 20% lately
    assert.equal(judge(faded, base, 100).verdict, 'faded')
    const early = [...ev(36, 30, 0), ...ev(2, 2, 100)]             // too few recent to confirm
    assert.equal(judge(early, base, 100).verdict, 'unconfirmed')
    // An edge that lives ONLY in the recent third is not found — it cannot confirm itself (CR 2026-11-12).
    const lateOnly = [...ev(30, 12, 0), ...ev(30, 30, 100)]
    assert.equal(judge(lateOnly, base, 100).verdict, 'no')
})

/** A sawtooth that falls to 100 and rallies to 110, again and again: support at 100, nothing at 103. */
function sawtooth(cycles) {
    const closes = []
    for (let c = 0; c < cycles; c++) {
        for (let p = 110; p > 100; p--) closes.push(p)
        for (let p = 100; p < 110; p++) closes.push(p)
    }
    return series(closes)
}

test('a level price keeps bouncing from beats the same level shifted: it RESPECTS it', () => {
    const b = sawtooth(20)
    const atrs = b.map(() => 1)
    const level = b.map(() => 100)
    const touches = levelTouches(b, level, atrs, PROFILE)
    assert.ok(touches.length >= 10)
    assert.ok(touches.every(t => t.out === 'win'))
    const cut = Math.floor(b.length * 2 / 3)
    const r = levelTest(b, level, atrs, 1, cut, { ...PROFILE, minN: 10 })
    assert.equal(r.verdict, 'respects', JSON.stringify(r))
    assert.ok(r.base < 0.2, 'the shifted levels (97, 98, 102, 103) are passed through on the way down')
})

test('a touch that slices through on the bar itself is a break, not a test', () => {
    const b = series([105, 104, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88])
    assert.deepEqual(levelTouches(b, b.map(() => 100), b.map(() => 1), { ...PROFILE, horizon: 5 }), [])
})

test('false breaks: a dip under a swing low closed back above within three bars, and what followed', () => {
    // swing low at 100 (bar 3), a sweep to 99 at bar 8 closing back at 100.6, then a rally.
    const closes = [104, 103, 102, 100.5, 102, 103, 102.5, 101.5, 100.6, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]
    const b = series(closes)
    b[3].low = 100
    b[8].low = 99
    const atrs = b.map(() => 1)
    const drift = driftOutcomes(b, atrs, PROFILE)
    const r = falseBreaks(b, atrs, 15, drift, { ...PROFILE, horizon: 5, minN: 1 })
    assert.equal(r.breaks, 1)
    assert.equal(r.false_rate, 1)
    assert.ok(r.bars_to_direction >= 1)
    assert.equal(r.after_sweep.n, 1)
    assert.equal(r.after_sweep.rate, 1)
    assert.deepEqual(r.sweep_depth_atr, { median: 1, p80: 1 }, 'the sweep went 1 ATR under the 100 low (to 99)')
})

test('events are counted once: the bars an outcome covers are skipped', () => {
    const b = series(Array.from({ length: 40 }, (_, i) => 100 + i))
    const outs = eventOutcomes(b, b.map(() => 1), () => true, { ...PROFILE, horizon: 5 })
    assert.deepEqual(outs.map(o => o.i), [1, 7, 13, 19, 25, 31])
})

test('VWAP resets each New York session', () => {
    const day1 = Date.parse('2026-11-10T09:30:00-05:00') / 1000
    const day2 = Date.parse('2026-11-11T09:30:00-05:00') / 1000
    const b = [
        { open: 10, high: 10, low: 10, close: 10, volume: 100, timestamp: day1 },
        { open: 20, high: 20, low: 20, close: 20, volume: 100, timestamp: day1 + 300 },
        { open: 50, high: 50, low: 50, close: 50, volume: 100, timestamp: day2 },
    ]
    assert.deepEqual(sessionVwap(b), [null, 15, null], "each session's first bar has no VWAP to test against")
})

test('too few bars for the 200 MA: no profile', () => {
    assert.equal(timeframeProfile(randomWalk(200, 1), 'day'), null)
    assert.equal(timeframeProfile(null, 'day'), null)
})

test('a random walk obeys nothing: across 20 walks, almost no test comes out RESPECTS (the baseline does its job)', () => {
    let respects = 0, tests = 0
    for (let seed = 1; seed <= 20; seed++) {
        const p = timeframeProfile(randomWalk(1000, seed), 'day')
        const all = [...Object.values(p.indicators), p.false_breaks.after_sweep, p.order_blocks]
        tests += all.length
        respects += all.filter(s => s.verdict === 'respects').length
    }
    assert.ok(respects / tests < 0.01, `${respects}/${tests} respected on noise`)
})

test("a day profile's shape: ATR %, gap, dollar volume, the drift, every test with its sample and baseline", () => {
    const p = timeframeProfile(randomWalk(600, 7), 'day')
    assert.equal(p.timeframe, 'day')
    assert.equal(p.bars, 600)
    assert.ok(p.atr_pct > 0 && p.gap_pct >= 0 && p.dollar_volume > 0)
    assert.deepEqual(Object.keys(p.indicators), ['ema20', 'sma50', 'sma200', 'rsi_oversold', 'macd_cross_up', 'volume_up_bar'])
    for (const s of Object.values(p.indicators)) {
        assert.ok(['respects', 'faded', 'unconfirmed', 'no', 'thin'].includes(s.verdict))
        assert.ok(Number.isInteger(s.n) && Number.isInteger(s.base_n))
    }
    assert.ok(p.false_breaks.breaks > 0)
    assert.ok(Number.isInteger(p.order_blocks.blocks))
    // Intraday adds VWAP; only the daily has a gap.
    const intra = timeframeProfile(randomWalk(600, 7).map((b, i) => ({ ...b, timestamp: 1_762_871_400 + i * 300 })), '5min')
    assert.ok('vwap' in intra.indicators)
    assert.equal(intra.gap_pct, null)
})

test('day trade / swing: it must move and be liquid; with nothing that holds it still fits, and says so', () => {
    const tf = (atr_pct, dollar_volume, verdict = 'no') => ({
        atr_pct, dollar_volume, indicators: { ema20: { verdict } },
        false_breaks: { after_sweep: { verdict: 'no' } }, order_blocks: { verdict: 'no' },
    })
    const s = suitability({ day: tf(3, 80e6, 'respects') })
    assert.equal(s.day_trade.fits, true)
    assert.deepEqual(s.swing.edges, ['ema20'])
    assert.equal(s.swing.why, 'moves, liquid, and something holds')
    assert.equal(s.day_trade.why, 'moves and liquid, but nothing technical holds', 'no intraday bars read: no day edge')
    assert.equal(suitability({ day: tf(3, 1e6) }).swing.why, 'too thin to trade')
    assert.equal(suitability({ day: tf(0.5, 80e6) }).swing.fits, false)
    assert.equal(suitability({}).swing.why, 'too little daily history (about a year is needed)')
})

test('the whole profile: the symbol, long side, each timeframe, and F', () => {
    const p = behaviourProfile('tsla', { day: randomWalk(400, 3), week: randomWalk(100, 4) })
    assert.equal(p.symbol, 'TSLA')
    assert.equal(p.side, 'long')
    assert.ok(p.timeframes.day)
    assert.equal(p.timeframes.week, null, '100 weekly bars: too few')
    assert.ok('day_trade' in p.suitability && 'swing' in p.suitability)
})

test('a bar that opens under the level is not a touch from above (the VWAP session-open case)', () => {
    const b = [bar(105), bar(96, { open: 95, high: 99, low: 94 }), ...series([97, 98, 99, 100, 101, 102, 103, 104])]
    assert.deepEqual(levelTouches(b, b.map(() => 100), b.map(() => 1), { ...PROFILE, horizon: 5 }), [])
})

test('the drift is sampled a window apart — overlapping windows would count one move ten times', () => {
    const b = series(Array.from({ length: 60 }, (_, i) => 100 + i))
    const d = driftOutcomes(b, b.map(() => 1), { ...PROFILE, horizon: 5 })
    assert.deepEqual(d.map(x => x.i), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50])
})

test('a deeper, OLDER swing low swept later is a break too — not only the latest low', () => {
    // lows: 100 at bar 3, then a higher low 103 at bar 9; bar 14 breaks 103, bar 20 sweeps under 100 and closes back.
    const closes = [106, 104, 102, 100.6, 103, 105, 106, 105, 104, 103.6, 105, 107, 106, 104, 102.6, 103, 102, 101.5, 101, 100.8, 100.4, 101, 103, 105, 107, 108, 109, 110, 111, 112]
    const b = series(closes)
    b[3].low = 100; b[9].low = 103; b[14].low = 102; b[20].low = 99
    const atrs = b.map(() => 1)
    const r = falseBreaks(b, atrs, 25, driftOutcomes(b, atrs, PROFILE), { ...PROFILE, horizon: 5, minN: 1 })
    assert.equal(r.breaks, 2, 'the break of 103 AND the later sweep of the older 100')
})

test('an order block is not retested before it EXISTS — the move that makes it is not its first hold', () => {
    // Bar 0 is the last down candle (top 101). Price climbs WITHOUT a gap, dips back to 100.95 at bar 4 (from above:
    // bar 3's low is 101.3), and only bar 6 leaves the gap that makes bar 0 a block (FVG middle 5) — known from bar 7.
    // The dip at bar 4 came before the block existed; counting it was look-ahead (CR 2026-11-12).
    const mk = (o, h, l, c, t) => ({ open: o, high: h, low: l, close: c, volume: 100, timestamp: t })
    const b = [mk(101, 101, 99, 99.5, 1), mk(99.5, 101.5, 99.4, 101.4, 2), mk(101.4, 101.8, 100.9, 101.7, 3), mk(101.7, 102, 101.3, 101.9, 4),
        mk(101.9, 102.1, 100.95, 102, 5), mk(102, 102.4, 101.9, 102.3, 6), mk(102.3, 104, 102.2, 103.9, 7),
        ...Array.from({ length: 30 }, (_, k) => mk(104 + k * 0.1, 104.5 + k * 0.1, 103.9 + k * 0.1, 104.4 + k * 0.1, 8 + k))]
    const atrs = b.map(() => 1)
    const r = orderBlockTest(b, atrs, 1, 30, { ...PROFILE, horizon: 5, minN: 1 })
    assert.equal(r.blocks, 1)
    assert.equal(r.n, 0, 'no retest counted inside the move that made the block')
})

test('false breaks: the LATEST one is kept as it happened — the example the chart shows (Roy, 2026-11-13)', () => {
    const closes = [104, 103, 102, 100.5, 102, 103, 102.5, 101.5, 100.6, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]
    const b = series(closes)
    b[3].low = 100
    b[8].low = 99
    const atrs = b.map(() => 1)
    const r = falseBreaks(b, atrs, 15, driftOutcomes(b, atrs, PROFILE), { ...PROFILE, horizon: 5, minN: 1 })
    const day8 = new Date((1_700_000_000 + 8 * 86_400) * 1000).toISOString()
    assert.deepEqual(r.latest, { at: day8, reclaimed_at: day8, level: 100, swept_to: 99, depth_atr: 1 })
    const flat = series(Array.from({ length: 20 }, (_, i) => 100 + i))
    assert.equal(falseBreaks(flat, flat.map(() => 1), 15, [], PROFILE).latest, null, 'no false break → no example')
})

test('the price cycle: a random walk almost never "holds" one; a real rhythm does, with its period and next window (proteus.md §8.1)', async () => {
    const { cycleTest } = await import('../../services/behaviourProfile.engine.js')
    // Noise: the same test on 20 random walks — at z ≥ 3 a cycle that "holds" should be a rare fluke, not the rule.
    const verdicts = Array.from({ length: 20 }, (_, k) => {
        const b = randomWalk(900, 101 + k)
        return cycleTest(b, Math.floor(b.length * (2 / 3))).verdict
    })
    assert.ok(verdicts.filter(v => v === 'respects').length <= 1, `random walks that "hold" a cycle: ${verdicts.join(',')}`)
    // A rhythm: lows every 20 sessions, a little noise on top.
    let s = 7
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    const closes = Array.from({ length: 900 }, (_, i) => 100 + 6 * Math.sin((2 * Math.PI * i) / 20) + (rnd() - 0.5) * 1.5)
    const c = cycleTest(series(closes), 600)
    assert.equal(c.verdict, 'respects')
    assert.ok(Math.abs(c.period_bars - 20) <= 2, `period ~20 (got ${c.period_bars})`)
    assert.ok(c.z >= 3 && c.rate > c.base)
    assert.ok(c.window && c.window.from < c.window.to && c.window.from > c.window.last_low, 'the next window comes after the last low')
    assert.equal(cycleTest(series(closes.slice(0, 60)), 40).verdict, 'thin', 'too few lows to say')
})

test('the false-break rate is chance\'s on a random walk — never a trait of its own (Roy, 2026-11-13: "how come it\'s always false breaks")', async () => {
    const { falseBreakChance, falseBreaks: fbOf } = await import('../../services/behaviourProfile.engine.js')
    const { calcATRSeries } = await import('../../monitoring/evaluators/structured.evaluator.js')
    const verdicts = []
    for (let k = 0; k < 12; k++) {
        const b = randomWalk(1200, 301 + k)
        const atrs = calcATRSeries(b.map(x => ({ t: x.timestamp * 1000, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume })), PROFILE.atrPeriod)
        const cut = Math.floor(b.length * (2 / 3))
        const fb = fbOf(b, atrs, cut, driftOutcomes(b, atrs, PROFILE), PROFILE)
        assert.ok(fb.false_rate > 0.6, `noise fakes most breaks (${fb.false_rate}) — which is why the rate alone means nothing`)
        const c = falseBreakChance(b, cut, fb, PROFILE)
        assert.ok(c.base > 0.6 && Number.isFinite(c.z), 'the baseline is the same bars in random order')
        verdicts.push(c.verdict)
    }
    assert.ok(verdicts.filter(v => v === 'more' || v === 'less').length <= 1, `a random walk's rate is chance's: ${verdicts.join(',')}`)
    assert.deepEqual(falseBreakChance(series([100, 101, 102]), 2, { older: { breaks: 3 } }, PROFILE), { verdict: 'thin', base: null, z: null })
})

test('Wyckoff on random walks: ranges are found, but springs, breakouts and dry-up retests almost never HOLD (proteus.md §8.1)', async () => {
    const { wyckoffTest, falseBreaks: fbOf } = await import('../../services/behaviourProfile.engine.js')
    const { calcATRSeries } = await import('../../monitoring/evaluators/structured.evaluator.js')
    let ranges = 0, holds = 0, tests = 0
    for (let k = 0; k < 12; k++) {
        const b = randomWalk(1500, 501 + k)
        const atrs = calcATRSeries(b.map(x => ({ t: x.timestamp * 1000, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume })), PROFILE.atrPeriod)
        const cut = Math.floor(b.length * (2 / 3))
        const drift = driftOutcomes(b, atrs, PROFILE)
        const fb = fbOf(b, atrs, cut, drift, PROFILE)
        const w = wyckoffTest(b, atrs, cut, drift, fb.sweeps, PROFILE)
        ranges += w.ranges
        for (const s of [w.springs, w.breakouts, w.dry_up]) {
            tests++
            if (s.verdict === 'respects') holds++
            assert.ok(['respects', 'faded', 'unconfirmed', 'no', 'thin'].includes(s.verdict))
        }
        assert.ok(['respects', 'faded', 'unconfirmed', 'no', 'thin'].includes(w.springs.vs_sweeps.verdict))
    }
    assert.ok(ranges > 0, 'noise makes tight ranges too')
    assert.ok(holds <= 1, `${holds}/${tests} Wyckoff tests held on noise`)
})

test('Wyckoff: a tight range, a spring under its low reclaimed, a breakout above it; the range it is in NOW', async () => {
    const { wyckoffTest } = await import('../../services/behaviourProfile.engine.js')
    // 20 bars inside 99–101 (span 2, ATR 1 → within 4 ATR); bar 25 dips to 97.5 and bar 26 closes back inside: a spring;
    // bar 32 closes above 101: a breakout. Then a climb, then a fresh tight range to the end — where it stands now.
    const closes = [...Array.from({ length: 25 }, (_, i) => 100 + (i % 2 ? 0.4 : -0.4)), 98.2, 100.2, 100.4, 100.6, 100.3, 100.5, 100.6, 102,
        ...Array.from({ length: 30 }, (_, i) => 103 + i), ...Array.from({ length: 25 }, (_, i) => 132 + (i % 2 ? 0.4 : -0.4))]
    const b = series(closes)
    b[25].low = 97.5
    const atrs = b.map(() => 1)
    const opts = { ...PROFILE, horizon: 5, minN: 1, minRecent: 1 }
    const w = wyckoffTest(b, atrs, 200, driftOutcomes(b, atrs, opts), [], opts)
    assert.ok(w.ranges >= 2)
    assert.equal(w.springs.n, 1, 'the dip under 99.1 closed back inside the next bar')
    assert.equal(w.breakouts.n, 1, 'the close at 102 above the range high')
    assert.equal(w.breakouts.upthrust_rate, 0, 'it never fell back inside')
    assert.equal(w.current.high, 132.9)
    assert.ok(w.current.low <= 131.1 && w.current.low >= 128, `the range found as soon as 20 bars fit in 4 ATR — the climb's last bars included (got ${w.current.low})`)
    // A dip that does NOT close back inside is a breakdown — the range ends, no spring.
    const down = series([...Array.from({ length: 25 }, (_, i) => 100 + (i % 2 ? 0.4 : -0.4)), 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87])
    assert.equal(wyckoffTest(down, down.map(() => 1), 100, [], [], opts).springs.n, 0)
})
