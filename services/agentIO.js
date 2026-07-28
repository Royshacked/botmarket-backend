import { logger } from './logger.service.js'
import { resolveAgentStream } from './agentUtils.js'

// The agent I/O protocol — the mechanics every streaming agent repeats verbatim.
//
// Each agent talks to the model the same way: open a stream, suppress its emit tags, capture the
// live ones, then pull a JSON block out of the raw reply and merge it onto the draft so far. Only
// the TAGS and the SHAPE differ, and those are the agent's own business.
//
// Before this module the mechanics were copied per agent: `_parseKairosResponse`,
// `_parseMentorResponse` and `_parseAnalystResponse` were the same eight lines with a different
// tag; `_mergeCallDraft` and `_mergeSetupDraft` were character-for-character identical; and the
// bounded phase-capture closure appeared five times with only its upper bound changed.

/**
 * Pull one `<tag>…</tag>` JSON block out of a raw model reply.
 *
 * Returns null when the block is absent OR malformed — a half-parsed draft is worse than none,
 * because the client replaces its worksheet wholesale and would wipe settled fields. A malformed
 * block is warn-logged (models do emit truncated JSON) but never throws: one bad block must not
 * take down a turn that also contained a perfectly good reply.
 *
 * The tag is matched EXACTLY, which matters more than it looks: `<setup>` and `<setups>` share a
 * prefix, and a loose match would parse the candidate offer as a worksheet.
 */
