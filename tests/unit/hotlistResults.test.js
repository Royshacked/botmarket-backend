import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { cellResult, withResults, todayHotlist, boardWithResults } from '../../services/hotlist.service.js'
import { summarize, BOARDS, OUTCOMES } from '../../services/hotlist.outcomes.js'

// Did it work? (Roy, 2026-10-24) — every graded cell carries its result from the outcome log, and the grade its record.

const doc = (outcome, extra = {}) => ({ board: 'b1', symbol: 'AAA', column: 'mid', entry: 100, level: 103, outcome, ...extra })

test('a scored cell: reached its level, missed it, or — open sky — up or down by the close', () => {
    const at = { day: '2026-10-22', column: 'mid', closed: '2026-10-23' }
    assert.equal(cellResult(doc({ reached: true, ret_pct: 2, mfe_pct: 3.5, mae_pct: -0.4, end: '2026-10-22' }), at).state, 'reached')
    const missed = cellResult(doc({ reached: false, ret_pct: -0.8, mfe_pct: 1.2, mae_pct: -1.5, end: '2026-10-22' }), at)
    assert.deepEqual(missed, { state: 'missed', ret_pct: -0.8, mfe_pct: 1.2, mae_pct: -1.5, level: 103, entry: 100, end: '2026-10-22' })
    assert.equal(cellResult(doc({ reached: null, ret_pct: 1.9 }, { level: null }), at).state, 'up')
    assert.equal(cellResult(doc({ reached: null, ret_pct: -0.1 }, { level: null }), at).state, 'down')
    assert.equal(cellResult(doc(null), at).state, 'no_data')
    assert.equal(cellResult(doc({ reached: false, ret_pct: 0, partial: true }), at).partial, true)
})

test('an unscored cell: open while its window runs, scoring once it has closed', () => {
    // A week cell of Thu 22 Oct runs five sessions: to Wed 28 Oct.
    assert.deepEqual(cellResult(null, { day: '2026-10-22', column: 'week', closed: '2026-10-23' }), { state: 'open', ends: '2026-10-28' })
    assert.deepEqual(cellResult(null, { day: '2026-10-22', column: 'mid', closed: '2026-10-22' }), { state: 'scoring', ends: '2026-10-22' })
    assert.equal(cellResult(null, { day: '2026-10-22', column: 'tomorrow', closed: '2026-10-22' }).state, 'open', 'tomorrow is the next session')
})

test('each graded column of a row gets the result of the board its cell lives on', () => {
    const rows = [{ symbol: 'AAA', board: 'b2', cell_board: { mid: 'b1', eod: 'b2' }, cells: { mid: { grade: 'A' }, eod: { grade: 'B' }, week: { grade: null } } }, { symbol: 'NONE', cells: {} }]
    const outcomes = [doc({ reached: true, ret_pct: 2 }), doc({ reached: false, ret_pct: -1 }, { board: 'b2', column: 'eod' }), doc({ reached: false }, { board: 'b2', column: 'mid' })]
    const [a, none] = withResults(rows, outcomes, { day: '2026-10-22', closed: '2026-10-23', boardOf: (r, col) => r.cell_board[col] })
    assert.deepEqual(Object.keys(a.results).sort(), ['eod', 'mid'], 'ungraded columns get none')
    assert.equal(a.results.mid.state, 'reached', "the mid cell lives on b1 — b2's mid outcome is not this cell's")
    assert.equal(a.results.eod.state, 'missed')
    assert.equal(none.results, undefined)
})

test('the record per grade: the hit rate over names with a level, and the up rate over every name', () => {
    const o = (grade, reached, ret) => ({ column: 'mid', day: '2026-10-22', grade, outcome: { reached, ret_pct: ret, mfe_pct: 1 } })
    const s = summarize([o('A', true, 2), o('A', false, -1), o('A', null, 1.5), o('B', false, 0.5)])
    assert.deepEqual([s.mid.grades.A.n, s.mid.grades.A.judged, s.mid.grades.A.hit_rate, s.mid.grades.A.up_rate], [3, 2, 50, 66.7])
    assert.deepEqual([s.mid.grades.B.hit_rate, s.mid.grades.B.up_rate], [0, 100])
    assert.equal(s.mid.grades.C.up_rate, null)
})

