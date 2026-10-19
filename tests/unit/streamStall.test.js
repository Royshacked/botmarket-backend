import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stallGuard, StreamStalledError } from '../../providers/streamStall.js'
import { streamAnthropicWithTools } from '../../providers/anthropic.provider.js'
import { streamOpenAICompatWithTools } from '../../providers/openaiCompat.provider.js'

// A model stream that stops sending is CUT, not waited on (2026-10-19: an Atlas turn on gpt-6-luna got nothing for
// 53 minutes, until the socket died). The guard aborts the round's request after a quiet spell; the provider throws a
// clear StreamStalledError for it — and still treats the user's Stop as a Stop.

const tick = (ms) => new Promise(r => setTimeout(r, ms))
const fast = (o) => stallGuard({ ...o, firstMs: 40, idleMs: 40 })

/** A stream that yields `first`, then waits — for ever, unless its signal aborts it (as a real SDK stream does). */
function hanging(first, signal) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const c of first) yield c
            await new Promise((_, reject) => {
                const fail = () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }))
                if (signal?.aborted) fail()
                else signal?.addEventListener('abort', fail, { once: true })
            })
        },
    }
}

test('the guard: quiet past the first allowance → aborted, stalled, and says so; data resets it to the idle allowance', async () => {
    const g = stallGuard({ firstMs: 30, idleMs: 60 })
    await tick(50)
    assert.equal(g.stalled, true)
    assert.equal(g.signal.aborted, true)
    assert.ok(g.error instanceof StreamStalledError)
    assert.match(g.error.message, /no data for 0s after the request|no data for \d+s after the request/)

    const h = stallGuard({ firstMs: 30, idleMs: 80 })
    await tick(20); h.touch(); await tick(40)
    assert.equal(h.stalled, false, 'a chunk moved it onto the longer idle allowance')
    h.done(); await tick(60)
    assert.equal(h.stalled, false, 'done() ends the watch')
})

test('the guard: the caller\'s abort passes through — and is not a stall', async () => {
    const ac = new AbortController()
    const g = stallGuard({ signal: ac.signal, firstMs: 1000, idleMs: 1000 })
    ac.abort()
    assert.equal(g.signal.aborted, true)
    assert.equal(g.stalled, false)
    g.done()
})

const chunk = (delta, finish = null) => ({ model: 'openai/gpt-6-luna', choices: [{ delta, finish_reason: finish }] })

test('openai-compat: a stream that goes quiet throws StreamStalledError instead of hanging', async () => {
    const client = { chat: { completions: { create: async (_req, opts) => hanging([chunk({ content: 'Looking at' })], opts?.signal) } } }
    await assert.rejects(
        streamOpenAICompatWithTools({ wire: 'openai/gpt-6-luna', model: 'gpt-6-luna', client, promptOrMessages: 'hi', systemPrompt: 'S', stall: fast }),
        (err) => err instanceof StreamStalledError && /stopped responding/.test(err.message),
    )
})

test('openai-compat: the user\'s Stop still returns what streamed — not a stall error', async () => {
    const ac = new AbortController()
    const client = { chat: { completions: { create: async (_req, opts) => hanging([chunk({ content: 'Looking at' })], opts?.signal) } } }
    const run = streamOpenAICompatWithTools({ wire: 'openai/gpt-6-luna', model: 'gpt-6-luna', client, promptOrMessages: 'hi', systemPrompt: 'S', signal: ac.signal, stall: (o) => stallGuard({ ...o, firstMs: 5000, idleMs: 5000 }) })
    await tick(20); ac.abort()
    assert.equal(await run, 'Looking at')
})

const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking at' } },
]

test('anthropic: a stream that goes quiet throws StreamStalledError — it is not passed off as a finished reply', async () => {
    const client = { messages: { stream: (_req, opts) => hanging(events, opts?.signal) } }
    await assert.rejects(
        streamAnthropicWithTools({ model: 'claude-sonnet-5', promptOrMessages: 'hi', systemPrompt: 'S', client, stall: fast }),
        (err) => err instanceof StreamStalledError,
    )
})

test('anthropic: the user\'s Stop still returns what streamed', async () => {
    const ac = new AbortController()
    const client = { messages: { stream: (_req, opts) => hanging(events, opts?.signal) } }
    const run = streamAnthropicWithTools({ model: 'claude-sonnet-5', promptOrMessages: 'hi', systemPrompt: 'S', client, signal: ac.signal, stall: (o) => stallGuard({ ...o, firstMs: 5000, idleMs: 5000 }) })
    await tick(20); ac.abort()
    assert.equal(await run, 'Looking at')
})
