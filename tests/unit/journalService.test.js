import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendJournal, listJournal, COLLECTION } from '../../services/journal.service.js'
import { makePersist } from '../../monitoring/dueLoop.js'

// The monitor journal is its own collection (docs/design/talos-per-candle.md). These cover the
// two things every caller relies on: an append that never fails the wake that produced it, and
// a newest-first page with a cursor. The db is a fake threaded through the same seam the monitors
// use, so nothing here touches Mongo.

/** A fake db holding one collection as an array, with just enough of the driver's surface. */
function fakeDb({ failInsert = false, hexIds = false } = {}) {
    const rows = []
    const calls = []
    let seq = 0
    const coll = {
        async insertOne(doc) {
            calls.push(['insertOne', doc])
            if (failInsert) throw new Error('boom')
            // hexIds: ids shaped like a real ObjectId's hex (same width, so string order is id order).
            rows.push({ _id: hexIds ? String(++seq).padStart(24, '0') : `oid${String(++seq).padStart(3, '0')}`, ...doc })
        },
        async updateOne(...a) { calls.push(['updateOne', ...a]); return { modifiedCount: 1 } },
        find(filter, opts) {
            calls.push(['find', filter, opts])
            let out = rows.filter(r => r.entityId === filter.entityId)
            if (filter.at?.$lt)  out = out.filter(r => r.at < filter.at.$lt)
            if (filter.at?.$lte) out = out.filter(r => r.at <= filter.at.$lte)
            if (filter.$or) {
                const [older, twin] = filter.$or
                out = out.filter(r => r.at < older.at.$lt || (r.at === twin.at && r._id < String(twin._id.$lt)))
            }
            const chain = {
                sort(s) {
                    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0)
                    out = [...out].sort((a, b) => -cmp(a.at, b.at) || (s._id === -1 ? -cmp(a._id, b._id) : 0))
                    return chain
                },
                limit(n)  { out = out.slice(0, n); return chain },
                async toArray() { return out },
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

    const { _id, ...stored } = db.rows[0]
    assert.deepEqual(stored, { entityId: 's1', at: '2026-09-17T10:00:00.000Z', reason: 'candle', note: 'first' })

    const page = await listJournal('s1', {}, db)
    assert.deepEqual(page.map(r => r.note), ['second', 'first'], 'newest first, scoped to the entity')
    assert.deepEqual(page.map(r => r.id), ['oid002', 'oid001'], 'each row carries its _id as `id`')
    assert.ok(page.every(r => !('_id' in r)), 'the raw _id is not sent')
})

test('listJournal pages with `before` (the oldest `at` the caller has) and clamps the limit', async () => {
    const db = fakeDb()
    for (let i = 0; i < 5; i++) {
        await appendJournal('s1', { at: `2026-09-17T1${i}:00:00.000Z`, reason: 'candle', note: String(i) }, db)
    }
    const first = await listJournal('s1', { limit: 2 }, db)
    assert.deepEqual(first.map(r => r.note), ['4', '3'])

    // The cursor is inclusive: the boundary row comes back (the client drops it by id), then the older ones.
    const next = await listJournal('s1', { limit: 3, before: first[first.length - 1].at }, db)
    assert.deepEqual(next.map(r => r.note), ['3', '2', '1'])

    const big = await listJournal('s1', { limit: 9999 }, db)
    assert.equal(big.length, 5, 'a huge limit is clamped, never rejected')
    assert.equal((await listJournal('s1', { limit: 0 }, db)).length, 5, 'a nonsense limit falls back to the default page')
})

test('two rows on the same millisecond: distinct ids, and neither is lost across a page boundary', async () => {
    // 2026-11-18, ARMK: one wake wrote the arm and the ran-past-the-entry line on the same `at`.
    const db = fakeDb()
    await appendJournal('s1', { at: '2026-11-18T18:00:00.000Z', note: 'older' }, db)
    await appendJournal('s1', { at: '2026-11-18T18:34:00.467Z', note: 'armed' }, db)
    await appendJournal('s1', { at: '2026-11-18T18:34:00.467Z', note: 'ran past' }, db)
    await appendJournal('s1', { at: '2026-11-18T19:00:00.000Z', note: 'newest' }, db)

    const first = await listJournal('s1', { limit: 2 }, db)
    assert.deepEqual(first.map(r => r.note), ['newest', 'ran past'], 'the twins split across the page')
    const next = await listJournal('s1', { limit: 50, before: first[first.length - 1].at }, db)
    const seen = new Set(first.map(r => r.id))
    assert.deepEqual(next.filter(r => !seen.has(r.id)).map(r => r.note), ['armed', 'older'],
        'the twin past the boundary still arrives')
})

test('the (at, id) cursor: a whole page on one millisecond pages on, never repeating or skipping a row', async () => {
    // Code review 2026-11-19: with `at` alone and inclusive, a page's worth of rows on one millisecond came back forever.
    const db = fakeDb({ hexIds: true })
    for (let i = 0; i < 5; i++) await appendJournal('s1', { at: '2026-11-18T18:34:00.467Z', note: `twin${i}` }, db)
    await appendJournal('s1', { at: '2026-11-18T18:00:00.000Z', note: 'older' }, db)
    const got = []
    let page = await listJournal('s1', { limit: 2 }, db)
    while (page.length) {
        got.push(...page)
        const last = page[page.length - 1]
        page = await listJournal('s1', { limit: 2, before: last.at, beforeId: last.id }, db)
    }
    assert.deepEqual(got.map(r => r.note), ['twin4', 'twin3', 'twin2', 'twin1', 'twin0', 'older'])
    const q = db.calls.filter(c => c[0] === 'find')[1][1]
    assert.ok(q.$or && !q.at, 'the pair is the cursor')
    // A beforeId that is not an id falls back to the inclusive `at` cursor, never to an injected query.
    await listJournal('s1', { before: '2026-11-18T18:34:00.467Z', beforeId: { $gt: '' } }, db)
    assert.deepEqual(db.calls.at(-1)[1].at, { $lte: '2026-11-18T18:34:00.467Z' })
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

test('makePersist ifStatus: a document that moved on is left alone, and nothing is journalled', async () => {
    const calls = []
    const db = { collection: (name) => ({ updateOne: async (...a) => { calls.push(['updateOne', name, ...a]); return { matchedCount: 0 } }, insertOne: async () => { calls.push(['insertOne']) } }) }
    const persist = makePersist({ collection: 'entities', kind: 'setup', log: '[t]' })
    assert.deepEqual(await persist('s1', { status: 'hit' }, { at: 't' }, db, { ifStatus: 'looking' }), { matched: false })
    assert.deepEqual(calls, [['updateOne', 'entities', { id: 's1', kind: 'setup', status: 'looking' }, { $set: { status: 'hit' } }]])
})
