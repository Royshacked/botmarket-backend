import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    resolveModel,
    _normalizeClassification,
    ROUTING_MODES,
    REASONING_EFFORT,
} from '../../services/modelRouter.service.js'
import { isAllowedModel } from '../../services/llmModels.js'
import { _thinkingConfig } from '../../providers/anthropic.provider.js'
import { calcCost } from '../../services/tokenUsage.service.js'

const HAIKU  = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-4-6'
const OPUS   = 'claude-opus-5'

// ─── classifier output → route ────────────────────────────────────────────────

test('classifier: opus is a reachable model choice', () => {
    assert.equal(_normalizeClassification({ model: 'opus', reasoning: 'high' }).model, OPUS)
    assert.equal(_normalizeClassification({ model: 'sonnet', reasoning: 'off' }).model, SONNET)
    assert.equal(_normalizeClassification({ model: 'haiku', reasoning: 'off' }).model, HAIKU)
})

test('classifier: all three reasoning levels round-trip', () => {
    const effort = r => _normalizeClassification({ model: 'sonnet', reasoning: r }).reasoningEffort
    assert.equal(effort('off'),  REASONING_EFFORT.OFF)
    assert.equal(effort('low'),  REASONING_EFFORT.LOW)
    assert.equal(effort('high'), REASONING_EFFORT.HIGH)
})

test('classifier: unknown / missing fields fall back to sonnet + off', () => {
    for (const parsed of [{}, null, undefined, { model: 'gpt-9', reasoning: 'max' }]) {
        assert.deepEqual(_normalizeClassification(parsed), {
            model: SONNET,
            reasoningEffort: REASONING_EFFORT.OFF,
        })
    }
})

test('every model the classifier can pick is in the provider registry', () => {
    for (const key of ['haiku', 'sonnet', 'opus']) {
        const { model } = _normalizeClassification({ model: key })
        assert.ok(isAllowedModel(model), `${model} would silently downgrade to the default`)
    }
})

// ─── Opus 5 effort floor ──────────────────────────────────────────────────────

test('manual mode: opus 5 with effort off floors to low', async () => {
    const route = await resolveModel({
        routingMode: ROUTING_MODES.MANUAL,
        model: OPUS,
        reasoningEffort: REASONING_EFFORT.OFF,
    })
    assert.deepEqual(route, { model: OPUS, reasoningEffort: REASONING_EFFORT.LOW })
})

test('manual mode: an explicit opus 5 effort is left alone', async () => {
    const route = await resolveModel({
        routingMode: ROUTING_MODES.MANUAL,
        model: OPUS,
        reasoningEffort: REASONING_EFFORT.HIGH,
    })
    assert.equal(route.reasoningEffort, REASONING_EFFORT.HIGH)
})

test('the floor is opus-5-only — sonnet/haiku keep effort off', async () => {
    for (const model of [SONNET, HAIKU]) {
        const route = await resolveModel({
            routingMode: ROUTING_MODES.MANUAL,
            model,
            reasoningEffort: REASONING_EFFORT.OFF,
        })
        assert.equal(route.reasoningEffort, REASONING_EFFORT.OFF)
    }
})

test('auto mode: phase table still routes, unchanged by the floor', async () => {
    const route = await resolveModel({ routingMode: ROUTING_MODES.AUTO, agent: 'idea', phase: 1 })
    assert.deepEqual(route, { model: HAIKU, reasoningEffort: REASONING_EFFORT.OFF })
})

// ─── provider thinking config ─────────────────────────────────────────────────

test('provider: effort off means no thinking block on sonnet', () => {
    assert.equal(_thinkingConfig('off', SONNET), null)
    assert.equal(_thinkingConfig(undefined, SONNET), null)
})

test('provider: opus 5 never runs without a thinking block', () => {
    // Opus 5 thinks whether or not we ask, so max_tokens must account for it.
    assert.deepEqual(_thinkingConfig('off', OPUS), {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
    })
    assert.deepEqual(_thinkingConfig(undefined, OPUS), {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
    })
})

test('provider: an explicit effort wins over the opus floor', () => {
    assert.deepEqual(_thinkingConfig('high', OPUS), {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
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

test('pricing: an unpriced model falls back instead of billing zero', () => {
    const cost = calcCost('some-future-model', { input_tokens: 1_000_000 })
    assert.equal(cost, 3)
})
