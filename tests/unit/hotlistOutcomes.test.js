import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { fmpDateToEpochSec } from '../../providers/fmp.price.provider.js'
import {
    sessionsAfter, windowEnd, lastClosedSession, scoringWindow, windowBars, scoreWindow, summarize, columnVerified,
    runOutcomes, OUTCOMES, BOARDS, VERIFY_MIN_SESSIONS, VERIFY_MIN_SAMPLES,
} from '../../services/hotlist.outcomes.js'
import { runCheckpoint } from '../../services/dailyScreener.checkpoint.js'

// The hotlist's OUTCOME LOG (docs/design/daily-names.md §7, build phase 4): what every graded cell
// did afterwards, so a column's grades can stop being "unverified" — or be shown not to mean much.

const ET = (d, t) => fmpDateToEpochSec(`${d} ${t}:00`)
const bar = (ts, o, h, l, c) => ({ timestamp: ts, open: o, high: h, low: l, close: c, volume: 1 })

// ─── The calendar ─────────────────────────────────────────────────────────────

test('sessions skip the weekend; each column\'s window ends where it should', () => {
    assert.equal(sessionsAfter('2026-10-22', 1), '2026-10-23', 'Thu → Fri')
    assert.equal(sessionsAfter('2026-10-23', 1), '2026-10-26', 'Fri → Mon')
    assert.equal(windowEnd('2026-10-21', 'mid'), '2026-10-21')
    assert.equal(windowEnd('2026-10-23', 'tomorrow'), '2026-10-26')
    assert.equal(windowEnd('2026-10-21', 'week'), '2026-10-27', 'five sessions: Wed … Tue')
})

test('the last closed session, and when scoring may run', () => {
    assert.equal(lastClosedSession(Date.parse('2026-10-21T21:00:00Z')), '2026-10-21', 'Wed 17:00 ET')
    assert.equal(lastClosedSession(Date.parse('2026-10-21T15:00:00Z')), '2026-10-20', 'Wed 11:00 ET — today is not closed')
    assert.equal(lastClosedSession(Date.parse('2026-10-25T15:00:00Z')), '2026-10-23', 'Sunday → Friday')
    assert.equal(scoringWindow(Date.parse('2026-10-21T15:00:00Z')), false, 'mid-session: the quota is the checkpoints\'')
    assert.equal(scoringWindow(Date.parse('2026-10-21T21:00:00Z')), true)
    assert.equal(scoringWindow(Date.parse('2026-10-24T15:00:00Z')), true, 'Saturday')
})

// ─── The windows ──────────────────────────────────────────────────────────────

const DAY = '2026-10-21'
const HOURLY = ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30'].map((t, i) => bar(ET(DAY, t), 100 + i, 101 + i, 99 + i, 100.5 + i))
const DAILY = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28']
    .map((d, i) => bar(ET(d, '00:00'), 100 + i, 102 + i, 98 + i, 101 + i))

test('each column reads its own bars', () => {
    assert.deepEqual(windowBars('open', DAY, { hourly: HOURLY }).map(b => b.open), [100], 'the first hour only')
    assert.equal(windowBars('mid', DAY, { hourly: HOURLY }).length, 6, '10:30 to the close')
    assert.equal(windowBars('eod', DAY, { hourly: HOURLY }).length, 2, '14:30 and 15:30')
    assert.deepEqual(windowBars('tomorrow', DAY, { daily: DAILY }).map(b => b.open), [102], 'the NEXT session, not the board\'s')
    assert.equal(windowBars('week', DAY, { daily: DAILY }).length, 5)
    assert.equal(windowBars('week', DAY, { daily: DAILY })[0].open, 101, 'starting on the board\'s own day')
})

test('a window scores MFE, MAE, the return at its end, and whether the level was reached', () => {
    const s = scoreWindow({ entry: 100, level: 103 }, windowBars('mid', DAY, { hourly: HOURLY }))
    assert.deepEqual(s, { mfe_pct: 7, mae_pct: 0, ret_pct: 6.5, reached: true, bars: 6, end: DAY })
    assert.equal(scoreWindow({ entry: 100, level: null }, HOURLY.slice(0, 1)).reached, null, 'open sky has no level to reach')
    assert.equal(scoreWindow({ entry: 100, level: 103 }, []), null)
    assert.equal(scoreWindow({ entry: 100, level: 110 }, DAILY.slice(1, 3), 5).partial, true, 'two of the week\'s five sessions')
})

// ─── The summary ──────────────────────────────────────────────────────────────