export function parseEmitBlock(raw, tag, log = '[agentIO]') {
    const m = String(raw ?? '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    if (!m) return null
    try {
        return JSON.parse(m[1].trim())
    } catch (err) {
        logger.warn(log, `${tag} JSON parse failed:`, err.message)
        return null
    }
}

/**
 * Carry a draft forward across turns.
 *
 * Agents are told to re-emit the COMPLETE artifact every turn, but on an edit turn a model often
 * narrates "everything else stands" and emits only the field it changed. The client replaces its
 * draft wholesale, so that thin block would wipe already-settled work.
 *
 * SHALLOW BY DESIGN: a re-emitted array or object replaces its prior value outright, so the model
 * can still DROP a zone or clear a field with an explicit null. Only OMISSION is protected.
 * Returns null when there is no new artifact this turn, so the caller keeps what it has.
 */
export function mergeDraft(prev, next) {
    if (!next) return null
    if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return next
    return { ...prev, ...next }
}

/**
 * A bounded phase capture. The model emits `<phase>N</phase>` every turn; the number drives the UI
 * heading and the next turn's model routing, so an out-of-range or non-numeric value must be
 * ignored rather than forwarded.
 *
 * Returns the capture callback plus a getter for the last valid value — agents need both, and
 * hand-rolling the closure five times is how the bounds drifted (1–5, 1–6, 1–7 by agent).
 */
export function makePhaseCapture(maxPhase, onPhase) {
    let captured = null
    return {
        capture: (p) => {
            const n = parseInt(p, 10)
            if (Number.isFinite(n) && n >= 1 && n <= maxPhase) {
                captured = n
                onPhase?.(n)
            }
        },
        get: () => captured,
    }
}

// ─── The chart-open protocol ──────────────────────────────────────────────────
//
// The workspace has ONE live chart surface, and every agent opens it the same way: end the reply
// with `<chart>{"ticker":"AAPL","timeframe":"1hr"}</chart>`. The tag is captured mid-stream, the
// controller forwards it as the `chart_open` SSE event, and the client's shared chart service
// puts it on screen. Per-agent judgment (when a chart is worth opening) stays in the agent's own
// prompt; this is only the pipe.
//
// Wiring a NEW agent is one argument — pass `onOpenChart` to runAgentStream and it supplies the
// instruction, the tag capture and the tag strip. Nothing else to remember.
//
// NOT the same thing as the `get_chart` TOOL some agents carry: that renders a static image for
// the agent to READ (and optionally drop in the chat). This opens the user's interactive chart.

/** Canonical timeframe spellings — the same set get_candles / get_chart accept. */
export const CHART_TIMEFRAMES = ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month']

// Every spelling a model actually emits ("1h", "1d", "60") mapped onto the canonical one. Mirrors
// the client's PriceChart PERIOD_MAP, so anything that normalizes here renders there.
const _TF_ALIASES = {
    '1m': '1min', '1': '1min',
    '5m': '5min', '5': '5min',
    '15m': '15min', '15': '15min',
    '30m': '30min', '30': '30min',
    '1h': '1hr', '1hour': '1hr', '60': '1hr',
    '2h': '2hr', '2hour': '2hr', '120': '2hr',
    '4h': '4hr', '4hour': '4hr', '240': '4hr',
    '1d': 'day', 'd': 'day', 'daily': 'day',
    '1w': 'week', 'w': 'week', 'weekly': 'week',
    '1mo': 'month', 'mo': 'month', 'monthly': 'month', 'm': 'month',
}

/**
 * Normalize a `<chart>` payload into something the client can actually render, or null.
 *
 * The ticker is the only hard requirement — a chart with no symbol is nothing to open. An
 * unrecognised timeframe falls back to `day` rather than failing the whole request: the user asked
 * to see the chart, and the wrong resolution is a click away while no chart at all is a dead end.
 */
export function normalizeChartRequest(req) {
    const ticker = String(req?.ticker ?? '').trim().toUpperCase().replace(/^\$/, '')
    if (!/^[A-Z0-9][A-Z0-9.\-/=^]{0,14}$/.test(ticker)) return null
    const tf = String(req?.timeframe ?? '').trim().toLowerCase()
    return {
        ticker,
        timeframe: CHART_TIMEFRAMES.includes(tf) ? tf : (_TF_ALIASES[tf] ?? 'day'),
    }
}

/**
 * Capture callback for the `<chart>` tag. Fires `onOpenChart` the moment the block closes — the
 * chart opens while the reply is still streaming — and remembers the last valid request.
 *
 * A malformed or symbol-less block is warn-logged and dropped: the reply itself is unaffected.
 */
export function makeChartOpenCapture(onOpenChart, log = '[agentIO]') {
    let captured = null
    return {
        capture: (text) => {
            let parsed = null
            try { parsed = JSON.parse(String(text ?? '').trim()) } catch {
                logger.warn(log, 'chart block JSON parse failed')
                return
            }
            const req = normalizeChartRequest(parsed)
            if (!req) { logger.warn(log, 'chart block has no usable ticker', { got: parsed?.ticker }); return }
            captured = req
            onOpenChart?.(req)
        },
        get: () => captured,
    }
}

/** Appended to the system prompt of every agent wired for charts. */
export const CHART_OPEN_INSTRUCTION = `## Opening a chart for the user

The user's workspace has one live, interactive chart panel. When the user asks to SEE a chart —
"show me NVDA", "open the 4h", "pull up that chart", "let me look at it" — open it by ending your
reply with a chart tag:

<chart>{"ticker":"NVDA","timeframe":"1hr"}</chart>

- timeframe: one of ${CHART_TIMEFRAMES.join(' ')}. Use the one they asked for; default to day.
- Acknowledge in one short sentence ("Opening NVDA on the 1h.") and then emit the tag. Never
  mention the tag itself, and never describe what a chart is.
- ONE chart tag per reply — the newest replaces whatever is on the panel.
- Emit it ONLY when the user asked to see a chart. It is not a way to illustrate your own analysis
  (use your chart/candle tools for that), and it does not replace any answer you owe them.`

// Point the `<chart>` descriptor at our capture. All emit tags are suppressed by default
// (buildTagCaptures), so the descriptor is normally already there — appended defensively for a
// caller that hand-built its capture array.
function _withChartCapture(tagCaptures, onCapture) {
    if (!Array.isArray(tagCaptures)) return tagCaptures
    let found = false
    const next = tagCaptures.map(t => {
        if (t?.open !== '<chart>') return t
        found = true
        return { ...t, onCapture }
    })
    return found ? next : [...next, { open: '<chart>', close: '</chart>', onCapture }]
}

// The system prompt is either a plain string or an array of cacheable text blocks. Appending a
// block leaves any cache_control'd prefix untouched.
function _appendSystemBlock(systemPrompt, text) {
    if (Array.isArray(systemPrompt)) return [...systemPrompt, { type: 'text', text }]
    return `${systemPrompt ?? ''}\n\n${text}`
}

/** Drop `<chart>…</chart>` from a raw reply — the payload was already captured. */
export function stripChartBlock(raw) {
    return String(raw ?? '').replace(/<chart>[\s\S]*?<\/chart>/g, '')
}

/**
 * Open a model stream for an agent and return its raw text.
 *
 * Wraps the three lines every agent repeats: resolve the model + usage recorder, log the start,
 * and call the provider's streaming fn with the standard argument bag. `meta` adds agent-specific
 * fields to the start log (asset, account count, edit mode…) without each agent re-deriving
 * `model` and `provider` for its own log line.
 *
 * `onOpenChart` opts the agent into the chart-open protocol above: the instruction is appended to
 * its system prompt, the `<chart>` tag is captured, and the block is stripped from the returned
 * raw so no agent has to add it to its own strip list.
 *
 * Deliberately does NOT parse otherwise: what comes back out of the stream is the agent's own
 * contract.
 */
export async function runAgentStream({
    log = '[agentIO]', requestedModel, userId,
    messages, systemPrompt, tools, toolHandlers,
    reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onOpenChart,
    meta = {},
    // Injectable so the argument-bag contract can be tested without a provider or a real model id.
    _resolve = resolveAgentStream,
}) {
    const { model, streamFn, provider, onUsage } = _resolve(requestedModel, userId)

    const chart = onOpenChart ? makeChartOpenCapture(onOpenChart, log) : null

    logger.info(log, 'chatStream start', { messageCount: messages?.length ?? 0, model, provider, ...meta })

    const raw = await streamFn({
        model, promptOrMessages: messages,
        systemPrompt: chart ? _appendSystemBlock(systemPrompt, CHART_OPEN_INSTRUCTION) : systemPrompt,
        tools, toolHandlers,
        reasoningEffort, signal, onToken,
        tagCaptures: chart ? _withChartCapture(tagCaptures, chart.capture) : tagCaptures,
        onToolStart, onReasoning, onUsage,
    })

    return chart ? stripChartBlock(raw) : raw
}
