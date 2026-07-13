/**
 * Thin Claude helper for monitoring calls.
 * Uses Haiku — fast and cheap for condition parsing / evaluation.
 * Isolated from the main trade-agent provider intentionally.
 */

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../services/logger.service.js'
import { extractFirstJSON } from './monitorUtils.js'

const LOG    = '[monitor.claude]'
const MODEL  = 'claude-haiku-4-5-20251001'
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * Call Claude and extract the first JSON object from the response.
 * @returns {Promise<object>}
 */
export async function claudeJSON(systemPrompt, userMessage) {
    const msg = await client.messages.create({
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
    const msg = await client.messages.create({
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
    const msg = await client.messages.create({
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
