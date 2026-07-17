import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _finalizeToolBlocks } from '../../providers/anthropic.provider.js'

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
