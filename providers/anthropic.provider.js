import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_MAX_CONTINUATIONS = 10

// ─── Tag suppressor ───────────────────────────────────────────────────────────
// Buffers streamed text and swallows <state>…</state> and <trade_idea>…</trade_idea>
// blocks so they never reach the UI.

function _createTagSuppressor(onToken) {
    const OPEN_TAGS  = ['<state>', '<trade_idea>']
    const CLOSE_TAGS = ['</state>', '</trade_idea>']

    let pending  = ''      // pre-tag lookahead buffer
    let inBlock  = false   // currently inside a suppressed block
    let closeTag = ''      // tag we're waiting for to end suppression

    function push(text) {
        pending += text
        _drain()
    }

    function _drain() {
        while (true) {
            if (inBlock) {
                const ci = pending.indexOf(closeTag)
                if (ci !== -1) {
                    // Found closing tag — discard everything up to and including it
                    pending  = pending.slice(ci + closeTag.length)
                    inBlock  = false
                    closeTag = ''
                    continue   // process remaining pending
                }
                // Close tag not yet complete — hold the entire buffer
                return
            }

            // Not in a block — look for an opening tag
            const ltIdx = pending.indexOf('<')
            if (ltIdx === -1) {
                // No '<' at all — safe to forward everything
                if (pending) { onToken(pending); pending = '' }
                return
            }

            // Flush everything before the '<'
            if (ltIdx > 0) {
                onToken(pending.slice(0, ltIdx))
                pending = pending.slice(ltIdx)
            }

            // pending now starts with '<' — check for a match
            let matched = false
            for (let i = 0; i < OPEN_TAGS.length; i++) {
                const tag = OPEN_TAGS[i]
                if (pending.startsWith(tag)) {
                    // Full open tag found → enter suppression
                    pending  = pending.slice(tag.length)
                    inBlock  = true
                    closeTag = CLOSE_TAGS[i]
                    matched  = true
                    break
                }
                // Buffer could still be a prefix of this tag → hold
                if (tag.startsWith(pending)) return
            }

            if (!matched) {
                // Not any suppress tag (and not a prefix) — emit the '<' and carry on
                onToken('<')
                pending = pending.slice(1)
            }
        }
    }

    function flush() {
        if (!inBlock && pending) onToken(pending)
        pending  = ''
        inBlock  = false
        closeTag = ''
    }

    return { push, flush }
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
}) {
    const messages   = _normalizeMessages(promptOrMessages)
    const suppressor = _createTagSuppressor(onToken)

    for (let i = 0; i < maxContinuations; i++) {
        const stream = client.messages.stream({
            model:      model ?? DEFAULT_MODEL,
            system:     systemPrompt,
            messages,
            tools,
            max_tokens: DEFAULT_MAX_TOKENS,
        })

        const contentBlocks = []
        let stopReason = null

        for await (const event of stream) {
            if (event.type === 'content_block_start') {
                contentBlocks[event.index] = { ...event.content_block }
            } else if (event.type === 'content_block_delta') {
                const block = contentBlocks[event.index]
                if (!block) continue
                if (event.delta.type === 'text_delta') {
                    block.text = (block.text || '') + event.delta.text
                    suppressor.push(event.delta.text)
                } else if (event.delta.type === 'input_json_delta') {
                    block._json = (block._json || '') + event.delta.partial_json
                }
            } else if (event.type === 'message_delta') {
                stopReason = event.delta.stop_reason
            }
        }

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
            const results = await Promise.all(toolUseBlocks.map(async b => {
                const handler = toolHandlers[b.name]
                const content = handler ? String(await handler(b.input)) : ''
                return { type: 'tool_result', tool_use_id: b.id, content }
            }))
            messages.push({ role: 'user', content: results })
            continue
        }

        suppressor.flush()
        return fullText
    }

    throw new Error(`Anthropic stream tool loop exceeded maxContinuations (${maxContinuations})`)
}

export async function callAnthropic(model, promptOrMessages, systemPrompt) {
    const messages = _normalizeMessages(promptOrMessages)
    const response = await client.messages.create({
        model: model ?? DEFAULT_MODEL,
        system: systemPrompt,
        messages,
        max_tokens: DEFAULT_MAX_TOKENS,
    })
    return _extractText(response.content)
}

export async function callAnthropicWithTools({
    model,
    promptOrMessages,
    systemPrompt,
    tools = [],
    toolHandlers = {},
    maxContinuations = DEFAULT_MAX_CONTINUATIONS,
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
            const results = await Promise.all(toolUseBlocks.map(async b => {
                const handler = toolHandlers[b.name]
                const content = handler ? String(await handler(b.input)) : ''
                return { type: 'tool_result', tool_use_id: b.id, content }
            }))
            messages.push({ role: 'user', content: results })
            continue
        }

        return _extractText(response.content)
    }

    throw new Error(`Anthropic tool loop exceeded maxContinuations (${maxContinuations})`)
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
