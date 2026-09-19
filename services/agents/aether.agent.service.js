// Aether — the event-exposure desk (agent key `aether`).
//
// Admin-only: guarded at the route layer via requireAdmin middleware.
// Pure conversational — no phase capture, no emit tags. The desk discusses the engine, interprets
// its DB outputs, and reasons qualitatively when quantitative data is absent.
//
// It IDENTIFIES rather than forecasts. The channel-graph engine this desk was built around
// is archived; what it reads now is the event pipeline — a named event, the companies it
// reaches, and what each one's own filings say.

import { fileURLToPath } from 'url'
import { dirname, join }  from 'path'

import { runAgentStream } from '../agentIO.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { makeRouteCapture, ROUTE_TAGS, buildRouteRule } from '../routing.util.js'
import { toolsFor }       from '../agentTools.registry.js'
import { makePromptLoader, LANGUAGE_RULE, BREVITY_RULE, cachedBlock, buildDeskMessages, stripEmitTags } from '../agentUtils.js'
import { AETHER_TOOL_SPECS, makeAetherToolHandlers } from '../tools/aether.tools.js'
import { logger }         from '../logger.service.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const LOG         = '[aetherAgent]'
const PROMPT_PATH = join(__dirname, '../../prompts/aether_system_prompt.md')
const _systemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 12

export const TOOLS = toolsFor({
    // Order is preserved exactly — prompt caching keys off the array prefix.
    get_event_candidates: AETHER_TOOL_SPECS.get_event_candidates,
})

const TOOL_HANDLERS = makeAetherToolHandlers()

export const aetherAgentService = { chatStream }

async function chatStream({
    messages, model: requestedModel, reasoningEffort, userId,
    onToken, onToolStart, onReasoning, signal,
    _run = runAgentStream,
}) {
    const systemPrompt  = _buildSystemPrompt()
    const builtMessages = _buildMessages({ messages })

    // The shared routing tags: the user asked to be sent to another desk with a name (routing.util).
    const route = makeRouteCapture('aether')
    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, onToolStart, onReasoning,
        tagCaptures: buildTagCaptures({ ...route.captures }),
    })

    const reply = stripEmitTags(raw ?? '', ROUTE_TAGS).trim()
    logger.info(LOG, 'chatStream done', { replyLength: reply.length })
    return { reply, ...route.result() }
}

function _buildSystemPrompt() {
    const today = new Date().toISOString().slice(0, 10)
    return [
        cachedBlock(_systemPrompt() + buildRouteRule('aether') + LANGUAGE_RULE + BREVITY_RULE),
        { type: 'text', text: `---\nCURRENT DATE: ${today}.` },
    ]
}

export function _buildMessages({ messages }) {
    return buildDeskMessages({ messages, max: MAX_RECENT_MESSAGES })
}
