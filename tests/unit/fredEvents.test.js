import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _assembleFedEvents } from '../../providers/fred.provider.js'

const releases = [
    { date: '2026-07-30', event: 'GDP', impact: 'high', kind: 'data' },
    { date: '2026-07-02', event: 'Employment Situation (Jobs)', impact: 'high', kind: 'data' },
    { date: '2026-07-14', event: 'CPI (Inflation)', impact: 'high', kind: 'data' },
]

test('fed: merges FOMC dates that fall inside the window and sorts soonest-first', () => {
    const out = _assembleFedEvents(releases, '2026-07-01', '2026-08-15', ['2026-07-29'])

    assert.deepEqual(out.map(e => e.date), ['2026-07-02', '2026-07-14', '2026-07-29', '2026-07-30'])
    const fomc = out.find(e => e.kind === 'fomc')
    assert.equal(fomc.date, '2026-07-29')
    assert.equal(fomc.event, 'FOMC Rate Decision')
    assert.equal(fomc.impact, 'high')
})

test('fed: FOMC dates outside the window are excluded', () => {
    const out = _assembleFedEvents(releases, '2026-07-01', '2026-08-15', ['2026-06-17', '2026-09-16'])

    assert.equal(out.filter(e => e.kind === 'fomc').length, 0)
    assert.equal(out.length, releases.length)
})

test('fed: window boundaries are inclusive', () => {
    const out = _assembleFedEvents([], '2026-07-01', '2026-07-29', ['2026-07-01', '2026-07-29', '2026-07-30'])

    assert.deepEqual(out.map(e => e.date), ['2026-07-01', '2026-07-29'])
})

test('fed: no releases and no in-window FOMC yields an empty list', () => {
    const out = _assembleFedEvents([], '2026-07-01', '2026-07-10', ['2026-07-29'])
    assert.deepEqual(out, [])
})
