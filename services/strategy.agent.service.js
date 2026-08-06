// Pythia — the strategy desk's streaming agent (key `strategy`; the brand is UI-only, exactly as
// Prometheus keeps the key `analyst`).
//
// Produces ONE artifact: a `tilt` — a named regime plus sector stances as active weight against a
// benchmark. Deliberately NOT an allocator and NOT a stock picker: Prometheus works bottom-up on
// names, Atlas allocates, and this desk exists precisely so the allocator reads a top-down view it
// did not write itself.
//
// The emitted `<tilt>` is a DRAFT, returned for preview and not saved — publishing it is a separate,
// explicit act (tiltService.publishTilt), same as a coverage draft vs initiating coverage.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { makePhaseCapture, runAgentStream, parseEmitBlock } from './agentIO.js'
import { toolsFor } from './agentTools.registry.js'
import { makePromptLoader, stripEmitTags, normalizeMessages, makeToolHandler, attachTurnContext, LANGUAGE_RULE } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { getMacroSnapshot, getSectorSnapshot } from '../providers/fmp.provider.js'
import { getPricedIn } from '../providers/fred.provider.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { SECTORS } from './entity/vocabulary.js'
import { logger } from './logger.service.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const LOG         = '[strategyAgent]'
const PROMPT_PATH = join(__dirname, '../strategy_system_prompt.md')
const _systemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 8

export const TOOLS = [
    // Order is preserved exactly — prompt caching keys off the array prefix, so new tools are
    // APPENDED, never inserted.
    ...toolsFor({
        web_search: '',
        get_macro_snapshot: `Hard macro read: the Treasury curve (3M/2Y/10Y/30Y + 2s10s inversion flag), key economic indicators (GDP, CPI, inflation, unemployment, Fed funds, consumer sentiment), and today's sector rotation. The Phase-1 backdrop. No arguments.`,
        get_sector_snapshot: `Today's sector rotation, every sector ranked leaders→laggards. Where money has actually been going — the tape against which your stance is a claim. No arguments.`,
        get_priced_in: `What the MARKET has already discounted: 5y and 10y breakeven inflation, the 5y5y forward, and the 10y TIPS real yield (FRED, daily). This is the benchmark your view has to beat — a regime call that merely restates what is priced is not a view. Breakevens carry an inflation risk premium, so they are not a pure forecast, and the market-implied POLICY PATH is not available to us. No arguments.`,
        get_coverage_by_sector: `OUR OWN analysts' book, aggregated by sector: how many active theses per sector, and which sectors we cover at all. The bottom-up cross-check for Phase 4 — where the book agrees with your top-down read that is your strongest basis, and where it disagrees you must say so rather than reconciling it away. No arguments.`,
    }),
]

const TOOL_HANDLERS = {
    get_macro_snapshot:  makeToolHandler('get_macro_snapshot',  () => getMacroSnapshot(),  (e) => `Could not fetch macro snapshot: ${e.message}`, LOG),
    get_sector_snapshot: makeToolHandler('get_sector_snapshot', () => getSectorSnapshot(), (e) => `Could not fetch sector snapshot: ${e.message}`, LOG),
    get_priced_in:       makeToolHandler('get_priced_in',       () => getPricedIn(),       (e) => `Could not fetch market-implied levels: ${e.message}`, LOG),
    get_coverage_by_sector: makeToolHandler('get_coverage_by_sector', () => _coverageBySector(), (e) => `Could not read the coverage book: ${e.message}`, LOG),
}

export const strategyAgentService = { chatStream }

/**
 * Our own book, per sector, LLM-ready. Reads coverage's OWNER-BLIND sweep: a house view is a
 * broadcast, so the cross-check is deliberately across the whole institution's research rather than
 * one user's — this is the desk asking "what does our analyst book think", not "what does yours".
 *
 * Says so explicitly when a sector has no coverage. Silence would read as "no view", and a stance
 * taken over an empty book should know it is unsupported.
 */
