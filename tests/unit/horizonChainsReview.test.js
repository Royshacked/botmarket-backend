import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { _setClientFactory, closeDb } from '../../providers/mongodb.provider.js'
import { researchQueueService } from '../../services/researchQueue.service.js'
import { startRun, getRun } from '../../services/researchRun.service.js'
import { resumeQueued, researchWeeks } from '../../services/houseResearch.service.js'
import { queueWeekPicks, resume, researchDay, requestRead, afterCheckpoint } from '../../services/hotlistResearch.service.js'
import { buildCatalystRead, gradeCatalystRead, windowPrices, catalystReadService, _setDeps as setReadDeps, GRADE_GIVE_UP_MS } from '../../services/catalystRead.service.js'
import { _parseCatalystRead } from '../../services/agents/analyst.agent.service.js'
import { RUNUP_TOOL_HANDLERS, _setIO } from '../../services/tools/runup.tools.js'
import { dayList } from '../../services/hotlist.service.js'

// The code review of 2026-10-24 on the horizon chains (docs/design/horizon-chains.md, "Code review"): one test per
// fix, named for what it protects.

const DAY = '2026-10-23'
const NOW = Date.parse('2026-10-23T13:25:00Z')   // 09:25 ET
const BOARD = {
    // The board the hand-off reads is the week board since 2026-10-25 (hotlistResearch readBoardId); its rows here are an
    // older board's, with Argus's picks — the stamping and the pick-up do not depend on which.
    id: `hb_${DAY}_week`, day: DAY, checkpoint: 'preopen', rows: [
        { symbol: 'ONE', cells: { week: { grade: 'A', range: { open_sky: true } } }, picks: { week: { why: 'first', rank: 1 } } },
        { symbol: 'TWO', cells: { week: { grade: 'B', range: { pct: 3, atr_mult: 1, level: 10 } } }, picks: { week: { why: 'second', rank: 2 } } },
        { symbol: 'XOM', cells: { week: { grade: 'B', range: { pct: 2, atr_mult: 1, level: 117 } } } },
        { symbol: 'OPN', cells: { open: { grade: 'A' } } },
    ],
}

/** A queue in memory with the service's own filters, and a run starter that records. */
function rig(over = {}) {
    const rows = [], starts = [], marks = [], rejects = []
    const deps = {
        enabled: () => true, maxNames: () => 10, maxUsd: () => 1, manualMax: () => 2, now: () => NOW,
        board: async () => BOARD,
        latestDay: async () => DAY,
        markBoard: async (id) => { marks.push(id) },
        liveSymbols: async () => new Set(),
        enqueue: async (row) => { rows.push({ id: `rq_${row.symbol}`, status: 'queued', created_at: new Date(NOW).toISOString(), ...row }); return { ok: true } },
        reject: async (id, reason) => { rejects.push([id, reason]); const r = rows.find(x => x.id === id); if (r) r.status = 'rejected' },
        listQueue: async (q) => rows.filter(r => (!q.source || r.source === q.source) && (!q.status || [q.status].flat().includes(r.status))
            && (!q.symbols || q.symbols.includes(r.symbol))),
        requeueStale: async () => ({ ok: true }),
        startRun: async (o) => { starts.push(o); return { ok: true, run: { id: 'run' } } },
        getRun: () => null,
        ...over,
    }
    return { rows, starts, marks, rejects, deps }
}
const hotRow = (symbol, day, extra = {}) => ({ id: `rq_${symbol}_${day}`, symbol, source: 'hotlist', requestedBy: 'house', status: 'queued',
    created_at: `${day}T13:30:00.000Z`, context: { hotlist: true, day }, ...extra })

test('#2 earlier days\' waiting names are expired by the next pick-up — they no longer block the name', async () => {
    const { rows, rejects, deps } = rig({ board: async () => ({ ...BOARD, research_queued_at: 'x' }) })
    rows.push(hotRow('OLD', '2026-10-22'), hotRow('LEGACY', '2026-10-22', { context: { hotlist: true } }))
    await resume(DAY, deps)
    assert.deepEqual(rejects.map(r => r[1]), ['expired', 'expired'])
})

