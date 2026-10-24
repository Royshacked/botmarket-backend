import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { nextReportFor, replaySymbol, summarizeReplay, replayWeek, backtestSummary, BACKTEST } from '../../services/hotlistBacktest.service.js'
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
    const s = summarizeReplay([o('A', 2, 'scheduled'), o('A', -1, 'accumulation'), o('C', 3, 'scheduled'), o(POOL_GRADE, 1), o(POOL_GRADE, -2)])
    assert.deepEqual([s.grades.A.n, s.grades.A.up_rate, s.grades.C.n, s.graded.n, s.pool.n, s.pool.up_rate], [2, 50, 1, 3, 2, 50])
    assert.deepEqual([s.paths.scheduled.n, s.paths.accumulation.n], [2, 1])
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
