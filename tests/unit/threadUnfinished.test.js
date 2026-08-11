import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _yourTurn } from '../../services/thread.service.js'

// Unfinished work per desk — what the route badges read. A conversation the user walked away from is
// already a DRAFT thread, resumable; the only thing missing was that nothing outside the desk said so.
// Whose turn it is is DERIVED from the messages, so there is no second field to keep in step.

test('the assistant spoke last → it is waiting on the user', () => {
    assert.equal(_yourTurn([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'which sectors?' }]), true)
})

test('the user spoke last → the desk owes the answer, not the user', () => {
    // Mid-response counts as the desk's turn: nothing is waiting on the human yet.
    assert.equal(_yourTurn([{ role: 'assistant', content: 'which sectors?' }, { role: 'user', content: 'tech' }]), false)
})

test('an empty or malformed thread is nobody\'s turn, not a crash', () => {
    assert.equal(_yourTurn([]), false)
    assert.equal(_yourTurn(null), false)
    assert.equal(_yourTurn(undefined), false)
    assert.equal(_yourTurn('not an array'), false)
})
