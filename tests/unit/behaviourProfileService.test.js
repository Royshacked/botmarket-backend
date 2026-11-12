import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileFor, fetchProfileBars, weeklyFromDaily, PROFILE_VERSION } from '../../services/behaviourProfile.service.js'
import { formatProfile, testLine, makeBehaviourProfileHandlers } from '../../services/tools/behaviourProfile.tools.js'

// Proteus's profile fetched, kept a week, and laid out as text (docs/design/proteus.md §5, §6).

const DAY = 86_400_000
const NOW = Date.parse('2026-11-12T20:00:00Z')

/** A fake candle source: a random walk per (timeSpan) over the asked window, counting the calls. */
function fakeGet() {
    const calls = []
    const step = { minute: 5 * 60_000, hour: 3_600_000, day: DAY }
    const get = async (sym, { timeSpan, multiplier, from, to }) => {
        calls.push({ sym, timeSpan, multiplier })
        const dt = step[timeSpan] * (timeSpan === 'minute' ? 1 : 1)
        const out = []
        let p = 100, s = Math.floor(from / dt)
        for (let t = Math.ceil(from / dt) * dt; t <= to; t += dt) {
            s = (s * 1664525 + 1013904223) >>> 0
            const o = p; p *= 1 + ((s / 2 ** 32) - 0.5) * 0.03
            out.push({ open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p, volume: 1e6, timestamp: t / 1000 })
        }
        return out
    }
    return { get, calls }
}

function fakeCache() {
    const store = new Map()
    return { store, read: async (k) => store.get(k) ?? null, write: async (k, v) => { store.set(k, v) } }
}

test('the bars: 5-minute paged by week over ~3 months, 1-hour by ~2 months over a year, one daily call, weekly built from it', async () => {
    const { get, calls } = fakeGet()
    const b = await fetchProfileBars('tsla', { get, now: NOW })
    assert.equal(calls.filter(c => c.timeSpan === 'minute').length, 14)
    assert.equal(calls.filter(c => c.timeSpan === 'hour').length, 7)
    assert.equal(calls.filter(c => c.timeSpan === 'day').length, 1)
    assert.ok(calls.every(c => c.sym === 'TSLA'))
    assert.ok(b.day.length > 2500, 'the daily view reads all ~10 years')
    assert.ok(b.week.length > 500, 'ten years of weeks')
    const ts = b['5min'].map(x => x.timestamp)
    assert.deepEqual(ts, [...new Set(ts)].sort((x, y) => x - y), 'pages de-duplicated and in order')
})

test('weekly bars: one per Monday, high/low/volume over the week; the week in progress is left out', () => {
    const d = (date, o, h, l, c) => ({ open: o, high: h, low: l, close: c, volume: 10, timestamp: Date.parse(`${date}T14:30:00Z`) / 1000 })
    const w = weeklyFromDaily([d('2026-11-09', 10, 12, 9, 11), d('2026-11-10', 11, 15, 10, 14), d('2026-11-16', 14, 14, 13, 13)], Date.parse('2026-11-30T00:00:00Z'))
    assert.equal(w.length, 2)
    assert.deepEqual({ open: w[0].open, high: w[0].high, low: w[0].low, close: w[0].close, volume: w[0].volume }, { open: 10, high: 15, low: 9, close: 14, volume: 20 })
    assert.equal(w[0].date, '2026-11-09')
    const thisWeek = weeklyFromDaily([d('2026-11-09', 10, 12, 9, 11), d('2026-11-16', 14, 14, 13, 13)], Date.parse('2026-11-18T20:00:00Z'))
    assert.deepEqual(thisWeek.map(x => x.date), ['2026-11-09'], 'the week of the 16th is not over on the 18th')
})

test('profiled once a week: the second ask is the stored one, no fetch; fresh recomputes; a stale version recomputes', async () => {
    const { get, calls } = fakeGet()
    const cache = fakeCache()
    const deps = { get, now: NOW, cache }
    const p1 = await profileFor('nvda', { deps })
    assert.equal(p1.symbol, 'NVDA')
    assert.equal(p1.computed_at, new Date(NOW).toISOString())
    assert.equal(cache.store.get('NVDA').version, PROFILE_VERSION)
    const n = calls.length
    await profileFor('NVDA', { deps })
    assert.equal(calls.length, n, 'the stored profile, no provider calls')
    await profileFor('NVDA', { deps, fresh: true })
    assert.ok(calls.length > n)
    cache.store.set('NVDA', { ...cache.store.get('NVDA'), version: PROFILE_VERSION - 1 })
    const m = calls.length
    await profileFor('NVDA', { deps })
    assert.ok(calls.length > m, 'an older engine version is not served')
})

