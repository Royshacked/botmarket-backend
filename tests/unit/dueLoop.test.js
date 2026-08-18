import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDueLoop } from '../../monitoring/dueLoop.js'

// The wake-up chore every monitor is built on — find what is due, CLAIM it against a lease, check it
// under a timeout. It had no tests of its own while Talos was its only caller. Coverage (Prometheus)
// and tilt (Pythia) now ride it too, over a DIFFERENT collection with a different schedule path and
// no `kind` field at all, so the query it builds is no longer one shape that one monitor would
// notice breaking: a stray `kind` clause selects nothing, silently, forever.

const NOW = Date.parse('2026-08-18T12:00:00.000Z')

/**
 * A Mongo stand-in that records what it was asked. `find` returns the rows it was seeded with (the
 * query is captured, not honoured — these tests assert the QUERY, which is the thing that regresses),
 * and `updateOne` answers whether the claim won.
 */
function fakeDb(rows, { claimWins = true } = {}) {
    const finds = [], updates = []
    let limitArg = null
    const db = {
        collection: (name) => ({
            find: (q) => {
                finds.push({ name, q })
                const cursor = {
                    limit: (n) => { limitArg = n; return cursor },
                    toArray: async () => rows,
                }
                return cursor
            },
            updateOne: async (q, u) => {
                updates.push({ name, q, u })
                return { modifiedCount: claimWins ? 1 : 0 }
            },
        }),
    }
    return { db, finds, updates, get limit() { return limitArg } }
}

const loopOver = (f, spec = {}) => createDueLoop({
    collection: 'entities', check: async () => {}, log: '[test]', name: 'test',
    getDbFn: async () => f.db, ...spec,
})

// ── the due query ────────────────────────────────────────────────────────────

test('kind and statuses are BOTH omitted when not given — not sent as null', () => {
    // The regression that would be invisible: `{kind: null, status: {$in: null}}` matches nothing,
    // every tick, and a monitor that selects nothing logs nothing either.
    const f = fakeDb([])
    const loop = loopOver(f, { statePath: 'monitor', filter: { status: { $ne: 'retired' } } })
    return loop._tick().then(() => {
        const q = f.finds[0].q
        assert.ok(!('kind' in q), 'no kind clause for a collection whose documents have none')
        assert.deepEqual(q.status, { $ne: 'retired' }, "the caller's own negative rule survives")
        assert.deepEqual(q.$or, [
            { 'monitor.next_check_at': null },
            { 'monitor.next_check_at': { $lte: q.$or[1]['monitor.next_check_at'].$lte } },
        ], 'the schedule is read from the path the CALLER keeps it at')
    })
})

test('the entity path is still the default — Talos must not have moved', async () => {
    const f = fakeDb([])
    await loopOver(f, { kind: 'setup', statuses: ['looking'], filter: { broker: { $ne: null } } })._tick()
    const q = f.finds[0].q
    assert.equal(q.kind, 'setup')
    assert.deepEqual(q.status, { $in: ['looking'] })
    assert.deepEqual(q.broker, { $ne: null })
    assert.ok('monitor_state.next_check_at' in q.$or[0], 'entities schedule under monitor_state')
})

test('limit is applied only when asked for', async () => {
    const f1 = fakeDb([])
    await loopOver(f1)._tick()
    assert.equal(f1.limit, null, 'no cap by default — Talos must keep seeing every due setup')

    const f2 = fakeDb([])
    await loopOver(f2, { limit: 50 })._tick()
    assert.equal(f2.limit, 50)
})

// ── the claim ────────────────────────────────────────────────────────────────

test('the claim pushes the schedule a full check-timeout forward, at the caller’s path', async () => {
    const f = fakeDb([{ id: 'a1', status: 'active' }])
    await loopOver(f, { statePath: 'monitor', checkTimeoutMs: 90_000 })._claim({ id: 'a1', status: 'active' }, NOW)
    const { q, u } = f.updates[0]
    assert.equal(q.id, 'a1')
    assert.equal(q.status, 'active', 'a document whose status moved is no longer what we decided to check')
    assert.equal(u.$set['monitor.next_check_at'], new Date(NOW + 90_000).toISOString())
})

test('a document with NO status is not claimed on `undefined`', async () => {
    // The driver sends `{status: undefined}` as `{status: null}`, which matches every document that
    // has no status — so the claim would land on whichever one Mongo reached first.
    const f = fakeDb([])
    await loopOver(f)._claim({ id: 'a1' }, NOW)
    assert.ok(!('status' in f.updates[0].q), 'no status to pin, so no status clause')
})

test('a lost claim skips the check — this is the double-fire guard', async () => {
    const f = fakeDb([{ id: 'a1', status: 'active' }], { claimWins: false })
    const checked = []
    await loopOver(f, { check: async (e) => { checked.push(e.id) } })._tick()
    assert.deepEqual(checked, [], 'someone else is already checking it')
})

// ── afterTick ────────────────────────────────────────────────────────────────

test('afterTick receives every check that returned a value, once, after all of them', async () => {
    const f = fakeDb([{ id: 'a', status: 'x' }, { id: 'b', status: 'x' }])
    const order = []
    const seen  = []
    await loopOver(f, {
        check:     async (e) => { order.push(`check:${e.id}`); return { due: e.id === 'b' } },
        afterTick: async (results) => { order.push('after'); seen.push(...results.map(r => r.entity.id)) },
    })._tick()
    assert.deepEqual(order, ['check:a', 'check:b', 'after'], 'a tick-wide budget is spent after the whole due set')
    assert.deepEqual(seen, ['a', 'b'])
})

test('a check that returns nothing contributes nothing — and no afterTick at all', async () => {
    const f = fakeDb([{ id: 'a', status: 'x' }])
    let called = false
    await loopOver(f, { check: async () => {}, afterTick: async () => { called = true } })._tick()
    assert.equal(called, false, 'Talos returns nothing; it must not pay for a hook it never asked for')
})

test('a throwing check is contained, and the others still run and still reach afterTick', async () => {
    const f = fakeDb([{ id: 'a', status: 'x' }, { id: 'b', status: 'x' }])
    const seen = []
    await loopOver(f, {
        check:     async (e) => { if (e.id === 'a') throw new Error('boom'); return e.id },
        afterTick: async (results) => { seen.push(...results.map(r => r.result)) },
    })._tick()
    assert.deepEqual(seen, ['b'])
})

test('a throwing afterTick never fails the tick — the checks already persisted their own work', async () => {
    const f = fakeDb([{ id: 'a', status: 'x' }])
    await loopOver(f, {
        check:     async () => 'ok',
        afterTick: async () => { throw new Error('remodel blew up') },
    })._tick()   // must resolve
})

test('a DB read error ends the tick quietly rather than wedging the loop', async () => {
    const loop = createDueLoop({
        collection: 'entities', check: async () => { throw new Error('should never run') },
        getDbFn: async () => { throw new Error('mongo down') }, log: '[test]', name: 'test',
    })
    await loop._tick()   // must resolve
})
