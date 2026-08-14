import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedModel } from '../../services/llmModels.js'
import { _thinkingConfig } from '../../providers/anthropic.provider.js'
import { calcCost } from '../../services/tokenUsage.service.js'

// These lived in modelRouter.test.js. The router is gone — the model is the user's own pick now,
// with no per-turn routing — but pricing and the thinking config are the provider's, not the
// router's, and they are what the whole cache/effort argument rests on. Kept here.

const HAIKU  = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-4-6'
const OPUS   = 'claude-opus-5'

// ─── the models a user can pick ───────────────────────────────────────────────

test('every selectable model is in the provider registry', () => {
    // The profile's MODEL_OPTIONS (frontend) must stay in step with this — a model offered in the
    // dropdown but unknown here silently downgrades to the default.
    for (const model of [HAIKU, SONNET, OPUS, 'claude-opus-4-8']) {
        assert.ok(isAllowedModel(model), `${model} would silently downgrade to the default`)
    }
})

// ─── provider thinking config ─────────────────────────────────────────────────
// Reasoning is no longer user-selectable: nothing sends an effort, so every desk arrives here
// with undefined. What that resolves to per model is the whole behaviour now.

test('no effort means no thinking block on sonnet — zero reasoning tokens', () => {
    assert.equal(_thinkingConfig(undefined, SONNET), null)
    assert.equal(_thinkingConfig('off', SONNET), null)
})

test('opus 5 never runs without a thinking block', () => {
    // Opus 5 thinks whether or not we ask, so max_tokens must account for it — and with thinking
    // explicitly off it can emit a tool call as plain text, which silently never runs.
    const expected = { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
    assert.deepEqual(_thinkingConfig(undefined, OPUS), expected)
    assert.deepEqual(_thinkingConfig('off', OPUS), expected)
})

test('the internal effort parameter still works when set in code', () => {
    // Removed from the UI, NOT from the plumbing: the monitors set it, and it is the seam a
    // future reasoning sidecar would use.
    assert.deepEqual(_thinkingConfig('high', OPUS), {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
    })
    assert.deepEqual(_thinkingConfig('low', SONNET), {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
    })
})

// ─── pricing ──────────────────────────────────────────────────────────────────

test('pricing: opus 5 is $5/$25 per 1M tokens', () => {
    const cost = calcCost(OPUS, { input_tokens: 1_000_000, output_tokens: 1_000_000 })
    assert.equal(+cost.toFixed(4), 30)
})

test('pricing: opus 4.8 matches opus 5 (both $5/$25, not the old $15/$75)', () => {
    const usage = { input_tokens: 500_000, output_tokens: 200_000 }
    assert.equal(calcCost('claude-opus-4-8', usage), calcCost(OPUS, usage))
})

test('pricing: cache reads/writes are billed at 0.1x / 1.25x input', () => {
    const cost = calcCost(OPUS, {
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
    })
    assert.equal(+cost.toFixed(4), 6.75)  // 0.50 + 6.25
})

test('pricing: a cached read is ~12x cheaper than a cold write', () => {
    // The number the whole "never change the model or effort mid-conversation" rule rests on.
    const warm = calcCost(SONNET, { cache_read_input_tokens: 1_000_000 })
    const cold = calcCost(SONNET, { cache_creation_input_tokens: 1_000_000 })
    assert.equal(+(cold / warm).toFixed(2), 12.5)
})

test('pricing: an unpriced model falls back instead of billing zero', () => {
    const cost = calcCost('some-future-model', { input_tokens: 1_000_000 })
    assert.equal(cost, 3)
})
