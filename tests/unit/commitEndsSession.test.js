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

// Not mid-chain: these test the ENDING (the rig runs desks mid-chain by default, where a commit keeps the session).
const rigFor = (agent = 'mentor', state = { draft: { asset: 'NVDA' } }) => makeActRig({ agent, desk: desk(agent), state, midChain: false })
const say = (r, s, content = 'Build me an NVDA long') => r.sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'user', content } })

test('a save RESOLVES the session — not kept, even one the user spoke in (its talk is on the entity) — and opens a fresh one: Axl, a line saying what was saved', async () => {
    const r = rigFor()
    const { s, press } = await r.start(user)
    await say(r, s)
    const out = await press('generate')
    assert.ok(out.result.nextSessionId && out.result.nextSessionId !== s.sessionId)
    assert.equal(await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' }), null, 'not archived — deleted')
    assert.equal(await r.sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' }), null, 'its rows went with it')
    assert.deepEqual((await r.sessions.list({ userId: 'u1' })).map(x => x.status), ['active'], 'History holds nothing from it')
    const next = await r.sessions.getActive({ userId: 'u1' })
    assert.equal(next.sessionId, out.result.nextSessionId)
    assert.equal(next.floor ?? 'axl', 'axl', 'the new session is Axl\'s')
    const [line] = await r.sessions.messagesSince({ sessionId: next.sessionId, userId: 'u1' })
    assert.equal(line.agent, 'axl')
    assert.equal(line.kind, 'sealed')
    assert.equal(line.content, '✓ Mentor built NVDA setup — saved to your Setups. You\'re back with Axl.')
    assert.deepEqual(line.ref, { kind: 'setup', ids: ['s1'], ended: true })
})

test('"New session" over a session the user spoke in still FILES it — History is what ended without a save', async () => {
    const r = rigFor()
    const { s } = await r.start(user)
    await say(r, s, 'What moved oil today?')
    await r.sessions.startNew({ userId: 'u1' })
    const old = await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(old.status, 'archived')
    assert.equal(old.title, 'What moved oil today?')
})

test('History\'s delete: an archived session goes with its rows; the live one and someone else\'s are refused', async () => {
    const r = rigFor()
    const { s } = await r.start(user)
    await say(r, s, 'What moved oil today?')
    const live = await r.sessions.startNew({ userId: 'u1' })
    assert.deepEqual(await r.sessions.remove({ sessionId: live.sessionId, userId: 'u1' }), { reason: 'active_session' })
    assert.deepEqual(await r.sessions.remove({ sessionId: s.sessionId, userId: 'u2' }), { reason: 'not_found' }, 'owner-scoped')
    assert.deepEqual(await r.sessions.remove({ sessionId: s.sessionId, userId: 'u1' }), { ok: true })
    assert.equal(await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' }), null)
    assert.equal(await r.sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' }), null)
    assert.deepEqual(await r.sessions.remove({ sessionId: s.sessionId, userId: 'u1' }), { reason: 'not_found' })
})

test('a session the user said NOTHING in is not kept — deleted, never "Untitled" in History; the new one still opens', async () => {
    const r = rigFor()
    const { s, press } = await r.start(user)
    await r.sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', kind: 'sealed', content: 'Mentor · NVDA setup' } })
    const out = await press('generate')
    assert.ok(out.result.nextSessionId && out.result.nextSessionId !== s.sessionId)
    assert.equal(await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' }), null)
    assert.equal(await r.sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' }), null, 'its rows went with it')
    assert.ok(!(await r.sessions.list({ userId: 'u1' })).some(x => x.title === 'Untitled'))
})

test('a commit that ends the session leaves its timeline as it was — the seal is told so; mid-chain it is not', async () => {
    const r = rigFor()
    const { s, press } = await r.start(user)
    await say(r, s)
    await press('generate')
    assert.equal(r.seals.at(-1).keepTimeline, true)
    const m = makeActRig({ agent: 'mentor', desk: desk('mentor'), state: { draft: { asset: 'NVDA' } } })   // mid-chain
    const run = await m.start(user)
    await run.press('generate')
    assert.equal('keepTimeline' in m.seals.at(-1), false)
})

test('"New session" over a session the user said nothing in replaces it rather than filing it', async () => {
    const r = rigFor()
    const { s } = await r.start(user)
    await r.sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'axl', role: 'assistant', content: 'Hello' } })
    const next = await r.sessions.startNew({ userId: 'u1' })
    assert.notEqual(next.sessionId, s.sessionId)
    assert.equal(await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' }), null)
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
