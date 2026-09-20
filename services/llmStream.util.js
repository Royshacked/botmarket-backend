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

// ─── The tool loop's landing round ────────────────────────────────────────────
// Both tool loops cap a turn at N model rounds. Past the cap they used to THROW — and a desk that
// was still reading on round N+1 lost the whole turn: every tool result, every token already
// streamed, and the structured block it was about to emit. That cliff was invisible to the model,
// which cannot count rounds it cannot see, so no prompt could steer it clear of the edge. Now the
// LAST round runs with tools switched off and this note appended to the final tool results, so
// the model lands as text with what it has. Shared by both providers (share the pipe): a desk's
// own prompt says what "as far as built" means for its block; this says only that the round is
// the last.
export const TOOL_BUDGET_LANDING = 'The tool budget for this turn is spent — this is your last round, and no further tool call will be honoured. Answer now with what you already have: emit whatever structured block you were building as far as it is built, say plainly what you did not get to check, and say you will continue next turn.'

// ─── Emit-tag registry ────────────────────────────────────────────────────────
// Every emit tag ANY agent may produce. The tag suppressor must know about all of
// them so a stray tag from one agent never leaks raw into another agent's chat UI.
// buildTagCaptures() suppresses ALL of these by default; an agent overrides only
// the few it actually captures. This removes the old footgun where each agent
// hand-listed its tags and a forgotten entry leaked `<state>`-style JSON to users.
export const ALL_EMIT_TAGS = [
    'state', 'trade_idea', 'asset', 'interval', 'phase', 'ticker',
    'portfolio_plan', 'portfolio_update', 'portfolio_mandate', 'portfolio_thesis',
    'scan_list', 'call', 'scan_request', 'kairos_pick', 'coverage', 'screen_request',
    'route', 'chart', 'setup', 'setups', 'edit', 'open', 'adopt', 'tilt',
    // Follow-up chips (services/suggestions.service.js). Registered here even though only Axl
    // emits it today — that is the whole point of this list: the suppressor must know a tag
    // BEFORE an agent starts using it, or the first turn that emits one prints it at the user.
    'suggest',
    // Prometheus's quick read on an Aether name (analyst_mode_quickread.md) — a verdict, not
    // coverage. Registered for the same reason as `suggest`.
    'quickread',
    // Atlas's two research hops (portfolio_system_prompt.md) and Argus's "send this name to
    // Prometheus" (the scanner prompts). Unregistered until 2026-09-18, so the block streamed raw
    // into the Atlas bubble until the settled reply replaced it.
    'coverage_request', 'coverage_refresh',
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
