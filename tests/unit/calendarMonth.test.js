import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    calendarService, parseRange, parseDate, chunkRange, earningsRowsInRange, readEarningsRange, enrichFromCache, addDays,
} from '../../api/calendar/calendar.service.js'

// The Floor's month calendar (2026-10-14): counts per day for a grid, one day in full on a click.
// Providers are injected — no network.

const status = (fn) => { try { fn(); return null } catch (e) { return e.status } }

test('parseDate: a real YYYY-MM-DD passes, anything else is a 400', () => {
    assert.equal(parseDate('2026-10-14'), '2026-10-14')
    assert.equal(status(() => parseDate('2026-02-30')), 400)   // well-formed, not a date
    assert.equal(status(() => parseDate('2026-1-5')), 400)
    assert.equal(status(() => parseDate(undefined)), 400)
    assert.equal(status(() => parseDate('2026-10-14T00:00')), 400)
})

test('parseRange: ordered and at most 62 days, inclusive', () => {
    assert.deepEqual(parseRange('2026-09-28', '2026-11-08'), { from: '2026-09-28', to: '2026-11-08' })
    assert.deepEqual(parseRange('2026-10-01', addDays('2026-10-01', 61)), { from: '2026-10-01', to: '2026-12-01' })
    assert.equal(status(() => parseRange('2026-10-01', addDays('2026-10-01', 62))), 400)
    assert.equal(status(() => parseRange('2026-10-10', '2026-10-01')), 400)
    assert.equal(status(() => parseRange('2026-10-01')), 400)
})

