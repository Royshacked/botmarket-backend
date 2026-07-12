import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KAIROS_TOOLS, buildKairosToolHandlers } from '../../services/kairos.tools.js'

// web_search is a provider-native tool (type web_search_20250305) — the LLM runtime
// executes it, so it has no local handler. Every OTHER tool must have one.
const NATIVE_TOOLS = new Set(['web_search'])

// ── get_correlations (added for the Phase 2 regime & correlation read) ──────────
test('get_correlations tool is registered with a tickers-array schema', () => {
    const tool = KAIROS_TOOLS.find(t => t.name === 'get_correlations')
    assert.ok(tool, 'get_correlations must be in KAIROS_TOOLS')
    assert.equal(tool.input_schema.properties.tickers.type, 'array')
    assert.deepEqual(tool.input_schema.required, ['tickers'])
})

test('get_correlations has a callable handler', () => {
    const handlers = buildKairosToolHandlers(null)
    assert.equal(typeof handlers.get_correlations, 'function')
})

// ── drift guard: schemas and handlers stay in sync ──────────────────────────────
test('every non-native tool has exactly one handler, and vice versa', () => {
    const handlers   = buildKairosToolHandlers(null)
    const toolNames  = KAIROS_TOOLS.map(t => t.name).filter(n => !NATIVE_TOOLS.has(n))
    const handlerKeys = Object.keys(handlers)

    for (const name of toolNames) {
        assert.equal(typeof handlers[name], 'function', `missing handler for tool "${name}"`)
    }
    for (const key of handlerKeys) {
        assert.ok(
            KAIROS_TOOLS.some(t => t.name === key),
            `handler "${key}" has no matching tool schema`,
        )
    }
})
