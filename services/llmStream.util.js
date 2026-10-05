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

/**
 * How many tool calls in ONE round actually run at once.
 *
 * A round used to be `Promise.all(uses.map(...))` in both providers: every call the model asked for,
 * fired together, however many that was. It stayed invisible while a round held two or three calls,
 * and it broke the moment a desk was told to ask for more — Argus's radar cut, given "call in
 * parallel" over a twenty-name shortlist, turned one round into twenty simultaneous candle requests
 * and got 429 back on fourteen of them. The model had done exactly as instructed; the burst was the
 * transport's.
 *
 * FOUR, and the number is about the PROVIDERS behind the tools, not the model. It is wide enough that
 * a round of per-name reads still overlaps — the whole point of asking for them together — and narrow
 * enough that a dozen-name round arrives as three waves rather than one spike, on top of the paper
 * loops already holding 45-85 requests a minute against the same key. Raising it trades a rate-limit
 * risk for latency that bounded overlap has already mostly bought.
 *
 * Shared by both providers (share the pipe). It bounds ONE round; the number of rounds is
 * maxContinuations, and the two limits answer different questions.
 */
export const MAX_PARALLEL_TOOLS = 4

/**
 * The per-turn VISION budget — the backstop under "never run it across the pool".
 *
 * get_chart, get_orderblocks and get_false_breaks each render a chart and then spend a Claude vision
 * call on the image. They are the only tools in the kit that bill per use, and nothing counted them:
 * web_search has its own max_uses, the render pool bounds concurrency, MAX_PARALLEL_TOOLS bounds what
 * is in flight — none of those bound the COUNT. The discipline lived entirely in a prompt line, and a
 * prompt line is not a budget. A scan working a twenty-name shortlist could spend twenty vision calls
 * and nothing would stop it or even say so afterwards.
 *
 * ONE BUDGET PER TURN, built by the provider's stream loop and carried on the tool ctx, because "per
 * turn" is a fact the loop knows and a module-level counter cannot: the handlers are built once at
 * import for some desks, so a counter in their closure would be process-global and would refuse the
 * fiftieth call of the day rather than the ninth of a turn.
 *
 * The refusal is a toolError, deliberately. A plain string would read to the model as a finding, and
 * worse, it would confer GROUNDING on the ticker in Argus's ledger — a name credited to a read that
 * never happened. It also names the cheap tools to use instead, so a refused turn has somewhere to go.
 */
export function makeVisionBudget(max) {
    const ceiling = Math.max(1, Number(max) || 1)
    let used = 0
    return {
        get used() { return used },
        get max()  { return ceiling },
        /** Claim one call. False when the budget is spent — the caller refuses, it does not throw. */
        take() {
            if (used >= ceiling) return false
            used++
            return true
        },
    }
}

/** What a vision tool says once the turn's budget is gone. */
export const VISION_BUDGET_SPENT = (name, max) =>
    `${name} refused: this turn's budget of ${max} chart/vision reads is spent. Each one renders a chart and spends a vision call, so they are for your strongest two or three names, never the pool. Use get_candles, get_indicators or get_price_action for the rest — they are numeric, cheap, and give you exact levels rather than approximate ones.`

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
    'route', 'chart', 'setup', 'setups', 'edit', 'open', 'adopt',
    // Pythia's answer on one GICS sub-industry (api/strategy/industryView.service.js).
    'industry_view',
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
    // "Open THIS item's detail window" — the third sibling of <route>/<edit> (routing.util
    // SHOW_KINDS). Registered for the same reason as `suggest`: the suppressor has to know the tag
    // before the first turn emits one, or the id prints at the user mid-sentence.
    'show',
    // Mentor's build ledger (services/mentorBuild.util.js) — the claims, settlements and reopens of
    // ONE turn. Server-validated, never shown: what the user agreed to is said in the reply, in
    // words, and the tag is only how the server hears about it.
    'build',
    // Mentor's candidate trades at the spans gate — the table the user picks from, rejects and all.
    // Unlike <build> this one IS rendered; it is suppressed from the prose and drawn as a card.
    'spans',
    // And the ways INTO those trades, at the second gate. Same deal: suppressed here, drawn there.
    'entries',
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
