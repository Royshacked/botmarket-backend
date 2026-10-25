import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../../tests/helpers/memDb.js'
import {
    daySnapshot, premarketSnapshot, dayCtx, openGapped, blocksFor, sessionPlan, replayDaySymbol, summarizeDayReplay, replayDays,
    BLOCK, PM_VOL_NOT_REPLAYED, DAY_CHECKPOINTS,
} from '../services/hotlistBacktest.day.js'
import { BACKTEST, backtestSummary } from '../../services/hotlistBacktest.service.js'
import { POOL_GRADE } from '../../services/hotlist.outcomes.js'

// The day replay (Roy, 2026-10-24: "replay the day columns") — the live day-column rules over past sessions, on quotes
// rebuilt from 5-minute bars.

const DAY = 86_400_000
/** Weekday daily bars from `start` — `f(i)` gives { close, open?, high?, low?, volume? }; timestamps at 00:00 ET (seconds). */
function bars(start, n, f) {
    const out = []
    for (let t = Date.parse(`${start}T04:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        const b = f(i++)
        out.push({ timestamp: t / 1000, open: b.open ?? b.close, high: b.high ?? b.close * 1.03, low: b.low ?? b.close * 0.97, close: b.close, volume: b.volume ?? 2e6 })
    }
    return out
}
const etDay = (b) => new Date(b.timestamp * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
/** One session's 5-minute bars (EDT), from `fromMin` ET: `f(k, etMin)` gives { close, open?, high?, low?, volume? }. */
function fiveMin(day, f, { fromMin = 9 * 60 + 30, toMin = 16 * 60 } = {}) {
    const out = []
    for (let m = fromMin, k = 0; m < toMin; m += 5, k++) {
        const b = f(k, m)
        const ts = Date.parse(`${day}T00:00:00Z`) / 1000 + (m + 4 * 60) * 60
        out.push({ timestamp: ts, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close, volume: b.volume ?? 1000 })
    }
    return out
}

test('the session quote at a checkpoint: the bars that END by then — a 10:25 bar closes at 10:30', () => {
    const s = fiveMin('2026-10-22', (k) => ({ close: 100 + k, high: 100 + k + 0.5, low: 100 + k - 0.5, open: 100 + k - 0.2, volume: 10 }))
    const q = daySnapshot(s, DAY_CHECKPOINTS.mid)
    assert.deepEqual(q, { price: 111, open: 99.8, dayHigh: 111.5, dayLow: 99.5, volume: 120 }, 'twelve bars, 09:30–10:25')
    assert.equal(daySnapshot(s, 9 * 60 + 30), null, 'nothing before the first bar ends')
    assert.equal(daySnapshot([], 630), null)
})

test('the 09:20 quote from the extended-hours bars: the pre-market only, the bar ending 09:20 the last', () => {
    const ext = fiveMin('2026-10-22', (k, m) => ({ close: m < 570 ? 50 + k * 0.01 : 99, volume: 5 }), { fromMin: 4 * 60, toMin: 11 * 60 })
    const q = premarketSnapshot(ext)
    assert.equal(q.price, 50 + 63 * 0.01, 'the 09:15 bar — 04:00 + 63 bars')
    assert.equal(q.volume, 64 * 5)
    assert.equal(premarketSnapshot([]), null)
})

test('the ctx a checkpoint would read: paced relative volume in session; the open on its 09:20 gap', () => {
    const stats = { close: 50, avg_vol20: 1e6 }
    const mid = dayCtx('mid', stats, { price: 52, open: 51, dayHigh: 52.5, dayLow: 50.8, volume: 300_000 }, { day: '2026-10-22' })
    assert.equal(mid.rvol, 1.95, '300k against a 1M day paced at 60 of 390 minutes')
    assert.deepEqual([mid.prevClose, mid.open, mid.dayHigh, mid.today], [50, 51, 52.5, '2026-10-22'])
    const open = dayCtx('open', stats, { price: 52, volume: 10 }, { day: '2026-10-22', catalyst: { material: true } })
    assert.equal(open.pmVolPct, PM_VOL_NOT_REPLAYED, 'pre-market volume is not replayable — taken as met')
    assert.equal(open.catalyst.material, true)
})

test('a gap day: OPEN_GAP_MIN at the open, half that with a beat', () => {
    assert.equal(openGapped(50, 51.5, null), true)
    assert.equal(openGapped(50, 50.5, null), false)
    assert.equal(openGapped(50, 50.5, { material: true }), true)
    assert.equal(openGapped(0, 51, null), false)
    assert.equal(openGapped(50, 49, { material: true }), false, 'a gap down never')
})

test('5-minute reads in blocks: only the blocks a planned day falls in', () => {
    const days = Array.from({ length: BLOCK * 3 }, (_, i) => `d${String(i).padStart(2, '0')}`)
    assert.deepEqual(blocksFor(days, new Set([days[1], days[BLOCK * 2 + 3]])).map(b => b[0]), [days[0], days[BLOCK * 2]])
    assert.deepEqual(blocksFor(days, new Set()), [])
})

test('the plan: a name below the gates on every day is not read for intraday', () => {
    const spy = bars('2025-06-02', 330, () => ({ close: 500 }))
    const cheap = bars('2025-06-02', 330, () => ({ close: 3 }))
    const days = spy.slice(-10).map(etDay)
    assert.equal(sessionPlan({ symbol: 'CHEAP', rows: cheap, bench: spy, days }).size, 0)
    const hot = bars('2025-06-02', 330, () => ({ close: 50 }))
    const plan = sessionPlan({ symbol: 'HOT', rows: hot, bench: spy, days })
    assert.equal(plan.size, 10)
    assert.deepEqual(plan.get(days[0]).gates, ['open', 'mid', 'eod', 'tomorrow'], '$100M a day, 6% ATR — every day column')
})

test('one name: in play at 10:30 is graded and scored from the 10:30 price; not in play is the pool', () => {
    const spy = bars('2025-06-02', 330, () => ({ close: 500 }))
    const rows = bars('2025-06-02', 330, () => ({ close: 50 }))
    const day = etDay(rows.at(-3))
    const plan = sessionPlan({ symbol: 'HOT', rows, bench: spy, days: [day] })
    // Up from 50.5 on 100k a bar (rvol ≈ 3.9 at 10:30), on to 53 by the close.
    const hot = fiveMin(day, (k) => ({ close: 50.5 + k * 0.03, volume: 100_000 }))
    const out = replayDaySymbol({ symbol: 'HOT', rows, plan, intraday: new Map([[day, hot]]) })
    const mid = out.find(r => r.column === 'mid')
    assert.notEqual(mid.grade, POOL_GRADE)
    assert.equal(mid.outcome.end, day)
    assert.ok(mid.outcome.ret_pct > 0, 'it kept rising after 10:30')
    assert.equal(out.find(r => r.column === 'open').grade, POOL_GRADE, 'a 1% gap is not in play at the open')
    // The same session on ordinary volume: in the pool on mid.
    const quiet = fiveMin(day, (k) => ({ close: 50.5 + k * 0.03, volume: 1_000 }))
    assert.equal(replayDaySymbol({ symbol: 'HOT', rows, plan, intraday: new Map([[day, quiet]]) }).find(r => r.column === 'mid').grade, POOL_GRADE)
    // No session bars: nothing.
    assert.deepEqual(replayDaySymbol({ symbol: 'HOT', rows, plan }), [])
})

test('the open: a 4% gap at 09:20 is in play on the gap; a beat makes a 2% one news', () => {
    const spy = bars('2025-06-02', 330, () => ({ close: 500 }))
    const rows = bars('2025-06-02', 330, () => ({ close: 50 }))
    const day = etDay(rows.at(-3))
    const session = fiveMin(day, (k) => ({ close: 52 + k * 0.01 }))
    const pm = (price) => new Map([[day, fiveMin(day, () => ({ close: price }), { fromMin: 4 * 60, toMin: 9 * 60 + 30 })]])
    const plan = sessionPlan({ symbol: 'GAP', rows, bench: spy, days: [day] })
    const gap = replayDaySymbol({ symbol: 'GAP', rows, plan, intraday: new Map([[day, session]]), premarket: pm(52) }).find(r => r.column === 'open')
    assert.equal(gap.path, 'gap')
    assert.equal(gap.outcome.bars, 12, 'the first hour')
    const beatPlan = new Map([...plan].map(([d, p]) => [d, { ...p, beat: { material: true, type: 'drift', surprise: 'positive' } }]))
    const news = replayDaySymbol({ symbol: 'GAP', rows, plan: beatPlan, intraday: new Map([[day, session]]), premarket: pm(51) }).find(r => r.column === 'open')
    assert.equal(news.path, 'catalyst')
    assert.equal(replayDaySymbol({ symbol: 'GAP', rows, plan, intraday: new Map([[day, session]]), premarket: pm(51) }).find(r => r.column === 'open').grade, POOL_GRADE, '2% without news is not')
})

test('the summary: per column, its grades, the graded set and the pool — the open by its way in', () => {
    const o = (column, grade, ret, path) => ({ day: 'd', column, grade, ...(path ? { path } : {}), outcome: { ret_pct: ret, reached: null, mfe_pct: 1 } })
    const s = summarizeDayReplay([o('mid', 'A', 1), o('mid', POOL_GRADE, -1), o('open', 'B', 2, 'gap'), o('open', 'A', -1, 'catalyst'), o('tomorrow', POOL_GRADE, 0.5)])
    assert.deepEqual([s.mid.graded.n, s.mid.pool.n, s.mid.grades.A.n], [1, 1, 1])
    assert.deepEqual([s.open.paths.gap.n, s.open.paths.catalyst.n, s.open.graded.n], [1, 1, 2])
    assert.equal(s.mid.paths, undefined, 'only the open has ways in')
    assert.deepEqual([s.eod.graded.n, s.tomorrow.pool.n], [0, 1])
})

test('the run: one summary per day column stored beside the week; a smoke run and a rate-limited one are not', async () => {
    const { db, rows } = memDb()
    rows('daily_screener_stats').push({ symbol: 'HOT', day: '2026-10-23' }, { symbol: 'CHEAP', day: '2026-10-23' })
    rows(BACKTEST).push({ id: 'week', column: 'week', sessions: 125 })
    const spy = bars('2025-06-02', 360, () => ({ close: 500 }))
    const hot = bars('2025-06-02', 360, () => ({ close: 50 }))
    const cheap = bars('2025-06-02', 360, () => ({ close: 3 }))
    const reads = []
    const base = {
        db: async () => db, now: () => Date.parse('2026-10-24T15:00:00Z'), perMinute: () => 6000, sleep: async () => {},
        bars: async (s) => (s === 'SPY' ? spy : s === 'HOT' ? hot : cheap),
        earnings: async () => [],
        intraday: async (s, from, to, extended) => {
            reads.push([s, from, to, extended])
            const ds = hot.map(etDay).filter(d => d >= from && d <= to)
            return ds.flatMap(d => fiveMin(d, (k) => ({ close: 50.5 + k * 0.03, volume: 100_000 })))
        },
    }
    const r = await replayDays({ sessions: 10, deps: base })
    assert.equal(r.outcome, 'done')
    assert.equal(r.sessions, 10)
    assert.ok(reads.every(([s]) => s === 'HOT'), 'a name under the gates gets no intraday read')
    assert.equal(reads.filter(x => !x[3]).length, Math.ceil(10 / BLOCK), 'one 5-minute read per block')
    assert.equal(reads.filter(x => x[3]).length, 0, 'no gap day, no pre-market read')
    assert.equal(r.reads, 1 + Math.ceil(10 / BLOCK) + 1, 'the reads counted: HOT daily + blocks + CHEAP daily')
    const stored = await backtestSummary({ db: async () => db })
    assert.deepEqual(Object.keys(stored).sort(), ['eod', 'mid', 'open', 'tomorrow', 'week'])
    assert.equal(stored.week.sessions, 125, 'the week replay untouched')
    assert.ok(stored.mid.summary.graded.n > 0)
    assert.equal(stored.mid.sessions, stored.mid.summary.sessions)
    assert.match(stored.open.caveats.join(' '), /pre-market volume/)

    rows(BACKTEST).length = 0
    const smoke = await replayDays({ sessions: 10, limit: 1, deps: base })
    assert.deepEqual([smoke.outcome, smoke.universe, rows(BACKTEST).length], ['smoke', 1, 0])
    const limited = await replayDays({ sessions: 10, deps: { ...base, intraday: async () => { const e = new Error('rate'); e.status = 429; throw e } } })
    assert.deepEqual([limited.ok, limited.outcome, limited.stopped, rows(BACKTEST).length], [false, 'partial', 'rate_limited', 0])
    assert.equal((await replayDays({ sessions: 10, deps: { ...base, earnings: async () => { throw new Error('402') } } })).outcome, 'no_calendar')
})
