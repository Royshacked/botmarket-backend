import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { getQuote, getQuotes, getRiskMetrics, getCorrelations, getNumericQuote, getVolsAndCorrelationsRaw } from '../providers/yahoofinance.provider.js'
import { getFundamentals, getEarningsCalendar, getEarnings, getMacroSnapshot } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { cleanConviction } from './conviction.util.js'
import { formatWorkspaceLine } from '../api/portfolio/portfolioMode.util.js'
import { logger }         from './logger.service.js'
import { COMMON_TOOL_HANDLERS, normalizeMessages, makePromptLoader, buildAccountLines, stripEmitTags, makeToolHandler, resolveAgentStream } from './agentUtils.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { buildTagCaptures } from './llmStream.util.js'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const LOG   = '[portfolioAgent]'
// Hot-reload the system prompt on file change (mtime-gated) — no restart needed.
const _systemPrompt = makePromptLoader(join(__dirname, '../portfolio_system_prompt.md'), LOG)
const MAX_MESSAGES = 10

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'get_quote',
        description: 'Get current price quote for a single ticker symbol.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_quotes',
        description: 'Get current prices for several tickers at once. Prefer this over calling get_quote repeatedly when sizing a multi-position portfolio.',
        input_schema: {
            type: 'object',
            properties: { tickers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["AAPL","NVDA","GLD"]' } },
            required: ['tickers'],
        },
    },
    {
        name: 'get_risk_metrics',
        description: 'Get annualized volatility and ATR (from 1y of daily prices) for a ticker. Use this to size positions by risk and to set sensible stop distances.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_correlations',
        description: 'Get the pairwise correlation matrix (1y daily returns) for a set of tickers. Use this to verify a portfolio is actually diversified before recommending it.',
        input_schema: {
            type: 'object',
            properties: { tickers: { type: 'array', items: { type: 'string' }, description: 'two or more tickers, e.g. ["NVDA","AAPL","GLD"]' } },
            required: ['tickers'],
        },
    },
    {
        name: 'get_fundamentals',
        description: 'Get company fundamentals for a single ticker: sector/industry, market cap, valuation (P/E, P/B, EV/EBITDA, FCF yield, earnings yield), quality (margins, ROE, ROIC, debt/equity), growth, AND the forward analyst view — consensus price target with upside vs price, and the buy/hold/sell rating split. Use this to qualify a candidate before including it — especially for multi-month/multi-year holds. For an ETF it returns exposure/profile plus real sector look-through weights (no company statements).',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_macro_snapshot',
        description: 'Hard macro read for the Phase-2 regime call: the current Treasury curve (3M/2Y/10Y/30Y with the 2s10s spread — inversion flag), key economic indicators (real GDP, CPI, inflation YoY, unemployment, Fed funds rate, consumer sentiment), and today\'s sector rotation (leaders/laggards). Call this alongside web_search — the snapshot is the data, web_search is the narrative. No arguments.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_sec_filings',
        description: "Primary-source due diligence: a company's latest SEC filings — 10-K (annual) and 10-Q (quarterly) statements, plus 8-K material events (item 2.02 = the earnings release) — with dates and links. Use it to verify the fundamentals story and check for material events before committing to a multi-month/multi-year hold. US filers only; most ETFs and foreign tickers aren't in EDGAR.",
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, FDX' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_short_interest',
        description: 'Short interest for a US-listed single stock/ADR: short % of float, days-to-cover (short ratio), and month-over-month change. FINRA data, reported bi-monthly with a ~2-week lag — use it as crowding/sentiment context (a heavily-shorted name carries squeeze risk in either direction), not as a live read. No data for ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. TSLA, GME, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_options_context',
        description: 'Options positioning for a US equity/ETF: put/call ratio (by open interest and by volume) and at-the-money implied volatility for the nearest expiry. Use elevated IV as a flag that the market expects a large move (often around a catalyst) when sizing or timing an entry. Quotes ~15-min delayed. No data for crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. NVDA, SPY, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_derivatives_context',
        description: 'Crypto-perp positioning from Binance: funding rate (crowding), open interest (committed leverage), and global long/short account ratio (retail skew). The crypto analog to short-interest/options sentiment — use it when a holding/candidate is a crypto perp. Crypto perps only (BTC, ETH, SOL…), not equities/FX/futures.',
        input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: 'e.g. BTC, ETH, SOL (or BTC-USD / BTCUSDT)' } },
            required: ['symbol'],
        },
    },
    {
        name: 'get_earnings',
        description: 'For a SINGLE ticker: its next earnings date + EPS estimate, plus the last 4 quarterly EPS actuals vs estimates (with surprise %). Use it to judge one holding/candidate — is a print imminent (gap risk), and does the company have a history of beating or missing. For the forward "who reports when" across many names, use get_earnings_calendar. US equities only — no ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_earnings_calendar',
        description: 'Upcoming earnings dates (with EPS/revenue estimates) between two dates (YYYY-MM-DD, window up to ~3 months). Optionally filter to specific symbols. Use it for entry timing — a candidate reporting in a few days carries gap risk, so you may size in after the print rather than before it.',
        input_schema: {
            type: 'object',
            properties: {
                from:    { type: 'string', description: 'start date YYYY-MM-DD' },
                to:      { type: 'string', description: 'end date YYYY-MM-DD' },
                symbols: { type: 'array', items: { type: 'string' }, description: 'optional — narrow to these tickers' },
            },
            required: ['from', 'to'],
        },
        cache_control: { type: 'ephemeral' },
    },
    {
        name: 'get_coverage',
        description: "The Analyst's researched coverage — the living per-name theses you can build a book from (a variant-perception thesis, OUR price target vs the Street = the gap/edge, a rating, and the status). Prefer constructing from a RESEARCHED name (a thesis + a target) over a raw screen hit. Optionally filter by sector. Read-only.",
        input_schema: { type: 'object', properties: { sector: { type: 'string', description: 'optional — narrow to one sector, e.g. Technology' } } },
    },
]

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
}