test('the day list and the board carry results; the API lists the days there are lists for, newest first', async () => {
    const { db, rows } = memDb()
    const board = (day, cp, extra = {}) => ({ id: `hb_${day}_${cp}`, day, checkpoint: cp, status: 'done', finished_at: Date.parse(`${day}T15:00:00Z`), columns: ['mid'],
        rows: [{ symbol: 'AAA', price: 100, cells: { mid: { grade: 'A', range: { level: 103 } } } }], ...extra })
    rows(BOARDS).push(board('2026-10-21', 'mid'), board('2026-10-22', 'mid'), { ...board('2026-10-23', 'mid'), status: 'running' })
    rows(OUTCOMES).push({ id: 'hb_2026-10-21_mid:AAA:mid', board: 'hb_2026-10-21_mid', day: '2026-10-21', symbol: 'AAA', column: 'mid', entry: 100, level: 103,
        outcome: { reached: true, ret_pct: 2.5, mfe_pct: 3.2, mae_pct: -0.3, end: '2026-10-21' } })
    const deps = { db: async () => db, now: () => Date.parse('2026-10-22T23:30:00Z'), latestRun: async () => null, summary: async () => ({}) }
    const t = await todayHotlist({ day: '2026-10-21', deps })
    assert.deepEqual(t.days, ['2026-10-22', '2026-10-21'], 'a running board is not a list yet')
    assert.equal(t.day_list[0].results.mid.state, 'reached')
    assert.equal(t.latest.rows[0].results.mid.ret_pct, 2.5)
    const today = await todayHotlist({ deps })
    assert.equal(today.day_list[0].results.mid.state, 'scoring', "22 Oct's mid window closed at 18:00 ET; the pass has not scored it yet")
    const b = await boardWithResults('hb_2026-10-21_mid', deps)
    assert.equal(b.rows[0].results.mid.state, 'reached')
})

// Argus's record (Roy, 2026-10-24: "why did Argus say avoid?") — his picks, avoids and unmarked names, side by side.
test("Argus's record: picks (per column), avoids (the row's) and unmarked, each by how often it ended up; boards he did not read are out", async () => {
    const { argusRecord } = await import('../../services/hotlist.outcomes.js')
    const o = (board, symbol, column, ret, reached = null) => ({ board, symbol, column, outcome: { ret_pct: ret, reached } })
    const boards = [
        { id: 'b1', argus: { summary: 's' }, rows: [{ symbol: 'PK', picks: { mid: { rank: 1 } } }, { symbol: 'AV', avoid: 'too little room' }, { symbol: 'UN' }, { symbol: 'OLD', pick: { column: 'eod' } }] },
        { id: 'b2', argus: null, rows: [{ symbol: 'XX' }] },
    ]
    const r = argusRecord([o('b1', 'PK', 'mid', 2, true), o('b1', 'PK', 'eod', -1), o('b1', 'AV', 'mid', 1, true), o('b1', 'UN', 'mid', -2, false),
        o('b1', 'OLD', 'eod', 3), o('b2', 'XX', 'mid', 5), { board: 'b1', symbol: 'UN', column: 'mid', outcome: null }], boards)
    assert.deepEqual([r.all.pick.n, r.all.avoid.n, r.all.unmarked.n], [2, 1, 2], "PK's eod is unmarked (picked for mid only); OLD's legacy pick counts on its column; b2 is out")
    assert.deepEqual([r.all.pick.up_rate, r.all.pick.ret_mean, r.all.pick.hit_rate], [100, 2.5, 100])
    assert.deepEqual([r.mid.pick.n, r.mid.avoid.up_rate, r.mid.unmarked.ret_mean], [1, 100, -2])
    assert.equal(r.eod.unmarked.n, 1)
})

test("the API's outcomes carry Argus's record beside the columns — and stay whole when it fails", async () => {
    const { hotlistOutcomes } = await import('../../services/hotlist.service.js')
    const summary = { mid: { n: 3 } }
    assert.deepEqual(await hotlistOutcomes({ summary: async () => summary, argus: async () => ({ all: { pick: { n: 1 } } }) }), { mid: { n: 3 }, argus: { all: { pick: { n: 1 } } } })
    assert.deepEqual(await hotlistOutcomes({ summary: async () => summary, argus: async () => { throw new Error('down') } }), { mid: { n: 3 } })
})