export async function _coverageBySector(deps = { listActiveBySector: coverageService.listActiveBySector }) {
    const rows = await deps.listActiveBySector(SECTORS)
    if (!rows?.length) return 'The coverage book is empty — no bottom-up cross-check is available. Say so rather than implying our analysts agree.'

    const bySector = new Map()
    for (const r of rows) {
        if (!bySector.has(r.sector)) bySector.set(r.sector, [])
        bySector.get(r.sector).push(r.symbol)
    }
    const covered = [...bySector.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([sector, syms]) => `  ${sector.padEnd(24)} ${syms.length} name${syms.length === 1 ? '' : 's'} — ${syms.join(', ')}`)
    const uncovered = SECTORS.filter(s => !bySector.has(s))

    return [
        'OUR BOOK — active coverage by sector (all analysts):',
        ...covered,
        uncovered.length ? `\nNo coverage at all in: ${uncovered.join(', ')}. A stance on these has no bottom-up support — say so.` : '',
    ].filter(Boolean).join('\n')
}

async function chatStream({
    messages, userPrompt, chatState = {},
    model: requestedModel, reasoningEffort, userId,
    onToken, onToolStart, onReasoning, onPhase, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
}) {
    const systemPrompt  = _buildSystemPrompt()
    const builtMessages = attachTurnContext(_buildMessages({ messages, userPrompt }), _buildTurnContext(chatState))

    const phase = makePhaseCapture(5, onPhase)
    // Every emit tag is suppressed by default; <tilt> is parsed from `raw` afterward, same as
    // Kairos parses <call> and Prometheus parses <coverage>.
    const tagCaptures = buildTagCaptures({ phase: phase.capture })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning,
        meta: { userPrompt },
    })

    const { reply, tilt } = _parseStrategyResponse(raw)
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasTilt: Boolean(tilt), rows: tilt?.tilts?.length ?? 0, phase: phase.get() })
    // A DRAFT — returned for preview, never saved. Publishing is a separate, explicit act.
    return { reply, phase: phase.get(), ...(tilt ? { tilt } : {}) }
}

// ─── tilt extraction (pure) ───────────────────────────────────────────────────

/**
 * Pull the `<tilt>` JSON out of raw model output → `{ reply, tilt }`. `tilt` is null when the block
 * is absent, malformed, or carries no rows — a discussion turn emits nothing, and that is normal.
 */
export function _parseStrategyResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['tilt', 'phase']).trim()
    return { reply, tilt: _cleanDraft(parseEmitBlock(text, 'tilt', LOG)) }
}

// Light guard (full normalization happens at publish): an object carrying at least one row.
function _cleanDraft(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null
    if (!Array.isArray(t.tilts) || !t.tilts.length) return null
    return t
}

function _buildSystemPrompt() {
    // Two blocks: the STATIC prompt behind the cache breakpoint (LANGUAGE_RULE rides there — it is
    // byte-identical every request, so in the dynamic tail it would be re-sent uncached forever),
    // and a small dynamic block. Anything that changes per TURN belongs in the turn context instead,
    // or it sits ahead of the conversation in the cache prefix and the history breakpoint can never
    // hit.
    const today = new Date().toISOString().slice(0, 10)
    return [
        { type: 'text', text: _systemPrompt() + LANGUAGE_RULE, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `---\nCURRENT DATE: ${today}. Resolve relative dates (this quarter, the next FOMC) against it.` },
    ]
}

/**
 * Per-turn state, attached to the LAST USER MESSAGE rather than the system prompt — a volatile block
 * in the system tail is what kept the conversation breakpoint from ever hitting.
 */
export function _buildTurnContext(chatState) {
    const current = chatState?.current_tilt
    if (!current) return null
    return `CURRENT PUBLISHED VIEW — this is the house view in force. Reaffirm what still holds (a `
        + `reaffirmed stance keeps its original clock and entry prices) and re-author only what has `
        + `actually moved.\n${JSON.stringify(current, null, 2)}`
}

// A continuing conversation is trimmed + coalesced; a first turn is just the prompt. normalizeMessages
// takes (messages, maxCount) and does NOT append userPrompt — passing it there silently yields an
// empty array and the API rejects the request with "at least one message is required".
export function _buildMessages({ messages, userPrompt }) {
    if (Array.isArray(messages) && messages.length) return normalizeMessages(messages, MAX_RECENT_MESSAGES)
    return userPrompt ? [{ role: 'user', content: String(userPrompt) }] : []
}
