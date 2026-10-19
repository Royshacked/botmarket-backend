import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'

// History's RESUME (design §3.5 "…or resumes it"; Roy, 2026-10-19): an archived session becomes the live one again,
// with its floor and its desks' state as it was left; the live one is put away exactly as "New session" puts it away.

function rig() {
    const { db } = memDb()
    const sent = []
    const sessions = makeSessionService({ getDb: async () => db, events: { state: (...a) => sent.push(a), message() {}, removed() {} } })
    return { sessions, sent }
}
const say = (sessions, s, content, agent = 'axl') => sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent, role: 'user', content } })

test('an archived session comes back live — floor and desk state intact — and the live one goes to History under its title', async () => {
    const { sessions, sent } = rig()
    const old = await sessions.getActive({ userId: 'u1' })
    await say(sessions, old, 'Build me an NVDA long', 'mentor')
    await sessions.setFloor({ sessionId: old.sessionId, userId: 'u1', agent: 'mentor' })
    await sessions.setAgentState({ sessionId: old.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })
    const now = await sessions.startNew({ userId: 'u1' })
    await say(sessions, now, 'What moved oil today?')

    const out = await sessions.resume({ sessionId: old.sessionId, userId: 'u1' })
    assert.equal(out.session.sessionId, old.sessionId)
    const back = await sessions.get({ sessionId: old.sessionId, userId: 'u1' })
    assert.deepEqual([back.status, back.floor, back.agentState.mentor.draft.asset, back.archivedAt], ['active', 'mentor', 'NVDA', null])
    const away = await sessions.get({ sessionId: now.sessionId, userId: 'u1' })
    assert.deepEqual([away.status, away.title], ['archived', 'What moved oil today?'])
    assert.equal((await sessions.getActive({ userId: 'u1' })).sessionId, old.sessionId, 'one live session — the resumed one')
    assert.deepEqual(sent.at(-1), ['u1', now.sessionId, { archived: true, next: old.sessionId }], 'every open screen moves with it')
})

test('a live session the user said nothing in is not kept on the way out — no "Untitled" in History', async () => {
    const { sessions } = rig()
    const old = await sessions.getActive({ userId: 'u1' })
    await say(sessions, old, 'Scan semis for me')
    const empty = await sessions.startNew({ userId: 'u1' })
    await sessions.resume({ sessionId: old.sessionId, userId: 'u1' })
    assert.equal(await sessions.get({ sessionId: empty.sessionId, userId: 'u1' }), null)
})

test('owner-scoped and idempotent: someone else\'s is not found; the live one comes back as it is', async () => {
    const { sessions } = rig()
    const old = await sessions.getActive({ userId: 'u1' })
    await say(sessions, old, 'Scan semis for me')
    await sessions.startNew({ userId: 'u1' })
    assert.deepEqual(await sessions.resume({ sessionId: old.sessionId, userId: 'u2' }), { reason: 'not_found' })
    assert.deepEqual(await sessions.resume({ sessionId: 'ses_nope', userId: 'u1' }), { reason: 'not_found' })
    const live = await sessions.getActive({ userId: 'u1' })
    assert.equal((await sessions.resume({ sessionId: live.sessionId, userId: 'u1' })).session.sessionId, live.sessionId)
})
