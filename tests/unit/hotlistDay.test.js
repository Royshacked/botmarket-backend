import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import {
    runDayBoard, dueCheckpoint, nextCheckpoint, buildPool, structureNames, eligibleNames, catalystOf, boardRow, orderRows,
    dayBoards, todayBoards, CHECKPOINTS, DAY_BOARDS, BOARD_MAX, RETRY_429, NEWS_PER_NAME, MAX_ATTEMPTS,
} from '../../services/hotlist.day.js'
import { BOARDS } from '../../services/hotlist.boards.js'
import { COLLECTION as STATS } from '../../services/dailyScreener.service.js'
import { _tick } from '../../monitoring/dailyScreener.monitor.service.js'

// The DAY BOARDS (docs/design/argus-rework.md §3.3, revived 2026-11-11 from archive/services/dailyScreener.checkpoint.js):
// three boards, the pool + the hard gates + the in-play numbers — no grades, no labeller, no Argus read, no outcome log,
// and their own collection so This week never sees them.

// 2026-10-21 is a Wednesday, EDT (ET = UTC-4).
const AT = (et) => Date.parse(`2026-10-21T${et}:00-04:00`)

// ─── When ─────────────────────────────────────────────────────────────────────

test('three boards — 09:20, 10:30, 14:30 ET; 08:00 and 15:30 stay archived; a weekend has none', () => {
    assert.deepEqual(CHECKPOINTS.map(c => c.id), ['open', 'mid', 'eod'])
    assert.equal(dueCheckpoint(AT('09:25')).checkpoint.id, 'open')
    assert.equal(dueCheckpoint(AT('10:31')).checkpoint.id, 'mid')
    assert.equal(dueCheckpoint(AT('14:59')).checkpoint.id, 'eod')
    assert.equal(dueCheckpoint(AT('08:05')), null, 'the 08:00 board is archived')
    assert.equal(dueCheckpoint(AT('15:35')), null, 'the 15:30 board is archived')
    assert.equal(dueCheckpoint(AT('11:05')), null, '10:30 missed by more than its window')
    assert.equal(dueCheckpoint(Date.parse('2026-10-24T13:25:00Z')), null, 'Saturday')
})

test('the next board: its time today, null after the last and on a weekend', () => {
    assert.equal(nextCheckpoint(AT('08:00')), '09:20')
    assert.equal(nextCheckpoint(AT('09:30')), '09:20', 'still inside its window')
    assert.equal(nextCheckpoint(AT('12:00')), '14:30')
    assert.equal(nextCheckpoint(AT('16:00')), null)
    assert.equal(nextCheckpoint(Date.parse('2026-10-24T13:00:00Z')), null)
})

// ─── The pool ─────────────────────────────────────────────────────────────────

test('pool: earnings, rating changes, news, movers, structures — only eligible names, capped', () => {
    const have = new Set(['A', 'B', 'C', 'D', 'E'])
    const pool = buildPool({ earnings: new Set(['B']), grades: new Set(['C']), news: ['A', 'B', 'NOGATE'], movers: new Set(['D']), structure: ['E', 'A'] }, have)
    assert.deepEqual(pool, ['B', 'C', 'A', 'D', 'E'])
    assert.deepEqual(buildPool({ news: ['A', 'B', 'C'] }, have, 2), ['A', 'B'])
})

const S = { symbol: 'ABC', name: 'Abc', sector: 'Tech', close: 100, atr14: 4, atr_pct: 4, adv20_usd: 100e6, avg_vol20: 1_000_000,
    day_high: 101, high5: 103, high20: 101, rs20: 3, nr7: true, next_earnings: '2026-10-27', closes20: [98, 99, 100] }

test('eligible: the column\'s stats gates — price, dollar volume, ATR', () => {
    const stats = [S, { ...S, symbol: 'THIN', adv20_usd: 10e6 }, { ...S, symbol: 'CALM', atr_pct: 1 }, { ...S, symbol: 'PENNY', close: 3 }]
    assert.deepEqual([...eligibleNames(stats, 'mid')], ['ABC'])
})

