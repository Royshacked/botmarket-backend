import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { resolveStreamFn } from './llmModels.js'
import { recordUsage } from './tokenUsage.service.js'
import { makePromptLoader, stripEmitTags, buildAccountLines, normalizeMessages } from './agentUtils.js'
import { KAIROS_TOOLS, buildKairosToolHandlers } from './kairos.tools.js'
import { kairosService } from '../api/kairos/kairos.service.js'
import { toBrokerSymbol } from './brokerSymbol.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { computeBasisOffset } from '../api/broker/brokerPrice.service.js'
import { logger } from './logger.service.js'

// Kairos build agent: a conversation → a DRAFT trading "call" (see KAIROS_PLAN.md, Phase 1).
// Forked from the Idea agent's streaming scaffold but self-contained. The agent emits a single
// <call> JSON block; the stream returns it as an UNSAVED draft. Nothing persists until the user
// clicks Generate → the save endpoint calls _finalizeCall (venue-resolve → validate → save),
// mirroring Idea's "build in chat, activate to persist" flow. Touches nothing in the Idea agent.

const __dirname   = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../kairos_system_prompt.md')
const LOG         = '[kairosAgent]'
const MAX_RECENT_MESSAGES = 8

const _baseSystemPrompt = makePromptLoader(PROMPT_PATH, LOG)

export function emptyKairosState() {
    return { active_asset: '', draft: null }
}

export const kairosAgentService = {
    chatStream,
}

async function chatStream({
    messages, userPrompt, chatState = emptyKairosState(), accounts = [],
    model: requestedModel, reasoningEffort, userId,
    onToken, onChart, onToolStart, onReasoning, onPhase, signal,
}) {
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)

    // get_chart returns an image tool_result only the Anthropic provider renders — gate the
    // tool (and its UI emit) to Anthropic, and tell the prompt it's absent otherwise.
    const isAnthropic  = provider === 'anthropic'
    const tools        = isAnthropic ? KAIROS_TOOLS : KAIROS_TOOLS.filter(t => t.name !== 'get_chart')
    const toolHandlers = buildKairosToolHandlers(isAnthropic ? onChart : null)

    const systemPrompt  = _buildSystemPrompt(chatState, accounts, { hasChartTool: isAnthropic })
    const builtMessages = _buildMessages({ messages, userPrompt })

    logger.info(LOG, 'chatStream start', { userPrompt, messageCount: builtMessages.length, model, provider, accounts: accounts?.length ?? 0 })

    const onUsage = userId ? (usage) => recordUsage(userId, model, usage).catch(() => {}) : undefined

    // The model emits <phase>N</phase> (1–5) at the start of each turn; capture it for the UI
    // progress + next-turn model routing. <call> is suppressed from the token stream and parsed
    // from `raw`.
    let capturedPhase = null
    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 5) { capturedPhase = n; onPhase?.(n) }
    }
    const tagCaptures = [
        { open: '<phase>', close: '</phase>', onCapture: onPhaseCapture },
        { open: '<call>',  close: '</call>',  onCapture: null },
    ]

    const raw = await streamFn({
        model, promptOrMessages: builtMessages, systemPrompt, tools, toolHandlers,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onUsage,
    })

    const { reply, call } = _parseKairosResponse(raw)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasCall: Boolean(call) })

    // The call is a DRAFT — returned for preview, NOT saved. The user clicks Generate to persist.
    return { reply, phase: capturedPhase, ...(call ? { call } : {}) }
}

// ─── Call extraction (pure) ───────────────────────────────────────────────────
// Pull the <call> JSON block out of the raw model output. Returns the user-visible reply
// (block stripped) plus the parsed draft call object (null if absent or malformed).
export function _parseKairosResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['call', 'phase']).trim()

    const m = text.match(/<call>([\s\S]*?)<\/call>/)
    if (!m) return { reply, call: null }

    try {
        return { reply, call: JSON.parse(m[1].trim()) }
    } catch (err) {
        logger.warn(LOG, 'call JSON parse failed:', err.message)
        return { reply, call: null }
    }
}

