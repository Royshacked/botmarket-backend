// Aether — the channel-graph forecasting engine desk (agent key `aether`).
//
// Admin-only: guarded at the route layer via requireAdmin middleware.
// Pure conversational — no phase capture, no emit tags. The desk discusses the engine, interprets
// its DB outputs, and reasons qualitatively when quantitative data is absent.

import { fileURLToPath } from 'url'
import { dirname, join }  from 'path'

import { runAgentStream } from '../agentIO.js'
import { toolsFor }       from '../agentTools.registry.js'
import { makePromptLoader, LANGUAGE_RULE, BREVITY_RULE, cachedBlock, buildDeskMessages } from '../agentUtils.js'
import { AETHER_TOOL_SPECS, makeAetherToolHandlers } from '../tools/aether.tools.js'
import { logger }         from '../logger.service.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const LOG         = '[aetherAgent]'
const PROMPT_PATH = join(__dirname, '../../prompts/aether_system_prompt.md')
const _systemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 12

export const TOOLS = toolsFor({
    // Order is preserved exactly — prompt caching keys off the array prefix.
    get_channel_taxonomy: AETHER_TOOL_SPECS.get_channel_taxonomy,
    get_channel_state:    AETHER_TOOL_SPECS.get_channel_state,
    get_regime:           AETHER_TOOL_SPECS.get_regime,
    get_name_exposure:    AETHER_TOOL_SPECS.get_name_exposure,
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

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, onToolStart, onReasoning,
    })

    const reply = (raw ?? '').trim()
    logger.info(LOG, 'chatStream done', { replyLength: reply.length })
    return { reply }
}

function _buildSystemPrompt() {
    const today = new Date().toISOString().slice(0, 10)
    return [
        cachedBlock(_systemPrompt() + LANGUAGE_RULE + BREVITY_RULE),
        { type: 'text', text: `---\nCURRENT DATE: ${today}.` },
    ]
}

export function _buildMessages({ messages }) {
    return buildDeskMessages({ messages, max: MAX_RECENT_MESSAGES })
}