// 2026-10-28: an empty OpenRouter balance left every refused run's name claimed — `in_research` with a reason — and the
// expiry read `queued` only: 60 names blocked on prod, for good.
test('earlier days\' claimed names are expired too — except the one a run is on now', async () => {
    const { rows, rejects, deps } = rig({ board: async () => ({ ...BOARD, research_queued_at: 'x' }),
        getRun: () => ({ status: 'running', current: 'LIVE' }) })
    rows.push(hotRow('STUCK', '2026-10-22', { status: 'in_research', reason: 'failed' }), hotRow('LIVE', '2026-10-22', { status: 'in_research' }),
        hotRow('WAIT', '2026-10-22'), hotRow('TODAY', DAY, { status: 'in_research', reason: 'failed' }), hotRow('DONE', '2026-10-22', { status: 'done' }))
    await resume(DAY, deps)
    assert.deepEqual(rejects.map(r => r[0]).sort(), ['rq_STUCK_2026-10-22', 'rq_WAIT_2026-10-22'])
    assert.ok(rejects.every(r => r[1] === 'expired'))
})

test('#4 a catalyst row and a coverage row for the same name are both kept; a second of the same kind is the duplicate', async () => {
    const { db } = memDb()
    const restore = _setClientFactory(() => ({ connect: async () => {}, db: () => db, close: async () => {} }))
    process.env.MONGODB_URI ??= 'mongodb://fake.invalid/test'
    try {
        await closeDb()
        const a = await researchQueueService.enqueue({ symbol: 'AAPL', source: 'hotlist', context: { hotlist: true, day: DAY } })
        const b = await researchQueueService.enqueue({ symbol: 'AAPL', source: 'pythia', context: { pythia: true } })
        const c = await researchQueueService.enqueue({ symbol: 'AAPL', source: 'hotlist', context: { hotlist: true, day: DAY } })
        const d = await researchQueueService.enqueue({ symbol: 'AAPL', source: 'scan' })
        assert.equal(a.duplicate, undefined)
        assert.equal(b.duplicate, undefined, 'coverage is a different question from a catalyst read')
        assert.equal(c.duplicate, true)
        assert.equal(d.duplicate, true, 'a second coverage request is the duplicate')
    } finally {
        await closeDb()
        restore()
    }
})

test('#4 a run for one chain takes only its own rows, and records whose it is', async () => {
    const queue = [{ id: 'rq_h', symbol: 'AAPL', source: 'hotlist', context: { hotlist: true } }, { id: 'rq_p', symbol: 'AAPL', source: 'pythia', context: {} }]
    const claimed = []
    await startRun({ userId: null, symbols: ['AAPL'], source: 'pythia' }, {
        listQueue: async () => queue, coveredSymbols: async () => new Set(), liveCatalystSymbols: async () => new Set(),
        startResearch: async (id) => { claimed.push(id); return { ok: false } },
        markDone: async () => ({}), reject: async () => ({}), annotate: async () => ({}), requeue: async () => ({}),
        costOf: () => 0, houseLedger: async () => null, book: async () => {},
    })
    for (let i = 0; i < 50 && getRun()?.status === 'running'; i++) await new Promise(r => setImmediate(r))
    assert.deepEqual(claimed, ['rq_p'])
    assert.equal(getRun().source, 'pythia')
})

test("#5 a day's rows are the ones carrying its session date — a late catch-up does not spend the next day's caps", async () => {
    const { rows, starts, deps } = rig({ maxNames: () => 2 })
    // Monday's late row, created after 20:00 ET (Tuesday in UTC), with $0.9 spent; and Tuesday is a fresh day.
    rows.push(hotRow('MON', '2026-10-22', { created_at: '2026-10-23T01:05:00.000Z', status: 'done', cost_usd: 0.9 }))
    const q = await queueWeekPicks(BOARD, deps)
    assert.deepEqual(q.queued, ['ONE', 'TWO'], "Monday's row is not Tuesday's: both slots are free")
    await researchDay(DAY, deps)
    assert.equal(starts[0].maxUsd, 1, "and none of Tuesday's dollar was spent by Monday's row")
})

