// Grouping the candidate list into events.
//
// The engine writes one flat row per (run, ticker) with the event denormalised onto it,
// so the screen needs a single query. This turns that back into "this happened, and
// these names are exposed to it" — the shape a reader actually reasons in.
//
// The field that made this worth a test is `event_category`, added after candidates were
// already in Mongo. Every row written before it exists without it, so the header must
// read as unlabelled rather than undefined, and the UI must be able to tell those apart.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupCandidatesByRun, readCandidateRows } from '../../api/aether/aether.service.js'

function row(over = {}) {
    return {
        run_id: 'Canada:2026-09-08',
        ticker: 'NUE',
        rank: 1,
        subject: 'Canada',
        event: 'Canada imposes retaliatory tariffs',
        answer_shape: 'sized',
        event_category: 'trade',
        event_date: '2026-09-08',
        created_at: '2026-09-08T12:00:00+00:00',
        ...over,
    }
}

test('one run becomes one group carrying the event header', () => {
    const [run] = groupCandidatesByRun([row(), row({ ticker: 'STLD' })])
    assert.equal(run.run_id, 'Canada:2026-09-08')
    assert.equal(run.subject, 'Canada')
    assert.equal(run.event_category, 'trade')
    assert.equal(run.candidates.length, 2)
})

test('candidates are ordered by rank inside their event', () => {
    const [run] = groupCandidatesByRun([
        row({ ticker: 'A', rank: 1 }),
        row({ ticker: 'B', rank: 9 }),
        row({ ticker: 'C', rank: 4 }),
    ])
    assert.deepEqual(run.candidates.map(c => c.ticker), ['B', 'C', 'A'])
})

test('an unranked candidate sorts last rather than throwing', () => {
    const [run] = groupCandidatesByRun([
        row({ ticker: 'A', rank: undefined }),
        row({ ticker: 'B', rank: 2 }),
    ])
    assert.deepEqual(run.candidates.map(c => c.ticker), ['B', 'A'])
})

test('events are ordered newest first', () => {
    const runs = groupCandidatesByRun([
        row({ run_id: 'old', created_at: '2026-09-01T00:00:00+00:00' }),
        row({ run_id: 'new', created_at: '2026-09-08T00:00:00+00:00' }),
    ])
    assert.deepEqual(runs.map(r => r.run_id), ['new', 'old'])
})

test('a fiscal event is grouped like any other — the category is a label, not a filter', () => {
    // The whole point of the taxonomy: a subsidy is as runnable as a tariff, and nothing
    // downstream is allowed to treat it differently.
    const runs = groupCandidatesByRun([
        row({ run_id: 'trade', event_category: 'trade' }),
        row({ run_id: 'fiscal', event_category: 'fiscal', subject: 'Section 45X' }),
    ])
    assert.equal(runs.length, 2)
    assert.deepEqual(runs.map(r => r.event_category).sort(), ['fiscal', 'trade'])
})

test('a row stored before the category existed reads as unlabelled, not undefined', () => {
    // The UI renders the chip on truthiness; `undefined` would render nothing too, but
    // it would also mean a JSON response with a missing key rather than an empty one.
    const legacy = row()
    delete legacy.event_category
    const [run] = groupCandidatesByRun([legacy])
    assert.equal(run.event_category, '')
    assert.ok('event_category' in run)
})

test('an empty list is an empty list, not a group with no candidates', () => {
    assert.deepEqual(groupCandidatesByRun([]), [])
})

// ── The read caps RUNS, not rows ─────────────────────────────────────────────
//
// It was `.limit(200)` on rows. On 2026-09-19 a thirty-day window held 18 runs and 273
// surviving rows: the desk header said "(200)", the 45-name Iran run showed five names, and
// the Canada run behind it was gone — silently. A run is the unit the reader reasons in, so
// the cut is made in runs, and a run is either whole or absent.
//
// The collection is faked at the driver surface (aggregate / find / toArray) — ESM bindings
// are immutable, so getDb cannot be stubbed; the read takes the handle instead.

function fakeCollection(rows) {
    const calls = { find: [] }
    const matches = q => rows.filter(r =>
        (q.survived === undefined || r.survived === q.survived)
        && (!q.created_at || r.created_at >= q.created_at.$gte)
        && (!q.run_id || q.run_id.$in.includes(r.run_id)))
    return {
        calls,
        aggregate(pipeline) {
            const q = pipeline.find(s => s.$match).$match
            const limit = pipeline.find(s => s.$limit).$limit
            const byRun = new Map()
            for (const r of matches(q)) {
                const cur = byRun.get(r.run_id)
                if (!cur || r.created_at > cur) byRun.set(r.run_id, r.created_at)
            }
            const out = [...byRun].map(([_id, created_at]) => ({ _id, created_at }))
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .slice(0, limit)
            return { toArray: async () => out }
        },
        find(q) {
            calls.find.push(q)
            return { toArray: async () => matches(q) }
        },
    }
}

function runRows(runId, createdAt, n, over = {}) {
    return Array.from({ length: n }, (_, i) =>
        row({ run_id: runId, created_at: createdAt, ticker: `${runId}-${i}`, rank: n - i, survived: true, ...over }))
}

