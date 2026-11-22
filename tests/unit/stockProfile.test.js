import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    SCALES, VERSION, RATIOS, swingLegs, counterLegs, sessionMoves, sessionsOf, sigmaSeries, bracketTrade, lineAt, efficiency,
    scaleProfile, levelsAt, weeklyOf, pairRecord,
} from '../../services/stockProfile.engine.js'
import { profileFor, storedProfile, levelsFor, isValid, scaleOf, fifteenFromFive, VALID_MS } from '../../services/stockProfile.service.js'

// Proteus v2 — how a stock moves, in its own σ (docs/design/proteus-v2.md).

const DAY = 86_400
const bar = (t, c, spread = 0.002) => ({ timestamp: t, open: c, high: c * (1 + spread), low: c * (1 - spread), close: c, volume: 1e6 })

/** A seeded random walk of `n` daily bars (drift per bar, daily vol), from 2016. */
function walk(n, { drift = 0, vol = 0.012, seed = 7, mean = null, t0 = Date.parse('2016-01-04T21:00:00Z') / 1000, step = DAY } = {}) {
    let s = seed, p = 100
    const out = []
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) >>> 0
        const u = s / 2 ** 32 - 0.5
        const pull = mean == null ? 0 : (Math.log(mean) - Math.log(p)) * 0.05
        p *= Math.exp(drift + pull + u * vol * 3.4)
        out.push(bar(t0 + i * step, p, vol / 3))
    }
    return out
}

test('scales: the horizons map to their scale (§2b)', () => {
    assert.equal(scaleOf('intraday'), 'day')
    assert.equal(scaleOf('day'), 'day')
    assert.equal(scaleOf('short term swing'), 'short', 'its own scale since v2 — a week, not a month')
    assert.equal(scaleOf('swing'), 'swing')
    assert.equal(scaleOf('long term'), 'long')
    assert.equal(scaleOf(undefined), 'swing')
    assert.equal(SCALES.day.unit, 26)
})

test('σ: the per-bar σ × √unit; intraday leaves the overnight return out', () => {
    const bars = walk(200, { vol: 0.01 })
    const sig = sigmaSeries(bars, SCALES.swing)
    assert.equal(sig[58], null)
    assert.ok(sig[199] > 0.02 && sig[199] < 0.09, `a month's σ of a 1% daily walk ≈ 4.6%: ${sig[199]}`)
    // Two sessions with a 10% gap between them: the gap is not an intraday return.
    const t0 = Date.parse('2026-11-02T14:30:00Z') / 1000
    const s1 = Array.from({ length: 26 }, (_, k) => bar(t0 + k * 900, 100 + (k % 2) * 0.1))
    const s2 = Array.from({ length: 26 }, (_, k) => bar(t0 + DAY + k * 900, 110 + (k % 2) * 0.1))
    const cfg = { ...SCALES.day, look: 40 }
    const ds = sigmaSeries([...s1, ...s2], cfg, sessionsOf([...s1, ...s2]))
    assert.ok(ds.at(-1) < 0.01, `the 10% gap is left out: ${ds.at(-1)}`)
})

test('swings: a zigzag on a planted saw — runs and pullbacks of the planted size', () => {
    const closes = []
    for (let k = 0; k < 12; k++) { for (let j = 0; j < 10; j++) closes.push(100 * (1 + 0.01 * j)); for (let j = 10; j > 5; j--) closes.push(100 * (1 + 0.01 * j)) }
    const bars = closes.map((c, i) => bar(i * DAY, c, 0))
    const legs = swingLegs(bars, bars.map(() => 0.02), 0, 1)
    const up = legs.filter(l => l.up), down = legs.filter(l => !l.up)
    assert.ok(up.length >= 8 && down.length >= 8)
    assert.ok(down.every(l => Math.abs(l.size - 1 / 11) < 0.001), 'each pullback 110 → 100')
    assert.ok(up.every(l => Math.abs(l.size - 0.1) < 0.001), 'each run 100 → 110')
})

test('noise: a pullback counts only when the next run made a new high', () => {
    const L = (up, end) => ({ up, size: 0.05, sig: 0.05, bars: 5, end, day: null })
    // up to 110, down, up to 120 (continued) → noise; down, up to 115 (not a new high) → not; down
    const legs = [L(true, 110), L(false, 104), L(true, 120), L(false, 112), L(true, 115), L(false, 100)]
    assert.equal(counterLegs(legs, false).length, 1)
    assert.equal(counterLegs(legs, false)[0].end, 104)
    // the short side: a rally counts when the next fall made a new low
    assert.equal(counterLegs(legs, true).length, 1)
})

