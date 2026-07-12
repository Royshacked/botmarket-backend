import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { getQuotes, getRiskMetrics, getPriceAction, getCycleAnalysis, getEarnings } from '../providers/yahoofinance.provider.js'
import { getFundamentals, getEarningsCalendar } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { cleanConviction } from './conviction.util.js'
import { logger }        from './logger.service.js'
import { COMMON_TOOL_HANDLERS, normalizeMessages, makePromptLoader, stripEmitTags, makeToolHandler, resolveAgentStream } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'

const __dirname     = dirname(fileURLToPath(import.meta.url))
const LOG   = '[scannerAgent]'
// Hot-reload the system prompt on file change (mtime-gated) — no restart needed.
const _systemPrompt = makePromptLoader(join(__dirname, '../scanner_system_prompt.md'), LOG)
const MAX_MESSAGES = 10

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
        name: 'get_earnings',
        description: 'For a SINGLE ticker: its next earnings date + EPS estimate, plus the last 4 quarterly EPS actuals vs estimates (with surprise %). Use it to qualify one scan candidate — is a print imminent (gap risk), and does the name have a track record of beating or missing. For the forward "who reports when" across a period, use get_earnings_calendar. US equities only.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' } },
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
    {
        name: 'get_cycle_analysis',
        description: 'Detect recurring cycles in a stock\'s price history. Two modes: "price" finds the dominant peak-to-peak / trough-to-trough interval, tells you the current phase, and estimates the next turning point. "calendar" shows how the stock behaved in a specific calendar window (e.g. late June) over the past 3–5 years — average return, hit rate, and whether this year is tracking with the historical pattern. Use "price" for recurring-interval / cyclic-window theses ("cycles every ~6 weeks"); use "calendar" for seasonal / calendar-pattern theses ("June is always weak"). The angle makes the mode clear — pick it directly rather than asking which they mean.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' },
                mode: { type: 'string', enum: ['price', 'calendar'], description: '"price" for recurring interval cycles, "calendar" for seasonal window analysis' },
                calendar_window: {
                    type: 'object',
                    description: 'Required for mode "calendar". Defines the window to analyze each year.',
                    properties: {
                        month_start: { type: 'number', description: '1-based month number (Jan=1). Start month of the window.' },
                        month_end:   { type: 'number', description: '1-based month number. End month — same as month_start for a single month.' },
                        day_start:   { type: 'number', description: 'Optional. Starting day within month_start (default 1).' },
                        day_end:     { type: 'number', description: 'Optional. Ending day within month_end (default last day of month).' },
                    },
                    required: ['month_start'],
                },
                lookback_years: { type: 'number', description: 'Years of history to use (default 4, max 6). More years = more reliable pattern but older data.' },
            },
            required: ['ticker', 'mode'],
        },
    },
    {
        name: 'get_short_interest',
        description: 'Short interest for a US-listed single stock/ADR: short % of float, days-to-cover (short ratio), and month-over-month change. FINRA data, reported bi-monthly with a ~2-week lag — use it for squeeze potential and crowded-bearish-positioning context on a scan candidate, not as a live read. No data for ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. GME, TSLA, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_options_context',
        description: 'Options positioning for a US equity/ETF: put/call ratio (by open interest and by volume) and at-the-money implied volatility for the nearest expiry. Use it to gauge directional skew and how big a move the market is pricing (elevated IV = expensive options / large expected move, often around a catalyst). Quotes ~15-min delayed. No data for crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. NVDA, SPY, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_derivatives_context',
        description: 'Crypto-perp positioning from Binance: funding rate (who pays to hold the trade — a crowding signal), open interest (committed leverage), and the global long/short account ratio (retail skew). This is the crypto analog to short-interest/options sentiment. Crypto perps only (BTC, ETH, SOL…) — not equities, FX or traditional futures.',
        input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: 'e.g. BTC, ETH, SOL (or BTC-USD / BTCUSDT)' } },
            required: ['symbol'],
        },
        cache_control: { type: 'ephemeral' },
    },
]

