import { fileURLToPath } from 'url'
import { parseEmitBlock, mergeDraft, runAgentStream } from './agentIO.js'
import { dirname, join } from 'path'
import { makePromptLoader, stripEmitTags, buildAccountLines, normalizeMessages, buildTimeSection } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { KAIROS_TOOLS, buildKairosToolHandlers } from './kairos.tools.js'
import { normalizeSetup, setupReadiness, computeRR } from './setup.schema.js'
import { logger } from './logger.service.js'

// Mentor — the trade ASSISTANT (Pipeline F). A conversation → a draft `setup` entity.
//
// Forked from the Kairos scaffold, which is the right shape for this: the emitted worksheet IS
// the state (no separate <state> block to carry), the client owns chat history, and nothing
// persists until the user presses Generate. What differs is the CONVERSATION contract — Mentor
// has no phases, so there is no phase capture and no PHASE_TABLES entry; it routes through the
// classifier (see modelRouter). The user always brings the ticker, so there is no scan hand-off.
//
// Tools are borrowed WHOLE from Kairos (docs/setup-entity.md §8 — share the pipe). Deliberately
// un-subsetted: Kairos picks one lens per build, but Mentor's lens is per-SETUP and it must be
// able to weigh a classical candidate against an SMC one inside a single conversation.

const __dirname   = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../mentor_system_prompt.md')
const LOG         = '[mentorAgent]'
const MAX_RECENT_MESSAGES = 8

const _baseSystemPrompt = makePromptLoader(PROMPT_PATH, LOG)

/** The dimensions <coverage> may claim. Anything else is dropped. */
export const COVERAGE_DIMENSIONS = ['markets', 'company', 'technicals']

export function emptyMentorState() {
    return { active_asset: '', draft: null, coverage: [] }
}

export const mentorAgentService = { chatStream }

async function chatStream({
    messages, userPrompt, chatState = emptyMentorState(), accounts = [], mainAccountId = null,
    clientTime = null,
    model: requestedModel, reasoningEffort, userId,
    onToken, onAsset, onInterval, onChart, onToolStart, onReasoning, onCoverage, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
}) {

    const tools        = KAIROS_TOOLS
    const toolHandlers = buildKairosToolHandlers(onChart, userId)

    const systemPrompt  = _buildSystemPrompt(chatState, accounts, mainAccountId, clientTime)
    const builtMessages = _buildMessages({ messages, userPrompt })

    // Coverage is CUMULATIVE across the conversation: the model re-states everything it has read,
    // but a turn that forgets a dimension must not un-read it. Union with the prior state.
    let capturedCoverage = null
    const onCoverageCapture = (raw) => {
        // Merge against what we've accumulated THIS turn, not the turn's starting state — a model
        // that emits <coverage> twice would otherwise have its second emit discard the first.
        const merged = mergeCoverage(capturedCoverage ?? chatState?.coverage, raw)
        capturedCoverage = merged
        onCoverage?.(merged)
    }

    const tagCaptures = buildTagCaptures({
        asset:    onAsset,
        interval: onInterval,
        coverage: onCoverageCapture,
    })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt, tools, toolHandlers,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onChart,
        meta: { userPrompt, asset: chatState?.active_asset || '', accounts: accounts?.length ?? 0 },
    })

    const { reply, setup, setups } = _parseMentorResponse(raw)

    // A candidate-offer turn and a worksheet turn are mutually exclusive by contract; if the model
    // emits both, the picked worksheet wins (it's the more committed artifact).
    const merged     = _mergeSetupDraft(chatState?.draft, setup)
    const normalized = merged ? normalizeSetup(merged) : null
    if (normalized) normalized.rr = computeRR(normalized) ?? normalized.rr

    const readiness = normalized ? setupReadiness(normalized, (accounts?.length ?? 0) > 0) : null

    logger.info(LOG, 'chatStream done', {
        replyLength: reply.length,
        hasSetup: Boolean(normalized),
        candidates: setups?.candidates?.length ?? 0,
        ready: readiness?.ready ?? false,
        coverage: capturedCoverage ?? chatState?.coverage ?? [],
    })

    return {
        reply,
        coverage: capturedCoverage ?? chatState?.coverage ?? [],
        ...(normalized ? { setup: normalized, readiness } : {}),
        ...(setups && !normalized ? { setups } : {}),
    }
}

// ─── Coverage (pure) ──────────────────────────────────────────────────────────

/**
 * Merge a `<coverage>` emit into the running set. Accepts the comma-separated tag body or an
 * array; unknown dimensions are dropped. Union, never replace — coverage only ever grows within
 * a conversation, so a turn that omits an already-read dimension can't reset the progress display.
 */
