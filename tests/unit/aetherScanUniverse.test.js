import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    buildUniverse, priorScanState, thesisLine, getScanUniverse, SCAN_SOURCE, UNIVERSE_DAYS,
} from '../../services/aetherScanUniverse.service.js'

// The radar → Argus universe and the rule that stops a name being scanned every day.
// buildUniverse is pure; getScanUniverse is exercised through its injected IO.

/** One run with one candidate, defaults chosen so a test only states what it is about. */
function run({ id = 'Canada:2026-09-20', subject = 'Canada', found = '2026-09-20T10:00:00Z',
               event_date = '2026-09-20', names = [] } = {}) {
    return {
        run_id: id, subject, event_date, created_at: found,
        candidates: names.map(n => ({
            ticker: n.ticker, company: n.company ?? '', side: n.side ?? 'helped',
            mechanism: n.mechanism ?? '', verdict: n.verdict ?? 'silent',
            rank: n.rank ?? 1, created_at: n.found ?? found, excess_pct: n.excess_pct ?? null,
            subject, event_date,
        })),
    }
}

/** A saved radar list: the names it kept, and the run ids its universe was cut from. */
const list = (sourceRuns, tickers) => ({ sourceRuns, candidates: tickers.map(t => ({ ticker: t })) })

// ── the universe, with nothing scanned yet ────────────────────────────────────

test('a first scan carries every name on the board', () => {
    const { candidates, skipped } = buildUniverse([
        run({ names: [{ ticker: 'NUE' }, { ticker: 'X' }] }),
    ], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['NUE', 'X'])
    assert.deepEqual(skipped, [])
})

test('one entry per ticker even when several events reach it — the edit-list seam is keyed by ticker', () => {
    const { candidates } = buildUniverse([
        run({ id: 'a:1', subject: 'Canada',  names: [{ ticker: 'XOM', side: 'hurt',   rank: 2 }] }),
        run({ id: 'b:1', subject: 'Hormuz',  names: [{ ticker: 'XOM', side: 'helped', rank: 5 }] }),
    ], [])
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].events, 2)
    // The best rank across its appearances, so the order is the board's own.
    assert.equal(candidates[0].rank, 5)
})

test('direction is never passed — Argus is asked a direction-blind question', () => {
    const { candidates } = buildUniverse([run({ names: [{ ticker: 'NUE', side: 'hurt' }] })], [])
    assert.equal(candidates[0].direction, undefined)
    // The side is information, so it is stated in the line rather than dropped.
    assert.match(candidates[0].thesis, /HURT/)
})

test('ordering is best rank first, then ticker — two runs of one board agree', () => {
    const { candidates } = buildUniverse([
        run({ names: [{ ticker: 'BBB', rank: 1 }, { ticker: 'AAA', rank: 1 }, { ticker: 'CCC', rank: 9 }] }),
    ], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['CCC', 'AAA', 'BBB'])
})

test('a blank ticker is dropped rather than carried as an empty row', () => {
    const { candidates } = buildUniverse([run({ names: [{ ticker: '' }, { ticker: 'NUE' }] })], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['NUE'])
})

test('the company name is taken off whichever appearance carries one', () => {
    const { candidates } = buildUniverse([
        run({ id: 'a:1', names: [{ ticker: 'XOM', company: '' }] }),
        run({ id: 'b:1', names: [{ ticker: 'XOM', company: 'Exxon Mobil Corporation' }] }),
    ], [])
    assert.equal(candidates[0].company, 'Exxon Mobil Corporation')
})

// ── the exclusion rule ────────────────────────────────────────────────────────

test('a name on yesterday\'s list is held back, with the reason', () => {
    const board = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }, { ticker: 'X' }] })]
    const { candidates, skipped } = buildUniverse(board, [list(['Canada:2026-09-20'], ['NUE'])])
    assert.deepEqual(candidates.map(c => c.ticker), ['X'])
    assert.deepEqual(skipped, [{ ticker: 'NUE', reason: 'listed_already' }])
})

