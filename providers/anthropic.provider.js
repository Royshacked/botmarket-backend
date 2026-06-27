import Anthropic from '@anthropic-ai/sdk'
import { createTagSuppressor } from '../services/llmStream.util.js'
import { isToolError, toolErrorText } from '../services/toolResult.util.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = 8192
// When thinking is on, reasoning tokens count toward max_tokens, so give the
// model headroom for both the hidden reasoning and the full visible reply.
const THINKING_MAX_TOKENS = 16000
const DEFAULT_MAX_CONTINUATIONS = 10

// Map the abstract reasoning-effort knob onto adaptive extended thinking. 'off'
// (or undefined) → no thinking block at all, so we pay for zero reasoning
// tokens. low/high → adaptive thinking with the matching effort level.
//
// We use adaptive thinking (not a fixed budget_tokens) because budget_tokens is
// removed on the Opus 4.7/4.8 family — sending it 400s the request (that was the
// "streaming failed" bug in Opus deep-think mode). Adaptive + effort is the
// supported path across both Opus 4.8 and Sonnet 4.6.
const EFFORT_LEVELS = { low: 'low', high: 'high' }
function _thinkingConfig(reasoningEffort) {
    const effort = EFFORT_LEVELS[reasoningEffort]
    return effort
        ? { thinking: { type: 'adaptive' }, output_config: { effort } }
        : null
}

// ─── Streaming tool loop ──────────────────────────────────────────────────────
// Like callAnthropicWithTools but calls onToken(text) for each streamed chunk,
// suppressing <state>/<trade_idea> blocks.  Returns the full accumulated text.

export async function streamAnthropicWithTools({
    model,
    promptOrMessages,
    systemPrompt,
    tools = [],
    toolHandlers = {},
    maxContinuations = DEFAULT_MAX_CONTINUATIONS,
    onToken,
    onAsset,
    onInterval,
    onTicker,
    onPlan,
    onUpdate,
    onScan,
    onMandate,
    onToolStart,
    onUsage,
    reasoningEffort,
    signal,
}) {
    const messages   = _normalizeMessages(promptOrMessages)
    const suppressor = createTagSuppressor(onToken, onAsset, onInterval, onTicker, onPlan, onUpdate, onScan, onMandate)
    const reasoning  = _thinkingConfig(reasoningEffort)

    for (let i = 0; i < maxContinuations; i++) {
        // Client disconnected (user hit Stop) — end the loop instead of burning
        // another model call / tool round.
        if (signal?.aborted) { suppressor.flush(); return '' }

        const stream = client.messages.stream({
            model:      model ?? DEFAULT_MODEL,
            system:     systemPrompt,
            messages,
            tools,
            max_tokens: reasoning ? THINKING_MAX_TOKENS : DEFAULT_MAX_TOKENS,
            ...(reasoning ?? {}),
        }, signal ? { signal } : undefined)

        const contentBlocks = []
        let stopReason = null
        let turnUsage  = null

        try {
            for await (const event of stream) {
                if (event.type === 'message_start') {
                    const u = event.message?.usage
                    if (u) turnUsage = { input_tokens: u.input_tokens ?? 0, output_tokens: 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 }
                } else if (event.type === 'content_block_start') {
                    contentBlocks[event.index] = { ...event.content_block }
                    // Surface a tool call as soon as its block opens so the UI can
                    // show a "Analyzing…" status chip without the model spending
                    // output tokens narrating it. Covers client tools (tool_use)
                    // and server tools like web_search (server_tool_use).
                    const cb = event.content_block
                    if (cb && (cb.type === 'tool_use' || cb.type === 'server_tool_use') && cb.name) {
                        onToolStart?.(cb.name)
                    }
                } else if (event.type === 'content_block_delta') {
                    const block = contentBlocks[event.index]
                    if (!block) continue
                    if (event.delta.type === 'text_delta') {
                        block.text = (block.text || '') + event.delta.text
                        suppressor.push(event.delta.text)
                    } else if (event.delta.type === 'input_json_delta') {
                        block._json = (block._json || '') + event.delta.partial_json
                    } else if (event.delta.type === 'thinking_delta') {
                        // Accumulate the model's reasoning but never push it to onToken
                        // — it stays hidden from the UI. We keep it (with its signature
                        // below) so the thinking block can be echoed back intact on the
                        // next tool turn, which the API requires.
                        block.thinking = (block.thinking || '') + event.delta.thinking
                    } else if (event.delta.type === 'signature_delta') {
                        block.signature = (block.signature || '') + event.delta.signature
                    }
                } else if (event.type === 'message_delta') {
                    stopReason = event.delta.stop_reason
                    if (turnUsage && event.usage?.output_tokens) turnUsage.output_tokens = event.usage.output_tokens
                }
            }
        } catch (err) {
            // A user-initiated stop aborts the underlying request — return the
            // partial text cleanly rather than throwing.
            if (signal?.aborted || err?.name === 'AbortError') {
                suppressor.flush()
                return contentBlocks.filter(Boolean).filter(b => b.type === 'text').map(b => b.text || '').join('')
            }
            throw err
        }

        if (turnUsage) onUsage?.(turnUsage)

        // Finalise tool blocks (merge partial JSON) — covers both tool_use and server_tool_use
        for (const block of contentBlocks) {
            if (block && block._json) {
                try { block.input = JSON.parse(block._json) } catch { block.input = {} }
                delete block._json
            }
        }

        const validBlocks = contentBlocks.filter(Boolean)
        const fullText    = validBlocks.filter(b => b.type === 'text').map(b => b.text || '').join('')

        if (stopReason === 'end_turn') {
            suppressor.flush()
            return fullText
        }

        if (stopReason === 'pause_turn') {
            messages.push({ role: 'assistant', content: validBlocks })
            continue
        }

        if (stopReason === 'tool_use') {
            const toolUseBlocks = validBlocks.filter(b => b.type === 'tool_use')
            messages.push({ role: 'assistant', content: validBlocks })
            const results = await Promise.all(toolUseBlocks.map(b => _runTool(toolHandlers, b)))
            messages.push({ role: 'user', content: results })
            continue
        }

        suppressor.flush()
        return fullText
    }

    throw new Error(`Anthropic stream tool loop exceeded maxContinuations (${maxContinuations})`)
}

