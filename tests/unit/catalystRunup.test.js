import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runUpStats, runUpReadText, sessionsBefore, RUNUP_TOOL_HANDLERS, _setIO, MIN_REPORTS } from '../../services/tools/runup.tools.js'
import { _parseCatalystRead, _cleanRunup, TOOLS } from '../../services/agents/analyst.agent.service.js'
import { runupTarget, readValidUntil, buildCatalystRead } from '../../services/catalystRead.service.js'
import { hotlistContext, resume } from '../../services/hotlistResearch.service.js'

// The three fixes after the first live catalyst read (docs/design/horizon-chains.md, "Found live"; Roy, 2026-10-23):
// a run-up gets its own yardstick, the window ends before the report, and a board whose picks were never queued is
// caught up on the next tick.

const DAY = 86_400_000
// Weekday daily bars from `start`, closes from `closeAt(i)`; timestamps in SECONDS at 16:00 ET, as FMP serves them.
function bars(start, n, closeAt) {
    const out = []
    for (let t = Date.parse(`${start}T20:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        out.push({ timestamp: t / 1000, close: closeAt(i++, new Date(t).toISOString().slice(0, 10)) })
    }
    return out
}

test('sessions before a report: the weekdays strictly between, weekends skipped', () => {
    assert.equal(sessionsBefore('2026-10-23', '2026-10-27'), 1)   // Fri → Tue: Monday only
    assert.equal(sessionsBefore('2026-10-19', '2026-10-23'), 3)
    assert.equal(sessionsBefore('2026-10-23', '2026-10-24'), 0)
})

test('the run-up record: entry `lead` sessions before the last session BEFORE each report, against SPY', () => {
    // A stock that rises 1% a session in the 3 sessions before each report and is flat otherwise.
    const reports = ['2026-02-10', '2026-05-12', '2026-08-11', '2026-10-13']
    const pre = new Set()
    const b = bars('2026-01-02', 220, () => 0)
    b.forEach((x, i) => { const d = new Date(x.timestamp * 1000).toISOString().slice(0, 10)
        for (const r of reports) { const last = b.filter(y => new Date(y.timestamp * 1000).toISOString().slice(0, 10) < r).length - 1
            if (i > last - 3 && i <= last) pre.add(d) } })
    let px = 100
    const stock = b.map(x => { const d = new Date(x.timestamp * 1000).toISOString().slice(0, 10); if (pre.has(d)) px *= 1.01; return { ...x, close: px } })
    const spy = bars('2026-01-02', 220, () => 500)
    const s = runUpStats({ reports, bars: stock, spyBars: spy, lead: 3 })
    assert.equal(s.n, 4)
    assert.equal(s.median_pct, 3.03)
    assert.equal(s.up_share, 1)
    assert.equal(s.median_excess_pct, 3.03, 'SPY flat: the excess is the move')
    assert.equal(s.rows[0].report, '2026-10-13', 'newest first')
    assert.equal(s.rows[0].to, '2026-10-12', 'exit is the close before the report')
})

test('too few reports: no line to copy; enough: the one line, with the report and the lead', () => {
    const few = runUpReadText('XYZ', { report: '2026-10-27', lead: 2, stats: { n: MIN_REPORTS - 1, rows: [] } })
    assert.match(few, /too few/)
    assert.doesNotMatch(few, /Copy this line/)
    const ok = runUpReadText('XYZ', { report: '2026-10-27', lead: 2, stats: { n: 4, rows: [], median_pct: 2.5, p25_pct: 1, p75_pct: 4, up_share: 0.75, median_excess_pct: 1.8 } })
    const line = JSON.parse(ok.split('in your block: ')[1])
    assert.deepEqual(line, { basis: 'run_up', report: '2026-10-27', lead_days: 2, n: 4, median_pct: 2.5, p25_pct: 1, p75_pct: 4, up_share: 0.75, median_excess_pct: 1.8 })
})

test('the tool: lead defaults to the sessions left, today included; no report ahead is not a run-up', async () => {
    const asked = []
    _setIO({
        today: () => '2026-10-23',
        earnings: async () => [{ date: '2026-10-27', epsActual: null }, ...['2025-10-28', '2026-01-27', '2026-04-28', '2026-07-28'].map(date => ({ date, epsActual: 1 }))],
        bars: async (sym, from) => { asked.push([sym, from]); return bars('2025-09-01', 300, (i) => 100 + i * 0.1) },
    })
    const text = await RUNUP_TOOL_HANDLERS.get_runup_history({ ticker: 'rcl' })
    assert.match(text, /^RCL — run-up into its reports, the last 2 sessions/)
    assert.equal(JSON.parse(text.split('in your block: ')[1]).lead_days, 2, 'Friday and Monday')
    assert.deepEqual(asked.map(a => a[0]), ['RCL', 'SPY'])
    _setIO({ earnings: async () => [{ date: '2026-07-28', epsActual: 1 }] })
    assert.match(await RUNUP_TOOL_HANDLERS.get_runup_history({ ticker: 'RCL' }), /not a run-up trade/)
})

test('the analyst offers the run-up tool, and consult stays last', () => {
    const names = TOOLS.map(t => t.name ?? t.type)
    assert.ok(names.includes('get_runup_history'))
    assert.equal(names.at(-1), 'consult')
})

test('the runup line is checked: numbers only, and no median or report date is no line', () => {
    assert.deepEqual(_cleanRunup({ report: '2026-10-27', median_pct: '2.5', n: 6, junk: 1 }),
        { basis: 'run_up', report: '2026-10-27', lead_days: null, n: 6, median_pct: 2.5, p25_pct: null, p75_pct: null, up_share: null, median_excess_pct: null })
    assert.equal(_cleanRunup({ report: '2026-10-27' }), null)
    assert.equal(_cleanRunup({ median_pct: 2 }), null)
    const raw = '<catalyst_read>{"ticker":"RCL","verdict":"credible","runup":{"report":"2026-10-27","median_pct":3.1,"p25_pct":1.2,"p75_pct":4.4,"n":8,"up_share":0.75}}</catalyst_read>'
    assert.equal(_parseCatalystRead(raw).runup.median_pct, 3.1)
})

test('a run-up target: spot plus the median run-up, the band off the quartiles, all of it open', () => {
    const t = runupTarget({ median_pct: 3, p25_pct: 1, p75_pct: 5 }, 260)
    assert.deepEqual(t, { value: 267.8, low: 262.6, high: 273, open_pct: 3, worth_pct: 3, moved_pct: 0, priced_share: null, spot: 260, basis: 'run_up' })
    assert.equal(runupTarget({ median_pct: 3 }, null), null)
})

test('the window ends the session before a report inside it; a report past the window changes nothing', () => {
    const now = Date.parse('2026-10-23T13:40:00Z')
    assert.equal(readValidUntil({ nowMs: now, windowDays: 5, exitBefore: '2026-10-27' }), '2026-10-26T21:00:00.000Z')
    assert.equal(readValidUntil({ nowMs: now, windowDays: 5, exitBefore: '2026-11-20' }), '2026-10-28T13:40:00.000Z')
    assert.equal(readValidUntil({ nowMs: now, windowDays: 5, exitBefore: null }), '2026-10-28T13:40:00.000Z')
    assert.equal(readValidUntil({ nowMs: now, windowDays: 5, exitBefore: '2026-10-23' }), '2026-10-28T13:40:00.000Z', 'a date already past is ignored')
})

test('a run-up read is ACTIVE with a target and dated to the report; a target at or under spot is a pass', () => {
    const now = Date.parse('2026-10-23T13:40:00Z')
    const parsed = { verdict: 'credible', window_days: 5, runup: { report: '2026-10-27', median_pct: 3, p25_pct: 1, p75_pct: 5, n: 8 } }
    const r = buildCatalystRead(parsed, { symbol: 'RCL', spot: 260, nowMs: now, context: { exit_before: '2026-10-27' } })
    assert.equal(r.status, 'active')
    assert.equal(r.target.value, 267.8)
    assert.equal(r.valid_until, '2026-10-26T21:00:00.000Z')
    assert.equal(r.exit_before, '2026-10-27')
    assert.equal(r.runup.n, 8)
    const flat = buildCatalystRead({ ...parsed, runup: { ...parsed.runup, median_pct: -0.5 } }, { symbol: 'RCL', spot: 260, nowMs: now })
    assert.equal(flat.status, 'pass', 'a long whose record runs DOWN into the report is no trade')
    assert.equal(flat.target, null)
    const gone = buildCatalystRead({ verdict: 'priced_in', delta: { delta_price_pct: 4, moved_pct: 6 } }, { symbol: 'X', spot: 50, nowMs: now })
    assert.equal(gone.status, 'pass', 'an event fully taken: nothing open, no instant hit')
})

test("the board's report date travels with the name to Prometheus", () => {
    const row = { symbol: 'RCL', cells: { week: { grade: 'C', exit_before: '2026-10-27', range: { pct: 4, atr_mult: 1.4, level: 272 } } }, picks: { week: { why: 'run-up', rank: 1 } } }
    assert.equal(hotlistContext({ id: 'b', day: '2026-10-23' }, row).exit_before, '2026-10-27')
})

test('the pick-up: an empty day with a 09:20 board is caught up; a day that queued anything is not re-queued', async () => {
    const BOARD = { id: 'hb_2026-10-23_preopen', day: '2026-10-23', rows: [
        { symbol: 'ONE', cells: { week: { grade: 'A', range: { open_sky: true } } }, picks: { week: { why: 'first', rank: 1 } } }] }
    const queued = [], asked = [], starts = []
    const deps = {
        enabled: () => true, maxNames: () => 10, maxUsd: () => 1, now: () => Date.parse('2026-10-23T13:30:00Z'),
        board: async (id) => { asked.push(id); return BOARD },
        enqueue: async (row) => { queued.push(row); return { ok: true } },
        listQueue: async (q) => (q.updatedSince ? [] : queued.map(r => ({ ...r, status: 'queued' }))),
        requeueStale: async () => ({ ok: true }),
        startRun: async (o) => { starts.push(o); return { ok: true, run: { id: 'r' } } },
        getRun: () => null,
    }
    const r = await resume('2026-10-23', deps)
    assert.equal(r.outcome, 'caught_up')
    assert.deepEqual(r.queued, ['ONE'])
    assert.deepEqual(asked, ['hb_2026-10-23_preopen'])
    assert.deepEqual(starts[0].symbols, ['ONE'])
    // Now the day has a row: the next tick resumes it, and never reads the board to queue it again.
    queued[0] = { ...queued[0] }
    const again = await resume('2026-10-23', { ...deps, listQueue: async (q) => (q.updatedSince ? [] : [{ symbol: 'ONE', source: 'hotlist', status: 'done' }]) })
    assert.equal(again.outcome, 'nothing_queued')
    assert.equal(asked.length, 1)
    assert.equal((await resume('2026-10-23', { ...deps, board: async () => null, listQueue: async () => [] })).outcome, 'no_names')
    assert.equal((await resume('2026-10-23', { ...deps, listQueue: async () => null })).outcome, 'queue_unavailable')
})
