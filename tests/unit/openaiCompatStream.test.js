import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    toSystemText, toOpenAIMessages, foldToolCallDeltas, finishToolCalls, streamOpenAICompatWithTools,
} from '../../providers/openaiCompat.provider.js'
import { isAdminOnlyModel, resolveStreamFn, DEFAULT_MODEL } from '../../services/llmModels.js'
import { resolveAgentStream } from '../../services/agentUtils.js'
import { buildTagCaptures } from '../../services/llmStream.util.js'

// The desks' streaming loop on a non-Anthropic candidate (providers/openaiCompat.provider.js
// streamOpenAICompatWithTools) — driven against a fake chat.completions stream — plus the
// admin gate on the chat registry (llmModels adminOnly → agentUtils.resolveAgentStream).

test('stream: system blocks flatten to one string; history keeps text and carries images as data URLs', () => {
    assert.equal(toSystemText('plain'), 'plain')
    assert.equal(toSystemText([{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }]), 'A\n\nB')
    const out = toOpenAIMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
    ])
    assert.deepEqual(out[0], { role: 'user', content: 'hi' })
    assert.deepEqual(out[1], { role: 'assistant', content: 'hello' })
    assert.equal(out[2].content[1].image_url.url, 'data:image/png;base64,AAA')
    assert.deepEqual(toOpenAIMessages('one'), [{ role: 'user', content: 'one' }])
})

test('stream: tool-call deltas fold by index and finish into tool_calls + tool_use blocks', () => {
    const acc = {}
    foldToolCallDeltas(acc, [{ index: 0, id: 'c1', function: { name: 'get_chart', arguments: '{"tick' } }])
    foldToolCallDeltas(acc, [{ index: 0, function: { arguments: 'er":"NVDA"}' } }, { index: 1, id: 'c2', function: { name: 'get_quote', arguments: '' } }])
    foldToolCallDeltas(acc, [{ index: 1, function: { arguments: '{"ticker":"SMH"}' } }])
    const { toolCalls, uses } = finishToolCalls(acc)
    assert.equal(toolCalls.length, 2)
    assert.equal(toolCalls[0].function.arguments, '{"ticker":"NVDA"}')
    assert.deepEqual(uses.map(u => [u.id, u.name, u.input]), [['c1', 'get_chart', { ticker: 'NVDA' }], ['c2', 'get_quote', { ticker: 'SMH' }]])
})

// A fake streaming client: each scripted turn is a list of chunks.
function fakeStreamClient(turns) {
    const requests = []
    return {
        requests,
        chat: { completions: { create: async (req) => {
            requests.push(req)
            const chunks = turns[requests.length - 1]
            return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
        } } },
    }
}
const chunk = (delta, finish = null, extra = {}) => ({ model: 'openai/gpt-5.6-luna', choices: [{ delta, finish_reason: finish }], ...extra })

test('stream: text streams through the tag suppressor, a tool round runs the handler, usage books per round', async () => {
    const client = fakeStreamClient([
        [
            chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_chart', arguments: '' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ticker":"NVDA"}' } }] }, 'tool_calls'),
            { model: 'openai/gpt-5.6-luna', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
        ],
        [
            chunk({ reasoning: 'looking at it' }),
            chunk({ content: 'Reclaim held. <state>{"phase":2}</state> Done.' }, 'stop'),
            { model: 'openai/gpt-5.6-luna', choices: [], usage: { prompt_tokens: 900, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } } },
        ],
    ])
    const tokens = [], starts = [], reasoning = [], booked = [], captured = []
    const text = await streamOpenAICompatWithTools({
        wire: 'openai/gpt-5.6-luna', model: 'gpt-5.6-luna', client,
        promptOrMessages: [{ role: 'user', content: 'read NVDA' }],
        systemPrompt: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
        tools: [
            { name: 'get_chart', description: 'chart', input_schema: { type: 'object', properties: { ticker: { type: 'string' } } } },
            { type: 'web_search_20260209', name: 'web_search' },
        ],
        toolHandlers: { get_chart: async ({ ticker }) => [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNG' } }, { type: 'text', text: `${ticker} chart` }] },
        onToken: t => tokens.push(t), onToolStart: n => starts.push(n), onReasoning: r => reasoning.push(r),
        onUsage: (u, m) => booked.push([u.input_tokens, u.cache_read_input_tokens, m]),
        tagCaptures: buildTagCaptures({ state: (s) => captured.push(s) }),
    })
    assert.equal(text, 'Reclaim held. <state>{"phase":2}</state> Done.', 'the raw text is returned in full')
    assert.equal(tokens.join(''), 'Reclaim held.  Done.', 'the emit tag never reaches the UI')
    assert.deepEqual(captured, ['{"phase":2}'])
    assert.deepEqual(starts, ['get_chart'])
    assert.deepEqual(reasoning, ['looking at it'])
    assert.deepEqual(booked, [[100, 0, 'gpt-5.6-luna'], [900, 100, 'gpt-5.6-luna']])

    const r1 = client.requests[0]
    assert.equal(r1.model, 'openai/gpt-5.6-luna')
    assert.equal(r1.stream, true)
    assert.equal(r1.messages[0].role, 'system'); assert.equal(r1.messages[0].content, 'SYS')
    assert.equal(r1.tools.length, 1, 'web_search is not a function tool')
    assert.deepEqual(r1.plugins, [{ id: 'web', max_results: 5 }], 'OpenRouter web plugin stands in for web_search')
    const r2 = client.requests[1]
    assert.deepEqual(r2.messages.slice(2).map(m => m.role), ['assistant', 'tool', 'user'])
    assert.equal(r2.messages[2].tool_calls[0].function.arguments, '{"ticker":"NVDA"}')
    assert.match(r2.messages[3].content, /NVDA chart/)
    assert.equal(r2.messages[4].content[1].image_url.url, 'data:image/png;base64,PNG')
})

