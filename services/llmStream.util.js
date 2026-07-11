// ─── Tag suppressor ───────────────────────────────────────────────────────────
// Provider-agnostic streamed-text processor. Buffers streamed text and swallows
// <state>…</state>, <trade_idea>…</trade_idea>, <asset>…</asset> (and the
// portfolio/ticker blocks) so they never reach the UI. Tags with an onCapture
// callback have their inner text captured and forwarded.
//
// Used by both the Anthropic and OpenAI streaming tool loops so the two providers
// expose identical streaming behavior to the agent services. Each agent passes its
// own `captures` array of tag descriptors ({ open, close, onCapture, keepText });
// the providers forward it verbatim with no agent-specific tag knowledge.

// ─── Emit-tag registry ────────────────────────────────────────────────────────
// Every emit tag ANY agent may produce. The tag suppressor must know about all of
// them so a stray tag from one agent never leaks raw into another agent's chat UI.
// buildTagCaptures() suppresses ALL of these by default; an agent overrides only
// the few it actually captures. This removes the old footgun where each agent
// hand-listed its tags and a forgotten entry leaked `<state>`-style JSON to users.
export const ALL_EMIT_TAGS = [
    'state', 'trade_idea', 'asset', 'interval', 'phase', 'ticker',
    'portfolio_plan', 'portfolio_update', 'portfolio_mandate', 'portfolio_thesis',
    'scan_list', 'call',
]

// Build the tag-capture descriptor array for a streaming agent. `overrides` maps a
// tag name to either a capture callback, or `{ onCapture, keepText }` for tags whose
// inner text should still reach the UI (e.g. <ticker>). Unlisted tags are suppress-only.
export function buildTagCaptures(overrides = {}) {
    return ALL_EMIT_TAGS.map(name => {
        const base = { open: `<${name}>`, close: `</${name}>`, onCapture: null }
        const ov = overrides[name]
        if (ov == null) return base
        if (typeof ov === 'function') return { ...base, onCapture: ov }
        return { ...base, onCapture: ov.onCapture ?? null, keepText: ov.keepText ?? false }
    })
}

export function createTagSuppressor({ onToken, captures = [] }) {
    // onToken is optional: non-streaming callers (e.g. the Axl social-chat reply,
    // which collects the full return value instead of streaming) omit it. Default
    // to a no-op so emitting text never throws — the suppressor still buffers and
    // swallows tag blocks, and the provider returns the accumulated text as usual.
    const emit = onToken ?? (() => {})
    const TAGS = captures

    let pending         = ''     // pre-tag lookahead buffer
    let inBlock         = false  // currently inside a suppressed block
    let closeTag        = ''     // tag we're waiting for to end suppression
    let captureCallback = null   // non-null when current block content should be forwarded
    let keepText        = false  // true when the block's inner text should still reach the UI (e.g. <ticker>)

    function push(text) {
        pending += text
        _drain()
    }

    function _drain() {
        while (true) {
            if (inBlock) {
                const ci = pending.indexOf(closeTag)
                if (ci !== -1) {
                    const content = pending.slice(0, ci)
                    if (captureCallback) {
                        const trimmed = content.trim()
                        if (trimmed) captureCallback(trimmed)
                        captureCallback = null
                    }
                    if (keepText && content) emit(content)
                    pending  = pending.slice(ci + closeTag.length)
                    inBlock  = false
                    closeTag = ''
                    keepText = false
                    continue
                }
                // Close tag not yet arrived — hold the entire buffer
                return
            }

            const ltIdx = pending.indexOf('<')
            if (ltIdx === -1) {
                if (pending) { emit(pending); pending = '' }
                return
            }

            if (ltIdx > 0) {
                emit(pending.slice(0, ltIdx))
                pending = pending.slice(ltIdx)
            }

            let matched = false
            for (const tag of TAGS) {
                if (pending.startsWith(tag.open)) {
                    pending         = pending.slice(tag.open.length)
                    inBlock         = true
                    closeTag        = tag.close
                    captureCallback = tag.onCapture ?? null
                    keepText        = tag.keepText ?? false
                    matched         = true
                    break
                }
                if (tag.open.startsWith(pending)) return  // possible prefix — hold
            }

            if (!matched) {
                emit('<')
                pending = pending.slice(1)
            }
        }
    }

    function flush() {
        if (!inBlock && pending) emit(pending)
        pending         = ''
        inBlock         = false
        closeTag        = ''
        captureCallback = null
        keepText        = false
    }

    return { push, flush }
}
