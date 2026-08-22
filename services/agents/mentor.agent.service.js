import { fileURLToPath } from 'url'
import { parseEmitBlock, mergeDraft, runAgentStream } from '../agentIO.js'
import { dirname, join } from 'path'
import { makePromptLoader, stripEmitTags, buildAccountLines, buildTimeSection, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, VENUE_RULE, cachedBlock, buildDeskMessages } from '../agentUtils.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { TRADING_TOOLS, buildTradingToolHandlers } from '../tools/trading.tools.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { buildVenueSection } from '../tools/tradingContext.tools.js'
import { normalizeSetup, setupReadiness, computeRR, validityProblems } from '../setup.schema.js'
import { logger } from '../logger.service.js'

// Mentor — the trade ASSISTANT (Pipeline F). A conversation → a draft `setup` entity.
//
// Forked from the Kairos scaffold, which is the right shape for this: the emitted worksheet IS
// the state (no separate <state> block to carry), the client owns chat history, and nothing
// persists until the user presses Generate. What differs is the CONVERSATION contract — Mentor
// has no phases, so there is no phase capture — its invariants are not steps
// (docs/desks/mentor-talos.md). The user always brings the ticker, so there is no scan hand-off.
//
// The tool kit is Mentor's own — services/tools/trading.tools.js, which carried Kairos's name until
// that desk was archived (2026-08-18) and is now named for its only live consumer. Taken WHOLE and
// deliberately un-subsetted: subsetting by lens suits a desk that picks one lens per build, but
// Mentor's lens is per-SETUP and it must weigh a classical candidate against an SMC one in a
// single conversation.

const __dirname   = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../../prompts/mentor_system_prompt.md')
const LOG         = '[mentorAgent]'
const MAX_RECENT_MESSAGES = 8

const _baseSystemPrompt = makePromptLoader(PROMPT_PATH, LOG)

/** The dimensions <coverage> may claim. Anything else is dropped. */
export const COVERAGE_DIMENSIONS = ['markets', 'company', 'technicals']

// Kairos's kit plus the reasoning sidecar, APPENDED so the shared array is the exact prefix of
// this one — the tools cache breakpoint sits inside TRADING_TOOLS, and inserting anywhere before it
// would re-write that cache on every Mentor turn.
//
// The sidecar now runs at every conversational desk. Mentor was the trial, and the shape it proved
// is the one they all follow: declare the tool, pass your OWN when-clause, wire nothing. The
// mechanism paragraphs come from consultDescription (deepThink.service.js) so they cannot drift
// desk to desk; the clause below is Mentor's own judgment and is the only part that is Mentor's.
//
// Gate it on DATA, not on it feeling useful: `byAgent.consult` in token_usage carries the reach
// rate and cost, and per-desk reach is now the thing to watch — a desk that consults on most turns
// has a description too permissive and wants tightening; one that never consults is paying a tool
// declaration for nothing.
export const MENTOR_TOOLS = [
    ...TRADING_TOOLS,
    ...toolsFor({
        // The sidecar is contractually last at every desk that declares it
        // (agentToolsRegistry.test.js), and it sits past the tools cache breakpoint — which is
        // inside TRADING_TOOLS, on get_derivatives_context — so declaring it here touches no
        // cached prefix.
        consult: consultDescription(`Reach for it in exactly three situations: **final sizing on real money** (live or manual — the account is at risk and the arithmetic has to be right); **two readings that genuinely disagree** and you cannot settle which one governs the entry; and **placing a zone where the structure is ambiguous** — a level that is both a prior high and a supply shelf, say.`),
    }),
]

export function emptyMentorState() {
    return { active_asset: '', draft: null, coverage: [] }
}

export const mentorAgentService = { chatStream }