test('#6 the hand-off stamps the board; the pick-up catches up an unstamped board once, and never a stamped one', async () => {
    const { rows, starts, marks, deps } = rig()
    // Every pick already in line for this kind elsewhere — nothing queued, but the board is still handed off.
    const dup = rig({ enqueue: async () => ({ ok: true, duplicate: true }) })
    await afterCheckpoint({ outcome: 'done', id: BOARD.id }, dup.deps)
    assert.deepEqual(dup.marks, [BOARD.id], 'stamped even when every pick was a duplicate')

    const r = await resume(DAY, deps)
    assert.equal(r.outcome, 'caught_up')
    assert.deepEqual(r.queued, ['ONE', 'TWO'])
    assert.deepEqual(marks, [BOARD.id])
    assert.deepEqual(starts[0].symbols, ['ONE', 'TWO'])
    // Stamped now: the next tick never queues the board again, even once both reads are done.
    rows.forEach(x => { x.status = 'done' })
    const again = await resume(DAY, { ...deps, board: async () => ({ ...BOARD, research_queued_at: 'x' }) })
    assert.equal(again.outcome, 'nothing_queued')
    assert.equal(rows.length, 2)
})

test('#6 a half-queued board (the process died mid-way) is finished without buying a done name twice', async () => {
    const { rows, deps } = rig()
    rows.push(hotRow('ONE', DAY, { status: 'done' }))
    const q = await queueWeekPicks(BOARD, deps)
    assert.deepEqual(q.queued, ['TWO'])
})

test('#12 a name with a live read is not queued and does not use a slot', async () => {
    const { deps } = rig({ maxNames: () => 1, liveSymbols: async () => new Set(['ONE']) })
    assert.deepEqual(await queueWeekPicks(BOARD, deps), { queued: ['TWO'], skipped: 0, live: 1 })
})

test('#13 an admin stop on one chain does not halt the other; a stopped Start-all halts both', async () => {
    const research = async () => ({ outcome: 'started' })
    const deps = { requeueStale: async () => ({}) }
    const stopped = (source) => ({ ...deps, getRun: () => ({ status: 'stopped', source }) })
    assert.equal((await resumeQueued(['A'], research, stopped('pythia'), { source: 'hotlist' })).outcome, 'started')
    assert.equal((await resumeQueued(['A'], research, stopped('hotlist'), { source: 'hotlist' })).outcome, 'stopped_by_admin')
    assert.equal((await resumeQueued(['A'], research, stopped(null), { source: 'hotlist' })).outcome, 'stopped_by_admin')
})

test('#14 a bad clock is an error outcome from the Pythia week, not a throw', async () => {
    const r = await researchWeeks([{ house_scan: { queued: [{ symbol: 'A' }] } }], { maxUsd: () => 1 }, { now: NaN })
    assert.equal(r.outcome, 'error')
})

test('#15 the single pick follows the merged picks — a later board that lists the name without a pick keeps it', () => {
    const b1 = { id: 'b1', checkpoint: 'preopen', rows: [{ symbol: 'NVDA', cells: { week: { grade: 'A' } }, picks: { week: { why: 'w', rank: 1 } }, pick: { why: 'w', rank: 1 } }] }
    const b2 = { id: 'b2', checkpoint: 'mid', rows: [{ symbol: 'NVDA', cells: { mid: { grade: 'B' } } }] }
    const [row] = dayList([b1, b2])
    assert.equal(row.picks.week.why, 'w')
    assert.equal(row.pick?.why, 'w')
})

test('#3 past its window a read is graded by the window\'s bars — a gap after the report is not a hit', () => {
    const now = Date.parse('2026-10-23T13:40:00Z')
    const read = buildCatalystRead({ verdict: 'credible', window_days: 5, runup: { report: '2026-10-27', median_pct: 3, p25_pct: 1, p75_pct: 5 }, target: { price: 267.8 } },
        { symbol: 'RCL', spot: 260, spy: 700, nowMs: now })
    const after = Date.parse('2026-10-27T15:00:00Z')   // the report day: the stock gapped to 290
    const missed = gradeCatalystRead(read, { price: 290, spy: 705, nowMs: after, window: { high: 266, close: 263, spy_close: 702 } })
    assert.equal(missed.status, 'expired')
    assert.equal(missed.outcome.price, 263)
    assert.equal(missed.outcome.basis, 'window')
    const reached = gradeCatalystRead(read, { price: 250, spy: 705, nowMs: after, window: { high: 268, close: 262, spy_close: 702 } })
    assert.equal(reached.status, 'hit', 'the window touched the target, whatever the price is now')
    assert.equal(gradeCatalystRead(read, { price: 290, nowMs: after, window: null }), null, 'no bars yet: wait')
    assert.equal(gradeCatalystRead(read, { price: 290, nowMs: Date.parse(read.valid_until) + GRADE_GIVE_UP_MS, window: null }).outcome.basis, 'unpriced')
})

