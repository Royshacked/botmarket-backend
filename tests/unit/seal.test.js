import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAgentContextService, forgetIfDeleted } from '../../services/agentContext.service.js'
import { makeSealing } from '../../services/desks/seal.js'
import { DESK_DEFS } from '../../services/desks/index.js'
import { mentorStateFromEntity } from '../../services/desks/mentor.desk.js'

// Sealing and editing (services/desks/seal.js, unified-chat.md §6.2): work that ends in an entity leaves
// the session for that entity's sealed context; editing brings it back; deleting the entity forgets it.

function rig() {
    const { db, rows } = memDb()
    const getDb = async () => db
    const sessions = makeSessionService({ getDb })
    const contexts = makeAgentContextService({ getDb })
    return { sessions, contexts, rows, seal: makeSealing({ sessions, contexts, desks: DESK_DEFS }) }
}
const say = (agent, role, content, extra = {}) => ({ agent, role, content, ...extra })

async function chat(sessions, sessionId, msgs) {
    for (const m of msgs) await sessions.append({ sessionId, userId: 'u1', message: m })
}

test('a seal moves the agent’s turns onto the entity, keeps hand-offs, leaves one line, links, and clears state', async () => {
    const { sessions, contexts, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await chat(sessions, s.sessionId, [
        say('axl', 'user', 'I want to trade'),
        say('scanner', 'assistant', 'NVDA is the pick', { kind: 'handoff', to: 'mentor' }),
        say('mentor', 'user', 'long it'),
        say('mentor', 'assistant', 'two legs, stop 142'),
    ])
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })

    const out = await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['st1'], name: 'NVDA setup' })
    assert.equal(out.sealed, 1)
    assert.equal(out.turns, 3)

    // The context: the hand-off it received (as the user), then its own two turns.
    const ctx = await contexts.load({ userId: 'u1', kind: 'setup', entityId: 'st1', agent: 'mentor' })
    assert.deepEqual(ctx.messages.map(m => `${m.role}:${m.content}`), ['user:NVDA is the pick', 'user:long it', 'assistant:two legs, stop 142'])

    // The session: Mentor's rows are gone; Axl's turn and Argus's hand-off stay; one sealed line.
    const left = await sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(left.map(m => `${m.agent}:${m.kind}`), ['axl:msg', 'scanner:handoff', 'mentor:sealed'])
    assert.equal(left.at(-1).content, 'Mentor built NVDA setup')
    const header = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(header.links.map(l => `${l.kind}:${l.id}`), ['setup:st1'])
    assert.equal(header.agentState.mentor, null)
})

test('a second seal takes only the turns since the first, and appends to the same context on an edit', async () => {
    const { sessions, contexts, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'build AMD'), say('mentor', 'assistant', 'done')])
    await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['st1'] })
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'move the stop'), say('mentor', 'assistant', 'moved')])
    const out = await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['st1'] })
    assert.equal(out.turns, 2)
    const ctx = await contexts.load({ userId: 'u1', kind: 'setup', entityId: 'st1', agent: 'mentor' })
    assert.deepEqual(ctx.messages.map(m => m.content), ['build AMD', 'done', 'move the stop', 'moved'])
})

test('Generate-all seals the same turns onto every setup it saved', async () => {
    const { sessions, contexts, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'AMD and NVDA'), say('mentor', 'assistant', 'both built')])
    const out = await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['a', 'b'] })
    assert.equal(out.sealed, 2)
    for (const id of ['a', 'b']) assert.equal((await contexts.load({ userId: 'u1', kind: 'setup', entityId: id, agent: 'mentor' })).messages.length, 2)
    assert.equal(out.line.content, 'Mentor built 2 setups')
})

test('the Generate hook does nothing without a sessionId, and never throws with a bad one', async () => {
    const { seal, rows } = rig()
    assert.equal(await seal.sealAfterGenerate({ body: {}, user: { _id: 'u1' } }, { kind: 'setup', entityIds: ['st1'] }), null)
    const bad = await seal.sealAfterGenerate({ body: { sessionId: 'nope' }, user: { _id: 'u1' } }, { kind: 'setup', entityIds: ['st1'] })
    assert.equal(bad.reason, 'not_found')
    assert.equal(rows('agent_contexts').length, 0)
})

test('openForEdit puts the desk’s state back from the entity, marks it editing, shows the card, and takes the floor', async () => {
    const { sessions, contexts, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await contexts.seal({ userId: 'u1', kind: 'setup', entityId: 'st1', agent: 'mentor', messages: [{ role: 'user', content: 'long AMD' }], summary: 'keep size under 2%' })
    const setup = { id: 'st1', asset: 'AMD', direction: 'long', chat_state: { draft: { asset: 'AMD', build: { names: [] } }, coverage: ['chart'] } }
    const out = await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: setup, name: 'AMD setup' })
    assert.equal(out.agent, 'mentor')
    assert.equal(out.hasContext, true)
    const header = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(header.agentState.mentor.editing, { kind: 'setup', entityId: 'st1' })
    assert.deepEqual(header.agentState.mentor.draft, { asset: 'AMD', build: { names: [] } })
    assert.equal(header.floor, 'mentor')
    assert.match(out.line.content, /^Mentor · AMD setup\nkeep size under 2%\nYou: long AMD$/)
})

test('an entity no desk edits is refused', async () => {
    const { sessions, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    assert.equal((await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'industry_view', entity: { id: 'x' } })).reason, 'not_editable')
})

// ── state from an entity ────────────────────────────────────────────────────

test('Mentor rebuilds its draft from a setup with no stored draft — the fallback the client used to build', () => {
    const st = mentorStateFromEntity({ id: 's', asset: 'TSLA', direction: 'short', entry_legs: [{ price: 250 }] })
    assert.equal(st.draft.asset, 'TSLA')
    assert.equal(st.draft.direction, 'short')
    assert.deepEqual(st.draft.entry_legs, [{ price: 250 }])
    assert.equal(st.active_asset, 'TSLA')
})

test('Argus reopens a saved list in edit mode; Prometheus reopens a thesis as its draft; Atlas needs only the book id', () => {
    const scan = DESK_DEFS.scanner.stateFromEntity({ id: 'sc1', thesis: 'semis', candidates: [{ ticker: 'NVDA' }], profile: 'investing' })
    assert.equal(scan.editingScanId, 'sc1')
    assert.deepEqual(scan.editList.candidates, [{ ticker: 'NVDA' }])
    assert.equal(scan.profile, 'investing')
    assert.deepEqual(DESK_DEFS.analyst.stateFromEntity({ id: 'c', symbol: 'CVX' }), { active_symbol: 'CVX', draft: { id: 'c', symbol: 'CVX' } })
    assert.equal(DESK_DEFS.portfolio.stateFromEntity({ portfolioId: 'p1' }).portfolioId, 'p1')
})

// ── delete cleanup ──────────────────────────────────────────────────────────

test('forgetIfDeleted clears the contexts only when the delete succeeded, and hands the result back', async () => {
    const calls = []
    const svc = { removeFor: async (a) => { calls.push(a); return { deleted: 1 } } }
    assert.deepEqual(forgetIfDeleted('setup', 'st1', { ok: true }, svc), { ok: true })
    assert.deepEqual(forgetIfDeleted('setup', 'st2', { ok: false, reason: 'not_found' }, svc), { ok: false, reason: 'not_found' })
    assert.equal(forgetIfDeleted('setup', 'st3', null, svc), null)
    assert.deepEqual(calls, [{ kind: 'setup', entityId: 'st1' }])
})
