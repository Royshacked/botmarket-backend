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
