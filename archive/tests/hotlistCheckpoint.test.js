// The CHECKPOINT pass's own tests, moved out of the live suites when the day columns were archived (2026-10-25,
// docs/design/hotlist-day-archive.md). Kept whole for a revival; NOT run (archive/README.md). Fixtures they use from
// their old files are noted where missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../../tests/helpers/memDb.js'
import { runCheckpoint, BOARDS, wideRow, BOARD_MAX, poolRow } from '../services/dailyScreener.checkpoint.js'
import { runOutcomes, OUTCOMES, POOL_GRADE, summarize } from '../../services/hotlist.outcomes.js'
// From tests/unit/hotlistOutcomes.test.js: `rig` (a memDb with one mid board and FIVE/DAILY bars) — restore it with the test.

test('the checkpoint marks each pick in its column, ranked in that column\'s list; `pick` stays the first', async () => {
    const { db, rows } = memDb()
    for (const s of ['AAA', 'BBB']) {
        rows('daily_screener_stats').push({ symbol: s, day: '2026-10-20', close: 100, atr14: 4, atr_pct: 4, adv20_usd: 100e6, avg_vol20: 1e6,
            day_high: 101, high5: 103, high20: 106, high50: 110, high52w: 120, rs20: 3, nr7: true, next_earnings: '2026-10-27' })
    }
    await runCheckpoint({ deps: {
        db: async () => db, latestRun: async () => ({ day: '2026-10-20' }),
        news: async () => [], earnings: async () => [], grades: async () => [], movers: async () => [],
        extQuote: async () => ({ mid: 104, spreadPct: 0.02, volume: 30_000 }), quote: async () => null,
        label: async () => new Map(),
        argus: async (b) => {
            const syms = b.rows.map(r => r.symbol)
            return { summary: 's', model: 'm', avoid: [], picks: [
                { symbol: syms[0], column: 'open', why: 'o1' }, { symbol: syms[1], column: 'open', why: 'o2' },
                { symbol: syms[1], column: 'week', why: 'w1', caution: 'c' },
            ] }
        },
        perMinute: () => 6000, now: () => Date.parse('2026-10-21T12:05:00Z'), sleep: async () => {},
    } })
    const board = rows(BOARDS)[0]
    const [first, second] = board.rows
    assert.deepEqual(first.picks, { open: { why: 'o1', caution: undefined, rank: 1 } })
    assert.deepEqual(second.picks, { open: { why: 'o2', caution: undefined, rank: 2 }, week: { why: 'w1', caution: 'c', rank: 1 } })
    assert.equal(second.pick.column, 'open', 'the first pick on the row')
})

test('the checkpoint stores Argus\'s summary and marks picks and traps in place', async () => {
    const { db, rows } = memDb()
    rows('daily_screener_stats').push({ symbol: 'ABC', day: '2026-10-20', close: 100, atr14: 4, atr_pct: 4, adv20_usd: 100e6, avg_vol20: 1e6,
        day_high: 101, high5: 103, high20: 106, high50: 110, high52w: 120, rs20: 3, nr7: true, next_earnings: '2026-10-27' })
    await runCheckpoint({ deps: {
        db: async () => db, latestRun: async () => ({ day: '2026-10-20' }),
        news: async () => [], earnings: async () => [], grades: async () => [], movers: async () => [],
        extQuote: async () => ({ mid: 104, spreadPct: 0.02, volume: 30_000 }), quote: async () => null,
        label: async () => new Map(),
        argus: async (b) => ({ summary: 'One name in play.', model: 'gpt-6-luna', picks: [{ symbol: b.rows[0].symbol, column: 'open', why: 'gap on volume', caution: 'thin' }], avoid: [] }),
        perMinute: () => 6000, now: () => Date.parse('2026-10-21T12:05:00Z'), sleep: async () => {},
    } })
    const board = rows(BOARDS)[0]
    assert.equal(board.argus.summary, 'One name in play.')
    assert.equal(board.rows[0].pick.rank, 1)
    assert.equal(board.rows[0].pick.why, 'gap on volume')
})

test('a board stamps which of its columns are still unverified', async () => {
    const { db, rows } = memDb()
    rows('daily_screener_stats').push({ symbol: 'ABC', day: '2026-10-20', close: 100, atr14: 4, atr_pct: 4, adv20_usd: 100e6, avg_vol20: 1e6,
        day_high: 101, high5: 103, high20: 106, high50: 110, high52w: 120, rs20: 3, nr7: true, next_earnings: '2026-10-27' })
    const deps = {
        db: async () => db, latestRun: async () => ({ day: '2026-10-20' }),
        news: async () => [], earnings: async () => [], grades: async () => [], movers: async () => [],
        extQuote: async () => ({ mid: 104, spreadPct: 0.02, volume: 30_000 }), quote: async () => null,
        label: async () => new Map(), verified: async () => new Set(['week']),
        perMinute: () => 6000, now: () => Date.parse('2026-10-21T12:05:00Z'), sleep: async () => {},
    }
    await runCheckpoint({ deps })
    const board = rows(BOARDS)[0]
    assert.deepEqual(board.unverified_columns, ['open'])
    assert.equal(board.unverified, true)
})

test('the pool — quoted names graded on no column — is scored as the control group, never as a grade', async () => {
    const { poolRow } = await import('../../services/dailyScreener.checkpoint.js')
    const { POOL_GRADE } = await import('../../services/hotlist.outcomes.js')
    assert.deepEqual(poolRow('P', { mid: 10.5, price: 11 }, ['open', 'week'], { book: 'extended', quotedAt: 7 }),
        { symbol: 'P', price: 10.5, quoted_at: 7, pool: true, cells: { open: { grade: POOL_GRADE, range: { level: null, atr_mult: null, open_sky: false } }, week: { grade: POOL_GRADE, range: { level: null, atr_mult: null, open_sky: false } } } })
    assert.equal(poolRow('P', { price: 11 }, ['mid'], { book: 'session' }).price, 11)
    assert.equal(poolRow('P', { price: 0 }, ['mid'], { book: 'session' }), null)
    const { deps, rows } = rig()
    rows(BOARDS)[0].wide = [poolRow('POOL', { price: 30 }, ['mid'], { book: 'session' })]
    await runOutcomes({ force: true, deps })
    const pool = rows(OUTCOMES).find(o => o.symbol === 'POOL')
    assert.deepEqual([pool.grade, pool.shown, pool.outcome.reached], [POOL_GRADE, false, null], 'no level to reach — up or down only')
    const s = summarize(rows(OUTCOMES))
    assert.deepEqual([s.mid.n, s.mid.pool.n], [1, 1], 'the pool is not a grade and does not count toward verified')
})

// Code review 2026-10-24: a run-up week trade is OUT before its report — scored to the close before it, not through it.

test('(archived half) the checkpoint keeps the graded names past its cut, compactly; the client never gets them', async () => {
    const { wideRow, BOARD_MAX } = await import('../../services/dailyScreener.checkpoint.js')
    assert.equal(BOARD_MAX, 60)
    assert.deepEqual(wideRow({ symbol: 'A', price: 10, quoted_at: 5, why: 'long text', cells: { mid: { grade: 'B', why: ['x'], range: { level: 11, atr_mult: 0.5, pct: 10 } }, eod: { grade: null } } }),
        { symbol: 'A', price: 10, quoted_at: 5, cells: { mid: { grade: 'B', range: { level: 11, atr_mult: 0.5, open_sky: false } } } })
})
