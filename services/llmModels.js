// Single source of truth for which chat models are selectable from the UI and
// which provider streaming function each one routes to. Used by the idea and
// portfolio agents so a model can be switched per-request while system prompts
// and tools stay identical.

import { streamAnthropicWithTools } from '../providers/anthropic.provider.js'
import { streamOpenAIWithTools }    from '../providers/openai.provider.js'

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

const MODELS = {
    'claude-opus-4-8':   { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Opus 4.8' },
    'claude-sonnet-4-6': { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Sonnet 4.6' },
    'gpt-5':             { provider: 'openai',    streamFn: streamOpenAIWithTools,    label: 'GPT-5' },
}

export function isAllowedModel(model) {
    return typeof model === 'string' && Object.prototype.hasOwnProperty.call(MODELS, model)
}

/**
 * Resolve a requested model id to its validated id and provider streaming
 * function. Falls back to DEFAULT_MODEL for unknown/missing ids so a bad value
 * never reaches a provider.
 */
export function resolveStreamFn(requestedModel) {
    const model = isAllowedModel(requestedModel) ? requestedModel : DEFAULT_MODEL
    return { model, streamFn: MODELS[model].streamFn, provider: MODELS[model].provider }
}
