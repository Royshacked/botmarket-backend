// Proteus — the technical analysis desk (agent key `proteus`, desk `technicals`; docs/design/proteus.md).
//
// Says how ONE stock's price behaves: the MEASURED profile first (get_behaviour_profile — counted from candles, every
// rate against a baseline), then, when asked, what is SEEN on its chart now (patterns, order blocks, sweeps — the
// vision tools, billed per use). He sets no levels (Mentor's), judges no business (Prometheus's), picks nothing
// (Argus's). Reached from Axl ("how does TSLA behave?") and Mentor (registry routedFrom), or opened directly.
//
// Model: the house chat model, like every desk (runAgentStream → resolveAgentStream → houseModels). Conversational:
// no working state, no entity, no emit tags of its own — the chain hand-off to Mentor is build step 4.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { runAgentStream } from '../agentIO.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { DESKS } from '../desks/registry.js'
import { makeRouteCapture, buildRouteRule } from '../routing.util.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { makePromptLoader, LANGUAGE_RULE, BREVITY_RULE, cachedBlock, normalizeMessages, cleanReply, makeToolHandler, buildAudienceSection, COMMON_TOOL_HANDLERS } from '../agentUtils.js'
import { getPriceAction, getCycleAnalysis } from '../priceAnalytics.service.js'
import { makeCandlesHandler, makeIndicatorsHandler, makeChartHandler } from '../tools/marketData.tools.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from '../tools/priceStructure.tools.js'
import { SMC_TOOLS, SMC_TOOL_HANDLERS } from '../tools/smc.tools.js'
import { BEHAVIOUR_PROFILE_TOOL_SPEC, makeBehaviourProfileHandlers } from '../tools/behaviourProfile.tools.js'
import { makeNewsHandlers } from '../tools/news.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from '../tools/marketHours.tools.js'
import { logger } from '../logger.service.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The spend ledger books this desk as `proteusAgent` (agentIO.agentKeyFromLog reads this tag).
const LOG = '[proteusAgent]'
const _prompt = makePromptLoader(join(__dirname, '../../prompts/proteus_system_prompt.md'), LOG)
const MAX_MESSAGES = DESKS.proteus.maxMessages

// ORDER IS THE CACHE PREFIX: the registry tools in this order, the cache breakpoint on the last stable one, the SMC
// tools after them, `consult` LAST (contractually — agentTools test).
const REGISTRY_TOOLS = toolsFor({
    get_behaviour_profile: BEHAVIOUR_PROFILE_TOOL_SPEC.get_behaviour_profile,
    get_candles: `Recent OHLCV candles for a ticker + timeframe — exact prices for a level, a swing high/low, a range, a gap. The cheap, exact numbers; prefer it to a chart when the question is a price.`,
    get_indicators: `Exact indicator VALUES now (EMA, SMA, RSI, MACD, ATR, VWAP — the monitor's math), for where price sits today against the lines the profile tested. A value now is not a rule: whether the stock RESPECTS a line is the profile's answer, never this one.`,
    get_price_action: `Momentum snapshot: 1d/5d/1m/3m moves, position in the 1-year range, relative volume — the stock's state today.`,
    get_cycle_analysis: `Recurring cycles in the price history: "price" mode finds the dominant peak-to-peak interval and the current phase; "calendar" mode shows how the stock behaved in a calendar window (e.g. late June) over past years. Only when the user asks about cycles or seasonality.`,
    get_chart: {
        description: `Render a candlestick chart IMAGE (with optional overlays) and LOOK at it — for what is SEEN NOW: a pattern forming or just completed (flag, cup and handle, head and shoulders, range, wedge), trend, where price sits vs the lines. A reading of one chart, never a hit rate. BILLS PER USE (render + vision): only when the user asks about patterns or the chart now; once or twice a turn at most.`,
        omit: ['show_to_user'],
    },
    get_orderblocks: {
        description: `ORDER BLOCKS on a plain candlestick chart now (one ticker + timeframe): where the zones sit today, fresh or mitigated, vs current price. Whether its order blocks HOLD is the profile's answer; this is where they are. BILLS PER USE (render + vision).`,
        omit: ['show_to_user'],
    },
    get_false_breaks: {
        description: `FALSE BREAKS / sweeps on a plain candlestick chart now (one ticker + timeframe): where price recently pushed past a prior high or low and closed back inside. How OFTEN it does that is the profile's answer; this is where it happened lately. BILLS PER USE (render + vision).`,
        omit: ['show_to_user'],
    },
    get_market_hours: MARKET_HOURS_TOOL_SPEC.get_market_hours,
    get_news: { description: `Recent dated NEWS on a name, newest first (\`companies\` with the ticker as \`subject\`). Only to explain a move on the chart the user asks about — the news is Prometheus's field, not yours.`, cache: true },
})

