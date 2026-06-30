// ─── Tag suppressor ───────────────────────────────────────────────────────────
// Provider-agnostic streamed-text processor. Buffers streamed text and swallows
// <state>…</state>, <trade_idea>…</trade_idea>, <asset>…</asset> (and the
// portfolio/ticker blocks) so they never reach the UI. Tags with an onCapture
// callback have their inner text captured and forwarded.
//
// Used by both the Anthropic and OpenAI streaming tool loops so the two providers
// expose identical streaming behavior to the agent services.

export function createTagSuppressor(onToken, onAsset, onInterval, onTicker, onPlan, onUpdate, onScan, onMandate, onPhase) {
    const TAGS = [
        { open: '<state>',               close: '</state>',               onCapture: null       },
        { open: '<trade_idea>',          close: '</trade_idea>',          onCapture: null       },
        { open: '<asset>',               close: '</asset>',               onCapture: onAsset    },
        { open: '<interval>',            close: '</interval>',            onCapture: onInterval },
        { open: '<phase>',               close: '</phase>',               onCapture: onPhase ?? null },
        ...(onTicker  ? [{ open: '<ticker>',             close: '</ticker>',             onCapture: onTicker,  keepText: true }] : []),
        ...(onPlan    ? [{ open: '<portfolio_plan>',     close: '</portfolio_plan>',     onCapture: onPlan    }] : []),
        ...(onUpdate  ? [{ open: '<portfolio_update>',   close: '</portfolio_update>',   onCapture: onUpdate  }] : []),
        ...(onScan    ? [{ open: '<scan_list>',          close: '</scan_list>',          onCapture: onScan    }] : []),
        { open: '<portfolio_mandate>',  close: '</portfolio_mandate>',  onCapture: onMandate ?? null },
        // Suppressed from the UI stream; captured from the raw text post-stream in the agent service.
        { open: '<portfolio_thesis>',   close: '</portfolio_thesis>',   onCapture: null },
    ]

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
                    if (keepText && content) onToken(content)
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
                    keepText        = tag.keepText ?? false
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
        keepText        = false
    }

    return { push, flush }
}
