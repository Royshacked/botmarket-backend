import { test } from 'node:test'
import assert from 'node:assert/strict'
import { throughStats, runUpReadText } from '../../services/tools/runup.tools.js'
import { _parseCatalystRead, _cleanRunUpCall, _cleanThrough } from '../../services/agents/analyst.agent.service.js'
import { buildCatalystRead, gradeCatalystRead, holdValidUntil, readFacts, GRADE_GIVE_UP_MS } from '../../services/catalystRead.service.js'
import { catalystRecord } from '../../services/prometheusCalls.service.js'
import { seedFacts } from '../../services/hotlist.service.js'
import { researchOpening } from '../../services/researchRun.service.js'

// Run-up reads (docs/design/runup-reads.md; Roy, 2026-10-31: "Prometheus should confirm (a) this company had good
// reports — worth going into the run-up, (b) is it worth to stay in the report"): a rule name's read answers the two,
// a target is optional on an exit, a hold runs through the report and needs one.

const DAY = 86_400_000
const NOW = Date.parse('2026-10-31T10:00:00Z')            // a Saturday, as the 11-02 board's reads were
const REPORT = '2026-11-09'                                 // a Monday: the exit is the close of Friday 11-06
const CTX = { hotlist: true, rule: true, day: '2026-11-02', exit_before: REPORT, atr_pct: 2 }
const LINE = { basis: 'run_up', report: REPORT, lead_days: 5, n: 11, median_pct: 1.5, p25_pct: -1, p75_pct: 3, up_share: 0.6,
    median_excess_pct: 0.3, full_lead: 10, full_median_pct: 0.8, so_far_pct: 3.7 }   // CEG's shape: "already ran" by the old test
const read = (block, ctx = CTX, spot = 100) => buildCatalystRead(block, { symbol: 'CEG', spot, spy: 500, nowMs: NOW, context: ctx })

function bars(start, n, closeAt) {
    const out = []
    for (let t = Date.parse(`${start}T20:00:00Z`), i = 0; out.length < n; t += DAY) {
        const d = new Date(t).getUTCDay()
        if (d === 0 || d === 6) continue
        out.push({ timestamp: t / 1000, close: closeAt(i++, new Date(t).toISOString().slice(0, 10)) })
    }
    return out
}

test('through the report: the close before it to the close of the session after — all reports, and after the beats', () => {
    // Flat at 100, but 110 on the session after each report — and the 08-11 report (a miss) falls to 95.
    const reports = ['2026-02-10', '2026-05-12', '2026-08-11', '2026-10-13']
    const after = new Set(['2026-02-11', '2026-05-13', '2026-10-14'])
    const b = bars('2026-01-02', 220, (i, d) => (after.has(d) ? 110 : d === '2026-08-12' ? 95 : 100))
    const s = throughStats({ reports, bars: b, beats: ['2026-02-10', '2026-05-12', '2026-10-13'] })
    assert.equal(s.n, 4)
    assert.deepEqual(s.rows.map(r => [r.report, r.pct, r.beat]), [['2026-10-13', 10, true], ['2026-08-11', -5, false], ['2026-05-12', 10, true], ['2026-02-10', 10, true]])
    assert.equal(s.median_pct, 10)
    assert.equal(s.up_share, 0.75)
    assert.equal(s.beat_n, 3)
    assert.equal(s.beat_median_pct, 10)
    // A report with no session after it yet (the bars stop) is left out, not priced off a missing close.
    assert.equal(throughStats({ reports: ['2026-10-13'], bars: b.filter(x => x.timestamp * 1000 < Date.parse('2026-10-14T00:00:00Z')) }).n, 0)
})

