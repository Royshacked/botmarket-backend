import { readFileSync }   from 'fs'
import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { resolveStreamFn } from './llmModels.js'
import { getQuote, getQuotes, getRiskMetrics, getCorrelations, getNumericQuote, getVolsAndCorrelationsRaw } from '../providers/yahoofinance.provider.js'
import { getFundamentals, getEarningsCalendar } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { toolError }      from './toolResult.util.js'
import { cleanConviction } from './conviction.util.js'
import { logger }         from './logger.service.js'
import { recordUsage }   from './tokenUsage.service.js'
import { COMMON_TOOL_HANDLERS, normalizeMessages } from './agentUtils.js'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, '../trade_portfolio_system_prompt.md'), 'utf-8')

const LOG   = '[portfolioAgent]'
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
        description: 'Get company fundamentals for a single ticker: sector/industry, market cap, valuation (P/E, P/B), quality (margins, ROE, debt/equity), and growth. Use this to qualify a candidate before including it — especially for multi-month/multi-year holds where fundamentals matter more than price action. ETFs return exposure/profile only (no company statements).',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
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
]

const TOOL_HANDLERS = {
    get_quote: async ({ ticker }) => {
        try { return await getQuote(ticker) }
        catch (err) { return toolError(`Could not fetch quote for ${ticker}: ${err.message}`) }
    },
    get_quotes: async ({ tickers }) => {
        try { return await getQuotes(tickers) }
        catch (err) { return toolError(`Could not fetch quotes: ${err.message}`) }
    },
    get_risk_metrics: async ({ ticker }) => {
        try { return await getRiskMetrics(ticker) }
        catch (err) { return toolError(`Could not fetch risk metrics for ${ticker}: ${err.message}`) }
    },
    get_correlations: async ({ tickers }) => {
        try { return await getCorrelations(tickers) }
        catch (err) { return toolError(`Could not compute correlations: ${err.message}`) }
    },
    get_fundamentals: async ({ ticker }) => {
        try { return await getFundamentals(ticker) }
        catch (err) { return toolError(`Could not fetch fundamentals for ${ticker}: ${err.message}`) }
    },
    get_sec_filings: async ({ ticker }) => {
        try { return await getSecFilings(ticker) }
        catch (err) { return toolError(`Could not fetch SEC filings for ${ticker}: ${err.message}`) }
    },
    get_earnings_calendar: async ({ from, to, symbols }) => {
        try { return await getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []) }
        catch (err) { return toolError(`Could not fetch earnings calendar: ${err.message}`) }
    },
    ...COMMON_TOOL_HANDLERS,
}

export const portfolioAgentService = { chatStream }