const TOOL_HANDLERS = {
    get_price_action: makeToolHandler('get_price_action',
        ({ ticker }) => getPriceAction(ticker),
        (err, { ticker }) => `Could not fetch price action for ${ticker}: ${err.message}`, LOG),
    get_quotes: makeToolHandler('get_quotes',
        ({ tickers }) => getQuotes(tickers),
        (err) => `Could not fetch quotes: ${err.message}`, LOG),
    get_risk_metrics: makeToolHandler('get_risk_metrics',
        ({ ticker }) => getRiskMetrics(ticker),
        (err, { ticker }) => `Could not fetch risk metrics for ${ticker}: ${err.message}`, LOG),
    get_fundamentals: makeToolHandler('get_fundamentals',
        ({ ticker }) => getFundamentals(ticker),
        (err, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${err.message}`, LOG),
    get_earnings: makeToolHandler('get_earnings',
        ({ ticker }) => getEarnings(ticker),
        (err, { ticker }) => `Could not fetch earnings for ${ticker}: ${err.message}`, LOG),
    get_earnings_calendar: makeToolHandler('get_earnings_calendar',
        ({ from, to, symbols }) => getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []),
        (err) => `Could not fetch earnings calendar: ${err.message}`, LOG),
    get_sec_filings: makeToolHandler('get_sec_filings',
        ({ ticker }) => getSecFilings(ticker),
        (err, { ticker }) => `Could not fetch SEC filings for ${ticker}: ${err.message}`, LOG),
    get_cycle_analysis: makeToolHandler('get_cycle_analysis',
        ({ ticker, mode, calendar_window, lookback_years }) => getCycleAnalysis(ticker, mode, calendar_window ?? null, lookback_years ?? 4),
        (err, { ticker }) => `Could not compute cycle analysis for ${ticker}: ${err.message}`, LOG),
    ...COMMON_TOOL_HANDLERS,
}

export const scannerAgentService = { chatStream }

// Exported for unit tests (scanner scorecard normalization + ranking).
export { _normalizeScan, _cleanScore }

async function chatStream({ messages = [], model: requestedModel, editList = null, reasoningEffort, userId, onToken, onTicker, onPhase, onToolStart, onReasoning, signal }) {
    const normalized = _buildMessages(messages)
    const { model, streamFn, provider, onUsage } = resolveAgentStream(requestedModel, userId)

    // Stable cached base + volatile tail: today's date (so "next week" resolves)
    // and, when editing an existing list, that list's current contents so the
    // agent can add / remove / change names against it.
    const today = new Date().toISOString().slice(0, 10)
    const dynamic = [`CURRENT DATE: ${today}. Resolve all relative timeframes (today, next week, this month) against this date.`]
    const editSection = _buildEditSection(editList)
    if (editSection) dynamic.push(editSection)

    const systemPrompt = [
        { type: 'text', text: _systemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamic.join('\n\n') },
    ]

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, model, provider })

    let capturedScan  = null
    let capturedPhase = null

    const onScan = (json) => { try { capturedScan = JSON.parse(json) } catch { /* malformed — ignore */ } }
    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 4) {
            capturedPhase = n
            onPhase?.(n)
        }
    }

    // All known emit tags suppressed by default; this agent captures phase, ticker
    // (which keeps its inner text in the UI), and scan_list.
    const tagCaptures = buildTagCaptures({
        phase:     onPhaseCapture,
        ticker:    { onCapture: onTicker, keepText: true },
        scan_list: onScan,
    })

    const raw = await streamFn({
        model,
        promptOrMessages: normalized,
        systemPrompt,
        tools:        TOOLS,
        toolHandlers: TOOL_HANDLERS,
        reasoningEffort,
        signal,
        onToken,
        tagCaptures,
        onToolStart,
        onReasoning,
        onUsage,
    })

    const reply = stripEmitTags(
        // <ticker> keeps its inner text in the reply (unwrap, don't strip).
        raw.replace(/<ticker>([\s\S]*?)<\/ticker>/g, '$1'),
        ['scan_list', 'phase'],
    ).trim()

    const scan = _normalizeScan(capturedScan, editList)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, hasScan: !!scan, candidates: scan?.candidates?.length ?? 0, phase: capturedPhase })
    return { reply, scan, phase: capturedPhase }
}

/**
 * Defensively normalize a captured scan so a malformed/partial block from the
 * model never reaches persistence or the UI. Drops candidates without a ticker,
 * uppercases symbols, and guarantees the period/thesis shape.
 *
 * In edit mode the model emits untouched candidates as a bare
 * `{ ticker, keep: true }` reference instead of re-typing their full
 * analysis/signals/sources (saves premium output and avoids regeneration drift).
 * We rehydrate those from editList — the full prior record we already hold.
 */
function _normalizeScan(scan, editList = null) {
    if (!scan || typeof scan !== 'object') return null
    const priorByTicker = _editListByTicker(editList)
    const candidates = Array.isArray(scan.candidates) ? scan.candidates : []
    const clean = candidates
        .map(c => _resolveCandidate(c, priorByTicker))
        .filter(Boolean)
    if (!clean.length) return null

    // Deterministic ranking: highest composite score first, regardless of the
    // order the model emitted. Stable, so equal scores keep their emitted order.
    clean.sort((a, b) => _scoreTotal(b) - _scoreTotal(a))

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

function _editListByTicker(editList) {
    const map = new Map()
    if (editList && Array.isArray(editList.candidates)) {
        for (const c of editList.candidates) {
            if (c && typeof c.ticker === 'string' && c.ticker.trim()) {
                map.set(c.ticker.toUpperCase().trim(), c)
            }
        }
    }
    return map
}

// Resolve one emitted candidate to a full clean record. A `keep:true` reference
// (or a bare ticker that matches a prior candidate and carries no new content)
// is rehydrated from the prior list so untouched names keep their original
// analysis verbatim instead of being regenerated.
function _resolveCandidate(c, priorByTicker) {
    if (!c || typeof c.ticker !== 'string' || !c.ticker.trim()) return null
    const key = c.ticker.toUpperCase().trim()
    const isBareReference = !c.analysis && !c.signals && !c.thesis
    if ((c.keep === true || isBareReference) && priorByTicker.has(key)) {
        return _cleanCandidate(priorByTicker.get(key))
    }
    return _cleanCandidate(c)
}

function _cleanCandidate(c) {
    return {
        ticker:    c.ticker.toUpperCase().trim(),
        name:      typeof c.name === 'string' ? c.name : null,
        direction: c.direction === 'short' ? 'short' : 'long',
        thesis:    typeof c.thesis === 'string' ? c.thesis : '',
        analysis:  typeof c.analysis === 'string' ? c.analysis : '',
        signals:   (c.signals && typeof c.signals === 'object') ? c.signals : {},
        score:     _cleanScore(c.score),
        conviction: cleanConviction(c.conviction),
        sources:   Array.isArray(c.sources) ? c.sources.filter(s => s && s.url) : [],
    }
}

// Coerce the transparent scorecard the agent emits into a 0–100 shape, or null
// when nothing usable is present (the UI then falls back to the conviction chip
// alone). Each component is clamped to 0–100; a non-numeric field becomes null so
// a partial card (e.g. total + technical only) still renders what it has.
const SCORE_KEYS = ['total', 'catalyst', 'technical', 'relativeStrength', 'liquidity']

function _cleanScore(raw) {
    if (!raw || typeof raw !== 'object') return null
    const out = {}
    let any = false
    for (const k of SCORE_KEYS) {
        const v = raw[k]
        // Reject null/''/undefined explicitly — Number(null) and Number('') are 0,
        // which would fabricate a real score out of an absent field.
        const n = (v === null || v === undefined || v === '') ? NaN : Number(v)
        if (Number.isFinite(n)) { out[k] = Math.min(100, Math.max(0, Math.round(n))); any = true }
        else out[k] = null
    }
    return any ? out : null
}

// Sort key for ranking: composite total, highest first. Names without a usable
// total sort last (−1) so a partial/missing score never jumps the queue.
function _scoreTotal(c) {
    const t = c?.score?.total
    return Number.isFinite(t) ? t : -1
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
        `When they ask to add, remove, or change names, re-emit the FULL <scan_list> (same period unless they change it) — but do NOT rewrite untouched names. Emit each unchanged candidate as a bare reference: { "ticker": "NVDA", "keep": true } — its saved analysis, signals and sources are preserved automatically. Write full rich fields ONLY for candidates you are adding or actually changing. To remove a name, just omit it.`,
    ].join('\n')
}

function _buildMessages(messages) {
    return normalizeMessages(messages, MAX_MESSAGES)
}
