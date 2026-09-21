import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getHouseModels, setHouseModels, _resetHouseModelsCache, COLLECTION, DOC_ID } from '../../services/houseModels.service.js'
import { costlierThanCheap } from '../../services/agentUtils.js'
import { CHEAP_MODEL } from '../../services/llmModels.js'
import { isAdminUserCached, _resetAdminCache } from '../../api/user/user.model.js'

// The house models (2026-09-21): one document the admin writes, every non-admin turn and read
// runs on. Driven against a fake collection — the read cache and the write validation are the
// behaviour; Mongo is the pipe.

function fakeDb(doc = null) {
    const calls = { finds: 0, updates: [] }
    const col = {
        findOne: async (q) => { calls.finds++; return q._id === DOC_ID ? doc : null },
        updateOne: async (q, u, o) => { calls.updates.push([q, u, o]); doc = { ...(doc ?? { _id: DOC_ID }), ...u.$set }; return { acknowledged: true } },
    }
    const db = { collection: (name) => { assert.equal(name, COLLECTION); return col } }
    return { getDb: async () => db, calls, current: () => doc }
}

const ALLOWED = { chat: id => ['gpt-5.6-luna', 'claude-sonnet-5'].includes(id), talos: id => ['gpt-5.6-luna', 'claude-sonnet-4-6'].includes(id) }

test('read: no document → both ids null; the document is read once a minute, not once a turn', async () => {
    _resetHouseModelsCache()
    const f = fakeDb(null)
    assert.deepEqual(await getHouseModels(f.getDb), { chatModel: null, talosModel: null, updatedAt: null, updatedBy: null })
    await getHouseModels(f.getDb); await getHouseModels(f.getDb)
    assert.equal(f.calls.finds, 1, 'cached')
    _resetHouseModelsCache()
    await getHouseModels(f.getDb)
    assert.equal(f.calls.finds, 2)
})

test('read: a non-string stored id reads as unset — the consumers resolve through their own registries', async () => {
    _resetHouseModelsCache()
    const f = fakeDb({ _id: DOC_ID, chatModel: 42, talosModel: 'gpt-5.6-luna' })
    const h = await getHouseModels(f.getDb)
    assert.equal(h.chatModel, null); assert.equal(h.talosModel, 'gpt-5.6-luna')
})

test('write: validates each id with the predicate passed, upserts, stamps who and when, and refreshes the cache', async () => {
    _resetHouseModelsCache()
    const f = fakeDb(null)
    await getHouseModels(f.getDb)                                   // prime the cache with "nothing"
    const out = await setHouseModels({ chatModel: 'gpt-5.6-luna' }, 'roy', { allowed: ALLOWED, getDb: f.getDb })
    assert.equal(out.chatModel, 'gpt-5.6-luna'); assert.equal(out.talosModel, null)
    assert.equal(out.updatedBy, 'roy'); assert.ok(out.updatedAt instanceof Date)
    const [q, u, o] = f.calls.updates[0]
    assert.deepEqual(q, { _id: DOC_ID }); assert.equal(o.upsert, true)
    assert.equal(u.$set.talosModel, undefined, 'an id not in the body is left as it was')
    assert.equal((await getHouseModels(f.getDb)).chatModel, 'gpt-5.6-luna', 'the next read sees the save at once')

    // The second id, alone, leaves the first in place.
    await setHouseModels({ talosModel: 'claude-sonnet-4-6' }, 'roy', { allowed: ALLOWED, getDb: f.getDb })
    assert.deepEqual([f.current().chatModel, f.current().talosModel], ['gpt-5.6-luna', 'claude-sonnet-4-6'])
})

test('write: an unregistered id, a non-string, or an empty body is a 400 and writes nothing', async () => {
    _resetHouseModelsCache()
    const f = fakeDb(null)
    for (const body of [{ chatModel: 'gpt-4o' }, { chatModel: 7 }, { talosModel: 'claude-sonnet-5' }, { talosModel: null }, {}, undefined]) {
        await assert.rejects(setHouseModels(body, 'roy', { allowed: ALLOWED, getDb: f.getDb }), err => err.status === 400, JSON.stringify(body))
    }
    // No predicates at all → nothing passes, rather than everything.
    await assert.rejects(setHouseModels({ chatModel: 'gpt-5.6-luna' }, 'roy', { getDb: f.getDb }), err => err.status === 400)
    assert.equal(f.calls.updates.length, 0)
})

test('the ceiling degrades only onto something cheaper than what would have run', () => {
    assert.equal(costlierThanCheap('claude-opus-5'), true)
    assert.equal(costlierThanCheap('claude-sonnet-5'), true)
    assert.equal(costlierThanCheap(CHEAP_MODEL), false)
    assert.equal(costlierThanCheap('gpt-5.6-luna'), false, 'Luna is a fifth of Haiku — "degrading" onto Haiku would cost more')
    assert.equal(costlierThanCheap('qwen3.7-flash'), false)
    assert.equal(costlierThanCheap('gemini-3.8-flash'), false)
    assert.equal(costlierThanCheap('no-such-model'), true, 'an unknown id prices as the default, which is dearer')
})

test('isAdminUserCached: one lookup per id per window; a failed lookup is not remembered; no id is never an admin', async () => {
    _resetAdminCache()
    let n = 0
    const lookup = async (id) => { n++; if (id === 'boom') throw new Error('db'); return id === 'roy' }
    assert.equal(await isAdminUserCached('roy', lookup), true)
    assert.equal(await isAdminUserCached('roy', lookup), true)
    assert.equal(await isAdminUserCached('marce', lookup), false)
    assert.equal(n, 2)
    await assert.rejects(isAdminUserCached('boom', lookup))
    await assert.rejects(isAdminUserCached('boom', lookup))
    assert.equal(n, 4, 'the throw was not cached')
    assert.equal(await isAdminUserCached(null, lookup), false)
    assert.equal(n, 4)
})
