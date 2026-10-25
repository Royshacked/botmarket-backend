import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inWindow, beatStreak, buildWeekBoard, runWeekBoard, boardId, marketOpen, RUNUP_GRADE } from '../../services/hotlist.week.js'
import { spyOverSma200 } from '../../services/dailyScreener.service.js'
import { windowBars, scoreWindow } from '../../services/hotlist.outcomes.js'

// This week, overnight on the run-up rule (hotlist-day-archive.md §3, 2026-10-25).

test('the window: the report on the sixth session — bought at the board day’s open, out at the fifth’s close', () => {
    // Board Monday 2026-10-26: out Friday 10-30; a report on Monday 11-02 (or the weekend before) is in.
    assert.equal(inWindow('2026-10-26', '2026-11-02'), '2026-10-30')
    assert.equal(inWindow('2026-10-26', '2026-10-31'), '2026-10-30', 'a weekend date before the sixth session')
    assert.equal(inWindow('2026-10-26', '2026-10-30'), null, 'inside the hold — the binary itself')
    assert.equal(inWindow('2026-10-26', '2026-11-03'), null, 'a session too far')
    assert.equal(inWindow('2026-10-26', null), null)
})

test('the streak: the last three reports before the day with numbers, each a beat', () => {
    const rows = [
        { date: '2026-11-02', epsActual: null, epsEstimated: 1.1 },          // the coming one
        { date: '2026-08-01', epsActual: 1.2, epsEstimated: 1.0 },
        { date: '2026-05-01', epsActual: 1.0, epsEstimated: 0.9 },
        { date: '2026-02-01', epsActual: 0.8, epsEstimated: 0.8 },           // a match is not a beat
        { date: '2025-11-01', epsActual: 0.9, epsEstimated: 0.7 },
    ]
    assert.deepEqual(beatStreak(rows, '2026-10-26').beats, 2)
    assert.equal(beatStreak(rows.slice(0, 3), '2026-10-26').of, 2, 'only two with numbers')
    assert.equal(beatStreak(rows.filter(r => r.date !== '2026-02-01'), '2026-10-26').beats, 3)
})

test('SPY’s 200-day gate from the nightly bars; the run says it or not', () => {
    const up = Array.from({ length: 250 }, (_, i) => ({ close: 400 + i }))
    assert.equal(spyOverSma200(up), true)
    assert.equal(spyOverSma200(up.slice(0, 100)), null)
    assert.equal(spyOverSma200([...up, { close: 300 }]), false)
    assert.equal(marketOpen({ spy: { over_sma200: true } }), true)
    assert.equal(marketOpen({ spy: {} }), null)
})

const STATS = [
    { symbol: 'BEAT', close: 50, adv20_usd: 3e7, atr_pct: 2.1, closes20: [1, 2], next_earnings: '2026-11-02', name: 'Beat Co' },
    { symbol: 'MISS', close: 50, adv20_usd: 3e7, next_earnings: '2026-11-02' },
    { symbol: 'THIN', close: 50, adv20_usd: 1e6, next_earnings: '2026-11-02' },
    { symbol: 'LATE', close: 50, adv20_usd: 3e7, next_earnings: '2026-11-10' },
]
const STREAKS = new Map([['BEAT', { beats: 3, of: 3, last: [] }], ['MISS', { beats: 2, of: 3, last: [] }], ['THIN', { beats: 3, of: 3, last: [] }]])