async function chatStream({ messages = [], ideaAccounts = [], portfolioId = null, portfolioIdeas = [], portfolioState = null, lifecycle = null, mandate = null, model: requestedModel, reasoningEffort, userId, onToken, onTicker, onPhase, onToolStart, onReasoning, signal }) {
    const normalized   = _buildMessages(messages)
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)

    // Stable base (cached) + volatile per-request sections (accounts, edit
    // context). cache_control on the base lets Anthropic cache the
    // tools+instructions prefix across turns; only the short tail varies. The
    // OpenAI provider flattens this block array back to a plain string.
    const today = new Date().toISOString().slice(0, 10)
    const dynamicSections = [`CURRENT DATE: ${today}. Resolve relative timeframes (today, next week, this month) against this date — e.g. when calling get_earnings_calendar.`]
    if (ideaAccounts.length > 0) dynamicSections.push(_buildAccountsSection(ideaAccounts))
    if (portfolioId && portfolioIdeas.length > 0) dynamicSections.push(_buildPortfolioContext(portfolioId, portfolioIdeas))
    if (mandate)    dynamicSections.push(_buildMandateSection(mandate))
    if (lifecycle)  dynamicSections.push(_buildLifecycleSection(lifecycle))
    if (portfolioState) dynamicSections.push(_buildPortfolioStateSection(portfolioState))

    // Two cache breakpoints: the static instructions, and the dynamic context
    // tail. The tail (date + accounts + mandate + lifecycle + snapshotted
    // portfolio state) is byte-identical across the follow-up turns of a review
    // session, so caching it lets turns 2+ read it at ~0.1× instead of re-paying
    // full price every turn. A turn where it does change just re-writes it once.
    const systemPrompt = [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ...(dynamicSections.length
            ? [{ type: 'text', text: dynamicSections.join('\n\n'), cache_control: { type: 'ephemeral' } }]
            : []),
    ]

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, accountCount: ideaAccounts.length, editMode: !!portfolioId, model, provider })

    let capturedPlan    = null
    let capturedUpdate  = null
    let capturedMandate = null
    let capturedPhase   = null

    const onUsage = userId ? (usage) => recordUsage(userId, model, usage).catch(() => {}) : undefined

    const raw = await streamFn({
        model,
        promptOrMessages: normalized,
        systemPrompt,
        tools:            TOOLS,
        toolHandlers:     TOOL_HANDLERS,
        reasoningEffort,
        signal,
        onToken,
        onTicker,
        onToolStart,
        onReasoning,
        onUsage,
        onPhase: (p) => {
            const n = parseInt(p, 10)
            if (n >= 1 && n <= 6) {
                capturedPhase = n
                onPhase?.(n)
            }
        },
        onPlan: (json) => {
            try { capturedPlan = JSON.parse(json) } catch { /* malformed */ }
        },
        onUpdate: (json) => {
            try { capturedUpdate = JSON.parse(json) } catch { /* malformed */ }
        },
        onMandate: (json) => {
            try { capturedMandate = JSON.parse(json) } catch { /* malformed */ }
        },
    })

    const reply = raw
        .replace(/<ticker>([\s\S]*?)<\/ticker>/g, '$1')
        .replace(/<phase>[\s\S]*?<\/phase>/g, '')
        .replace(/<portfolio_plan>[\s\S]*?<\/portfolio_plan>/g, '')
        .replace(/<portfolio_update>[\s\S]*?<\/portfolio_update>/g, '')
        .replace(/<portfolio_mandate>[\s\S]*?<\/portfolio_mandate>/g, '')
        .trim()

    if (capturedPlan) capturedPlan = await _sizePlan(capturedPlan)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasPlan: !!capturedPlan, hasUpdate: !!capturedUpdate, hasMandate: !!capturedMandate, phase: capturedPhase })
    return { reply, plan: capturedPlan, update: capturedUpdate, mandate: capturedMandate, phase: capturedPhase }
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
    const fmt = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'
    const lines = accounts.map(a => {
        const type  = a.isLive ? 'LIVE' : 'DEMO'
        const parts = [`${(a.broker || '').toUpperCase()} ${type} — login: ${a.login || '—'}, currency: ${a.currency || '—'}`]
        if (a.balance != null) parts.push(`balance: ${fmt(a.balance)}`)
        if (a.equity  != null) parts.push(`equity: ${fmt(a.equity)}`)
        return `  - ${parts.join(', ')}`
    })
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

function _buildPortfolioStateSection(state) {
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
    const header = [
        `PORTFOLIO REVIEW STATE — computed ${date}`,
        `Total notional: $${Math.round(state.totalNotional).toLocaleString('en-US')} | P&L: ${fmtMoney(state.totalPnl)} (${fmtPct(state.totalPnlPct)})`,
    ].join('\n')

    const live    = state.ideas.filter(s => s.actualWeight != null)
    const pending = state.ideas.filter(s => s.actualWeight == null)

    const liveLines = live.map(s => {
        const target  = s.allocationRatio != null ? `target ${Math.round(s.allocationRatio * 100)}%` : 'target —'
        const actual  = `actual ${Math.round(s.actualWeight * 100)}%`
        const drift   = fmtDrift(s.drift)
        const pnl     = `P&L ${fmtMoney(s.pnl)} (${fmtPct(s.pnlPct)})`
        const age     = s.thesisAgeDays != null ? `${s.thesisAgeDays}d` : ''
        const earn    = s.upcomingEarnings ? `  ⚠ earnings ${s.upcomingEarnings.date}` : ''
        return `  ${s.asset.padEnd(6)} ${(s.direction ?? '').padEnd(6)} ${target}  ${actual}  ${drift}  ${pnl}  ${age}${earn}`
    })

    const pendingLines = pending.map(s => {
        const target = s.allocationRatio != null ? `target ${Math.round(s.allocationRatio * 100)}%` : 'target —'
        const earn   = s.upcomingEarnings ? `  ⚠ earnings ${s.upcomingEarnings.date}` : ''
        return `  ${s.asset.padEnd(6)} ${s.direction?.padEnd(6) ?? '      '} ${target}  [${s.status}]${earn}`
    })

    const sections = [header]
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

    sections.push('Use this data as the starting point for the review. Do not call get_quotes for tickers already shown above — prices are current. Propose specific actions (rebalance, trim, add, exit, swap) where the data warrants it.')

    return sections.join('\n\n')
}