test('session moves: run, fall, and the dip the session later exceeded', () => {
    const t0 = Date.parse('2026-11-02T14:30:00Z') / 1000
    const px = [100, 102, 101, 104, 103.5, 105]   // a dip 102 → 101 later exceeded; the run 100 → 105
    const bars = px.map((c, k) => ({ timestamp: t0 + k * 900, open: c, high: c, low: c, close: c }))
    const sess = sessionsOf(bars)
    const m = sessionMoves(bars, bars.map(() => 0.01), sess)
    assert.equal(m.length, 1)
    assert.ok(Math.abs(m[0].run - 0.05) < 1e-9)
    assert.ok(Math.abs(m[0].pull - (1 - 101 / 102)) < 1e-9, 'the deepest dip later exceeded')
    assert.ok(m[0].fall < 0.01, 'never 100% on the first bar')
})

test('a bracket: the stop on a bar that reaches both; open at the end', () => {
    const bars = [bar(0, 100, 0), { timestamp: 1, open: 100, high: 106, low: 94, close: 100 }, bar(2, 100, 0)]
    assert.equal(bracketTrade(bars, 0, 2, 0.05, 0.05).how, 'stop')
    assert.equal(bracketTrade(bars, 0, 2, 0.1, 0.1).how, 'open')
    assert.equal(bracketTrade(bars, 0, 2, 0.05, 0.05, true).how, 'stop', 'short mirrored')
})

test('the line: a clean trend has R² ≈ 1 and its slope; efficiency 1', () => {
    const bars = Array.from({ length: 70 }, (_, i) => bar(i * DAY, 100 * Math.exp(0.01 * i), 0))
    const l = lineAt(bars, 69, 63)
    assert.ok(l.r2 > 0.999)
    assert.ok(Math.abs(l.slope - 0.01) < 1e-9)
    assert.ok(Math.abs(efficiency(bars, 69, 63) - 1) < 1e-9)
})

test('the swing profile: every measure present, counts carried, levels on both sides', () => {
    const bars = walk(2500, { drift: 0.0003 })
    const p = scaleProfile(bars, SCALES.swing)
    assert.equal(p.enough, true)
    assert.ok(p.sigma > 0)
    assert.ok(p.swings.runs.n >= 8 && p.swings.runs.sig.median > 0)
    for (const side of ['long', 'short']) {
        const lv = p.levels[side]
        assert.equal(lv.enough, true, side)
        assert.ok(lv.stop_sig > 0 && lv.target_sig > 0 && lv.record.n > 100)
        assert.deepEqual(Object.keys(lv.ratios).map(Number).sort((a, b) => a - b), [...RATIOS])
    }
    assert.ok(['reverts', 'persists', 'neither'].includes(p.trend.persistence.label))
    assert.ok(['range', 'mixed', 'up trend', 'down trend'].includes(p.regime.label))
    assert.ok(Number.isFinite(p.stretch.now))
})

test('trend or revert: a mean-reverting series reads "reverts"', () => {
    const p = scaleProfile(walk(2500, { mean: 100, vol: 0.015, seed: 11 }), SCALES.swing)
    assert.equal(p.trend.persistence.label, 'reverts', `corr ${p.trend.persistence.corr}`)
})

test('too short: a new listing says so', () => {
    const p = scaleProfile(walk(80), SCALES.swing)
    assert.equal(p.enough, false)
    assert.equal(p.reason, 'too_short')
})

test('levels for a ratio: the stop stays at the noise, the target ratio × stop; the nearest record', () => {
    const p = scaleProfile(walk(2500, { drift: 0.0003 }), SCALES.swing)
    const l = levelsAt(p, 3)
    assert.equal(l.stop.sig, p.levels.long.stop_sig)
    assert.ok(Math.abs(l.target.sig - 3 * l.stop.sig) < 0.002)
    assert.ok(l.stop.price < p.close && l.target.price > p.close)
    assert.equal(l.record_ratio, 3)
    const s = levelsAt(p, 2.2, 'short')
    assert.ok(s.stop.price > p.close && s.target.price < p.close)
    assert.equal(s.record_ratio, 2)
    assert.equal(levelsAt(p, 0), null)
    assert.equal(levelsAt({ enough: false }, 2), null)
})

