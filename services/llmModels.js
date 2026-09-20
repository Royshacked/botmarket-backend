// Single source of truth for which chat models are selectable from the UI and
// which provider streaming function each one routes to. Used by the idea and
// portfolio agents so a model can be switched per-request while system prompts
// and tools stay identical.

import { streamAnthropicWithTools } from '../providers/anthropic.provider.js'
import { streamOpenAICompatWithTools } from '../providers/openaiCompat.provider.js'

// Sonnet 5 since 2026-09-20 (was Sonnet 4.6): $2/$10 against $3/$15, in-family, already in the
// menu. Its tokenizer counts ~30% more, so the net is ~10-15% — more on output-heavy desks, since
// output is where the discount bites. It reasons by default (THINKS_BY_DEFAULT floors it to `low`),
// and the vision one-shot in monitor.claude follows this constant, which _oneShotRequest already
// handles. A user who picked a model explicitly keeps it; an unset preference means this.
// Talos has its own default (assess.shared ASSESS_MODEL) and did not move.
export const DEFAULT_MODEL = 'claude-sonnet-5'
/** Where a user past their spend ceiling is routed. Named here so it stays one of MODELS. */
export const CHEAP_MODEL   = 'claude-haiku-4-5-20251001'

// `webSearch` is the web_search server-tool variant this model accepts, carried ON the entry so a
// new model declares its own capability in ONE place. The 2026-02-09 variant (dynamic filtering:
// max_uses, allowed/blocked domains, user_location) is on Opus 5/4.8 and Sonnet 5/4.6; Haiku 4.5
// keeps the basic 2025-03-05 variant. See webSearchTypeFor.
const WS_NEW = 'web_search_20260209'
const WS_OLD = 'web_search_20250305'

const MODELS = {
    'claude-opus-5':            { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Opus 5',    webSearch: WS_NEW },
    'claude-opus-4-8':          { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Opus 4.8',  webSearch: WS_NEW },
    'claude-sonnet-5':          { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Sonnet 5',  webSearch: WS_NEW },
    'claude-sonnet-4-6':        { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Sonnet 4.6', webSearch: WS_NEW },
    'claude-haiku-4-5-20251001': { provider: 'anthropic', streamFn: streamAnthropicWithTools, label: 'Claude Haiku 4.5', webSearch: WS_OLD },
    // A CANDIDATE for the desks' base model (2026-09-20), admin-only while under evaluation — the
    // same pattern as Talos's TALOS_MODELS: the admin picks it in the profile, their own desks run
    // on it, the ledger's byModel row says what it cost. `streamFn` binds the endpoint and the
    // wire slug so the loop never learns the registry. No `webSearch`: the provider substitutes
    // OpenRouter's web plugin when a desk declares the tool. resolveAgentStream routes a non-admin
    // who somehow requests it to DEFAULT_MODEL.
    'gpt-5.6-luna': {
        provider: 'openai-compat', label: 'GPT-5.6 Luna', adminOnly: true, webSearch: null,
        streamFn: (args) => streamOpenAICompatWithTools({ ...args, endpoint: 'openrouter', wire: 'openai/gpt-5.6-luna' }),
    },
}

/**
 * The web_search variant to send this model — read off its MODELS entry (`webSearch`), so a new
 * model's capability is declared once, beside its other facts. An UNKNOWN model defaults to the
 * basic variant, which is accepted everywhere web_search is. The registry emits the modern type as
 * its base; the provider (and the assess loop) call this to downgrade per request — a user, or a
 * spend-degraded turn, on Haiku.
 */
export function webSearchTypeFor(model) {
    return MODELS[model]?.webSearch ?? WS_OLD
}

export function isAllowedModel(model) {
    return typeof model === 'string' && Object.prototype.hasOwnProperty.call(MODELS, model)
}

/** A model only an admin may run a desk on — a candidate under evaluation. */
export function isAdminOnlyModel(model) {
    return isAllowedModel(model) && MODELS[model].adminOnly === true
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