test('the tool line carries the through-the-report record, and "already ran" is context, never a verdict', () => {
    const stats = { n: 5, rows: [], median_pct: 1, p25_pct: 0, p75_pct: 2, up_share: 0.6, median_excess_pct: 0.2 }
    const through = { n: 5, median_pct: -1.2, p25_pct: -4, p75_pct: 3, up_share: 0.4, beat_n: 4, beat_median_pct: 0.5 }
    const text = runUpReadText('CEG', { report: REPORT, lead: 5, stats, cycle: { full_lead: 10, full_median_pct: 0.8, so_far_pct: 3.7 }, through })
    assert.match(text, /Through the report .*median -1\.2%.*up 40% of the time over 5 reports; after the 4 that beat, median 0\.5%/)
    assert.match(text, /context: say whether that changes your call/)
    assert.doesNotMatch(text, /priced_in/)
    const line = JSON.parse(text.split('as "runup" in your block: ')[1])
    assert.equal(line.through_median_pct, -1.2)
    assert.equal(line.through_beat_median_pct, 0.5)
    // Too few reports through: no line, no fields.
    assert.doesNotMatch(runUpReadText('CEG', { report: REPORT, lead: 5, stats, through: { ...through, n: 2 } }), /Through the report/)
})

test('the block: run_up and through_report are parsed, checked, else null', () => {
    assert.deepEqual(_cleanRunUpCall({ worth: true, why: ' three real beats ' }), { worth: true, why: 'three real beats' })
    assert.equal(_cleanRunUpCall({ worth: 'yes' }), null)
    assert.deepEqual(_cleanThrough({ call: 'hold', why: 'gaps up after beats' }), { call: 'hold', why: 'gaps up after beats' })
    assert.equal(_cleanThrough({ call: 'maybe' }), null)
    const p = _parseCatalystRead(`<catalyst_read>${JSON.stringify({ ticker: 'ceg', verdict: 'credible', run_up: { worth: true }, through_report: { call: 'exit' }, runup: { ...LINE, through_n: 6, through_median_pct: 2 } })}</catalyst_read>`)
    assert.deepEqual(p.run_up, { worth: true, why: null })
    assert.deepEqual(p.through_report, { call: 'exit', why: null })
    assert.equal(p.runup.through_median_pct, 2)
})

test('(a) worth it, no target: CONFIRMED — active, out before the report, no veto for having run this cycle', () => {
    const r = read({ verdict: 'credible', run_up: { worth: true, why: 'beats with guidance raised' }, through_report: { call: 'exit' }, runup: LINE, company: { verdict: 'weak' } })
    assert.equal(r.status, 'active')
    assert.equal(r.pass_reason, null)
    assert.equal(r.target, null)
    assert.equal(r.exit_before, REPORT)
    assert.equal(r.valid_until, '2026-11-06T21:00:00.000Z', 'the close of the last SESSION before the Monday report — Friday, not Sunday')
    assert.deepEqual(r.through_report, { call: 'exit', why: null, report: REPORT })
    assert.deepEqual(r.run_up, { worth: true, why: 'beats with guidance raised' })
})

test('(a) not worth it, a broken company, no window left: a pass with its reason', () => {
    assert.deepEqual([read({ verdict: 'unclear', run_up: { worth: false } }).status, read({ verdict: 'unclear', run_up: { worth: false } }).pass_reason], ['pass', 'not_worth'])
    const broken = read({ verdict: 'credible', run_up: { worth: true }, company: { verdict: 'broken' } })
    assert.deepEqual([broken.status, broken.pass_reason], ['pass', 'company'])
    const late = buildCatalystRead({ verdict: 'credible', run_up: { worth: true } }, { symbol: 'CEG', spot: 100, nowMs: Date.parse('2026-11-09T14:00:00Z'), context: CTX })
    assert.deepEqual([late.status, late.pass_reason], ['pass', 'report_too_close'])
    // An old-shaped answer (no run_up): the verdict decides — credible is worth it.
    assert.equal(read({ verdict: 'credible', runup: LINE }).status, 'active')
    // …and it is stored with the answer it implies, so the FE and Mentor (which read `run_up.worth`) see it confirmed too.
    assert.deepEqual(read({ verdict: 'credible', runup: LINE }).run_up, { worth: true, why: null })
    assert.equal(readFacts(read({ verdict: 'credible', runup: LINE })) != null, true)
    assert.equal(read({ verdict: 'priced_in', runup: LINE }).pass_reason, 'not_worth')
})

test('an exit with a target keeps it; one too close to trade is dropped, the read still confirmed', () => {
    const t = read({ verdict: 'credible', run_up: { worth: true }, runup: LINE, target: { price: 103, why: 'the run-up median, a bit more' } })
    assert.equal(t.status, 'active')
    assert.equal(t.target.value, 103)
    assert.equal(t.target.basis, 'prometheus')
    const small = read({ verdict: 'credible', run_up: { worth: true }, runup: LINE, target: { price: 100.5 } })   // +0.5% < 1% (half ATR 1%)
    assert.deepEqual([small.status, small.target], ['active', null])
})

