import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _finalizeToolBlocks, _toToolResultContent, _noteStop, _oneShotRequest, _applyDeltaUsage, _runTool } from '../../providers/anthropic.provider.js'

// Regression: a no-argument tool (get_macro_snapshot) streams an EMPTY input_json_delta, so the
// block's scratch `_json` ends up ''. The old truthiness check left `_json: ''` on the block, and
// echoing it back on the next tool round 400'd the API ("tool_use._json: Extra inputs are not
// permitted"). _finalizeToolBlocks must strip `_json` even when empty.

test('finalizeToolBlocks: empty _json (no-arg tool) → input {} and _json removed', () => {
    const blocks = [{ type: 'tool_use', id: 't1', name: 'get_macro_snapshot', input: {}, _json: '' }]
    _finalizeToolBlocks(blocks)
    assert.deepEqual(blocks[0], { type: 'tool_use', id: 't1', name: 'get_macro_snapshot', input: {} })
    assert.ok(!('_json' in blocks[0]))
})

test('finalizeToolBlocks: populated _json parsed into input, scratch removed', () => {
    const blocks = [{ type: 'tool_use', id: 't2', name: 'get_peers', input: {}, _json: '{"ticker":"AAPL"}' }]
    _finalizeToolBlocks(blocks)
    assert.deepEqual(blocks[0].input, { ticker: 'AAPL' })
    assert.ok(!('_json' in blocks[0]))
})

test('finalizeToolBlocks: malformed _json → input {} (never throws)', () => {
    const blocks = [{ type: 'tool_use', id: 't3', name: 'x', input: {}, _json: '{ not json' }]
    _finalizeToolBlocks(blocks)
    assert.deepEqual(blocks[0].input, {})
    assert.ok(!('_json' in blocks[0]))
})

test('finalizeToolBlocks: leaves text/thinking blocks and sparse entries untouched', () => {
    const blocks = [
        { type: 'text', text: 'hi' },
        undefined,
        { type: 'thinking', thinking: '...', signature: 'sig' },
        { type: 'tool_use', id: 't4', name: 'get_quote', input: {}, _json: '{"ticker":"NVDA"}' },
    ]
    _finalizeToolBlocks(blocks)
    assert.deepEqual(blocks[0], { type: 'text', text: 'hi' })
    assert.equal(blocks[1], undefined)
    assert.deepEqual(blocks[2], { type: 'thinking', thinking: '...', signature: 'sig' })
    assert.deepEqual(blocks[3].input, { ticker: 'NVDA' })
})

test('finalizeToolBlocks: null / empty input safe', () => {
    assert.doesNotThrow(() => _finalizeToolBlocks(null))
    assert.doesNotThrow(() => _finalizeToolBlocks([]))
})

// ─── _toToolResultContent ─────────────────────────────────────────────────────
// Regression: a handler returning a PLAIN OBJECT fell through to `String(ret)` and reached the
// model as "[object Object]" — a successful tool call carrying no information. get_trading_context
// and check_broker_symbol both did this, so no agent could read accounts, balances, open positions
// or live P&L, and Axl answered "I don't know" to a P&L question the app could answer exactly.
// Tools are expected to return model-ready TEXT, but the boundary must degrade to readable JSON.

test('toToolResultContent: a plain object is serialized, NEVER "[object Object]"', () => {
    const out = _toToolResultContent({ accounts: [{ id: 'a1', positions: [{ symbol: 'NVDA', pnl: -1925.55 }] }] })
    assert.equal(typeof out, 'string')
    assert.doesNotMatch(out, /\[object Object\]/)
    // The numbers a P&L answer needs actually survive.
    assert.match(out, /NVDA/)
    assert.match(out, /-1925\.55/)
})

test('toToolResultContent: strings pass through untouched (the normal path)', () => {
    assert.equal(_toToolResultContent('Price : $195.04'), 'Price : $195.04')
})

test('toToolResultContent: content blocks still pass through as blocks', () => {
    const arr = [{ type: 'image', source: {} }]
    assert.equal(_toToolResultContent(arr), arr)
    assert.deepEqual(_toToolResultContent({ type: 'text', text: 'hi' }), [{ type: 'text', text: 'hi' }])
})

test('toToolResultContent: null/undefined → empty string', () => {
    assert.equal(_toToolResultContent(null), '')
    assert.equal(_toToolResultContent(undefined), '')
})

test('toToolResultContent: a circular object degrades instead of throwing the turn away', () => {
    const circular = { a: 1 }
    circular.self = circular
    assert.doesNotThrow(() => _toToolResultContent(circular))
})

