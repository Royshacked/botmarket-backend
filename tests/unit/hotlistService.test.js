import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { todayHotlist, dayList } from '../../services/hotlist.service.js'
import { BOARDS } from '../../services/hotlist.outcomes.js'
import { RUNS, RUN_STALE_MS } from '../../services/dailyScreener.service.js'

// The Hotlist's read side (services/hotlist.service.js): the latest board, and — since Roy asked for
// "an indication in the UI that it is running" (2026-10-22) — what the screener is doing right now
// and its latest finished overnight pass.

const NOW = Date.parse('2026-10-22T10:30:00Z')

async function rig({ runs = [], boards = [], latest = null } = {}) {
    const { db } = memDb()
    if (runs.length) await db.collection(RUNS).insertMany(runs)
    if (boards.length) await db.collection(BOARDS).insertMany(boards)
    return { db: async () => db, now: () => NOW, latestRun: async () => latest, summary: async () => null }
}

test('the overnight pass running shows as working, with its count', async () => {
    const deps = await rig({ runs: [{ id: 'ds_2026-10-21', day: '2026-10-21', status: 'running', started_at: NOW - 600_000, progress: { done: 425, of: 1512 } }] })
    const r = await todayHotlist({ deps })
    assert.deepEqual(r.working, { kind: 'overnight', day: '2026-10-21', started_at: NOW - 600_000, done: 425, of: 1512 })
    assert.equal(r.latest, null)
    assert.equal(r.stats, null)
})

test('a run just claimed, before its universe is read: working, count unknown', async () => {
    const deps = await rig({ runs: [{ id: 'ds_2026-10-21', day: '2026-10-21', status: 'running', started_at: NOW - 5_000 }] })
    const r = await todayHotlist({ deps })
    assert.equal(r.working.kind, 'overnight')
    assert.equal(r.working.done, null)
    assert.equal(r.working.of, null)
})

test('a pass whose heartbeat stopped is not shown as work, however recent its start', async () => {
    const deps = await rig({ runs: [{ id: 'ds_2026-10-21', day: '2026-10-21', status: 'running', started_at: NOW - 20 * 60_000, progress_at: NOW - 11 * 60_000 }] })
    assert.equal((await todayHotlist({ deps })).working, null)
})

test('a dead process\'s "running" is not shown as work', async () => {
    const deps = await rig({ runs: [{ id: 'ds_2026-10-20', day: '2026-10-20', status: 'running', started_at: NOW - RUN_STALE_MS - 1 }] })
    assert.equal((await todayHotlist({ deps })).working, null)
})

test('a checkpoint building its board wins over the overnight line, and rides along with the latest board', async () => {
    const deps = await rig({
        boards: [
            { id: 'hb_2026-10-22_premarket', day: '2026-10-22', checkpoint: 'premarket', status: 'done', finished_at: NOW - 3_600_000, rows: [] },
            { id: 'hb_2026-10-22_preopen', day: '2026-10-22', checkpoint: 'preopen', status: 'running', started_at: NOW - 60_000 },
        ],
        latest: { day: '2026-10-21', status: 'done', written: 1432, finished_at: NOW - 7_200_000 },
    })
    const r = await todayHotlist({ deps })
    assert.deepEqual(r.working, { kind: 'board', day: '2026-10-22', checkpoint: 'preopen', started_at: NOW - 60_000 })
    assert.equal(r.latest.id, 'hb_2026-10-22_premarket', 'the running board is not the latest board')
    assert.deepEqual(r.checkpoints.map(c => c.id), ['hb_2026-10-22_premarket'])
    assert.deepEqual(r.stats, { day: '2026-10-21', status: 'done', written: 1432, finished_at: NOW - 7_200_000 })
})

test('nothing running, a pass finished: stats, no working', async () => {
    const deps = await rig({ latest: { day: '2026-10-21', status: 'partial', written: 900, finished_at: NOW - 60_000 } })
    const r = await todayHotlist({ deps })
    assert.equal(r.working, null)
    assert.equal(r.stats.status, 'partial')
    assert.equal(r.stats.written, 900)
})

// ─── The day's watchlist (Roy, 2026-10-22) ───────────────────────────────────

