import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _finalizeServerTools } from '../../providers/anthropic.provider.js'
import { webSearchTypeFor } from '../../services/llmModels.js'

// The web_search server tool is finalized against the request's MODEL, in the provider — the one
// place that knows both the tool array and the model. The registry emits the 2026-02-09 variant as
// a declared base (it is built once, model-blind); the provider downgrades it for a model that only
// takes the basic variant (Haiku, the spend-degrade target) and caps max_uses. A blind version bump
// would have 400'd a Haiku turn that offered web_search.

test('webSearchTypeFor: the modern set gets 2026-02-09, Haiku and unknowns get the basic variant', () => {
    for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6'])
        assert.equal(webSearchTypeFor(m), 'web_search_20260209', m)
    assert.equal(webSearchTypeFor('claude-haiku-4-5-20251001'), 'web_search_20250305')
    assert.equal(webSearchTypeFor('something-unreleased'), 'web_search_20250305', 'unknown → basic, which is accepted everywhere')
})

test('the finalizer downgrades web_search for Haiku and caps max_uses', () => {
    const tools = [{ type: 'web_search_20260209', name: 'web_search' }, { name: 'get_candles', input_schema: {} }]
    const forSonnet = _finalizeServerTools(tools, 'claude-sonnet-4-6')
    assert.deepEqual(forSonnet[0], { type: 'web_search_20260209', name: 'web_search', max_uses: 5 })
    const forHaiku = _finalizeServerTools(tools, 'claude-haiku-4-5-20251001')
    assert.deepEqual(forHaiku[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 5 })
    // the local tool is untouched
    assert.deepEqual(forHaiku[1], { name: 'get_candles', input_schema: {} })
})

test('an array with no server tool is returned unchanged — the cache prefix is not disturbed', () => {
    const tools = [{ name: 'get_candles', input_schema: {} }]
    assert.equal(_finalizeServerTools(tools, 'claude-sonnet-4-6'), tools)
    assert.equal(_finalizeServerTools([], 'claude-sonnet-4-6').length, 0)
    assert.equal(_finalizeServerTools(undefined, 'claude-sonnet-4-6'), undefined)
})
