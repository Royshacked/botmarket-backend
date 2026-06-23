import { readFileSync }   from 'fs'
import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { resolveStreamFn } from './llmModels.js'
import { getQuote, getQuotes, getRiskMetrics, getCorrelations, getNumericQuote } from '../providers/yahoofinance.provider.js'
import { getFundamentals, getEarningsCalendar } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { toolError }      from './toolResult.util.js'
import { logger }         from './logger.service.js'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, '../trade_portfolio_system_prompt.md'), 'utf-8')

const LOG   = '[portfolioAgent]'
const MAX_MESSAGES = 20

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
}

export const portfolioAgentService = { chatStream }

async function chatStream({ messages = [], ideaAccounts = [], portfolioId = null, portfolioIdeas = [], model: requestedModel, onToken, onTicker, signal }) {
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

    const systemPrompt = [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ...(dynamicSections.length ? [{ type: 'text', text: dynamicSections.join('\n\n') }] : []),
    ]

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, accountCount: ideaAccounts.length, editMode: !!portfolioId, model, provider })

    let capturedPlan   = null
    let capturedUpdate = null

    const raw = await streamFn({
        model,
        promptOrMessages: normalized,
        systemPrompt,
        tools:            TOOLS,
        toolHandlers:     TOOL_HANDLERS,
        signal,
        onToken,
        onTicker,
        onPlan: (json) => {
            try { capturedPlan = JSON.parse(json) } catch { /* malformed */ }
        },
        onUpdate: (json) => {
            try { capturedUpdate = JSON.parse(json) } catch { /* malformed */ }
        },
    })

    const reply = raw
        .replace(/<ticker>([\s\S]*?)<\/ticker>/g, '$1')
        .replace(/<portfolio_plan>[\s\S]*?<\/portfolio_plan>/g, '')
        .replace(/<portfolio_update>[\s\S]*?<\/portfolio_update>/g, '')
        .trim()

    if (capturedPlan) capturedPlan = await _sizePlan(capturedPlan)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasPlan: !!capturedPlan, hasUpdate: !!capturedUpdate })
    return { reply, plan: capturedPlan, update: capturedUpdate }
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
    ideas.forEach((idea, i) => { idea.allocationRatio = Number(norm[i].toFixed(4)) })

    const positionSize = Number(plan.positionSize)
    if (!Number.isFinite(positionSize) || positionSize <= 0) {
        logger.info(LOG, 'sizePlan: no positionSize, quantities left as provided')
        return plan
    }

    // Fetch live prices for all assets in parallel, then size by dollar weight.
    const prices = await Promise.all(ideas.map(async (idea) => {
        try { return (await getNumericQuote(idea.asset)).price }
        catch (err) { logger.warn(LOG, `sizePlan: price fetch failed for ${idea.asset}`, err.message); return null }
    }))
    ideas.forEach((idea, i) => {
        const price = prices[i]
        idea.quantity = (price > 0)
            ? Math.floor((positionSize * idea.allocationRatio) / price)
            : null
    })
    logger.info(LOG, 'sizePlan: quantities computed', { positionSize, ideas: ideas.length })
    return plan
}

function _buildMessages(messages) {
    return messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
        .map(({ role, content }) => ({ role, content: content.trim() }))
        .slice(-MAX_MESSAGES)
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