test('#3 the window\'s prices: the high and the last close inside it, by ET date', () => {
    const read = { set_at: '2026-10-23T13:40:00Z', valid_until: '2026-10-26T21:00:00.000Z' }
    const bar = (d, high, close) => ({ timestamp: Date.parse(`${d}T04:00:00Z`) / 1000, high, close })
    // The read came at 09:40 ET: its own day's 285 high may predate it, so the window starts the next session.
    const bars = [bar('2026-10-22', 300, 299), bar('2026-10-23', 285, 262), bar('2026-10-26', 270, 268), bar('2026-10-27', 290, 289)]
    assert.deepEqual(windowPrices(read, bars, [bar('2026-10-26', 1, 705)]), { high: 270, close: 268, spy_close: 705 })
    // A read before the open (09:25 ET) owns its whole day.
    assert.equal(windowPrices({ ...read, set_at: '2026-10-23T13:25:00Z' }, bars, []).high, 285)
    assert.equal(windowPrices(read, [], []), null)
})

test('#7 a read made after the close before its report is a pass — no window left', () => {
    const late = Date.parse('2026-10-26T22:00:00Z')
    const r = buildCatalystRead({ verdict: 'credible', window_days: 5, runup: { report: '2026-10-27', median_pct: 3 } }, { symbol: 'RCL', spot: 260, nowMs: late })
    assert.equal(r.status, 'pass')
    assert.equal(r.pass_reason, 'report_too_close')
    assert.equal(r.valid_until, new Date(late).toISOString())
    assert.equal(buildCatalystRead({ verdict: 'contradicted' }, { symbol: 'X', spot: 1, nowMs: late }).pass_reason, 'contradicted')
})