const B = (id, checkpoint, finished_at, rows) => ({ id, day: '2026-10-22', checkpoint, status: 'done', columns: [], finished_at, rows })

test('day list: every name once — cells merged per column, each tied to the board it lives on', () => {
    const list = dayList([
        B('hb_pre', 'premarket', 1, [
            { symbol: 'ABC', price: 100, cells: { open: { grade: null }, week: { grade: 'B', path: 'scheduled' } }, pick: { why: 'run-up', rank: 1 } },
            { symbol: 'OLD', price: 50, cells: { week: { grade: 'C', path: 'accumulation' } } },
        ]),
        B('hb_mid', 'mid', 2, [
            { symbol: 'ABC', price: 103, cells: { mid: { grade: 'A' } } },
            { symbol: 'NEW', price: 20, cells: { mid: { grade: 'C' } }, avoid: 'thin' },
        ]),
    ])
    const abc = list.find(r => r.symbol === 'ABC')
    assert.equal(abc.price, 103, 'the latest board\'s price')
    assert.deepEqual(Object.keys(abc.cells).sort(), ['mid', 'week'], 'the ungraded open cell is not carried')
    assert.deepEqual(abc.cell_board, { week: 'hb_pre', mid: 'hb_mid' })
    assert.equal(abc.first_seen, 'premarket')
    assert.deepEqual(abc.seen, ['premarket', 'mid'])
    assert.equal(abc.pick, undefined, 'pick/avoid are the latest board\'s read of the name')
    assert.equal(abc.status, 'in_play')
    assert.equal(list.find(r => r.symbol === 'OLD').status, 'building')
    assert.equal(list.find(r => r.symbol === 'NEW').avoid, 'thin')
    // In play first, then building; alphabetical inside a status.
    assert.deepEqual(list.map(r => r.symbol), ['ABC', 'NEW', 'OLD'])
})

test('day list: picks lead; a row from before paths existed gets a status from its story', () => {
    const list = dayList([B('hb_pre', 'premarket', 1, [
        { symbol: 'AAA', cells: { week: { grade: 'C' } } },
        { symbol: 'ZZZ', cells: { week: { grade: 'B' } }, catalyst: { material: true }, pick: { rank: 1 } },
    ])])
    assert.deepEqual(list.map(r => [r.symbol, r.status]), [['ZZZ', 'in_play'], ['AAA', 'setting_up']])
    assert.deepEqual(dayList([]), [])
})

test('todayHotlist carries the day list', async () => {
    const deps = await rig({ boards: [B('hb_2026-10-22_mid', 'mid', NOW - 1000, [{ symbol: 'ABC', cells: { mid: { grade: 'A' } } }])] })
    const r = await todayHotlist({ deps })
    assert.deepEqual(r.day_list.map(x => x.symbol), ['ABC'])
    assert.equal(r.day_list[0].cell_board.mid, 'hb_2026-10-22_mid')
})

test('day list: a later board that quoted the name and left a column ungraded takes that grade back', () => {
    const list = dayList([
        B('hb_pre', 'premarket', 1, [
            { symbol: 'ABC', cells: { week: { grade: 'B', path: 'scheduled' } } },
            { symbol: 'GONE', cells: { week: { grade: 'C', path: 'scheduled' } } },
            { symbol: 'KEPT', cells: { week: { grade: 'C', path: 'scheduled' } } },
        ]),
        B('hb_open', 'preopen', 2, [
            { symbol: 'ABC', cells: { open: { grade: 'A' }, week: { grade: null } } },
            { symbol: 'GONE', cells: { open: { grade: null }, week: { grade: null } } },
        ]),
    ])
    const abc = list.find(r => r.symbol === 'ABC')
    assert.deepEqual(Object.keys(abc.cells), ['open'], '09:20 took the week B back')
    assert.deepEqual(abc.cell_board, { open: 'hb_open' })
    assert.equal(list.find(r => r.symbol === 'GONE'), undefined, 'every grade taken back: off the list')
    assert.equal(list.find(r => r.symbol === 'KEPT').cells.week.grade, 'C', 'not on the later board: maybe not quoted — kept')
})
