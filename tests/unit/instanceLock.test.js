import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createInstanceLock, LOOPS_LOCK_KEY } from '../../services/instanceLock.service.js'

// Leader election for the background loops. What these pin is not "does it take a lease" but the
// three ways a lease goes WRONG, because each of them puts two reconcilers on the same broker:
// a follower that starts loops anyway, a leader that keeps running after losing the lease, and a
// process that releases a lease it no longer owns.

/**
 * A Mongo-shaped collection holding ONE document, enforcing the `_id` uniqueness the real upsert
 * relies on. The duplicate-key error is the mechanism under test, not an edge case — so it is
 * modelled rather than stubbed away.
 */
function fakeCollection() {
    let doc = null
    return {
        get doc() { return doc },
        set doc(d) { doc = d },
        async updateOne(filter, update, opts) {
            const matches = doc && doc._id === filter._id && filter.$or.some(c =>
                (c.holder !== undefined && doc.holder === c.holder) ||
                (c.expiresAt !== undefined && doc.expiresAt <= c.expiresAt.$lte))
            if (matches) { doc = { ...doc, ...update.$set }; return { matchedCount: 1 } }
            if (!doc && opts?.upsert) { doc = { _id: filter._id, ...update.$set }; return { upsertedCount: 1 } }
            const err = new Error('E11000 duplicate key error'); err.code = 11000; throw err
        },
        async deleteOne(filter) {
            if (doc && doc._id === filter._id && doc.holder === filter.holder) { doc = null; return { deletedCount: 1 } }
            return { deletedCount: 0 }
        },
    }
}

const lockFor = (col, id, over = {}) => createInstanceLock({
    getCollection: async () => col, instanceId: id, ttlMs: 30_000, renewMs: 10_000, ...over,
})

test('the first instance takes the lease and is the leader', async () => {
    const col = fakeCollection()
    const a = lockFor(col, 'A')
    assert.equal(await a._tryAcquire(), true)
    assert.equal(col.doc._id, LOOPS_LOCK_KEY)
    assert.equal(col.doc.holder, 'A')
})

test('the SECOND instance is refused — this is the whole point', async () => {
    const col = fakeCollection()
    assert.equal(await lockFor(col, 'A')._tryAcquire(), true)
    assert.equal(await lockFor(col, 'B')._tryAcquire(), false,
        'a second process must not run a second copy of every loop')
    assert.equal(col.doc.holder, 'A', 'and must not have stolen the lease on the way past')
})

test('the holder can renew its own lease indefinitely', async () => {
    const col = fakeCollection()
    let t = 1_000
    const a = lockFor(col, 'A', { now: () => t })
    await a._tryAcquire()
    t += 5_000
    assert.equal(await a._tryAcquire(), true)
    assert.equal(col.doc.expiresAt, new Date(t + 30_000).toISOString())
})

test('an EXPIRED lease is takeable — a dead leader does not stop the fleet forever', async () => {
    const col = fakeCollection()
    let t = 1_000
    await lockFor(col, 'A', { now: () => t })._tryAcquire()

    t += 29_000
    assert.equal(await lockFor(col, 'B', { now: () => t })._tryAcquire(), false, 'still live')

    t += 2_000                                     // now past A's 30s horizon
    assert.equal(await lockFor(col, 'B', { now: () => t })._tryAcquire(), true)
    assert.equal(col.doc.holder, 'B')
})

test('an unreachable database means FOLLOWER, never leader', async () => {
    // "Cannot prove we are alone" and "we are alone" are different answers, and only one of them is
    // safe to act on: guessing leader here is how two reconcilers end up on one account.
    const lock = createInstanceLock({
        getCollection: async () => { throw new Error('no mongo') },
        instanceId: 'A', ttlMs: 30_000, renewMs: 10_000,
    })
    assert.equal(await lock._tryAcquire(), false)
    assert.equal(lock.isLeader(), false)
})

test('losing the lease calls onLost, so the loops stand down', async () => {
    // The transition that prevents two leaders. A renewal can fail for reasons that are nobody's
    // fault — a blip, a GC pause — and by then another process may legitimately hold the lease.
    const col = fakeCollection()
    let lost = 0, acquired = 0
    const a = lockFor(col, 'A', { onAcquired: () => { acquired++ }, onLost: () => { lost++ } })

    await a.start()
    assert.equal(a.isLeader(), true)
    assert.equal(acquired, 1)

    // B legitimately takes over — A blipped and its lease lapsed.
    col.doc = { _id: LOOPS_LOCK_KEY, holder: 'B', expiresAt: new Date(Date.now() + 60_000).toISOString() }

    await a._tick()   // exactly what the renewal interval runs

    assert.equal(a.isLeader(), false, 'A must not keep believing it is the leader')
    assert.equal(lost, 1, 'and must be TOLD, so its loops stop — otherwise two reconcilers')
    assert.equal(acquired, 1, 'no spurious re-acquire')

    await a.stop()
    assert.equal(col.doc.holder, 'B', 'standing down did not disturb the real leader')
})

test('callbacks fire ONCE per transition, not once per tick', async () => {
    const col = fakeCollection()
    let acquired = 0
    const a = lockFor(col, 'A', { onAcquired: () => { acquired++ } })
    await a.start()
    await a._tryAcquire()
    await a._tryAcquire()
    assert.equal(acquired, 1, 'a renewed lease is not a new leadership')
    await a.stop()
})

test('release is guarded on the holder — a former leader cannot delete the new one’s lease', async () => {
    const col = fakeCollection()
    const a = lockFor(col, 'A')
    await a.start()

    // B takes over after A's lease lapses; A then shuts down and must not clear B's claim.
    col.doc = { _id: LOOPS_LOCK_KEY, holder: 'B', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    await a.stop()

    assert.equal(col.doc?.holder, 'B', 'B still holds it')
})

test('stop() on a follower is a no-op, and safe to call blind', async () => {
    const col = fakeCollection()
    await lockFor(col, 'A').start()
    const b = lockFor(col, 'B')
    await b.start()
    assert.equal(b.isLeader(), false)
    await b.stop()
    assert.equal(col.doc.holder, 'A')
})

test('a renew interval that is not comfortably inside the TTL is refused at construction', () => {
    // A lease renewed as often as it expires is a lease that expires — one slow round trip and
    // leadership changes hands for no reason. Cheaper to catch here than at 3am.
    assert.throws(() => createInstanceLock({ getCollection: async () => ({}), instanceId: 'A', ttlMs: 10_000, renewMs: 9_000 }),
        /must be < half/)
    assert.doesNotThrow(() => createInstanceLock({ getCollection: async () => ({}), instanceId: 'A', ttlMs: 30_000, renewMs: 10_000 }))
})
