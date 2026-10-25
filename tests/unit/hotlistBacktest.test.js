import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { nextReportFor, replaySymbol, summarizeReplay, replayWeek, backtestSummary, BACKTEST, distribution, groupStats } from '../../services/hotlistBacktest.service.js'
import { POOL_GRADE } from '../../services/hotlist.outcomes.js'
import { hotlistOutcomes } from '../../services/hotlist.service.js'

// The week replay (Roy, 2026-10-24: "can't we score retrospectively?") — the live rules over past sessions.

const DAY = 86_400_000
/** Weekday bars from `start` — `f(i)` gives { close, high?, low?, open?, volume? }; timestamps in seconds at 00:00 ET. */
function bars(start, n, f) {
    const out = []
    for (let t = Date.parse(`${start}T04:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const b = f(i++)
        out.push({ timestamp: t / 1000, open: b.open ?? b.close, high: b.high ?? b.close * 1.02, low: b.low ?? b.close * 0.98, close: b.close, volume: b.volume ?? 2e6 })
    }
    return out
}
const day = (b) => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

test('the report the overnight pass would have seen: first on or after the evening before, within 21 days', () => {
    const dates = ['2026-05-01', '2026-07-30', '2026-10-28']
    assert.equal(nextReportFor(dates, '2026-07-21'), '2026-07-30')
    assert.equal(nextReportFor(dates, '2026-07-31'), '2026-07-30', 'reported the evening before: still the one it saw')
    assert.equal(nextReportFor(dates, '2026-06-01'), null, 'none within 21 days')
})

test('a replayed session uses only what was known the evening before — and the open as the price', () => {
    // A strong, steady riser (RS over a flat SPY), a report 7 days ahead of the last replayed session.
    const b = bars('2025-06-02', 330, (i) => ({ close: 50 + i * 0.1, volume: 3e6 }))
    const spy = bars('2025-06-02', 330, () => ({ close: 500 }))
    const days = b.slice(-12, -5).map(day)
    const report = new Date(Date.parse(`${days.at(-1)}T12:00:00Z`) + 7 * DAY).toISOString().slice(0, 10)
    const rows = replaySymbol({ symbol: 'UP', bars: b, bench: spy, reports: [report], days })
    assert.ok(rows.length > 0)
    const last = rows.at(-1)
    assert.equal(last.day, days.at(-1))
    assert.ok(last.grade !== POOL_GRADE, 'a report in the window and RS: graded')
    assert.equal(last.path, 'scheduled')
    const i = b.findIndex(x => day(x) === last.day)
    assert.equal(last.outcome.ret_pct, Math.round((b[i + 4].close / b[i].open - 1) * 10000) / 100, 'entry at the open, out at the fifth close')
    // Changing the bars from D on cannot change D's grade: no lookahead.
    const shocked = b.map((x, k) => (k >= i ? { ...x, high: x.high * 3, close: x.close * 3, open: x.open } : x))
    assert.equal(replaySymbol({ symbol: 'UP', bars: shocked, bench: spy, reports: [report], days: [last.day] })[0].grade, last.grade)
})

test('a name that clears the gates but grades nothing is the pool; a failed gate or an incomplete window is out', () => {
    const flat = bars('2025-06-02', 330, (i) => ({ close: 50 - (i % 7) * 0.01, volume: 3e6, high: 52, low: 48 }))
    const spy = bars('2025-06-02', 330, (i) => ({ close: 500 + i }))
    const days = flat.slice(-3).map(day).concat(flat.slice(-10, -9).map(day))
    const rows = replaySymbol({ symbol: 'FLAT', bars: flat, bench: spy, reports: [], days })
    assert.ok(rows.every(r => r.grade === POOL_GRADE), 'no RS, no date, no money arriving: the pool')
    assert.ok(rows.every(r => r.day !== day(flat.at(-1))), 'the last sessions have no complete window')
    const thin = bars('2025-06-02', 330, () => ({ close: 50, volume: 10 }))
    assert.deepEqual(replaySymbol({ symbol: 'THIN', bars: thin, bench: spy, reports: [], days }), [], 'fails the dollar-volume gate')
})

test('the summary: per grade, per path, the graded set and the pool apart', () => {
    const o = (grade, ret, path = null) => ({ day: 'd', grade, path, outcome: { ret_pct: ret, reached: grade === POOL_GRADE ? null : ret > 1, mfe_pct: 2 } })
    const s = summarizeReplay([o('A', 2, 'scheduled'), o('A', -1, 'catalyst'), o('C', 3, 'scheduled'), o(POOL_GRADE, 1), o(POOL_GRADE, -2)])
    assert.deepEqual([s.grades.A.n, s.grades.A.up_rate, s.grades.C.n, s.graded.n, s.pool.n, s.pool.up_rate], [2, 50, 1, 3, 2, 50])
    assert.deepEqual([s.paths.scheduled.n, s.paths.catalyst.n, s.paths.accumulation], [2, 1, undefined], 'money arriving is gone (2026-10-24)')
    assert.equal(s.pool.hit_rate, null, 'the pool has no level to reach')
})

test('the run: today’s universe, SPY’s sessions, the calendar — one summary document, and the API carries it', async () => {
    const { db, rows } = memDb()
    rows('daily_screener_stats').push({ symbol: 'UP', day: '2026-10-23' }, { symbol: 'FLAT', day: '2026-10-23' })
    const up = bars('2025-06-02', 330, (i) => ({ close: 50 + i * 0.1, volume: 3e6 }))
    const flat = bars('2025-06-02', 330, (i) => ({ close: 50 - (i % 7) * 0.01, volume: 3e6, high: 52, low: 48 }))
    const spy = bars('2025-06-02', 330, () => ({ close: 500 }))
    const read = []
    const r = await replayWeek({ sessions: 20, deps: {
        db: async () => db, now: () => Date.parse('2026-10-24T15:00:00Z'), perMinute: () => 6000, sleep: async () => {},
        bars: async (s) => { read.push(s); return s === 'SPY' ? spy : s === 'UP' ? up : flat },
        earnings: async () => [{ symbol: 'UP', date: new Date(Date.parse(`${day(spy.at(-8))}T12:00:00Z`) + 7 * DAY).toISOString().slice(0, 10) }],
    } })
    assert.equal(r.outcome, 'done')
    assert.deepEqual(read, ['SPY', 'UP', 'FLAT'])
    assert.equal(r.sessions, 20)
    assert.equal(rows(BACKTEST).length, 1)
    assert.ok(r.summary.pool.n > 0)
    assert.match(r.caveats.join(' '), /survivorship/)
    const stored = await backtestSummary({ db: async () => db })
    assert.equal(stored.week.to, r.to)
    const api = await hotlistOutcomes({ summary: async () => ({ mid: { n: 1 } }), backtest: async () => stored })
    assert.equal(api.backtest.week.sessions, 20)
})

// Code review 2026-10-24: a replay that could not read the calendar, or was rate-limited, never replaces the stored one.
test('no calendar stops the replay; a rate-limited run is returned but not stored', async () => {
    const { db, rows } = memDb()
    rows('daily_screener_stats').push({ symbol: 'UP', day: '2026-10-23' }, { symbol: 'FLAT', day: '2026-10-23' })
    rows(BACKTEST).push({ id: 'week', column: 'week', sessions: 125, keep: true })
    const spy = bars('2025-06-02', 330, () => ({ close: 500 }))
    const up = bars('2025-06-02', 330, (i) => ({ close: 50 + i * 0.1, volume: 3e6 }))
    const base = { db: async () => db, now: () => Date.parse('2026-10-24T15:00:00Z'), perMinute: () => 6000, sleep: async () => {} }
    const noCal = await replayWeek({ sessions: 20, deps: { ...base, bars: async () => spy, earnings: async () => { throw new Error('429') } } })
    assert.equal(noCal.outcome, 'no_calendar')
    const limited = await replayWeek({ sessions: 20, deps: { ...base, earnings: async () => [],
        bars: async (s) => { if (s === 'FLAT') { const e = new Error('rate'); e.status = 429; throw e } return s === 'SPY' ? spy : up } } })
    assert.deepEqual([limited.ok, limited.outcome, limited.stopped], [false, 'partial', 'rate_limited'])
    assert.equal(rows(BACKTEST).length, 1)
    assert.equal(rows(BACKTEST)[0].keep, true, 'the complete replay stays')
})

// Roy, 2026-10-24: "why didn't we have the catalyst path?" — an earnings beat reported the session before stands in for
// that morning's positive drift label.
test('the catalyst proxy: an EPS beat of 5% (and a cent), revenue not missed', async () => {
    const { earningsBeat, BEAT_MIN } = await import('../../services/hotlistBacktest.service.js')
    assert.equal(BEAT_MIN, 0.05)
    assert.deepEqual(earningsBeat({ epsActual: 1.1, epsEstimated: 1, revenueActual: 105, revenueEstimated: 100 }),
        { material: true, type: 'drift', surprise: 'positive', proxy: 'earnings_beat' })
    assert.equal(earningsBeat({ epsActual: 1.04, epsEstimated: 1 }), null, 'a 4% beat is no surprise')
    assert.equal(earningsBeat({ epsActual: 0.105, epsEstimated: 0.1 }), null, 'a 5% beat under a cent is noise')
    assert.ok(earningsBeat({ epsActual: -0.1, epsEstimated: -0.3 }), 'a smaller loss than expected is a beat')
    assert.equal(earningsBeat({ epsActual: 1.2, epsEstimated: 1, revenueActual: 95, revenueEstimated: 100 }), null, 'revenue missed')
    assert.ok(earningsBeat({ epsActual: 1.2, epsEstimated: 1, revenueActual: null, revenueEstimated: 100 }), 'revenue unknown: EPS decides')
    assert.equal(earningsBeat({ epsActual: 1.2, epsEstimated: null }), null, 'no estimate, no surprise')
    assert.equal(earningsBeat({ epsActual: null, epsEstimated: 1 }), null, 'not reported yet')
    assert.equal(earningsBeat(undefined), null)
})

test('a beat reported the session before puts a name on the catalyst path; one reported that day does not (lookahead)', () => {
    const b = bars('2025-06-02', 330, (i) => ({ close: 50 + i * 0.1, volume: 2e6 }))
    const spy = bars('2025-06-02', 330, () => ({ close: 500 }))
    const days = b.slice(-12, -5).map(day)
    const D = days.at(-1)
    const prev = day(b[b.findIndex(x => day(x) === D) - 1])
    const beat = { epsActual: 1.2, epsEstimated: 1, revenueActual: 110, revenueEstimated: 100 }
    const on = replaySymbol({ symbol: 'UP', bars: b, bench: spy, reports: [prev], results: new Map([[prev, beat]]), days: [D] })
    assert.equal(on[0]?.path, 'catalyst')
    assert.ok(on[0].grade !== POOL_GRADE)
    const same = replaySymbol({ symbol: 'UP', bars: b, bench: spy, reports: [D], results: new Map([[D, beat]]), days: [D] })
    assert.notEqual(same[0]?.path, 'catalyst', 'a report dated D may come after the close')
})

test('the replay summary splits the catalyst path out', () => {
    const r = (path, ret) => ({ day: '2026-10-01', grade: 'B', path, outcome: { ret_pct: ret, mfe_pct: 1, reached: null } })
    const s = summarizeReplay([r('catalyst', 2), r('catalyst', -1), r('scheduled', 1),
        // The stand-in's variants count in their own line and nowhere else.
        { ...r('catalyst', 5), variant: 'small_move' }, { ...r('catalyst', -3), variant: 'day_two' }, { ...r('catalyst', 1), variant: 'day_two' }])
    assert.deepEqual([s.paths.catalyst.n, s.paths.scheduled.n, s.graded.n], [2, 1, 3])
    assert.deepEqual([s.catalyst_variants.next_open.n, s.catalyst_variants.small_move.n, s.catalyst_variants.day_two.n], [2, 1, 2])
    assert.equal(s.catalyst_variants.day_two.ret_mean, -1)
})

test("the stand-in's variants: a beat with a small move since before the report, and a beat two sessions back", async () => {
    const { catalystVariants, earningsBeat, SMALL_MOVE_MAX } = await import('../../services/hotlistBacktest.service.js')
    assert.equal(SMALL_MOVE_MAX, 3)
    const beatRow = { epsActual: 1.2, epsEstimated: 1 }
    const beat = earningsBeat(beatRow)
    const rows = [{ close: 100 }, { close: 101, open: 100.5 }, { open: 102, close: 103 }]   // i = 2: from 100 (before the report) to the 102 open
    const dateOf = ['d0', 'd1', 'd2']
    assert.deepEqual(catalystVariants({ rows, dateOf, i: 2, results: new Map(), beat }).map(v => v[0]), ['small_move'], '+2% since before the report')
    const ran = [{ close: 100 }, { close: 106 }, { open: 108, close: 109 }]
    assert.deepEqual(catalystVariants({ rows: ran, dateOf, i: 2, results: new Map(), beat }), [], '+8%: already ran')
    const down = [{ close: 100 }, { close: 98 }, { open: 97, close: 99 }]
    assert.deepEqual(catalystVariants({ rows: down, dateOf, i: 2, results: new Map(), beat }), [], 'a beat it sold off on: not a small move')
    const two = catalystVariants({ rows, dateOf, i: 2, results: new Map([['d0', beatRow]]), beat: null })
    assert.deepEqual(two.map(v => v[0]), ['day_two'], 'reported two sessions back: bought on the second day after it')
})

// Roy, 2026-10-24: "do you have a distribution of the percent profit?"
test('the distribution: percentiles, buckets, and a confidence range that counts each session once', () => {
    const o = (day, ret) => ({ day, outcome: { ret_pct: ret, reached: null, mfe_pct: 1 } })
    const xs = [o('a', -12), o('a', -1), o('a', 1), o('b', 3), o('b', 6), o('b', 11), o('c', 0), o('c', 0.5)]
    const d = distribution(xs)
    assert.deepEqual(d.buckets.map(b => b.n), [1, 0, 0, 1, 3, 1, 1, 1], '≤−10 · −10…−5 · −5…−2 · −2…0 · 0…2 · 2…5 · 5…10 · ≥10 (0 counts up)')
    assert.deepEqual([d.buckets[0].from, d.buckets[0].to, d.buckets.at(-1).from, d.buckets.at(-1).to], [null, -10, 10, null])
    assert.equal(d.buckets.reduce((s, b) => s + b.n, 0), 8)
    assert.equal(d.pcts.p50, 0.75)
    assert.equal(d.sessions, 3)
    // Session means: a −4, b +6.67, c +0.25 → their mean +0.97; the range spans the sessions, not the eight names.
    assert.equal(d.session_mean, 0.97)
    assert.ok(d.ci95[0] < 0 && d.ci95[1] > 5, 'three sessions far apart: a wide range')
    assert.equal(distribution([]), null)
    assert.equal(distribution([o('a', 1)]).ci95, null, 'one session: no range')
    assert.ok(groupStats(xs).dist.pcts.p95 > 6)
    assert.equal(groupStats([]).dist, null)
})
