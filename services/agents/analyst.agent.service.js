// The Analyst agent (P3) — a buy-side research analyst. Streams a research conversation and emits a
// <coverage> draft (the variant-perception thesis + our price target vs the Street + kill-criteria).
// Mirrors the Kairos agent shape: the agent captures the raw <coverage> block and returns it as a
// DRAFT for preview; normalization + persistence happen at initiate (coverage.service.initiateCoverage),
// exactly as Kairos parses <call> here and normalizeCall runs at save.

import { fileURLToPath } from 'url'
import { makePhaseCapture, runAgentStream } from '../agentIO.js'
import { parseEmitBlock } from '../agentIO.js'
import { toolsFor } from '../agentTools.registry.js'
import { dirname, join } from 'path'

import { getFundamentals, getEarnings, getStockPeers, getSectorSnapshot, getMacroSnapshot } from '../../providers/fmp.provider.js'
import { getSecFilings } from '../../providers/sec.provider.js'
import { makePromptLoader, stripEmitTags, normalizeMessages, makeToolHandler, buildAudienceSection, attachTurnContext, LANGUAGE_RULE, VENUE_RULE, COMMON_TOOL_HANDLERS } from '../agentUtils.js'
import { makeTradingContextHandlers, buildVenueSection, TRADING_CONTEXT_TOOL_SPEC } from '../tools/tradingContext.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from '../tools/marketHours.tools.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { VALUATION_TOOLS, VALUATION_TOOL_HANDLERS } from '../tools/valuation.tools.js'
import { logger } from '../logger.service.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const LOG         = '[analystAgent]'
const PROMPT_PATH = join(__dirname, '../../prompts/analyst_system_prompt.md')
const _systemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 8

export const TOOLS = [
    // web_search leads, then the SHARED valuation module (its own single home), then the
    // read tools. Order is preserved exactly — prompt caching keys off the array prefix.
    ...toolsFor({
        web_search: '',
    }),
    ...VALUATION_TOOLS,   // get_consensus, compute_valuation (P2)
    ...toolsFor({
        get_fundamentals: `Company fundamentals for a single ticker: sector/industry, market cap, valuation, margins, ROE, growth. The Phase-1 profile read.`,
        get_sec_filings: `What the company actually filed with the SEC: latest 8-K (2.02 = earnings release), 10-Q, 10-K, with dates + links. Free EDGAR read — confirm what happened, don't rely on memory. US filers only.`,
        get_earnings: `Next earnings date + EPS estimate, and the last 4 quarterly EPS actuals vs estimates (surprise %). Use it for the catalyst calendar and the beat/miss track record.`,
        get_stock_peers: `The fundamental peer cohort (same sector/size) for a ticker — the comp set for a relative-multiple argument.`,
        get_sector_snapshot: `Today’s sector rotation — every sector ranked leaders→laggards. Backdrop for whether the group is a tailwind or headwind. No arguments.`,
        get_macro_snapshot: `Hard macro regime: treasury curve, key econ indicators, sector move. The top-down backdrop for a long-horizon thesis. No arguments.`,
        get_short_interest: `Short % of float + days-to-cover for a US single stock (FINRA, ~2-week lag). Crowded-bearish / squeeze context for the thesis. No ETFs/crypto.`,
        get_options_context: `Options positioning for a US equity/ETF: put/call ratio + ATM implied vol (nearest expiry). How big a move the market is pricing around a catalyst.`,
        get_trading_context: TRADING_CONTEXT_TOOL_SPEC.get_trading_context,
        check_broker_symbol: `Check whether a name is actually TRADABLE at the user's connected live broker, and what the broker calls it. Coverage on a name the user physically cannot buy is research nobody can act on — check before initiating, and say so in the thesis if the name is unavailable. tradable null means the broker could not be reached: UNKNOWN, never treat as unavailable.`,
        // APPENDED, never inserted — the snapshot compares by index and prompt caching keys off
        // the array prefix.
        get_market_hours: MARKET_HOURS_TOOL_SPEC.get_market_hours,
    }),
]