test('the board: the window, the gates, the streak; every name equal; SPY under its 200-day writes it empty', () => {
    const b = buildWeekBoard({ boardDay: '2026-10-26', statsDay: '2026-10-23', stats: STATS, streaks: STREAKS, spyOver200: true, nowMs: 1 })
    assert.equal(b.id, 'hb_2026-10-26_week')
    assert.deepEqual(b.columns, ['week'])
    assert.equal(b.checkpoint, 'overnight')
    assert.deepEqual(b.rows.map(r => r.symbol), ['BEAT'])
    assert.equal(b.counts.window, 2, 'BEAT and MISS are in the window; THIN fails the dollar volume')
    const c = b.rows[0].cells.week
    assert.equal(c.grade, RUNUP_GRADE)
    assert.equal(c.exit_before, '2026-11-02')
    assert.equal(c.path, 'scheduled')
    const shut = buildWeekBoard({ boardDay: '2026-10-26', statsDay: '2026-10-23', stats: STATS, streaks: STREAKS, spyOver200: false, nowMs: 1 })
    assert.deepEqual(shut.rows, [])
    assert.match(shut.closed, /200-day/)
})

test('the run: from the latest run, one history read per window name, once; again when a partial run is done', async () => {
    const written = [], reads = []
    let have = null
    const coll = (name) => ({
        find: () => ({ toArray: async () => STATS }),
        findOne: async () => (name === 'hotlist_boards' ? have : null),
        updateOne: async (f, u) => { written.push(u.$set); have = { stats_status: u.$set.stats_status } },
        deleteMany: async () => {},
    })
    const deps = { db: async () => ({ collection: coll }), run: async () => ({ day: '2026-10-23', status: 'partial', spy: { over_sma200: true } }),
        earnings: async (s) => { reads.push(s); return s === 'BEAT' ? [1, 2, 3].map(k => ({ date: `2026-0${k}-01`, epsActual: 2, epsEstimated: 1 })) : [] },
        perMinute: () => 6000, now: () => Date.parse('2026-10-23T23:00:00Z'), sleep: async () => {} }
    const r = await runWeekBoard({ deps })
    assert.equal(r.outcome, 'done')
    assert.equal(r.id, boardId('2026-10-26'), 'Friday’s run → Monday’s board')
    assert.deepEqual(reads.sort(), ['BEAT', 'MISS'], 'only the window names that pass the gates')
    assert.equal(written[0].rows.length, 1)
    assert.equal((await runWeekBoard({ deps })).outcome, 'exists', 'the partial run, not done yet — kept')
    deps.run = async () => ({ day: '2026-10-23', status: 'done', spy: { over_sma200: true } })
    assert.equal((await runWeekBoard({ deps })).outcome, 'done', 'the run is done now — built again')
    assert.equal((await runWeekBoard({ deps })).outcome, 'exists')
    deps.run = async () => null
    assert.equal((await runWeekBoard({ deps })).outcome, 'no_run')
})

test('scoring the overnight board: the window from the board day, cut before the report; entry at the open', () => {
    const bar = (d, o, c) => ({ timestamp: Date.parse(`${d}T14:30:00Z`) / 1000, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c })
    const daily = [bar('2026-10-26', 100, 101), bar('2026-10-27', 101, 102), bar('2026-10-28', 102, 103), bar('2026-10-29', 103, 104), bar('2026-10-30', 104, 105), bar('2026-11-02', 105, 90)]
    const win = windowBars('week', '2026-10-26', { daily }, { exitBefore: '2026-11-02' })
    assert.equal(win.length, 5)
    assert.equal(scoreWindow({ entry: win[0].open }, win).ret_pct, 5)
})

test('the hand-off: every name on the overnight board goes to Prometheus, marked as the rule’s; the facts say the rule', async () => {
    const { weekPicks, hotlistContext, readBoardId } = await import('../../services/hotlistResearch.service.js')
    const { seedFacts } = await import('../../services/hotlist.service.js')
    const b = buildWeekBoard({ boardDay: '2026-10-26', statsDay: '2026-10-23', stats: [...STATS, { ...STATS[0], symbol: 'ALSO' }],
        streaks: new Map([...STREAKS, ['ALSO', { beats: 3, of: 3, last: [] }]]), spyOver200: true, nowMs: 1 })
    assert.deepEqual(weekPicks(b).map(r => r.symbol), ['ALSO', 'BEAT'], 'no picks needed — the rule listed them')
    assert.equal(readBoardId('2026-10-26'), 'hb_2026-10-26_week')
    const ctx = hotlistContext(b, b.rows[1])
    assert.equal(ctx.rule, true)
    assert.equal(ctx.why, null, 'no one picked it — code review 2026-10-25')
    assert.equal(ctx.exit_before, '2026-11-02')
    const facts = seedFacts(b.rows[1], 'week')
    assert.match(facts, /run-up rule: reports 2026-11-02/)
    assert.doesNotMatch(facts, /free range null/)
})

