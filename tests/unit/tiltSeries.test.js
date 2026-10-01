import { test } from 'node:test'
import assert from 'node:assert/strict'

import { relativeSeries, thin, seriesForTilt, closesFor, _clearSeriesCache, MAX_POINTS, CONTEXT_DAYS } from '../../api/strategy/tiltSeries.service.js'
import { relativeReturnPct, contributionBp } from '../../monitoring/tilt.assess.js'

// The line behind a stance. The one property worth defending is that it AGREES with the number
// printed beside it — a chart that quietly disagrees with the grade is worse than no chart.

const DAY = 24 * 60 * 60 * 1000
const T0  = Date.parse('2026-01-01T00:00:00.000Z')
const bars = (...closes) => closes.map((c, i) => ({ t: T0 + i * DAY, c }))

const row = (over = {}) => ({
    bucket: 'Technology', grain: 'sector', proxy: { symbol: 'XLK', weighting: 'cap', exact: true },
    stance: 'over', active_bp: 150, set_at: '2026-01-01T00:00:00.000Z',
    base_px: 100, base_bench_px: 200, ...over,
})

// ── the line is rebased on the FROZEN baseline ───────────────────────────────
test('the line starts where the CALL was made, not where the first bar happens to sit', () => {
    // The first bar is 2% above the frozen baseline, and the benchmark is flat. The line must open
    // at 102 — not at 100 — or it is drawing a different call from the one being graded.
    const line = relativeSeries(row(), bars(102, 104), bars(200, 200))
    assert.equal(line[0].v, 102)
    assert.equal(line[1].v, 104)
})

test('relative means relative — a bucket that fell LESS than the benchmark rises', () => {
    // Down 5% while the benchmark is down 10%: the stance worked, and the line says so.
    const line = relativeSeries(row(), bars(100, 95), bars(200, 180))
    assert.equal(line[0].v, 100)
    assert.ok(line[1].v > 100, `expected the line above 100, got ${line[1].v}`)
})

test('THE LINE AND THE GRADE AGREE — the last point is what the contribution is computed from', () => {
    // The property the whole module exists for, asserted against the grader itself rather than
    // against a number copied out of it.
    const r = row({ active_bp: -100, base_px: 50, base_bench_px: 400 })
    const line = relativeSeries(r, bars(50, 47), bars(400, 420))
    const last = line.at(-1)

    const graded = relativeReturnPct({ sectorStart: r.base_px, sectorNow: 47, benchStart: r.base_bench_px, benchNow: 420 })
    assert.ok(Math.abs((last.v - 100) - graded) < 0.02, `line says ${last.v - 100}%, the grader says ${graded}%`)
    assert.ok(Math.abs(contributionBp(r.active_bp, last.v - 100) - contributionBp(r.active_bp, graded)) < 0.05)
})

test('a day only one leg priced is SKIPPED, never drawn flat', () => {
    // A missing quote and an unchanged price are different facts, and only one of them belongs on
    // a chart — the same rule that keeps contribution null rather than zero.
    const line = relativeSeries(row(), bars(100, 101, 102), [{ t: T0, c: 200 }, { t: T0 + 2 * DAY, c: 200 }])
    assert.equal(line.length, 2)
    assert.deepEqual(line.map(p => p.v), [100, 102])
})

test('a row with no usable baseline draws nothing rather than guessing one', () => {
    for (const bad of [{ base_px: null }, { base_px: 0 }, { base_bench_px: null }, { base_bench_px: -5 }]) {
        assert.deepEqual(relativeSeries(row(bad), bars(100, 110), bars(200, 200)), [], JSON.stringify(bad))
    }
    assert.deepEqual(relativeSeries(null, bars(100), bars(200)), [])
    assert.deepEqual(relativeSeries(row(), null, null), [])
})

// ── thinning ─────────────────────────────────────────────────────────────────
test('thin keeps the LAST point, because that is the one the number comes from', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ t: T0 + i * DAY, v: i }))
    const out  = thin(many)
    assert.equal(out.length, MAX_POINTS)
    assert.equal(out.at(-1).v, 499, 'the newest point must survive')
    assert.equal(out[0].v, 0, 'and so must the oldest')
})

test('thin is the identity below the cap, and safe on junk', () => {
    const few = [{ t: T0, v: 100 }, { t: T0 + DAY, v: 101 }]
    assert.deepEqual(thin(few), few)
    assert.deepEqual(thin([]), [])
    assert.deepEqual(thin(null), [])
})

// ── the view-level read ──────────────────────────────────────────────────────
const doc = (over = {}) => ({
    benchmark: 'SPX',
    tilts: [row({ set_at: new Date(Date.now() - 30 * DAY).toISOString() })],
    ...over,
})

