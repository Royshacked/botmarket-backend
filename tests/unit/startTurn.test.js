import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeStartTurn } from '../../services/desks/startTurn.js'
import { withSessionLock, sessionBusy } from '../../services/desks/turnLock.js'
import { parseMention } from '../../services/session.util.js'
import { lookupForEdit } from '../../services/desks/entityLookup.js'
import { stopTurn } from '../../api/_shared/turnRegistry.js'

// The turn endpoint's engine (plan phase 5b): who answers, one turn at a time per session, answered at
// once and run queued, stoppable through the existing turn registry.

const tick = () => new Promise(r => setTimeout(r, 5))

// ── the lock ────────────────────────────────────────────────────────────────

test('turns on one session run one at a time, in order — never interleaved', async () => {
    const log = []
    const slow = (name, ms) => () => new Promise(r => { log.push(`${name}:start`); setTimeout(() => { log.push(`${name}:end`); r(name) }, ms) })
    const a = withSessionLock('s1', slow('a', 20))
    const b = withSessionLock('s1', slow('b', 1))
    assert.equal(sessionBusy('s1'), true)
    assert.deepEqual(await Promise.all([a, b]), ['a', 'b'])
    assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end'])
    assert.equal(sessionBusy('s1'), false)
})

test('a failed turn never blocks the turns behind it; other sessions do not wait', async () => {
    const failing = withSessionLock('s2', async () => { throw new Error('boom') })
    const after   = withSessionLock('s2', async () => 'ok')
    await assert.rejects(failing, /boom/)
    assert.equal(await after, 'ok')
    assert.equal(await withSessionLock('s3', async () => 'free'), 'free')
})

// ── @mentions ───────────────────────────────────────────────────────────────

test('an agent named at the START, by brand or key, takes the message; anywhere else it is just text', () => {
    assert.deepEqual(parseMention('@Atlas, add this to the growth sleeve'), { agent: 'portfolio', text: 'add this to the growth sleeve' })
    assert.deepEqual(parseMention('@mentor long NVDA'), { agent: 'mentor', text: 'long NVDA' })
    assert.equal(parseMention('email me @atlas later'), null)
    assert.equal(parseMention('@nobody hi'), null)
    assert.equal(parseMention(null), null)
})

// ── startTurn ───────────────────────────────────────────────────────────────

function rig({ turnImpl } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const ran = [], statuses = [], after = []
    const sessionTurn = async (args) => { ran.push(args); return turnImpl ? turnImpl(args) : { payload: { reply: 'ok' } } }
    const emitterFor = ({ turnId, agent }) => ({ emit: () => {}, status: (s, extra) => statuses.push([turnId, agent, s, extra]), end: () => {} })
    const { startTurn } = makeStartTurn({ sessions, sessionTurn, emitterFor, afterTurn: async (x) => { after.push(x) } })
    return { sessions, startTurn, ran, statuses, after }
}
const user = { _id: 'u1', role: 'user' }

test('it answers at once with the turn id and the agent; the turn then runs and reports done', async () => {
    const { sessions, startTurn, ran, statuses, after } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const out = await startTurn({ user, sessionId: s.sessionId, text: 'hello', turnId: 't1' })
    assert.deepEqual(out, { turnId: 't1', agent: 'axl' })
    await tick()
    assert.equal(ran[0].agent, 'axl')
    assert.deepEqual(statuses.map(x => x[2]), ['started', 'done'])
    assert.equal(after.length, 1)
})

test('who answers: the tapped agent, else an @mention (stripped), else the floor', async () => {
    const { sessions, startTurn, ran } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor' })
    await startTurn({ user, sessionId: s.sessionId, text: 'next', turnId: 'a' })
    await startTurn({ user, sessionId: s.sessionId, text: '@Argus find semis', turnId: 'b' })
    await startTurn({ user, sessionId: s.sessionId, text: 'hi', agent: 'axl', turnId: 'c' })
    await tick()
    assert.deepEqual(ran.map(r => `${r.agent}:${r.text}`), ['mentor:next', 'scanner:find semis', 'axl:hi'])
})

test('refused before anything runs: empty text, another user’s session, an admin desk for a trader', async () => {
    const { sessions, startTurn, ran } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    assert.equal((await startTurn({ user, sessionId: s.sessionId, text: '  ' })).reason, 'empty')
    assert.equal((await startTurn({ user: { _id: 'u2' }, sessionId: s.sessionId, text: 'x' })).reason, 'not_found')
    assert.equal((await startTurn({ user, sessionId: s.sessionId, text: 'x', agent: 'strategy' })).reason, 'forbidden')
    await tick()
    assert.equal(ran.length, 0)
})

test('the existing Stop route stops a queued session turn — it reports stopped', async () => {
    const { sessions, startTurn, statuses } = rig({ turnImpl: ({ signal }) => new Promise(r => {
        signal.addEventListener('abort', () => r({ stopped: true }))
    }) })
    const s = await sessions.getActive({ userId: 'u1' })
    await startTurn({ user, sessionId: s.sessionId, text: 'long answer', turnId: 'stop-me' })
    await tick()
    assert.equal(stopTurn('stop-me', 'u1'), true)
    await tick()
    assert.deepEqual(statuses.map(x => x[2]), ['started', 'stopped'])
})

test('a turn that throws reports error and the session keeps working', async () => {
    let n = 0
    const { sessions, startTurn, statuses } = rig({ turnImpl: () => { if (n++ === 0) throw new Error('model down'); return { payload: {} } } })
    const s = await sessions.getActive({ userId: 'u1' })
    await startTurn({ user, sessionId: s.sessionId, text: 'one', turnId: 'e1' })
    await startTurn({ user, sessionId: s.sessionId, text: 'two', turnId: 'e2' })
    await tick()
    assert.deepEqual(statuses.map(x => `${x[0]}:${x[2]}`), ['e1:started', 'e1:error', 'e2:started', 'e2:done'])
})

// ── the edit lookup ─────────────────────────────────────────────────────────

test('an edit reads the entity through its own lookup; coverage only for an admin; an unknown kind is refused', async () => {
    const lookups = {
        setup:    async ({ id }) => ({ ok: true, doc: { id } }),
        coverage: async ({ user }) => (user.role === 'admin' ? { ok: true, doc: { id: 'c' } } : { ok: false, reason: 'forbidden' }),
    }
    assert.deepEqual(await lookupForEdit({ kind: 'setup', id: 's1', user }, lookups), { ok: true, doc: { id: 's1' } })
    assert.equal((await lookupForEdit({ kind: 'coverage', id: 'c', user }, lookups)).reason, 'forbidden')
    assert.equal((await lookupForEdit({ kind: 'call', id: 'x', user }, lookups)).reason, 'not_editable')
})

test('Stop on a turn still WAITING in the queue cancels it — it never runs', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const { sessions, startTurn, ran, statuses } = rig({ turnImpl: async ({ text }) => { if (text === 'first') await gate; return { payload: {} } } })
    const s = await sessions.getActive({ userId: 'u1' })
    await startTurn({ user, sessionId: s.sessionId, text: 'first', turnId: 'q1' })
    await startTurn({ user, sessionId: s.sessionId, text: 'second', turnId: 'q2' })
    await tick()
    assert.equal(stopTurn('q2', 'u1'), true, 'the queued turn is registered and stoppable')
    release()
    await tick()
    assert.deepEqual(ran.map(r => r.text), ['first'])
    assert.ok(statuses.some(([id, , st, extra]) => id === 'q2' && st === 'stopped' && extra?.queued))
})