// ── v2 (2026-11-21, Roy: "fit the period to the horizon"; lab-proteus-horizon / -target.mjs) ──
test('v2: every scale but the day reads daily bars, σ over its horizon, trades capped at 3 × H', () => {
    assert.equal(VERSION, 2, 'a stored v1 profile is rebuilt on its next read')
    for (const [k, H] of [['short', 5], ['swing', 21], ['long', 63]]) {
        assert.equal(SCALES[k].unit, H, k)
        assert.equal(SCALES[k].cap, 3 * H, k)
        assert.equal(SCALES[k].look, 60, `${k}: σ off the last 60 daily returns`)
    }
    assert.equal(SCALES.short.label, 'short term swing')
    assert.equal(SCALES.day.stop, null, 'the day scale keeps its measured levels until its own lab')
})

test('v2: the stop and the target are the horizon\'s constants × σ — whatever the name\'s own swings', () => {
    const calm = scaleProfile(walk(2500, { drift: 0.0003, vol: 0.008, seed: 3 }), SCALES.swing)
    const wild = scaleProfile(walk(2500, { mean: 100, vol: 0.02, seed: 11 }), SCALES.swing)
    for (const p of [calm, wild]) {
        for (const side of ['long', 'short']) {
            const lv = p.levels[side]
            assert.equal(lv.basis, 'constant')
            assert.equal(lv.stop_sig, 1.73)
            assert.equal(lv.target_sig, 0.81)
            assert.ok(Math.abs(lv.stop_pct - 1.73 * p.sigma) < 0.001, 'in % from today\'s σ')
        }
        assert.ok(p.swings.runs.n >= 8, 'the measured swings stay, as the description')
    }
    assert.ok(wild.levels.long.stop_pct > calm.levels.long.stop_pct, 'what differs per stock is σ')
    const short = scaleProfile(walk(2500, { drift: 0.0003 }), SCALES.short)
    assert.equal(short.levels.long.stop_sig, 2.08)
    assert.equal(short.cap, 15)
    assert.equal(short.per, 'week')
    assert.ok(short.levels.long.record.n > 100)
})

test('v2: the record stops at the cap — an unfinished trade counts as not finished', () => {
    // σ held at 50%: a 1.73σ stop and a 0.81σ target are far past anything ~1%-a-day bars reach in 63 sessions.
    const bars = walk(1000, { vol: 0.012, seed: 5 }), sig = bars.map(() => 0.5)
    const r = pairRecord(bars, sig, SCALES.swing, null, 1.73, 0.81)
    assert.equal(r.never, 1, 'every entry unfinished within the 63-session hold')
    assert.ok(r.median_bars <= 63)
    const loose = pairRecord(bars, bars.map(() => 0.01), SCALES.swing, null, 1.73, 0.81)
    assert.equal(loose.never, 0, 'a σ of 1%: both levels within ~2% — every trade finishes')
})

test('v2: levels for a ratio carry the target that fits the horizon and the cap', () => {
    const p = scaleProfile(walk(2500, { drift: 0.0003 }), SCALES.swing)
    const l = levelsAt(p, 3)
    assert.equal(l.stop.sig, 1.73)
    assert.equal(l.natural.target_sig, 0.81)
    assert.ok(Math.abs(l.natural.rr - 0.81 / 1.73) < 0.002)
    assert.equal(l.cap, 63)
    assert.ok(l.natural.record.enough)
})

test('weekly bars: Monday-first weeks, the week in progress left out', () => {
    const mon = Date.parse('2026-11-02T21:00:00Z') / 1000
    const days = [0, 1, 2, 3, 4, 7, 8].map(d => bar(mon + d * DAY, 100 + d))
    assert.equal(weeklyOf(days, mon + 9 * DAY).length, 1)
    assert.equal(weeklyOf(days, mon + 14 * DAY).length, 2)
    assert.equal(weeklyOf(days, mon + 9 * DAY)[0].close, 104)
})

test('15-minute bars from 5-minute', () => {
    const t0 = Date.parse('2026-11-02T14:30:00Z')
    const five = Array.from({ length: 6 }, (_, k) => ({ timestamp: (t0 + k * 300_000) / 1000, open: k, high: k + 1, low: k - 1, close: k, volume: 1 }))
    const f = fifteenFromFive(five)
    assert.equal(f.length, 2)
    assert.deepEqual([f[0].open, f[0].high, f[0].low, f[0].close, f[0].volume], [0, 3, -1, 2, 3])
})

// ── the service: build, store, validity ─────────────────────────────────────────────────────────────────────────────