// ─── Venue resolution (cTrader symbol gate, copied from the Idea flow) ─────────
// Bind the call to the selected account's venue and resolve the broker-native symbol +
// basis offset. Only cTrader needs resolution (NQ→US100→US100.cash + index basis); paper and
// manual trade in chart space (symbol == asset, offset 0). Never throws — falls back to the
// static map / zero offset. Deps are injectable for testing.
export async function _resolveVenue(broker, userId, accountId, asset, deps = {}) {
    const {
        toBrokerSymbol:     _toBrokerSymbol     = toBrokerSymbol,
        // Wrapped (not detached) so the real brokerService method keeps its receiver.
        resolveSymbol:      _resolveSymbol      = (...args) => brokerService.resolveSymbol(...args),
        computeBasisOffset: _computeBasisOffset = computeBasisOffset,
    } = deps

    if (broker !== 'ctrader') return { broker_symbol: asset, basis_offset: 0 }

    const mapped = _toBrokerSymbol('ctrader', asset)
    let brokerSymbol = mapped
    try {
        const res = await _resolveSymbol('ctrader', userId, accountId, mapped)
        if (res?.found && res.symbol) brokerSymbol = res.symbol
    } catch (err) {
        logger.warn(LOG, `resolveSymbol ${asset}→${mapped} failed — using static map: ${err.message}`)
    }

    let basis_offset = 0
    try {
        const { offset } = await _computeBasisOffset({ brokerSymbol, asset })
        basis_offset = offset || 0
    } catch (err) {
        logger.warn(LOG, `basis offset failed for ${asset}→${brokerSymbol}: ${err.message}`)
    }

    return { broker_symbol: brokerSymbol, basis_offset }
}

// Called on Generate. Bind venue from the marked accounts (bank icon), resolve the symbol gate,
// then validate + persist. Multi-broker forking is deferred — the call binds to the MAIN account's
// broker for the trial; all marked account ids are stored.
export async function _finalizeCall(call, { userId = null, accounts = [], mainAccountId = null } = {}) {
    const list = Array.isArray(accounts) ? accounts.filter(a => a && a.id != null) : []
    const main = list.find(a => String(a.id) === String(mainAccountId)) ?? list[0] ?? null
    const broker = main?.broker ?? null

    const { broker_symbol, basis_offset } = await _resolveVenue(broker, userId, main?.id ?? null, call.asset)

    const merged = {
        ...call,
        broker,
        accounts:        list.map(a => String(a.id)),
        main_account_id: main?.id != null ? String(main.id) : null,
        broker_symbol,
        basis_offset,
    }

    return kairosService.saveKairosCall(merged, userId)
}

// ─── Prompt / messages ────────────────────────────────────────────────────────
function _buildSystemPrompt(chatState, accounts, { hasChartTool = true } = {}) {
    const asset = chatState?.active_asset || 'none'
    const draft = chatState?.draft
        ? `\nDraft call so far (carry set fields forward, only change what's discussed):\n${JSON.stringify(chatState.draft, null, 2)}`
        : ''

    const chartNote = hasChartTool
        ? ''
        : '\n\nNOTE: get_chart is NOT available this session — do your visual read from get_candles and web_search, and never claim to see a chart image.'

    const dynamicContext = `---
CONVERSATION CONTEXT:
Active asset: ${asset}${draft}${_buildAccountsSection(accounts)}${chartNote}`

    return [
        { type: 'text', text: _baseSystemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicContext },
    ]
}

function _buildAccountsSection(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        return '\n\nACCOUNTS: none marked. Tell the user to mark a trading account (paper / live / manual) at the bank icon — the call can\'t be generated or monitored without one.'
    }
    const lines = buildAccountLines(accounts)
    return `\n\nACCOUNTS (marked at the bank icon — the call will bind here):\n${lines.join('\n')}`
}

function _buildMessages({ messages, userPrompt }) {
    if (Array.isArray(messages) && messages.length > 0) {
        return normalizeMessages(messages, MAX_RECENT_MESSAGES)
    }
    return userPrompt?.trim() ? [{ role: 'user', content: userPrompt.trim() }] : []
}
