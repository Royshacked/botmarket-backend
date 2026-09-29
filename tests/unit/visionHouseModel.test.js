import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelRoute, DEFAULT_MODEL } from '../../services/llmModels.js'
import { claudeVision, _setOneShot, _setCompatOneShot, _setHouseModelsReader } from '../../monitoring/monitor.claude.js'

// THE PICTURE FOLLOWS THE HOUSE. Vision was pinned to the Anthropic default while every desk turn
// ran on the admin's pick, so on 2026-09-29 one session spent $0.26 of Sonnet vision against $0.19
// of Luna desk — the pictures cost more than the conversation they were part of. One selector,
// everything on it.

/** Run one vision read with the house pick forced and both one-shot paths watched. */
async function visionOn(chatModel) {
    const seen = {}
    const restore = [
        _setHouseModelsReader(async () => ({ chatModel })),
        _setOneShot(async (args) => { seen.anthropic = args; return 'anthropic-read' }),
        _setCompatOneShot(async (args) => { seen.compat = args; return 'compat-read' }),
    ]
    const text = await claudeVision('sys', 'what do you see', 'PNGDATA', { maxTokens: 777 })
    for (const r of restore) r()
    return { text, ...seen }
}

// ─── The route ────────────────────────────────────────────────────────────────

test('an Anthropic model needs no endpoint; a candidate carries its endpoint AND wire slug', () => {
    assert.deepEqual(modelRoute('claude-sonnet-5'), {
        model: 'claude-sonnet-5', provider: 'anthropic', endpoint: null, wire: null,
    })
    assert.deepEqual(modelRoute('gpt-6-luna'), {
        model: 'gpt-6-luna', provider: 'openai-compat', endpoint: 'openrouter', wire: 'openai/gpt-6-luna',
    })
})

test('an unknown model routes to the default, never to a provider that never heard of it', () => {
    assert.equal(modelRoute('gpt-9-imaginary').model, DEFAULT_MODEL)
    assert.equal(modelRoute(undefined).model, DEFAULT_MODEL)
})

// ─── The read ─────────────────────────────────────────────────────────────────

test('on a house Anthropic model the read goes down the Anthropic path, image intact', async () => {
    const { text, anthropic, compat } = await visionOn('claude-sonnet-5')
    assert.equal(text, 'anthropic-read')
    assert.equal(compat, undefined)
    assert.equal(anthropic.model, 'claude-sonnet-5')
    assert.equal(anthropic.image, 'PNGDATA', 'the picture is the whole point of the call')
    assert.equal(anthropic.maxTokens, 777)
})

test('on a house candidate the SAME read goes to that vendor, with the wire slug', async () => {
    const { text, anthropic, compat } = await visionOn('gpt-6-luna')
    assert.equal(text, 'compat-read')
    assert.equal(anthropic, undefined, 'and does not also bill Anthropic')
    assert.equal(compat.endpoint, 'openrouter')
    assert.equal(compat.wire, 'openai/gpt-6-luna')
    assert.equal(compat.model, 'gpt-6-luna', 'booked under the id the ledger prices')
    assert.equal(compat.image, 'PNGDATA')
    assert.equal(compat.maxTokens, 777)
})

test('a house pick nobody recognises still reads the chart, on the default', async () => {
    const { text, anthropic } = await visionOn('gpt-9-imaginary')
    assert.equal(text, 'anthropic-read')
    assert.equal(anthropic.model, DEFAULT_MODEL)
})

test('a house lookup that THROWS still reads the chart — a structure read must not vanish', async () => {
    const restore = [
        _setHouseModelsReader(async () => { throw new Error('mongo is down') }),
        _setOneShot(async (args) => args),
    ]
    const out = await claudeVision('sys', 'q', 'PNG', { maxTokens: 64 })
    for (const r of restore) r()
    assert.equal(out.model, DEFAULT_MODEL)
    assert.equal(out.image, 'PNG')
})
