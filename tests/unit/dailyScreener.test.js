import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { createPacer } from '../../services/concurrency.util.js'
import { screenerStats, breadthAboveSma20, MIN_BARS } from '../../services/dailyScreener.stats.js'
import { runNightly, dueSessionDay, COLLECTION, RUNS } from '../../services/dailyScreener.service.js'
import { _tick } from '../../monitoring/dailyScreener.monitor.service.js'

// DailyScreener's overnight pass (docs/design/daily-names.md §6, build phase 2). Off by default; when
// on, ~430 FMP reads a night on the key live pricing shares — so the pacing and the stop-on-429 are
// as much the point as the numbers.

// ─── The pacer ────────────────────────────────────────────────────────────────

test('pacer: N starts a minute, evenly spaced — the first one goes at once', async () => {
    let t = 0
    const slept = []
    const pace = createPacer({ perMinute: 60, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms } })
    await pace(); await pace(); await pace()
    assert.deepEqual(slept, [1000, 1000], '60 a minute = one a second; no wait before the first')
})

test('pacer: time that already passed is not slept again', async () => {
    let t = 0
    const slept = []
    const pace = createPacer({ perMinute: 30, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms } })
    await pace()
    t += 5000                    // the call itself took 5s of the 2s gap
    await pace()
    assert.deepEqual(slept, [])
})

// ─── The arithmetic ───────────────────────────────────────────────────────────

const DAY = 86_400
const T0  = Date.parse('2026-01-02T05:00:00Z') / 1000
/** n daily bars, close rising by `step`, a fixed 2-point range — deterministic. */
function series(n, { start = 100, step = 0.5, vol = 2_000_000 } = {}) {
    return Array.from({ length: n }, (_, i) => {
        const c = start + i * step
        return { timestamp: T0 + i * DAY, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: vol }
    })
}

test('stats: too few bars → null, not numbers made of nothing', () => {
    assert.equal(screenerStats(series(MIN_BARS - 1)), null)
    assert.equal(screenerStats(null), null)
})

test('stats: the gates, the overhead levels and relative strength', () => {
    const bars  = series(260)
    const bench = series(260, { start: 400, step: 0.5 })
    const s = screenerStats(bars, bench)
    const last = bars.at(-1)
    assert.equal(s.close, last.close)
    assert.equal(s.adv20_usd, Math.round(bars.slice(-20).reduce((a, b) => a + b.close * b.volume, 0) / 20))
    assert.equal(s.atr14, 2, 'a 2-point range with no gaps')
    assert.equal(s.atr_pct, Math.round((2 / last.close) * 10000) / 100)
    assert.equal(s.high20, last.high, 'a rising series: the overhead level is today\'s high')
    assert.equal(s.day_high, last.high)
    assert.equal(s.above_sma20, true)
    // Same point step on a 4× larger base → the stock outruns SPY in percent.
    assert.ok(s.rs20 > 0)
    assert.equal(s.last_date, new Date(last.timestamp * 1000).toISOString().slice(0, 10))
})

test('stats: relative strength is matched by SESSION, not by position', () => {
    const bars  = series(100)
    const bench = series(100, { start: 400 }).slice(0, 90)   // SPY lacks the last ten sessions
    const s = screenerStats(bars, bench)
    assert.equal(s.rs5, null, 'no SPY bar on the stock\'s last session → no comparison, not a wrong one')
})

test('stats: NR7 and the inside day', () => {
    const bars = series(80)
    const last = bars.at(-1), prev = bars.at(-2)
    bars[bars.length - 1] = { ...last, high: prev.high - 0.1, low: prev.low + 0.1 }   // narrower and inside
    const s = screenerStats(bars)
    assert.equal(s.nr7, true)
    assert.equal(s.inside_day, true)
    assert.equal(screenerStats(series(80)).inside_day, false)
})

test('breadth: the share closing above the 20-day average, ignoring unknowns', () => {
    assert.equal(breadthAboveSma20([{ above_sma20: true }, { above_sma20: false }, { above_sma20: true }, {}]), 66.7)
    assert.equal(breadthAboveSma20([]), null)
})

// ─── When it is due ───────────────────────────────────────────────────────────

test('due: after 18:00 ET on a weekday → that day; in session → not due', () => {
    assert.equal(dueSessionDay(Date.parse('2026-10-21T22:30:00Z')), '2026-10-21', 'Wed 18:30 EDT')
    assert.equal(dueSessionDay(Date.parse('2026-10-21T19:00:00Z')), null, 'Wed 15:00 EDT, the session')
})

test('due: before the open → the previous weekday, so a sleeping machine still catches up', () => {
    assert.equal(dueSessionDay(Date.parse('2026-10-22T10:00:00Z')), '2026-10-21', 'Thu 06:00 → Wed')
    assert.equal(dueSessionDay(Date.parse('2026-10-26T10:00:00Z')), '2026-10-23', 'Mon 06:00 → Fri')
})

test('due: a Saturday afternoon is not a session', () => {
    assert.equal(dueSessionDay(Date.parse('2026-10-24T20:00:00Z')), null)
})

// ─── The run ──────────────────────────────────────────────────────────────────

const WED_EVENING = Date.parse('2026-10-21T22:30:00Z')
const UNIVERSE = [
    { symbol: 'AAA', companyName: 'Aaa', sector: 'Technology', exchangeShortName: 'NYSE', marketCap: 5e9 },
    { symbol: 'BBB', companyName: 'Bbb', sector: 'Industrials', exchangeShortName: 'NASDAQ', marketCap: 2e9 },
    { symbol: 'CCC', companyName: 'Ccc', sector: 'Energy', exchangeShortName: 'NYSE', marketCap: 1e9 },
]