test('THE EXCEPTION: an event no previous scan saw puts a listed name back', () => {
    const board = [
        run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }] }),
        run({ id: 'Hormuz:2026-09-22', names: [{ ticker: 'NUE' }] }),
    ]
    const { candidates, skipped } = buildUniverse(board, [list(['Canada:2026-09-20'], ['NUE'])])
    assert.deepEqual(candidates.map(c => c.ticker), ['NUE'])
    assert.deepEqual(skipped, [])
    // And it is marked, so the seed can say why a name the user has seen is back.
    assert.equal(candidates[0].returning, true)
})

test('events the last scan already saw do not put a listed name back, however many there are', () => {
    const board = [
        run({ id: 'Canada:2026-09-18', names: [{ ticker: 'NUE' }] }),
        run({ id: 'Trump:2026-09-20',  names: [{ ticker: 'NUE' }] }),
    ]
    const prior = [list(['Canada:2026-09-18', 'Trump:2026-09-20'], ['NUE'])]
    assert.deepEqual(buildUniverse(board, prior).candidates, [])
})

test('a REWRITTEN candidate date cannot re-admit a name — the rule never reads the clock', () => {
    // Discovered.to_mongo() stamps created_at with `now` when a candidate is stored without one,
    // so re-verifying an event used to make every name it reached look brand new.
    const board = [run({ id: 'Canada:2026-09-18', found: '2030-01-01T00:00:00Z', names: [{ ticker: 'NUE' }] })]
    assert.deepEqual(buildUniverse(board, [list(['Canada:2026-09-18'], ['NUE'])]).candidates, [])
})

test('a name Argus REJECTED is not excluded — it was never on the output list', () => {
    // The universe handed over held both; only NUE came back on the saved list.
    const board = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }, { ticker: 'X' }] })]
    const { candidates } = buildUniverse(board, [list(['Canada:2026-09-20'], ['NUE'])])
    assert.deepEqual(candidates.map(c => c.ticker), ['X'])
})

test('events seen across SEVERAL prior lists all count as seen', () => {
    const board = [
        run({ id: 'Canada:2026-09-18', names: [{ ticker: 'NUE' }] }),
        run({ id: 'Hormuz:2026-09-22', names: [{ ticker: 'NUE' }] }),
    ]
    // Neither list saw both events; between them they saw both, so nothing here is new.
    const prior = [list(['Canada:2026-09-18'], ['NUE']), list(['Hormuz:2026-09-22'], [])]
    assert.deepEqual(buildUniverse(board, prior).candidates, [])
})

test('the run ids of THIS universe come back out, so the caller can store them', () => {
    const board = [run({ id: 'Canada:2026-09-18', names: [{ ticker: 'NUE' }] }),
                   run({ id: 'Hormuz:2026-09-22', names: [] })]
    // Including the event that produced no names — it was still on the board and still seen.
    assert.deepEqual(buildUniverse(board, []).runIds, ['Canada:2026-09-18', 'Hormuz:2026-09-22'])
})

test('first-time names are not marked as returning', () => {
    const { candidates } = buildUniverse([run({ names: [{ ticker: 'NUE' }] })], [])
    assert.equal(candidates[0].returning, undefined)
})

test('priorScanState: case-folds tickers and unions the run ids', () => {
    const { listed, seenRuns } = priorScanState([list(['a:1'], ['nue']), list(['b:1'], ['NUE', 'x'])])
    assert.deepEqual([...listed].sort(), ['NUE', 'X'])
    assert.deepEqual([...seenRuns].sort(), ['a:1', 'b:1'])
})

test('priorScanState: a list with no sourceRuns excludes nothing, and junk is survived', () => {
    // No record of which events it saw → every event reads as new and its names come back.
    // Scanning a name twice costs a row in a prompt; hiding one loses it.
    const { listed, seenRuns } = priorScanState([{ candidates: [{ ticker: 'X' }] }, null, { sourceRuns: ['a:1'] }])
    assert.equal(listed.size, 0)
    assert.deepEqual([...seenRuns], ['a:1'])
})