test('structures: RS + a structure, strongest RS first; a report within a day is out', () => {
    const out = structureNames([
        { ...S, symbol: 'LOW', rs20: 1 }, { ...S, symbol: 'HIGH', rs20: 8 }, { ...S, symbol: 'WEAK', rs20: -2 },
        { ...S, symbol: 'TONIGHT', rs20: 9, next_earnings: '2026-10-21' },
    ], '2026-10-21')
    assert.deepEqual(out, ['HIGH', 'LOW'])
    assert.equal(structureNames(Array.from({ length: 70 }, (_, i) => ({ ...S, symbol: `S${i}` })), '2026-10-21').length, 60, 'capped')
})

// ─── The catalyst, by timestamp ───────────────────────────────────────────────

test('a catalyst is its headlines (newest first, capped) and the report / rating flags — no label, no model call', () => {
    const headlines = new Map([['ABC', [
        { title: 'old', at: '2026-10-21 05:00:00' }, { title: 'newest', at: '2026-10-21 08:59:00' },
        { title: 'mid', at: '2026-10-21 07:00:00' }, { title: 'older', at: '2026-10-21 04:00:00' },
    ]]])
    const c = catalystOf('ABC', { headlines, reported: new Set(['ABC']), rated: new Set() })
    assert.equal(c.news.length, NEWS_PER_NAME)
    assert.deepEqual(c.news.map(n => n.title), ['newest', 'mid', 'old'])
    assert.equal(c.earnings, true)
    assert.equal(c.rating, false)
    assert.equal(catalystOf('XYZ', { headlines, reported: new Set(), rated: new Set() }), null)
    assert.deepEqual(catalystOf('RTG', { headlines: new Map(), reported: new Set(), rated: new Set(['RTG']) }), { news: [], earnings: false, rating: true })
})

// ─── A row ────────────────────────────────────────────────────────────────────

const OPEN = { book: 'extended', etMin: 560, day: '2026-10-21' }

