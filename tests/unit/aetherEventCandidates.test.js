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
import { groupCandidatesByRun } from '../../api/aether/aether.service.js'

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
