import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'

// The session store (services/session.service.js) on the in-memory Mongo. memDb does not enforce
// unique indexes, so "one active per user per scope" is asserted on the service's own logic here; the
// partial-unique index is the production backstop under a race.

function fresh() {
    const { db, rows } = memDb()
    return { svc: makeSessionService({ getDb: async () => db }), rows }
}
const say = (agent, role, content) => ({ agent, role, content })

test('getActive creates the running session on first ask, and returns the SAME one after', async () => {
    const { svc, rows } = fresh()
    const a = await svc.getActive({ userId: 'u1' })
    const b = await svc.getActive({ userId: 'u1' })
    assert.equal(a.sessionId, b.sessionId)
    assert.equal(a.scope, 'main')
    assert.equal(a.status, 'active')
    assert.equal(a.floor, 'axl')
    assert.equal(rows('sessions').length, 1)
})

test('one active per user PER SCOPE — the admin desks keep their own; another user gets their own', async () => {
    const { svc } = fresh()
    const main  = await svc.getActive({ userId: 'u1', scope: 'main' })
    const pyth  = await svc.getActive({ userId: 'u1', scope: 'strategy' })
    const other = await svc.getActive({ userId: 'u2', scope: 'main' })
    assert.notEqual(main.sessionId, pyth.sessionId)
    assert.notEqual(main.sessionId, other.sessionId)
    assert.equal(await svc.getActive({ userId: 'u1', scope: 'nope' }), null)
})

test('append claims increasing seqs and stores the normalized message', async () => {
    const { svc } = fresh()
    const s = await svc.getActive({ userId: 'u1' })
    const one = await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('axl', 'user', 'hi') })
    const two = await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('axl', 'assistant', 'hello') })
    assert.equal(one.message.seq, 1)
    assert.equal(two.message.seq, 2)
    assert.equal(two.message.kind, 'msg')
})

test('append refuses a bad message, another user’s session, and an archived one', async () => {
    const { svc } = fresh()
    const s = await svc.getActive({ userId: 'u1' })
    assert.equal((await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('kairos', 'user', 'x') })).reason, 'invalid_message')
    assert.equal((await svc.append({ sessionId: s.sessionId, userId: 'u2', message: say('axl', 'user', 'x') })).reason, 'not_found')
    await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('axl', 'user', 'first') })
    await svc.startNew({ userId: 'u1' })
    assert.equal((await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('axl', 'user', 'late') })).reason, 'not_found')
})

test('messagesSince replays in order after a seq, and answers null for a session that is not yours', async () => {
    const { svc } = fresh()
    const s = await svc.getActive({ userId: 'u1' })
    for (const t of ['a', 'b', 'c', 'd']) await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('axl', 'user', t) })
    assert.deepEqual((await svc.messagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 2 })).map(m => m.content), ['c', 'd'])
    assert.deepEqual((await svc.messagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0, limit: 2 })).map(m => m.seq), [1, 2])
    assert.equal(await svc.messagesSince({ sessionId: s.sessionId, userId: 'u2' }), null)
})

test('startNew archives the running session, titled from its first user message, and opens a fresh one', async () => {
    const { svc } = fresh()
    const s = await svc.getActive({ userId: 'u1' })
    await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('axl', 'assistant', 'What do you want to do?') })
    await svc.append({ sessionId: s.sessionId, userId: 'u1', message: say('axl', 'user', 'trade NVDA') })
    const next = await svc.startNew({ userId: 'u1' })
    assert.notEqual(next.sessionId, s.sessionId)
    const history = await svc.list({ userId: 'u1' })
    const old = history.find(h => h.sessionId === s.sessionId)
    assert.equal(old.status, 'archived')
    assert.equal(old.title, 'trade NVDA')
    assert.ok(old.archivedAt > 0)
})

test('startNew on an EMPTY session reuses it — pressing New twice never fills history with blank rows', async () => {
    const { svc } = fresh()
    const s = await svc.getActive({ userId: 'u1' })
    const again = await svc.startNew({ userId: 'u1' })
    assert.equal(again.sessionId, s.sessionId)
    assert.equal((await svc.list({ userId: 'u1' })).length, 1)
})

test('list is the user’s own sessions in the scope, without the desks’ working state', async () => {
    const { svc } = fresh()
    const s = await svc.getActive({ userId: 'u1' })
    await svc.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })
    await svc.getActive({ userId: 'u2' })
    await svc.getActive({ userId: 'u1', scope: 'strategy' })
    const mine = await svc.list({ userId: 'u1' })
    assert.equal(mine.length, 1)
    // memDb ignores projections, so this pins the service's REQUEST, which is what Mongo honours.
    // The full header (with agentState) is get()'s, the desks' read:
    assert.deepEqual((await svc.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.mentor, { draft: { asset: 'NVDA' } })
})

test('setAgentState is per agent and owner-scoped; addLink records many entities', async () => {
    const { svc } = fresh()
    const s = await svc.getActive({ userId: 'u1' })
    assert.equal((await svc.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'nope', state: {} })).reason, 'invalid_agent')
    assert.equal((await svc.setAgentState({ sessionId: s.sessionId, userId: 'u2', agent: 'mentor', state: {} })).reason, 'not_found')
    await svc.addLink({ sessionId: s.sessionId, userId: 'u1', link: { kind: 'scan', id: 'sc1', agent: 'scanner' } })
    await svc.addLink({ sessionId: s.sessionId, userId: 'u1', link: { kind: 'setup', id: 'st1', agent: 'mentor' } })
    assert.equal((await svc.addLink({ sessionId: s.sessionId, userId: 'u1', link: { kind: 'setup' } })).reason, 'invalid_link')
    const got = await svc.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(got.links.map(l => l.id), ['sc1', 'st1'])
    assert.equal(await svc.get({ sessionId: s.sessionId, userId: 'u2' }), null)
})
