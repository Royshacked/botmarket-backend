import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTagSuppressor } from '../../services/llmStream.util.js'

// Feed a whole string through the suppressor one char at a time (mimics streamed
// deltas) and return everything onToken received, joined.
function run(text, opts = {}) {
    const out = []
    const s = createTagSuppressor({ onToken: (t) => out.push(t), captures: opts.captures ?? [] })
    for (const ch of text) s.push(ch)
    s.flush()
    return out.join('')
}

test('createTagSuppressor: passes plain text straight through', () => {
    assert.equal(run('hello world'), 'hello world')
})

test('createTagSuppressor: swallows a suppressed block', () => {
    const captures = [{ open: '<state>', close: '</state>' }]
    assert.equal(run('a<state>hidden</state>b', { captures }), 'ab')
})

test('createTagSuppressor: forwards inner text of a capture with onCapture', () => {
    const captured = []
    const captures = [{ open: '<ticker>', close: '</ticker>', onCapture: (t) => captured.push(t) }]
    assert.equal(run('go <ticker>NQ</ticker> now', { captures }), 'go  now')
    assert.deepEqual(captured, ['NQ'])
})

// Regression: the Axl social-chat reply path calls the provider without onToken
// (it collects the full return value instead of streaming). The suppressor must
// treat onToken as optional and no-op instead of throwing "onToken is not a
// function" — a throw there was swallowed by fire-and-forget .catch and left Axl
// silently never replying.
test('createTagSuppressor: works with no onToken (non-streaming caller)', () => {
    const s = createTagSuppressor({ captures: [{ open: '<state>', close: '</state>' }] })
    assert.doesNotThrow(() => {
        s.push('hello ')
        s.push('<state>x</state>')
        s.push('world')
        s.flush()
    })
})

test('createTagSuppressor: no onToken + keepText block does not throw', () => {
    const s = createTagSuppressor({ captures: [{ open: '<ticker>', close: '</ticker>', keepText: true }] })
    assert.doesNotThrow(() => {
        s.push('a<ticker>NQ</ticker>b')
        s.flush()
    })
})
