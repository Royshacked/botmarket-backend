import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _yourTurn, _lastLine } from '../../services/thread.service.js'

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

// ── what was last said ───────────────────────────────────────────────────────
// The same message `_yourTurn` reads, and it was being pulled out of Mongo and binned: the badge
// kept whose turn it was and dropped the words. They are the only account of what a desk actually
// DID, and reception has no other way to know — Axl quotes this on the walk back from a desk.

test('the desk\'s closing turn travels, named as the desk\'s', () => {
    assert.deepEqual(
        _lastLine([{ role: 'user', content: 'cover NVDA' }, { role: 'assistant', content: 'PT 210 vs 185 Street.' }]),
        { role: 'assistant', text: 'PT 210 vs 185 Street.' },
    )
})

// The role is half the meaning, not bookkeeping: the user speaking last means they walked out
// mid-turn, which is a trip to offer back INTO rather than one to close.
test('the user speaking last is reported as the user\'s — a trip cut short', () => {
    assert.deepEqual(
        _lastLine([{ role: 'assistant', content: 'which zone?' }, { role: 'user', content: 'the 412 one' }]),
        { role: 'user', text: 'the 412 one' },
    )
})

test('hard wrapping is collapsed — it becomes a clause in a sentence, not a document', () => {
    assert.equal(_lastLine([{ role: 'assistant', content: '  PT 210,\n  vs   185.  ' }]).text, 'PT 210, vs 185.')
})

// Capped because it is quoted INSIDE a prompt. A desk's closing turn can be a page of plan, and a
// page quoted back at reception buries the question the return turn exists to ask.
test('a page-long closing turn is cut, not carried whole', () => {
    const long = _lastLine([{ role: 'assistant', content: 'x'.repeat(5000) }])
    assert.equal(long.text.length, 400)
})

test('nothing said, or nothing sayable, is null — never a quote of an empty string', () => {
    assert.equal(_lastLine([]), null)
    assert.equal(_lastLine(null), null)
    assert.equal(_lastLine([{ role: 'assistant', content: '   ' }]), null)
    assert.equal(_lastLine([{ role: 'assistant' }]), null)
    // A hidden row is history-only — the note a chart turn leaves behind. Nobody said it.
    assert.equal(_lastLine([{ role: 'assistant', content: 'Showed the SPY day chart.', hidden: true }]), null)
})