test('09:20 row: gap on pre-market volume → in play, with the numbers and why — and NO grade or free range', () => {
    const row = boardRow(S, { mid: 104, spreadPct: 0.02, volume: 30_000 }, 'open', { ...OPEN, quotedAt: 7 })
    assert.equal(row.gap_pct, 4)
    assert.equal(row.pm_vol_pct, 3)
    assert.equal(row.quoted_at, 7)
    assert.match(row.why[0], /gap \+4% on 3% of a day's volume pre-market/)
    assert.deepEqual(row.spark, [98, 99, 100])
    for (const gone of ['grade', 'cells', 'range', 'pick', 'avoid', 'status']) assert.equal(gone in row, false, gone)
})

test('09:20: a fresh catalyst by timestamp lets a smaller gap in (the archived "fresh news" path); none, and it is not in play', () => {
    const q = { mid: 102, spreadPct: 0.02, volume: 0 }
    const cat = { news: [{ title: 'ABC wins a contract', at: '2026-10-21 06:30:00' }], earnings: false, rating: false }
    assert.ok(boardRow(S, q, 'open', { ...OPEN, catalyst: cat }))
    assert.equal(boardRow(S, q, 'open', OPEN), null)
})

test('a failed gate is no row — the spread at 09:20, the dollar volume in session', () => {
    assert.equal(boardRow(S, { mid: 104, spreadPct: 0.2, volume: 30_000 }, 'open', OPEN), null)
    const thin = { ...S, adv20_usd: 10e6 }
    assert.equal(boardRow(thin, { price: 103, open: 101, previousClose: 100, dayHigh: 104, dayLow: 100, volume: 900_000 }, 'mid', { book: 'session', etMin: 630, day: '2026-10-21' }), null)
})

test('10:30 row: volume against an ordinary day so far, above the open → in play; where it sits in the day\'s range', () => {
    // 10:30 is 60 of 390 minutes: 400k shares is 2.6× an ordinary day's pace.
    const row = boardRow(S, { price: 103, open: 101, previousClose: 100, dayHigh: 104, dayLow: 100, volume: 400_000 }, 'mid', { book: 'session', etMin: 630, day: '2026-10-21' })
    assert.equal(row.rvol, 2.6)
    assert.equal(row.gap_pct, 3)
    assert.equal(row.range_pos, 0.75)
    assert.match(row.why[0], /2\.6× normal volume, above the open/)
    assert.equal(boardRow(S, { price: 100.5, open: 101, previousClose: 100, dayHigh: 104, dayLow: 100, volume: 400_000 }, 'mid', { book: 'session', etMin: 630, day: '2026-10-21' }), null, 'under the open')
})

test('the board\'s order is not a grade: a fresh catalyst first, then the biggest move either way, then volume', () => {
    const rows = orderRows([
        { symbol: 'BIG', gap_pct: 9, rvol: 1 }, { symbol: 'NEWS', gap_pct: 2, catalyst: { news: [] } },
        { symbol: 'DOWN', gap_pct: -10, rvol: 1 }, { symbol: 'VOL', gap_pct: 9, rvol: 5 }, null,
    ])
    assert.deepEqual(rows.map(r => r.symbol), ['NEWS', 'DOWN', 'VOL', 'BIG'])
})

// ─── The run ──────────────────────────────────────────────────────────────────

function rig(over = {}) {
    const { db, rows } = memDb()
    // QUIET is in the pool by structure (NR7) and never in play: the name a pass quotes for nothing.
    rows(STATS).push({ ...S, day: '2026-10-20' }, { ...S, symbol: 'QUIET', next_earnings: null, day: '2026-10-20' })
    const calls = []
    const deps = {
        db: async () => db,
        latestRun: async () => ({ day: '2026-10-20', breadth_above_sma20: 55, spy: { close: 600 } }),
        news: async () => [{ symbol: 'ABC', title: 'ABC wins a contract', publishedDate: '2026-10-21 06:30:00' }],
        earnings: async () => [],
        grades: async () => [],
        movers: async () => { calls.push('movers'); return [] },
        extQuote: async (s) => { calls.push(s); return s === 'ABC' ? { mid: 104, spreadPct: 0.02, volume: 30_000 } : { mid: 100.1, spreadPct: 0.02, volume: 10 } },
        quote: async () => { throw new Error('the session quote is not used before the open') },
        perMinute: () => 6000,
        now: () => AT('09:25'),
        sleep: async () => {},
        ...over,
    }
    return { deps, rows, calls }
}

test('run: pools, quotes the extended book and publishes ONE board in its OWN collection — never hotlist_boards', async () => {
    const { deps, rows, calls } = rig()
    const r = await runDayBoard({ deps })
    assert.equal(r.outcome, 'done')
    assert.equal(r.id, 'hd_2026-10-21_open')
    assert.ok(!calls.includes('movers'), 'movers are regular-session data — not read before the open')
    assert.equal(rows(BOARDS).length, 0, 'This week\'s collection is never written')
    const board = rows(DAY_BOARDS)[0]
    assert.equal(board.status, 'done')
    assert.equal(board.checkpoint, 'open')
    assert.equal(board.column, 'open')
    assert.deepEqual(board.rows.map(x => x.symbol), ['ABC'])
    assert.equal(board.rows[0].catalyst.news[0].title, 'ABC wins a contract')
    assert.deepEqual(board.counts, { pool: 2, quoted: 2, in_play: 1, headlines: 1 })
    assert.equal(board.regime.breadth_above_sma20, 55)
    assert.doesNotMatch(JSON.stringify(board), /"grade"|"unverified"|"argus"|"wide"|"labels"/)
})

test('run: in session the movers join the pool and the session quote is used', async () => {
    const { deps, rows, calls } = rig({
        now: () => AT('10:35'),
        movers: async (kind) => { calls.push(kind); return kind === 'gainers' ? [{ symbol: 'ABC' }] : [] },
        extQuote: async () => { throw new Error('not in session') },
        quote: async (s) => (s === 'ABC' ? { price: 103, open: 101, previousClose: 100, dayHigh: 104, dayLow: 100, volume: 400_000 } : { price: 100, open: 100, previousClose: 100, dayHigh: 100, dayLow: 100, volume: 10 }),
    })
    const r = await runDayBoard({ deps })
    assert.equal(r.id, 'hd_2026-10-21_mid')
    assert.deepEqual(calls, ['gainers', 'active'])
    assert.deepEqual(rows(DAY_BOARDS)[0].rows.map(x => x.symbol), ['ABC'])
})

const E429 = () => Object.assign(new Error('429'), { status: 429 })

test('run: a 429 that outlasts its retries publishes a PARTIAL board with what it has', async () => {
    const { deps, rows } = rig({ extQuote: async (s) => { if (s === 'QUIET') throw E429(); return { mid: 104, spreadPct: 0.02, volume: 30_000 } } })
    const r = await runDayBoard({ deps })
    assert.equal(r.outcome, 'partial')
    assert.equal(rows(DAY_BOARDS)[0].stopped, 'rate_limited')
    assert.equal(rows(DAY_BOARDS)[0].retried_429, RETRY_429)
})

test('run: a failed rating-changes read (not a 429) does not kill the board — the archived pass let it throw', async () => {
    const { deps } = rig({ grades: async () => { throw new Error('boom') } })
    assert.equal((await runDayBoard({ deps })).outcome, 'done')
})

test('run: one board per checkpoint; no overnight stats → nothing published; outside every window nothing is read', async () => {
    const a = rig()
    await runDayBoard({ deps: a.deps })
    assert.equal((await runDayBoard({ deps: a.deps })).outcome, 'exists')

    const b = rig({ latestRun: async () => null })
    assert.equal((await runDayBoard({ deps: b.deps })).outcome, 'no_stats')
    assert.equal(b.rows(DAY_BOARDS).length, 0)

    const c = rig({ now: () => AT('12:00') })
    assert.equal((await runDayBoard({ deps: c.deps })).outcome, 'not_due')
    assert.equal(c.calls.length, 0)
})

test('run: the board is CLAIMED — a second server that loses the claim reads nothing', async () => {
    const { deps, calls } = rig()
    const db = await deps.db()
    const real = db.collection.bind(db)
    db.collection = (name) => {
        const c = real(name)
        if (name !== DAY_BOARDS) return c
        return { ...c, updateOne: async (q, u, o) => { if (o?.upsert) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); return c.updateOne(q, u, o) } }
    }
    assert.equal((await runDayBoard({ deps })).outcome, 'already_running')
    assert.equal(calls.length, 0)
})

