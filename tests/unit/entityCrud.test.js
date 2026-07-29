import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeEntityCrud, ownsEntity } from '../../services/entity/entityCrud.service.js'
import { LIVE_POSITION } from '../../services/entity/vocabulary.js'

// entityCrud is the ONE owner-scoped list/read/patch/delete over `entities`, replacing four
// hand-rolled copies (tradeIdeas, kairos, setups). These lock the two things a shared CRUD must
// never get wrong — the owner guard and the kind scope — plus the drift the copies had already
// accumulated (not_found vs forbidden, missing admin paths).

/** A spy collection: records every call's args, returns canned values. */
function spyColl(returns = {}) {
    const calls = []
    const coll = {
        calls,
        async findOne(...a) { calls.push(['findOne', ...a]); return returns.findOne ?? null },
        find(...a) {
            calls.push(['find', ...a])
            return { sort: (s) => { calls.push(['sort', s]); return { toArray: async () => returns.find ?? [] } } }
        },
        async findOneAndUpdate(...a) { calls.push(['findOneAndUpdate', ...a]); return returns.findOneAndUpdate ?? null },
        async deleteOne(...a) { calls.push(['deleteOne', ...a]); return { deletedCount: 1 } },
        async insertOne(...a) { calls.push(['insertOne', ...a]); return { acknowledged: true } },
    }
    return coll
}

const make = (coll, cfg = {}) => makeEntityCrud({ kind: 'setup', log: '[test]', coll: async () => coll, ...cfg })

// ── the owner guard ───────────────────────────────────────────────────────────

test('ownsEntity: own doc yes, someone else no, ownerless legacy yes', () => {
    assert.equal(ownsEntity({ userId: 'u1' }, 'u1'), true)
    assert.equal(ownsEntity({ userId: 'u1' }, 'u2'), false)
    assert.equal(ownsEntity({ userId: null }, 'u2'), true)           // pre-cutover, ownerless
    assert.equal(ownsEntity({}, 'u2'), true)
})

// There is no admin bypass anywhere in the entity layer. Cross-user visibility is pinned off at
// the token, so an admin argument here would be unreachable code that still reads as a live escape
// hatch. These pin its ABSENCE, so re-adding one is a deliberate act with a failing test attached.
test('ownsEntity takes NO admin argument — a stray truthy third arg cannot grant access', () => {
    assert.equal(ownsEntity({ userId: 'u1' }, 'u2', true), false)
    assert.equal(ownsEntity.length, 2)
})

test('getOwned separates missing from not-yours (setups used to report both as not_found)', async () => {
    const missing = make(spyColl({ findOne: null }))
    assert.deepEqual(await missing.getOwned('s1', 'u1'), { ok: false, reason: 'not_found' })

    const theirs = make(spyColl({ findOne: { id: 's1', userId: 'someone_else' } }))
    assert.deepEqual(await theirs.getOwned('s1', 'u1'), { ok: false, reason: 'forbidden' })
})

test('getOwned refuses another user\'s doc even when handed an isAdmin option', async () => {
    const crud = make(spyColl({ findOne: { id: 's1', userId: 'someone_else' } }))
    assert.deepEqual(await crud.getOwned('s1', 'u1', { isAdmin: true }),
        { ok: false, reason: 'forbidden' })
})

test('a projection can NEVER hide the owner field — otherwise every doc reads as ownerless', async () => {
    const coll = spyColl({ findOne: { id: 's1', userId: 'u1' } })
    await make(coll).getOwned('s1', 'u1', { projection: { status: 1 } })
    assert.deepEqual(coll.calls[0], ['findOne',
        { id: 's1', kind: 'setup' },
        { projection: { status: 1, userId: 1 } },   // ← forced in
    ])
})

// ── kind + owner scoping ──────────────────────────────────────────────────────

test('list scopes by kind + owner, newest first, and strips _id', async () => {
    const coll = spyColl({ find: [{ _id: 'oid', id: 's1', savedAt: 2 }] })
    const out = await make(coll).list('u1')
    assert.deepEqual(coll.calls[0], ['find', { kind: 'setup', userId: 'u1' }])
    assert.deepEqual(coll.calls[1], ['sort', { savedAt: -1 }])
    assert.deepEqual(out, [{ id: 's1', savedAt: 2 }])   // _id gone
})

test('list is ALWAYS owner-scoped — no option widens it past the caller', async () => {
    const coll = spyColl()
    await make(coll, { kind: { $ne: 'call' } }).list('u1', { isAdmin: true })
    assert.deepEqual(coll.calls[0], ['find', { kind: { $ne: 'call' }, userId: 'u1' }])
})

