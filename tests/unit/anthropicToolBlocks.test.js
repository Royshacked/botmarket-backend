import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _finalizeToolBlocks, _toToolResultContent } from '../../providers/anthropic.provider.js'

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
