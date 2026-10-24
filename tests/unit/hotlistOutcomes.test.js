import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { fmpDateToEpochSec } from '../../providers/fmp.price.provider.js'
import {
    sessionsAfter, windowEnd, lastClosedSession, scoringWindow, windowBars, windowPartial, scoreWindow, summarize, columnVerified,
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
    assert.equal(lastClosedSession(Date.parse('2026-10-21T22:00:00Z')), '2026-10-21', 'Wed 18:00 ET')
    assert.equal(lastClosedSession(Date.parse('2026-10-21T21:00:00Z')), '2026-10-20', 'Wed 17:00 ET — FMP may not have the close yet')
    assert.equal(lastClosedSession(Date.parse('2026-10-21T15:00:00Z')), '2026-10-20', 'Wed 11:00 ET — today is not closed')
    assert.equal(lastClosedSession(Date.parse('2026-10-25T15:00:00Z')), '2026-10-23', 'Sunday → Friday')
    assert.equal(scoringWindow(Date.parse('2026-10-21T15:00:00Z')), false, 'mid-session: the quota is the checkpoints\'')
    assert.equal(scoringWindow(Date.parse('2026-10-21T21:00:00Z')), true)
    assert.equal(scoringWindow(Date.parse('2026-10-24T15:00:00Z')), true, 'Saturday')
})

// ─── The windows ──────────────────────────────────────────────────────────────

const DAY = '2026-10-21'
/** The session in 5-minute bars, 09:30 … 15:55: bar i opens at 100 + 0.1·i, ±1 around it. */
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const FIVE = Array.from({ length: 78 }, (_, i) => { const o = 100 + i / 10; return bar(ET(DAY, hhmm(570 + 5 * i)), o, o + 1, o - 1, o + 0.5) })
const QUOTED_1033 = ET(DAY, '10:33') * 1000
const DAILY = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28']
    .map((d, i) => bar(ET(d, '00:00'), 100 + i, 102 + i, 98 + i, 101 + i))

test('each column reads its own bars', () => {
    assert.equal(windowBars('open', DAY, { intraday: FIVE }).length, 12, 'the first hour only')
    assert.equal(windowBars('mid', DAY, { intraday: FIVE }).length, 66, '10:30 to the close, when the quote time is unknown')
    assert.equal(windowBars('eod', DAY, { intraday: FIVE }).length, 18, '14:30 to the close')
    assert.deepEqual(windowBars('tomorrow', DAY, { daily: DAILY }).map(b => b.open), [102], 'the NEXT session, not the board\'s')
    assert.equal(windowBars('week', DAY, { daily: DAILY }).length, 5)
    assert.equal(windowBars('week', DAY, { daily: DAILY })[0].open, 101, 'starting on the board\'s own day')
})

test('mid and eod start at the first bar AFTER the quote — a high printed before the entry does not count', () => {
    const spiked = FIVE.map(b => (b.timestamp === ET(DAY, '10:30') ? { ...b, high: 120 } : b))
    const win = windowBars('mid', DAY, { intraday: spiked }, { after: QUOTED_1033 })
    assert.equal(win.length, 65)
    assert.equal(win[0].timestamp, ET(DAY, '10:35'), 'the 10:30 bar began before a 10:33 quote')
    assert.equal(scoreWindow({ entry: 101, level: 115 }, win).reached, false, 'the 10:30 spike to 120 was before the entry')
})

test('a window scores MFE, MAE, the return at its end, and whether the level was reached', () => {
    const s = scoreWindow({ entry: 100, level: 103 }, windowBars('mid', DAY, { intraday: FIVE }, { after: QUOTED_1033 }))
    assert.deepEqual(s, { mfe_pct: 8.7, mae_pct: 0.3, ret_pct: 8.2, reached: true, bars: 65, end: DAY })
    assert.equal(scoreWindow({ entry: 100, level: null }, FIVE.slice(0, 1)).reached, null, 'open sky has no level to reach')
    assert.equal(scoreWindow({ entry: 100, level: 103 }, []), null)
    assert.equal(scoreWindow({ entry: 100, level: 110 }, DAILY.slice(1, 3), true).partial, true)
})

test('a window short of what it spans is partial: the close not in, a session missing', () => {
    assert.equal(windowPartial('mid', windowBars('mid', DAY, { intraday: FIVE })), false)
    assert.equal(windowPartial('mid', windowBars('mid', DAY, { intraday: FIVE.slice(0, 50) })), true, 'stops at 13:35')
    assert.equal(windowPartial('open', windowBars('open', DAY, { intraday: FIVE })), false)
    assert.equal(windowPartial('week', DAILY.slice(1, 3)), true, 'two of the week\'s five sessions')
    assert.equal(windowPartial('tomorrow', DAILY.slice(2, 3)), false)
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

const AFTER_CLOSE = Date.parse('2026-10-21T22:30:00Z')   // Wed 18:30 ET
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
        intraday: async (sym) => { calls.push(sym); return FIVE },
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
    const empty = rig({ intraday: async () => [] })
    const r1 = await runOutcomes({ force: true, deps: empty.deps })
    assert.equal(r1.scored, 0)
    assert.equal(empty.rows(BOARDS)[0].scored, undefined, 'not marked: the bars may just be late')

    const late = rig({ intraday: async () => [], now: () => Date.parse('2026-10-27T22:30:00Z') })
    const r2 = await runOutcomes({ force: true, deps: late.deps })
    assert.equal(r2.gave_up, 1)
    assert.equal(late.rows(BOARDS)[0].scored.mid, true)
    assert.equal(late.rows(OUTCOMES)[0].outcome, null, 'recorded as no outcome — and summarize skips it')
})

