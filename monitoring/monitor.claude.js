/**
 * Thin Claude helper for monitoring calls.
 * Uses Haiku — fast and cheap for condition parsing / evaluation.
 * Isolated from the main trade-agent provider intentionally.
 */

import Anthropic from '@anthropic-ai/sdk'
import { extractFirstJSON } from './parsers/llmReply.parser.js'
import { config } from '../services/config.js'

const MODEL = 'claude-haiku-4-5-20251001'

// LAZY, and deliberately so. This used to be `const client = new Anthropic({ apiKey:
// process.env.ANTHROPIC_API_KEY })` at module scope, which reads the environment at IMPORT time —
// and nothing in this file guaranteed the environment was loaded by then. It worked only because
// the module next door (monitorUtils) pulled in a chain that eventually did `import 'dotenv/config'`,
// so .env was populated as a side effect of an unrelated import that happened to be evaluated first.
//
// That is invisible until it moves. Swapping one import for a leaf module with no dependencies of
// its own removed the accidental ordering, and every condition parse started failing with "Could not
// resolve authentication method" — a key that WAS in .env, read one tick too early. The parse
// failure is then silent (parseCondition catches and returns an unknown), so a `touch` leaf that
// should rest at the broker quietly reads back as level 0.
//
// Constructing on first CALL removes the ordering question: by the time anything parses a condition,
// server.js has long since loaded dotenv. It also means importing this module — which the pure
// parser tests do transitively — no longer needs an API key to exist.
let _client = null
function client() {
    if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey })
    return _client
}

/**
 * Call Claude and extract the first JSON object from the response.
 * @returns {Promise<object>}
 */
export async function claudeJSON(systemPrompt, userMessage) {
    const msg = await client().messages.create({
        model:      MODEL,
        max_tokens: 512,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
    })
    const text  = msg.content[0]?.text ?? ''
    return extractFirstJSON(text)
}

/**
 * Call Claude and return the raw text response.
 * Used for YES/NO evaluators.
 * @returns {Promise<string>}
 */
export async function claudeText(systemPrompt, userMessage) {
    const msg = await client().messages.create({
        model:    MODEL,
        max_tokens: 64,
        system:   systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
    })
    return msg.content[0]?.text ?? ''
}

/**
 * Call Claude Sonnet with a chart image + text prompt.
 * Used by the chart evaluator for visual pattern recognition (YES/NO, default 64 tokens)
 * and by the price-structure tools for a richer structured read (pass a larger maxTokens).
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} imageBase64  base64-encoded PNG bytes of the chart
 * @param {{ maxTokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function claudeVision(systemPrompt, userMessage, imageBase64, { maxTokens = 64 } = {}) {
    const msg = await client().messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [{
            role:    'user',
            content: [
                {
                    type:   'image',
                    source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
                },
                { type: 'text', text: userMessage },
            ],
        }],
    })
    return msg.content[0]?.text ?? ''
}