export function mergeCoverage(prior, raw) {
    const incoming = Array.isArray(raw)
        ? raw
        : String(raw ?? '').split(',')
    const next = incoming
        .map(s => String(s).trim().toLowerCase())
        .filter(s => COVERAGE_DIMENSIONS.includes(s))
    return [...new Set([...(Array.isArray(prior) ? prior : []), ...next])]
}

// ─── Draft carry-forward (pure) ───────────────────────────────────────────────

/**
 * Merge a freshly emitted setup onto the prior draft so an OMITTED field carries forward.
 *
 * The prompt demands the complete worksheet every turn, but on an edit turn the model sometimes
 * narrates "everything else stands" and emits only the changed field. The client replaces its
 * draft wholesale, so that thin block would wipe settled zones.
 *
 * Shallow BY DESIGN (same rule as Kairos's `_mergeCallDraft`): a re-emitted array or object
 * replaces its prior value outright, so the model can still DROP a zone or clear a field with an
 * explicit null — only omission is protected. Returns null when there's no new setup this turn.
 */
export const _mergeSetupDraft = mergeDraft

// ─── Emit-block extraction (pure) ─────────────────────────────────────────────

/**
 * Pull `<setup>` (the live worksheet) and `<setups>` (the 2–3 candidate offer) out of the raw
 * model output, returning the user-visible reply with both blocks stripped. A malformed block is
 * logged and treated as absent — the client keeps its existing draft rather than being handed
 * a half-parsed one.
 */
export function _parseMentorResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['setup', 'setups', 'asset', 'interval', 'coverage']).trim()

    return { reply, setup: _parseBlock(text, 'setup'), setups: _parseCandidates(text) }
}

// The shared extractor already matches the tag EXACTLY, which is what keeps <setups> from being
// read as a <setup> whose body happens to start with an "s".
const _parseBlock = (text, tag) => parseEmitBlock(text, tag, LOG)

/**
 * The candidate offer. Each entry is a full setup plus a label and a pitch; the setups are
 * normalised here so the client renders comparable cards (rr, readiness) rather than raw model
 * output. Candidates that don't normalise to anything are dropped; an empty list → null.
 */
export function _parseCandidates(text) {
    const parsed = _parseBlock(text, 'setups')
    const list   = Array.isArray(parsed?.candidates) ? parsed.candidates : null
    if (!list) return null

    const candidates = list.reduce((out, c) => {
        const setup = normalizeSetup(c?.setup)
        if (!setup) return out
        setup.rr = computeRR(setup) ?? setup.rr
        out.push({
            label: typeof c?.label === 'string' && c.label.trim() ? c.label.trim() : setup.trade_mode,
            pitch: typeof c?.pitch === 'string' ? c.pitch.trim() : '',
            setup,
        })
        return out
    }, [])

    return candidates.length ? { candidates } : null
}

// ─── Prompt / messages ────────────────────────────────────────────────────────

function _buildSystemPrompt(chatState, accounts, mainAccountId, clientTime) {
    const asset = chatState?.active_asset || 'none'
    const draft = chatState?.draft
        ? `\nSetup so far (carry every settled field forward; change only what's discussed):\n${JSON.stringify(chatState.draft, null, 2)}`
        : ''

    const covered = Array.isArray(chatState?.coverage) && chatState.coverage.length
        ? chatState.coverage.join(', ')
        : 'nothing yet'

    const today = new Date().toISOString().slice(0, 10)
    const dynamicContext = `---
CURRENT DATE: ${today}. Resolve relative dates (today, next week, this month) against it — including when setting active_from / valid_until.
${buildTimeSection(clientTime, 'active_from / valid_until')}
COVERAGE SO FAR: ${covered}. Re-state these in every <coverage> tag plus anything new you read this turn.
CONVERSATION CONTEXT:
Active asset: ${asset}${draft}${_buildAccountsSection(accounts, mainAccountId)}`

    return [
        { type: 'text', text: _baseSystemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicContext },
    ]
}

function _buildAccountsSection(accounts, mainAccountId = null) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        return '\n\nACCOUNTS: none marked. Tell the user to mark a trading account (paper / live / manual) at the bank icon — the setup can\'t be generated or monitored without one.'
    }
    const lines = buildAccountLines(accounts, mainAccountId)
    const mainNote = accounts.length > 1
        ? ' The account tagged ← MAIN is the one the setup binds to — its broker sets the venue (symbol + price space) it executes and is monitored in.'
        : ''
    return `\n\nACCOUNTS (marked at the bank icon — the setup will bind here):\n${lines.join('\n')}${mainNote}`
}

function _buildMessages({ messages, userPrompt }) {
    if (Array.isArray(messages) && messages.length > 0) {
        return normalizeMessages(messages, MAX_RECENT_MESSAGES)
    }
    return userPrompt?.trim() ? [{ role: 'user', content: userPrompt.trim() }] : []
}
