// Echo — the event desk (agent key `echo`, desk `events`; docs/design/echo-desk.md).
//
// Maps ONE event to the companies it reaches through the supply chain. Two kinds, never mixed (§2): the FORWARD TEST's
// events (the engine's, read with get_echo_events / get_event_map — the record, frozen at the day-5 check, graded by
// the market) and the USER's events (map_event — framed here, mapped by echoMap.service, saved per user, never graded).
// He sets no levels (the trader's), judges no business (the analyst's), and calls nothing a pick: the forward test is
// unproven until its verdict reads. Reached from Axl ("what does GTA 6 do to…"), from the Hotlist's Echo tab, or
// opened directly.
//
// Model: the house chat model, like every desk (runAgentStream). The MAP is not this model's — map_event makes one
// Opus 5.5 call of its own (echoMap.service), costed to the user as `echo`.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { runAgentStream } from '../agentIO.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { DESKS } from '../desks/registry.js'
import { makeRouteCapture, buildRouteRule } from '../routing.util.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { makePromptLoader, LANGUAGE_RULE, VOICE_RULE, BREVITY_RULE, cachedBlock, normalizeMessages, cleanReply, makeToolHandler, buildAudienceSection } from '../agentUtils.js'
import { getPriceAction } from '../priceAnalytics.service.js'
import { makeNewsHandlers } from '../tools/news.tools.js'
import { ECHO_TOOL_SPEC, makeEchoHandlers } from '../tools/echo.tools.js'
import { logger } from '../logger.service.js'
import { REMEMBER_DESCRIPTION } from '../tools/userProfile.tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The spend ledger books this desk as `echoAgent` (agentIO.agentKeyFromLog reads this tag).
const LOG = '[echoAgent]'
const _prompt = makePromptLoader(join(__dirname, '../../prompts/echo_system_prompt.md'), LOG)
const MAX_MESSAGES = DESKS.echo.maxMessages

// ORDER IS THE CACHE PREFIX: the registry tools in this order, `consult` LAST (contractually — agentTools test).
export const TOOLS = toolsFor({
    get_echo_events: ECHO_TOOL_SPEC.get_echo_events,
    get_event_map: ECHO_TOOL_SPEC.get_event_map,
    map_event: ECHO_TOOL_SPEC.map_event,
    get_news: { description: `Recent dated NEWS (\`companies\` with a ticker as \`subject\`, or a topic) — to check what happened before you frame an event the user names (the date, what changed, which way), or to explain a link. Facts for the frame, never the map itself.`, cache: true },
    get_price_action: `Momentum snapshot: 1d/5d/1m/3m moves, position in the 1-year range, relative volume — how far a name has already moved since the event.`,
    // ABOUT THE USER (one-axl.md step 3): a lasting fact the user states — the handler is runAgentStream's.
    remember_about_user: REMEMBER_DESCRIPTION,
    consult: consultDescription(`Reach for it in one situation only: framing an event where the direction at the origin honestly could go either way and the user cannot say — never to map, and never to read a map.`),
})

const TOOL_HANDLERS = {
    ...makeNewsHandlers(),
    get_price_action: makeToolHandler('get_price_action',
        ({ ticker }) => getPriceAction(ticker),
        (err, { ticker }) => `Could not fetch price action for ${ticker}: ${err.message}`, LOG),
}

export const echoAgentService = { chatStream }

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
        cachedBlock(_prompt() + buildRouteRule('echo') + LANGUAGE_RULE + VOICE_RULE + BREVITY_RULE),
        { type: 'text', text: dynamic.join('\n\n') },
    ]

    // <route>/<open>: the user asked to take a name on — the trader to build a trade, the analyst to judge the business.
    const route = makeRouteCapture('echo')
    const raw = await _run({
        log: LOG, requestedModel, userId, messages: normalized, systemPrompt,
        tools: TOOLS,
        // The user's own events are theirs: the Echo handlers are bound to this turn's user.
        toolHandlers: { ...TOOL_HANDLERS, ...makeEchoHandlers({ userId }) },
        reasoningEffort, signal, onToken, onToolStart, onReasoning, onChart,
        tagCaptures: buildTagCaptures({ ...route.captures }),
    })

    const reply = cleanReply(raw)
    const routing = route.result()
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, route: routing.route })
    return { reply, ...routing }
}