function fakeCache() {
    const m = new Map()
    return { m, read: async k => m.get(k), write: async (k, v) => { m.set(k, v) } }
}
function fakeGet() {
    const calls = []
    const get = async (sym, { timeSpan, from, to }) => {
        calls.push(timeSpan)
        if (timeSpan === 'day') return walk(2520, { t0: Math.floor(from / 1000), drift: 0.0002 })
        // 5-minute bars of the regular session, Mon–Fri, in this page
        const out = []
        for (let d = Math.floor(from / 86_400_000); d * 86_400_000 < to; d++) {
            const wd = new Date(d * 86_400_000).getUTCDay()
            if (wd === 0 || wd === 6) continue
            const open = d * 86_400 + 14.5 * 3600
            const w = walk(78, { t0: open, step: 300, seed: d, vol: 0.001 })
            out.push(...w)
        }
        return out
    }
    return { get, calls }
}

test('profileFor: builds every scale once, then serves the stored one; the day scale goes stale after a day', async () => {
    const cache = fakeCache(), { get, calls } = fakeGet()
    const now = Date.parse('2026-11-20T21:00:00Z')
    const e = await profileFor('ko', { deps: { cache, get, now } })
    assert.equal(e.symbol, 'KO')
    assert.equal(e.version, VERSION)
    assert.ok(e.scales.swing.enough && e.scales.long.enough)
    assert.ok(e.scales.day.bars > 1000, `15-minute bars: ${e.scales.day.bars}`)
    const n = calls.length
    await profileFor('KO', { deps: { cache, get, now: now + 3_600_000 } })
    assert.equal(calls.length, n, 'served from the store')
    assert.equal(isValid(cache.m.get('KO'), 'day', now + VALID_MS.day + 1), false)
    assert.equal(isValid(cache.m.get('KO'), 'swing', now + VALID_MS.day + 1), true)
    await profileFor('KO', { scales: ['day'], deps: { cache, get, now: now + 2 * 86_400_000 } })
    assert.ok(calls.length > n && !calls.slice(n).includes('day'), 'only the day scale rebuilt — no daily fetch')
    assert.ok(cache.m.get('KO').scales.swing.enough, 'the rest kept')
})

test('storedProfile never builds; an old version is not served', async () => {
    const cache = fakeCache()
    assert.equal(await storedProfile('KO', { deps: { cache } }), null)
    cache.m.set('KO', { version: VERSION - 1, scales: { swing: {} }, built: { swing: new Date().toISOString() } })
    assert.equal(await storedProfile('KO', { deps: { cache } }), null)
})

test('levelsFor: the horizon picks the scale', async () => {
    const cache = fakeCache(), { get } = fakeGet()
    const now = Date.parse('2026-11-20T21:00:00Z')
    const l = await levelsFor('KO', 3, { horizon: 'swing', deps: { cache, get, now } })
    assert.equal(l.enough, true)
    assert.equal(l.scale, 'swing')
    assert.equal(l.ratio, 3)
    const lt = await levelsFor('KO', 2, { horizon: 'long term', side: 'short', deps: { cache, get, now } })
    assert.equal(lt.scale, 'long term')
    const st = await levelsFor('KO', 2, { horizon: 'short term swing', deps: { cache, get, now } })
    assert.equal(st.scale, 'short term swing', 'its own scale since v2')
    assert.equal(st.stop.sig, 2.08)
})

// 2026-11-21: the house's rating bands measure a target in the stock's σ over its horizon — this one read.
test('horizonSigma: the swing scale\'s σ (a month, a fraction) × √months, in %; no history → null, never a throw', async () => {
    const { horizonSigma } = await import('../../services/stockProfile.service.js')
    const cache = fakeCache(), { get } = fakeGet()
    const now = Date.parse('2026-11-20T21:00:00Z')
    const entry = await profileFor('KO', { scales: ['swing'], deps: { cache, get, now } })
    const m = entry.scales.swing.sigma
    assert.ok(m > 0)
    assert.equal(await horizonSigma('KO', '3m', { deps: { cache, get, now } }), Math.round(m * Math.sqrt(3) * 1000) / 10)
    assert.equal(await horizonSigma('KO', '12m', { deps: { cache, get, now } }), Math.round(m * Math.sqrt(12) * 1000) / 10)
    const empty = { get: async () => [], getDaily: async () => [] }
    assert.equal(await horizonSigma('NONE', '3m', { deps: { cache: fakeCache(), ...empty, now } }), null)
})
