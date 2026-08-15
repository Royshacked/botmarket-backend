import Anthropic from '@anthropic-ai/sdk'
import { createTagSuppressor } from '../services/llmStream.util.js'
import { isToolError, toolErrorText } from '../services/toolResult.util.js'
import { config } from '../services/config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })
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

// Models that reason whether or not we ask. Omitting the thinking block does NOT mean "no
// reasoning" on these the way it does on Sonnet 4.6 / Opus 4.8 — they reason anyway, those
// tokens count against max_tokens, and DEFAULT_MAX_TOKENS would truncate the reply mid-answer.
// So an 'off' effort floors to 'low' here, which also buys THINKING_MAX_TOKENS.
//
// This matters far more now that reasoning is not user-selectable: EVERY request arrives with
// no effort, so a model in this set that were missing from it would silently run at its own
// default effort on the smaller token budget.
//   • Opus 5    — reasons by default. Turning thinking explicitly off is the worse fix: with
//                 thinking disabled it can emit a tool call as plain text instead of a tool_use
//                 block, so the call silently never runs — fatal for tool-driven agents.
//   • Sonnet 5  — REVERSED from Sonnet 4.6: omitting `thinking` runs adaptive at effort `high`,
//                 where 4.6 ran thinking-off. Without this entry a Sonnet 5 turn would think at
//                 high effort against DEFAULT_MAX_TOKENS.
// Sonnet 4.6 and Opus 4.8 are deliberately absent — they genuinely run thinking-off when the
// field is omitted, which is what we want when nothing asks for reasoning.
const THINKS_BY_DEFAULT = new Set(['claude-opus-5', 'claude-sonnet-5'])
const FLOOR_EFFORT = 'low'

