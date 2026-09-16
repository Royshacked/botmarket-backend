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
import { CHEAP_MODEL, DEFAULT_MODEL } from '../services/llmModels.js'
import { extractFirstJSON } from './parsers/llmReply.parser.js'

// A condition parse and a YES/NO verdict are reading, not modelling — the cheap model, as before.
// A chart is a VISION read, and the cheap model's eyes are not good enough for structure; the
// desks' default model reads the picture.
const PARSE_MODEL  = CHEAP_MODEL
const VISION_MODEL = DEFAULT_MODEL

/**
 * Call Claude and extract the first JSON object from the response.
 * @returns {Promise<object>}
 */
export async function claudeJSON(systemPrompt, userMessage) {
    return extractFirstJSON(await callAnthropicOnce({ model: PARSE_MODEL, systemPrompt, user: userMessage, maxTokens: 512 }))
}

/**
 * Call Claude and return the raw text response.
 * Used for YES/NO evaluators.
 * @returns {Promise<string>}
 */
export async function claudeText(systemPrompt, userMessage) {
    return callAnthropicOnce({ model: PARSE_MODEL, systemPrompt, user: userMessage, maxTokens: 64 })
}

/**
 * A chart image + a question → the model's read of the picture. Used by the chart evaluator for
 * visual pattern recognition (YES/NO, default 64 tokens) and by the price-structure tools for a
 * richer structured read (pass a larger maxTokens).
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} imageBase64  base64-encoded PNG bytes of the chart
 * @param {{ maxTokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function claudeVision(systemPrompt, userMessage, imageBase64, { maxTokens = 64 } = {}) {
    return callAnthropicOnce({ model: VISION_MODEL, systemPrompt, user: userMessage, image: imageBase64, maxTokens })
}