function rig(over = {}) {
    const { db, rows } = memDb()
    const calls = []
    const deps = {
        db: async () => db,
        universe: async () => UNIVERSE,
        bars: async (sym) => { calls.push(sym); return series(260) },
        earnings: async () => [{ symbol: 'BBB', date: '2026-10-28' }],
        perMinute: () => 6000,
        now: () => WED_EVENING,
        sleep: async () => {},
        ...over,
    }
    return { deps, rows, calls }
}

test('run: reads the benchmark, every name, writes one stats doc each and a done run', async () => {
    const { deps, rows, calls } = rig()
    const r = await runNightly({ deps })
    assert.equal(r.outcome, 'done')
    assert.equal(r.day, '2026-10-21')
    assert.deepEqual(calls, ['SPY', 'AAA', 'BBB', 'CCC'])
    assert.equal(rows(COLLECTION).length, 3)
    const bbb = rows(COLLECTION).find(d => d.symbol === 'BBB')
    assert.equal(bbb.next_earnings, '2026-10-28')
    assert.equal(bbb.day, '2026-10-21')
    const run = rows(RUNS)[0]
    assert.equal(run.status, 'done')
    assert.equal(run.written, 3)
    assert.equal(run.breadth_above_sma20, 100)
})

test('run: a 429 ENDS the pass — partial, with what it has, nothing retried through the quota', async () => {
    const { deps, rows, calls } = rig({
        bars: async (sym) => {
            calls.push(sym)
            if (sym === 'BBB') throw Object.assign(new Error('Too Many Requests'), { status: 429 })
            return series(260)
        },
    })
    const r = await runNightly({ deps })
    assert.equal(r.outcome, 'partial')
    assert.equal(r.stopped, 'rate_limited')
    assert.deepEqual(calls, ['SPY', 'AAA', 'BBB'], 'CCC is never asked')
    assert.equal(rows(COLLECTION).length, 1)
    assert.equal(rows(RUNS)[0].status, 'partial')
})

test('run: a partial run is retried ONCE, an hour later — not on every five-minute tick', async () => {
    let t = WED_EVENING
    let limited = true
    const { deps, calls } = rig({
        now: () => t,
        bars: async (sym) => {
            calls.push(sym)
            if (sym === 'BBB' && limited) throw Object.assign(new Error('Too Many Requests'), { status: 429 })
            return series(260)
        },
    })
    assert.equal((await runNightly({ deps })).outcome, 'partial')
    t += 5 * 60_000
    const tick = await runNightly({ deps })
    assert.equal(tick.outcome, 'exists', 'five minutes on: left alone')
    assert.equal(calls.length, 3, 'nothing read')

    t += 60 * 60_000
    assert.equal((await runNightly({ deps })).outcome, 'partial', 'an hour on: the one retry (still limited)')
    limited = false
    t += 2 * 60 * 60_000
    assert.equal((await runNightly({ deps })).outcome, 'exists', 'two attempts and done trying')
    assert.equal(calls.length, 6)
    assert.equal((await runNightly({ deps, force: true })).outcome, 'done', 'force still runs it')
})

test('run: an empty universe is tried again the same way, not every tick', async () => {
    let t = WED_EVENING, reads = 0
    const { deps } = rig({ now: () => t, universe: async () => { reads++; return [] } })
    assert.equal((await runNightly({ deps })).outcome, 'no_universe')
    t += 5 * 60_000
    await runNightly({ deps })
    assert.equal(reads, 1)
})

test('run: a bad ticker is skipped; a long run of failures is an outage and stops', async () => {
    const bad = rig({ bars: async (sym) => { if (sym === 'BBB') throw new Error('500'); return series(260) } })
    const r1 = await runNightly({ deps: bad.deps })
    assert.equal(r1.outcome, 'done')
    assert.equal(r1.failed, 1)
    assert.equal(r1.written, 2)

    const many = Array.from({ length: 40 }, (_, i) => ({ symbol: `X${i}`, exchangeShortName: 'NYSE' }))
    const down = rig({ universe: async () => many, bars: async (sym) => { if (sym === 'SPY') return series(260); throw new Error('ECONNRESET') } })
    const r2 = await runNightly({ deps: down.deps })
    assert.equal(r2.stopped, 'outage')
    assert.ok(r2.failed < many.length, 'it stopped before reading all forty')
})

test('run: once per day — a finished day is not read again, unless forced', async () => {
    const { deps, calls } = rig()
    await runNightly({ deps })
    const again = await runNightly({ deps })
    assert.equal(again.outcome, 'exists')
    assert.equal(calls.length, 4, 'no second pass of reads')
    const forced = await runNightly({ deps, force: true })
    assert.equal(forced.outcome, 'done')
})

test('run: not due in the session — nothing is read', async () => {
    const { deps, calls } = rig({ now: () => Date.parse('2026-10-21T19:00:00Z') })
    assert.equal((await runNightly({ deps })).outcome, 'not_due')
    assert.equal(calls.length, 0)
})

test('run: the pace is applied between reads', async () => {
    let t = WED_EVENING
    const slept = []
    const { deps } = rig({ perMinute: () => 60, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms } })
    await runNightly({ deps })
    // SPY, the earnings read, three names = five paced starts → four gaps of a second.
    assert.deepEqual(slept, [1000, 1000, 1000, 1000])
})

// ─── The monitor ──────────────────────────────────────────────────────────────

test('monitor: off by default — nothing runs', async () => {
    let ran = false
    const r = await _tick({ enabled: () => false, run: async () => { ran = true } })
    assert.deepEqual(r, { outcome: 'off' })
    assert.equal(ran, false)
})