test('run: a board that ERRORS is marked so and retried in its window — at most MAX_ATTEMPTS (CR 2026-11-11)', async () => {
    let fail = true
    const { deps, rows } = rig({ latestRun: async () => { if (fail) throw new Error('stats down'); return { day: '2026-10-20', spy: null } } })
    // latestRun throws BEFORE the claim: nothing written, the next tick simply tries.
    assert.equal((await runDayBoard({ deps })).outcome, 'error')
    assert.equal(rows(DAY_BOARDS).length, 0)
    // A throw AFTER the claim: the board is marked error, not left running.
    fail = false
    const after = rig({ grades: async () => [], extQuote: async () => { throw Object.assign(new Error('boom'), { status: 500 }) } })
    const db = await after.deps.db()
    const real = db.collection.bind(db)
    let breakOnce = true
    db.collection = (name) => {
        const c = real(name)
        if (name !== DAY_BOARDS) return c
        return { ...c, updateOne: async (q, u, o) => { if (!o?.upsert && breakOnce && u.$set?.rows) { breakOnce = false; throw new Error('write failed') } return c.updateOne(q, u, o) } }
    }
    assert.equal((await runDayBoard({ deps: after.deps })).outcome, 'error')
    assert.equal(after.rows(DAY_BOARDS)[0].status, 'error')
    assert.equal((await runDayBoard({ deps: after.deps })).outcome, 'done', 'the next tick takes it again')
    // Three errors and it is left.
    const stuck = rig()
    stuck.rows(DAY_BOARDS).push({ id: 'hd_2026-10-21_open', day: '2026-10-21', status: 'error', attempts: MAX_ATTEMPTS })
    assert.equal((await runDayBoard({ deps: stuck.deps })).outcome, 'gave_up')
})