test('list: caller filter composes on top of the scope', async () => {
    const coll = spyColl()
    await make(coll).list('u1', { filter: { status: 'looking' } })
    assert.deepEqual(coll.calls[0], ['find', { kind: 'setup', userId: 'u1', status: 'looking' }])
})

// Coverage's wiring: no `kind` discriminator (its collection holds one thing) and recency is
// `updated_at`, because a thesis is as fresh as its last revision.
test('no kind configured → filters carry no kind at all (the coverage case)', async () => {
    const coll = spyColl({ findOne: { id: 'cov1', userId: 'u1' } })
    const crud = makeEntityCrud({ collection: 'coverage', sortBy: { updated_at: -1 }, log: '[test]', coll: async () => coll })

    await crud.list('u1')
    assert.deepEqual(coll.calls[0], ['find', { userId: 'u1' }])
    assert.deepEqual(coll.calls[1], ['sort', { updated_at: -1 }])   // not savedAt

    await crud.getOwned('cov1', 'u1')
    assert.deepEqual(coll.calls[2], ['findOne', { id: 'cov1' }, undefined])
})

test('list degrades to [] when the collection throws — a list surface never 500s', async () => {
    const coll = spyColl()
    coll.find = () => { throw new Error('mongo down') }
    assert.deepEqual(await make(coll).list('u1'), [])
})

// ── delete lock + the before-delete hook ──────────────────────────────────────

test('remove refuses a live position and does NOT run the cleanup hook', async () => {
    const coll = spyColl({ findOne: { id: 's1', userId: 'u1', status: 'long' } })
    let hookRan = false
    const res = await make(coll, { deleteLock: LIVE_POSITION })
        .remove('s1', 'u1', { onBeforeDelete: () => { hookRan = true } })
    assert.deepEqual(res, { ok: false, reason: 'in_position' })
    assert.equal(hookRan, false)
    assert.equal(coll.calls.some(c => c[0] === 'deleteOne'), false)
})

test('remove runs the hook with the doc, then deletes within the kind scope', async () => {
    const coll = spyColl({ findOne: { id: 's1', userId: 'u1', status: 'waiting' } })
    const seen = []
    const res = await make(coll, { deleteLock: LIVE_POSITION })
        .remove('s1', 'u1', { onBeforeDelete: doc => seen.push(doc.id) })
    assert.deepEqual(res, { ok: true })
    assert.deepEqual(seen, ['s1'])
    assert.deepEqual(coll.calls.at(-1), ['deleteOne', { id: 's1', kind: 'setup' }])
})

test('remove on someone else\'s doc is forbidden and never reaches deleteOne', async () => {
    const coll = spyColl({ findOne: { id: 's1', userId: 'other', status: 'waiting' } })
    assert.deepEqual(await make(coll).remove('s1', 'u1'), { ok: false, reason: 'forbidden' })
    assert.equal(coll.calls.some(c => c[0] === 'deleteOne'), false)
})

// The lock is OPT-IN, so an unconfigured crud deletes at any status. No live kind relies on that
// any more — call was the last one, and it now passes LIVE_POSITION like setup and idea — but the
// default has to stay honest for the next kind that registers.
test('no deleteLock configured → a live doc deletes', async () => {
    const coll = spyColl({ findOne: { id: 'x1', userId: 'u1', status: 'long' } })
    const res = await makeEntityCrud({ kind: 'other', log: '[test]', coll: async () => coll })
        .remove('x1', 'u1')
    assert.deepEqual(res, { ok: true })
})

// ── patch ─────────────────────────────────────────────────────────────────────

test('patchOwned guards first, then $sets and returns the stripped updated doc', async () => {
    const coll = spyColl({
        findOne: { id: 's1', userId: 'u1', status: 'waiting' },
        findOneAndUpdate: { _id: 'oid', id: 's1', status: 'looking' },
    })
    const res = await make(coll).patchOwned('s1', 'u1', { status: 'looking' })
    assert.deepEqual(res, { ok: true, doc: { id: 's1', status: 'looking' } })
    assert.deepEqual(coll.calls.at(-1), ['findOneAndUpdate',
        { id: 's1', kind: 'setup' },
        { $set: { status: 'looking' } },
        { returnDocument: 'after' },
    ])
})

test('patchOwned on someone else\'s doc never writes', async () => {
    const coll = spyColl({ findOne: { id: 's1', userId: 'other' } })
    assert.deepEqual(await make(coll).patchOwned('s1', 'u1', { status: 'looking' }),
        { ok: false, reason: 'forbidden' })
    assert.equal(coll.calls.some(c => c[0] === 'findOneAndUpdate'), false)
})