// P4d: render the Analyst's active coverage as an LLM-ready read for Atlas to construct from. Pure —
// exported for tests. Shows OUR PT vs the Street (the gap = the edge) so Atlas allocates on research.
export function _formatCoverage(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(c => c && c.symbol)
    if (!list.length) return 'No Analyst coverage yet — nothing researched to build from. Source via a <screen_request> to Argus, or screen directly.'
    const lines = list.map(c => {
        const pt   = c.price_target?.value
        const gap  = Number.isFinite(c.gap?.pct) ? ` (${c.gap.pct >= 0 ? '+' : ''}${c.gap.pct}% vs Street${Number.isFinite(c.gap?.consensus_pt) ? ` ${c.gap.consensus_pt}` : ''})` : ''
        const th   = typeof c.thesis === 'string' && c.thesis ? ` — ${c.thesis.length > 160 ? c.thesis.slice(0, 157) + '…' : c.thesis}` : ''
        return `- ${c.symbol} [${c.rating ?? 'unrated'}]${pt != null ? ` our PT ${pt}${gap}` : ''} · ${c.status ?? 'active'}${th}`
    })
    return ['Analyst coverage (researched theses — build from these, our target vs the Street):', ...lines].join('\n')
}

// Per-session handler — coverage is per-user, so it binds userId (like Kairos's userId-bound tools).
function makeCoverageHandler(userId) {
    return makeToolHandler('get_coverage',
        async ({ sector } = {}) => _formatCoverage(await coverageService.getCoverage(userId, { status: 'active', sector: sector ?? null })),
        (err) => `Could not fetch coverage: ${err.message}`, LOG)
}

export const portfolioAgentService = { chatStream }

