import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicWithTools } from '../providers/anthropic.provider.js'
import { DEFAULT_MODEL } from './llmModels.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { getEarningsCalendar, getFundamentals } from '../providers/fmp.provider.js'
import { getPriceAction, getCycleAnalysis } from '../providers/yahoofinance.provider.js'
import { logger } from './logger.service.js'
import { COMMON_TOOL_HANDLERS, makePromptLoader, buildAccountLines, buildPositionsSection, makeToolHandler, resolveAgentStream } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { makeQuoteHandler, makeCandlesHandler, makeEarningsHandler, makeChartHandler, makeIndicatorsHandler } from './marketData.tools.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from './priceStructure.tools.js'
import { _parseResponse, emptyAnalysisState } from './idea.stateParser.js'

// emptyAnalysisState lives in idea.stateParser.js (with the response parser it
// seeds), but is re-exported here so existing importers of this module keep
// resolving it unchanged.
export { emptyAnalysisState }

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = join(__dirname, '../idea_system_prompt.md')

const LOG = '[ideaAgent]'

// Load the system prompt fresh when the file changes (mtime-gated), so prompt
// edits take effect on the next request without a server restart.
const _baseSystemPrompt = makePromptLoader(PROMPT_PATH, LOG)
const MAX_RECENT_MESSAGES = 6

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'get_quote',
        description: 'Get the current real-time price quote for a stock ticker. Call this when the user asks about current price, today\'s levels, or when you need live price data to answer accurately.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'Stock ticker symbol e.g. AAPL, NVDA' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'get_candles',
        description: 'Fetch recent OHLCV candles for a ticker. Use this whenever the user asks about orderblocks, support/resistance, chart patterns, price levels, or any question that requires seeing recent price action. Never say you cannot see live data — call this tool first.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: {
                    type: 'string',
                    description: 'Stock ticker symbol e.g. AAPL, NVDA',
                },
                timeframe: {
                    type: 'string',
                    enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'],
                    description: 'Candle timeframe. 2hr and 4hr are aggregated server-side from native 1hr bars into true 2hr/4hr OHLCV (Yahoo has no native 2hr/4hr); every other resolution is a native interval. Sub-hour history is limited (1min ~5 days, 5/15/30min ~weeks) — match the timeframe to the setup.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_price_action',
        description: 'Momentum/positioning snapshot for a ticker: 1d/5d/1m/3m % moves, position within the 1y range, and relative volume. A fast read early in formation on whether the name is actually moving the way the thesis claims and whether volume backs it — before drilling into exact candles.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_orderblocks',
        description: 'Detect ORDER BLOCKS on a plain (indicator-free) candlestick chart for one ticker + timeframe. Renders the chart and runs a focused visual read: the last opposing candle/cluster before an impulsive structure break (bullish OB = last down-candle before a rally; bearish OB = last up-candle before a selloff), whether each is fresh/untested or mitigated, and its zone vs current price. Reach for this when mapping the setup to find price-action entry zones and triggers — as easily as you would an indicator value. Levels are approximate; confirm exact prices with get_candles.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:       { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA, BTCUSDT' },
                timeframe:    { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'], description: 'Chart timeframe — read the orderblocks on the timeframe(s) you trade on.' },
                show_to_user: { type: 'boolean', description: 'Set true to render the analyzed chart in the user\'s chat (the plain chart the read is based on). Leave false for an internal read.' },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_false_breaks',
        description: 'Detect FALSE BREAKS / liquidity sweeps on a plain (indicator-free) candlestick chart for one ticker + timeframe. Renders the chart and runs a focused visual read: where price pushed beyond a clear prior high/low, failed, and closed back inside the range (a stop run / trap), whether the level was reclaimed, and how recent. Reach for this when mapping the setup to find price-action triggers. Levels are approximate; confirm exact prices with get_candles.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:       { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA, BTCUSDT' },
                timeframe:    { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'], description: 'Chart timeframe — read the sweeps on the timeframe(s) you trade on.' },
                show_to_user: { type: 'boolean', description: 'Set true to render the analyzed chart in the user\'s chat. Leave false for an internal read.' },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_indicators',
        description: 'Compute exact indicator VALUES from recent candles — the SAME math the monitor uses (EMA, SMA, RSI, MACD, ATR, VWAP). Confirm a read with hard numbers: ATR for volatility-sizing a stop, price vs EMA / VWAP for location, RSI for momentum/divergence, MACD for trend. Price action leads; indicators only confirm.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:    { type: 'string', description: 'Stock ticker symbol e.g. AAPL, NVDA' },
                timeframe: {
                    type: 'string',
                    enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'],
                    description: 'Candle timeframe to compute on.',
                },
                indicators: {
                    type: 'string',
                    description: 'Comma-separated list with optional period, e.g. "ema(20), ema(50), rsi(14), atr(14), macd, vwap". Period is optional (defaults: ema/sma 20, rsi/atr 14). VWAP is session-anchored (intraday).',
                },
            },
            required: ['ticker', 'timeframe', 'indicators'],
        },
    },
    {
        name: 'get_cycle_analysis',
        description: 'Detect recurring cycles in a stock\'s price history. Two modes: "price" finds the dominant peak-to-peak / trough-to-trough interval, the current phase, and the next estimated turning point. "calendar" shows how the stock behaved in a specific calendar window (e.g. late June) over the past 3–5 years — average return, hit rate, and whether this year is tracking. Use "price" for recurring-interval theses, "calendar" for seasonal ones. Pass `timeframe` on a "price" read: a sub-hourly-to-hourly rung (1min–1hr) times a session-scale INTRADAY cycle (in bars); day/week/month (the default) times the multi-day swing cycle.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' },
                mode: { type: 'string', enum: ['price', 'calendar'], description: '"price" for recurring interval cycles, "calendar" for seasonal window analysis' },
                timeframe: { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', 'day', 'week', 'month'], description: 'For "price" mode: the cycle resolution. 1min–1hr = intraday cycle (bars); day (default)/week/month = multi-day swing cycle. Ignored for "calendar".' },
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
                lookback_years: { type: 'number', description: 'Years of history to use (default 4, max 6).' },
            },
            required: ['ticker', 'mode'],
        },
    },
    {
        name: 'get_earnings',
        description: 'Upcoming earnings date + EPS estimate for a ticker, plus the last 4 quarterly EPS actuals vs estimates (with surprise %). Use this in early formation when checking if there is a catalyst coming up, whether to hold through earnings, or whether the company has a history of beating/missing. US equities only — no ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'get_earnings_calendar',
        description: 'Forward earnings calendar: upcoming earnings dates (with EPS/revenue estimates) for companies reporting between two dates (YYYY-MM-DD, window up to ~3 months); optionally filter to specific symbols. Use it to see what reports when around your setup — is the ticker itself, a sector peer, or an index heavyweight printing inside the trade horizon (gap / catalyst risk). For ONE ticker\'s own date plus its past beat/miss history, use get_earnings instead.',
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
        name: 'get_fundamentals',
        description: 'Company fundamentals for a single ticker: sector/industry, market cap, valuation (P/E, P/B), quality (margins, ROE, debt/equity), and growth. Weight it by horizon — light for intraday/day setups, heavily for swing / position trades where fundamentals matter more than price action. ETFs return exposure/profile only.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_sec_filings',
        description: 'Recent earnings-relevant SEC filings for a US-listed equity: latest 8-K (flagging item 2.02 earnings releases), 10-Q and 10-K with filing dates and document links. Use when the user wants to dig into what was actually reported — guidance, material events, or any red flags in recent filings. US equities only (EDGAR filers); not for ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'get_chart',
        description: 'Render an actual TradingView candlestick chart IMAGE (with indicator overlays) and look at it directly, for VISUAL / structural analysis — chart patterns, trendlines, support/resistance, orderblocks, where price sits relative to moving averages. Renders native 4hr candles. For EXACT numeric levels (precise entry/stop/TP prices) prefer get_candles. ONLY call this once the conversation is about building or refining a concrete trade setup on a SINGLE asset — i.e. you are defining or validating an entry, stop, or take-profit, or confirming the market structure behind that setup. Do NOT call it while scanning / screening for stocks, comparing multiple tickers, or answering general questions about a stock; use get_quote / get_candles / web_search for that. One asset, setup stage only.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: {
                    type: 'string',
                    description: 'Ticker symbol e.g. AAPL, NVDA, BTCUSDT',
                },
                timeframe: {
                    type: 'string',
                    enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'],
                    description: 'Chart timeframe. All resolutions render natively via TradingView.',
                },
                indicators: {
                    type: 'string',
                    description: 'Optional free-text indicators to overlay, e.g. "rsi(14), ema(50), volume, vwap". Leave EMPTY for a PLAIN price-only chart (the default) — best for reading structure, orderblocks and S/R without moving-average clutter. Add an overlay ONLY to confirm a read against it.',
                },
                show_to_user: {
                    type: 'boolean',
                    description: 'Set true whenever this chart relates to the user\'s ACTUAL setup — you are defining, validating, or refining their entry / stop / take-profit or reading the market structure behind it, or they asked to see it. In those cases the user wants to see what you are looking at, so show it. Leave false / omit ONLY for a quick throwaway internal peek that does not inform the setup under discussion; such a check must NOT appear in the chat.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_short_interest',
        description: 'Short interest for a US-listed single stock/ADR: short % of float, days-to-cover (short ratio), and month-over-month change. FINRA data, reported bi-monthly with a ~2-week lag — use it for squeeze potential and crowded-bearish positioning when building or pressure-testing a thesis, not as a live read. No data for ETFs, crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. GME, TSLA, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_options_context',
        description: 'Options positioning for a US equity/ETF: put/call ratio (by open interest and by volume) and at-the-money implied volatility for the nearest expiry. Use it to read directional skew and how big a move the market is pricing (elevated IV = expensive options / large expected move, often around a catalyst — relevant for entry timing and event risk). Quotes ~15-min delayed. No data for crypto, FX or futures.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. NVDA, SPY, AAPL' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_derivatives_context',
        description: 'Crypto-perp positioning from Binance: funding rate (who pays to hold the trade — a crowding signal), open interest (committed leverage), and the global long/short account ratio (retail skew). This is the crypto analog to short-interest/options sentiment — use it when the setup is on a crypto perp. Crypto perps only (BTC, ETH, SOL…), not equities, FX or traditional futures.',
        input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: 'e.g. BTC, ETH, SOL (or BTC-USD / BTCUSDT)' } },
            required: ['symbol'],
        },
        cache_control: { type: 'ephemeral' },
    },
]

