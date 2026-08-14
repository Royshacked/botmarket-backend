import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedModel } from '../../services/llmModels.js'
import { _thinkingConfig } from '../../providers/anthropic.provider.js'
import { _thinkingConfig as hermesThinkingConfig } from '../../monitoring/hermes.assess.js'
import { calcCost } from '../../services/tokenUsage.service.js'

// These lived in modelRouter.test.js. The router is gone — the model is the user's own pick now,
// with no per-turn routing — but pricing and the thinking config are the provider's, not the
// router's, and they are what the whole cache/effort argument rests on. Kept here.

const HAIKU    = 'claude-haiku-4-5-20251001'
const SONNET   = 'claude-sonnet-4-6'
const SONNET_5 = 'claude-sonnet-5'
const OPUS     = 'claude-opus-5'

// ─── the models a user can pick ───────────────────────────────────────────────

// Mirrors the frontend's MODEL_OPTIONS (cmps/modelOptions.js) exactly. Two lists keyed by the
// same ids is the drift we just removed from the AI-pref keys; this is the pin that keeps them
// in step, so add a model in BOTH places or the dropdown offers something that silently
// downgrades to the default.
const SELECTABLE = [HAIKU, SONNET_5, SONNET, 'claude-opus-4-8', OPUS]

test('every selectable model is in the provider registry', () => {
    for (const model of SELECTABLE) {
        assert.ok(isAllowedModel(model), `${model} would silently downgrade to the default`)
    }
})

test('every selectable model has its own PRICING row', () => {
    // Probed via a CACHE READ, not plain input: DEFAULT_PRICING carries input/output but no
    // cache rates, so `p.cacheRead ?? 0` makes an unpriced model bill cache reads at ZERO while
    // still looking plausible on input. Sonnet 5's input rate is identical to the fallback, so
    // an input-token probe here would pass whether or not the row exists.
    for (const model of SELECTABLE) {
        const cost = calcCost(model, { cache_read_input_tokens: 1_000_000 })
        assert.ok(cost > 0, `${model} has no PRICING row — cache reads would bill as free`)
    }
})

// ─── provider thinking config ─────────────────────────────────────────────────
// Reasoning is no longer user-selectable: nothing sends an effort, so every desk arrives here
// with undefined. What that resolves to per model is the whole behaviour now.

test('no effort means no thinking block on sonnet 4.6 — zero reasoning tokens', () => {
    assert.equal(_thinkingConfig(undefined, SONNET), null)
    assert.equal(_thinkingConfig('off', SONNET), null)
})

test('the models that reason by default never run without a thinking block', () => {
    // Both think whether or not we ask, so max_tokens must account for it (the caller picks
    // THINKING_MAX_TOKENS off a non-null return). Opus 5 additionally must not run with thinking
    // explicitly off, where it can emit a tool call as plain text that silently never runs.
    const expected = { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
    for (const model of [OPUS, SONNET_5]) {
        assert.deepEqual(_thinkingConfig(undefined, model), expected, model)
        assert.deepEqual(_thinkingConfig('off', model), expected, model)
    }
})

test('sonnet 5 is floored even though sonnet 4.6 is not', () => {
    // The regression this guards: Sonnet 5 REVERSED 4.6's default — omitting `thinking` runs
    // adaptive at effort `high`, where 4.6 ran thinking-off. Nothing sends an effort any more,
    // so a missing entry means every Sonnet 5 turn thinks at high effort on the SMALL token
    // budget. Same call, same arguments, opposite correct answers.
    assert.equal(_thinkingConfig(undefined, SONNET), null)
    assert.notEqual(_thinkingConfig(undefined, SONNET_5), null)
})

test('the model argument is load-bearing — omitting it skips the floor', () => {
    // Pinned because the one-arg form is what a drifted copy looked like: hermes.assess.js carried
    // its own `_thinkingConfig(effort)` that "mirrored" this one, never learned about the floor,
    // and so ran the monitors thinking-off on a model that must not be. The monitors import THIS
    // function now; this keeps the no-model call visibly wrong rather than quietly plausible.
    assert.equal(_thinkingConfig(undefined), null)
    assert.equal(_thinkingConfig('off'), null)
})

test('the monitors use the provider’s thinking config, not a copy of it', () => {
    // The duplicate is the actual bug here — two implementations of one mechanism drift, and this
    // one drifted silently in the direction that costs money and breaks tool calls.
    assert.equal(hermesThinkingConfig, _thinkingConfig, 'hermes re-exported a different function')
    assert.deepEqual(
        hermesThinkingConfig(undefined, OPUS),
        { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
        'the monitors are not getting the reasons-by-default floor',
    )
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