export function _thinkingConfig(reasoningEffort, model) {
    const effort = EFFORT_LEVELS[reasoningEffort]
        ?? (THINKS_BY_DEFAULT.has(model) ? FLOOR_EFFORT : null)
    return effort
        ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } }
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
    const historyLen = messages.length
    const suppressor = createTagSuppressor({ onToken, captures: tagCaptures })
    const reasoning  = _thinkingConfig(reasoningEffort, model ?? DEFAULT_MODEL)

    for (let i = 0; i < maxContinuations; i++) {
        // Client disconnected (user hit Stop) — end the loop instead of burning
        // another model call / tool round.
        if (signal?.aborted) { suppressor.flush(); return '' }

        // Walk the breakpoint forward so this round reads the rounds before it instead of
        // re-paying for them. mutableTail defaults to 1 — this loop compacts.
        advanceToolLoopCache(messages, historyLen)

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

// The non-streaming twin of streamAnthropicWithTools. Currently has NO callers — every desk and
// monitor streams — but it is kept in step with the streaming loop rather than left behind: the
// two differ only in transport, and a copy that silently lacks the tool-loop cache handling is
// how the next caller gets the expensive behaviour back without anyone noticing.
export async function callAnthropicWithTools({
    model,
    promptOrMessages,
    systemPrompt,
    tools = [],
    toolHandlers = {},
    maxContinuations = DEFAULT_MAX_CONTINUATIONS,
    onUsage,
}) {
    const messages   = _normalizeMessages(promptOrMessages)
    const historyLen = messages.length

    for (let i = 0; i < maxContinuations; i++) {
        advanceToolLoopCache(messages, historyLen)

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
// (e.g. an image). Strings stay strings; arrays/content blocks pass through as-is
// so the Anthropic API renders them as tool_result content blocks.
//
// A PLAIN OBJECT is serialized, never String()-ed. `String({a:1})` is
// "[object Object]" — a valid, silent, information-free tool result: the call
// succeeds, the model is told nothing, and it answers "I don't know" about data
// the app had in hand. Tools here are expected to return model-ready TEXT (see
// userData.tools.js on the adapter/read split), but a handler that returns its
// service's object must degrade to readable JSON, not to a placeholder.
// Exported for testing — this is the seam where a tool's return value becomes what the model reads,
// and it had no coverage at all while it was quietly emitting "[object Object]".
export function _toToolResultContent(ret) {
    if (ret == null) return ''
    if (typeof ret === 'string') return ret
    if (Array.isArray(ret)) return ret          // already a list of content blocks
    if (ret.type) return [ret]                  // single content block → wrap
    if (typeof ret === 'object') {
        try { return JSON.stringify(ret) } catch { return String(ret) }   // circular → last resort
    }
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
        return _stampHistoryCache(promptOrMessages.map((m) => ({ role: m.role, content: m.content })))
    return []
}

/**
 * Mark the end of the conversation history as a prompt-cache breakpoint. Pure; exported for tests.
 *
 * Every agent already caches its SYSTEM prompt, and none of them cached the conversation — so turn
 * 9 re-read turns 1–8 at full price, and the longer the desk session ran the more it cost. Caching
 * is a prefix match over `tools → system → messages`, so a breakpoint on the last history turn lets
 * every following turn read the whole conversation at ~0.1×.
 *
 * It lives HERE, at the provider boundary, because `cache_control` is Anthropic's — the agents are
 * multi-provider and must not learn about it. One stamp, every agent, no per-agent wiring.
 *
 * Placed once, on the way in. From there the tool loop MOVES it forward rather than adding a second
 * one — see _frozenCacheTarget / _restampToolLoopCache below, which is what makes a deep tool loop
 * read its own earlier rounds instead of re-paying for them.
 *
 * BUDGET: the API allows FOUR breakpoints per request and the agents already spend up to three (one
 * on the tool list, one or two on the system prompt — Atlas and Kairos use two). This is the fourth.
 * A new system-prompt breakpoint anywhere would push a request over the limit and it would be
 * rejected, so add one only by taking one away.
 *
 * Skipped below two messages: a first turn has no prior conversation to reuse, and a breakpoint
 * there would occupy a slot to cache something nothing will ever read.
 */
export function _stampHistoryCache(messages) {
    if (messages.length < 2) return messages
    const last = messages[messages.length - 1]
    const stamped = typeof last.content === 'string'
        ? [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
        : Array.isArray(last.content) && last.content.length
            ? last.content.map((b, i) =>
                (i === last.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b))
            : null
    if (!stamped) return messages
    return [...messages.slice(0, -1), { ...last, content: stamped }]
}

/**
 * Walk the ONE message-level cache breakpoint forward as a tool loop grows. THE entry point —
 * every tool loop in the app calls this and nothing re-implements it.
 *
 * A tool loop appends an assistant `tool_use` turn and a user `tool_result` turn per round, all of
 * it AFTER the history breakpoint, so round 9 re-reads rounds 1–8 at full price. That is the bulk
 * of the uncached prompt spend on the tool-heavy desks — not prompt assembly.
 *
 * `mutableTail` is how many of the newest user turns may STILL CHANGE after being sent, and it is
 * the only thing that differs between callers:
 *
 *   • 1 (default) — the desk loop below, which runs `_compactPriorToolResults`: it rewrites
 *     already-sent results in place (images to a placeholder, long text truncated). A breakpoint
 *     on the newest result is invalidated by that rewrite a round later, so we would pay a write
 *     every round and never read it back. Compaction is idempotent, so the turn BEFORE the newest
 *     is frozen — that is as far as the breakpoint can safely reach.
 *   • 0 — the monitors (hermes/talos), which never rewrite a result. Nothing is mutable, so the
 *     newest turn is already frozen and the breakpoint can sit on it: one extra round of coverage.
 *
 * Set it wrong and the failure is silent and expensive — a breakpoint on bytes that keep changing
 * writes a cache entry per round that nothing ever reads.
 *
 * @returns {boolean} whether the breakpoint moved
 */
export function advanceToolLoopCache(messages, historyLen, { mutableTail = 1 } = {}) {
    const target = _frozenCacheTarget(messages, historyLen, mutableTail)
    if (target === -1) return false
    return _restampToolLoopCache(messages, target)
}

/**
 * The furthest frozen user turn the breakpoint can reach. Pure; exported for tests.
 *
 * Returns -1 until enough user turns exist to clear `mutableTail`, which is also what keeps the
 * earliest rounds alone — at that depth there is nothing behind the frontier worth a write.
 *
 * Scans for the turn rather than computing an offset because a `pause_turn` round pushes ONE
 * message instead of two, so index arithmetic drifts out of phase the moment a server tool pauses.
 */
export function _frozenCacheTarget(messages, historyLen, mutableTail = 1) {
    let seen = 0
    for (let i = messages.length - 1; i >= historyLen; i--) {
        if (messages[i]?.role !== 'user') continue
        if (++seen > mutableTail) return i
    }
    return -1
}

/**
 * Move the ONE message-level breakpoint onto `targetIdx`. Mutates; exported for tests.
 *
 * Strips every existing message-level stamp before placing the new one, so the count is right by
 * construction rather than by bookkeeping. That matters more than it looks: the budget is four
 * breakpoints per request and the agents already spend up to three (tool list + one or two system
 * blocks), so an accidental second message stamp is a production-only 400 on exactly the longest
 * conversations — the ones this is meant to make cheaper.
 *
 * Returns whether it moved the breakpoint.
 */
export function _restampToolLoopCache(messages, targetIdx) {
    const target = messages[targetIdx]
    if (!Array.isArray(target?.content) || !target.content.length) return false

    for (const msg of messages) {
        if (!Array.isArray(msg?.content)) continue
        msg.content = msg.content.map(b => {
            if (!b?.cache_control) return b
            const { cache_control, ...rest } = b
            return rest
        })
    }

    // Re-read after the strip: the loop above replaced the array on every message, target included.
    const content = messages[targetIdx].content
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } }
    return true
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
// Exported for tests: the tool-loop breakpoint above is placed entirely on the strength of this
// function's two properties — that it rewrites a result exactly once, and that a block it rewrites
// keeps its `cache_control`. Both are pinned in promptCacheHistory.test.js.
export function _compactPriorToolResults(messages) {
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
