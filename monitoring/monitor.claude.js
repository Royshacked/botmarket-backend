/**
 * Thin Claude helper for monitoring calls.
 * Uses Haiku — fast and cheap for condition parsing / evaluation.
 * Isolated from the main trade-agent provider intentionally.
 */

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../services/logger.service.js'

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
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`claudeJSON: no JSON in response — ${text}`)
    return JSON.parse(match[0])
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