test('stream: no web plugin off OpenRouter, and a substituted model throws', async () => {
    const client = fakeStreamClient([[chunk({ content: 'ok' }, 'stop')]])
    await streamOpenAICompatWithTools({ endpoint: 'mistral', wire: 'openai/gpt-5.6-luna', model: 'm', client, promptOrMessages: 'hi', systemPrompt: 'S',
        tools: [{ type: 'web_search_20260209', name: 'web_search' }] })
    assert.equal(client.requests[0].plugins, undefined)
    assert.equal(client.requests[0].tools, undefined)

    const bad = fakeStreamClient([[{ model: 'openai/gpt-5.6-terra', choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]])
    await assert.rejects(streamOpenAICompatWithTools({ wire: 'openai/gpt-5.6-luna', model: 'm', client: bad, promptOrMessages: 'hi', systemPrompt: 'S' }), /served "openai\/gpt-5.6-terra"/)
})

test('stream: an aborted signal ends the loop with the text so far, no throw', async () => {
    const ac = new AbortController()
    const client = { chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() {
        yield chunk({ content: 'part' }); ac.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e
    } }) } } }
    const text = await streamOpenAICompatWithTools({ wire: 'w', model: 'm', client, promptOrMessages: 'hi', systemPrompt: 'S', signal: ac.signal })
    assert.equal(text, 'part')
})

// ─── The chat registry gate ───────────────────────────────────────────────────

test('registry: the candidates are registered admin-only; the Anthropic entries are not', () => {
    for (const id of ['gpt-5.6-luna', 'qwen3.7-plus', 'mistral-medium-3.5', 'qwen3.7-flash', 'deepseek-v4.1-flash', 'gemini-3.8-flash']) {
        assert.equal(isAdminOnlyModel(id), true, id)
        assert.equal(resolveStreamFn(id).provider, 'openai-compat', id)
    }
    assert.equal(isAdminOnlyModel('claude-sonnet-5'), false)
    assert.equal(isAdminOnlyModel('nope'), false)
    const r = resolveStreamFn('gpt-5.6-luna')
    assert.equal(r.provider, 'openai-compat'); assert.equal(typeof r.streamFn, 'function')
})

test('resolveAgentStream: everyone runs the house model, unasked — the request is not read', async () => {
    const noIO = [async () => null, async () => null, async () => {}]
    const HOUSE = async () => ({ chatModel: 'gpt-5.6-luna' })
    // Whatever the client asked — a candidate, a plain pick, nothing — the house's.
    for (const asked of ['qwen3.7-plus', 'claude-opus-5', undefined]) {
        const turn = await resolveAgentStream(asked, 'u2', 'mentorAgent', ...noIO, HOUSE)
        assert.equal(turn.model, 'gpt-5.6-luna', String(asked)); assert.equal(turn.provider, 'openai-compat')
    }
    // No user (a house run) → the house model too.
    const house = await resolveAgentStream(undefined, null, 'marketBrief', ...noIO, HOUSE)
    assert.equal(house.model, 'gpt-5.6-luna')
    // No house choice, or an unreadable one, is the default.
    assert.equal((await resolveAgentStream('claude-opus-5', 'u2', 'mentorAgent', ...noIO, async () => ({ chatModel: null }))).model, DEFAULT_MODEL)
    assert.equal((await resolveAgentStream('claude-opus-5', 'u2', 'mentorAgent', ...noIO, async () => { throw new Error('db') })).model, DEFAULT_MODEL)
    // A house id that left the registry falls to the default, not to a provider error.
    assert.equal((await resolveAgentStream(undefined, 'u2', 'mentorAgent', ...noIO, async () => ({ chatModel: 'gone' }))).model, DEFAULT_MODEL)
})
