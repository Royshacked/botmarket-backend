import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    toOpenAITools, toToolUses, toToolMessages, toAnthropicUsage, toStopReason, servedModelMatches, runOpenAICompatRead,
} from '../../providers/openaiCompat.provider.js'
import { TALOS_MODELS, ALLOWED_MODELS, ASSESS_MODEL, resolveTalosModel, assessRouting, talosModel } from '../../monitoring/assess.shared.js'
import { makeAssessToolRunner } from '../../monitoring/assessTools.js'

// The OpenAI-compatible read loop (providers/openaiCompat.provider.js) — every translation is pure
// and pinned here, and the loop is driven end to end against a fake client. Plus the Talos model
// registry and the admin gate in assessRouting (monitoring/assess.shared.js).

const TOOLS = [
    { name: 'get_chart',   description: 'Render a chart', input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] } },
    { name: 'get_candles', description: 'Rows',           input_schema: { type: 'object', properties: { ticker: { type: 'string' } } } },
    { type: 'web_search_20260209', name: 'web_search' },
]

test('openaiCompat: tool schemas translate; the server tool is dropped', () => {
    const out = toOpenAITools(TOOLS)
    assert.equal(out.length, 2)
    assert.deepEqual(out[0], { type: 'function', function: { name: 'get_chart', description: 'Render a chart', parameters: TOOLS[0].input_schema } })
    assert.ok(!out.some(t => t.function.name === 'web_search'))
    assert.deepEqual(toOpenAITools(undefined), [])
})

test('openaiCompat: tool_calls become tool_use blocks the shared runner dispatches; bad JSON is {}', () => {
    const uses = toToolUses({ tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'get_chart', arguments: '{"ticker":"NVDA","timeframe":"15min"}' } },
        { id: 'c2', type: 'function', function: { name: 'get_candles', arguments: '{not json' } },
        { id: 'c3', type: 'custom',   function: { name: 'x' } },
    ] })
    assert.deepEqual(uses, [
        { type: 'tool_use', id: 'c1', name: 'get_chart',   input: { ticker: 'NVDA', timeframe: '15min' } },
        { type: 'tool_use', id: 'c2', name: 'get_candles', input: {} },
    ])
    assert.deepEqual(toToolUses({ content: 'plain' }), [])
})

test('openaiCompat: text results become tool messages; an image rides in ONE user message after them', () => {
    const msgs = toToolMessages([
        { type: 'tool_result', tool_use_id: 'c1', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'NVDA 15min chart (app render).' },
        ] },
        { type: 'tool_result', tool_use_id: 'c2', content: 'rows...' },
        { type: 'tool_result', tool_use_id: 'c3', is_error: true, content: 'SMH is not in this plan\'s scope.' },
    ])
    assert.equal(msgs.length, 4)
    assert.equal(msgs[0].role, 'tool'); assert.equal(msgs[0].tool_call_id, 'c1')
    assert.match(msgs[0].content, /NVDA 15min chart/); assert.match(msgs[0].content, /1 image\(s\).*follow/)
    assert.deepEqual(msgs[1], { role: 'tool', tool_call_id: 'c2', content: 'rows...' })
    assert.deepEqual(msgs[2], { role: 'tool', tool_call_id: 'c3', content: 'SMH is not in this plan\'s scope.' })
    assert.equal(msgs[3].role, 'user')
    assert.equal(msgs[3].content[1].type, 'image_url')
    assert.equal(msgs[3].content[1].image_url.url, 'data:image/png;base64,AAAA')
    // No image → no trailing user message.
    assert.equal(toToolMessages([{ type: 'tool_result', tool_use_id: 'c2', content: 'rows' }]).length, 1)
})

test('openaiCompat: usage and finish_reason translate to the shapes the ledger and the loop use', () => {
    assert.deepEqual(toAnthropicUsage({ prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1000 } }),
        { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000 })
    assert.deepEqual(toAnthropicUsage({ prompt_tokens: 5, completion_tokens: 1 }), { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0 })
    assert.equal(toAnthropicUsage(undefined), null)
    assert.equal(toStopReason('tool_calls', true), 'tool_use')
    assert.equal(toStopReason('stop', true), 'tool_use')
    assert.equal(toStopReason('length', false), 'max_tokens')
    assert.equal(toStopReason('stop', false), 'end_turn')
    assert.equal(servedModelMatches('openai/gpt-5.6-luna', 'openai/gpt-5.6-luna'), true)
    assert.equal(servedModelMatches('gpt-5.6-luna-2026-07', 'openai/gpt-5.6-luna'), true)
    assert.equal(servedModelMatches('openai/gpt-5.6-terra', 'openai/gpt-5.6-luna'), false)
    assert.equal(servedModelMatches(undefined, 'x/y'), true)
})

// A fake chat.completions client: round 1 asks for a chart, round 2 answers.
function fakeClient(script) {
    const requests = []
    return {
        requests,
        chat: { completions: { create: async (req) => { requests.push(req); return script[requests.length - 1] } } },
    }
}

