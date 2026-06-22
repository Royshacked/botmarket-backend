import { readFileSync }   from 'fs'
import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { resolveStreamFn } from './llmModels.js'
import { getQuotes, getRiskMetrics, getPriceAction } from '../providers/yahoofinance.provider.js'
import { getFundamentals, getEarningsCalendar } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { logger }        from './logger.service.js'

const __dirname     = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, '../scanner_system_prompt.md'), 'utf-8')

const LOG   = '[scannerAgent]'
const MAX_MESSAGES = 20

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'get_price_action',
        description: 'Recent price-action summary for a ticker: 1d/5d/1m/3m moves, position within the 1y range, and relative volume. Use it to confirm a name is actually moving the way your thesis claims.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_quotes',
        description: 'Get current prices for several tickers at once.',
        input_schema: {
            type: 'object',
            properties: { tickers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["AAPL","NVDA","FDX"]' } },
            required: ['tickers'],
        },
    },
    {
        name: 'get_risk_metrics',
        description: 'Annualized volatility and ATR (from 1y of daily prices) for a ticker. Use it to gauge how violent a name is before putting it on the list.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_fundamentals',
        description: 'Company fundamentals for a single ticker: sector/industry, market cap, valuation, margins, ROE, growth. Use it to qualify a longer-horizon pick. ETFs return exposure/profile only.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_earnings_calendar',
        description: 'Upcoming earnings dates (with EPS/revenue estimates) between two dates (YYYY-MM-DD, window up to ~3 months). Optionally filter to specific symbols. Use it for the forward-looking "who reports when" — especially for week/multi-day scans.',
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
    {
        name: 'get_sec_filings',
        description: "What a company has actually filed with the SEC: latest 8-K (item 2.02 = the real earnings release), 10-Q, 10-K, with dates and links. Use it to confirm an earnings event truly dropped. US filers only; most ETFs and foreign tickers aren't in EDGAR.",
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, FDX, NKE' } },
            required: ['ticker'],
        },
    },
]

const TOOL_HANDLERS = {
    get_price_action: async ({ ticker }) => {
        try { return await getPriceAction(ticker) }
        catch (err) { return `Could not fetch price action for ${ticker}: ${err.message}` }
    },
    get_quotes: async ({ tickers }) => {
        try { return await getQuotes(tickers) }
        catch (err) { return `Could not fetch quotes: ${err.message}` }
    },
    get_risk_metrics: async ({ ticker }) => {
        try { return await getRiskMetrics(ticker) }
        catch (err) { return `Could not fetch risk metrics for ${ticker}: ${err.message}` }
    },
    get_fundamentals: async ({ ticker }) => {
        try { return await getFundamentals(ticker) }
        catch (err) { return `Could not fetch fundamentals for ${ticker}: ${err.message}` }
    },
    get_earnings_calendar: async ({ from, to, symbols }) => {
        try { return await getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []) }
        catch (err) { return `Could not fetch earnings calendar: ${err.message}` }
    },
    get_sec_filings: async ({ ticker }) => {
        try { return await getSecFilings(ticker) }
        catch (err) { return `Could not fetch SEC filings for ${ticker}: ${err.message}` }
    },
}

export const scannerAgentService = { chatStream }

async function chatStream({ messages = [], model: requestedModel, editList = null, onToken, onTicker, signal }) {
    const normalized = _buildMessages(messages)
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)

    // Stable cached base + volatile tail: today's date (so "next week" resolves)
    // and, when editing an existing list, that list's current contents so the
    // agent can add / remove / change names against it.
    const today = new Date().toISOString().slice(0, 10)
    const dynamic = [`CURRENT DATE: ${today}. Resolve all relative timeframes (today, next week, this month) against this date.`]
    const editSection = _buildEditSection(editList)
    if (editSection) dynamic.push(editSection)

    const systemPrompt = [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamic.join('\n\n') },
    ]

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, model, provider })

    let capturedScan = null

    const raw = await streamFn({
        model,
        promptOrMessages: normalized,
        systemPrompt,
        tools:        TOOLS,
        toolHandlers: TOOL_HANDLERS,
        signal,
        onToken,
        onTicker,
        onScan: (json) => {
            try { capturedScan = JSON.parse(json) } catch { /* malformed — ignore */ }
        },
    })

    const reply = raw
        .replace(/<ticker>([\s\S]*?)<\/ticker>/g, '$1')
        .replace(/<scan_list>[\s\S]*?<\/scan_list>/g, '')
        .trim()

    const scan = _normalizeScan(capturedScan)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasScan: !!scan, candidates: scan?.candidates?.length ?? 0 })
    return { reply, scan }
}

/**
 * Defensively normalize a captured scan so a malformed/partial block from the
 * model never reaches persistence or the UI. Drops candidates without a ticker,
 * uppercases symbols, and guarantees the period/thesis shape.
 */
function _normalizeScan(scan) {
    if (!scan || typeof scan !== 'object') return null
    const candidates = Array.isArray(scan.candidates) ? scan.candidates : []
    const clean = candidates
        .filter(c => c && typeof c.ticker === 'string' && c.ticker.trim())
        .map(c => ({
            ticker:    c.ticker.toUpperCase().trim(),
            name:      typeof c.name === 'string' ? c.name : null,
            direction: c.direction === 'short' ? 'short' : 'long',
            thesis:    typeof c.thesis === 'string' ? c.thesis : '',
            analysis:  typeof c.analysis === 'string' ? c.analysis : '',
            signals:   (c.signals && typeof c.signals === 'object') ? c.signals : {},
            sources:   Array.isArray(c.sources) ? c.sources.filter(s => s && s.url) : [],
        }))
    if (!clean.length) return null

    const period = (scan.period && typeof scan.period === 'object') ? scan.period : {}
    return {
        period: {
            label: typeof period.label === 'string' ? period.label : '',
            start: typeof period.start === 'string' ? period.start : null,
            end:   typeof period.end   === 'string' ? period.end   : null,
        },
        thesis:     typeof scan.thesis === 'string' ? scan.thesis : 'Scan',
        direction:  ['long', 'short', 'mixed'].includes(scan.direction) ? scan.direction : 'mixed',
        candidates: clean,
    }
}

// When the user reopens a saved list to edit it, tell the agent exactly what's
// currently on the list so it edits against it (add/remove/replace names) and
// re-emits the FULL updated <scan_list> rather than starting a new one.
function _buildEditSection(editList) {
    if (!editList || !Array.isArray(editList.candidates) || editList.candidates.length === 0) return null
    const p     = editList.period || {}
    const when  = [p.label, (p.start && p.end) ? `(${p.start} → ${p.end})` : (p.start || p.end || '')].filter(Boolean).join(' ')
    const lines = editList.candidates.map(c => `  - ${c.ticker} (${c.direction || '?'}) — ${c.thesis || ''}`.trimEnd())
    return [
        `EDIT MODE — the user is refining an existing list: "${editList.thesis || 'Scan'}"${when ? ` — ${when}` : ''}.`,
        `Current candidates:`,
        ...lines,
        `When they ask to add, remove, or change names, apply the change and re-emit the FULL updated <scan_list> (keep the names they didn't touch, same period unless they change it). Keep each candidate's analysis/signals rich, as usual.`,
    ].join('\n')
}

function _buildMessages(messages) {
    return messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
        .map(({ role, content }) => ({ role, content: content.trim() }))
        .slice(-MAX_MESSAGES)
}