async function chatStream({ messages = [], ideaAccounts = [], portfolioId = null, portfolioIdeas = [], portfolioState = null, isReviewMode = false, reviewDelta = null, lifecycle = null, mandate = null, thesis = null, model: requestedModel, reasoningEffort, userId, onToken, onTicker, onPhase, onToolStart, onReasoning, signal }) {
    const normalized   = _buildMessages(messages)
    const { model, streamFn, provider, onUsage } = resolveAgentStream(requestedModel, userId)

    // Stable base (cached) + volatile per-request sections (accounts, edit
    // context). cache_control on the base lets Anthropic cache the
    // tools+instructions prefix across turns; only the short tail varies. The
    // OpenAI provider flattens this block array back to a plain string.
    const today = new Date().toISOString().slice(0, 10)
    const dynamicSections = [`CURRENT DATE: ${today}. Resolve relative timeframes (today, next week, this month) against this date — e.g. when calling get_earnings_calendar.`]
    if (ideaAccounts.length > 0) dynamicSections.push(_buildAccountsSection(ideaAccounts))
    if (portfolioId && portfolioIdeas.length > 0) dynamicSections.push(_buildPortfolioContext(portfolioId, portfolioIdeas))
    if (mandate)    dynamicSections.push(_buildMandateSection(mandate))
    if (thesis)     dynamicSections.push(_buildThesisSection(thesis))
    if (lifecycle)  dynamicSections.push(_buildLifecycleSection(lifecycle))
    if (portfolioState) dynamicSections.push(_buildPortfolioStateSection(portfolioState, isReviewMode, reviewDelta))

    // Two cache breakpoints: the static instructions, and the dynamic context
    // tail. The tail (date + accounts + mandate + lifecycle + snapshotted
    // portfolio state) is byte-identical across the follow-up turns of a review
    // session, so caching it lets turns 2+ read it at ~0.1× instead of re-paying
    // full price every turn. A turn where it does change just re-writes it once.
    const systemPrompt = [
        { type: 'text', text: _systemPrompt(), cache_control: { type: 'ephemeral' } },
        ...(dynamicSections.length
            ? [{ type: 'text', text: dynamicSections.join('\n\n'), cache_control: { type: 'ephemeral' } }]
            : []),
    ]

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, accountCount: ideaAccounts.length, editMode: !!portfolioId, model, provider })

    let capturedPlan    = null
    let capturedUpdate  = null
    let capturedMandate = null
    let capturedThesis  = null
    let capturedPhase   = null

    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 6) {
            capturedPhase = n
            onPhase?.(n)
        }
    }
    const onPlan    = (json) => { try { capturedPlan    = JSON.parse(json) } catch { /* malformed */ } }
    const onUpdate  = (json) => { try { capturedUpdate  = JSON.parse(json) } catch { /* malformed */ } }
    const onMandate = (json) => { try { capturedMandate = JSON.parse(json) } catch { /* malformed */ } }

    // All known emit tags suppressed by default; this agent captures phase, ticker
    // (which keeps its inner text in the UI), and the plan/update/mandate blocks.
    const tagCaptures = buildTagCaptures({
        phase:             onPhaseCapture,
        ticker:            { onCapture: onTicker, keepText: true },
        portfolio_plan:    onPlan,
        portfolio_update:  onUpdate,
        portfolio_mandate: onMandate,
    })

    const raw = await streamFn({
        model,
        promptOrMessages: normalized,
        systemPrompt,
        tools:            TOOLS,
        // Per-session: get_coverage binds this user (coverage is per-user); the rest are static.
        toolHandlers:     { ...TOOL_HANDLERS, get_coverage: makeCoverageHandler(userId) },
        reasoningEffort,
        signal,
        onToken,
        tagCaptures,
        onToolStart,
        onReasoning,
        onUsage,
    })

    // <portfolio_thesis> is suppressed from the UI stream but remains in raw — pull it here.
    const thesisMatch = raw.match(/<portfolio_thesis>([\s\S]*?)<\/portfolio_thesis>/)
    if (thesisMatch) {
        try { capturedThesis = JSON.parse(thesisMatch[1].trim()) } catch { /* malformed */ }
    }
    // P4c: Atlas hands a sleeve's mandate to Argus's INVESTING desk to source + research candidates.
    const screenRequest = _parseScreenRequest(raw)

    const reply = stripEmitTags(
        // <ticker> keeps its inner text in the reply (unwrap, don't strip).
        raw.replace(/<ticker>([\s\S]*?)<\/ticker>/g, '$1'),
        ['phase', 'portfolio_plan', 'portfolio_update', 'portfolio_mandate', 'portfolio_thesis', 'screen_request'],
    ).trim()

    if (capturedPlan) capturedPlan = await _sizePlan(capturedPlan)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasPlan: !!capturedPlan, hasUpdate: !!capturedUpdate, hasMandate: !!capturedMandate, hasThesis: !!capturedThesis, screenRequest: !!screenRequest, phase: capturedPhase })
    return { reply, plan: capturedPlan, update: capturedUpdate, mandate: capturedMandate, thesis: capturedThesis, phase: capturedPhase, ...(screenRequest ? { screenRequest } : {}) }
}