async function chatStream({
    messages, userPrompt, chatState = emptyMentorState(), accounts = [], mainAccountId = null,
    clientTime = null, audience = null, seed = null,
    model: requestedModel, reasoningEffort, userId,
    onToken, onAsset, onInterval, onChart, onToolStart, onReasoning, onCoverage, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _venueSection = buildVenueSection,
}) {

    const tools        = MENTOR_TOOLS
    // `consult` is deliberately absent: runAgentStream builds it from the tool declaration, which is
    // also the only place that holds `onReasoning` — wiring it here would swallow the sidecar's
    // thinking silently. See the MENTOR_TOOLS note above.
    const toolHandlers = buildTradingToolHandlers(onChart, userId)

    const systemPrompt  = _buildSystemPrompt(chatState, accounts, mainAccountId, audience, seed)
    // The venue (mode / broker / accounts / free cash) rides the last USER message rather than
    // the system prompt: free cash moves whenever anything fills, so a volatile system block
    // would sit ahead of the whole conversation in the cache prefix. See buildVenueSection.
    const builtMessages = attachTurnContext(
        attachTurnContext(_buildMessages({ messages, userPrompt }), _buildTurnContext(chatState, clientTime)),
        await _venueSection(userId))

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

/**
 * What the readiness gate says about the draft the agent itself emitted — fed BACK to it next turn.
 *
 * Without this the agent is the only party that can't see the verdict on its own work: the panel
 * shows a dark Generate button and the reason, the user has to read it out, and the agent re-emits
 * the same mistake because nothing told it. Live runs made that concrete — with two scenarios, the
 * validity ordering was right on one and wrong on the other about every other build, and each time
 * the refusal was invisible to the model that could have fixed it in one line.
 *
 * `missing` is deliberately NOT included: an unfinished setup is the normal state of a
 * conversation, and reciting the gaps every turn would push the agent to fill them by guessing
 * rather than by asking. A `problem` is different — the setup is complete and CONTRADICTS itself,
 * which is never something to wait out.
 */
export function _buildProblemsSection(draft) {
    const problems = draft ? validityProblems(draft) : []
    if (!problems.length) return ''
    return `\nTHE PLAN YOU EMITTED DOES NOT ADD UP — fix this in your next <setup>, and say so plainly rather than silently re-emitting:\n${
        problems.map(p => `- ${p}`).join('\n')}\nGenerate refuses a setup in this state, so the user cannot save it until you correct it.`
}

/**
 * SESSION-STABLE only. Talos carries THREE per-turn things and all three moved to
 * _buildTurnContext: the setup draft (and the problems derived from it), the coverage tally (it
 * grows on the turns the model reads something new), and the clock. Any one of them left here
 * would have been enough to keep the history breakpoint from hitting — the cache prefix does not
 * care how small the volatile block is, only that it sits ahead of the conversation.
 */
function _buildSystemPrompt(chatState, accounts, mainAccountId, audience = null, seed = null) {
    const asset = chatState?.active_asset || 'none'
    const today = new Date().toISOString().slice(0, 10)
    const audienceBlock = buildAudienceSection(audience)
    const dynamicContext = `---
CURRENT DATE: ${today}. Resolve relative dates (today, next week, this month) against it — including when setting active_from / valid_until.
${audienceBlock ? `
${audienceBlock}

` : ''}
CONVERSATION CONTEXT:
Active asset: ${asset}${_buildAccountsSection(accounts, mainAccountId)}${_buildSeedSection(seed)}`

    return [
        cachedBlock(_baseSystemPrompt() + LANGUAGE_RULE + VENUE_RULE + BREVITY_RULE),
        { type: 'text', text: dynamicContext },
    ]
}

/**
 * The name Argus handed over, and the lens it recommends. PURE; empty string when the user arrived
 * on their own, which is the ordinary case.
 *
 * The LENS IS A RECOMMENDATION, not a decision, and the prompt says so out loud because the two
 * read identically to a model handed a field called `recommended_mode`. Mentor's whole contract is
 * that it works on what the user brought and hands the decision back — silently adopting a scanner's
 * lens would be the desk quietly authoring for them, which is the one thing it must not do.
 *
 * It also has to be SAID. A recommendation the user never hears is indistinguishable from Mentor
 * having decided.
 */
function _buildSeedSection(seed) {
    if (!seed?.ticker) return ''
    const lens = String(seed.recommended_mode ?? '').trim()
    return `

ARGUS HANDED YOU THIS NAME: ${seed.ticker}${seed.direction ? ` (${seed.direction})` : ''}`
        + `${seed.thesis ? `
  thesis: ${seed.thesis}` : ''}`
        + `${seed.analysis ? `
  Argus's read: ${seed.analysis}` : ''}`
        + (lens ? `
  Argus recommends the ${lens} lens.` : '')
        + `

Open on it: say the name, relay Argus's read in a sentence rather than restating it wholesale, and`
        + (lens
            ? ` NAME THE RECOMMENDED LENS AND WHY IT FITS — then ask whether they want to build it that way. It is Argus's recommendation, not a decision: if the user wants a different lens, or the chart disagrees with it, say so and use theirs. A lens adopted without the user hearing it is one they never chose.`
            : ` ask which lens they want to build it through.`)
        + ` The ticker is settled unless they change it; everything else is still theirs to shape.`
}

/**
 * Everything that is true only for THIS turn. Rides on the last user message. PURE.
 *
 * The COVERAGE tally travels with its own re-state instruction, and the draft with its
 * carry-forward rule and the problems block: an instruction separated from the data it governs is
 * how a prompt quietly stops meaning what it says.
 */
export function _buildTurnContext(chatState, clientTime = null) {
    const draft = chatState?.draft
        ? `\nSetup so far (carry every settled field forward; change only what's discussed):\n${JSON.stringify(chatState.draft, null, 2)}${_buildProblemsSection(chatState.draft)}`
        : ''

    const covered = Array.isArray(chatState?.coverage) && chatState.coverage.length
        ? chatState.coverage.join(', ')
        : 'nothing yet'

    return `---
${buildTimeSection(clientTime, 'active_from / valid_until')}
COVERAGE SO FAR: ${covered}. Re-state these in every <coverage> tag plus anything new you read this turn.${draft}`
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
    return buildDeskMessages({ messages, userPrompt, max: MAX_RECENT_MESSAGES })
}
