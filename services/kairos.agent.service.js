import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { makePromptLoader, stripEmitTags, buildAccountLines, buildPositionsSection, normalizeMessages, resolveAgentStream } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
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
    messages, userPrompt, chatState = emptyKairosState(), accounts = [], brokerContext = null,
    model: requestedModel, reasoningEffort, userId,
    onToken, onChart, onToolStart, onReasoning, onPhase, signal,
}) {
    const { model, streamFn, provider, onUsage } = resolveAgentStream(requestedModel, userId)

    const tools        = KAIROS_TOOLS
    const toolHandlers = buildKairosToolHandlers(onChart)

    const systemPrompt  = _buildSystemPrompt(chatState, accounts, brokerContext)
    const builtMessages = _buildMessages({ messages, userPrompt })

    logger.info(LOG, 'chatStream start', { userPrompt, messageCount: builtMessages.length, model, provider, accounts: accounts?.length ?? 0 })

    // The model emits <phase>N</phase> (1–5) at the start of each turn; capture it for the UI
    // progress + next-turn model routing. <call> is suppressed from the token stream and parsed
    // from `raw`.
    let capturedPhase = null
    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 5) { capturedPhase = n; logger.info(LOG, 'phase', n); onPhase?.(n) }
    }
    // All known emit tags suppressed by default; this agent captures phase. <call> is
    // suppressed from the token stream and parsed from `raw` afterward.
    const tagCaptures = buildTagCaptures({ phase: onPhaseCapture })

    const raw = await streamFn({
        model, promptOrMessages: builtMessages, systemPrompt, tools, toolHandlers,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onUsage,
    })

    const { reply, call } = _parseKairosResponse(raw)
    const mergedCall = _mergeCallDraft(chatState?.draft, call)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasCall: Boolean(call), merged: Boolean(mergedCall) })

    // DIAGNOSTIC (temporary): the "content disappears when streaming finishes" symptom traces to
    // turns where a <call> fragment is present but did NOT parse — a malformed/unclosed block. On
    // those turns the tag suppressor can swallow trailing narration (flush drops an unclosed block)
    // and stripEmitTags can leak or over-strip. Dump the shape + tail so we can see the exact emit.
    const rawStr = String(raw ?? '')
    const hasCallOpen  = /<call>/i.test(rawStr)
    const hasCallClose = /<\/call>/i.test(rawStr)
    if (hasCallOpen && (!call || !hasCallClose)) {
        logger.warn(LOG, 'malformed <call> emit', {
            rawLen: rawStr.length, replyLen: reply.length, parsed: Boolean(call),
            hasClose: hasCallClose,
            afterClose: hasCallClose ? rawStr.slice(rawStr.lastIndexOf('</call>') + 7).trim().length : null,
            tail: rawStr.slice(-500),
        })
    }

    // The call is a DRAFT — returned for preview, NOT saved. The user clicks Generate to persist.
    return { reply, phase: capturedPhase, ...(mergedCall ? { call: mergedCall } : {}) }
}

// ─── Draft carry-forward (pure) ───────────────────────────────────────────────
// The model is told to re-emit the COMPLETE call every turn (its prior draft is fed back as
// context), but on an edit turn it sometimes emits a PARTIAL block — narrating "…everything else
// stands" while the JSON carries only the changed field. The client replaces its draft wholesale,
// so that thin block would wipe already-settled parts of the worksheet (zones, levels, patterns).
// Merge a freshly parsed call onto the prior draft so an OMITTED field carries forward.
// Shallow BY DESIGN: a re-emitted array/object (entry_zones, sizing…) fully replaces its prior
// value, so the model can still edit or DROP a zone/pattern, and can clear a field by emitting null
// — only omission is protected. Returns null when there is no new call this turn (client keeps its
// existing draft untouched).
export function _mergeCallDraft(prevDraft, call) {
    if (!call) return null
    if (!prevDraft || typeof prevDraft !== 'object' || Array.isArray(prevDraft)) return call
    return { ...prevDraft, ...call }
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

// Called on Generate (and on the "Update call" edit — pass `updateId`). Bind venue from the marked
// accounts (bank icon), resolve the symbol gate, then validate + persist. Multi-broker forking is
// deferred — the call binds to the MAIN account's broker for the trial; all marked account ids are
// stored. `chatState` (build conversation + draft) rides along so an edit can reopen the chat.
export async function _finalizeCall(call, { userId = null, accounts = [], mainAccountId = null, updateId = null, chatState = undefined } = {}) {
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
        ...(chatState !== undefined ? { chat_state: chatState } : {}),
    }

    return updateId
        ? kairosService.updateKairosCall(updateId, merged, userId)
        : kairosService.saveKairosCall(merged, userId)
}

// ─── Prompt / messages ────────────────────────────────────────────────────────
function _buildSystemPrompt(chatState, accounts, brokerContext = null) {
    const asset = chatState?.active_asset || 'none'
    const draft = chatState?.draft
        ? `\nDraft call so far (carry set fields forward, only change what's discussed):\n${JSON.stringify(chatState.draft, null, 2)}`
        : ''

    const today = new Date().toISOString().slice(0, 10)
    const dynamicContext = `---
CURRENT DATE: ${today}. Resolve relative timeframes (today, next week, this month) against this date — e.g. when calling get_earnings_calendar or setting valid_until.
CONVERSATION CONTEXT:
Active asset: ${asset}${draft}${buildPositionsSection(brokerContext)}${_buildAccountsSection(accounts)}`

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