test("a stored profile older than a week is recomputed, whatever the cache's own clock says", async () => {
    const { get, calls } = fakeGet()
    const cache = fakeCache()
    cache.store.set('KO', { version: PROFILE_VERSION, profile: { symbol: 'KO', timeframes: {}, suitability: {} }, computed_at: new Date(NOW - 8 * DAY).toISOString() })
    const p = await profileFor('KO', { deps: { get, now: NOW, cache } })
    assert.ok(calls.length > 0, 'recomputed')
    assert.equal(p.computed_at, new Date(NOW).toISOString())
})

test('a page that fails is skipped, not the profile', async () => {
    const { get } = fakeGet()
    let n = 0
    const flaky = async (sym, o) => { if (o.timeSpan === 'minute' && n++ === 3) throw new Error('429'); return get(sym, o) }
    const b = await fetchProfileBars('AMD', { get: flaky, now: NOW })
    assert.ok(b['5min'].length > 0 && b.day.length > 0)
})

test('two asks at once compute once', async () => {
    const { get, calls } = fakeGet()
    const deps = { get, now: NOW, cache: fakeCache() }
    const [a, b] = await Promise.all([profileFor('AMD', { deps }), profileFor('AMD', { deps })])
    assert.equal(a.symbol, b.symbol)
    assert.equal(calls.length, 22)
})

test('no daily history: an error, nothing stored', async () => {
    const cache = fakeCache()
    await assert.rejects(profileFor('ZZZZ', { deps: { get: async () => [], now: NOW, cache } }), /no price history for ZZZZ/)
    assert.equal(cache.store.size, 0)
    await assert.rejects(profileFor('  ', { deps: { cache } }), /symbol is required/)
})

test('a test line: verdict in words, rate vs baseline, the sample, the recent third', () => {
    const s = { verdict: 'respects', n: 37, rate: 0.78, base: 0.49, z: 3.1, recent: { n: 12, rate: 0.75, base: 0.5 } }
    assert.equal(testLine('50 SMA', s, 'touches'), '50 SMA: HOLDS — 78% vs 49% baseline (37 touches in the older two-thirds, z 3.1; recent third 75% vs 50%, 12)')
    assert.equal(testLine('VWAP', { verdict: 'thin', n: 0 }), 'VWAP: none in this history')
    assert.match(testLine('x', { ...s, verdict: 'faded' }), /held in the older history, NOT lately/)
})

test('the text: how to read it, what holds (or nothing), each timeframe, the sweeps, the fit', async () => {
    const { get } = fakeGet()
    const p = await profileFor('KO', { deps: { get, now: NOW, cache: fakeCache() } })
    const text = formatProfile(p)
    assert.match(text, /^KO — measured behaviour profile, long side, computed 2026-11-12\./)
    assert.match(text, /a test HOLDS only when it beat its baseline by 10\+ points at z ≥ 3/)
    assert.match(text, /WHAT HOLDS: /)
    for (const tf of ['5-MINUTE', '1-HOUR', 'DAILY', 'WEEKLY']) assert.match(text, new RegExp(`${tf} \\(`))
    assert.match(text, /Breaks of a swing low: \d+, \d+% FALSE/)
    assert.match(text, /FITS: day trade (yes|no) — .*\. Swing (yes|no) — /)
    // A profile where a test held names it up top.
    const held = structuredClone(p)
    held.timeframes.day.indicators.sma50.verdict = 'respects'
    assert.match(formatProfile(held), /WHAT HOLDS: 50 SMA \(daily\)\./)
    held.timeframes.week = null
    assert.match(formatProfile(held), /WEEKLY: too few bars to measure/)
})

test('the tool: needs a ticker; a failure says so and forbids describing the stock from memory', async () => {
    const h = makeBehaviourProfileHandlers({ deps: { get: async () => { throw new Error('provider down') }, now: NOW, cache: fakeCache() } })
    assert.equal(await h.get_behaviour_profile({}), 'Pass `ticker`.')
    const out = await h.get_behaviour_profile({ ticker: 'tsla' })
    assert.match(JSON.stringify(out), /Could not measure TSLA: provider down — say so; do not describe its behaviour from memory/)
})
