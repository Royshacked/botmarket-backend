import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendJournal, listJournal, COLLECTION } from '../../services/journal.service.js'
import { makePersist } from '../../monitoring/dueLoop.js'

// The monitor journal is its own collection (docs/design/talos-per-candle.md). These cover the
// two things every caller relies on: an append that never fails the wake that produced it, and
// a newest-first page with a cursor. The db is a fake threaded through the same seam the monitors
// use, so nothing here touches Mongo.

/** A fake db holding one collection as an array, with just enough of the driver's surface. */
function fakeDb({ failInsert = false } = {}) {
    const rows = []
    const calls = []
    const coll = {
        async insertOne(doc) {
            calls.push(['insertOne', doc])
            if (failInsert) throw new Error('boom')
            rows.push(doc)
        },
        async updateOne(...a) { calls.push(['updateOne', ...a]); return { modifiedCount: 1 } },
        find(filter, opts) {
            calls.push(['find', filter, opts])
            let out = rows.filter(r => r.entityId === filter.entityId)
            if (filter.at?.$lt) out = out.filter(r => r.at < filter.at.$lt)
            const chain = {
                sort(s)   { out = [...out].sort((a, b) => (a.at < b.at ? 1 : -1) * (s.at === -1 ? 1 : -1)); return chain },
                limit(n)  { out = out.slice(0, n); return chain },
                async toArray() { return out.map(({ _id, ...r }) => r) },
            }
            return chain
        },
    }
    return { rows, calls, collection: (name) => { assert.equal(name, COLLECTION); return coll } }
}

test('appendJournal writes { entityId, ...entry } and lists newest first', async () => {
    const db = fakeDb()
    await appendJournal('s1', { at: '2026-09-17T10:00:00.000Z', reason: 'candle', note: 'first' }, db)
    await appendJournal('s1', { at: '2026-09-17T11:00:00.000Z', reason: 'guard',  note: 'second' }, db)
    await appendJournal('s2', { at: '2026-09-17T12:00:00.000Z', reason: 'candle', note: 'other setup' }, db)

    assert.deepEqual(db.rows[0], { entityId: 's1', at: '2026-09-17T10:00:00.000Z', reason: 'candle', note: 'first' })

    const page = await listJournal('s1', {}, db)
    assert.deepEqual(page.map(r => r.note), ['second', 'first'], 'newest first, scoped to the entity')
})

test('listJournal pages with `before` (the oldest `at` the caller has) and clamps the limit', async () => {
    const db = fakeDb()
    for (let i = 0; i < 5; i++) {
        await appendJournal('s1', { at: `2026-09-17T1${i}:00:00.000Z`, reason: 'candle', note: String(i) }, db)
    }
    const first = await listJournal('s1', { limit: 2 }, db)
    assert.deepEqual(first.map(r => r.note), ['4', '3'])

    const next = await listJournal('s1', { limit: 2, before: first[first.length - 1].at }, db)
    assert.deepEqual(next.map(r => r.note), ['2', '1'])

    const big = await listJournal('s1', { limit: 9999 }, db)
    assert.equal(big.length, 5, 'a huge limit is clamped, never rejected')
    assert.equal((await listJournal('s1', { limit: 0 }, db)).length, 5, 'a nonsense limit falls back to the default page')
})

test('appendJournal never throws — a lost line must not fail the wake', async () => {
    const db = fakeDb({ failInsert: true })
    await assert.doesNotReject(() => appendJournal('s1', { at: 'x', reason: 'candle' }, db))
    await appendJournal(null, { at: 'x' }, db)
    await appendJournal('s1', null, db)
    assert.equal(db.calls.filter(c => c[0] === 'insertOne').length, 1, 'no entity or no entry → no write attempted')
})

test('listJournal without an entity is empty, not a full-collection scan', async () => {
    const db = fakeDb()
    assert.deepEqual(await listJournal(null, {}, db), [])
    assert.equal(db.calls.length, 0)
})

test('makePersist: $set on the entity, then the journal row — and no row when the wake has none', async () => {
    const db = fakeDb()
    const persist = makePersist({ collection: 'entities', kind: 'setup', log: '[t]' })
    // The entity collection and the journal collection share the fake here; the assertion is on
    // the sequence of calls, which is what the seam guarantees.
    db.collection = (name) => ({ ...fakeDb().collection(COLLECTION), async updateOne(...a) { db.calls.push(['updateOne', name, ...a]); return { modifiedCount: 1 } }, async insertOne(doc) { db.calls.push(['insertOne', name, doc]) } })

    await persist('s1', { 'monitor_state.memo': 'm' }, { at: 't', reason: 'candle' }, db)
    assert.deepEqual(db.calls[0], ['updateOne', 'entities', { id: 's1', kind: 'setup' }, { $set: { 'monitor_state.memo': 'm' } }])
    assert.deepEqual(db.calls[1], ['insertOne', COLLECTION, { entityId: 's1', at: 't', reason: 'candle' }])

    db.calls.length = 0
    await persist('s1', { 'monitor_state.memo': 'm' }, null, db)
    assert.equal(db.calls.length, 1, 'a quiet write is one write')
})
