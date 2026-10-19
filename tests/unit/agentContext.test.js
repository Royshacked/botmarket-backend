import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeAgentContextService } from '../../services/agentContext.service.js'
import { MAX_SEALED_MESSAGES } from '../../services/session.util.js'

// Sealed agent context (services/agentContext.service.js): an agent's conversation kept with the entity
// it produced, per user — the same for an owned entity and a house one.

function fresh() {
    const { db, rows } = memDb()
    return { svc: makeAgentContextService({ getDb: async () => db }), rows }
}
const key = { userId: 'u1', kind: 'setup', entityId: 'st1', agent: 'mentor' }
const turns = (...c) => c.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }))

test('seal → load round trip', async () => {
    const { svc } = fresh()
    await svc.seal({ ...key, messages: turns('long AMD', 'two legs, stop 142'), summary: 'keep size under 2%', artifacts: [{ kind: 'setup', id: 'st1' }] })
    const got = await svc.load(key)
    assert.deepEqual(got.messages.map(m => m.content), ['long AMD', 'two legs, stop 142'])
    assert.equal(got.summary, 'keep size under 2%')
    assert.deepEqual(got.artifacts, [{ kind: 'setup', id: 'st1' }])
    assert.ok(got.sealedAt > 0)
})

test('a second seal APPENDS — an edit adds to the history it reopened, and keeps the first seal time', async () => {
    const { svc } = fresh()
    await svc.seal({ ...key, messages: turns('build') })
    const first = (await svc.load(key)).sealedAt
    await svc.seal({ ...key, messages: turns('move the stop'), summary: 'newer summary' })
    const got = await svc.load(key)
    assert.deepEqual(got.messages.map(m => m.content), ['build', 'move the stop'])
    assert.equal(got.summary, 'newer summary')
    assert.equal(got.sealedAt, first)
})

test('a seal without a summary keeps the one already there', async () => {
    const { svc } = fresh()
    await svc.seal({ ...key, messages: turns('a'), summary: 'kept' })
    await svc.seal({ ...key, messages: turns('b') })
    assert.equal((await svc.load(key)).summary, 'kept')
})

test('the newest messages are kept once a context outgrows the cap', async () => {
    const { svc } = fresh()
    const many = Array.from({ length: MAX_SEALED_MESSAGES + 10 }, (_, i) => ({ role: 'user', content: `m${i}` }))
    await svc.seal({ ...key, messages: many })
    const got = await svc.load(key)
    assert.equal(got.messages.length, MAX_SEALED_MESSAGES)
    assert.equal(got.messages[0].content, 'm10')
})

test('each user’s context is theirs — even on a HOUSE entity both can see', async () => {
    const { svc } = fresh()
    const cov = { kind: 'coverage', entityId: 'cov_NVDA', agent: 'analyst' }
    await svc.seal({ ...cov, userId: 'admin1', messages: turns('revise NVDA') })
    assert.equal(await svc.load({ ...cov, userId: 'admin2' }), null)
    assert.deepEqual((await svc.load({ ...cov, userId: 'admin1' })).messages.map(m => m.content), ['revise NVDA'])
})

test('a bad kind, agent or missing key is refused, and load answers null for it', async () => {
    const { svc } = fresh()
    assert.equal((await svc.seal({ ...key, kind: 'call', messages: turns('x') })).reason, 'invalid_context')
    assert.equal((await svc.seal({ ...key, agent: 'kairos', messages: turns('x') })).reason, 'invalid_context')
    assert.equal((await svc.seal({ ...key, entityId: null, messages: turns('x') })).reason, 'invalid_context')
    assert.equal(await svc.load({ ...key, kind: 'call' }), null)
})

test('removeFor deletes every user’s context for the entity, and only that entity', async () => {
    const { svc, rows } = fresh()
    await svc.seal({ ...key, messages: turns('a') })
    await svc.seal({ ...key, userId: 'u2', messages: turns('b') })
    await svc.seal({ ...key, entityId: 'st2', messages: turns('c') })
    assert.equal((await svc.removeFor({ kind: 'setup', entityId: 'st1' })).deleted, 2)
    assert.deepEqual(rows('agent_contexts').map(r => r.entityId), ['st2'])
    assert.equal((await svc.removeFor({ kind: 'nope', entityId: 'st2' })).deleted, 0)
})