test('openaiCompat: the loop runs a tool round through the shared runner and returns the final text', async () => {
    const client = fakeClient([
        { model: 'openai/gpt-5.6-luna', usage: { prompt_tokens: 100, completion_tokens: 10 },
            choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_chart', arguments: '{"ticker":"NVDA","timeframe":"15min"}' } }] } }] },
        { model: 'openai/gpt-5.6-luna', usage: { prompt_tokens: 900, completion_tokens: 50 },
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"verdict":"wait","read":"nothing yet"}' } }] },
    ])
    const calls = []
    const runToolUses = makeAssessToolRunner({
        symbols: ['NVDA'], onCall: n => calls.push(n),
        handlers: { get_chart: async () => [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNG' } }, { type: 'text', text: 'chart' }] },
    })
    const booked = []
    const trace  = { calls, usage: [] }
    const out = await runOpenAICompatRead({
        wire: 'openai/gpt-5.6-luna', model: 'gpt-5.6-luna', systemText: 'SYS', userText: 'USER', tools: TOOLS,
        runToolUses, onUsage: (u, m) => booked.push([u.input_tokens, m]), trace, client,
    })
    assert.deepEqual(out, { text: '{"verdict":"wait","read":"nothing yet"}', stopReason: 'end_turn' })
    assert.deepEqual(calls, ['get_chart'])
    assert.deepEqual(booked, [[100, 'gpt-5.6-luna'], [900, 'gpt-5.6-luna']])
    assert.equal(trace.format, 'openai')
    assert.equal(trace.rounds, 2)
    assert.equal(trace.stopReason, 'end_turn')
    // system, user, assistant(tool_calls), tool, user(image), assistant(final)
    assert.deepEqual(trace.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'user', 'assistant'])
    assert.equal(client.requests[0].model, 'openai/gpt-5.6-luna')
    assert.equal(client.requests[0].tools.length, 2)
    assert.equal(client.requests[1].messages[3].tool_call_id, 'c1')
})

test('openaiCompat: a substituted model is an IO failure, not a silently different candidate', async () => {
    const client = fakeClient([{ model: 'openai/gpt-5.6-terra', usage: {}, choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }])
    await assert.rejects(
        runOpenAICompatRead({ wire: 'openai/gpt-5.6-luna', model: 'gpt-5.6-luna', systemText: 'S', userText: 'U', tools: [], runToolUses: async () => [], client }),
        /served "openai\/gpt-5.6-terra"/,
    )
})

test('openaiCompat: the runaway backstop abandons a model that never stops asking', async () => {
    const turn = { model: 'm', usage: {}, choices: [{ finish_reason: 'tool_calls', message: { content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_candles', arguments: '{"ticker":"NVDA"}' } }] } }] }
    const client = fakeClient(Array.from({ length: 10 }, () => turn))
    const out = await runOpenAICompatRead({
        wire: 'm', model: 'm', systemText: 'S', userText: 'U', tools: TOOLS, client, runawayRounds: 2,
        runToolUses: async (uses) => uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: 'rows' })),
    })
    assert.deepEqual(out, { runaway: true })
    assert.equal(client.requests.length, 3)
})

// ─── The registry and the gate ────────────────────────────────────────────────

test('talos models: every entry has a provider and a wire id; the default is Anthropic and open to all', () => {
    for (const [id, m] of Object.entries(TALOS_MODELS)) {
        assert.ok(['anthropic', 'openai-compat'].includes(m.provider), id)
        if (m.provider === 'openai-compat') assert.ok(['openrouter', 'mistral'].includes(m.endpoint), id)
        assert.ok(m.wire && m.label, id)
        assert.ok(ALLOWED_MODELS.has(id))
    }
    assert.equal(TALOS_MODELS[ASSESS_MODEL].provider, 'anthropic')
    assert.equal(TALOS_MODELS[ASSESS_MODEL].adminOnly, undefined)
    assert.equal(talosModel('nope').wire, ASSESS_MODEL)
})

test('talos models: a candidate is honoured for an admin and routed to the default for anyone else', () => {
    assert.equal(resolveTalosModel('gpt-5.6-luna', true),  'gpt-5.6-luna')
    assert.equal(resolveTalosModel('gpt-5.6-luna', false), ASSESS_MODEL)
    assert.equal(resolveTalosModel('claude-sonnet-5', false), ASSESS_MODEL)
    assert.equal(resolveTalosModel('claude-opus-4-8', false), 'claude-opus-4-8')
    assert.equal(resolveTalosModel('gpt-4o', true), ASSESS_MODEL)
    assert.equal(resolveTalosModel(undefined, true), ASSESS_MODEL)
})

test('assessRouting: reads the document once, applies the gate, caps the effort, and never throws', async () => {
    const admin  = async () => ({ id: 'u1', role: 'admin', preferences: { hermesModel: 'mistral-medium-3.5', hermesReasoning: 'high' } })
    const trader = async () => ({ id: 'u2', role: 'user',  preferences: { hermesModel: 'mistral-medium-3.5' } })
    const legacy = async () => ({ id: 'u3', isAdmin: true, preferences: { hermesModel: 'qwen3.7-plus' } })
    const broken = async () => { throw new Error('db down') }

    const a = await assessRouting('u1', admin)
    assert.equal(a.model, 'mistral-medium-3.5'); assert.equal(a.provider, 'openai-compat'); assert.equal(a.endpoint, 'mistral'); assert.equal(a.wire, 'mistral-medium-2604'); assert.equal(a.reasoningEffort, 'low')
    const t = await assessRouting('u2', trader)
    assert.equal(t.model, ASSESS_MODEL); assert.equal(t.provider, 'anthropic'); assert.equal(t.wire, ASSESS_MODEL)
    assert.equal((await assessRouting('u3', legacy)).model, 'qwen3.7-plus')
    const b = await assessRouting('u4', broken)
    assert.equal(b.model, ASSESS_MODEL); assert.equal(b.provider, 'anthropic'); assert.equal(b.reasoningEffort, 'off')
    assert.equal((await assessRouting(null)).provider, 'anthropic')
})
