import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { logger }         from './logger.service.js'
import { normalizeMessages, makePromptLoader, stripEmitTags } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { runAgentStream } from './agentIO.js'

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

// ONE Axl. This turn both converses and routes, which used to be two agents: a `routeIntent` doorman
// on its own tight prompt (no history, no app knowledge) answered the landing box, while the real
// Axl — this one — lived behind a link. The doorman answered app questions anyway, inventing them,
// and could not resolve a follow-up: "give spy" then "now the 4h" charted a ticker it had never been
// told. Routing is now a section of Axl's own prompt and a `<route>` tag on a normal reply, so the
// user gets one Axl that remembers, explains, charts, and hands them to a desk when they want one.

export const axlAgentService = { chatStream }

async function chatStream({ messages = [], model: requestedModel, reasoningEffort, userId, onToken, onToolStart, onReasoning, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
} = {}) {
    const normalized = normalizeMessages(messages, MAX_MESSAGES)

    // Stable cached base + volatile tail (today's date, so "this week" resolves).
    const today = new Date().toISOString().slice(0, 10)
    const systemPrompt = [
        { type: 'text', text: _systemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `CURRENT DATE: ${today}. Resolve relative timeframes (today, this week, this month) against this date.` },
    ]

    // The chart tag is captured and emitted by runAgentStream (shared protocol) — Axl only forwards
    // the callback, exactly like every other agent, and that ONE argument is the whole reason a
    // toolless agent can put a chart in its chat at all. <route> is Axl's own: suppressed from the
    // token stream here, and stripped from `raw` below because this return value is a second
    // consumer that would otherwise hand the client "…to the trading desk. <route>trade</route>".
    let chartRow = null
    let routeCapture = null
    const raw = await _run({
        log: LOG, requestedModel, userId,
        messages: normalized, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken,
        tagCaptures: buildTagCaptures({ route: (text) => { routeCapture = text.trim() } }),
        onToolStart, onReasoning,
        onChart: (row) => { chartRow = row; onChart?.(row) },
    })

    const reply = stripEmitTags(raw ?? '', ['route']).trim()
    logger.info(LOG, 'chatStream done', { route: routeCapture, replyLength: reply.length })
    // `chart` on the return is the REQUEST, never the image: the row already went out on its own
    // event and doubling it here would double the bytes on the wire.
    return {
        reply,
        route: routeCapture,
        chart: chartRow ? { ticker: chartRow.symbol, timeframe: chartRow.timeframe } : null,
    }
}