export async function callAnthropic(model, promptOrMessages, systemPrompt, { onUsage } = {}) {
    const messages = _normalizeMessages(promptOrMessages)
    const response = await client.messages.create({
        model: model ?? DEFAULT_MODEL,
        system: systemPrompt,
        messages,
        max_tokens: DEFAULT_MAX_TOKENS,
    })
    onUsage?.(response.usage)
    return _extractText(response.content)
}

export async function callAnthropicWithTools({
    model,
    promptOrMessages,
    systemPrompt,
    tools = [],
    toolHandlers = {},
    maxContinuations = DEFAULT_MAX_CONTINUATIONS,
    onUsage,
}) {
    const messages = _normalizeMessages(promptOrMessages)

    for (let i = 0; i < maxContinuations; i++) {
        const response = await client.messages.create({
            model: model ?? DEFAULT_MODEL,
            system: systemPrompt,
            messages,
            tools,
            max_tokens: DEFAULT_MAX_TOKENS,
        })

        onUsage?.(response.usage)

        if (response.stop_reason === 'end_turn') {
            return _extractText(response.content)
        }

        if (response.stop_reason === 'pause_turn') {
            messages.push({ role: 'assistant', content: response.content })
            continue
        }

        if (response.stop_reason === 'tool_use') {
            const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')
            messages.push({ role: 'assistant', content: response.content })
            const results = await Promise.all(toolUseBlocks.map(b => _runTool(toolHandlers, b)))
            messages.push({ role: 'user', content: results })
            continue
        }

        return _extractText(response.content)
    }

    throw new Error(`Anthropic tool loop exceeded maxContinuations (${maxContinuations})`)
}

// Allow tool handlers to return either a plain string or rich content blocks
// (e.g. an image). Strings stay strings; arrays/objects pass through as-is so
// the Anthropic API renders them as tool_result content blocks.
function _toToolResultContent(ret) {
    if (ret == null) return ''
    if (typeof ret === 'string') return ret
    if (Array.isArray(ret)) return ret          // already a list of content blocks
    if (ret.type) return [ret]                  // single content block → wrap
    return String(ret)
}

// Run one tool and build its tool_result block. A toolError() return — or a
// thrown error — becomes an is_error result so the model treats it as a failed
// call, not as data.
async function _runTool(toolHandlers, block) {
    const handler = toolHandlers[block.name]
    if (!handler) return _errorResult(block.id, `no handler for tool ${block.name}`)
    try {
        const ret = await handler(block.input)
        if (isToolError(ret)) return _errorResult(block.id, toolErrorText(ret))
        return { type: 'tool_result', tool_use_id: block.id, content: _toToolResultContent(ret) }
    } catch (err) {
        return _errorResult(block.id, err?.message ?? 'tool failed')
    }
}

function _errorResult(toolUseId, message) {
    return { type: 'tool_result', tool_use_id: toolUseId, content: `ERROR: ${message}`, is_error: true }
}

function _normalizeMessages(promptOrMessages) {
    if (typeof promptOrMessages === 'string') return [{ role: 'user', content: promptOrMessages }]
    if (Array.isArray(promptOrMessages))
        return promptOrMessages.map((m) => ({ role: m.role, content: m.content }))
    return []
}

function _extractText(content) {
    return content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
}