// ─── Screen-request extraction (pure) ───────────────────────────────────────────
// Atlas is the PM — it doesn't run the discovery funnel; it hands a sleeve's MANDATE to Argus's
// INVESTING profile (the screening desk) to source fundamentally-screened candidates, which the Analyst
// then researches. This pulls the <screen_request> mandate block. Needs a sector OR a style to constrain
// (else null). Mirrors Kairos's _parseScanRequest. Exported for tests.
export function _parseScreenRequest(raw) {
    const m = (raw ?? '').match(/<screen_request>([\s\S]*?)<\/screen_request>/)
    if (!m) return null
    let obj
    try { obj = JSON.parse(m[1].trim()) } catch (err) { logger.warn(LOG, 'screen_request parse failed:', err.message); return null }
    const s = k => (typeof obj?.[k] === 'string' && obj[k].trim() ? obj[k].trim() : null)
    const sector = s('sector'), style = s('style')
    if (!sector && !style) return null   // a screen needs at least a sector or a style to constrain
    return { sector, style, cap_band: s('cap_band'), constraints: s('constraints'), note: s('note') }
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

function _buildAccountsSection(accounts) {
    const lines = buildAccountLines(accounts)
    return `PORTFOLIO ACCOUNTS (the user plans to execute ideas from this portfolio on):\n${lines.join('\n')}\n\nWhen suggesting position sizes, use these account balances to recommend concrete allocations. If a main account is identified by a larger balance or context, use it as the reference for scaling other accounts.`
}

function _buildMandateSection(mandate) {
    const lines = ['INVESTMENT MANDATE (already established — do not re-ask for any field listed here):']
    if (mandate.objective)     lines.push(`Objective: ${mandate.objective}`)
    if (mandate.horizon)       lines.push(`Time horizon: ${mandate.horizon}`)
    if (mandate.riskTolerance) lines.push(`Risk tolerance: ${mandate.riskTolerance}`)
    if (mandate.constraints)   lines.push(`Constraints: ${mandate.constraints}`)
    if (mandate.benchmark)     lines.push(`Benchmark: ${mandate.benchmark}`)
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

function _buildPortfolioStateSection(state, isReviewMode = false, reviewDelta = null) {
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

    const liveLines = live.map(s => {
        const target  = s.allocationRatio != null ? `target ${Math.round(s.allocationRatio * 100)}%` : 'target —'
        const actual  = `actual ${Math.round(s.actualWeight * 100)}%`
        const drift   = fmtDrift(s.drift)
        const pnl     = `P&L ${fmtMoney(s.pnl)} (${fmtPct(s.pnlPct)})`
        const age     = s.thesisAgeDays != null ? `${s.thesisAgeDays}d` : ''
        const earn    = s.upcomingEarnings ? `  ⚠ earnings ${s.upcomingEarnings.date}` : ''
        return `  ${s.asset.padEnd(6)} ${(s.direction ?? '').padEnd(6)} ${target}  ${actual}  ${drift}  ${pnl}  ${age}${fmtConviction(s)}${earn}`
    })

    const pendingLines = pending.map(s => {
        const target = s.allocationRatio != null ? `target ${Math.round(s.allocationRatio * 100)}%` : 'target —'
        const earn   = s.upcomingEarnings ? `  ⚠ earnings ${s.upcomingEarnings.date}` : ''
        return `  ${s.asset.padEnd(6)} ${s.direction?.padEnd(6) ?? '      '} ${target}  [${s.status}]${earn}`
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
        ? 'Use this data as the starting point for the review. Do not call get_quotes for tickers already shown above — prices are current. Propose specific actions (rebalance, trim, add, exit, swap) where the data warrants it.'
        : 'This is the live book you are helping with — the workspace, open positions, and per-position + total P&L are current. Do not call get_quotes for tickers already shown above. Ground any answer or proposed edit in these actual positions and P&L; do NOT run a full scheduled review unless the user asks for one.')

    return sections.join('\n\n')
}
