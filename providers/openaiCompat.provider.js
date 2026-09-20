// The OpenAI-compatible read loop — how a NON-Anthropic Talos candidate is read.
//
// WHY ONE ADAPTER. Every candidate outside Anthropic (TALOS_MODELS, provider 'openai-compat') speaks
// the OpenAI chat-completions wire format. So the app carries ONE translation of its read — tools,
// tool results, usage — and the same adapter that runs the evaluation is the one that would ship if
// a candidate won. WHICH ACCOUNT it talks to is an `endpoint` (base URL + key) on the registry
// entry, not a second loop: OpenRouter fronts most vendors behind one key; Mistral is read on
// their own API.
//
// WHAT IS SHARED with the Anthropic loop in talos.assess.js: the prompts (untouched — they are the
// desk's judgment), the tool KIT and its dispatch (makeAssessToolRunner runs the calls exactly as it
// does for Claude, symbol scope and all), the runaway backstop, the parse, the recorder's trace.
// WHAT IS TRANSLATED here, and only here: the tool schemas, the tool-call shape, the tool-result
// shape (an image cannot ride in an OpenAI `tool` message — it follows as a `user` message), the
// usage. Everything translated is a pure function with a test.
//
// WHAT IS LOST, on purpose: `web_search` (an Anthropic server tool — a condition that needs the
// web comes back `unchecked`, which is already the prompt's rule), the prompt cache markers (these
// vendors cache automatically or not at all) and the thinking config (vendor defaults).

import OpenAI from 'openai'
import { config } from '../services/config.js'
import { logger } from '../services/logger.service.js'
import { createTagSuppressor, TOOL_BUDGET_LANDING } from '../services/llmStream.util.js'
import { _runTool } from './anthropic.provider.js'

const LOG = '[openaiCompat]'

/** The accounts an OpenAI-format read can go to. `key` is read per client build. */
export const ENDPOINTS = Object.freeze({
    openrouter: { baseURL: 'https://openrouter.ai/api/v1', key: () => config.openrouterApiKey,
        // OpenRouter's attribution header — optional; it makes the account's usage page say which
        // app spent what.
        headers: { 'X-Title': 'TRADVICE Talos' } },
    mistral:    { baseURL: 'https://api.mistral.ai/v1',    key: () => config.mistralApiKey },
})

const _clients = new Map()
function _clientFor(endpoint) {
    const ep = ENDPOINTS[endpoint]
    if (!ep) throw new Error(`unknown endpoint "${endpoint}"`)
    if (!_clients.has(endpoint)) {
        _clients.set(endpoint, new OpenAI({ apiKey: ep.key(), baseURL: ep.baseURL, defaultHeaders: ep.headers }))
    }
    return _clients.get(endpoint)
}

// ─── Translators (pure) ────────────────────────────────────────────────────────

/**
 * Anthropic tool definitions → OpenAI function tools. Server tools (`type: web_search_*`) have no
 * OpenAI twin and are dropped; a registry tool is `{ name, description, input_schema }`.
 */
export function toOpenAITools(tools) {
    return (tools ?? [])
        .filter(t => t?.name && t?.input_schema && !(typeof t.type === 'string' && t.type.startsWith('web_search')))
        .map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }))
}

/**
 * An OpenAI assistant message's `tool_calls` → Anthropic `tool_use` blocks, so the shared runner
 * dispatches them unchanged. Unparseable arguments become `{}` — the handler's own validation then
 * answers with its normal error string, which the model can act on.
 */
export function toToolUses(message) {
    return (message?.tool_calls ?? [])
        .filter(c => c?.type === 'function' && c.function?.name)
        .map(c => {
            let input = {}
            try { input = JSON.parse(c.function.arguments || '{}') } catch { /* {} */ }
            return { type: 'tool_use', id: c.id, name: c.function.name, input: input && typeof input === 'object' ? input : {} }
        })
}

/**
 * The runner's `tool_result` blocks → the OpenAI messages that answer a tool turn.
 *
 * Every call gets a `tool` message (the API requires one per tool_call_id, immediately after the
 * assistant turn). A result that carries an IMAGE — get_chart — cannot: OpenAI tool messages are
 * text. So its text rides in the tool message with a pointer, and every image of the round follows
 * in ONE `user` message after the tool messages, labelled with the tool call it belongs to.
 */
