import OpenAI from 'openai'
import { createTagSuppressor } from '../services/llmStream.util.js'

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

const DEFAULT_SYSTEM_PROMPT =
    process.env.OPENAI_SYSTEM_PROMPT?.trim() || 'You are a helpful assistant.'

const DEFAULT_MAX_TOOL_TURNS = 12

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system'])



export async function callOpenAI(model, promptOrMessages, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
    const response = await client.responses.create({
        model,
        input: normalizeInput(promptOrMessages, systemPrompt),
    })

    return response.output_text ?? ''
}

export async function callOpenAIWithTools({
    model,
    promptOrMessages,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    tools,
    executeTool,
    tool_choice = 'auto',
    maxTurns = DEFAULT_MAX_TOOL_TURNS,
}) {
    let input = normalizeInput(promptOrMessages, systemPrompt)

    for (let turn = 0; turn < maxTurns; turn++) {
        const response = await client.responses.create({
            model,
            input,
            tools,
            tool_choice,
        })

        const functionCalls = (response.output ?? []).filter((item) => item?.type === 'function_call')

        if (functionCalls.length === 0) {
            return response.output_text ?? ''
        }

        input = [...input, ...(response.output ?? [])]

        for (const call of functionCalls) {
            const callId = call.call_id
            const toolId = call.name

            let args = {}
            try {
                args = call.arguments ? JSON.parse(call.arguments) : {}
            } catch {
                input.push({
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify({ error: `Invalid JSON arguments for ${toolId}` }),
                })
                continue
            }

            try {
                const outcome = await executeTool(toolId, args)
                const output = outcome.ok
                    ? JSON.stringify(outcome.result ?? null)
                    : JSON.stringify({ error: outcome.error ?? 'Tool execution failed' })
                input.push({ type: 'function_call_output', call_id: callId, output })
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                input.push({
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify({ error: message }),
                })
            }
        }
    }

    throw new Error(`OpenAI tool loop exceeded maxTurns (${maxTurns})`)
}

// ─── Streaming tool loop ──────────────────────────────────────────────────────
// Mirrors streamAnthropicWithTools' signature exactly so the agent services can
// route to either provider with no other changes. Calls onToken(text) for each
// streamed chunk (with <state>/<trade_idea>/… blocks suppressed via the shared
// tag suppressor) and returns the full accumulated reply text of the final turn.
//
// `tools` are authored in the Anthropic shape used by the agents; _toOpenAITools
// converts them to the OpenAI Responses format (and swaps the web_search server
// tool for OpenAI's native one). `toolHandlers` is the same name→async-fn map the
// agents already pass (each handler returns a string).

export async function streamOpenAIWithTools({
    model,
    promptOrMessages,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    tools = [],
    toolHandlers = {},
    maxContinuations = DEFAULT_MAX_TOOL_TURNS,
    onToken,
    onAsset,
    onInterval,
    onTicker,
    onPlan,
    onUpdate,
}) {
    let input          = normalizeInput(promptOrMessages, systemPrompt)
    const openAITools  = _toOpenAITools(tools)
    const suppressor   = createTagSuppressor(onToken, onAsset, onInterval, onTicker, onPlan, onUpdate)

    for (let i = 0; i < maxContinuations; i++) {
        const stream = client.responses.stream({
            model,
            input,
            ...(openAITools.length ? { tools: openAITools } : {}),
        })

        // Accumulate this turn's text from the deltas — finalResponse().output_text
        // is not reliably populated for streamed responses, and the agents parse
        // <state>/<trade_idea> out of the returned text, so we must capture it here.
        let turnText = ''
        for await (const event of stream) {
            if (event.type === 'response.output_text.delta' && event.delta) {
                turnText += event.delta
                suppressor.push(event.delta)
            }
        }

        const final         = await stream.finalResponse()
        const functionCalls  = (final.output ?? []).filter((item) => item?.type === 'function_call')

        if (functionCalls.length === 0) {
            suppressor.flush()
            return turnText || (final.output_text ?? '')
        }

        // Preserve the model's output items (function_call + any reasoning) in the
        // conversation, then append a result for each call. The SDK enriches
        // function_call items with a client-side `parsed_arguments` field that the
        // API rejects when echoed back, so rebuild those to their minimal shape.
        const outputItems = (final.output ?? []).map((item) => {
            if (item?.type !== 'function_call') return item
            return {
                type:      'function_call',
                call_id:   item.call_id,
                name:      item.name,
                arguments: item.arguments,
                ...(item.id ? { id: item.id } : {}),
            }
        })
        input = [...input, ...outputItems]

        await Promise.all(functionCalls.map(async (call) => {
            let args = {}
            try { args = call.arguments ? JSON.parse(call.arguments) : {} }
            catch {
                input.push({ type: 'function_call_output', call_id: call.call_id, output: `Invalid JSON arguments for ${call.name}` })
                return
            }
            const handler = toolHandlers[call.name]
            let output = ''
            try { output = handler ? String(await handler(args)) : '' }
            catch (err) { output = `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}` }
            input.push({ type: 'function_call_output', call_id: call.call_id, output })
        }))
    }

    throw new Error(`OpenAI stream tool loop exceeded maxContinuations (${maxContinuations})`)
}

/**
 * Convert the agents' Anthropic-shaped tool defs to the OpenAI Responses format.
 * - { name, description, input_schema }      → { type:'function', name, description, parameters }
 * - { type:'web_search_20250305', ... }       → OpenAI's native { type:'web_search' }
 * - anything already in OpenAI shape passes through unchanged.
 */
function _toOpenAITools(tools = []) {
    return tools.map((t) => {
        if (typeof t?.type === 'string' && t.type.startsWith('web_search')) {
            return { type: 'web_search' }
        }
        if (t?.input_schema) {
            return {
                type:        'function',
                name:        t.name,
                description: t.description,
                parameters:  t.input_schema,
            }
        }
        return t
    })
}

/**
 * String prompt → [system, user]. Array → typed messages; inject system if missing.
 */

// The agents may pass systemPrompt as Anthropic-style content blocks (used to
// mark a cache_control breakpoint for prompt caching). OpenAI wants a plain
// string, so flatten a block array to its concatenated text.
function _systemPromptToText(sp) {
    if (Array.isArray(sp)) return sp.map(b => (typeof b === 'string' ? b : b?.text || '')).join('\n\n')
    return sp
}

function normalizeInput(promptOrMessages, systemPrompt) {
    const resolvedSystemPrompt = _systemPromptToText(systemPrompt) ?? DEFAULT_SYSTEM_PROMPT

    const toTypedContent = (content, role) => {
        if (Array.isArray(content)) return content
        const type = role === 'assistant' ? 'output_text' : 'input_text'
        if (typeof content === 'string') return [{ type, text: content }]
        if (content == null) return [{ type, text: '' }]
        return [{ type, text: String(content) }]
    }

    if (Array.isArray(promptOrMessages)) {
        const normalized = promptOrMessages.map((m) => {
            const role = m?.role
            if (!ALLOWED_ROLES.has(role)) {
                throw new Error(`Invalid message role: ${role}`)
            }
            return { role, content: toTypedContent(m.content, role) }
        })

        const hasSystem = normalized.some((m) => m.role === 'system')
        if (!hasSystem && resolvedSystemPrompt) {
            normalized.unshift({
                role: 'system',
                content: toTypedContent(resolvedSystemPrompt, 'system'),
            })
        }

        return normalized
    }

    return [
        { role: 'system', content: toTypedContent(resolvedSystemPrompt, 'system') },
        { role: 'user', content: toTypedContent(promptOrMessages, 'user') },
    ]
}
