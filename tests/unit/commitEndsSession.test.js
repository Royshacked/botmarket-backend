import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeActRig, TRADER } from '../helpers/actRig.js'

// A COMMIT ENDS THE SESSION (Roy, 2026-10-18): saving the work archives the session and opens a fresh one with Axl,
// its first line saying what was saved. Not mid-chain — a save by a desk a chain went THROUGH keeps the session; the
// chain ends it when the desk that started it commits. (act.endAfterCommit)

const user = TRADER

// One desk, one action that saves (`generate`, with a seal), one that does not (`later`), one that is refused.
const desk = (agent = 'mentor') => ({
    hasWork: (s) => !!s?.draft,
    actions: {
        generate: async () => ({ result: { saved: true }, seal: { kind: 'setup', entityIds: ['s1'], name: 'NVDA setup' }, after: null }),
        later:    async () => ({ result: {}, after: null }),
        refuse:   async () => ({ reason: 'save_failed' }),
    },
    agent,
})

const rigFor = (agent = 'mentor', state = { draft: { asset: 'NVDA' } }) => makeActRig({ agent, desk: desk(agent), state })

test('a save archives the session and opens a fresh one — Axl, a line saying what was saved', async () => {
    const r = rigFor()
    const { s, press } = await r.start(user)
    const out = await press('generate')
    assert.ok(out.result.nextSessionId && out.result.nextSessionId !== s.sessionId)
    assert.equal((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).status, 'archived')
    const next = await r.sessions.getActive({ userId: 'u1' })
    assert.equal(next.sessionId, out.result.nextSessionId)
    assert.equal(next.floor ?? 'axl', 'axl', 'the new session is Axl\'s')
    const [line] = await r.sessions.messagesSince({ sessionId: next.sessionId, userId: 'u1' })
    assert.equal(line.agent, 'axl')
    assert.equal(line.kind, 'sealed')
    assert.equal(line.content, '✓ Mentor built NVDA setup — saved to your Setups. You\'re back with Axl.')
    assert.deepEqual(line.ref, { kind: 'setup', ids: ['s1'], ended: true, from: s.sessionId })
})

test('a session with no message in it (the work was all hand edits) is still archived — never reused', async () => {
    const r = rigFor()
    const { s, press } = await r.start(user)
    assert.equal((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).seq ?? 0, 0)
    const out = await press('generate')
    assert.notEqual(out.result.nextSessionId, s.sessionId)
})

test('a press that saves nothing (Later), or a refused save, leaves the session where it is', async () => {
    const r = rigFor()
    const { s, press } = await r.start(user)
    assert.equal((await press('refuse')).reason, 'save_failed')
    const later = await press('later')
    assert.equal(later.result.nextSessionId, undefined)
    assert.equal((await r.sessions.getActive({ userId: 'u1' })).sessionId, s.sessionId)
})

test('mid-chain: a save by a desk the chain went THROUGH keeps the session; the chain\'s own desk ends it', async () => {
    const r = rigFor('mentor')
    const { s, press } = await r.start(user)
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'running', origin: 'portfolio' } })
    assert.equal((await press('generate')).result.nextSessionId, undefined, 'Atlas started it — Mentor\'s save is a step')
    assert.equal((await r.sessions.getActive({ userId: 'u1' })).sessionId, s.sessionId)

    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'running', origin: 'mentor' } })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })
    assert.ok((await press('generate')).result.nextSessionId, 'the chain\'s own desk committing ends it')
})

test('a chain that is DONE does not hold the session open', async () => {
    const r = rigFor('mentor')
    const { s, press } = await r.start(user)
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'done', origin: 'portfolio' } })
    assert.ok((await press('generate')).result.nextSessionId)
})
