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
import { makePromptLoader, stripEmitTags, makeToolHandler, attachTurnContext, LANGUAGE_RULE, BREVITY_RULE, buildStandingProposalRule, cachedBlock, buildDeskMessages } from '../agentUtils.js'
import { buildTagCaptures } from '../llmStream.util.js'
import { makeRouteCapture, ROUTE_TAGS, buildRouteRule } from '../routing.util.js'
import { getMacroSnapshot, getSectorSnapshot } from '../../providers/fmp.provider.js'
import { getPricedIn } from '../../providers/fred.provider.js'
import { coverageService } from '../../api/analyst/coverage.service.js'
import { readChannelState, formatChannelState } from '../../api/strategy/channelState.service.js'
import { readChannelExposures, formatChannelExposures } from '../../api/strategy/channelExposures.service.js'
import { previewSizing, expandChannelDraft } from '../../api/strategy/channelSizing.service.js'
import { readIndustryReads, formatIndustryReads } from '../../api/strategy/industryReads.service.js'
import { readTrackRecord, formatRecord } from '../../api/strategy/channelCalls.service.js'
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
        // Step 5 of the same design: the betas on the funds. Ahead of consult for the same reason.
        get_channel_exposures: `Which BUCKETS move with which CHANNEL, measured: every sector and industry fund's weekly return beyond the market regressed on each channel since ~2006, listing only |t| ≥ 3, with the buckets each fund stands for and how far it has already moved at today's z. The Phase-3 evidence for mapping a regime onto buckets — it turns "utilities are rate sensitive" from a story into a number, and names the INDUSTRIES a channel actually reaches, including ones our coverage does not. A beta proves an exposure is real; it is not an edge — a high one means the channel is already traded through that fund. Pass \`channel\` (an id from get_channel_state) to narrow to one.`,
        // Step 6: the table sized from the desk's channel calls. Same function the draft is expanded
        // with after parsing, so the preview and the published table cannot differ.
        size_from_channels: `PREVIEW the table your channel calls produce. Pass channel_views — your macro calls, each a channel id from get_channel_state and the move you expect in its z over the horizon (dz, ±3 at most) — and optionally reactions (a bucket you expect to respond STRONGER, WEAKER or OPPOSITE to its measured history on one channel, with the reason), exclude (buckets to leave out, EACH WITH ITS REASON — an exclusion is a call and is stored with the view), and manual_rows (your own non-channel rows, so the preview accounts for them). The code turns the calls into every fund's expected move beyond the market through the measured betas, ADDS each fund's industry evidence (get_industry_reads), holds each sector as one row or splits it into its industries where they diverge, nets to zero and caps. With no calls it sizes the evidence alone. Call it, read the table, revise the CALLS until it says what you mean — then emit the same channel_views in the <tilt> block.`,
        // Step 6b: the industry reads — evidence where no channel reaches (tech), a tilt beside the
        // channels everywhere else. Ahead of consult, which stays last.
        get_industry_reads: `What each INDUSTRY's own companies and fund say, measured: an EVIDENCE score per industry (−0.5..+0.5) from its companies' beat rate and surprise last quarter and its fund's 12-1 month momentum over SPY — measured since 2010 to rank industries' next six months (IC +0.08; +0.12 on tech) — plus CONTEXT that is never sized: P/E against its own five years and trailing growth. The evidence is already ADDED to the sized table; read it to know why a row is there, to see which industries look strongest and weakest, and — for tech, where no channel reaches — as the only measured evidence there is. Pass \`sector\` to narrow to one.`,
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
    get_channel_exposures: makeToolHandler('get_channel_exposures',
        async (input) => formatChannelExposures(await readChannelExposures(), { channel: typeof input?.channel === 'string' && input.channel.trim() ? input.channel.trim() : null }),
        (e) => `Could not read the channel exposures: ${e.message}`, LOG),
    get_industry_reads: makeToolHandler('get_industry_reads',
        async (input) => formatIndustryReads(await readIndustryReads(), { sector: typeof input?.sector === 'string' && input.sector.trim() ? input.sector.trim() : null }),
        (e) => `Could not read the industry reads: ${e.message}`, LOG),
    size_from_channels: makeToolHandler('size_from_channels', (input) => previewSizing(input ?? {}),
        (e) => `Could not size the table: ${e.message}`, LOG),
}

/** The standing view's channel calls — what a new call is compared against. */
function _standingCalls(chatState) {
    const v = chatState?.current_tilt?.channel_views
    return Array.isArray(v) ? v : []
}

/**
 * The handlers for ONE turn. Only the sizing preview needs the turn's state — to flag a call that
 * reverses the standing view's — so it is the only one rebuilt; the rest are the shared constants.
 */