test('summary: per column and grade — samples, the share that reached their level, the median move', () => {
    const o = (column, grade, reached, mfe, day = DAY) => ({ column, grade, day, outcome: { reached, mfe_pct: mfe, ret_pct: mfe / 2 } })
    const s = summarize([o('open', 'A', true, 4), o('open', 'A', false, 1), o('open', 'C', false, 0.5), o('week', 'B', null, 3), { column: 'mid', grade: 'A', outcome: null }])
    assert.equal(s.open.n, 3)
    assert.equal(s.open.grades.A.hit_rate, 50)
    assert.equal(s.open.grades.A.mfe_median, 2.5)
    assert.equal(s.open.grades.C.n, 1)
    assert.equal(s.week.grades.B.hit_rate, null, 'open sky only — nothing to judge')
    assert.equal(s.mid.n, 0, 'a cell with no outcome is not a sample')
    assert.equal(s.open.verified, false)
})

test('a column is verified on enough sessions AND enough samples — not either alone', () => {
    assert.equal(columnVerified({ n: VERIFY_MIN_SAMPLES, sessions: VERIFY_MIN_SESSIONS }), true)
    assert.equal(columnVerified({ n: 500, sessions: VERIFY_MIN_SESSIONS - 1 }), false, 'a busy fortnight is not eight weeks')
    assert.equal(columnVerified({ n: VERIFY_MIN_SAMPLES - 1, sessions: 100 }), false)
})

// ─── The run ──────────────────────────────────────────────────────────────────

const AFTER_CLOSE = Date.parse('2026-10-21T21:30:00Z')   // Wed 17:30 ET
const BOARD = {
    id: 'hb_2026-10-21_mid', day: DAY, checkpoint: 'mid', status: 'done', columns: ['mid'],
    rows: [
        { symbol: 'ABC', price: 100, cells: { mid: { grade: 'A', range: { level: 103, atr_mult: 1, open_sky: false } } } },
        { symbol: 'XYZ', price: 50, cells: { mid: { grade: null } } },
    ],
}

function rig(over = {}) {
    const { db, rows } = memDb()
    rows(BOARDS).push(structuredClone(BOARD))
    const calls = []
    const deps = {
        db: async () => db,
        hourly: async (sym) => { calls.push(sym); return HOURLY },
        daily: async () => DAILY,
        perMinute: () => 6000, now: () => AFTER_CLOSE, sleep: async () => {},
        ...over,
    }
    return { deps, rows, calls }
}

test('run: scores the graded cells of every closed window, once', async () => {
    const { deps, rows, calls } = rig()
    const r = await runOutcomes({ force: true, deps })
    assert.equal(r.outcome, 'done')
    assert.equal(r.scored, 1)
    assert.deepEqual(calls, ['ABC'], 'an ungraded cell costs no read')
    const o = rows(OUTCOMES)[0]
    assert.equal(o.id, 'hb_2026-10-21_mid:ABC:mid')
    assert.equal(o.grade, 'A')
    assert.equal(o.outcome.reached, true)
    assert.equal(rows(BOARDS)[0].scored.mid, true)

    assert.equal((await runOutcomes({ force: true, deps })).outcome, 'nothing_due', 'a scored column is not read again')
})

test('run: a window that has not closed yet is left for later', async () => {
    const { deps, rows } = rig({ now: () => Date.parse('2026-10-21T21:30:00Z') })
    rows(BOARDS)[0].columns = ['tomorrow']
    rows(BOARDS)[0].rows[0].cells = { tomorrow: { grade: 'B', range: { level: 104 } } }
    assert.equal((await runOutcomes({ force: true, deps })).outcome, 'nothing_due', 'tomorrow is Thursday')
})

test('run: missing bars are retried — until the window is long closed, then given up on', async () => {
    const empty = rig({ hourly: async () => [] })
    const r1 = await runOutcomes({ force: true, deps: empty.deps })
    assert.equal(r1.scored, 0)
    assert.equal(empty.rows(BOARDS)[0].scored, undefined, 'not marked: the bars may just be late')

    const late = rig({ hourly: async () => [], now: () => Date.parse('2026-10-27T21:30:00Z') })
    const r2 = await runOutcomes({ force: true, deps: late.deps })
    assert.equal(r2.gave_up, 1)
    assert.equal(late.rows(BOARDS)[0].scored.mid, true)
    assert.equal(late.rows(OUTCOMES)[0].outcome, null, 'recorded as no outcome — and summarize skips it')
})

test('run: a 429 stops the scoring', async () => {
    const { deps, rows } = rig({ hourly: async () => { throw Object.assign(new Error('429'), { status: 429 }) } })
    const r = await runOutcomes({ force: true, deps })
    assert.equal(r.outcome, 'partial')
    assert.equal(r.stopped, 'rate_limited')
    assert.equal(rows(OUTCOMES).length, 0)
})

test('run: mid-session it does not compete with the checkpoints for the quota', async () => {
    const { deps, calls } = rig({ now: () => Date.parse('2026-10-21T15:00:00Z') })
    assert.equal((await runOutcomes({ deps })).outcome, 'not_due')
    assert.equal(calls.length, 0)
})

// ─── The board's verified stamp ───────────────────────────────────────────────

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
