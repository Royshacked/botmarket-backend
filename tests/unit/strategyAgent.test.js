import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TOOLS, _parseStrategyResponse, _buildTurnContext, _buildMessages } from '../../services/agents/strategy.agent.service.js'
import { ALL_EMIT_TAGS } from '../../services/llmStream.util.js'

// Pythia's agent seams (pure) — the industry desk, rebuilt 2026-10-05. The stream itself is
// contract-tested with the other desks.

// ── the emit tag must be registered or it leaks ──────────────────────────────
test('<industry_view> is in the shared emit-tag registry', () => {
    // Not cosmetic: buildTagCaptures suppresses only registered tags, so an unregistered one streams
    // raw JSON into the user's chat.
    assert.ok(ALL_EMIT_TAGS.includes('industry_view'))
})

// ── the tools ────────────────────────────────────────────────────────────────
test('the desk reads industries, not channels — and consult stays last', () => {
    const names = TOOLS.map(t => t.name)
    for (const n of ['list_industries', 'get_industry_metrics', 'get_industry_companies', 'get_industry_view']) assert.ok(names.includes(n), n)
    for (const gone of ['get_channel_state', 'size_from_channels', 'get_priced_in']) assert.ok(!names.includes(gone), gone)
    assert.equal(names.at(-1), 'consult')
    assert.deepEqual(TOOLS.find(t => t.name === 'get_industry_metrics').input_schema.required, ['industry'])
})

// ── draft extraction ─────────────────────────────────────────────────────────
const BLOCK = (industry, extra = '') => `<industry_view>{"industry":"${industry}","demand":{"grade":"growing","rationale":"r"},`
    + `"economics":{"grade":"good","rationale":"r"},"cycle":{"grade":"peak","rationale":"r"}${extra}}</industry_view>`

test('an answered turn yields the reply and every block, stripped', () => {
    const { reply, views } = _parseStrategyResponse(`Semis are strong.\n${BLOCK('45301020')}\n${BLOCK(' 45301010 ')}`)
    assert.equal(reply, 'Semis are strong.')
    assert.deepEqual(views.map(v => v.industry), ['45301020', '45301010'], 'trimmed')
    assert.equal(views[0].cycle.grade, 'peak')
})

test('a discussion turn emits nothing, and that is normal', () => {
    const { reply, views } = _parseStrategyResponse('Airlines earn below their cost of capital most years.')
    assert.deepEqual(views, [])
    assert.match(reply, /^Airlines/)
})

test('a block with no industry, malformed JSON or an array is dropped, never half-kept', () => {
    assert.deepEqual(_parseStrategyResponse('<industry_view>{"demand":{}}</industry_view>').views, [])
    assert.deepEqual(_parseStrategyResponse('<industry_view>{not json}</industry_view>').views, [])
    assert.deepEqual(_parseStrategyResponse('<industry_view>[1]</industry_view>').views, [])
    assert.deepEqual(_parseStrategyResponse(null).views, [])
})

// ── per-turn context ─────────────────────────────────────────────────────────
test('the turn context names the industry in focus and, on a review, why it is due', () => {
    assert.equal(_buildTurnContext({}), null)
    assert.equal(_buildTurnContext({ industry: '45301020' }), 'IN FOCUS: GICS sub-industry 45301020.')
    assert.match(_buildTurnContext({ industry: '45301020', review_reason: 'early-review trigger: margin_at_range_edge' }),
        /REVIEW, brought forward because: early-review trigger: margin_at_range_edge/)
})

test('a first turn is just the prompt', () => {
    const msgs = _buildMessages({ messages: undefined, userPrompt: 'Review semiconductors' })
    assert.equal(msgs.at(-1).role, 'user')
})