test('#8 the run-up tool: a report today is not skipped for next quarter\'s; a report weeks away is not a run-up', async () => {
    const past = ['2025-10-28', '2026-01-27', '2026-04-28', '2026-07-28'].map(date => ({ date, epsActual: 1 }))
    _setIO({ today: () => '2026-10-27', earnings: async () => [{ date: '2026-10-27', epsActual: null }, { date: '2027-01-26', epsActual: null }, ...past], bars: async () => [] })
    assert.match(await RUNUP_TOOL_HANDLERS.get_runup_history({ ticker: 'RCL' }), /report is TODAY/)
    _setIO({ today: () => '2026-10-23', earnings: async () => [{ date: '2026-12-15', epsActual: null }, ...past] })
    assert.match(await RUNUP_TOOL_HANDLERS.get_runup_history({ ticker: 'RCL' }), /past a short swing's window/)
})

test('#16 #17 one active read per name — a read past its window no longer blocks, and is graded before the new one', async () => {
    const { db, rows } = memDb()
    const now = Date.parse('2026-10-28T14:00:00Z')
    rows('catalyst_reads').push({ id: 'cr_old', symbol: 'RCL', status: 'active', set_at: '2026-10-23T13:40:00Z', valid_until: '2026-10-26T21:00:00.000Z',
        target: { value: 268 }, price_at_read: 260 })
    setReadDeps({ db: async () => db, now: () => now, price: async () => 270, bars: async () => null })
    assert.deepEqual([...await catalystReadService.liveSymbols()], [], 'its window ran out: not live')
    const saved = await catalystReadService.saveRead({ verdict: 'unclear' }, { symbol: 'RCL' })
    assert.equal(saved.ok, true)
    assert.equal(rows('catalyst_reads').find(r => r.id === 'cr_old').status, 'expired', 'closed (unpriced) to make room')
})

test('#16 a duplicate-key insert from a racing process is a live_read, not a failure', async () => {
    const coll = { createIndex: async () => {}, findOne: async () => null, find: () => ({ toArray: async () => [] }),
        insertOne: async () => { const e = new Error('E11000'); e.code = 11000; throw e } }
    setReadDeps({ db: async () => ({ collection: () => coll }), now: () => NOW, price: async () => 100 })
    assert.deepEqual(await catalystReadService.saveRead({ verdict: 'unclear' }, { symbol: 'X' }), { ok: false, reason: 'live_read' })
})

test('#18 a block with a run-up line and a delta keeps only the run-up', () => {
    const raw = '<catalyst_read>{"ticker":"RCL","verdict":"credible","delta":{"delta_price_pct":4,"spot":250},"runup":{"report":"2026-10-27","median_pct":3}}</catalyst_read>'
    const p = _parseCatalystRead(raw)
    assert.equal(p.delta, null)
    assert.equal(p.runup.median_pct, 3)
})

test('#19 one failed write does not stop the grading pass', async () => {
    let n = 0
    const coll = {
        createIndex: async () => {},
        find: () => ({ toArray: async () => [1, 2].map(i => ({ id: `cr_${i}`, symbol: `S${i}`, status: 'active', valid_until: '2099-01-01T00:00:00Z', target: { value: 10 }, price_at_read: 9 })) }),
        updateOne: async () => { if (n++ === 0) throw new Error('mongo') },
    }
    setReadDeps({ db: async () => ({ collection: () => coll }), now: () => NOW, price: async () => 11 })
    assert.deepEqual(await catalystReadService.gradeDue(), { graded: 1, hit: 1, expired: 0, failed: 1 })
})

test("a user's read on a week name Argus did not pick: today's board only, a week grade, no live or waiting read, a daily count", async () => {
    const { rows, starts, deps } = rig()
    assert.deepEqual(await requestRead({ boardId: BOARD.id, symbol: 'xom', userId: 'u1' }, deps), { ok: true, outcome: 'started' })
    assert.equal(rows[0].requestedBy, 'u1')
    assert.equal(rows[0].context.requested, true)
    assert.deepEqual(starts[0], { userId: null, symbols: ['XOM'], maxUsd: null, source: 'hotlist' }, 'outside the house budget')
    assert.equal((await requestRead({ boardId: BOARD.id, symbol: 'XOM' }, deps)).reason, 'already_queued')
    assert.equal((await requestRead({ boardId: BOARD.id, symbol: 'OPN' }, deps)).reason, 'not_on_week')
    assert.equal((await requestRead({ boardId: BOARD.id, symbol: 'ONE' }, { ...deps, liveSymbols: async () => new Set(['ONE']) })).reason, 'live_read')
    assert.equal((await requestRead({ boardId: BOARD.id, symbol: 'ONE' }, { ...deps, latestDay: async () => '2026-10-26' })).reason, 'stale_board', 'a newer board replaced it')
    assert.equal((await requestRead({ boardId: BOARD.id, symbol: 'TWO' }, { ...deps, getRun: () => null, startRun: async () => ({ ok: false, reason: 'already_running' }) })).outcome, 'queued')
    assert.equal((await requestRead({ boardId: BOARD.id, symbol: 'ONE' }, deps)).reason, 'daily_cap', 'two asked for today: the cap')
})

test("users' waiting reads go first and never count against the house's budget or its name cap", async () => {
    const { rows, starts, deps } = rig({ maxNames: () => 1 })
    rows.push(hotRow('XOM', DAY, { requestedBy: 'u1', cost_usd: 5 }))
    await researchDay(DAY, deps)
    assert.deepEqual(starts[0].symbols, ['XOM'])
    rows[0].status = 'done'
    assert.deepEqual((await queueWeekPicks(BOARD, deps)).queued, ['ONE'], 'the user row is not a house slot')
    await researchDay(DAY, deps)
    assert.deepEqual([starts[1].symbols, starts[1].maxUsd], [['ONE'], 1], "the user's $5 is not the house's")
    // House reads switched off: a user's waiting read is still picked up.
    rows.push(hotRow('LMT', DAY, { requestedBy: 'u2' }))
    const off = await resume(DAY, { ...deps, enabled: () => false, board: async () => ({ ...BOARD, research_queued_at: 'x' }) })
    assert.equal(off.outcome, 'started')
    assert.deepEqual(starts.at(-1).symbols, ['LMT'])
})

// Roy, 2026-10-24: "I see RCL's last price above its price target" — a +0.23% target is not a trade.
test('a target that leaves less than 1% open, or half the daily range, is a pass: too small to trade', async () => {
    const { minOpenPct } = await import('../../services/catalystRead.service.js')
    assert.equal(minOpenPct(null), 1)
    assert.equal(minOpenPct(1.4), 1, 'half a 1.4% range is under the floor')
    assert.equal(minOpenPct(3.2), 1.6)
    const now = Date.parse('2026-10-23T19:51:00Z')
    // His target at the record's +0.23% (277.34), then at +2% (282.23).
    const rcl = { verdict: 'credible', window_days: 5, runup: { report: '2026-10-27', median_pct: 0.23, p25_pct: -0.55, p75_pct: 1.72 }, target: { price: 277.34 } }
    const r = buildCatalystRead(rcl, { symbol: 'RCL', spot: 276.7, nowMs: now, context: { exit_before: '2026-10-27', atr_pct: 3.2 } })
    assert.deepEqual([r.status, r.pass_reason, r.target], ['pass', 'too_small', null])
    const big = buildCatalystRead({ ...rcl, runup: { ...rcl.runup, median_pct: 2 }, target: { price: 282.23 } }, { symbol: 'RCL', spot: 276.7, nowMs: now, context: { atr_pct: 3.2 } })
    assert.equal(big.status, 'active', '2% clears a 1.6% bar')
})

test("on a weekend the latest list is still Friday's: a read is asked for on it (Roy, 2026-10-24: \"nothing happens\")", async () => {
    const { rows, deps } = rig({ now: () => Date.parse('2026-10-24T15:00:00Z'), latestDay: async () => DAY })
    assert.deepEqual(await requestRead({ boardId: BOARD.id, symbol: 'XOM', userId: 'u' }, deps), { ok: true, outcome: 'started' })
    assert.equal(rows[0].context.day, DAY)
})

// Code review 2026-10-25 (#1, high): the overnight week board for a day is built the EVENING BEFORE, so its rows are
// created before that day's UTC midnight — a queue read bounded there found none of them and Prometheus read nothing.
test('#25-1 the overnight board\'s names, queued the evening before, are researched — a queue that honours `since`', async () => {
    const WEEK = { id: `hb_${DAY}_week`, day: DAY, checkpoint: 'overnight', rows: [
        { symbol: 'RU1', cells: { week: { grade: 'R', why: ['reports 2026-10-30'], exit_before: '2026-10-30' } } },
        { symbol: 'RU2', cells: { week: { grade: 'R', why: ['reports 2026-10-30'], exit_before: '2026-10-30' } } },
    ] }
    const evening = '2026-10-22T22:20:00.000Z'   // Thursday 18:20 ET — the board for Friday 10-23
    const { rows, starts, deps } = rig({ board: async () => WEEK, now: () => Date.parse(evening) })
    deps.enqueue = async (row) => { rows.push({ id: `rq_${row.symbol}`, status: 'queued', created_at: evening, ...row }); return { ok: true } }
    deps.listQueue = async (q) => rows.filter(r => (!q.source || r.source === q.source) && (!q.status || r.status === q.status)
        && (!q.symbols || q.symbols.includes(r.symbol)) && (!q.since || r.created_at >= q.since))
    const r = await afterCheckpoint({ outcome: 'done', id: WEEK.id }, deps)
    assert.deepEqual(r.queued, ['RU1', 'RU2'])
    assert.deepEqual(starts[0]?.symbols, ['RU1', 'RU2'], 'researched at once, not left to expire')
    assert.equal(rows[0].context.rule, true, 'listed by the rule — not "Argus picked it"')
    assert.equal(rows[0].context.why, null)
})

test('#25-9 the pick-up hands off the NEXT session\'s board when the evening hand-off failed', async () => {
    const NEXT = { id: 'hb_2026-10-26_week', day: '2026-10-26', checkpoint: 'overnight', rows: [{ symbol: 'NX', cells: { week: { grade: 'R' } } }] }
    const { marks, starts, deps } = rig({ board: async () => ({ ...BOARD, research_queued_at: 'x' }), latestBoard: async () => NEXT })
    const r = await resume(DAY, deps)
    assert.deepEqual(marks, [NEXT.id])
    assert.deepEqual(r.next.queued, ['NX'])
    assert.ok(starts.some(s => s.symbols.includes('NX')))
    // Stamped: not again.
    const again = await resume(DAY, { ...deps, latestBoard: async () => ({ ...NEXT, research_queued_at: 'y' }) })
    assert.equal(again.next, undefined)
})
