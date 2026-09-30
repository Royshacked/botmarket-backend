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

import { makePhaseCapture, runAgentStream, parseEmitBlock } from '../agentIO.js'
import { toolsFor } from '../agentTools.registry.js'
import { consultDescription } from '../deepThink.service.js'
import { makePromptLoader, stripEmitTags, makeToolHandler, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, cachedBlock, buildDeskMessages } from '../agentUtils.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { makeRouteCapture, ROUTE_TAGS, buildRouteRule } from '../routing.util.js'
import { getMacroSnapshot, getSectorSnapshot } from '../../providers/fmp.provider.js'
import { getPricedIn } from '../../providers/fred.provider.js'
import { coverageService } from '../../api/analyst/coverage.service.js'
import { readChannelState, formatChannelState } from '../../api/strategy/channelState.service.js'
import { SECTORS } from '../entity/vocabulary.js'
import { logger } from '../logger.service.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const LOG         = '[strategyAgent]'
const PROMPT_PATH = join(__dirname, '../../prompts/strategy_system_prompt.md')
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
        // Last of the desk's own tools, ahead of the sidecar only — `consult` stays LAST on every
        // desk (agentToolsRegistry.test.js). The channel read, revived 2026-09-30 as step 4 of
        // docs/design/pythia-industries-and-channels.md: Python writes it, this only formats it.
        get_channel_state: `The macro CHANNELS, measured: every driver (energy cost, real yields, the curve, breakevens, credit spreads, the dollar, liquidity, labor, freight, demand…) as a z-score against its own trailing two years, with its reading one and three months ago and where today sits in its history since 2005, plus the week's regime from VIX and credit spreads. The Phase-1 read of what is actually moving, and the vocabulary for kill-criteria — a falsifier written as "discount_rate z below +1" is checkable where prose is not. READINGS, not sector evidence: which buckets move with a channel is not measured yet. Each line carries its own as-of date; monthly series lag by weeks. No arguments.`,
        // Appended, never inserted — prompt caching keys off the array prefix. The reasoning sidecar
        // (services/deepThink.service.js): one bounded decision put to a stronger model and handed
        // back as a tool result. The mechanism half of this description is shared with every other
        // desk; the clause below is Pythia's own judgment about WHEN.
        //
        // A tilt is a BROADCAST every other desk reads, so the blast radius of getting the regime
        // wrong is larger here than at a desk authoring one entity — which is what makes the once-
        // per-tilt consult below cheap in relative terms, not what makes it unlimited.
        consult: consultDescription(`A tilt is a broadcast the whole house reads, so it is worth thinking hard about ONCE. Reach for it in exactly two situations: **the regime call itself**, when the macro data, the tape and what is already priced do not point the same way and you have to name one regime anyway; and **a sector stance that contradicts our own coverage book** — your top-down read and the analysts' bottom-up theses disagree, and you must decide which one the stance follows and say why. Not per sector: the stances follow from the regime, and re-consulting each one is the same call answered eight times.`),
    }),
]