// Candle config / aggregation / chart caching / the get_quote·candles·earnings·chart
// handlers are shared with Kairos — see services/marketData.tools.js.
const TOOL_HANDLERS = {
    get_quote:      makeQuoteHandler(LOG),
    get_candles:    makeCandlesHandler(LOG),
    get_earnings:   makeEarningsHandler(LOG),
    get_indicators: makeIndicatorsHandler(LOG),

    get_price_action: makeToolHandler('get_price_action',
        ({ ticker }) => getPriceAction(ticker),
        (err, { ticker }) => `Could not fetch price action for ${ticker}: ${err.message}`, LOG),

    get_cycle_analysis: makeToolHandler('get_cycle_analysis',
        ({ ticker, mode, calendar_window, lookback_years, timeframe }) => getCycleAnalysis(ticker, mode, calendar_window ?? null, lookback_years ?? 4, timeframe ?? 'day'),
        (err, { ticker }) => `Could not compute cycle analysis for ${ticker}: ${err.message}`, LOG),

    get_fundamentals: makeToolHandler('get_fundamentals',
        ({ ticker }) => getFundamentals(ticker),
        (err, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${err.message}`, LOG),

    get_earnings_calendar: makeToolHandler('get_earnings_calendar',
        ({ from, to, symbols }) => getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []),
        (err) => `Could not fetch earnings calendar: ${err.message}`, LOG),

    get_sec_filings: makeToolHandler(
        'get_sec_filings',
        ({ ticker }) => getSecFilings(ticker),
        (err, { ticker }) => `Could not fetch SEC filings for ${ticker}: ${err.message}`,
        LOG,
    ),

    ...COMMON_TOOL_HANDLERS,
}

// Build the per-request tool handler map. get_chart closes over onChart so it can
// surface the rendered chart to the user's chat when the agent flags show_to_user;
// pass onChart = null (non-stream path) to keep get_chart model-only — the image
// still reaches the LLM, it just isn't shown to the user.
function _buildToolHandlers(onChart) {
    return {
        ...TOOL_HANDLERS,
        get_chart: makeChartHandler({ log: LOG, onChart, readText: 'Analyze the price structure visually — patterns, S/R, orderblocks, false breaks first; indicators only confirm.' }),
        // Vision-backed price-action tools — need onChart to (optionally) surface the analyzed chart.
        get_orderblocks:  makeStructureVisionHandler({ log: LOG, kind: 'orderblocks',  vision: OB_VISION, onChart }),
        get_false_breaks: makeStructureVisionHandler({ log: LOG, kind: 'false_breaks', vision: FB_VISION, onChart }),
    }
}

export const ideaAgentService = {
    chat,
    chatStream,
}

async function chat({ messages, userPrompt, analysisState = emptyAnalysisState(), brokerContext = null, clientTime = null }) {
    const systemPrompt = _buildSystemPrompt(analysisState, brokerContext, [], clientTime)
    const builtMessages = _buildMessages({ messages, userPrompt, analysisState })

    logger.info(LOG, 'chat start', {
        userPrompt,
        messageCount: builtMessages.length,
        activeAsset: analysisState?.structured_state?.active_asset ?? '',
    })

    const raw = await callAnthropicWithTools({
        model: DEFAULT_MODEL,
        promptOrMessages: builtMessages,
        systemPrompt,
        tools: TOOLS,
        toolHandlers: _buildToolHandlers(null),   // non-stream: chart goes to the LLM only, not the UI
    })

    const { reply, updatedState, tradeIdea } = _parseResponse(raw, analysisState, userPrompt)

    logger.info(LOG, 'chat done', {
        replyLength: reply.length,
        hasTradeIdea: Boolean(tradeIdea),
        recentMessageCount: updatedState.recent_messages.length,
    })

    return { reply, analysisState: updatedState, ...(tradeIdea ? { tradeIdea } : {}) }
}

async function chatStream({ messages, userPrompt, analysisState = emptyAnalysisState(), brokerContext = null, ideaAccounts = [], clientTime = null, model: requestedModel, reasoningEffort, userId, onToken, onAsset, onInterval, onChart, onPhase, onToolStart, onReasoning, signal }) {
    const { model, streamFn, provider, onUsage } = resolveAgentStream(requestedModel, userId)

    const tools        = TOOLS
    const toolHandlers = _buildToolHandlers(onChart)

    const systemPrompt   = _buildSystemPrompt(analysisState, brokerContext, ideaAccounts, clientTime)
    const builtMessages  = _buildMessages({ messages, userPrompt, analysisState })

    logger.info(LOG, 'chatStream start', {
        userPrompt,
        messageCount:  builtMessages.length,
        activeAsset:   analysisState?.structured_state?.active_asset ?? '',
        model,
        provider,
    })

    let capturedPhase = null

    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 5) {
            capturedPhase = n
            onPhase?.(n)
        }
    }

    // All known emit tags are suppressed by default (buildTagCaptures); this agent
    // captures asset/interval/phase. Everything else is suppress-only so no stray
    // tag reaches the UI.
    const tagCaptures = buildTagCaptures({ asset: onAsset, interval: onInterval, phase: onPhaseCapture })

    const raw = await streamFn({
        model,
        promptOrMessages: builtMessages,
        systemPrompt,
        tools,
        toolHandlers,
        reasoningEffort,
        signal,
        onToken,
        tagCaptures,
        onToolStart,
        onReasoning,
        onUsage,
    })

    const { reply, updatedState, tradeIdea } = _parseResponse(raw, analysisState, userPrompt)

    logger.info(LOG, 'chatStream done', {
        replyLength:       reply.length,
        hasTradeIdea:      Boolean(tradeIdea),
        recentMessageCount: updatedState.recent_messages.length,
        phase: capturedPhase,
    })

    return { reply, analysisState: updatedState, phase: capturedPhase, ...(tradeIdea ? { tradeIdea } : {}) }
}

function _buildSystemPrompt(analysisState, brokerContext, ideaAccounts = [], clientTime = null) {
    const asset   = analysisState?.structured_state?.active_asset || 'none'
    const summary = analysisState?.recent_chat_summary || 'No prior context.'
    const pt      = analysisState?.structured_state?.pending_trade

    // Include the current pending_trade so the LLM updates from it rather than
    // re-deriving the entire state from scratch each turn.
    const stateSection = pt
        ? `\nCurrent pending trade (carry all set fields forward — only update what changed):\n${JSON.stringify(pt, null, 2)}`
        : ''

    // Split into a stable base (the instructions — byte-identical every request)
    // and a volatile context tail. cache_control on the base lets Anthropic cache
    // the tools+instructions prefix across turns (and across users), so only the
    // short tail is reprocessed each request. Returned as system content blocks.
    const today = new Date().toISOString().slice(0, 10)
    const dynamicContext = `---
CURRENT DATE: ${today}. Resolve relative timeframes (today, next week, this month) against this date — e.g. when calling get_earnings_calendar.
${_buildTimeSection(clientTime)}
CONVERSATION CONTEXT:
${summary}
Active asset: ${asset}${stateSection}${buildPositionsSection(brokerContext)}${_buildIdeaAccountsSection(ideaAccounts)}`

    return [
        { type: 'text', text: _baseSystemPrompt(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicContext },
    ]
}

// Timezone guidance for time-condition authoring. The browser sends its instant + IANA
// zone; render the user's local wall-clock + UTC offset so the agent converts clock/date
// times against the USER's timezone and stores after/before as absolute UTC. When the zone
// is missing/invalid, tell the agent to ask rather than guess. See project_timestamp_ideas.
function _buildTimeSection(clientTime) {
    const local = _formatClientTime(clientTime)
    return local
        ? `USER LOCAL TIME: ${local}. Interpret any clock time or date the user gives WITHOUT an explicit timezone in THIS timezone, and resolve relative dates (today, tomorrow, next week) against the user's local date. For a time condition, always store after/before as absolute UTC (ISO-8601 …Z).`
        : `USER LOCAL TIMEZONE: unknown. If the user gives a clock time or date for a time condition, ask which timezone (or confirm UTC) before converting — never guess — then store after/before as absolute UTC (ISO-8601 …Z).`
}

// Format the browser instant in its IANA zone as "Mon, 07/13/2026, 19:24 Asia/Jerusalem
// (GMT+03:00)". Returns null when the zone is absent or invalid (bad IANA string throws in
// Intl). Exported for unit testing.
export function _formatClientTime(clientTime) {
    const tz  = typeof clientTime?.clientTz === 'string' ? clientTime.clientTz.trim() : ''
    const now = Number.isFinite(clientTime?.clientNow) ? clientTime.clientNow : Date.now()
    if (!tz) return null
    try {
        const d     = new Date(now)
        const local = d.toLocaleString('en-US', {
            timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
            day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        })
        const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
            .formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? ''
        return `${local} ${tz}${offset ? ` (${offset})` : ''}`
    } catch {
        return null   // invalid IANA timezone
    }
}

function _buildIdeaAccountsSection(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        // No account is selected. A trade can't be monitored or executed without one
        // (paper or live), so tell the user to pick one in the account selector before
        // you finalize/activate the setup — don't hand off a ready-to-execute trade
        // without a chosen account.
        return `\n\nIDEA ACCOUNTS: none selected. Before finalizing or activating this trade, tell the user they need to choose a trading account (paper or live) in the account selector — the idea can't be monitored or executed without one.`
    }
    const lines = buildAccountLines(accounts)
    return `\n\nIDEA ACCOUNTS (the user plans to execute this trade on):\n${lines.join('\n')}`
}

function _buildMessages({ messages, userPrompt, analysisState }) {
    const prior = Array.isArray(analysisState?.recent_messages) ? analysisState.recent_messages : []

    if (Array.isArray(messages) && messages.length > 0) {
        const normalized = messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
            .map(({ role, content }) => ({ role, content: content.trim() }))
        // Caller owns the history — don't prepend prior to avoid duplicating messages
        // that are already present in the messages array.
        return _trimMessages(normalized)
    }

    const current = userPrompt?.trim()
        ? [{ role: 'user', content: userPrompt.trim() }]
        : []
    return _trimMessages([...prior, ...current])
}

function _trimMessages(messages) {
    if (!Array.isArray(messages)) return []
    return messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.trim() }))
        .slice(-MAX_RECENT_MESSAGES)
}