test('(b) a HOLD with a target runs through the report: window to the session after it, no exit_before', () => {
    const r = read({ verdict: 'credible', run_up: { worth: true }, through_report: { call: 'hold', why: 'gaps up after beats' }, runup: LINE, target: { price: 108 } })
    assert.equal(r.status, 'active')
    assert.equal(r.exit_before, null)
    assert.equal(r.valid_until, '2026-11-10T21:00:00.000Z', 'the close of the session after the report')
    assert.deepEqual(r.through_report, { call: 'hold', why: 'gaps up after beats', report: REPORT })
    // A Friday report holds to Monday's close.
    assert.equal(holdValidUntil({ nowMs: NOW, report: '2026-11-06' }), '2026-11-09T21:00:00.000Z')
    assert.equal(holdValidUntil({ nowMs: Date.parse('2026-11-12T00:00:00Z'), report: REPORT }), null)
})

test('(b) a HOLD with no target, or one too close, is kept as an exit and says so', () => {
    for (const target of [undefined, { price: 100.4 }]) {
        const r = read({ verdict: 'credible', run_up: { worth: true }, through_report: { call: 'hold' }, runup: LINE, ...(target ? { target } : {}) })
        assert.equal(r.status, 'active')
        assert.equal(r.exit_before, REPORT)
        assert.equal(r.valid_until, '2026-11-06T21:00:00.000Z')
        assert.deepEqual(r.through_report, { call: 'exit', why: null, report: REPORT, dropped: 'no_target' })
    }
    // A pass never carries a dropped hold — nothing was confirmed to hold.
    assert.equal(read({ verdict: 'unclear', run_up: { worth: false }, through_report: { call: 'hold' } }).through_report.dropped, undefined)
})

test('an event read (no rule) is unchanged: no target is still a pass', () => {
    const r = buildCatalystRead({ verdict: 'credible', runup: LINE }, { symbol: 'CEG', spot: 100, nowMs: NOW, context: { hotlist: true, exit_before: REPORT } })
    assert.equal(r.status, 'pass')
    assert.equal(r.through_report, undefined)
})

test('grading a confirmed read with no target: nothing until the window ends, then `closed` on the window vs SPY', () => {
    const r = read({ verdict: 'credible', run_up: { worth: true }, runup: LINE })
    const end = Date.parse(r.valid_until)
    assert.equal(gradeCatalystRead(r, { price: 150, spy: 500, nowMs: end - DAY }), null, 'no target: a high price inside the window is no hit')
    const g = gradeCatalystRead(r, { price: null, spy: null, nowMs: end + 1000, window: { high: 105, close: 103, spy_close: 505 } })
    assert.equal(g.status, 'closed')
    assert.deepEqual([g.outcome.return_pct, g.outcome.spy_return_pct, g.outcome.vs_spy, g.outcome.hit, g.outcome.basis], [3, 1, 2, null, 'window'])
    assert.equal(gradeCatalystRead(r, { price: null, spy: null, nowMs: end + 1000, window: null }), null, 'bars not in yet: wait')
    assert.equal(gradeCatalystRead(r, { price: null, spy: null, nowMs: end + GRADE_GIVE_UP_MS, window: null }).outcome.basis, 'unpriced')
})

test('the record: closed reads are backed, the hit rate is over the targeted, holds and exits apart', () => {
    const m = (v) => ({ window_mark: { vs_spy: v } })
    const rec = catalystRecord([
        { status: 'hit', through_report: { call: 'hold' }, ...m(4) },
        { status: 'expired', ...m(-1) },
        { status: 'closed', through_report: { call: 'exit' }, ...m(1) },
        { status: 'pass', pass_reason: 'not_worth', ...m(0.5) },
        { status: 'active' },
    ])
    assert.equal(rec.backed.reads, 3)
    assert.equal(rec.backed.targeted, 2)
    assert.equal(rec.backed.hit, 1)
    assert.equal(rec.backed.by_call.hold.n, 1)
    assert.equal(rec.backed.by_call.exit.n, 1, 'an event read (no call) is in neither')
    assert.equal(rec.passes.by_reason.not_worth.n, 1)
    assert.equal(rec.open, 1)
})

