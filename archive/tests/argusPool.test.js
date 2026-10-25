import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../../tests/helpers/memDb.js'
import { boardRow, poolForArgus, runCheckpoint, POOL_FOR_ARGUS } from '../services/dailyScreener.checkpoint.js'
import { boardText, normalizeRead, argusRead, MAX_SPOTS } from '../../services/hotlist.argus.js'
import { BOARDS, argusRecord, POOL_GRADE } from '../../services/hotlist.outcomes.js'

// Argus reads the POOL (Roy, 2026-10-24: "let Argus read the pool") — the names the screener quoted but graded on no
// horizon: he may SPOT what its rules missed, and his spots are scored against the pool names he passed on.

const STATS = { symbol: 'AAA', close: 100, atr14: 4, atr_pct: 4, adv20_usd: 100e6, avg_vol20: 1e6,
    day_high: 101, high5: 103, high20: 106, high50: 110, high52w: 120, rs20: 3, nr7: true, next_earnings: '2026-10-27' }

test('an ungraded name keeps its facts when asked — every cell ungraded, the failed gate named', () => {
    const quiet = { ...STATS, symbol: 'QQQX', atr_pct: 1, nr7: false, rs20: -5, next_earnings: null }
    const opts = { book: 'extended', etMin: 8 * 60, day: '2026-10-21', catalyst: null }
    assert.equal(boardRow(quiet, { mid: 100, spreadPct: 0.02, volume: 1000 }, ['open', 'week'], opts), null)
    const kept = boardRow(quiet, { mid: 100, spreadPct: 0.02, volume: 1000 }, ['open', 'week'], { ...opts, keepUngraded: true })
    assert.equal(kept.symbol, 'QQQX')
    assert.ok(Object.values(kept.cells).every(c => c.grade == null))
    assert.equal(kept.cells.open.gate, 'atr')
})

test("the pool's most active names go to Argus: a material story first, then the biggest move, then volume", () => {
    const r = (symbol, gap, extra = {}) => ({ symbol, gap_pct: gap, rvol: 1, ...extra })
    const top = poolForArgus([r('SMALL', 0.5), r('BIGDOWN', -7), r('STORY', 1, { catalyst: { material: true } }), r('MID', 3), null], 3)
    assert.deepEqual(top.map(x => x.symbol), ['STORY', 'BIGDOWN', 'MID'])
    assert.equal(POOL_FOR_ARGUS, 40)
})

test('the board text carries the pool, each name with why it is on no column', () => {
    const text = boardText({ checkpoint: 'mid', day: '2026-10-21', columns: ['mid'], rows: [],
        pool: [{ symbol: 'PPP', price: 20, gap_pct: 6, rvol: 3, atr_pct: 2, catalyst: null, cells: { mid: { grade: null, gate: 'dollar_volume' } } },
            { symbol: 'QQQ', price: 10, gap_pct: 1, atr_pct: 4, cells: { mid: { grade: null } } }] })
    assert.match(text, /POOL \(quoted, in play on no column/)
    assert.match(text, /PPP .*\| on no column — mid: fails the dollar volume gate/)
    assert.match(text, /QQQ .*\| on no column — mid: did not qualify/)
})

test("a spot is held to the pool and to the board's columns, once per name and column, at most ten", () => {
    const board = { columns: ['mid'], rows: [{ symbol: 'ON', cells: { mid: { grade: 'B' } } }], pool: [{ symbol: 'P1' }, { symbol: 'P2' }] }
    const read = normalizeRead({ summary: 's', spots: [
        { symbol: 'p1', column: 'mid', why: 'real story', caution: 'thin' }, { symbol: 'P1', column: 'mid', why: 'again' },
        { symbol: 'ON', column: 'mid', why: 'on the board, not the pool' }, { symbol: 'P2', column: 'week', why: 'not this board' },
        { symbol: 'ZZZ', column: 'mid', why: 'not quoted' },
    ] }, board)
    assert.deepEqual(read.spots, [{ symbol: 'P1', column: 'mid', why: 'real story', caution: 'thin' }])
    assert.equal(MAX_SPOTS, 10)
})

test('a board with nothing graded is still read when it has a pool — his spots alone are an answer', async () => {
    let asked = null
    const read = await argusRead({ checkpoint: 'mid', columns: ['mid'], rows: [], pool: [{ symbol: 'P1', cells: { mid: { grade: null } } }] }, {
        model: async () => 'm', send: async ({ userText }) => { asked = userText; return '{"spots":[{"symbol":"P1","column":"mid","why":"missed"}]}' },
    })
    assert.match(asked, /POOL/)
    assert.deepEqual(read.spots.map(s => s.symbol), ['P1'])
    assert.equal(await argusRead({ rows: [], pool: [] }), null)
})

test('the checkpoint hands Argus the pool, and marks what he saw and spotted on the wide rows', async () => {
    const { db, rows } = memDb()
    rows('daily_screener_stats').push({ ...STATS, day: '2026-10-20' },
        { ...STATS, symbol: 'POOLX', day: '2026-10-20', nr7: false, rs20: -5, high5: 140, high20: 150, high50: 160, high52w: 170, next_earnings: null })
    let seenPool = null
    await runCheckpoint({ deps: {
        db: async () => db, latestRun: async () => ({ day: '2026-10-20' }),
        news: async () => [{ symbol: 'POOLX', title: 'POOLX wins a contract', publishedDate: '2026-10-21 06:00:00' }],
        earnings: async () => [], grades: async () => [], movers: async () => [],
        extQuote: async (s) => (s === 'POOLX' ? { mid: 100, spreadPct: 0.02, volume: 1000 } : { mid: 104, spreadPct: 0.02, volume: 30_000 }), quote: async () => null,
        label: async () => new Map(),
        argus: async (b) => { seenPool = b.pool.map(r => r.symbol); return { summary: 's', model: 'm', picks: [], avoid: [], spots: [{ symbol: 'POOLX', column: 'week', why: 'the contract', caution: 'small' }] } },
        perMinute: () => 6000, now: () => Date.parse('2026-10-21T12:05:00Z'), sleep: async () => {},
    } })
    const board = rows(BOARDS)[0]
    assert.deepEqual(seenPool, ['POOLX'])
    const w = board.wide.find(x => x.symbol === 'POOLX')
    assert.deepEqual([w.pool, w.seen, w.spot], [true, true, { week: { why: 'the contract', caution: 'small' } }])
    assert.deepEqual(board.argus.spots.map(s => s.symbol), ['POOLX'])
    assert.equal(board.argus.pool_read, 1)
})

test("his record: spots against the pool names he passed on — the ones he never saw stay out", () => {
    const boards = [{ id: 'b', argus: { summary: 's' }, rows: [] }]
    const o = (symbol, ret, extra) => ({ board: 'b', symbol, column: 'mid', grade: POOL_GRADE, shown: false, outcome: { ret_pct: ret, reached: null }, ...extra })
    const r = argusRecord([o('S', 3, { seen: true, spot: true }), o('P', -1, { seen: true }), o('P2', 2, { seen: true }), o('U', 5, {})], boards)
    assert.deepEqual([r.all.spot.n, r.all.spot.up_rate, r.all.passed.n, r.all.passed.up_rate], [1, 100, 2, 50])
    assert.equal(r.mid.spot.ret_mean, 3)
})