/**
 * PROVIDER-SHAPED bars ending today, so the freshness guard does not filter the row out.
 * `{timestamp, close}` is what the candle provider hands back; `closesFor` is what maps it.
 */
const recent = (n, from) => Array.from({ length: n }, (_, i) => ({
    timestamp: Date.now() - (n - 1 - i) * DAY, close: from + i,
}))

test('every open stance gets a line, and the benchmark is fetched ONCE for the table', async () => {
    const asked = []
    const io = { fetchBars: async (symbol) => { asked.push(symbol); return recent(10, symbol === 'SPY' ? 200 : 100) } }
    const out = await seriesForTilt(doc({ tilts: [
        row({ bucket: 'Technology', set_at: new Date(Date.now() - 30 * DAY).toISOString() }),
        row({ bucket: 'Energy', proxy: { symbol: 'XLE' }, base_px: 100, set_at: new Date(Date.now() - 30 * DAY).toISOString() }),
    ] }), { io })

    assert.deepEqual(Object.keys(out).sort(), ['Energy', 'Technology'])
    assert.equal(asked.filter(s => s === 'SPY').length, 1, 'one benchmark read serves the whole table')
})

test('a stance set TODAY still has a line — the quarter it was made into, all marked as context', async () => {
    // It used to have none (a call made today has no performance yet), and a sized table publishes
    // most rows fresh, so the whole board went blank. The range now always spans CONTEXT_DAYS before
    // the call, so it is never the zero-width request that 403s.
    const asked = []
    const io = { fetchBars: async (s, from, to) => { asked.push({ s, days: (to - from) / DAY }); return recent(60, s === 'SPY' ? 200 : 100) } }
    _clearSeriesCache()
    const out = await seriesForTilt(doc({ tilts: [row({ set_at: new Date().toISOString() })] }), { io })
    const line = out.Technology
    assert.ok(line && line.length > 1, 'a line is drawn')
    assert.ok(line.slice(0, -1).every(p => p.pre === true), 'everything before today is context')
    assert.ok(asked.find(a => a.s === 'XLK').days >= CONTEXT_DAYS - 1, 'never a zero-width range')
})

test('context points are marked, the call\'s own are not, and the last point is still the grade', () => {
    const set = '2026-01-03T12:00:00.000Z'
    const r = row({ set_at: set, base_px: 100, base_bench_px: 200 })
    const line = relativeSeries(r, bars(98, 99, 100, 104), bars(200, 200, 200, 210))   // T0 = Jan 1
    assert.deepEqual(line.map(p => !!p.pre), [true, true, false, false])
    const graded = relativeReturnPct({ sectorStart: 100, sectorNow: 104, benchStart: 200, benchNow: 210 })
    assert.ok(Math.abs((line.at(-1).v - 100) - graded) < 0.02)
})

test('a row with no proxy is skipped — there is nothing to draw it from', async () => {
    const io = { fetchBars: async () => recent(10, 100) }
    const out = await seriesForTilt(doc({ tilts: [row({ proxy: null })] }), { io })
    assert.deepEqual(out, {})
})

test('an unreachable provider costs the LINE and never the board', async () => {
    // From a COLD cache, or a warm one answers from memory and never reaches the provider — which
    // is the cache working and this assertion meaning nothing.
    _clearSeriesCache()
    const io = { fetchBars: async () => { throw new Error('provider down') } }
    assert.deepEqual(await seriesForTilt(doc(), { io }), {})
    assert.deepEqual(await closesFor('NOPE', Date.now() - DAY, Date.now(), io), [])
})

test('an unknown benchmark draws nothing rather than measuring against a guess', async () => {
    const io = { fetchBars: async () => recent(10, 100) }
    assert.deepEqual(await seriesForTilt(doc({ benchmark: 'NDX' }), { io }), {})
})

test('seconds and milliseconds both read as the same instant', async () => {
    // FMP hands back seconds, the Massive path milliseconds. Read one as the other and every bar
    // lands in 1970.
    const secs = [{ timestamp: Math.floor(Date.now() / 1000), close: 101 }]
    const ms   = [{ timestamp: Date.now(), close: 101 }]
    const a = await closesFor('A', 0, Date.now(), { fetchBars: async () => secs })
    const b = await closesFor('B', 0, Date.now(), { fetchBars: async () => ms })
    assert.ok(Math.abs(a[0].t - b[0].t) < 1000, 'both should land at the same second')
    assert.ok(a[0].t > Date.parse('2020-01-01'), 'not 1970')
})

test('a bar with no usable close is dropped, not carried as zero', async () => {
    const io = { fetchBars: async () => [
        { timestamp: Date.now(), close: 100 },
        { timestamp: Date.now(), close: null },
        { timestamp: Date.now(), close: 0 },
        { timestamp: Date.now(), close: 'x' },
    ] }
    assert.equal((await closesFor('C', 0, Date.now(), io)).length, 1)
})
