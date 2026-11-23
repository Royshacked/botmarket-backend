import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isoWeek, onePerWeek, scoredRuns } from '../../services/situation/scorecard.js'
import { gradeForecasts } from '../../services/situation/store.js'

test('isoWeek and onePerWeek: the last item of each Monday-based week', () => {
    assert.equal(isoWeek('2025-01-06'), '2025-W02')
    assert.equal(isoWeek('2024-12-30'), '2025-W01')
    const xs = [{ as_of: '2025-01-06', n: 1 }, { as_of: '2025-01-08', n: 2 }, { as_of: '2025-01-13', n: 3 }]
    assert.deepEqual(onePerWeek(xs).map(x => x.n), [2, 3])
})

test('scoredRuns: one scheduled run a week; events and overrides never scored', () => {
    const runs = [
        { run_id: 'b', kind: 'build', as_of: '2025-01-06' }, { run_id: 'e1', kind: 'event', as_of: '2025-01-08' },
        { run_id: 'w', kind: 'weekly', as_of: '2025-01-13' }, { run_id: 'o', kind: 'event', as_of: '2025-01-13' },
        { run_id: 'e2', kind: 'event', as_of: '2025-01-15' },
    ]
    assert.deepEqual(scoredRuns(runs).map(r => r.run_id), ['b', 'w'])
})

test('gradeForecasts: only forecasts of runs saved whole are graded', async () => {
    const forecasts = [
        { forecast_id: 'f1', node_id: 'n', option: 'yes', p: 0.8, run_id: 'ok', outcome: null },
        { forecast_id: 'f2', node_id: 'n', option: 'yes', p: 0.6, run_id: 'half', outcome: null },
    ]
    const runs = [{ run_id: 'ok', complete: true }, { run_id: 'half', complete: false }]
    const db = { collection: (name) => ({
        find: (q) => ({ toArray: async () => (name === 'situation_runs' ? runs.filter(r => q.run_id.$in.includes(r.run_id) && r.complete === q.complete) : forecasts.filter(f => f.node_id === q.node_id && f.outcome === null)) }),
        updateOne: async (q, u) => { Object.assign(forecasts.find(f => f.forecast_id === q.forecast_id), u.$set) },
    }) }
    const n = await gradeForecasts('n', 'yes', '2025-02-01', { db: async () => db })
    assert.equal(n, 1)
    assert.equal(forecasts[0].outcome, 1)
    assert.equal(forecasts[1].outcome, null)
})
