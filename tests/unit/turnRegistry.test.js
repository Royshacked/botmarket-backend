import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTurn, stopTurn, _turnCount } from '../../api/_shared/turnRegistry.js'

// STOP and WALKING AWAY used to be the same signal — a closed socket — so leaving a desk mid-answer
// killed the turn and threw away work the user had already paid for. A turn now carries an id, and only
// an explicit stop aborts it.

test('a registered turn can be stopped by its owner', () => {
    const ac = new AbortController()
    registerTurn('t1', ac, 'u1')
    assert.equal(stopTurn('t1', 'u1'), true)
    assert.equal(ac.signal.aborted, true)
})

test('a turn cannot be stopped by anyone else', () => {
    // A turn id is guessable enough that stopping someone else's work must be impossible.
    const ac = new AbortController()
    registerTurn('t2', ac, 'u1')
    assert.equal(stopTurn('t2', 'someone-else'), false)
    assert.equal(ac.signal.aborted, false)
    stopTurn('t2', 'u1')
})

test('stopping an unknown turn is not an error', () => {
    // It may have finished between the click and the request — the same outcome the user wanted.
    assert.equal(stopTurn('never-existed', 'u1'), false)
})

test('release removes the turn, so a later stop cannot reach a finished one', () => {
    const ac = new AbortController()
    const release = registerTurn('t3', ac, 'u1')
    release()
    assert.equal(stopTurn('t3', 'u1'), false)
    assert.equal(ac.signal.aborted, false)
})

test('a turn with no id still runs, it just cannot be stopped remotely', () => {
    const before = _turnCount()
    const release = registerTurn(null, new AbortController(), 'u1')
    assert.equal(_turnCount(), before, 'nothing registered')
    release()   // and releasing it is safe
})

test('stopping twice is harmless', () => {
    const ac = new AbortController()
    registerTurn('t4', ac, 'u1')
    assert.equal(stopTurn('t4', 'u1'), true)
    assert.equal(stopTurn('t4', 'u1'), false)
})
