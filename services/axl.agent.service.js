import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { logger }         from './logger.service.js'
import { normalizeMessages, makePromptLoader, stripEmitTags } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { runAgentStream } from './agentIO.js'
import { toolsFor } from './agentTools.registry.js'
import { makeTradingContextHandlers, TRADING_CONTEXT_TOOL_SPEC } from './tradingContext.tools.js'
import { makeObjectiveHandlers, OBJECTIVE_TOOL_SPEC } from './objective.tools.js'
import { getOpenObjective, markRouted } from './objective.service.js'
import { toObjectiveSummary } from '../api/objectives/objective.model.js'

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
// account/trade data + tools and are added one by one — the VENUE reads are the
// first, since "which account am I on / what am I holding / can I trade this
// here" is a question ABOUT the app, which is Axl's own job, not a desk's.
// save_objective is the one WRITE Axl has, and it does not breach the boundary above: it records
// what the user said they want, which is intake, not authoring. No level, size, order or artifact
// comes out of it — those stay with the desks.
export const TOOLS = toolsFor({
    get_trading_context: TRADING_CONTEXT_TOOL_SPEC.get_trading_context,
    check_broker_symbol: TRADING_CONTEXT_TOOL_SPEC.check_broker_symbol,
    save_objective: OBJECTIVE_TOOL_SPEC.save_objective,
})

// ONE Axl. This turn both converses and routes, which used to be two agents: a `routeIntent` doorman
// on its own tight prompt (no history, no app knowledge) answered the landing box, while the real
// Axl — this one — lived behind a link. The doorman answered app questions anyway, inventing them,
// and could not resolve a follow-up: "give spy" then "now the 4h" charted a ticker it had never been
// told. Routing is now a section of Axl's own prompt and a `<route>` tag on a normal reply, so the
// user gets one Axl that remembers, explains, charts, and hands them to a desk when they want one.

export const axlAgentService = { chatStream }

// The route tag may carry the name the user is here for: `<route>research NVDA</route>`. Desk and
// symbol travel as ONE capture because they are one decision — a desk that opens on a name the
// router never picked is worse than a desk that opens empty. Split only; the controller validates
// both (an unknown desk or a junk symbol must not reach the client).
export function _splitRoute(raw) {
    if (typeof raw !== 'string') return { desk: null, symbol: null }
    const [desk = null, symbol = null] = raw.trim().split(/[\s:,]+/)
    return { desk: desk ? desk.toLowerCase() : null, symbol: symbol || null }
}

async function chatStream({ messages = [], model: requestedModel, reasoningEffort, userId, onToken, onToolStart, onReasoning, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    // The objective collaborators are seams too: intake is the one part of Axl that touches the
    // database, and a unit test of the turn should not need one.
    _objectiveHandlers = makeObjectiveHandlers,
    _tradingContextHandlers = makeTradingContextHandlers,
    _getOpenObjective = getOpenObjective,
    _markRouted = markRouted,
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

    // The objective handler is wrapped rather than passed straight through, so the turn knows an
    // intake happened without a second read: the id it returns rides out on the `done` payload and
    // is what the client confirms back to the user.
    let savedObjective = null
    const objectiveHandlers = _objectiveHandlers(userId)
    const toolHandlers = {
        ..._tradingContextHandlers(userId),
        ...objectiveHandlers,
        save_objective: async (args) => {
            const result = await objectiveHandlers.save_objective(args)
            if (result?.saved && result.objective) savedObjective = result.objective
            return result
        },
    }

    const raw = await _run({
        log: LOG, requestedModel, userId,
        messages: normalized, systemPrompt,
        tools: TOOLS, toolHandlers,
        reasoningEffort, signal, onToken,
        tagCaptures: buildTagCaptures({ route: (text) => { routeCapture = text.trim() } }),
        onToolStart, onReasoning,
        onChart: (row) => { chartRow = row; onChart?.(row) },
    })

    const reply = stripEmitTags(raw ?? '', ['route']).trim()
    const { desk, symbol } = _splitRoute(routeCapture)

    // Stamp which desk took the goal. Only on a routing turn, and only then do we pay for a read —
    // the objective is usually captured a turn or two before the hand-off, so the id from THIS turn
    // is often null while an open objective still exists.
    let objective = savedObjective
    if (desk && userId) {
        objective ??= toObjectiveSummary(await _getOpenObjective(userId))
        if (objective?.id) await _markRouted(objective.id, desk)
    }

    logger.info(LOG, 'chatStream done', { route: desk, routeSymbol: symbol, objectiveId: objective?.id ?? null, replyLength: reply.length })
    // `chart` on the return is the REQUEST, never the image: the row already went out on its own
    // event and doubling it here would double the bytes on the wire.
    return {
        reply,
        route: desk,
        routeSymbol: symbol,
        objective,
        chart: chartRow ? { ticker: chartRow.symbol, timeframe: chartRow.timeframe } : null,
    }
}
