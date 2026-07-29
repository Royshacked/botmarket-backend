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

// ─── The chart-in-chat protocol ───────────────────────────────────────────────
//
// Any agent can show the user a chart in its OWN chat, and they all do it the same way: emit
// `<chart>{"ticker":"SPY","timeframe":"day"}</chart>`. The tag is captured mid-stream and the
// controller forwards it as the `chart` SSE event — the same event `get_chart(show_to_user)` uses,
// so the client's one chart row shows it with no per-agent component. Per-agent judgment (when a
// chart is worth showing) stays in the agent's own prompt; this is only the pipe.
//
// Wiring a NEW agent is one argument — pass `onChart` to runAgentStream and it supplies the
// instruction, the tag capture and the tag strip. Nothing else to remember.
//
// TWO triggers on ONE event, and the payloads differ because the two things ARE different:
//
//   the tag  (the USER asked to see a chart)  → `{ symbol, timeframe, live: true }`
//   get_chart(show_to_user) (the AGENT shows what it read) → `{ symbol, timeframe, imageBase64 }`
//
// A chart the user asked for is LIVE: the client mounts its own interactive chart (crosshair, zoom,
// ticker/timeframe header, fresh candles), so nothing is rendered server-side and the row appears
// instantly instead of after a headless-Chromium round trip. A chart the AGENT looked at stays a
// still PNG on purpose — it is evidence of what the model actually saw, overlays included, and a
// live chart would quietly redraw that evidence.
//
// An agent whose TOOL charts are deliberately model-only (Argus) still gets the tag — the user
// asking to look is not the agent illustrating itself.
//
// EVERY surface that can ask for a chart shows it this way, the reception included: it has no
// message list, but it does have a result area, and a chart the user asked for belongs next to the
// sentence that answered them — not on a panel across the screen.

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
 * The ticker is the only hard requirement — a chart with no symbol is nothing to render. An
 * unrecognised timeframe falls back to `day` rather than failing the whole request: "give SPY" names
 * no timeframe at all, and the daily is the answer to it — while no chart is a dead end, and asking
 * the user to restate a timeframe they never gave is worse than showing them one.
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
 * Capture callback for the `<chart>` tag. Fires `onRequest` the moment the block closes — while the
 * reply is still streaming — and remembers the last valid request.
 *
 * The callback gets the normalized REQUEST, not a rendered chart. `makeChartChatPipe` wraps this to
 * add the render + emit that every surface actually wants; the bare capture stays exported for a
 * caller that only needs to know WHAT was asked for.
 *
 * A malformed or symbol-less block is warn-logged and dropped: the reply itself is unaffected.
 */
export function makeChartRequestCapture(onRequest, log = '[agentIO]') {
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
            onRequest?.(req)
        },
        get: () => captured,
    }
}

/** Appended to the system prompt of every agent wired for charts. */
export const CHART_INSTRUCTION = `## Showing the user a chart

When the user asks to SEE a chart — "give SPY", "show me NVDA", "let me look at the 4h", "pull up
that chart" — show it by emitting a chart tag:

<chart>{"ticker":"SPY","timeframe":"day"}</chart>

- timeframe: one of ${CHART_TIMEFRAMES.join(' ')}. Use the one they asked for; default to day.
- Say NOTHING about it. No "Here's SPY on the daily.", no "Opening the chart." — the chart carries
  its own ticker and timeframe, so a sentence repeating them is noise. When the chart is all they
  asked for, the tag IS your entire reply: emit it and stop. Never mention the tag itself.
- The chart appears in this chat as part of the same turn, and it is LIVE — they can hover it for
  OHLC, zoom and pan. ONE chart per reply: if you already put one in front of the user with a tool
  this turn (show_to_user), do not emit the tag as well.
- The tag needs no tool call. When the user only wants to LOOK, use it rather than spending a
  get_chart round trip.
- Emit it ONLY when the user asked to see a chart, in THIS message. It is not a way to illustrate
  your own analysis (use your chart/candle tools for that), and answering an unrelated question is
  not a reason to re-show the chart already in front of them — a chart you showed earlier is still
  there. If they asked something ELSE in the same breath, answer that in full: the silence rule
  covers the chart, never a question you owe them.`

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
 * The whole chat pipe for one turn: capture the tag, hand the chat a LIVE chart row.
 *
 * Synchronous, and that is the point — the row goes out the moment the tag closes, mid-stream, with
 * nothing to render and nothing to wait for. `.get()` returns the last normalized REQUEST, which is
 * what the reception's `done` payload reports so the client knows a chart was asked for, not a desk.
 *
 * A repeated IDENTICAL request emits once. Models restate an acknowledgement (and re-emit the tag)
 * more often than they mean two charts, and two identical charts read as a bug.
 *
 * A throwing `onChart` is contained: the reply still lands.
 */
export function makeChartChatPipe(onChart, { log = '[agentIO]' } = {}) {
    let last = null
    return makeChartRequestCapture((req) => {
        if (last?.ticker === req.ticker && last?.timeframe === req.timeframe) return
        last = req
        try {
            onChart?.({ symbol: req.ticker, timeframe: req.timeframe, live: true })
        } catch (err) {
            logger.warn(log, 'chart emit failed:', err.message)
        }
    }, log)
}

/**
 * Open a model stream for an agent and return its raw text.
 *
 * Wraps the three lines every agent repeats: resolve the model + usage recorder, log the start,
 * and call the provider's streaming fn with the standard argument bag. `meta` adds agent-specific
 * fields to the start log (asset, account count, edit mode…) without each agent re-deriving
 * `model` and `provider` for its own log line.
 *
 * `onChart` opts the agent into the chart-in-chat protocol above: the instruction is appended to its
 * system prompt, the `<chart>` tag is captured and passed to `onChart` as a live chart row, and the
 * block is stripped from the returned raw so no agent has to add it to its own strip list. It is the
 * SAME callback an agent gives its `get_chart` tool — one chart row, one event, either trigger.
 *
 * Deliberately does NOT parse otherwise: what comes back out of the stream is the agent's own
 * contract.
 */
// Every agent's `chatStream` takes `_run = runAgentStream` and calls `_run(...)` here. That one
// seam is what lets the SHARED contract test (tests/unit/agentStreamContract.test.js) drive every
// agent's real chatStream with no provider and no model id — the assertions live once, not per
// agent. It exists because the prelude a chatStream runs before this call is the one stretch of
// agent code nothing else covers: a bad reference there throws before the first token, and the
// client only ever sees the generic "Streaming failed".
export async function runAgentStream({
    log = '[agentIO]', requestedModel, userId,
    messages, systemPrompt, tools, toolHandlers,
    reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onChart,
    meta = {},
    // Injectable so the argument-bag contract can be tested without a provider or a real model id.
    _resolve = resolveAgentStream,
}) {
    const { model, streamFn, provider, onUsage } = _resolve(requestedModel, userId)

    const chart = onChart ? makeChartChatPipe(onChart, { log }) : null

    logger.info(log, 'chatStream start', { messageCount: messages?.length ?? 0, model, provider, ...meta })

    const raw = await streamFn({
        model, promptOrMessages: messages,
        systemPrompt: chart ? _appendSystemBlock(systemPrompt, CHART_INSTRUCTION) : systemPrompt,
        tools, toolHandlers,
        reasoningEffort, signal, onToken,
        tagCaptures: chart ? _withChartCapture(tagCaptures, chart.capture) : tagCaptures,
        onToolStart, onReasoning, onUsage,
    })

    return chart ? stripChartBlock(raw) : raw
}
