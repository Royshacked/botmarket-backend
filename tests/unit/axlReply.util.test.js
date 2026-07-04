import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toAgentMessages } from '../../api/chat/axlReply.util.js'

const BOT = 'axl'

test('toAgentMessages: maps bot→assistant, others→user', () => {
    const out = toAgentMessages([
        { senderId: 'u1',  content: 'hi' },
        { senderId: BOT,   content: 'hello, I am Axl' },
        { senderId: 'u1',  content: 'how does this app work?' },
    ], BOT)
    assert.deepEqual(out, [
        { role: 'user',      content: 'hi' },
        { role: 'assistant', content: 'hello, I am Axl' },
        { role: 'user',      content: 'how does this app work?' },
    ])
})

test('toAgentMessages: drops empty / non-string content (e.g. notification cards)', () => {
    const out = toAgentMessages([
        { senderId: BOT, content: '' },
        { senderId: BOT, content: '   ' },
        { senderId: BOT, content: null },
        { senderId: BOT, content: 'real text' },
        { senderId: 'u1', content: 'ask' },
    ], BOT)
    assert.deepEqual(out, [
        { role: 'assistant', content: 'real text' },
        { role: 'user',      content: 'ask' },
    ])
})

test('toAgentMessages: trims content', () => {
    const out = toAgentMessages([{ senderId: 'u1', content: '  spaced  ' }], BOT)
    assert.deepEqual(out, [{ role: 'user', content: 'spaced' }])
})

test('toAgentMessages: keeps only the last maxCount', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ senderId: 'u1', content: `m${i}` }))
    const out = toAgentMessages(msgs, BOT, 5)
    assert.equal(out.length, 5)
    assert.equal(out[0].content, 'm15')
    assert.equal(out.at(-1).content, 'm19')
})

test('toAgentMessages: senderId compared as string (numeric ids)', () => {
    const out = toAgentMessages([
        { senderId: 42, content: 'from a numeric user' },
    ], 42)
    assert.deepEqual(out, [{ role: 'assistant', content: 'from a numeric user' }])
})

test('toAgentMessages: non-array input → empty', () => {
    assert.deepEqual(toAgentMessages(null, BOT), [])
    assert.deepEqual(toAgentMessages(undefined, BOT), [])
})
