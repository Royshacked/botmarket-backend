import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeMongoBackedCache } from '../../services/mongoCache.util.js'

// The two-layer cache fmp.provider (fundamentals) and finnhub.provider (profiles) each wrote by hand,
// once. Memory first, Mongo second, both best-effort — and the document shape spreads the value so
// the two collections that already exist keep reading without a migration.

function fakeDb({ docs = {}, failRead = false, failWrite = false } = {}) {
    const writes = []
    const db = {
        collection: () => ({
            findOne: async (q) => { if (failRead) throw new Error('mongo down'); return docs[q.symbol] ?? null },
            updateOne: async (q, u, o) => { if (failWrite) throw new Error('mongo down'); writes.push({ q, u, o }); return { matchedCount: 1 } },
        }),
    }
    return { writes, getDb: async () => db }
}

test('a miss in both layers is null; a write lands in memory AND Mongo in the flat shape', async () => {
    const f = fakeDb()
    const c = makeMongoBackedCache({ collection: 'x', ttlMs: 60_000, getDb: f.getDb })
    assert.equal(await c.read('NVDA'), null)
    await c.write('NVDA', { name: 'Nvidia', logo: 'l' })
    assert.deepEqual(await c.read('NVDA'), { name: 'Nvidia', logo: 'l' }, 'the memory layer answers')
    assert.deepEqual(f.writes[0].q, { symbol: 'NVDA' })
    assert.equal(f.writes[0].u.$set.symbol, 'NVDA')
    assert.equal(f.writes[0].u.$set.name, 'Nvidia')
    assert.ok(Number.isFinite(f.writes[0].u.$set.fetchedAt))
    assert.deepEqual(f.writes[0].o, { upsert: true })
})

test('a young Mongo document is served (and promoted to memory) without its bookkeeping fields', async () => {
    const f = fakeDb({ docs: { AAPL: { _id: 'oid', symbol: 'AAPL', text: 'fundamentals…', asOf: '2026-09-16', fetchedAt: Date.now() - 1000 } } })
    const c = makeMongoBackedCache({ collection: 'x', ttlMs: 60_000, getDb: f.getDb })
    assert.deepEqual(await c.read('AAPL'), { text: 'fundamentals…', asOf: '2026-09-16' }, 'the value is exactly what was written — no _id, no key, no fetchedAt')
})

test('a Mongo document past the TTL is a miss', async () => {
    const f = fakeDb({ docs: { OLD: { symbol: 'OLD', text: 't', fetchedAt: Date.now() - 120_000 } } })
    const c = makeMongoBackedCache({ collection: 'x', ttlMs: 60_000, getDb: f.getDb })
    assert.equal(await c.read('OLD'), null)
})

test('Mongo failing is a miss on read and a kept answer on write — never a throw', async () => {
    const down = makeMongoBackedCache({ collection: 'x', ttlMs: 60_000, getDb: fakeDb({ failRead: true, failWrite: true }).getDb })
    assert.equal(await down.read('X'), null)
    await down.write('X', { v: 1 })                       // does not throw
    assert.deepEqual(await down.read('X'), { v: 1 }, 'the memory layer still has it')
})

test('a key field other than symbol, and the required config', () => {
    assert.throws(() => makeMongoBackedCache({ ttlMs: 1 }), /collection is required/)
    assert.throws(() => makeMongoBackedCache({ collection: 'x' }), /ttlMs is required/)
    assert.ok(makeMongoBackedCache({ collection: 'x', ttlMs: 1, keyField: 'ref' }))
})
