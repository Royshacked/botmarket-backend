/**
 * The monitor tier's three one-shot reads — a JSON parse, a YES/NO answer, a look at a chart — as
 * thin readings of the ONE Anthropic call path (providers/anthropic.provider.callAnthropicOnce).
 *
 * This module used to hold a second Anthropic client, "isolated from the main trade-agent provider
 * intentionally", with its own hardcoded model ids and no usage hook: every condition parse, every
 * evaluator verdict and every chart-vision read went through a client nothing else could see and was
 * billed to nobody. What was its own — which model reads what, and how many tokens each read needs —
 * is still here. The client, the request shape and the stop-reason log are the provider's.
 *
 * The MODEL IDS come from llmModels, where the desks' do, so a model change is one edit.
 */

import { callAnthropicOnce } from '../providers/anthropic.provider.js'
import { callOpenAICompatOnce } from '../providers/openaiCompat.provider.js'
import { CHEAP_MODEL, DEFAULT_MODEL, modelRoute } from '../services/llmModels.js'
import { getHouseModels } from '../services/houseModels.service.js'
import { extractFirstJSON } from './parsers/llmReply.parser.js'

// The one call, behind a seam. The outage tests used to simulate "no model" by blanking
// ANTHROPIC_API_KEY before this module's lazily-built client read it; the client lives in the
// provider now, at module scope, and ESM hoists the import above the assignment — so the blanking
// reached nothing, and in a shell with the key exported those tests would have made real Haiku
// calls and failed while spending tokens. A test that wants the model unreachable says so HERE.
let _once = callAnthropicOnce
/** Swap the one-shot call (tests). Returns a restore function; `null` restores the real one. */
export function _setOneShot(fn) {
    const prev = _once
    _once = fn ?? callAnthropicOnce
    return () => { _once = prev }
}

// The same seam for the non-Anthropic path, so a test can hold the vision read still whichever
// model the house is on.
let _onceCompat = callOpenAICompatOnce
export function _setCompatOneShot(fn) {
    const prev = _onceCompat
    _onceCompat = fn ?? callOpenAICompatOnce
    return () => { _onceCompat = prev }
}

// A condition parse and a YES/NO verdict are reading, not modelling — the cheap model, as before.
const PARSE_MODEL = CHEAP_MODEL

/**
 * WHICH MODEL READS THE PICTURE: the HOUSE pick, the same one every desk turn runs on.
 *
 * It used to be pinned to `DEFAULT_MODEL` while the desks followed the admin's selection, which
 * made the vision reads the most expensive thing in a build the moment the house moved to a
 * cheaper model — measured on 2026-09-29, $0.26 of Sonnet vision against $0.19 of Luna desk, so
 * the pictures cost more than the conversation. One selector, everything on it (houseModels).
 *
 * Falls back to the default on any failure, because a vision read that cannot resolve a model is
 * a structure read that silently does not happen.
 */
async function _visionRoute() {
    try {
        const { chatModel } = await _houseModels()
        return modelRoute(chatModel)
    } catch {
        return modelRoute(DEFAULT_MODEL)
    }
}

// The house lookup behind a seam, like the two one-shots above: a test that wants the vision read
// on a particular model says so here rather than writing to a database to find out.
let _houseModels = getHouseModels
export function _setHouseModelsReader(fn) {
    const prev = _houseModels
    _houseModels = fn ?? getHouseModels
    return () => { _houseModels = prev }
}

/**
 * Call Claude and extract the first JSON object from the response.
 * @returns {Promise<object>}
 */
export async function claudeJSON(systemPrompt, userMessage) {
    return extractFirstJSON(await _once({ model: PARSE_MODEL, systemPrompt, user: userMessage, maxTokens: 512 }))
}

/**
 * Call Claude and return the raw text response.
 * Used for YES/NO evaluators.
 * @returns {Promise<string>}
 */
export async function claudeText(systemPrompt, userMessage) {
    return _once({ model: PARSE_MODEL, systemPrompt, user: userMessage, maxTokens: 64 })
}

/**
 * A chart image + a question → the model's read of the picture. Used by the chart evaluator for
 * visual pattern recognition (YES/NO, default 64 tokens) and by the price-structure tools for a
 * richer structured read (pass a larger maxTokens).
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} imageBase64  base64-encoded PNG bytes of the chart
 * @param {{ maxTokens?: number, onUsage?: (usage: object, model: string) => void }} [opts]
 *   `onUsage` is the caller's booking hook — the read runs on VISION_MODEL, which the hook is told,
 *   so the caller prices it at that model's rate and not at the loop's.
 * @returns {Promise<string>}
 */
export async function claudeVision(systemPrompt, userMessage, imageBase64, { maxTokens = 64, onUsage } = {}) {
    const route = await _visionRoute()
    if (route.provider === 'anthropic') {
        return _once({ model: route.model, systemPrompt, user: userMessage, image: imageBase64, maxTokens, onUsage })
    }
    return _onceCompat({
        endpoint: route.endpoint, wire: route.wire, model: route.model,
        systemText: systemPrompt, userText: userMessage, image: imageBase64, maxTokens, onUsage,
    })
}