const TOOL_HANDLERS = {
    get_macro_snapshot:  makeToolHandler('get_macro_snapshot',  () => getMacroSnapshot(),  (e) => `Could not fetch macro snapshot: ${e.message}`, LOG),
    get_sector_snapshot: makeToolHandler('get_sector_snapshot', () => getSectorSnapshot(), (e) => `Could not fetch sector snapshot: ${e.message}`, LOG),
    get_priced_in:       makeToolHandler('get_priced_in',       () => getPricedIn(),       (e) => `Could not fetch market-implied levels: ${e.message}`, LOG),
    get_coverage_by_sector: makeToolHandler('get_coverage_by_sector', () => _coverageBySector(), (e) => `Could not read the coverage book: ${e.message}`, LOG),
    get_channel_state:   makeToolHandler('get_channel_state',   async () => formatChannelState(await readChannelState()), (e) => `Could not read the channel state: ${e.message}`, LOG),
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
        bySector.get(r.sector).push(r)
    }

    // A stance can be held on an INDUSTRY now, and `bottom_up` on one has to mean our covered names
    // in THAT industry rather than in its sector. Only industries carrying enough of the book to
    // argue from are broken out: one name is an anecdote, and printing every singleton would bury
    // the sector line it sits under. The rest stay counted in their sector, where they belong.
    const MIN_FOR_A_CLAIM = 3

    /**
     * What the book CONCLUDES about a bucket, not merely where it looks.
     *
     * Asked why it kept a call at sector grain, the desk answered: "the book provides coverage, not
     * directional analyst conclusions, so it does not establish bottom-up support." It was reading a
     * list of tickers. `bottom_up` is a claim about what our analysts think, so the mix has to be on
     * the line or the basis cannot honestly be chosen.
     *
     * The LEAN is stated rather than left to be counted: a reader skimming eleven sectors and ten
     * industries should not have to do arithmetic to see which way a bucket points.
     */
    const RATING_ORDER = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell']
    const BULLISH = new Set(['strong_buy', 'buy'])
    const BEARISH = new Set(['sell', 'strong_sell'])

    const verdict = (rs) => {
        const counted = rs.filter(r => r.rating)
        if (!counted.length) return 'no ratings yet'
        const tally = RATING_ORDER
            .map(k => [k, counted.filter(r => r.rating === k).length])
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${n} ${k.replace('_', ' ')}`)
            .join(', ')
        const bull = counted.filter(r => BULLISH.has(r.rating)).length
        const bear = counted.filter(r => BEARISH.has(r.rating)).length
        // A MAJORITY of the covered names, not merely more than the other side. "1 buy, 2 hold"
        // has no bears and would otherwise read BULLISH on a single opinion — a lean this desk
        // would then cite as bottom-up support for an overweight. Holds are not agreement.
        const need = Math.ceil(counted.length / 2)
        const lean = (bull >= need && bull > bear) ? 'BULLISH'
            : (bear >= need && bear > bull) ? 'BEARISH'
            : 'SPLIT'
        return `${tally} — ${lean}`
    }

    const line = (bucket, rs, indent = 2) =>
        `${' '.repeat(indent)}${bucket.padEnd(34 - indent)} ${String(rs.length).padStart(2)} name${rs.length === 1 ? ' ' : 's'}`
        + `  ${verdict(rs).padEnd(34)} ${rs.map(r => r.symbol).join(', ')}`

    const covered = []
    for (const [sector, rs] of [...bySector.entries()].sort((a, b) => b[1].length - a[1].length)) {
        covered.push(line(sector, rs))
        const byIndustry = new Map()
        for (const r of rs) {
            if (!r.industry) continue
            if (!byIndustry.has(r.industry)) byIndustry.set(r.industry, [])
            byIndustry.get(r.industry).push(r)
        }
        for (const [industry, irs] of [...byIndustry.entries()].sort((a, b) => b[1].length - a[1].length)) {
            if (irs.length >= MIN_FOR_A_CLAIM) covered.push(line(industry, irs, 6))
        }
    }
    const uncovered = SECTORS.filter(s => !bySector.has(s))

    return [
        'OUR BOOK — active coverage, by sector and by the industries deep enough to argue from:',
        ...covered,
        uncovered.length ? `\nNo coverage at all in: ${uncovered.join(', ')}. A stance on these has no bottom-up support — say so.` : '',
        `\nAn industry listed above carries at least ${MIN_FOR_A_CLAIM} covered names, which is what makes`
        + ' `bottom_up` available at that grain. One that is not listed is not a gap in the market — it is'
        + ' a gap in OUR book, and a stance taken there rests on something else.'
        + '\nThe lean is what our analysts CONCLUDED, not where they looked: a bucket reading BULLISH on six'
        + ' names is bottom-up support for an overweight on that bucket, and a SPLIT one is not, however'
        + ' many names it holds.',
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
    // Prometheus parses <coverage>.
    // …plus the shared routing tags: the user asked to be sent to another desk with a name.
    const route = makeRouteCapture('strategy')
    const tagCaptures = buildTagCaptures({ phase: phase.capture, ...route.captures })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: TOOL_HANDLERS,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning,
        meta: { userPrompt },
    })

    const { reply, tilt } = _parseStrategyResponse(raw)
    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasTilt: Boolean(tilt), rows: tilt?.tilts?.length ?? 0, phase: phase.get() })
    // A DRAFT — returned for preview, never saved. Publishing is a separate, explicit act.
    return { reply, phase: phase.get(), ...(tilt ? { tilt } : {}), ...route.result() }
}

// ─── tilt extraction (pure) ───────────────────────────────────────────────────

/**
 * Pull the `<tilt>` JSON out of raw model output → `{ reply, tilt }`. `tilt` is null when the block
 * is absent, malformed, or carries no rows — a discussion turn emits nothing, and that is normal.
 */
export function _parseStrategyResponse(raw) {
    const text  = raw ?? ''
    const reply = stripEmitTags(text, ['tilt', 'phase', ...ROUTE_TAGS]).trim()
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
        cachedBlock(_systemPrompt() + buildRouteRule('strategy') + LANGUAGE_RULE + BREVITY_RULE),
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
    // The monitor's bookkeeping (`monitor.*`) is not part of the view and is not shown to the desk.
    const { monitor, ...view } = current   // eslint-disable-line no-unused-vars -- destructured away on purpose
    return `CURRENT PUBLISHED VIEW — this is the house view in force. Reaffirm what still holds (a `
        + `reaffirmed stance keeps its original clock and entry prices) and re-author only what has `
        + `actually moved.\n${JSON.stringify(view, null, 2)}`
}

// A continuing conversation is trimmed + coalesced; a first turn is just the prompt. normalizeMessages
// takes (messages, maxCount) and does NOT append userPrompt — passing it there silently yields an
// empty array and the API rejects the request with "at least one message is required".
export function _buildMessages({ messages, userPrompt }) {
    return buildDeskMessages({ messages, userPrompt, max: MAX_RECENT_MESSAGES })
}