export function toToolMessages(results) {
    const toolMsgs = []
    const images   = []
    for (const r of results ?? []) {
        if (r?.type !== 'tool_result') continue
        const parts = Array.isArray(r.content) ? r.content : [{ type: 'text', text: String(r.content ?? '') }]
        const text  = parts.filter(p => p?.type === 'text').map(p => p.text).join('\n')
        const imgs  = parts.filter(p => p?.type === 'image' && p.source?.type === 'base64' && p.source.data)
        for (const img of imgs) {
            images.push({ type: 'image_url', image_url: { url: `data:${img.source.media_type || 'image/png'};base64,${img.source.data}` } })
        }
        const pointer = imgs.length ? `\n[${imgs.length} image(s) from this call follow in the next user message]` : ''
        toolMsgs.push({ role: 'tool', tool_call_id: r.tool_use_id, content: (text || (r.is_error ? 'error' : '')) + pointer })
    }
    if (images.length) {
        toolMsgs.push({ role: 'user', content: [{ type: 'text', text: 'The image(s) returned by the tool call(s) above:' }, ...images] })
    }
    return toolMsgs
}

/** OpenAI usage → the Anthropic-shaped usage the ledger books (services/tokenUsage.service). */
export function toAnthropicUsage(usage) {
    if (!usage) return null
    return {
        input_tokens:            Number(usage.prompt_tokens ?? 0) || 0,
        output_tokens:           Number(usage.completion_tokens ?? 0) || 0,
        // Reported, not subtracted: the cached share is inside prompt_tokens and the row for these
        // models prices cacheRead at 0, so the prompt is charged at the input rate in full.
        cache_read_input_tokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
    }
}

/** `finish_reason` → the stop_reason vocabulary the read loop already handles. */
export function toStopReason(finishReason, hasToolCalls) {
    if (hasToolCalls || finishReason === 'tool_calls') return 'tool_use'
    if (finishReason === 'length') return 'max_tokens'
    return 'end_turn'
}

/** Did the provider serve the model that was asked for? OpenRouter echoes its own slug back. */
export function servedModelMatches(served, wire) {
    if (!served) return true   // no claim to check
    const tail = String(wire).split('/').pop()
    return String(served).includes(tail)
}

// ─── The loop ──────────────────────────────────────────────────────────────────

/**
 * One read, OpenAI wire format. Mirrors the Anthropic loop in talos.assess.js: request → run the
 * calls → answer → until the model stops asking. Fills `trace` the same way (format 'openai').
 *
 * Returns `{ text, stopReason }` or `{ runaway: true }`. Throws on IO — the caller maps that to
 * `_failReason: 'io'` exactly as it does for Claude. A served model that is not the one asked for
 * is an IO failure too: a silently substituted candidate would corrupt the comparison.
 *
 * @param {object} p
 * @param {string} p.endpoint     which account (ENDPOINTS key — TALOS_MODELS[id].endpoint)
 * @param {string} p.wire         the slug the endpoint is sent (TALOS_MODELS[id].wire)
 * @param {string} p.model        the registry id, for the ledger (its PRICING row)
 * @param {string} p.systemText
 * @param {string} p.userText
 * @param {Array}  p.tools        Anthropic-shaped, as built for the read
 * @param {Function} p.runToolUses  the shared runner (makeAssessToolRunner)
 * @param {Function} p.onUsage    (usage, model) per round
 * @param {object} p.trace        the recorder's trace, filled here
 */
