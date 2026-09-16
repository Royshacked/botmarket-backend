// Single source of truth for which chat models are selectable from the UI and
// which provider streaming function each one routes to. Used by the idea and
// portfolio agents so a model can be switched per-request while system prompts
// and tools stay identical.

import { streamAnthropicWithTools } from '../providers/anthropic.provider.js'

export const DEFAULT_MODEL = 'claude-sonnet-4-6'
/** Where a user past their spend ceiling is routed. Named here so it stays one of MODELS. */
export const CHEAP_MODEL   = 'claude-haiku-4-5-20251001'

const MODELS = {
    'claude-opus-5':            { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Opus 5' },
    'claude-opus-4-8':          { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Opus 4.8' },
    'claude-sonnet-5':          { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Sonnet 5' },
    'claude-sonnet-4-6':        { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Sonnet 4.6' },
    'claude-haiku-4-5-20251001': { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Haiku 4.5' },
}

// Which web_search server-tool variant a model accepts. The 2026-02-09 variant (dynamic
// filtering: max_uses, allowed/blocked domains, user_location) is on Opus 5/4.8 and Sonnet 5/4.6;
// Haiku 4.5 keeps the basic 2025-03-05 variant, and an UNKNOWN model defaults to basic too, because
// basic is accepted everywhere web_search is. The registry emits the modern type as its base; the
// provider calls this to downgrade per request (a user, or a spend-degraded turn, on Haiku).
const WEB_SEARCH_20260209 = new Set(['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6'])

export function webSearchTypeFor(model) {
    return WEB_SEARCH_20260209.has(model) ? 'web_search_20260209' : 'web_search_20250305'
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