// ── a turn that stopped short SAYS SO ─────────────────────────────────────────
// max_tokens and refusal used to return through the same line as end_turn, and the provider had no
// logger at all, so a truncated or refused desk reply left no trace anywhere.
test('_noteStop: max_tokens and refusal are logged with the model; an ordinary end is silent', () => {
    assert.match(_noteStop('max_tokens', null, 'claude-sonnet-4-6', 812), /cut by max_tokens on claude-sonnet-4-6 after 812 chars/)
    assert.match(_noteStop('refusal', { category: 'cyber', explanation: 'no' }, 'claude-opus-5', 0), /claude-opus-5 REFUSED \(cyber\): no/)
    assert.match(_noteStop('refusal', null, 'claude-opus-5', 0), /no category/)
    assert.equal(_noteStop('end_turn', null, 'm', 10), null)
    assert.equal(_noteStop('stop_sequence', null, 'm', 10), null)
    assert.equal(_noteStop(null, null, 'm', 10), null)
    assert.match(_noteStop('something_new', null, 'm', 10), /unexpected stop_reason something_new/)
})

// ── the one-shot read follows the loop's thinking rule ────────────────────────
// A model in THINKS_BY_DEFAULT reasons whether or not it is asked, and those tokens count against
// max_tokens — so a 64-token YES/NO on such a model would spend its budget on hidden reasoning and
// answer ''. monitor.claude aliases its vision model to llmModels.DEFAULT_MODEL; the day that
// default moves to a reasoning model, this is what keeps the chart verdicts readable (CR on §8).
test('_oneShotRequest: a reasoning model gets the thinking block and the loop\'s ceiling; a plain one gets neither', () => {
    const think = _oneShotRequest({ model: 'claude-sonnet-5', systemPrompt: 's', content: 'q', maxTokens: 64 })
    assert.equal(think.thinking?.type, 'adaptive')
    assert.equal(think.output_config?.effort, 'low', 'floored, not left at the model\'s own high')
    assert.equal(think.max_tokens, 16000, 'the loop\'s THINKING_MAX_TOKENS, not the caller\'s 64')

    const plain = _oneShotRequest({ model: 'claude-haiku-4-5-20251001', systemPrompt: 's', content: 'q', maxTokens: 64 })
    assert.equal(plain.thinking, undefined)
    assert.equal(plain.output_config, undefined)
    assert.equal(plain.max_tokens, 64)
    assert.deepEqual(plain.messages, [{ role: 'user', content: 'q' }])
})

// ─── the usage the books are handed ───────────────────────────────────────────
// Two things arrive only on the closing message_delta: the final output count and the server-tool
// counters. The second was dropped on the floor, so a desk that searched on every turn billed
// exactly like one that never did ($10 per 1,000 searches, off the token columns entirely).

test('applyDeltaUsage: the closing delta supplies output_tokens and the search counter', () => {
    const turn = { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    _applyDeltaUsage(turn, { output_tokens: 42, server_tool_use: { web_search_requests: 2 } })
    assert.equal(turn.output_tokens, 42)
    assert.deepEqual(turn.server_tool_use, { web_search_requests: 2 })
})

test('applyDeltaUsage: a delta without the counter leaves none behind, and a missing delta is a no-op', () => {
    const turn = { input_tokens: 1, output_tokens: 0 }
    _applyDeltaUsage(turn, { output_tokens: 7 })
    assert.equal(turn.output_tokens, 7)
    assert.ok(!('server_tool_use' in turn))
    assert.equal(_applyDeltaUsage(turn, undefined), turn)
    assert.equal(_applyDeltaUsage(null, { output_tokens: 1 }), null)
})

// ─── the context a handler is handed ──────────────────────────────────────────
// A tool that makes its own model call (a structure-vision read) can only book it through the
// turn's hook, and the handler is built long before any turn exists — so the loop passes the hook
// with every call. A handler that ignores its second argument is unaffected.

test('runTool: the handler receives the turn context as its second argument', async () => {
    const seen = []
    const handlers = { get_orderblocks: async (input, ctx) => { seen.push([input, ctx]); return 'ok' } }
    const onUsage = () => {}
    const res = await _runTool(handlers, { type: 'tool_use', id: 't9', name: 'get_orderblocks', input: { ticker: 'AAPL' } }, { onUsage })
    assert.equal(res.content, 'ok')
    assert.equal(res.tool_use_id, 't9')
    assert.deepEqual(seen[0][0], { ticker: 'AAPL' })
    assert.equal(seen[0][1].onUsage, onUsage, 'the very hook, not a copy')
})

test('runTool: a one-argument handler still runs, and a missing handler is an error result', async () => {
    const res = await _runTool({ get_quote: async ({ ticker }) => `q:${ticker}` }, { id: 't1', name: 'get_quote', input: { ticker: 'NVDA' } })
    assert.equal(res.content, 'q:NVDA')
    const miss = await _runTool({}, { id: 't2', name: 'nope', input: {} })
    assert.equal(miss.is_error, true)
})