export async function runOpenAICompatRead({
    endpoint = 'openrouter', wire, model, systemText, userText, tools, runToolUses, onUsage, trace = {},
    maxTokens = 16_000, runawayRounds = 25, log = LOG, tag = '', client = null,
}) {
    client ??= _clientFor(endpoint)
    const oaTools  = toOpenAITools(tools)
    const messages = [
        { role: 'system', content: systemText },
        { role: 'user',   content: userText },
    ]
    Object.assign(trace, { format: 'openai', endpoint, wire, tools: oaTools, messages, usage: trace.usage ?? [], rounds: 0 })

    for (let round = 0; ; round++) {
        const res = await client.chat.completions.create({
            model: wire, messages, tools: oaTools, tool_choice: 'auto', max_tokens: maxTokens,
        })
        if (!servedModelMatches(res?.model, wire)) {
            throw new Error(`provider served "${res?.model}" for "${wire}"`)
        }
        const choice  = res?.choices?.[0]
        const message = choice?.message ?? { role: 'assistant', content: '' }
        const usage   = toAnthropicUsage(res?.usage)
        onUsage?.(usage, model)
        trace.usage.push(usage)
        trace.rounds = round + 1

        const uses = toToolUses(message)
        const stopReason = toStopReason(choice?.finish_reason, uses.length > 0)
        trace.stopReason = stopReason
        messages.push({ role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) })

        if (stopReason !== 'tool_use') {
            return { text: String(message.content ?? ''), stopReason }
        }

        const results = await runToolUses(uses)
        messages.push(...toToolMessages(results))

        if (round >= runawayRounds) {
            logger.error(log, `${tag} RUNAWAY: ${round + 1} tool rounds — abandoning the read`)
            return { runaway: true }
        }
    }
}

// ─── The desks' streaming loop ─────────────────────────────────────────────────
// The streaming twin of streamAnthropicWithTools, same signature, for a chat desk on a non-Anthropic
// candidate (llmModels MODELS, provider 'openai-compat'). Same tag suppressor (services/llmStream.util
// — it was written provider-agnostic for exactly this), same _runTool and handler contract, same
// onToken / onToolStart / onReasoning / onUsage hooks. Translated here: the system blocks, the
// history, the streamed tool-call deltas, the tool results (images follow as a user message), the
// usage. `web_search` becomes OpenRouter's web plugin when the endpoint is OpenRouter and the desk
// declared the tool; elsewhere it is simply absent.

/** Anthropic system blocks (or a string) → one system string. Cache markers are Anthropic's. */
export function toSystemText(systemPrompt) {
    if (typeof systemPrompt === 'string') return systemPrompt
    return (systemPrompt ?? []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n')
}

/** Anthropic-shaped history (string content, or text/image blocks) → OpenAI messages. Pure. */
export function toOpenAIMessages(promptOrMessages) {
    if (typeof promptOrMessages === 'string') return [{ role: 'user', content: promptOrMessages }]
    return (promptOrMessages ?? []).map(m => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content }
        const parts = (m.content ?? []).map(b => {
            if (b?.type === 'text')  return { type: 'text', text: b.text }
            if (b?.type === 'image' && b.source?.type === 'base64') {
                return { type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } }
            }
            return null
        }).filter(Boolean)
        // An assistant turn is text only in OpenAI's format; a user turn may carry parts.
        return m.role === 'assistant'
            ? { role: 'assistant', content: parts.filter(p => p.type === 'text').map(p => p.text).join('\n') }
            : { role: m.role, content: parts }
    })
}

/**
 * Fold one streamed chunk's tool-call deltas into the accumulator (index → {id, name, args}).
 * OpenAI streams a call's `id` and `name` on its first delta and the `arguments` string in pieces.
 * Mutates; exported for tests.
 */
export function foldToolCallDeltas(acc, deltas) {
    for (const d of deltas ?? []) {
        const i = d.index ?? 0
        const cur = acc[i] ?? (acc[i] = { id: null, name: null, args: '' })
        if (d.id) cur.id = d.id
        if (d.function?.name) cur.name = (cur.name ?? '') + d.function.name
        if (d.function?.arguments) cur.args += d.function.arguments
    }
    return acc
}

/** The accumulator → the assistant message's `tool_calls` and the runner's `tool_use` blocks. */
export function finishToolCalls(acc) {
    const calls = Object.values(acc).filter(c => c.id && c.name)
    const toolCalls = calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
    return { toolCalls, uses: toToolUses({ tool_calls: toolCalls }) }
}

const STREAM_MAX_TOKENS = 16_000