test('run: a SHORT window is read again, not written for good — and kept, flagged, once it is long closed', async () => {
    const short = rig({ intraday: async () => FIVE.slice(0, 50) })
    await runOutcomes({ force: true, deps: short.deps })
    assert.equal(short.rows(BOARDS)[0].scored, undefined, 'FMP may not have the afternoon yet')
    assert.equal(short.rows(OUTCOMES).length, 0)

    const late = rig({ intraday: async () => FIVE.slice(0, 50), now: () => Date.parse('2026-10-27T22:30:00Z') })
    await runOutcomes({ force: true, deps: late.deps })
    assert.equal(late.rows(BOARDS)[0].scored.mid, true)
    assert.equal(late.rows(OUTCOMES)[0].outcome.partial, true)
})

test('run: the log keeps ~120 sessions', async () => {
    const { deps, rows } = rig()
    rows(OUTCOMES).push({ id: 'old', day: '2026-01-05', column: 'mid' }, { id: 'recent', day: '2026-09-01', column: 'mid' })
    await runOutcomes({ force: true, deps })
    assert.deepEqual(rows(OUTCOMES).map(o => o.id).sort(), ['hb_2026-10-21_mid:ABC:mid', 'recent'])
})

test('run: a 429 stops the scoring', async () => {
    const { deps, rows } = rig({ intraday: async () => { throw Object.assign(new Error('429'), { status: 429 }) } })
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

// ─── The wide set (Roy, 2026-10-24: "with the analysis we lose good statistics") ───

test('the wide set: every graded name past the board is scored too, marked not shown', async () => {
    const { deps, rows, calls } = rig()
    rows(BOARDS)[0].wide = [{ symbol: 'OFF', price: 20, cells: { mid: { grade: 'C', range: { level: 20.2, atr_mult: 0.2, open_sky: false } } } }]
    const r = await runOutcomes({ force: true, deps })
    assert.equal(r.scored, 2)
    assert.deepEqual(calls.sort(), ['ABC', 'OFF'])
    const by = Object.fromEntries(rows(OUTCOMES).map(o => [o.symbol, o.shown]))
    assert.deepEqual(by, { ABC: true, OFF: false })
})

test('the wide set is kept 60 days, the board 168', async () => {
    const { deps, rows } = rig()
    const old = (day, shown) => ({ id: `x_${day}_${shown}`, day, column: 'mid', shown, outcome: { ret_pct: 1 } })
    rows(OUTCOMES).push(old('2026-07-01', false), old('2026-07-01', true), old('2026-09-15', false))
    await runOutcomes({ force: true, deps })
    const left = rows(OUTCOMES).filter(o => o.id.startsWith('x_')).map(o => o.id).sort()
    assert.deepEqual(left, ['x_2026-07-01_true', 'x_2026-09-15_false'], 'July off the board: past 60 days; on it: kept')
})

test("each column's summary sets the board's names against the graded names off it", () => {
    const o = (shown, ret) => ({ column: 'mid', day: DAY, grade: 'B', ...(shown == null ? {} : { shown }), outcome: { ret_pct: ret, reached: null } })
    const s = summarize([o(null, 2), o(true, -1), o(false, 1), o(false, -3), o(false, -2)])
    assert.deepEqual([s.mid.n, s.mid.board.n, s.mid.board.up_rate, s.mid.off.n, s.mid.off.up_rate], [5, 2, 50, 3, 33.3], 'a row from before the wide set counts as the board\'s')
})

test("Argus's record stays the board's: a name off it was never in front of him", async () => {
    const { argusRecord } = await import('../../services/hotlist.outcomes.js')
    const boards = [{ id: 'b', argus: { summary: 's' }, rows: [{ symbol: 'ON' }] }]
    const r = argusRecord([{ board: 'b', symbol: 'ON', column: 'mid', outcome: { ret_pct: 1 } }, { board: 'b', symbol: 'OFF', column: 'mid', shown: false, outcome: { ret_pct: 1 } }], boards)
    assert.equal(r.all.unmarked.n, 1)
})

test('the checkpoint keeps the graded names past its cut, compactly; the client never gets them', async () => {
    const { wideRow, BOARD_MAX } = await import('../../services/dailyScreener.checkpoint.js')
    assert.equal(BOARD_MAX, 60)
    assert.deepEqual(wideRow({ symbol: 'A', price: 10, quoted_at: 5, why: 'long text', cells: { mid: { grade: 'B', why: ['x'], range: { level: 11, atr_mult: 0.5, pct: 10 } }, eod: { grade: null } } }),
        { symbol: 'A', price: 10, quoted_at: 5, cells: { mid: { grade: 'B', range: { level: 11, atr_mult: 0.5, open_sky: false } } } })
    const { boardById } = await import('../../services/hotlist.service.js')
    const { db, rows } = memDb()
    rows(BOARDS).push({ id: 'hb_x', status: 'done', rows: [], wide: [{ symbol: 'A' }] })
    assert.equal((await boardById('hb_x', { db: async () => db })).wide, undefined)
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