test('chunkRange: consecutive windows, the last one clipped to `to`', () => {
    assert.deepEqual(chunkRange('2026-10-01', '2026-10-16'), [
        ['2026-10-01', '2026-10-07'], ['2026-10-08', '2026-10-14'], ['2026-10-15', '2026-10-16'],
    ])
    assert.deepEqual(chunkRange('2026-10-01', '2026-10-01'), [['2026-10-01', '2026-10-01']])
    assert.deepEqual(chunkRange('2026-10-30', '2026-11-02', 1).map(([d]) => d),
        ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
})

// Finnhub caps at 1,500 rows and drops the EARLIEST dates; in a capped answer only the earliest day
// it returned is cut (sampled 2026-10-14). So the later days are kept and the rest re-asked by day.
const full = (dates) => ({ earningsCalendar: Array.from({ length: 1500 }, (_, i) => ({ symbol: `X${i}`, date: dates[i % dates.length] })) })

test('earnings rows: a capped window keeps its whole days and re-asks only the cut ones', async () => {
    const calls = []
    const fetchRows = async (from, to) => {
        calls.push(`${from}|${to}`)
        if (from !== to) return full(['2025-01-08', '2025-01-09'])      // 06–07 missing, 08 cut
        return { earningsCalendar: [{ symbol: `D${from}`, date: from }] }
    }
    const rows = await earningsRowsInRange('2025-01-06', '2025-01-09', fetchRows)
    assert.deepEqual(calls, ['2025-01-06|2025-01-09', '2025-01-06|2025-01-06', '2025-01-07|2025-01-07', '2025-01-08|2025-01-08'])
    const per = rows.reduce((m, r) => ({ ...m, [r.date]: (m[r.date] ?? 0) + 1 }), {})
    assert.deepEqual(per, { '2025-01-06': 1, '2025-01-07': 1, '2025-01-08': 1, '2025-01-09': 750 })
})

test('earnings rows: a complete empty answer IS cached; a failed one is not', async () => {
    let n = 0
    const empty = async () => { n += 1; return { earningsCalendar: [] } }
    await earningsRowsInRange('2025-02-01', '2025-02-01', empty)     // a quiet Saturday
    await earningsRowsInRange('2025-02-01', '2025-02-01', empty)
    assert.equal(n, 1)

    let m = 0
    const down = async () => { m += 1; throw new Error('429') }
    assert.deepEqual(await earningsRowsInRange('2025-02-03', '2025-02-03', down), [])
    await earningsRowsInRange('2025-02-03', '2025-02-03', down)
    assert.equal(m, 2)
})

// The CR's medium finding: a day that failed inside a capped chunk must not be cached as part of it.
test('earnings rows: a capped window with a failed day is served but not cached', async () => {
    let failMonday = true
    const calls = []
    const fetchRows = async (from, to) => {
        calls.push(`${from}|${to}`)
        if (from !== to) return full(['2025-03-04', '2025-03-05'])
        if (from === '2025-03-03' && failMonday) throw new Error('429')
        return { earningsCalendar: [{ symbol: `D${from}`, date: from }] }
    }
    const first = await readEarningsRange('2025-03-03', '2025-03-05', fetchRows)
    assert.equal(first.complete, false)
    assert.ok(!first.rows.some(r => r.date === '2025-03-03'))

    failMonday = false
    const second = await readEarningsRange('2025-03-03', '2025-03-05', fetchRows)
    assert.equal(second.complete, true)
    assert.ok(second.rows.some(r => r.date === '2025-03-03'))
    assert.equal(calls.filter(c => c === '2025-03-03|2025-03-05').length, 2)   // re-asked, not served stale
})

test('counts: per day across all three feeds, deduped, clipped to the range', async () => {
    const out = await calendarService.getCounts('2026-10-01', '2026-10-09', {
        earningsRows: async (f, t) => [
            { symbol: 'AAPL', date: '2026-10-02' }, { symbol: 'AAPL', date: '2026-10-02' },   // duplicate
            { symbol: 'MSFT', date: '2026-10-02' }, { symbol: 'NVDA', date: '2026-10-08' },
        ].filter(r => r.date >= f && r.date <= t),
        fedEvents: async () => [{ date: '2026-10-02', event: 'Jobless Claims', impact: 'low' }, { date: '2026-10-30', event: 'outside' }],
        ipoRows:   async () => [{ date: '2026-10-08', symbol: 'NEW' }],
    })
    assert.deepEqual(out.days, {
        '2026-10-02': { earnings: 2, fed: 1, ipo: 0 },
        '2026-10-08': { earnings: 1, fed: 0, ipo: 1 },
    })
    assert.equal(out.from, '2026-10-01')
})

// An important release is NAMED on its day — only the high-impact ones, once each.
test('counts: names the day\'s high-impact Fed releases, not the minor ones', async () => {
    const none = async () => []
    const out = await calendarService.getCounts('2026-10-01', '2026-10-31', {
        earningsRows: none, ipoRows: none,
        fedEvents: async () => [
            { date: '2026-10-14', event: 'CPI (Inflation)', short: 'CPI', impact: 'high' },
            { date: '2026-10-14', event: 'Jobless Claims', short: 'Claims', impact: 'low' },
            { date: '2026-10-15', event: 'PPI', short: 'PPI', impact: 'medium' },
            { date: '2026-10-28', event: 'FOMC Rate Decision', short: 'FOMC', impact: 'high' },
            { date: '2026-10-29', event: 'GDP', impact: 'high' },                       // no short → event
            { date: '2026-10-29', event: 'PCE / Personal Income', short: 'PCE', impact: 'high' },
        ],
    })
    assert.deepEqual(out.days['2026-10-14'], { earnings: 0, fed: 2, ipo: 0, fedHigh: ['CPI'] })
    assert.equal(out.days['2026-10-15'].fedHigh, undefined)
    assert.deepEqual(out.days['2026-10-28'].fedHigh, ['FOMC'])
    assert.deepEqual(out.days['2026-10-29'].fedHigh, ['GDP', 'PCE'])
})

test('day: that date only, earnings biggest-first by revenue estimate', async () => {
    const out = await calendarService.getDay('2026-10-02', {
        earningsRows: async () => [
            { symbol: 'SMOL', date: '2026-10-02', revenueEstimate: 1e6 },
            { symbol: 'BIG',  date: '2026-10-02', revenueEstimate: 9e10 },
            { symbol: 'NONE', date: '2026-10-02' },
            { symbol: 'ELSE', date: '2026-10-03', revenueEstimate: 1e12 },
        ],
        fedEvents: async () => [{ date: '2026-10-02', event: 'Jobs' }, { date: '2026-10-03', event: 'x' }],
        ipoRows:   async () => [{ date: '2026-10-02', symbol: 'NEW', name: 'NewCo' }],
        enrich:    async (items) => items,
        enrichIpo: async (items) => items,
    })
    assert.deepEqual(out.earnings.map(r => r.symbol), ['BIG', 'SMOL', 'NONE'])
    assert.deepEqual(out.fed.map(e => e.event), ['Jobs'])
    assert.deepEqual(out.ipo.map(r => r.symbol), ['NEW'])
})

// A peak day runs 350+ names: cached profiles for all, live lookups only for the first misses.
test('enrichFromCache: cache for everyone, live calls capped and spent on the top of the list', async () => {
    const items = ['A', 'B', 'C', 'D', 'E'].map(symbol => ({ symbol }))
    const cached = { B: { name: 'Bee', logo: 'b.png' }, D: { name: 'Dee', logo: 'd.png' } }
    const live = []
    await enrichFromCache(items, {
        peek: async (s) => cached[s] ?? null,
        fetchProfile: async (s) => { live.push(s); return { name: `${s} Inc`, logo: null } },
        liveCap: 2,
    })
    assert.deepEqual(live.sort(), ['A', 'C'])
    assert.deepEqual(items.map(i => i.name ?? null), ['A Inc', 'Bee', 'C Inc', 'Dee', null])
})