export const TOOLS = [
    ...REGISTRY_TOOLS,
    ...SMC_TOOLS,
    ...toolsFor({
        consult: consultDescription(`Reach for it in one situation only: the user asks for a judgment the profile does not settle — two readings of the same chart that point opposite ways — and the answer matters to them. Never to read the profile itself.`),
    }),
]

const TOOL_HANDLERS = {
    ...makeBehaviourProfileHandlers(),
    get_candles: makeCandlesHandler(LOG),
    get_indicators: makeIndicatorsHandler(LOG),
    get_price_action: makeToolHandler('get_price_action',
        ({ ticker }) => getPriceAction(ticker),
        (err, { ticker }) => `Could not fetch price action for ${ticker}: ${err.message}`, LOG),
    get_cycle_analysis: makeToolHandler('get_cycle_analysis',
        ({ ticker, mode, calendar_window, lookback_years, timeframe }) => getCycleAnalysis(ticker, mode, calendar_window ?? null, lookback_years ?? 4, timeframe ?? 'day'),
        (err, { ticker }) => `Could not compute cycle analysis for ${ticker}: ${err.message}`, LOG),
    // The vision tools read the chart for the MODEL (onChart: null), like Argus's: the user sees a chart when Proteus
    // puts one in the reply with the <chart> tag (onChart below), not every render he looks at.
    get_chart: makeChartHandler({ log: LOG, onChart: null, readText: 'Read what is VISIBLE now: the pattern if there is one (name it only if it is clear), trend, where price sits vs the overlays. A reading of this chart, not a statistic.' }),
    get_orderblocks: makeStructureVisionHandler({ log: LOG, kind: 'orderblocks', vision: OB_VISION, onChart: null }),
    get_false_breaks: makeStructureVisionHandler({ log: LOG, kind: 'false_breaks', vision: FB_VISION, onChart: null }),
    ...SMC_TOOL_HANDLERS,
    ...COMMON_TOOL_HANDLERS,
    ...makeNewsHandlers(),
    ...makeMarketHoursHandlers(),
}

export const proteusAgentService = { chatStream }

async function chatStream({
    messages = [], model: requestedModel, audience = null, reasoningEffort, userId,
    onToken, onToolStart, onReasoning, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam (agentIO.runAgentStream)
}) {
    const normalized = normalizeMessages(messages, MAX_MESSAGES)
    const today = new Date().toISOString().slice(0, 10)
    const dynamic = [`CURRENT DATE: ${today}.`]
    const audienceSection = buildAudienceSection(audience)
    if (audienceSection) dynamic.push(audienceSection)
    const systemPrompt = [
        cachedBlock(_prompt() + buildRouteRule('proteus') + LANGUAGE_RULE + BREVITY_RULE),
        { type: 'text', text: dynamic.join('\n\n') },
    ]

    // <route>/<open>: the user asked to be sent to another desk with a name (routing.util) — Mentor, to trade it.
    const route = makeRouteCapture('proteus')
    const raw = await _run({
        log: LOG, requestedModel, userId, messages: normalized, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, onToolStart, onReasoning, onChart,
        tagCaptures: buildTagCaptures({ ...route.captures }),
    })

    const reply = cleanReply(raw)
    const routing = route.result()
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, route: routing.route })
    return { reply, ...routing }
}
