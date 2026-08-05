import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _register, _unregister, _socketCount, emit } from '../../api/chat/chatWs.js'

// The socket registry behind the unread badge. It used to hold ONE socket per user, so a second
// connection displaced the first WITHOUT closing it: that browser saw no close, never reconnected,
// and quietly stopped receiving `new_message` — the badge sat still while messages arrived, and the
// count only appeared when opening the chat read it over REST.

const OPEN = 1   // WebSocket.OPEN — the fakes only need the numeric state

function fakeSocket(readyState = OPEN) {
    return { readyState, sent: [], send(frame) { this.sent.push(frame) } }
}

function events(ws) {
    return ws.sent.map(f => JSON.parse(f))
}

test('a second connection joins the user instead of displacing the first', () => {
    const a = fakeSocket(), b = fakeSocket()
    _register('u1', a)
    _register('u1', b)

    assert.equal(_socketCount('u1'), 2)

    emit('u1', 'new_message', { id: 'm1' })
    assert.deepEqual(events(a), [{ event: 'new_message', data: { id: 'm1' } }], 'the FIRST tab must still be fed')
    assert.deepEqual(events(b), [{ event: 'new_message', data: { id: 'm1' } }])

    _unregister('u1', a)
    _unregister('u1', b)
})

test('closing one tab leaves the others connected', () => {
    const a = fakeSocket(), b = fakeSocket()
    _register('u2', a)
    _register('u2', b)

    assert.equal(_unregister('u2', a), 1)
    emit('u2', 'new_message', { id: 'm2' })

    assert.equal(events(a).length, 0, 'a closed socket is never written to')
    assert.deepEqual(events(b), [{ event: 'new_message', data: { id: 'm2' } }])

    _unregister('u2', b)
})

test('the last close forgets the user — no empty set left behind', () => {
    const a = fakeSocket()
    _register('u3', a)
    assert.equal(_unregister('u3', a), 0)
    assert.equal(_socketCount('u3'), 0)

    // Emitting to someone offline is a no-op, not a throw: every monitor pushes through here.
    assert.doesNotThrow(() => emit('u3', 'new_message', { id: 'm3' }))
})

test('a socket that is not OPEN is skipped, and does not stop the others', () => {
    const closing = fakeSocket(2)   // CLOSING
    const live    = fakeSocket()
    _register('u4', closing)
    _register('u4', live)

    emit('u4', 'new_message', { id: 'm4' })

    assert.equal(events(closing).length, 0)
    assert.equal(events(live).length, 1)

    _unregister('u4', closing)
    _unregister('u4', live)
})

test('unregistering a socket that was never registered is harmless', () => {
    assert.equal(_unregister('nobody', fakeSocket()), 0)
})
