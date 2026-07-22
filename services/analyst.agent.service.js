// The Analyst agent (P3) — a buy-side research analyst. Streams a research conversation and emits a
// <coverage> draft (the variant-perception thesis + our price target vs the Street + kill-criteria).
// Mirrors the Kairos agent shape: the agent captures the raw <coverage> block and returns it as a
// DRAFT for preview; normalization + persistence happen at initiate (coverage.service.initiateCoverage),
// exactly as Kairos parses <call> here and normalizeCall runs at save.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { getFundamentals, getEarnings, getStockPeers, getSectorSnapshot, getMacroSnapshot } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { makePromptLoader, stripEmitTags, buildPositionsSection, normalizeMessages, resolveAgentStream, makeToolHandler, COMMON_TOOL_HANDLERS } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { VALUATION_TOOLS, VALUATION_TOOL_HANDLERS } from './valuation.tools.js'
import { logger } from './logger.service.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const LOG         = '[analystAgent]'
const PROMPT_PATH = join(__dirname, '../analyst_system_prompt.md')
const _systemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 8

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    ...VALUATION_TOOLS,   // get_consensus, compute_valuation (P2)
    {
        name: 'get_fundamentals',
        description: 'Company fundamentals for a single ticker: sector/industry, market cap, valuation, margins, ROE, growth. The Phase-1 profile read.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA' } }, required: ['ticker'] },
    },
    {
        name: 'get_sec_filings',
        description: "What the company actually filed with the SEC: latest 8-K (2.02 = earnings release), 10-Q, 10-K, with dates + links. Free EDGAR read — confirm what happened, don't rely on memory. US filers only.",
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. AAPL, NKE' } }, required: ['ticker'] },
    },
    {
        name: 'get_earnings',
        description: 'Next earnings date + EPS estimate, and the last 4 quarterly EPS actuals vs estimates (surprise %). Use it for the catalyst calendar and the beat/miss track record.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA' } }, required: ['ticker'] },
    },
    {
        name: 'get_stock_peers',
        description: 'The fundamental peer cohort (same sector/size) for a ticker — the comp set for a relative-multiple argument.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA' } }, required: ['ticker'] },
    },
    {
        name: 'get_sector_snapshot',
        description: 'Today’s sector rotation — every sector ranked leaders→laggards. Backdrop for whether the group is a tailwind or headwind. No arguments.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_macro_snapshot',
        description: 'Hard macro regime: treasury curve, key econ indicators, sector move. The top-down backdrop for a long-horizon thesis. No arguments.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_short_interest',
        description: 'Short % of float + days-to-cover for a US single stock (FINRA, ~2-week lag). Crowded-bearish / squeeze context for the thesis. No ETFs/crypto.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. GME, TSLA' } }, required: ['ticker'] },
    },
    {
        name: 'get_options_context',
        description: 'Options positioning for a US equity/ETF: put/call ratio + ATM implied vol (nearest expiry). How big a move the market is pricing around a catalyst.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. NVDA, SPY' } }, required: ['ticker'] },
    },
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
}

export const analystAgentService = { chatStream }

async function chatStream({
    messages, userPrompt, chatState = {}, brokerContext = null,
    model: requestedModel, reasoningEffort, userId,
    onToken, onToolStart, onReasoning, onPhase, signal,
}) {
    const { model, streamFn, provider, onUsage } = resolveAgentStream(requestedModel, userId)
    const systemPrompt  = _buildSystemPrompt(chatState, brokerContext)
    const builtMessages = _buildMessages({ messages, userPrompt })

    logger.info(LOG, 'chatStream start', { userPrompt, messageCount: builtMessages.length, model, provider })

    let capturedPhase = null
    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 6) { capturedPhase = n; onPhase?.(n) }
    }
    // Suppress every emit tag from the token stream; capture phase live. <coverage> is suppressed and
    // parsed from `raw` afterward (same as Kairos parses <call>).
    const tagCaptures = buildTagCaptures({ phase: onPhaseCapture })

    const raw = await streamFn({
        model, promptOrMessages: builtMessages, systemPrompt, tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onUsage,
    })

    const { reply, coverage } = _parseAnalystResponse(raw)
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasCoverage: Boolean(coverage), phase: capturedPhase })
    // The coverage is a DRAFT — returned for preview, NOT saved. Initiating persists it (P1).
    return { reply, phase: capturedPhase, ...(coverage ? { coverage } : {}) }
}

// ─── Coverage extraction (pure) ───────────────────────────────────────────────
// Pull the <coverage> JSON out of raw model output. Returns the visible reply (block stripped) + the
// parsed draft (null when absent, malformed, or missing a symbol). A "no-edge" turn emits no block.
export function _parseAnalystResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['coverage', 'phase']).trim()
    const m = text.match(/<coverage>([\s\S]*?)<\/coverage>/)
    if (!m) return { reply, coverage: null }
    try {
        return { reply, coverage: _cleanDraft(JSON.parse(m[1].trim())) }
    } catch (err) {
        logger.warn(LOG, 'coverage JSON parse failed:', err.message)
        return { reply, coverage: null }
    }
}

// Light guard on the draft (full normalization happens at initiate): must be an object with a symbol.
function _cleanDraft(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    if (typeof c.symbol !== 'string' || !c.symbol.trim()) return null
    return { ...c, symbol: c.symbol.toUpperCase().trim() }
}

function _buildSystemPrompt(chatState, brokerContext = null) {
    const today  = new Date().toISOString().slice(0, 10)
    const active = chatState?.active_symbol || 'none'
    const draft  = chatState?.draft
        ? `\nDraft coverage so far (carry set fields forward, only change what's discussed):\n${JSON.stringify(chatState.draft, null, 2)}`
        : ''
    const dynamic = `---
CURRENT DATE: ${today}. Resolve relative dates (this quarter, next earnings) against it.
Active name: ${active}${draft}${buildPositionsSection(brokerContext)}`
    return [
        { type: 'text', text: _systemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamic },
    ]
}

function _buildMessages({ messages, userPrompt }) {
    if (Array.isArray(messages) && messages.length) return normalizeMessages(messages, MAX_RECENT_MESSAGES)
    return userPrompt ? [{ role: 'user', content: String(userPrompt) }] : []
}