test('a prior list with no sourceRuns excludes nothing', () => {
    const board = [run({ names: [{ ticker: 'NUE' }] })]
    const out = buildUniverse(board, [{ candidates: [{ ticker: 'NUE' }] }])
    assert.deepEqual(out.candidates.map(c => c.ticker), ['NUE'])
})

// ── the thesis line ───────────────────────────────────────────────────────────

test('one claim reads as one sentence; the filing verdict rides along', () => {
    const line = thesisLine([{ subject: 'Canada', side: 'hurt', mechanism: 'imports steel', verdict: 'quantified', event_date: '2026-09-20' }])
    assert.equal(line, 'HURT by Canada (2026-09-20) — imports steel — filings: quantified — no move measured')
})

test('several claims are counted and spelled out', () => {
    const line = thesisLine([
        { subject: 'Canada', side: 'hurt',   event_date: '2026-09-20' },
        { subject: 'Hormuz', side: 'helped', event_date: '2026-09-19' },
    ])
    assert.match(line, /^Reached by 2 events\./)
    assert.match(line, /HURT by Canada/)
    assert.match(line, /HELPED by Hormuz/)
})

test('past the fourth claim the rest are counted rather than printed', () => {
    const line = thesisLine(Array.from({ length: 5 }, (_, i) => ({ subject: `E${i}`, side: 'helped' })))
    assert.match(line, /and 2 further events/)
})

test('a long mechanism is clipped, not dropped — whole boards go in one prompt', () => {
    const line = thesisLine([{ subject: 'Canada', side: 'hurt', mechanism: 'x'.repeat(500) }])
    assert.ok(line.length < 400, line.length)
    assert.match(line, /…/)
})

test('no claims → an empty line rather than a throw', () => {
    assert.equal(thesisLine([]), '')
})

// ── getScanUniverse: the IO seam ──────────────────────────────────────────────

const io = ({ runs = [], scans = [] } = {}) => ({
    runs:  async () => runs,
    scans: async () => scans,
})

test('only radar-sourced scans count as prior lists', async () => {
    const runs  = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }] })]
    const scans = [
        // A list the user built by hand that happens to hold the same name must not exclude it.
        { source: null, sourceRuns: ['Canada:2026-09-20'], candidates: [{ ticker: 'NUE' }] },
    ]
    const out = await getScanUniverse('u1', {}, io({ runs, scans }))
    assert.deepEqual(out.candidates.map(c => c.ticker), ['NUE'])
    assert.equal(out.priorLists, 0)
})

test('a radar-sourced scan does exclude', async () => {
    const runs  = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }] })]
    const scans = [{ source: SCAN_SOURCE, sourceRuns: ['Canada:2026-09-20'], candidates: [{ ticker: 'NUE' }] }]
    const out = await getScanUniverse('u1', {}, io({ runs, scans }))
    assert.deepEqual(out.candidates, [])
    assert.equal(out.priorLists, 1)
    assert.equal(out.skipped[0].ticker, 'NUE')
})

test('the window defaults to the list\'s own and is reported back', async () => {
    const out = await getScanUniverse('u1', {}, io())
    assert.equal(out.days, UNIVERSE_DAYS)
})

test('a failed scan read THROWS rather than handing back the whole board', async () => {
    const deps = { runs: async () => [run({ names: [{ ticker: 'NUE' }] })],
                   scans: async () => { throw new Error('mongo down') } }
    await assert.rejects(() => getScanUniverse('u1', {}, deps), /mongo down/)
})

test('no scans at all is not a failure — it is a first scan', async () => {
    const out = await getScanUniverse('u1', {}, { runs: async () => [run({ names: [{ ticker: 'NUE' }] })], scans: async () => null })
    assert.deepEqual(out.candidates.map(c => c.ticker), ['NUE'])
})
