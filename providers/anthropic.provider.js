import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_MAX_CONTINUATIONS = 10

// ─── Tag suppressor ───────────────────────────────────────────────────────────
// Buffers streamed text and swallows <state>…</state>, <trade_idea>…</trade_idea>,
// and <asset>…</asset> blocks so they never reach the UI.
// Tags with an onCapture callback have their inner text captured and forwarded.

function _createTagSuppressor(onToken, onAsset, onInterval, onTicker, onPlan, onUpdate) {
    const TAGS = [
        { open: '<state>',               close: '</state>',               onCapture: null       },
        { open: '<trade_idea>',          close: '</trade_idea>',          onCapture: null       },
        { open: '<asset>',               close: '</asset>',               onCapture: onAsset    },
        { open: '<interval>',            close: '</interval>',            onCapture: onInterval },
        ...(onTicker ? [{ open: '<ticker>',            close: '</ticker>',            onCapture: onTicker }] : []),
        ...(onPlan   ? [{ open: '<portfolio_plan>',    close: '</portfolio_plan>',    onCapture: onPlan   }] : []),
        ...(onUpdate ? [{ open: '<portfolio_update>',  close: '</portfolio_update>',  onCapture: onUpdate }] : []),
    ]

    let pending         = ''     // pre-tag lookahead buffer
    let inBlock         = false  // currently inside a suppressed block
    let closeTag        = ''     // tag we're waiting for to end suppression
    let captureCallback = null   // non-null when current block content should be forwarded

    function push(text) {
        pending += text
        _drain()
    }

    function _drain() {
        while (true) {
            if (inBlock) {
                const ci = pending.indexOf(closeTag)
                if (ci !== -1) {
                    if (captureCallback) {
                        const content = pending.slice(0, ci).trim()
                        if (content) captureCallback(content)
                        captureCallback = null
                    }
                    pending  = pending.slice(ci + closeTag.length)
                    inBlock  = false
                    closeTag = ''
                    continue
                }
                // Close tag not yet arrived — hold the entire buffer
                return
            }

            const ltIdx = pending.indexOf('<')
            if (ltIdx === -1) {
                if (pending) { onToken(pending); pending = '' }
                return
            }

            if (ltIdx > 0) {
                onToken(pending.slice(0, ltIdx))
                pending = pending.slice(ltIdx)
            }

            let matched = false
            for (const tag of TAGS) {
                if (pending.startsWith(tag.open)) {
                    pending         = pending.slice(tag.open.length)
                    inBlock         = true
                    closeTag        = tag.close
                    captureCallback = tag.onCapture ?? null
                    matched         = true
                    break
                }
                if (tag.open.startsWith(pending)) return  // possible prefix — hold
            }

            if (!matched) {
                onToken('<')
                pending = pending.slice(1)
            }
        }
    }

    function flush() {
        if (!inBlock && pending) onToken(pending)
        pending         = ''
        inBlock         = false
        closeTag        = ''
        captureCallback = null
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
    onAsset,
    onInterval,
    onTicker,
    onPlan,
    onUpdate,
}) {
    const messages   = _normalizeMessages(promptOrMessages)
    const suppressor = _createTagSuppressor(onToken, onAsset, onInterval, onTicker, onPlan, onUpdate)

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
