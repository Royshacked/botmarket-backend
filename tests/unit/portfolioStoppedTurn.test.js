import { test } from 'node:test'
import assert from 'node:assert/strict'
import { portfolioChatService } from '../../api/portfolio/portfolioChat.service.js'
import { threadService } from '../../services/thread.service.js'

// A TURN THE USER STOPPED still leaves a conversation behind.
//
// Atlas is the one desk whose draft is written on the SERVER, so the rule the five client-persisted
// desks get from useChatStream's `onStopped` has to be stated here too. The controller's abort gate
// used to drop everything — the model's answer AND the conversation — so a build the user walked out
// of mid-turn left no marker at the hub and no chat after a reload.
//
// What is saved is the messages AS SENT: the user's turn and the completed ones before it. Never an
// assistant turn, because none arrived.

function withCapturedSaves(fn) {
    const real  = threadService.saveDraft
    const calls = []
    threadService.saveDraft = async (arg) => { calls.push(arg); return { ok: true } }
    try { fn() } finally { threadService.saveDraft = real }
    return calls
}

const MSGS = [
    { role: 'user',      content: 'Build me a defensive book.' },
    { role: 'assistant', content: 'What horizon?' },
    { role: 'user',      content: '5 years, income tilt.' },
]
const MANDATE = { objective: 'income', horizon: '5y' }

test('a stopped construction turn saves the conversation as sent', () => {
    const calls = withCapturedSaves(() => {
        portfolioChatService.persistStoppedTurn({
            userId: 'u1', threadId: 't1', portfolioId: null,
            messages: MSGS, mandate: MANDATE, phase: null, pipeline: 'portfolio',
        })
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].agent, 'portfolio')
    assert.equal(calls[0].threadId, 't1')
    assert.equal(calls[0].pipeline, 'portfolio')   // the MARKER keys on this, never on the agent
    assert.deepEqual(calls[0].messages, MSGS)
    // The turn produced no reply, so nothing is appended — an empty assistant turn would come back
    // on resume as an answer Atlas never gave.
    assert.equal(calls[0].messages.at(-1).role, 'user')
})

test('below the substantive floor it writes nothing — the same answer a completed turn gets there', () => {
    const calls = withCapturedSaves(() => {
        portfolioChatService.persistStoppedTurn({
            userId: 'u1', threadId: 't1', portfolioId: null,
            messages: [{ role: 'user', content: 'hi' }], mandate: null, phase: null,
        })
    })
    assert.equal(calls.length, 0)
})

test('a phase past the floor saves even with no mandate yet', () => {
    const calls = withCapturedSaves(() => {
        portfolioChatService.persistStoppedTurn({
            userId: 'u1', threadId: 't1', portfolioId: null,
            messages: MSGS, mandate: null, phase: 3,
        })
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].phase, 3)
})

test('an EDIT saves nothing — that conversation belongs to the book it is editing', () => {
    const calls = withCapturedSaves(() => {
        portfolioChatService.persistStoppedTurn({
            userId: 'u1', threadId: 't1', portfolioId: 'p1',
            messages: MSGS, mandate: MANDATE, phase: 4,
        })
    })
    assert.equal(calls.length, 0)
})

test('no thread to write to is a no-op, not a crash', () => {
    const calls = withCapturedSaves(() => {
        portfolioChatService.persistStoppedTurn({
            userId: 'u1', threadId: null, portfolioId: null,
            messages: MSGS, mandate: MANDATE, phase: 4,
        })
    })
    assert.equal(calls.length, 0)
})
