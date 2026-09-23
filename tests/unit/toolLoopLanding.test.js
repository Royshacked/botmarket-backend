import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamAnthropicWithTools } from '../../providers/anthropic.provider.js'
import { streamOpenAICompatWithTools } from '../../providers/openaiCompat.provider.js'
import { TOOL_BUDGET_LANDING } from '../../services/llmStream.util.js'

// The tool loop's LANDING ROUND, on both providers. A turn that is still calling tools when the
// continuation cap arrives used to throw — and Mentor's "go all the way" build, which climbs eight
// rungs of reads in one turn, walked straight into that cliff on an imperfectly batched run: ten
// tool rounds streamed to the user, then an error and no worksheet. The model cannot count rounds
// it cannot see, so the fix is the loop's: the last round runs with tools OFF and a note on the
// final tool results saying so, and the turn lands as text with what it has.

// ─── Anthropic ────────────────────────────────────────────────────────────────

const TOOL = { name: 'get_quote', description: 'q', input_schema: { type: 'object', properties: { ticker: { type: 'string' } } } }

const toolRound = (id) => [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'get_quote', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ticker":"NVDA"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
]
const textRound = (text) => [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
]

/** A scripted Anthropic client: each round yields its event list and records the request. The loop
 *  MUTATES one messages array across rounds, so each request is snapshotted at the moment it is made. */
function fakeAnthropic(rounds) {
    const requests = []
    return {
        requests,
        messages: { stream: (req) => {
            requests.push(structuredClone(req))
            const events = rounds[requests.length - 1] ?? textRound('')
            return { async *[Symbol.asyncIterator]() { for (const e of events) yield e } }
        } },
    }
}

test('anthropic: the last allowed round runs with tools off and the model is told, so the turn lands as text', async () => {
    const client = fakeAnthropic([toolRound('t1'), toolRound('t2'), textRound('NVDA 180.2 — continuing next turn. <setup>{"asset":"NVDA"}</setup>')])
    const text = await streamAnthropicWithTools({
        model: 'claude-sonnet-5', promptOrMessages: 'go all the way NVDA', systemPrompt: 'S',
        tools: [TOOL], toolHandlers: { get_quote: async () => 'NVDA 180.2' },
        maxContinuations: 3, client,
    })
    assert.match(text, /continuing next turn/, 'the landing round\'s text is what the turn returns — nothing thrown')

    const [r1, r2, r3] = client.requests
    assert.equal(r1.tool_choice, undefined, 'ordinary rounds leave tool choice to the model')
    assert.equal(r2.tool_choice, undefined)
    assert.deepEqual(r3.tool_choice, { type: 'none' }, 'the landing round forbids tool use')
    assert.deepEqual(r3.tools, r1.tools, 'the tools array itself is unchanged — the cache prefix is not disturbed')

    // The note rides the LAST tool results the model reads, not an earlier round's.
    const lastUser = r3.messages[r3.messages.length - 1]
    assert.equal(lastUser.role, 'user')
    assert.equal(lastUser.content[0].type, 'tool_result')
    assert.deepEqual(lastUser.content[lastUser.content.length - 1], { type: 'text', text: TOOL_BUDGET_LANDING })
    const earlierUser = r2.messages[r2.messages.length - 1]
    assert.ok(!earlierUser.content.some(b => b.type === 'text' && b.text === TOOL_BUDGET_LANDING), 'round 1\'s results carry no note')
})

test('anthropic: a turn that ends inside the budget never sees the note or the tool ban', async () => {
    const client = fakeAnthropic([toolRound('t1'), textRound('done')])
    const text = await streamAnthropicWithTools({
        model: 'claude-sonnet-5', promptOrMessages: 'hi', systemPrompt: 'S',
        tools: [TOOL], toolHandlers: { get_quote: async () => 'q' },
        maxContinuations: 10, client,
    })
    assert.equal(text, 'done')
    for (const r of client.requests) assert.equal(r.tool_choice, undefined)
    assert.ok(!JSON.stringify(client.requests).includes(TOOL_BUDGET_LANDING))
})

test('anthropic: no tools declared → no tool_choice on the last round either (the API rejects one without tools)', async () => {
    const client = fakeAnthropic([textRound('plain')])
    await streamAnthropicWithTools({ model: 'claude-sonnet-5', promptOrMessages: 'hi', systemPrompt: 'S', tools: [], maxContinuations: 1, client })
    assert.equal(client.requests[0].tool_choice, undefined)
})

test('anthropic: the throw is still the backstop if the landing round somehow returns a tool call', async () => {
    const client = fakeAnthropic([toolRound('t1'), toolRound('t2')])
    await assert.rejects(
        streamAnthropicWithTools({ model: 'claude-sonnet-5', promptOrMessages: 'hi', systemPrompt: 'S', tools: [TOOL], toolHandlers: { get_quote: async () => 'q' }, maxContinuations: 2, client }),
        /exceeded maxContinuations \(2\)/)
})

// ─── OpenAI-compat ────────────────────────────────────────────────────────────

function fakeOpenAI(turns) {
    const requests = []
    return {
        requests,
        chat: { completions: { create: async (req) => {
            requests.push(structuredClone(req))
            const chunks = turns[requests.length - 1]
            return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
        } } },
    }
}
const chunk = (delta, finish = null) => ({ model: 'openai/gpt-6-luna', choices: [{ delta, finish_reason: finish }] })
const oaToolRound = (id) => [
    chunk({ tool_calls: [{ index: 0, id, function: { name: 'get_quote', arguments: '{"ticker":"NVDA"}' } }] }, 'tool_calls'),
]

test('openai-compat: same landing — tool_choice none on the last round, the note as a user message before it', async () => {
    const client = fakeOpenAI([oaToolRound('c1'), oaToolRound('c2'), [chunk({ content: 'landing text' }, 'stop')]])
    const text = await streamOpenAICompatWithTools({
        wire: 'openai/gpt-6-luna', model: 'gpt-6-luna', client,
        promptOrMessages: 'go all the way NVDA', systemPrompt: 'S',
        tools: [TOOL], toolHandlers: { get_quote: async () => 'NVDA 180.2' },
        maxContinuations: 3,
    })
    assert.equal(text, 'landing text')
    const [r1, r2, r3] = client.requests
    assert.equal(r1.tool_choice, 'auto')
    assert.equal(r2.tool_choice, 'auto')
    assert.equal(r3.tool_choice, 'none')
    const last = r3.messages[r3.messages.length - 1]
    assert.deepEqual(last, { role: 'user', content: TOOL_BUDGET_LANDING })
    assert.equal(r3.messages[r3.messages.length - 2].role, 'tool', 'the note follows the final tool results')
    assert.ok(!r2.messages.some(m => m.content === TOOL_BUDGET_LANDING), 'not before the last round')
})
