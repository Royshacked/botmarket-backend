import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mirrorDiscoveryRuns } from '../../services/aetherMirror.service.js'

// A discovery run spent in the HOUSE database is copied — by run_id, since the spawn time — into
// the laptop's own database, so the local Aether list shows it. A copy, never a second run.

function fakeDb(name, data = {}) {
    const writes = {}
    return {
        databaseName: name,
        writes,
        collection(coll) {
            const rows = data[coll] ?? []
            return {
                find(q) {
                    const out = rows.filter(r => {
                        if (q.created_at?.$gte) return r.created_at >= q.created_at.$gte
                        if (q.run_id?.$in)      return q.run_id.$in.includes(r.run_id)
                        return true
                    })
                    return { toArray: async () => out }
                },
                async bulkWrite(ops) {
                    writes[coll] = ops.map(o => o.replaceOne)
                    return { upsertedCount: ops.length, modifiedCount: 0 }
                },
            }
        },
    }
}

const house = () => fakeDb('test', {
    aether_event_runs: [
        { _id: 'x1', run_id: 'r_old', created_at: '2026-09-19T10:00:00+00:00', subject: 'old' },
        { _id: 'x2', run_id: 'r_new', created_at: '2026-09-19T16:05:00+00:00', subject: 'new' },
    ],
    aether_event_candidates: [
        { _id: 'c1', run_id: 'r_old', ticker: 'AAA' },
        { _id: 'c2', run_id: 'r_new', ticker: 'BBB', tier: 2 },
        { _id: 'c3', run_id: 'r_new', ticker: 'CCC', tier: 1 },
    ],
    aether_run_usage: [
        { _id: 'u1', run_id: 'r_new', usage: { input: 10 } },
    ],
})

test('copies the runs since the spawn, their candidates and usage — and nothing older', async () => {
    const to  = fakeDb('axl_dev')
    const out = await mirrorDiscoveryRuns({ from: house(), to, since: '2026-09-19T16:00:00.000Z' })
    assert.deepEqual(out, { runs: 1, candidates: 2, usage: 1 })
    assert.deepEqual(to.writes.aether_event_runs.map(w => w.filter), [{ run_id: 'r_new' }])
    assert.deepEqual(to.writes.aether_event_candidates.map(w => w.filter), [{ run_id: 'r_new', ticker: 'BBB' }, { run_id: 'r_new', ticker: 'CCC' }])
    assert.deepEqual(to.writes.aether_run_usage.map(w => w.filter), [{ run_id: 'r_new' }])
    // Upserts on the engine's own keys, with the source _id stripped — the local copy gets its own.
    assert.ok(to.writes.aether_event_runs.every(w => w.upsert && !('_id' in w.replacement)))
})

test('a run that stored nothing mirrors nothing, and says so rather than failing', async () => {
    const to  = fakeDb('axl_dev')
    const out = await mirrorDiscoveryRuns({ from: house(), to, since: '2026-09-20T00:00:00.000Z' })
    assert.deepEqual(out, { runs: 0, candidates: 0, usage: 0 })
    assert.deepEqual(to.writes, {})
})

test('a source that throws costs the laptop a list, never the run — no throw out', async () => {
    const from = { databaseName: 'test', collection: () => ({ find: () => ({ toArray: async () => { throw new Error('boom') } }) }) }
    const out  = await mirrorDiscoveryRuns({ from, to: fakeDb('axl_dev'), since: '2026-09-19T16:00:00.000Z' })
    assert.deepEqual(out, { runs: 0, candidates: 0, usage: 0 })
})
