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

test('an UPDATE seals only when the agent is editing that entity — never its unrelated work in progress', async () => {
    const { sessions, contexts, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await chat(sessions, s.sessionId, [say('scanner', 'user', 'find me semis'), say('scanner', 'assistant', 'here are 8')])
    const skipped = await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'scanner', kind: 'scan', entityIds: ['old'], onlyIfEditing: true })
    assert.equal(skipped.reason, 'not_editing')
    assert.equal(await contexts.load({ userId: 'u1', kind: 'scan', entityId: 'old', agent: 'scanner' }), null)
    assert.equal((await sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })).length, 2, 'the in-progress turns stay')
})

test('nothing to seal → no line, no link, nothing cleared', async () => {
    const { sessions, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'X' } } })
    const out = await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['st1'] })
    assert.deepEqual(out, { sealed: 0, turns: 0, line: null })
    const h = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(h.links, [])
    assert.deepEqual(h.agentState.mentor, { draft: { asset: 'X' } })
})

test('the seal point is stored, and an older summary never travels with newer turns', async () => {
    const { sessions, contexts, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'a'), say('mentor', 'assistant', 'b')])
    const first = await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['st1'] })
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).seals.mentor, first.line.seq)
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'c')])
    await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['st2'] })
    const two = await contexts.load({ userId: 'u1', kind: 'setup', entityId: 'st2', agent: 'mentor' })
    assert.deepEqual(two.messages.map(m => m.content), ['c'])
    assert.equal(two.summary, null)
})

test('reopening is REFUSED while the agent holds other unsealed work, unless the user chose to drop it', async () => {
    const { sessions, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })
    const setup = { id: 'st9', asset: 'AMD' }
    assert.deepEqual(await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: setup }), { reason: 'busy', agent: 'mentor' })
    assert.deepEqual((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.mentor, { draft: { asset: 'NVDA' } }, 'the NVDA work is untouched')
    const forced = await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: setup, force: true })
    assert.equal(forced.agent, 'mentor')
    // Reopening the SAME item it is already editing is not "other work".
    assert.equal((await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: setup })).agent, 'mentor')
})

test('a long name is cut for the line', async () => {
    const { sessions, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await chat(sessions, s.sessionId, [say('scanner', 'user', 'go')])
    const out = await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'scanner', kind: 'scan', entityIds: ['sc'], name: 'x'.repeat(200) })
    assert.ok(out.line.content.length <= 'Argus saved '.length + 60)
    assert.match(out.line.content, /…$/)
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
    assert.deepEqual(DESK_DEFS.analyst.stateFromEntity({ id: 'c', symbol: 'CVX' }), { active_symbol: 'CVX', draft: { id: 'c', symbol: 'CVX' }, standing: false, editingSymbol: 'CVX' })
    assert.equal(DESK_DEFS.portfolio.stateFromEntity({ portfolioId: 'p1' }).portfolioId, 'p1')
})

// ── delete cleanup ──────────────────────────────────────────────────────────

test('forgetIfDeleted clears the contexts only when the delete succeeded, and hands the result back', async () => {
    const calls = []
    const svc = { removeFor: async (a) => { calls.push(a); return { deleted: 1 } } }
    assert.deepEqual(forgetIfDeleted('setup', 'st1', { ok: true }, svc), { ok: true })
    assert.deepEqual(forgetIfDeleted('setup', 'st2', { ok: false, reason: 'not_found' }, svc), { ok: false, reason: 'not_found' })
    assert.equal(forgetIfDeleted('setup', 'st3', null, svc), null)
    // A delete that matched nothing — another user's portfolioId, or one already gone — forgets nothing.
    assert.deepEqual(forgetIfDeleted('portfolio', 'p-not-mine', { ok: true, deleted: 0 }, svc), { ok: true, deleted: 0 })
    forgetIfDeleted('portfolio', 'p-mine', { ok: true, deleted: 1 }, svc)
    assert.deepEqual(calls, [{ kind: 'setup', entityId: 'st1' }, { kind: 'portfolio', entityId: 'p-mine' }])
})

test('a state that is only mode or markers does not block reopening — only real unsealed work does', async () => {
    const { sessions, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    // Argus's landing mode after a route: no list in progress.
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: { handoff: false, profile: 'trading', pendingScan: null, editingScanId: null } })
    const out = await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'scan', entity: { id: 'sc1', candidates: [] } })
    assert.equal(out.agent, 'scanner')
})

test('8e: a reopen over other work SETS IT ASIDE — the dropped turns never seal onto the item; the same item keeps them', async () => {
    const { sessions, contexts, seal } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'NVDA on a pullback?'), say('mentor', 'assistant', 'Here is an NVDA draft.')])
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })
    const setup = { id: 'st9', asset: 'AMD' }
    await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: setup, force: true })
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.ok(after.seals.mentor >= 2, 'the seal point moved past the NVDA turns')
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'move the AMD stop'), say('mentor', 'assistant', 'Moved.')])
    await seal.sealFromSession({ userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['st9'] })
    const ctx = await contexts.load({ userId: 'u1', kind: 'setup', entityId: 'st9', agent: 'mentor' })
    const said = ctx.messages.map(m => m.content).join(' | ')
    assert.match(said, /move the AMD stop/)
    assert.doesNotMatch(said, /NVDA/, 'the put-aside NVDA conversation is not on the AMD setup')

    // Reopening the SAME item it is already editing sets nothing aside.
    const before = (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).seals.mentor
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'AMD' }, editing: { kind: 'setup', entityId: 'st9' } } })
    await chat(sessions, s.sessionId, [say('mentor', 'user', 'and the target?')])
    await seal.openForEdit({ userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: setup })
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).seals.mentor, before)
})