test('run: a board shows at most BOARD_MAX names', async () => {
    const many = Array.from({ length: BOARD_MAX + 5 }, (_, i) => ({ ...S, symbol: `N${i}`, day: '2026-10-20' }))
    // Every name has news, so the pool holds them all (structures alone are capped at 60).
    const { deps, rows } = rig({
        extQuote: async () => ({ mid: 104, spreadPct: 0.02, volume: 30_000 }),
        news: async (symbols) => symbols.map(s => ({ symbol: s, title: `${s} news`, publishedDate: '2026-10-21 06:30:00' })),
    })
    rows(STATS).push(...many)
    await runDayBoard({ deps })
    assert.equal(rows(DAY_BOARDS)[0].rows.length, BOARD_MAX)
    assert.equal(rows(DAY_BOARDS)[0].counts.in_play, BOARD_MAX + 7, 'every quoted name was in play; the board shows the first BOARD_MAX')
})

// ─── The read side ────────────────────────────────────────────────────────────

test('read: a day\'s boards oldest first, the days newest first; today\'s newest first; running boards are not shown', async () => {
    const { db, rows } = memDb()
    rows(DAY_BOARDS).push(
        { id: 'hd_2026-10-20_eod', day: '2026-10-20', checkpoint: 'eod', status: 'done', finished_at: 1, _id: 'x', started_at: 0, rows: [] },
        { id: 'hd_2026-10-21_open', day: '2026-10-21', checkpoint: 'open', status: 'done', finished_at: 2, rows: [] },
        { id: 'hd_2026-10-21_mid', day: '2026-10-21', checkpoint: 'mid', status: 'partial', finished_at: 3, rows: [] },
        { id: 'hd_2026-10-21_eod', day: '2026-10-21', checkpoint: 'eod', status: 'running', rows: [] },
    )
    const deps = { db: async () => db, now: () => AT('11:00') }
    const latest = await dayBoards({ deps })
    assert.equal(latest.day, '2026-10-21')
    assert.deepEqual(latest.boards.map(b => b.checkpoint), ['open', 'mid'])
    assert.deepEqual(latest.days, ['2026-10-21', '2026-10-20'])
    const past = await dayBoards({ day: '2026-10-20', deps })
    assert.deepEqual(past.boards.map(b => b.id), ['hd_2026-10-20_eod'])
    assert.equal('_id' in past.boards[0] || 'started_at' in past.boards[0], false, 'no Mongo id, no claim bookkeeping')
    assert.deepEqual((await todayBoards({ deps })).map(b => b.checkpoint), ['mid', 'open'])
    assert.deepEqual(await dayBoards({ deps: { db: async () => memDb().db } }), { day: null, boards: [], days: [] })
})

// ─── The monitor ──────────────────────────────────────────────────────────────

test('monitor: the overnight pass, then the day board, then the week board — and off means none', async () => {
    const order = []
    const step = (k) => async () => { order.push(k); return { outcome: 'not_due' } }
    const on = await _tick({ enabled: () => true, nightly: step('n'), dayBoard: async () => { order.push('d'); return { outcome: 'done' } }, week: step('w') })
    assert.deepEqual(order, ['n', 'd', 'w'])
    assert.equal(on.dayBoard, 'started', 'started, not awaited — the tick does not wait minutes on a board (CR 2026-11-11)')
    assert.deepEqual(await _tick({ enabled: () => false, nightly: step('x'), dayBoard: step('x') }), { outcome: 'off' })
    assert.deepEqual(order, ['n', 'd', 'w'])
})
