import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { resolveStreamFn } from './llmModels.js'
import { logger }         from './logger.service.js'
import { recordUsage }    from './tokenUsage.service.js'
import { normalizeMessages, makePromptLoader } from './agentUtils.js'

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

export const axlAgentService = { chatStream }

async function chatStream({ messages = [], model: requestedModel, reasoningEffort, userId, onToken, onToolStart, onReasoning, signal } = {}) {
    const normalized = normalizeMessages(messages, MAX_MESSAGES)
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)

    // Stable cached base + volatile tail (today's date, so "this week" resolves).
    const today = new Date().toISOString().slice(0, 10)
    const systemPrompt = [
        { type: 'text', text: _systemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `CURRENT DATE: ${today}. Resolve relative timeframes (today, this week, this month) against this date.` },
    ]

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, model, provider })

    const onUsage = userId ? (usage) => recordUsage(userId, model, usage).catch(() => {}) : undefined

    const raw = await streamFn({
        model,
        promptOrMessages: normalized,
        systemPrompt,
        tools:        TOOLS,
        toolHandlers: TOOL_HANDLERS,
        reasoningEffort,
        signal,
        onToken,
        onToolStart,
        onReasoning,
        onUsage,
    })

    const reply = (raw ?? '').trim()
    logger.info(LOG, 'chatStream done', { replyLength: reply.length })
    return { reply }
}
