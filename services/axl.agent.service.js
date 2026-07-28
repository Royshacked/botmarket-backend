import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { logger }         from './logger.service.js'
import { normalizeMessages, makePromptLoader, resolveAgentStream, stripEmitTags } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { makeChartChatPipe, runAgentStream, stripChartBlock, CHART_TIMEFRAMES } from './agentIO.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG = '[axlAgent]'
// Hot-reload the system prompt on file change (mtime-gated) — no restart needed.
const _systemPrompt = makePromptLoader(join(__dirname, '../axl_system_prompt.md'), LOG)
const MAX_MESSAGES = 12

// Axl is the non-trading meta-layer: the social-chat assistant, app guide, and
// (later) the account-report / trade-analysis concierge. It is READ-ONLY by
// design — it never emits a <trade_idea>, order, or any authoring artifact. That
// discipline is what keeps it from becoming a superset of the three specialists;
// anything about forming or changing a trade/portfolio/scan routes to that
// specialist's own chat. Roles beyond #1 (social bot) + #5 (app help) need
// account/trade data + tools and are added one by one — no tools yet.
const TOOLS = []
const TOOL_HANDLERS = {}

export const axlAgentService = { chatStream, routeIntent }

// Tight routing system prompt — phaseless, no tool context needed.
const ROUTE_SYSTEM = `You are Axl, the reception at a trading platform with four specialist desks.
Your ONLY job: identify which desk the user wants (or handle a chart request directly), then reply with ONE short sentence. End your reply with the appropriate tag(s).

Desks and keys:
- trade: intraday, day, or swing trade of a specific asset (begins with Argus validating the asset, then Kairos plans the setup)
- portfolio: build or manage a portfolio, long-term or swing allocation (Argus scans, Prometheus researches, Atlas allocates)
- scan: produce a watchlist of candidates for later setups (Argus scans and lists)
- research: deep-dive research on a company or sector (Prometheus builds a coverage thesis)

Chart requests (handle directly — do NOT route to a desk):
If the user asks to open or show a chart for a ticker, emit ONLY the tags, with NO sentence at all:
<route>open_chart</route><chart>{"ticker":"TICKER","timeframe":"TIMEFRAME"}</chart>
The chart appears right here and carries its own ticker and timeframe, so a sentence would only
repeat it. The user stays at reception; nothing is routed.
Use the ticker they mentioned. Use the timeframe they mentioned (${CHART_TIMEFRAMES.join(' ')}); default to day if none given.

Reply format: ONE sentence, then tag(s) — except a chart request, which is tags only.
Examples:
"Let's find you a setup — routing you to the trading desk." <route>trade</route>
"Time to build your book — sending you to the portfolio desk." <route>portfolio</route>
"On it — routing you to the scan desk for a fresh watchlist." <route>scan</route>
"Deep dive coming — routing you to the research desk." <route>research</route>
<route>open_chart</route><chart>{"ticker":"AAPL","timeframe":"1hr"}</chart>
<route>open_chart</route><chart>{"ticker":"TSLA","timeframe":"day"}</chart>`

async function routeIntent({ message, userId, onToken, onReasoning, onChart, signal } = {}) {
    const { model, streamFn, onUsage } = resolveAgentStream(undefined, userId)

    let routeCapture = null
    // Reception's chart tag rides the SHARED pipe (agentIO) end to end — same validation, same
    // `chart` row every agent chat shows. It cannot use runAgentStream (it also captures <route>),
    // so it wires the pipe by hand; that is the only difference.
    const chart = makeChartChatPipe(onChart, { log: LOG })
    const tagCaptures = buildTagCaptures({
        route: (text) => { routeCapture = text.trim() },
        chart: chart.capture,
    })

    const systemPrompt = [{ type: 'text', text: ROUTE_SYSTEM }]

    logger.info(LOG, 'routeIntent start', { model })

    const raw = await streamFn({
        model,
        promptOrMessages: [{ role: 'user', content: message }],
        systemPrompt,
        tools:        [],
        toolHandlers: {},
        reasoningEffort: 'low',
        signal,
        onToken,
        tagCaptures,
        onReasoning,
        onUsage,
    })

    // Both tags come out of `raw`, not just <chart>: the suppressor keeps them off the token stream,
    // but this return value is a second consumer, and it was handing back "…on the daily.
    // <route>open_chart</route>". Nothing rendered it, which is exactly why it survived.
    const reply = stripEmitTags(stripChartBlock(raw), ['route']).trim()
    logger.info(LOG, 'routeIntent done', { route: routeCapture, replyLength: reply.length })
    return { reply, route: routeCapture, chart: chart.get() }
}

async function chatStream({ messages = [], model: requestedModel, reasoningEffort, userId, onToken, onToolStart, onReasoning, onChart, signal } = {}) {
    const normalized = normalizeMessages(messages, MAX_MESSAGES)

    // Stable cached base + volatile tail (today's date, so "this week" resolves).
    const today = new Date().toISOString().slice(0, 10)
    const systemPrompt = [
        { type: 'text', text: _systemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `CURRENT DATE: ${today}. Resolve relative timeframes (today, this week, this month) against this date.` },
    ]

    // The chart tag is captured, rendered and emitted by runAgentStream (shared protocol) — Axl only
    // forwards the callback, exactly like every other agent, and that ONE argument is the whole
    // reason a toolless agent can put a chart in its chat at all.
    let chartRow = null
    const raw = await runAgentStream({
        log: LOG, requestedModel, userId,
        messages: normalized, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken,
        tagCaptures: buildTagCaptures(),
        onToolStart, onReasoning,
        onChart: (row) => { chartRow = row; onChart?.(row) },
    })

    const reply = (raw ?? '').trim()
    logger.info(LOG, 'chatStream done', { replyLength: reply.length })
    // `chart` on the return keeps the `done` payload shape for clients that read it there — the
    // REQUEST, never the image: the PNG already went out on its own event and doubling it here
    // would double the bytes on the wire.
    return { reply, chart: chartRow ? { ticker: chartRow.symbol, timeframe: chartRow.timeframe } : null }
}