/**
 * @param {object} p  streamAnthropicWithTools's parameters, plus `endpoint` + `wire` (bound by the
 *                    MODELS entry) and `client` (tests). `model` is the registry id, for the ledger.
 * @returns {Promise<string>} the reply's visible text, emit tags suppressed
 */
export async function streamOpenAICompatWithTools({
    endpoint = 'openrouter', wire, model,
    promptOrMessages, systemPrompt, tools = [], toolHandlers = {}, maxContinuations = 10,
    onToken, tagCaptures = [], onToolStart, onReasoning, onUsage, signal, client = null,
}) {
    client ??= _clientFor(endpoint)
    if (!wire) throw new Error('streamOpenAICompatWithTools: wire is required — llmModels binds it')
    const suppressor = createTagSuppressor({ onToken, captures: tagCaptures })
    const oaTools    = toOpenAITools(tools)
    const wantsWeb   = (tools ?? []).some(t => typeof t?.type === 'string' && t.type.startsWith('web_search'))
    const messages   = [{ role: 'system', content: toSystemText(systemPrompt) }, ...toOpenAIMessages(promptOrMessages)]

    for (let i = 0; i < maxContinuations; i++) {
        if (signal?.aborted) { suppressor.flush(); return '' }

        // The landing round — same rule as the Anthropic loop: tools off, land as text. TOOL_BUDGET_LANDING.
        const landing = i === maxContinuations - 1

        const stream = await client.chat.completions.create({
            model: wire, messages, max_tokens: STREAM_MAX_TOKENS, stream: true,
            stream_options: { include_usage: true },
            ...(oaTools.length ? { tools: oaTools, tool_choice: landing ? 'none' : 'auto' } : {}),
            // OpenRouter's stand-in for the Anthropic server tool. Billed per result by OpenRouter.
            ...(wantsWeb && endpoint === 'openrouter' ? { plugins: [{ id: 'web', max_results: 5 }] } : {}),
        }, signal ? { signal } : undefined)

        let text   = ''
        let finish = null
        let usage  = null
        let served = null
        const acc  = {}
        const announced = new Set()
        try {
            for await (const chunk of stream) {
                served ??= chunk.model ?? null
                if (chunk.usage) usage = chunk.usage
                const choice = chunk.choices?.[0]
                if (!choice) continue
                const d = choice.delta ?? {}
                if (typeof d.content === 'string' && d.content) { text += d.content; suppressor.push(d.content) }
                // OpenRouter normalises reasoning onto `reasoning`; some vendors spell it reasoning_content.
                const r = d.reasoning ?? d.reasoning_content
                if (typeof r === 'string' && r) onReasoning?.(r)
                if (d.tool_calls?.length) {
                    foldToolCallDeltas(acc, d.tool_calls)
                    for (const c of d.tool_calls) {
                        const idx  = c.index ?? 0
                        const name = acc[idx]?.name
                        if (name && !announced.has(idx)) { announced.add(idx); onToolStart?.(name) }
                    }
                }
                if (choice.finish_reason) finish = choice.finish_reason
            }
        } catch (err) {
            if (signal?.aborted || err?.name === 'AbortError') { suppressor.flush(); return text }
            throw err
        }

        if (!servedModelMatches(served, wire)) throw new Error(`provider served "${served}" for "${wire}"`)
        if (usage) onUsage?.(toAnthropicUsage(usage), model)

        const { toolCalls, uses } = finishToolCalls(acc)
        const stopReason = toStopReason(finish, uses.length > 0)

        if (stopReason !== 'tool_use') {
            if (stopReason === 'max_tokens') logger.warn(LOG, `reply cut by max_tokens on ${wire} after ${text.length} chars`)
            suppressor.flush()
            return text
        }

        messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
        const results = await Promise.all(uses.map(u => _runTool(toolHandlers, u, { onUsage })))
        messages.push(...toToolMessages(results))
        if (i === maxContinuations - 2) messages.push({ role: 'user', content: TOOL_BUDGET_LANDING })
    }

    throw new Error(`OpenAI-compat stream tool loop exceeded maxContinuations (${maxContinuations})`)
}
