import { fileURLToPath }  from 'url'
import { parseEmitBlock, parseEmitBlocks, makePhaseCapture, runAgentStream } from './agentIO.js'
import { toolsFor } from './agentTools.registry.js'
import { dirname, join }  from 'path'
import { getQuote, getQuotes, getRiskMetrics, getCorrelations, getNumericQuote, getVolsAndCorrelationsRaw } from '../providers/yahoofinance.provider.js'
import { getFundamentals, getEarningsCalendar, getEarnings, getMacroSnapshot } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { cleanConviction } from './conviction.util.js'
import { formatWorkspaceLine } from '../api/portfolio/portfolioMode.util.js'
import { logger }         from './logger.service.js'
import { COMMON_TOOL_HANDLERS, normalizeMessages, makePromptLoader, buildAccountLines, stripEmitTags, makeToolHandler, buildObjectiveSection, buildAudienceSection, LANGUAGE_RULE } from './agentUtils.js'
import { makeTradingContextHandlers } from './tradingContext.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from './marketHours.tools.js'
import { makeChartHandler } from './marketData.tools.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { buildTagCaptures } from './llmStream.util.js'
import { buildSchoolSection, normalizeAllocation, normalizeSelection } from './investorSchools.js'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const LOG   = '[portfolioAgent]'
// Hot-reload the system prompt on file change (mtime-gated) — no restart needed.
const _systemPrompt = makePromptLoader(join(__dirname, '../portfolio_system_prompt.md'), LOG)
const MAX_MESSAGES = 10

export const TOOLS = toolsFor({
    web_search: '',
    get_trading_context: `The book's trading venue + accounts: which modes are available (paper / live / manual), which live brokers are connected, and every account with its balance, capabilities, whether it is selected, and what is already open in it. The capital base and existing exposure a construction or rebalance must be sized against — read it, never assume it. No arguments.`,
    check_broker_symbol: `Check whether a name is actually TRADABLE at the user's connected live broker, and what the broker calls it. A holding the broker does not list cannot be bought, so check before adding a new name to a live book. tradable null means the broker could not be reached: UNKNOWN, never treat as unavailable.`,
    get_quote: `Get current price quote for a single ticker symbol.`,
    get_quotes: `Get current prices for several tickers at once. Prefer this over calling get_quote repeatedly when sizing a multi-position portfolio.`,
    get_risk_metrics: `Get annualized volatility and ATR (from 1y of daily prices) for a ticker. Use this to size positions by risk and to set sensible stop distances.`,
    get_correlations: `Get the pairwise correlation matrix (1y daily returns) for a set of tickers. Use this to verify a portfolio is actually diversified before recommending it.`,
    get_fundamentals: `Get company fundamentals for a single ticker: sector/industry, market cap, valuation (P/E, P/B, EV/EBITDA, FCF yield, earnings yield), quality (margins, ROE, ROIC, debt/equity), growth, AND the forward analyst view — consensus price target with upside vs price, and the buy/hold/sell rating split. Use this to qualify a candidate before including it — especially for multi-month/multi-year holds. For an ETF it returns exposure/profile plus real sector look-through weights (no company statements).`,
    get_macro_snapshot: `Hard macro read for the Phase-2 regime call: the current Treasury curve (3M/2Y/10Y/30Y with the 2s10s spread — inversion flag), key economic indicators (real GDP, CPI, inflation YoY, unemployment, Fed funds rate, consumer sentiment), and today's sector rotation (leaders/laggards). Call this alongside web_search — the snapshot is the data, web_search is the narrative. No arguments.`,
    get_sec_filings: `Primary-source due diligence: a company's latest SEC filings — 10-K (annual) and 10-Q (quarterly) statements, plus 8-K material events (item 2.02 = the earnings release) — with dates and links. Use it to verify the fundamentals story and check for material events before committing to a multi-month/multi-year hold. US filers only; most ETFs and foreign tickers aren't in EDGAR.`,
    get_short_interest: `Short interest for a US-listed single stock/ADR: short % of float, days-to-cover (short ratio), and month-over-month change. FINRA data, reported bi-monthly with a ~2-week lag — use it as crowding/sentiment context (a heavily-shorted name carries squeeze risk in either direction), not as a live read. No data for ETFs, crypto, FX or futures.`,
    get_options_context: `Options positioning for a US equity/ETF: put/call ratio (by open interest and by volume) and at-the-money implied volatility for the nearest expiry. Use elevated IV as a flag that the market expects a large move (often around a catalyst) when sizing or timing an entry. Quotes ~15-min delayed. No data for crypto, FX or futures.`,
    get_derivatives_context: `Crypto-perp positioning from Binance: funding rate (crowding), open interest (committed leverage), and global long/short account ratio (retail skew). The crypto analog to short-interest/options sentiment — use it when a holding/candidate is a crypto perp. Crypto perps only (BTC, ETH, SOL…), not equities/FX/futures.`,
    get_earnings: `For a SINGLE ticker: its next earnings date + EPS estimate, plus the last 4 quarterly EPS actuals vs estimates (with surprise %). Use it to judge one holding/candidate — is a print imminent (gap risk), and does the company have a history of beating or missing. For the forward "who reports when" across many names, use get_earnings_calendar. US equities only — no ETFs, crypto, FX or futures.`,
    get_earnings_calendar: {
        description: `Upcoming earnings dates (with EPS/revenue estimates) between two dates (YYYY-MM-DD, window up to ~3 months). Optionally filter to specific symbols. Use it for entry timing — a candidate reporting in a few days carries gap risk, so you may size in after the print rather than before it.`,
        cache: true,
    },
    get_coverage: `The Analyst's researched coverage — the living per-name theses you can build a book from (a variant-perception thesis, OUR price target vs the Street = the gap/edge, a rating, and the status). Prefer constructing from a RESEARCHED name (a thesis + a target) over a raw screen hit. Optionally filter by sector. Read-only.`,
    get_chart: `Render a candlestick chart IMAGE for ONE name and look at it directly. Your job is allocation, not entry timing, so use this for the questions a picture answers better than a number: where a candidate sits in its multi-year range, whether a holding's trend is intact or broken, how ugly a drawdown was, what a long base looks like. Prefer weekly/monthly for a multi-month or multi-year hold; a daily view is for judging whether to phase into a position now or wait. Numbers (valuation, risk metrics, correlations) still decide the WEIGHT — this only informs the read. Set show_to_user true when the picture is part of the case you're making to the user, so they see what you saw.`,
    // APPENDED, never inserted — the snapshot compares by index and prompt caching keys off the
    // array prefix.
    get_market_hours: MARKET_HOURS_TOOL_SPEC.get_market_hours,
})