test('Mentor hears it: confirmed with no target, a hold, and the board line yields to the hold', () => {
    const exit = read({ verdict: 'credible', confidence: 0.7, run_up: { worth: true, why: 'three real beats' }, through_report: { call: 'exit', why: 'gaps both ways' }, runup: LINE, company: { verdict: 'sound' } })
    const f = readFacts(exit)
    assert.match(f, /^Prometheus \(credible, 0\.7\): confirmed for the run-up, no target of his/)
    assert.match(f, /worth the run-up — three real beats/)
    assert.match(f, /out before the report 2026-11-09 — gaps both ways/)
    const hold = readFacts(read({ verdict: 'credible', run_up: { worth: true }, through_report: { call: 'hold', why: 'gaps up after beats' }, runup: LINE, target: { price: 108 } }))
    assert.match(hold, /target 108\.00/)
    assert.match(hold, /HOLD THROUGH the report 2026-11-09 — gaps up after beats/)
    assert.doesNotMatch(hold, /out before/)
    const dropped = readFacts(read({ verdict: 'credible', run_up: { worth: true }, through_report: { call: 'hold' }, runup: LINE }))
    assert.match(dropped, /leaned to holding but set no target/)
    assert.equal(readFacts(read({ verdict: 'unclear', run_up: { worth: false } })), null, 'a pass is not handed on')
    const row = { symbol: 'CEG', next_earnings: REPORT, cells: { week: { grade: 'R', exit_before: REPORT, why: ['reports 2026-11-09'] } } }
    assert.match(seedFacts(row, 'week'), /the setup must be out before it/)
    assert.match(seedFacts(row, 'week', { hold: true }), /Prometheus says hold through it/)
    assert.doesNotMatch(seedFacts(row, 'week', { hold: true }), /must be out before/)
})

test('the opening asks a rule name the two questions, and when the trade opens', () => {
    const o = researchOpening({ symbol: 'CEG', context: { hotlist: true, rule: true, day: '2026-11-02', facts: 'run-up rule: reports 2026-11-09' } })
    assert.match(o, /run-up rule listed it THIS WEEK, bought at the 2026-11-02 open/)
    assert.match(o, /\(a\) were its last reports good enough to go into the run-up, and \(b\) is the report itself worth holding through/)
    assert.match(o, /The run-up rule listed it/)
})

test('code review 2026-10-31: a weekend read, a verdict at odds with (a), no report date, a session in progress', async () => {
    // Saturday 11-07 for a Monday 11-09 report: Friday's close has passed — no session left, nothing to confirm.
    const sat = buildCatalystRead({ verdict: 'credible', run_up: { worth: true } }, { symbol: 'CEG', spot: 100, nowMs: Date.parse('2026-11-07T15:00:00Z'), context: CTX })
    assert.deepEqual([sat.status, sat.pass_reason], ['pass', 'report_too_close'])
    // worth:true beside a contradicted / priced-in verdict is not confirmed, and is stored as not worth it.
    for (const verdict of ['contradicted', 'priced_in', 'unclear']) {
        const r = read({ verdict, run_up: { worth: true, why: 'x' } })
        assert.deepEqual([r.status, r.pass_reason, r.run_up], ['pass', 'not_worth', { why: 'x', worth: false }], verdict)
    }
    // No report date anywhere: not a run-up — a pass, never a 30-day confirmation.
    const none = read({ verdict: 'credible', run_up: { worth: true } }, { ...CTX, exit_before: null })
    assert.deepEqual([none.status, none.pass_reason], ['pass', 'no_report'])
    // Today's bar (a session in progress) is no "after" close.
    const b = bars('2026-10-01', 20, (i, d) => (d === '2026-10-15' ? 120 : 100))
    assert.equal(throughStats({ reports: ['2026-10-14'], bars: b, today: '2026-10-15' }).n, 0)
    assert.equal(throughStats({ reports: ['2026-10-14'], bars: b, today: '2026-10-16' }).median_pct, 20)
})