// Code review 2026-10-25 (#4, B1): a failed read is counted and the board rebuilt; a failed calendar says why; boards pruned.
test('a failed earnings read: counted, the board partial, rebuilt at most hourly; old boards pruned', async () => {
    let have = null, now = Date.parse('2026-10-23T23:00:00Z')
    const deleted = []
    const coll = (name) => ({
        find: () => ({ toArray: async () => STATS }),
        findOne: async () => (name === 'hotlist_boards' ? have : null),
        updateOne: async (f, u) => { have = { ...u.$set } },
        deleteMany: async (q) => { deleted.push(q) },
    })
    let fail = true
    const deps = { db: async () => ({ collection: coll }), run: async () => ({ day: '2026-10-23', status: 'done', spy: { over_sma200: true } }),
        earnings: async (s) => { if (s === 'BEAT' && fail) throw new Error('timeout'); return [1, 2, 3].map(k => ({ date: `2026-0${k}-01`, epsActual: 2, epsEstimated: 1 })) },
        perMinute: () => 6000, now: () => now, sleep: async () => {} }
    const r = await runWeekBoard({ deps })
    assert.equal(r.failed, 1)
    assert.equal(have.status, 'partial')
    assert.equal(have.counts.failed, 1)
    assert.deepEqual(have.rows.map(x => x.symbol), ['MISS'], 'BEAT is off until its read comes')
    assert.deepEqual(deleted[0], { day: { $lt: '2026-09-26' } }, 'thirty days kept')
    assert.equal((await runWeekBoard({ deps })).outcome, 'exists', 'not again within the hour')
    now += 61 * 60 * 1000; fail = false
    assert.equal((await runWeekBoard({ deps })).outcome, 'done')
    assert.equal(have.status, 'done')
    assert.deepEqual(have.rows.map(x => x.symbol), ['BEAT', 'MISS'])
    assert.equal((await runWeekBoard({ deps })).outcome, 'exists')
})

test('a failed calendar on the run: an empty board that says why — not a quiet week', () => {
    const b = buildWeekBoard({ boardDay: '2026-10-26', statsDay: '2026-10-23', stats: STATS, streaks: STREAKS, spyOver200: true, nowMs: 1, calendarFailed: true })
    assert.deepEqual(b.rows, [])
    assert.match(b.closed, /earnings calendar could not be read/)
})

test('the run-up rule keeps its own record apart from the week’s older outcomes; Axl says an unknown gate', async () => {
    const { summarize } = await import('../../services/hotlist.outcomes.js')
    const o = (grade, day, ret) => ({ column: 'week', day, grade, outcome: { ret_pct: ret, reached: null } })
    const s = summarize([o('A', '2026-10-01', 5), o('B', '2026-10-01', -1), o('R', '2026-10-26', 2), o('R', '2026-10-27', -1), o('R', '2026-10-27', 3)])
    assert.deepEqual([s.week.rule.n, s.week.rule.sessions, s.week.rule.up_rate, s.week.rule.verified], [3, 2, 66.7, false])
    assert.equal(s.week.n, 5, 'the column still counts every week outcome')
    const { formatHotlist } = await import('../../services/tools/hotlist.tools.js')
    const txt = formatHotlist({ day: '2026-10-26', latest: { checkpoint: 'overnight', market: { gate: 'unknown' } }, day_list: [{ symbol: 'A', status: 'setting_up', cells: { week: { grade: 'R', why: ['x'] } } }] })
    assert.match(txt, /could not be checked/)
})