test('a run is whole or absent — the cap never returns the tail of a run', async () => {
    const col = fakeCollection([
        ...runRows('Intel:2026-09-18', '2026-09-19T13:17:00+00:00', 15),
        ...runRows('Iran:2026-09-09',  '2026-09-10T11:15:00+00:00', 45),
        ...runRows('Canada:2026-09-08','2026-09-09T10:32:00+00:00', 33),
    ])
    const rows = await readCandidateRows(col, { query: { survived: true }, maxRuns: 2 })
    const runs = groupCandidatesByRun(rows)
    assert.deepEqual(runs.map(r => r.run_id), ['Intel:2026-09-18', 'Iran:2026-09-09'],
        'the newest runs survive the cap and the oldest goes, entire')
    assert.equal(runs[1].candidates.length, 45, 'the straddling run comes back whole, not as its newest rows')
})

test('under the cap every row in the window comes back — 273 rows is 273 rows', async () => {
    const col = fakeCollection([
        ...runRows('a', '2026-09-19T00:00:00+00:00', 100),
        ...runRows('b', '2026-09-18T00:00:00+00:00', 100),
        ...runRows('c', '2026-09-17T00:00:00+00:00', 73),
    ])
    const rows = await readCandidateRows(col, { query: { survived: true } })
    assert.equal(rows.length, 273)
})

test('the window and the survived filter reach the row read too, not only the run pick', async () => {
    // A run that has survivors also has dropped rows under the same run_id; picking the run
    // by its survivors and then reading every row of it would let the dropped ones back in.
    const col = fakeCollection([
        ...runRows('a', '2026-09-19T00:00:00+00:00', 3),
        ...runRows('a', '2026-09-19T00:00:00+00:00', 2, { survived: false }),
    ])
    const rows = await readCandidateRows(col, { query: { survived: true, created_at: { $gte: '2026-09-01' } } })
    assert.equal(rows.length, 3)
    assert.equal(col.calls.find[0].survived, true)
    assert.ok(col.calls.find[0].created_at, 'the window is on the row read')
})

test('an empty window makes no row read at all', async () => {
    const col = fakeCollection([])
    const rows = await readCandidateRows(col, { query: { survived: true } })
    assert.deepEqual(rows, [])
    assert.equal(col.calls.find.length, 0, '`$in: []` is a pointless round trip')
})

// ── Did this event disclose at all ───────────────────────────────────────────
//
// Everything the engine records about quality is per NAME, so nothing answered the
// run-level question — and the three live runs differ enormously on exactly that while
// reading identically as a list. Canada came back 26 of 41 survivors quantified, Bombardier
// 19 of 28, Iran 8 of 45. All three look like "forty-odd names"; only two are breadth.

test('a run carries a reading of its own evidence', () => {
    const runs = groupCandidatesByRun([
        row({ ticker: 'A', verdict: 'quantified' }),
        row({ ticker: 'B', verdict: 'quantified' }),
        row({ ticker: 'C', verdict: 'mentioned' }),
    ])
    assert.equal(runs[0].evidence.n_survived, 3)
    assert.equal(runs[0].evidence.n_quantified, 2)
    assert.equal(runs[0].evidence.n_mentioned, 1)
    assert.equal(runs[0].evidence.discloses, true)
})

test('an event filings never turn into a line item is marked as not disclosing', () => {
    // The Iran shape: almost nothing quantified, so verification rejected almost nothing
    // and the length of the list said nothing about the strength of it.
    const runs = groupCandidatesByRun([
        row({ ticker: 'A', verdict: 'mentioned' }),
        row({ ticker: 'B', verdict: 'mentioned' }),
        row({ ticker: 'C', verdict: 'silent' }),
    ])
    assert.equal(runs[0].evidence.n_quantified, 0)
    assert.equal(runs[0].evidence.discloses, false)
})

test('the reading is per run, not pooled across the window', () => {
    const runs = groupCandidatesByRun([
        row({ run_id: 'Canada:1', ticker: 'A', verdict: 'quantified', created_at: '2026-09-09T00:00:00+00:00' }),
        row({ run_id: 'Iran:1', ticker: 'B', verdict: 'silent', created_at: '2026-09-08T00:00:00+00:00' }),
    ])
    const byId = Object.fromEntries(runs.map(r => [r.run_id, r.evidence]))
    assert.equal(byId['Canada:1'].discloses, true)
    assert.equal(byId['Iran:1'].discloses, false)
})

test('an empty run is not a division by zero and does not claim to disclose', () => {
    const runs = groupCandidatesByRun([])
    assert.deepEqual(runs, [])
})

test('a verdict nobody thought of is counted as a survivor, not as a figure', () => {
    // no_filer, skipped and unverified are all real values here, and none of them is a
    // reading of a filing. Counting one as quantified would overstate the run.
    const runs = groupCandidatesByRun([
        row({ ticker: 'A', verdict: 'quantified' }),
        row({ ticker: 'B', verdict: 'something_new' }),
    ])
    assert.equal(runs[0].evidence.n_survived, 2)
    assert.equal(runs[0].evidence.n_quantified, 1)
    assert.equal(runs[0].evidence.n_mentioned, 0)
    assert.equal(runs[0].evidence.n_silent, 0)
})

test('a missing verdict does not throw', () => {
    const runs = groupCandidatesByRun([row({ ticker: 'A' })])
    assert.equal(runs[0].evidence.n_quantified, 0)
    assert.equal(runs[0].evidence.quantified_share, 0)
})
