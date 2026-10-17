import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { turnEmitter, runningTurn, replay } from '../../services/sessionChannel.js'
import { onClientEvent, _dispatch } from '../../api/chat/chatWs.js'

// The unified chat's live channel (plan phase 5a) — on the existing WebSocket. What it must guarantee:
// every change the store makes is pushed; a running turn streams as deltas and keeps its text so far; a
// reconnecting screen is caught up from the store, to that socket only.

const OPEN = 1
const fakeSocket = () => { const sent = []; return { readyState: OPEN, send: (f) => sent.push(JSON.parse(f)), sent } }

function storeWithEvents() {
    const { db } = memDb()
    const pushed = []
    const events = {
        message: (u, s, m) => pushed.push(['message', u, s, m.seq]),
        removed: (u, s, seqs) => pushed.push(['removed', u, s, seqs]),
        state:   (u, s, p) => pushed.push(['state', u, s, p]),
    }
    return { store: makeSessionService({ getDb: async () => db, events }), pushed }
}

test('every change the store makes is pushed: appends, removals, the floor, an agent’s state, a new session', async () => {
    const { store, pushed } = storeWithEvents()
    const s = await store.getActive({ userId: 'u1' })
    await store.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'axl', role: 'user', content: 'hi' } })
    await store.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor' })
    await store.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' } } })
    await store.removeMessages({ sessionId: s.sessionId, userId: 'u1', seqs: [1] })
    const next = await store.startNew({ userId: 'u1' })
    assert.deepEqual(pushed, [
        ['message', 'u1', s.sessionId, 1],
        ['state', 'u1', s.sessionId, { floor: 'mentor' }],
        ['state', 'u1', s.sessionId, { agent: 'mentor', state: { draft: { asset: 'NVDA' } } }],
        ['removed', 'u1', s.sessionId, [1]],
        ['state', 'u1', s.sessionId, { archived: true, next: next.sessionId }],
    ])
})

test('a refused change pushes nothing (another user’s session)', async () => {
    const { store, pushed } = storeWithEvents()
    const s = await store.getActive({ userId: 'u1' })
    await store.setFloor({ sessionId: s.sessionId, userId: 'u2', agent: 'mentor' })
    await store.append({ sessionId: s.sessionId, userId: 'u2', message: { agent: 'axl', role: 'user', content: 'x' } })
    assert.deepEqual(pushed, [])
})

test('a running turn streams as deltas, keeps its text so far, and is forgotten when it ends', () => {
    const sent = []
    const t = turnEmitter({ userId: 'u1', sessionId: 'ses1', turnId: 'tu1', agent: 'mentor', send: (...a) => sent.push(a) })
    t.status('started')
    t.emit('token', { text: 'Hello ' })
    t.emit('status', { tool: 'get_candles' })
    t.emit('token', { text: 'world' })
    assert.equal(runningTurn('ses1').text, 'Hello world')
    assert.deepEqual(sent[1], ['u1', 'session_delta', { sessionId: 'ses1', turnId: 'tu1', agent: 'mentor', type: 'token', data: { text: 'Hello ' } }])
    assert.deepEqual(sent[0], ['u1', 'session_turn', { sessionId: 'ses1', turnId: 'tu1', agent: 'mentor', status: 'started' }])
    t.end()
    assert.equal(runningTurn('ses1'), null)
})

test('replay sends every row after the seq, the floor, and a running turn’s text once — to the socket that asked', async () => {
    const { store } = storeWithEvents()
    const s = await store.getActive({ userId: 'u1' })
    for (const c of ['a', 'b', 'c']) await store.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'axl', role: 'user', content: c } })
    const t = turnEmitter({ userId: 'u1', sessionId: s.sessionId, turnId: 'tu9', agent: 'axl', send: () => {} })
    t.emit('token', { text: 'thinking…' })
    const replies = []
    await replay({ userId: 'u1', data: { sessionId: s.sessionId, afterSeq: 1 }, reply: (e, d) => replies.push([e, d]) }, store)
    t.end()
    const [event, body] = replies[0]
    assert.equal(event, 'session_replay')
    assert.deepEqual(body.messages.map(m => m.content), ['b', 'c'])
    assert.equal(body.floor, 'axl')
    assert.deepEqual(body.running, { turnId: 'tu9', agent: 'axl', text: 'thinking…' })
})

test('replay of a session that is not yours answers not_found and leaks nothing', async () => {
    const { store } = storeWithEvents()
    const s = await store.getActive({ userId: 'u1' })
    const replies = []
    await replay({ userId: 'u2', data: { sessionId: s.sessionId }, reply: (e, d) => replies.push([e, d]) }, store)
    assert.deepEqual(replies, [['session_replay', { sessionId: s.sessionId, error: 'not_found' }]])
})

test('chatWs routes a client frame to its registered handler, with a reply bound to that socket', async () => {
    const seen = []
    onClientEvent('test_frame', ({ userId, data, reply }) => { seen.push([userId, data]); reply('test_answer', { ok: true }) })
    const ws = fakeSocket()
    _dispatch('u1', ws, { event: 'test_frame', data: { x: 1 } })
    await new Promise(r => setImmediate(r))
    assert.deepEqual(seen, [['u1', { x: 1 }]])
    assert.deepEqual(ws.sent, [{ event: 'test_answer', data: { ok: true } }])
    _dispatch('u1', ws, { event: 'nobody_listens' })   // an unknown frame is ignored, not an error
})