function _turnHandlers(chatState) {
    const previous = _standingCalls(chatState)
    return {
        ...TOOL_HANDLERS,
        size_from_channels: makeToolHandler('size_from_channels', (input) => previewSizing(input ?? {}, { previous }),
            (e) => `Could not size the table: ${e.message}`, LOG),
    }
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
    _record = readTrackRecord,   // the graded call record (channelCalls) — injectable for tests
}) {
    const systemPrompt  = _buildSystemPrompt()
    // The desk's own call record rides into a REVIEW — a standing view with channel calls is the only
    // time it bears on the next call. Never fatal: no record reads as "none yet".
    const record = _standingCalls(chatState).length ? await _record().catch(() => null) : null
    const builtMessages = attachTurnContext(_buildMessages({ messages, userPrompt }), _buildTurnContext(chatState, record))

    const phase = makePhaseCapture(5, onPhase)
    // Every emit tag is suppressed by default; <tilt> is parsed from `raw` afterward, same as
    // Prometheus parses <coverage>.
    // …plus the shared routing tags: the user asked to be sent to another desk with a name.
    const route = makeRouteCapture('strategy')
    const tagCaptures = buildTagCaptures({ phase: phase.capture, ...route.captures })

    const raw = await _run({
        log: LOG, requestedModel, userId, messages: builtMessages, systemPrompt,
        tools: TOOLS, toolHandlers: _turnHandlers(chatState),
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning,
        meta: { userPrompt },
    })

    const parsed = _parseStrategyResponse(raw)
    const { reply } = parsed
    // Channel calls are sized HERE, before the draft reaches the preview, so what the admin sees is
    // exactly what publishing stores. A failed read keeps the desk's own rows rather than the turn.
    let tilt = parsed.tilt
    try { tilt = await expandChannelDraft(tilt, undefined, { previous: _standingCalls(chatState) }) } catch (err) { logger.warn(LOG, 'channel sizing failed — draft keeps only its own rows', err.message) }
    if (tilt && !tilt.tilts?.length) tilt = null
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
    // A block may carry only channel calls — the rows are sized from them after parsing.
    const rows  = Array.isArray(t.tilts) && t.tilts.length
    const calls = Array.isArray(t.channel_views) && t.channel_views.length
    if (!rows && !calls) return null
    return rows ? t : { ...t, tilts: [] }
}

function _buildSystemPrompt() {
    // Two blocks: the STATIC prompt behind the cache breakpoint (LANGUAGE_RULE rides there — it is
    // byte-identical every request, so in the dynamic tail it would be re-sent uncached forever),
    // and a small dynamic block. Anything that changes per TURN belongs in the turn context instead,
    // or it sits ahead of the conversation in the cache prefix and the history breakpoint can never
    // hit.
    const today = new Date().toISOString().slice(0, 10)
    return [
        cachedBlock(_systemPrompt() + buildRouteRule('strategy') + LANGUAGE_RULE + buildStandingProposalRule('tilt', 'Publish') + BREVITY_RULE),
        { type: 'text', text: `---\nCURRENT DATE: ${today}. Resolve relative dates (this quarter, the next FOMC) against it.` },
    ]
}

/**
 * Per-turn state, attached to the LAST USER MESSAGE rather than the system prompt — a volatile block
 * in the system tail is what kept the conversation breakpoint from ever hitting.
 */
export function _buildTurnContext(chatState, record = null) {
    const current = chatState?.current_tilt
    if (!current) return null
    // The monitor's bookkeeping (`monitor.*`) is not part of the view and is not shown to the desk,
    // and neither is each sized row's `drivers` — the arithmetic of the CALLS listed below, repeated
    // per row; it multiplied the context without adding a fact the calls do not already state.
    const { monitor, ...view } = current   // eslint-disable-line no-unused-vars -- destructured away on purpose
    const lean = { ...view, tilts: (view.tilts ?? []).map(({ drivers, ...row }) => row) }   // eslint-disable-line no-unused-vars
    const calls = Array.isArray(view.channel_views) ? view.channel_views : []
    const standing = calls.length
        ? '\n\nSTANDING CHANNEL CALLS — a call STANDS unless the evidence moved. Restate it, or say what '
          + 'changed in the readings since it was made; a call that reverses one of these is flagged in '
          + 'the sizing preview.\n'
          + calls.map(c => `  ${c.channel_id}: call ${c.dz}z (base ${c.base_dz ?? 'n/a'}z, sized on ${c.deviation ?? c.dz}z) `
              + `made at z ${c.z_at_set ?? '?'} on ${String(c.set_at ?? '?').slice(0, 10)} — ${c.rationale ?? 'no reason recorded'}`).join('\n')
        : ''
    // How the desk's PAST calls have done against the base rate — graded at six months, with interim
    // marks at four and thirteen weeks (channelCalls). A call is judged on exactly its departure from
    // the base rate, and this is where the desk sees that judgment.
    const recordText = record ? `\n\n${formatRecord(record)}` : ''
    return `CURRENT PUBLISHED VIEW — this is the house view in force. Reaffirm what still holds (a `
        + `reaffirmed stance keeps its original clock and entry prices) and re-author only what has `
        + `actually moved.${standing}${recordText}\n\n${JSON.stringify(lean, null, 2)}`
}

// A continuing conversation is trimmed + coalesced; a first turn is just the prompt. normalizeMessages
// takes (messages, maxCount) and does NOT append userPrompt — passing it there silently yields an
// empty array and the API rejects the request with "at least one message is required".
export function _buildMessages({ messages, userPrompt }) {
    return buildDeskMessages({ messages, userPrompt, max: MAX_RECENT_MESSAGES })
}