const TOOL_HANDLERS = {
    get_quote: makeToolHandler('get_quote',
        ({ ticker }) => getQuote(ticker),
        (err, { ticker }) => `Could not fetch quote for ${ticker}: ${err.message}`, LOG),
    get_quotes: makeToolHandler('get_quotes',
        ({ tickers }) => getQuotes(tickers),
        (err) => `Could not fetch quotes: ${err.message}`, LOG),
    get_risk_metrics: makeToolHandler('get_risk_metrics',
        ({ ticker }) => getRiskMetrics(ticker),
        (err, { ticker }) => `Could not fetch risk metrics for ${ticker}: ${err.message}`, LOG),
    get_correlations: makeToolHandler('get_correlations',
        ({ tickers }) => getCorrelations(tickers),
        (err) => `Could not compute correlations: ${err.message}`, LOG),
    get_fundamentals: makeToolHandler('get_fundamentals',
        ({ ticker }) => getFundamentals(ticker),
        (err, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${err.message}`, LOG),
    get_macro_snapshot: makeToolHandler('get_macro_snapshot',
        () => getMacroSnapshot(),
        (err) => `Could not fetch macro snapshot: ${err.message}`, LOG),
    get_sec_filings: makeToolHandler('get_sec_filings',
        ({ ticker }) => getSecFilings(ticker),
        (err, { ticker }) => `Could not fetch SEC filings for ${ticker}: ${err.message}`, LOG),
    get_earnings: makeToolHandler('get_earnings',
        ({ ticker }) => getEarnings(ticker),
        (err, { ticker }) => `Could not fetch earnings for ${ticker}: ${err.message}`, LOG),
    get_earnings_calendar: makeToolHandler('get_earnings_calendar',
        ({ from, to, symbols }) => getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []),
        (err) => `Could not fetch earnings calendar: ${err.message}`, LOG),
    ...COMMON_TOOL_HANDLERS,
    // Unbound (market hours belong to the instrument, not the user) — so it lives in the
    // static map, unlike the venue handlers that are rebuilt per request around a userId.
    ...makeMarketHoursHandlers(),
}

// Coverage the Analyst never classified. Its own bucket, always last: a name with no sector is not a
// sleeve, and quietly filing it under one would be the guess this grouping exists to prevent.
const UNSECTORED = 'Unclassified'

// P4d: render the Analyst's active coverage as an LLM-ready read for Atlas to construct from. Pure —
// exported for tests. Shows OUR PT vs the Street (the gap = the edge) so Atlas allocates on research,
// grouped by sector so it can see which SLEEVE each name was researched for.
export function _formatCoverage(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(c => c && c.symbol)
    // This message is an INSTRUCTION, not a status line — it lands late in the context, right where
    // the model is deciding what to do next, so it outranks the prompt's sourcing rule in practice.
    // It used to end "or screen directly", which is the one thing Atlas must never do: it then read
    // fundamentals, picked names and allocated, and the screening desk and the research desk were
    // both skipped. Say only what is actually allowed, and say to stop.
    if (!list.length) return 'No Analyst coverage yet — nothing researched to build from. You have NO screener of your own: emit a <screen_request> for the sleeve and END THE TURN there. Argus screens, the Analyst researches, and you construct once coverage comes back. Do NOT pick names yourself from get_fundamentals, web_search or memory — a name you sourced is a name nobody screened or researched.'
    const line = (c) => {
        const pt   = c.price_target?.value
        const gap  = Number.isFinite(c.gap?.pct) ? ` (${c.gap.pct >= 0 ? '+' : ''}${c.gap.pct}% vs Street${Number.isFinite(c.gap?.consensus_pt) ? ` ${c.gap.consensus_pt}` : ''})` : ''
        const th   = typeof c.thesis === 'string' && c.thesis ? ` — ${c.thesis.length > 160 ? c.thesis.slice(0, 157) + '…' : c.thesis}` : ''
        return `- ${c.symbol} [${c.rating ?? 'unrated'}]${pt != null ? ` our PT ${pt}${gap}` : ''} · ${c.status ?? 'active'}${th}`
    }

    // GROUPED BY SECTOR, not a flat list. Atlas builds a book of SLEEVES, and a sleeve is a sector
    // bucket from Phase 3 — so "which names do I have for technology" is the question it actually
    // asks here. Read flat, it had to re-derive that mapping from the tickers it happened to
    // recognize, which is exactly the guessing the research pipeline exists to remove. The sector is
    // the Analyst's own (coverage.sector), so the grouping is the researcher's classification, not
    // Atlas's memory of one.
    const bySector = new Map()
    for (const c of list) {
        const sector = typeof c.sector === 'string' && c.sector.trim() ? c.sector.trim() : UNSECTORED
        if (!bySector.has(sector)) bySector.set(sector, [])
        bySector.get(sector).push(c)
    }
    // First-seen order, but the unclassified bucket always last — it is a data gap, not a sleeve.
    const sectors = [...bySector.keys()].filter(s => s !== UNSECTORED)
    if (bySector.has(UNSECTORED)) sectors.push(UNSECTORED)

    const blocks = sectors.map(sector => [
        sector === UNSECTORED ? `${UNSECTORED} (no sector recorded — check the name fits before placing it):` : `${sector}:`,
        ...bySector.get(sector).map(line),
    ].join('\n'))

    return [
        'Analyst coverage (researched theses — build from these, our target vs the Street).',
        'Grouped by the sector the Analyst researched each name UNDER — that is the sleeve it was sourced for. A sleeve from your architecture with no heading here has nothing researched behind it yet: route it, do not fill it from another sector\'s names.',
        ...blocks.flatMap(b => ['', b]),
    ].join('\n')
}

// Per-session handler — coverage is per-user, so it binds userId (like Kairos's userId-bound tools).
function makeCoverageHandler(userId) {
    return makeToolHandler('get_coverage',
        async ({ sector } = {}) => _formatCoverage(await coverageService.getCoverage(userId, { status: 'active', sector: sector ?? null })),
        (err) => `Could not fetch coverage: ${err.message}`, LOG)
}

export const portfolioAgentService = { chatStream }

async function chatStream({ messages = [], ideaAccounts = [], mainAccountId = null, portfolioId = null, portfolioIdeas = [], portfolioState = null, isReviewMode = false, reviewDelta = null, lifecycle = null, mandate = null, thesis = null, objective = null, audience = null, model: requestedModel, reasoningEffort, userId, onToken, onTicker, onPhase, onToolStart, onReasoning, onChart, signal,
    _run = runAgentStream,   // the shared contract-test seam — see runAgentStream in agentIO.js
}) {
    const normalized   = _buildMessages(messages)

    // Stable base (cached) + volatile per-request sections (accounts, edit
    // context). cache_control on the base lets Anthropic cache the
    // tools+instructions prefix across turns; only the short tail varies. The
    // OpenAI provider flattens this block array back to a plain string.
    const today = new Date().toISOString().slice(0, 10)
    const dynamicSections = [`CURRENT DATE: ${today}. Resolve relative timeframes (today, next week, this month) against this date — e.g. when calling get_earnings_calendar.`]
    if (ideaAccounts.length > 0) dynamicSections.push(_buildAccountsSection(ideaAccounts, mainAccountId))
    if (portfolioId && portfolioIdeas.length > 0) dynamicSections.push(_buildPortfolioContext(portfolioId, portfolioIdeas))
    // Ahead of the mandate deliberately: the objective is what the user actually said on the way in,
    // and the mandate below may have been DERIVED from it (see portfolioChat.service loadStreamContext).
    // Reading the source first makes a mandate that drifted from it visible rather than invisible.
    // Who we're talking to comes FIRST: it frames how everything below is said.
    const audienceSection = buildAudienceSection(audience)
    if (audienceSection) dynamicSections.push(audienceSection)
    const objectiveSection = buildObjectiveSection(objective)
    if (objectiveSection) dynamicSections.push(objectiveSection)
    if (mandate)    dynamicSections.push(_buildMandateSection(mandate))
    // Right after the mandate, because it IS a mandate field — and because it governs how everything
    // below is read: the selection school sets the bar for Phase 4, the allocation school sets the
    // weighting rule for Phase 5, and both set the question this book is reviewed against. Rendered
    // even with no mandate yet: with nothing chosen it is the menu Atlas picks from in Phase 1.
    const schoolSection = buildSchoolSection(mandate, { menu: !isReviewMode })
    if (schoolSection) dynamicSections.push(schoolSection)
    if (thesis)     dynamicSections.push(_buildThesisSection(thesis))
    if (lifecycle)  dynamicSections.push(_buildLifecycleSection(lifecycle))
    if (portfolioState) dynamicSections.push(_buildPortfolioStateSection(portfolioState, isReviewMode, reviewDelta))

    // Two cache breakpoints: the static instructions, and the dynamic context
    // tail. The tail (date + accounts + mandate + lifecycle + snapshotted
    // portfolio state) is byte-identical across the follow-up turns of a review
    // session, so caching it lets turns 2+ read it at ~0.1× instead of re-paying
    // full price every turn. A turn where it does change just re-writes it once.
    const systemPrompt = [
        { type: 'text', text: _systemPrompt() + LANGUAGE_RULE, cache_control: { type: 'ephemeral' } },
        ...(dynamicSections.length
            ? [{ type: 'text', text: dynamicSections.join('\n\n'), cache_control: { type: 'ephemeral' } }]
            : []),
    ]


    let capturedPlan    = null
    let capturedUpdate  = null
    let capturedMandate = null
    let capturedThesis  = null
    const phase = makePhaseCapture(6, onPhase)
    const onPlan    = (json) => { try { capturedPlan    = JSON.parse(json) } catch { /* malformed */ } }
    const onUpdate  = (json) => { try { capturedUpdate  = JSON.parse(json) } catch { /* malformed */ } }
    const onMandate = (json) => { try { capturedMandate = JSON.parse(json) } catch { /* malformed */ } }

    // All known emit tags suppressed by default; this agent captures phase, ticker
    // (which keeps its inner text in the UI), and the plan/update/mandate blocks.
    const tagCaptures = buildTagCaptures({
        phase:             phase.capture,
        ticker:            { onCapture: onTicker, keepText: true },
        portfolio_plan:    onPlan,
        portfolio_update:  onUpdate,
        portfolio_mandate: onMandate,
    })

    const raw = await _run({
        log: LOG, requestedModel, userId,
        messages: normalized, systemPrompt,
        tools: TOOLS,
        // Per-session: get_coverage binds this user (coverage is per-user), get_chart closes over
        // this turn's onChart so a chart the agent flags show_to_user reaches THIS chat; the rest
        // are static.
        toolHandlers: {
            ...TOOL_HANDLERS,
            ...makeTradingContextHandlers(userId),
            get_coverage: makeCoverageHandler(userId),
            get_chart:    makeChartHandler({ log: LOG, onChart, readText: 'Read it as a POSITIONING question — where in the range, trend intact or broken, base or breakdown. Weights still come from the numbers.' }),
        },
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onChart,
        meta: { accountCount: ideaAccounts.length, editMode: !!portfolioId },
    })

    // <portfolio_thesis> is suppressed from the UI stream but remains in raw — pull it here.
    const thesisMatch = raw.match(/<portfolio_thesis>([\s\S]*?)<\/portfolio_thesis>/)
    if (thesisMatch) {
        try { capturedThesis = JSON.parse(thesisMatch[1].trim()) } catch { /* malformed */ }
    }
    // P4c: Atlas hands a sleeve's mandate to Argus's INVESTING desk to source + research candidates.
    const screenRequests = _parseScreenRequests(raw)
    // G1: Atlas hands a HELD name back to Prometheus for an async re-research when its coverage is stale.
    const coverageRefresh = _parseCoverageRefresh(raw)

    const reply = stripEmitTags(
        // <ticker> keeps its inner text in the reply (unwrap, don't strip).
        raw.replace(/<ticker>([\s\S]*?)<\/ticker>/g, '$1'),
        ['phase', 'portfolio_plan', 'portfolio_update', 'portfolio_mandate', 'portfolio_thesis', 'screen_request', 'coverage_refresh'],
    ).trim()

    if (capturedPlan) capturedPlan = await _sizePlan(capturedPlan)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasPlan: !!capturedPlan, hasUpdate: !!capturedUpdate, hasMandate: !!capturedMandate, hasThesis: !!capturedThesis, screenRequests: screenRequests.length, coverageRefresh: !!coverageRefresh, phase: phase.get() })
    return { reply, plan: capturedPlan, update: capturedUpdate, mandate: capturedMandate, thesis: capturedThesis, phase: phase.get(), ...(screenRequests.length ? { screenRequests } : {}), ...(coverageRefresh ? { coverageRefresh } : {}) }
}

// ─── Coverage-refresh extraction (pure) ─────────────────────────────────────────
// G1: Atlas → Prometheus hop. In review mode Atlas may ask the research desk to re-research a HELD
// name whose coverage is stale/insufficient, rather than guessing on its thesis. Pulls the
// <coverage_refresh> block; needs a ticker (else null). The refresh runs async server-side and pings
// Atlas when the rewritten coverage is ready. Mirrors _parseScreenRequest. Exported for tests.
export function _parseCoverageRefresh(raw) {
    const o = parseEmitBlock(raw, 'coverage_refresh', LOG)
    if (!o) return null
    const ticker = String(o?.ticker ?? '').toUpperCase().trim()
    if (!ticker) return null
    const question = typeof o?.question === 'string' && o.question.trim() ? o.question.trim() : null
    return { ticker, question }
}

// ─── Screen-request extraction (pure) ───────────────────────────────────────────
// Atlas is the PM — it doesn't run the discovery funnel; it hands a sleeve's MANDATE to Argus's
// INVESTING profile (the screening desk) to source fundamentally-screened candidates, which the Analyst
// then researches. This pulls the <screen_request> mandate block. Needs a sector OR a style to constrain
// (else null). Mirrors Kairos's _parseScanRequest. Exported for tests.
export function _parseScreenRequest(raw) {
    return _parseScreenRequests(raw)[0] ?? null
}

/**
 * EVERY sleeve Atlas routed this turn, in order. A book has three or four, and screening them one
 * per round trip put the user through the whole Atlas → Argus → Prometheus → Atlas walk once per
 * sector. They go out together now and come back once.
 *
 * Pure; exported for tests.
 */
export function _parseScreenRequests(raw) {
    return parseEmitBlocks(raw, 'screen_request', LOG).map(_cleanScreenRequest).filter(Boolean)
}

function _cleanScreenRequest(obj) {
    const s = k => (typeof obj?.[k] === 'string' && obj[k].trim() ? obj[k].trim() : null)
    const sector = s('sector'), style = s('style')
    if (!sector && !style) return null   // a screen needs at least a sector or a style to constrain
    // `lens` is the mandate's SELECTION school riding the hop — the only half of the school Argus has
    // any use for (a screener has nothing to do with how risk is spread). Validated against the same
    // vocabulary both ends read, so a hallucinated school reaches the screen as "no lens" (the neutral
    // ranking) rather than as a word nothing downstream understands.
    // `industry` is the finer pond INSIDE the sector, and it crosses only when Atlas actually holds a
    // view ("semis, not software"). Absent, Argus narrows the sector itself — that is screening
    // mechanics and its job. Present, it is a judgment and therefore has to travel as a field: buried
    // in free-text constraints it is a hint Argus may or may not treat as binding.
    return { sector, industry: s('industry'), style, cap_band: s('cap_band'), lens: normalizeSelection(s('lens')), constraints: s('constraints'), note: s('note') }
}

/**
 * Deterministically finalize a captured plan's allocations and quantities so
 * the LLM never has to do the arithmetic:
 *  - allocationRatio across ideas is normalized to sum to exactly 1.0
 *  - if the plan carries a positionSize (total capital), every quantity is
 *    recomputed as floor(positionSize × ratio / livePrice) using live quotes;
 *    a price that can't be fetched leaves that idea's quantity null
 *  - with no positionSize, any explicit per-asset quantity the user gave is
 *    preserved as-is
 */
async function _sizePlan(plan) {
    const ideas = Array.isArray(plan?.ideas) ? plan.ideas : []
    if (!ideas.length) return plan

    // Normalize allocation ratios → sum to 1.0 (equal-weight fallback).
    const ratios = ideas.map(i => (Number.isFinite(i.allocationRatio) && i.allocationRatio > 0 ? i.allocationRatio : 0))
    const total  = ratios.reduce((a, b) => a + b, 0)
    const norm   = total > 0 ? ratios.map(r => r / total) : ideas.map(() => 1 / ideas.length)
    ideas.forEach((idea, i) => {
        idea.allocationRatio = Number(norm[i].toFixed(4))
        idea.conviction = cleanConviction(idea.conviction)
    })

    const positionSize = Number(plan.positionSize)
    if (!Number.isFinite(positionSize) || positionSize <= 0) {
        logger.info(LOG, 'sizePlan: no positionSize, quantities left as provided')
        return plan
    }

    // Fetch live prices in parallel with vols+correlation (single candle fetch per ticker).
    const assets = ideas.map(i => i.asset)
    const [prices, volAndCorr] = await Promise.all([
        Promise.all(ideas.map(async (idea) => {
            try { return (await getNumericQuote(idea.asset)).price }
            catch (err) { logger.warn(LOG, `sizePlan: price fetch failed for ${idea.asset}`, err.message); return null }
        })),
        getVolsAndCorrelationsRaw(assets).catch(() => null),
    ])
    const vols     = volAndCorr?.vols     ?? assets.map(() => null)
    const corrData = volAndCorr?.corrData ?? null

    ideas.forEach((idea, i) => {
        const price = prices[i]
        if (price > 0) {
            const raw = Math.floor((positionSize * idea.allocationRatio) / price)
            idea.quantity = raw > 0 ? raw : 1
        } else {
            idea.quantity = null
        }
    })

    // Portfolio volatility: √(wᵀ Σ w) where Σ[i][j] = ρ[i][j] × σ[i] × σ[j]
    if (vols.every(v => v != null) && corrData) {
        const symIdx = Object.fromEntries(corrData.symbols.map((s, k) => [s, k]))
        let portfolioVar = 0
        for (let i = 0; i < ideas.length; i++) {
            for (let j = 0; j < ideas.length; j++) {
                const ri  = symIdx[assets[i].toUpperCase()] ?? -1
                const rj  = symIdx[assets[j].toUpperCase()] ?? -1
                const rho = (ri >= 0 && rj >= 0) ? corrData.matrix[ri][rj] : (i === j ? 1 : 0)
                portfolioVar += norm[i] * norm[j] * vols[i] * vols[j] * rho
            }
        }
        plan.portfolioVol = Number(Math.sqrt(portfolioVar).toFixed(4))  // annualized, e.g. 0.18 = 18%
    }

    logger.info(LOG, 'sizePlan: quantities computed', { positionSize, ideas: ideas.length, portfolioVol: plan.portfolioVol ?? null })
    return plan
}

function _buildMessages(messages) {
    return normalizeMessages(messages, MAX_MESSAGES)
}

function _buildPortfolioContext(portfolioId, ideas) {
    const name    = ideas[0]?.portfolioName || 'Portfolio'
    const header  = `EDIT MODE — CURRENT PORTFOLIO: "${name}" (portfolioId: ${portfolioId})\nThe user wants to modify this portfolio. Here are the current ideas:\n`
    const ideaLines = ideas.map(idea => {
        const alloc  = idea.allocationRatio != null ? `${Math.round(idea.allocationRatio * 100)}%` : '—'
        const qty    = idea.quantity != null ? String(idea.quantity) : 'not set'
        const entry  = Array.isArray(idea.entry_conditions) && idea.entry_conditions.length
            ? idea.entry_conditions.map(c => `"${c.condition}"`).join(', ')
            : 'no entry conditions yet'
        const stop   = Array.isArray(idea.stop_conditions) && idea.stop_conditions.length
            ? idea.stop_conditions.map(c => `"${c.condition}"`).join(', ')
            : 'no stop yet'
        const accs   = Array.isArray(idea.accounts) && idea.accounts.length ? idea.accounts.join(', ') : 'none'
        return `  ideaId: ${idea.id}\n  asset: ${idea.asset} | direction: ${idea.direction ?? '?'} | type: ${idea.type ?? '?'} | allocation: ${alloc} | qty: ${qty}\n  entry: ${entry}\n  stop: ${stop}\n  accounts: ${accs}\n  notes: ${idea.notes || '—'}`
    }).join('\n\n')
    return `${header}\n${ideaLines}`
}

export function _buildAccountsSection(accounts, mainAccountId = null) {
    const lines = buildAccountLines(accounts, mainAccountId)
    const mainNote = accounts.length > 1
        ? ' The account tagged ← MAIN is the reference account — use it as the base for scaling the other accounts. (If none is tagged, use the largest balance or context to pick the reference.)'
        : ''
    return `PORTFOLIO ACCOUNTS (the user plans to execute ideas from this portfolio on):\n${lines.join('\n')}\n\nSize against "available to deploy", NOT balance: balance counts capital already sitting in open positions, so building a book on it allocates the same money twice and hands the user a plan they cannot fill. Where an account reports no available figure, balance is the only number there is — use it, and say that the sizing assumes the account is uninvested.${mainNote}`
}

// A mandate CARRIED OVER from a goal the user gave Axl — possibly in an earlier session — is not the
// same thing as one they established with Atlas, and must not be rendered as though it were. Stated
// as fact, Atlas builds a book on a target nobody confirmed this session (see the ASK rule in Phase 1).
function _buildCarriedMandateSection(mandate, setAt) {
    const when = Number.isFinite(setAt) ? new Date(setAt).toISOString().slice(0, 10) : null
    const lines = [`CARRIED-OVER GOAL — the user told Axl this${when ? ` on ${when}` : ' previously'}, NOT to you, and possibly in an earlier session:`]
    return { lines, close: `This is a PROPOSAL, not an established mandate. Open by putting it back to them in one line — "${when ? `on ${when} you set` : 'you set'} this goal; still the plan?" — and let them change it. Once they confirm, treat it as established and stop asking. Do NOT build, screen, or name anything until they have.` }
}

export function _buildMandateSection(mandate) {
    const carried = mandate._fromObjective
    if (carried) {
        const { lines, close } = _buildCarriedMandateSection(mandate, carried.setAt)
        if (mandate.objective)     lines.push(`Objective: ${mandate.objective}`)
        if (mandate.horizon)       lines.push(`Time horizon: ${mandate.horizon}`)
        if (mandate.riskTolerance) lines.push(`Risk tolerance: ${mandate.riskTolerance}`)
        lines.push(close)
        return lines.join('\n')
    }
    const lines = ['INVESTMENT MANDATE (already established — do not re-ask for any field listed here):']
    if (mandate.objective)     lines.push(`Objective: ${mandate.objective}`)
    if (mandate.horizon)       lines.push(`Time horizon: ${mandate.horizon}`)
    if (mandate.riskTolerance) lines.push(`Risk tolerance: ${mandate.riskTolerance}`)
    if (mandate.constraints)   lines.push(`Constraints: ${mandate.constraints}`)
    if (mandate.benchmark)     lines.push(`Benchmark: ${mandate.benchmark}`)
    // The two school axes are mandate fields like any other — named here so they are covered by the
    // do-not-re-ask rule (a school that re-derives itself every turn from a slightly different
    // sentence is the failure mode). What they MEAN is the INVESTMENT SCHOOL block below.
    const selection  = normalizeSelection(mandate.selection)
    const allocation = normalizeAllocation(mandate.allocation)
    if (selection)  lines.push(`Selection school: ${selection}`)
    if (allocation) lines.push(`Allocation school: ${allocation}`)
    lines.push('Do not re-ask for mandate details — use these directly.')
    return lines.join('\n')
}

function _buildThesisSection(thesis) {
    const lines = ['PORTFOLIO THESIS (the persisted intent — validate drift against THIS; do not silently rewrite it to match the book):']
    if (thesis.strategy) lines.push(`Strategy: ${thesis.strategy}`)
    if (Array.isArray(thesis.targetExposures) && thesis.targetExposures.length) {
        lines.push('Target exposures:')
        for (const e of thesis.targetExposures) {
            const t = e?.target != null ? ` — target ${Math.round(e.target * 100)}%` : ''
            lines.push(`  ${e?.label ?? '?'}${t}`)
        }
    }
    if (thesis.version != null) lines.push(`(thesis v${thesis.version}${thesis.updatedReason ? `, last changed by ${thesis.updatedReason}` : ''})`)
    lines.push('Only propose a thesis change (via <portfolio_thesis>) if the STRATEGY itself is stale — not to chase drift.')
    return lines.join('\n')
}

function _buildLifecycleSection(lifecycle) {
    const fmtDate = ts => ts ? new Date(ts).toISOString().slice(0, 10) : null
    const now = Date.now()

    const lastReview = lifecycle.lastReviewAt ? fmtDate(lifecycle.lastReviewAt) : 'never'
    const nextDue    = lifecycle.nextReviewAt  ? fmtDate(lifecycle.nextReviewAt)  : null
    const overdue    = lifecycle.nextReviewAt && lifecycle.nextReviewAt <= now

    const lines = [
        `PORTFOLIO LIFECYCLE:`,
        `Review cadence: ${lifecycle.reviewCadence ?? 'monthly'}`,
        `Last review: ${lastReview}`,
        nextDue ? `Next review due: ${nextDue}${overdue ? ' (OVERDUE)' : ''}` : null,
    ].filter(Boolean)

    const history = Array.isArray(lifecycle.reviewHistory) ? lifecycle.reviewHistory.slice(-3) : []
    if (history.length > 0) {
        lines.push('Recent review history (oldest to newest):')
        for (const entry of history) {
            const date    = fmtDate(entry.completedAt ?? entry.date ?? null) ?? '?'
            const summary = typeof entry.summary === 'string' ? entry.summary
                          : typeof entry.notes   === 'string' ? entry.notes
                          : null
            lines.push(`  ${date}${summary ? `: ${summary}` : ''}`)
        }
    }

    return lines.join('\n')
}

/**
 * Render the review-window delta (benchmark-relative performance + regime then→now) as a
 * compact block for the Scoreboard. Returns null when nothing is resolvable (first review).
 */
export function _formatReviewDelta(d) {
    if (!d) return null
    const lines = []

    if (d.benchmark) {
        const b   = d.benchmark
        const sgn = n => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`
        const win = d.windowDays != null ? `, ${d.windowDays}d` : ''
        const book = b.bookDeltaPnlPct == null ? 'book n/a' : `book ${sgn(b.bookDeltaPnlPct)}% (Δ unrealized P&L)`
        const rel  = b.relativePct == null ? ''
            : ` → book ${b.relativePct >= 0 ? 'AHEAD' : 'BEHIND'} by ${Math.abs(b.relativePct).toFixed(1)}pt`
        lines.push(`Performance vs ${b.ticker} (since last review${win}): ${b.ticker} ${sgn(b.returnPct)}% | ${book}${rel}`)
    }

    if (d.regime) {
        const r = d.regime
        const pair = (label, then, now, unit = '') => (then != null && now != null) ? `${label} ${then}${unit}→${now}${unit}` : null
        const parts = [
            pair('2s10s', r.spread2s10s.then, r.spread2s10s.now),
            pair('Fed funds', r.fedFunds.then, r.fedFunds.now, '%'),
            pair('inflation', r.inflation.then, r.inflation.now, '%'),
        ].filter(Boolean)
        let line = `Regime shift since last review: ${parts.length ? parts.join(', ') : 'n/a'}`
        if (r.inversionFlip) line += ' ⚠ yield-curve inversion FLIPPED'
        if (r.rotatedIn.length || r.rotatedOut.length) {
            line += ` | sector leaders ${r.rotatedIn.length ? `+[${r.rotatedIn.join(', ')}]` : ''}${r.rotatedOut.length ? ` −[${r.rotatedOut.join(', ')}]` : ''}`.trimEnd()
        }
        lines.push(line)
    }

    return lines.length ? lines.join('\n') : null
}

export function _buildPortfolioStateSection(state, isReviewMode = false, reviewDelta = null) {
    const fmtMoney = (n) => {
        if (n == null) return '—'
        const abs = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
        return `${n >= 0 ? '+' : '-'}$${abs}`
    }
    const fmtPct = (n, decimals = 1) => {
        if (n == null) return '—'
        return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`
    }
    const fmtDrift = (drift) => {
        if (drift == null) return ''
        const pts = (drift * 100).toFixed(1)
        if (Math.abs(drift) < 0.01) return 'on target'
        return drift > 0 ? `OVERWEIGHT +${pts}pt` : `underweight ${pts}pt`
    }

    const date = new Date(state.computedAt).toISOString().slice(0, 10)
    // Title decides behaviour: "PORTFOLIO REVIEW STATE" triggers the review sub-phases (prompt);
    // "CURRENT PORTFOLIO" is live context during a normal update/edit — same data, no review.
    const title = isReviewMode
        ? `PORTFOLIO REVIEW STATE — computed ${date}`
        : `CURRENT PORTFOLIO — POSITIONS & P&L — as of ${date}`
    const header = [
        title,
        formatWorkspaceLine(state.workspace),
        `Total notional: $${Math.round(state.totalNotional).toLocaleString('en-US')} | Total P&L: ${fmtMoney(state.totalPnl)} (${fmtPct(state.totalPnlPct)})`,
    ].filter(Boolean).join('\n')

    const live    = state.ideas.filter(s => s.actualWeight != null)
    const pending = state.ideas.filter(s => s.actualWeight == null)

    const fmtConviction = (s) => {
        const cur = s.conviction?.level
        if (!cur) return ''
        const prev = s.convictionPrev?.level
        const trend = prev && prev !== cur ? ` (was ${prev})` : ''
        return `  conviction ${cur}${trend}`
    }

    // The FROZEN per-holding thesis (notes) + conviction rationale — rendered ONLY in review mode,
    // where the whole task is judging each holding intact / weakening / broken against the thesis it
    // was bought on. Omitted in construction/edit context to keep that (prompt-cached) tail lean.
    const thesisLine = (s) => {
        if (!isReviewMode) return ''
        const note = typeof s.notes === 'string' ? s.notes.trim() : ''
        const rat  = typeof s.conviction?.rationale === 'string' ? s.conviction.rationale.trim() : ''
        const parts = []
        if (note) parts.push(`thesis: ${note}`)
        if (rat && rat !== note) parts.push(`rationale: ${rat}`)
        return parts.length ? `\n           ↳ ${parts.join(' · ')}` : ''
    }

    const liveLines = live.map(s => {
        const target  = s.allocationRatio != null ? `target ${Math.round(s.allocationRatio * 100)}%` : 'target —'
        const actual  = `actual ${Math.round(s.actualWeight * 100)}%`
        const drift   = fmtDrift(s.drift)
        const pnl     = `P&L ${fmtMoney(s.pnl)} (${fmtPct(s.pnlPct)})`
        const age     = s.thesisAgeDays != null ? `${s.thesisAgeDays}d` : ''
        const earn    = s.upcomingEarnings ? `  ⚠ earnings ${s.upcomingEarnings.date}` : ''
        return `  ${s.asset.padEnd(6)} ${(s.direction ?? '').padEnd(6)} ${target}  ${actual}  ${drift}  ${pnl}  ${age}${fmtConviction(s)}${earn}${thesisLine(s)}`
    })

    const pendingLines = pending.map(s => {
        const target = s.allocationRatio != null ? `target ${Math.round(s.allocationRatio * 100)}%` : 'target —'
        const earn   = s.upcomingEarnings ? `  ⚠ earnings ${s.upcomingEarnings.date}` : ''
        return `  ${s.asset.padEnd(6)} ${s.direction?.padEnd(6) ?? '      '} ${target}  [${s.status}]${earn}${thesisLine(s)}`
    })

    const sections = [header]
    const deltaBlock = isReviewMode ? _formatReviewDelta(reviewDelta) : null
    if (deltaBlock) sections.push(deltaBlock)
    if (liveLines.length)    sections.push(`Live positions:\n${liveLines.join('\n')}`)
    if (pendingLines.length) sections.push(`Pending (awaiting entry):\n${pendingLines.join('\n')}`)

    const sectorRows = Array.isArray(state.sectors) ? state.sectors : []
    if (sectorRows.length > 0) {
        const sectorLines = sectorRows.map(s => {
            const target = s.targetWeight != null ? `target ${Math.round(s.targetWeight * 100)}%` : 'target —'
            const actual = s.actualWeight != null ? `actual ${Math.round(s.actualWeight * 100)}%` : 'actual —'
            const drift  = fmtDrift(s.drift)
            return `  ${String(s.sector).padEnd(20)} ${target}  ${actual}  ${drift}`
        })
        sections.push(`Sector weights:\n${sectorLines.join('\n')}`)
    }

    sections.push(isReviewMode
        ? 'Use this data as the starting point for the review. Do not call get_quotes for tickers already shown above — prices are current. Judge each holding intact / weakening / broken against the thesis + rationale shown beneath it. Propose specific actions (rebalance, trim, add, exit, swap) where the data warrants it.'
        : 'This is the live book you are helping with — the workspace, open positions, and per-position + total P&L are current. Do not call get_quotes for tickers already shown above. Ground any answer or proposed edit in these actual positions and P&L; do NOT run a full scheduled review unless the user asks for one.')

    return sections.join('\n\n')
}
