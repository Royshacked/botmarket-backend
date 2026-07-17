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
    tagCaptures = [],
    onToolStart,
    onReasoning,
    onUsage,
    reasoningEffort,
    signal,
}) {
    const messages   = _normalizeMessages(promptOrMessages)
    const suppressor = createTagSuppressor({ onToken, captures: tagCaptures })
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
                        // Accumulate the model's reasoning (kept with its signature below
                        // so the thinking block can be echoed back intact on the next tool
                        // turn, which the API requires) and stream it to onReasoning so the
                        // UI can surface it live, the same way tokens/status are surfaced.
                        // It is never sent to onToken — the visible reply stays separate.
                        block.thinking = (block.thinking || '') + event.delta.thinking
                        onReasoning?.(event.delta.thinking)
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

        // Finalise tool blocks (merge streamed partial JSON into `input`, strip the scratch field).
        _finalizeToolBlocks(contentBlocks)

        const validBlocks = contentBlocks.filter(Boolean)
        const fullText    = validBlocks.filter(b => b.type === 'text').map(b => b.text || '').join('')

        if (stopReason === 'end_turn') {
            suppressor.flush()
            return fullText
        }

        if (stopReason === 'pause_turn') {
            _compactPriorToolResults(messages)
            messages.push({ role: 'assistant', content: _compactServerResults(validBlocks) })
            continue
        }

        if (stopReason === 'tool_use') {
            const toolUseBlocks = validBlocks.filter(b => b.type === 'tool_use')
            _compactPriorToolResults(messages)
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
            _compactPriorToolResults(messages)
            messages.push({ role: 'assistant', content: _compactServerResults(response.content) })
            continue
        }

        if (response.stop_reason === 'tool_use') {
            const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')
            _compactPriorToolResults(messages)
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

// Finalise streamed tool_use / server_tool_use blocks: merge the accumulated partial-JSON scratch
// field (`_json`) into `input`, then ALWAYS strip `_json` once it exists — even when it's the empty
// string. A no-argument tool (e.g. get_macro_snapshot) streams an empty input_json_delta, so `_json`
// ends up `''`; a truthiness check would skip the delete and leave `_json: ''` on the block, which the
// API rejects when the block is echoed back on the next tool round ("tool_use._json: Extra inputs are
// not permitted"). An empty `_json` keeps the block's initial `input` ({} from content_block_start).
// Mutates in place. Pure over its input; exported for testing.
export function _finalizeToolBlocks(contentBlocks) {
    for (const block of (contentBlocks ?? [])) {
        if (!block || !('_json' in block)) continue
        try { block.input = block._json ? JSON.parse(block._json) : (block.input ?? {}) }
        catch { block.input = {} }
        delete block._json
    }
    return contentBlocks
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

// Cap web search result text carried into subsequent continuations. The model
// already read the full content on the turn it arrived; we only truncate what
// goes back into the messages array for later turns, where verbatim raw results
// add input tokens without adding new information.
const _SEARCH_RESULT_CHARS = 3000
function _compactServerResults(blocks) {
    return blocks.map(block => {
        if (block.type !== 'server_tool_result') return block
        if (Array.isArray(block.content)) {
            return {
                ...block,
                content: block.content.map(c =>
                    c.type === 'text' && c.text?.length > _SEARCH_RESULT_CHARS
                        ? { ...c, text: c.text.slice(0, _SEARCH_RESULT_CHARS) + '\n[truncated]' }
                        : c
                ),
            }
        }
        if (typeof block.content === 'string' && block.content.length > _SEARCH_RESULT_CHARS) {
            return { ...block, content: block.content.slice(0, _SEARCH_RESULT_CHARS) + '\n[truncated]' }
        }
        return block
    })
}

// Within one tool loop the messages array accumulates every client tool_result.
// Once the model has consumed a result, re-sending it verbatim on each later
// continuation just re-bills input — a base64 get_chart image (~1.5k image
// tokens) is the worst offender. Shrink already-consumed tool_result blocks:
// drop images to a short placeholder, truncate long text. Safe to call at the
// top of a tool_use/pause_turn branch — every result already in `messages` was
// visible to the call that just returned, so none are awaiting a first read.
// The fresh results are appended raw afterwards, so they reach the model in full.
function _compactPriorToolResults(messages) {
    for (const msg of messages) {
        if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue
        msg.content = msg.content.map(_compactToolResultBlock)
    }
}

// Idempotent: a block already compacted has no image and short text, so a
// repeat pass returns it unchanged — no marker field needed (and none must be
// added, since the block is sent verbatim to the API on the next call).
function _compactToolResultBlock(block) {
    if (!block || block.type !== 'tool_result') return block
    const content = block.content
    if (Array.isArray(content)) {
        let changed = false
        const next = content.map(c => {
            if (c?.type === 'image') {
                changed = true
                return { type: 'text', text: '[image omitted from history — already analyzed]' }
            }
            if (c?.type === 'text' && c.text?.length > _SEARCH_RESULT_CHARS) {
                changed = true
                return { ...c, text: c.text.slice(0, _SEARCH_RESULT_CHARS) + '\n[truncated]' }
            }
            return c
        })
        return changed ? { ...block, content: next } : block
    }
    if (typeof content === 'string' && content.length > _SEARCH_RESULT_CHARS) {
        return { ...block, content: content.slice(0, _SEARCH_RESULT_CHARS) + '\n[truncated]' }
    }
    return block
}