const TOOL_HANDLERS = {
    ...VALUATION_TOOL_HANDLERS,
    get_fundamentals:    makeToolHandler('get_fundamentals',    ({ ticker }) => getFundamentals(ticker),  (e, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${e.message}`, LOG),
    get_sec_filings:     makeToolHandler('get_sec_filings',     ({ ticker }) => getSecFilings(ticker),    (e, { ticker }) => `Could not fetch SEC filings for ${ticker}: ${e.message}`, LOG),
    get_earnings:        makeToolHandler('get_earnings',        ({ ticker }) => getEarnings(ticker),      (e, { ticker }) => `Could not fetch earnings for ${ticker}: ${e.message}`, LOG),
    get_stock_peers:     makeToolHandler('get_stock_peers',     ({ ticker }) => getStockPeers(ticker),    (e, { ticker }) => `Could not fetch peers for ${ticker}: ${e.message}`, LOG),
    get_sector_snapshot: makeToolHandler('get_sector_snapshot', () => getSectorSnapshot(),                (e) => `Could not fetch sector snapshot: ${e.message}`, LOG),
    get_macro_snapshot:  makeToolHandler('get_macro_snapshot',  () => getMacroSnapshot(),                 (e) => `Could not fetch macro snapshot: ${e.message}`, LOG),
    ...COMMON_TOOL_HANDLERS,   // get_short_interest, get_options_context, get_derivatives_context
    // Unbound (market hours belong to the instrument, not the user) — so it lives in the
    // static map, unlike the venue handlers that are rebuilt per request around a userId.
    ...makeMarketHoursHandlers(),
}

export const analystAgentService = { chatStream }

async function chatStream({
    messages, userPrompt, chatState = {}, seed = null, audience = null,
    model: requestedModel, reasoningEffort, userId,
    onToken, onToolStart, onReasoning, onPhase, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
    _venueSection = buildVenueSection,
}) {
    const systemPrompt  = _buildSystemPrompt(chatState, seed, audience)
    // The venue (mode / broker / accounts / free cash) rides the last USER message rather than
    // the system prompt: free cash moves whenever anything fills, so a volatile system block
    // would sit ahead of the whole conversation in the cache prefix. See buildVenueSection.
    const builtMessages = attachTurnContext(
        attachTurnContext(_buildMessages({ messages, userPrompt }), _buildTurnContext(chatState)),
        await _venueSection(userId))


    const phase = makePhaseCapture(6, onPhase)
    // Suppress every emit tag from the token stream; capture phase live. <coverage> is suppressed and
    // parsed from `raw` afterward (same as Kairos parses <call>).
    const tagCaptures = buildTagCaptures({ phase: phase.capture })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: { ...TOOL_HANDLERS, ...makeTradingContextHandlers(userId) },
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onChart,
        meta: { userPrompt },
    })

    const { reply, coverage } = _parseAnalystResponse(raw)
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasCoverage: Boolean(coverage), phase: phase.get() })
    // The coverage is a DRAFT — returned for preview, NOT saved. Initiating persists it (P1).
    return { reply, phase: phase.get(), ...(coverage ? { coverage } : {}) }
}

// ─── Coverage extraction (pure) ───────────────────────────────────────────────
// Pull the <coverage> JSON out of raw model output. Returns the visible reply (block stripped) + the
// parsed draft (null when absent, malformed, or missing a symbol). A "no-edge" turn emits no block.
export function _parseAnalystResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['coverage', 'phase']).trim()
    return { reply, coverage: _cleanDraft(parseEmitBlock(text, 'coverage', LOG)) }
}

// Light guard on the draft (full normalization happens at initiate): must be an object with a symbol.
function _cleanDraft(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    if (typeof c.symbol !== 'string' || !c.symbol.trim()) return null
    return { ...c, symbol: c.symbol.toUpperCase().trim() }
}

// The plausibility flags standing against the last model (coverage.service `_plausibilityFlags`).
//
// They ride on the stored doc, so update mode already showed them to the agent — as two unlabelled
// objects in a 60-line JSON dump, which is the same as not showing them. The last re-model read a
// flagged 30x bear leg and moved it FURTHER out (TSLA, 42 → 36, widening the band to 11.7x), because
// nothing in the prompt said what the array was or that it was owed an answer.
//
// So they come out of the dump and get named. Framed as the desk's objections rather than as
// instructions: the analyst may defend a leg — arguing a name re-rates outside its own history is a
// legitimate variant view, which is exactly why these RECORD rather than refuse — but it must now
// answer instead of stepping over.
const _withoutFlags = ({ flags, ...rest }) => rest   // eslint-disable-line no-unused-vars
function _objectionsBlock(flags) {
    const list = (Array.isArray(flags) ? flags : [])
        .map(f => ({ leg: typeof f?.leg === 'string' ? f.leg.trim() : '', detail: typeof f?.detail === 'string' ? f.detail.trim() : '' }))
        .filter(f => f.detail)
    if (!list.length) return ''
    return `\n\nSTANDING OBJECTIONS to the model above — the desk's automated coherence checks flagged these`
        + ` and they are UNANSWERED. Address every one: either fix the leg, or state plainly in the thesis`
        + ` what justifies it. Do not re-emit the same numbers without saying which you chose and why.\n`
        + list.map(f => `  • ${f.leg ? `[${f.leg} leg] ` : ''}${f.detail}`).join('\n')
}

/**
 * SESSION-STABLE only. The draft moved to _buildTurnContext — it changes every turn, and in
 * `system` that sat ahead of the whole conversation in the cache prefix, so the history breakpoint
 * behind it could never hit. See agentUtils.attachTurnContext.
 *
 * `existing_coverage` deliberately STAYS: it is the stored thesis, fetched once for the session and
 * byte-identical thereafter — it is the draft that moves, not everything shaped like JSON.
 */
export function _buildSystemPrompt(chatState, seed = null, audience = null) {
    const today  = new Date().toISOString().slice(0, 10)
    const active = chatState?.active_symbol || 'none'
    const existingBlock = chatState?.existing_coverage
        ? `\nEXISTING COVERAGE — update mode: this name is already in the book. Revise the thesis rather than starting from scratch. Reference what's changed since the prior view.\n`
            + `${JSON.stringify(_withoutFlags(chatState.existing_coverage), null, 2)}`
            + _objectionsBlock(chatState.existing_coverage?.flags)
        : ''
    // P4b: an Argus INVESTING-profile candidate handed over for research. Start Phase 1 with this name +
    // Argus's screen read as a provisional input — VERIFY it, don't take it on faith, and form your OWN view.
    const seedBlock = seed?.ticker
        ? `\nARGUS SEED (research this candidate): ticker=${seed.ticker}${seed.sector ? `, sector=${seed.sector}` : ''}`
            + `${seed.thesis ? `\n  Argus's screen rationale: ${seed.thesis}` : ''}${seed.analysis ? `\n  Argus's fundamental read: ${seed.analysis}` : ''}`
            + `\n  → Start here, verify Argus's read against the tools, then form your own variant view.`
        : ''
    const audienceBlock = buildAudienceSection(audience)
    const dynamic = `---
CURRENT DATE: ${today}. Resolve relative dates (this quarter, next earnings) against it.
${audienceBlock ? `
${audienceBlock}

` : ''}Active name: ${active}${seedBlock}${existingBlock}`
    return [
        { type: 'text', text: _systemPrompt() + LANGUAGE_RULE + VENUE_RULE, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamic },
    ]
}

/**
 * The one per-TURN thing Prometheus carries: the coverage being drafted. Rides on the last user
 * message so it is frozen history by the next turn. PURE; '' when there is no draft yet.
 */
export function _buildTurnContext(chatState) {
    return chatState?.draft
        ? `---\nDraft coverage so far (carry set fields forward, only change what's discussed):\n${JSON.stringify(chatState.draft, null, 2)}`
        : ''
}

function _buildMessages({ messages, userPrompt }) {
    if (Array.isArray(messages) && messages.length) return normalizeMessages(messages, MAX_RECENT_MESSAGES)
    return userPrompt ? [{ role: 'user', content: String(userPrompt) }] : []
}
