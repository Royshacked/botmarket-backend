import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { getQuotes, getRiskMetrics, getPriceAction, getCycleAnalysis } from '../providers/yahoofinance.provider.js'
import { getFundamentals, getEarningsCalendar, getEarnings, screenCandidates, getMarketMovers, getAnalystActions, getSectorSnapshot } from '../providers/fmp.provider.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { makeCandlesHandler, makeIndicatorsHandler, makeChartHandler } from './marketData.tools.js'
import { isMode } from './kairos.modes.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from './priceStructure.tools.js'
import { cleanConviction } from './conviction.util.js'
import { logger }        from './logger.service.js'
import { COMMON_TOOL_HANDLERS, normalizeMessages, makePromptLoader, stripEmitTags, makeToolHandler, resolveAgentStream, TRADE_HORIZONS } from './agentUtils.js'
import { buildTagCaptures } from './llmStream.util.js'
import { isToolError } from './toolResult.util.js'
import { makeGroundingLedger, recordSourced, recordTouched, groundingTier, DISCOVERY_TOOLS, PER_NAME_TICKER_ARGS } from './scanner.grounding.js'

const __dirname     = dirname(fileURLToPath(import.meta.url))
const LOG   = '[scannerAgent]'
// One prompt per Argus PROFILE (P4a): trading = the technical/catalyst trade scanner (unchanged);
// investing = the fundamental/quality screen for portfolio candidates (→ Analyst). Hot-reloaded.
const _profilePrompt = {
    trading:   makePromptLoader(join(__dirname, '../scanner_system_prompt.md'), LOG),
    investing: makePromptLoader(join(__dirname, '../scanner_profile_investing.md'), LOG),
}
const MAX_MESSAGES = 10

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'screen_candidates',
        description: 'Screen the US universe for names that fit the scan\'s shape — the grounded discovery leg (Phase 2). Filter by sector, market cap, price, beta, dividend, and a liquidity floor (volume). NOTE: this is a FUNDAMENTAL & liquidity screen — it CANNOT filter for chart setups (52-week-high, base, RSI). For a technical angle, use it to define a liquid, in-sector universe, then confirm the setup per-name with get_candles/get_indicators. Returns a compact list; qualify each hit before listing it.',
        input_schema: {
            type: 'object',
            properties: {
                sector:            { type: 'string', description: 'e.g. Technology, Healthcare, Energy, Financial Services, Utilities' },
                industry:          { type: 'string', description: 'optional finer bucket, e.g. Semiconductors' },
                marketCapMoreThan: { type: 'number', description: 'min market cap in USD, e.g. 10000000000 for $10B+' },
                marketCapLowerThan:{ type: 'number', description: 'max market cap in USD, e.g. 2000000000 for small-cap' },
                priceMoreThan:     { type: 'number', description: 'min share price (a tradability floor — e.g. 5 to drop penny names)' },
                priceLowerThan:    { type: 'number', description: 'max share price' },
                betaMoreThan:      { type: 'number', description: 'min beta (higher = more cyclical/volatile)' },
                betaLowerThan:     { type: 'number', description: 'max beta (lower = more defensive)' },
                dividendMoreThan:  { type: 'number', description: 'min annual dividend per share in USD' },
                volumeMoreThan:    { type: 'number', description: 'min average volume — the liquidity floor; set it for tradability' },
                country:           { type: 'string', description: 'e.g. US (default universe is US)' },
                isEtf:             { type: 'boolean', description: 'true to screen ETFs instead of single stocks' },
                limit:             { type: 'number', description: 'max results 1–50 (default 25)' },
            },
        },
    },
    {
        name: 'get_market_movers',
        description: 'Today\'s biggest movers — the momentum / gap / "what\'s moving" starting pool for Phase-2 discovery. kind="gainers" (biggest % up), "losers" (biggest % down — short pool), or "active" (highest volume). Grounded discovery, not a watchlist: qualify every name (relative strength, tradability, a real catalyst) before it makes the list. US-listed.',
        input_schema: {
            type: 'object',
            properties: {
                kind:  { type: 'string', enum: ['gainers', 'losers', 'active'], description: 'gainers = biggest % up, losers = biggest % down, active = most traded by volume' },
                limit: { type: 'number', description: 'how many to return, 1–50 (default 20)' },
            },
            required: ['kind'],
        },
    },
    {
        name: 'get_sector_snapshot',
        description: 'Today\'s sector rotation — every sector ranked leaders→laggards by average move. Use it in Phase 2 for a sector-rotation angle (find the leading/lagging groups, then screen_candidates INSIDE them), and in Phase 3 as the sector leg of the relative-strength check (is the name\'s sector leading?). No arguments.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_analyst_actions',
        description: 'Recent analyst rating changes — a catalyst pool beyond earnings. With NO symbols: the market-wide latest upgrades/downgrades feed (Phase-2 discovery of ratings-driven names). With symbols: each name\'s recent rating actions (Phase-3 validation of a shortlist — is a fresh upgrade/downgrade backing the move?). US-listed equities.',
        input_schema: {
            type: 'object',
            properties: {
                symbols: { type: 'array', items: { type: 'string' }, description: 'optional — narrow to these tickers for a per-name read; omit for the market-wide discovery feed' },
                limit:   { type: 'number', description: 'max rows for the market-wide feed, 1–50 (default 25)' },
            },
        },
    },
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
        name: 'get_candles',
        description: 'Fetch recent OHLCV candles for a ticker + timeframe — the exact price structure to name the setup and run the structure-respect check (swing highs/lows, prior-day levels, breakout shelves, base/range). Baseline Phase-3 tool: read the structure from the candles before you score `technical`. Always call it before committing to a named setup or a level.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:    { type: 'string', description: 'e.g. AAPL, NVDA, SPY' },
                timeframe: {
                    type: 'string',
                    enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'],
                    description: 'Candle timeframe. 2hr/4hr are aggregated from native 1hr bars; every other resolution is native. Match it to the scan\'s trade style — intraday/day → minutes/hours, swing → day, long term → day/week.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_indicators',
        description: 'Compute exact indicator VALUES from recent candles — the SAME math the monitor uses (EMA, SMA, RSI, MACD, ATR, VWAP). Use it to CONFIRM the technical read with hard numbers: price vs EMA/VWAP for location, RSI for momentum/divergence, MACD for trend, ATR for how violent the name is. Price action / structure (get_candles) leads; indicators only confirm — a name clean on price with soft indicators is a lower `technical` score, not a reject.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:    { type: 'string', description: 'e.g. AAPL, NVDA' },
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
        name: 'get_chart',
        description: 'Render an actual candlestick chart IMAGE (KLineCharts, optional indicator overlays) and look at it directly for VISUAL / structural analysis — chart patterns, trend, where price sits vs moving averages / VWAP, base/breakout geometry. Use it to CONFIRM the named setup on the strongest names. EXPENSIVE (image render + vision) — reserve it for the top shortlist and the Kairos single-pick, NOT every candidate. For exact numeric levels prefer get_candles.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:     { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA' },
                timeframe:  { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'], description: 'Chart timeframe — match the scan\'s trade style.' },
                indicators: { type: 'string', description: 'Optional overlays, e.g. "ema(50), vwap, volume". Leave EMPTY for a PLAIN price-only chart (the default) — best for reading structure without moving-average clutter.' },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_orderblocks',
        description: 'Detect ORDER BLOCKS on a plain candlestick chart (one ticker + timeframe): the last opposing candle/cluster before an impulsive structure break, whether it is fresh/untested or mitigated, and its zone vs current price. Angle-triggered — reach for it when the scan angle is structure / supply-demand / entry-zone hunting. Levels are approximate; confirm exact prices with get_candles.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:    { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA' },
                timeframe: { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'], description: 'Chart timeframe to read the orderblocks on.' },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_false_breaks',
        description: 'Detect FALSE BREAKS / liquidity sweeps on a plain candlestick chart (one ticker + timeframe): where price pushed beyond a clear prior high/low, failed, and closed back inside the range (a stop run / trap), whether the level was reclaimed, and how recent. Angle-triggered — reach for it for a failed-breakout / reversal / squeeze angle. Levels are approximate; confirm exact prices with get_candles.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:    { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA' },
                timeframe: { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'], description: 'Chart timeframe to read the sweeps on.' },
            },
            required: ['ticker', 'timeframe'],
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
    screen_candidates: makeToolHandler('screen_candidates',
        (filters) => screenCandidates(filters || {}),
        (err) => `Could not run screen: ${err.message}`, LOG),
    get_market_movers: makeToolHandler('get_market_movers',
        ({ kind, limit }) => getMarketMovers(kind, limit),
        (err) => `Could not fetch market movers: ${err.message}`, LOG),
    get_sector_snapshot: makeToolHandler('get_sector_snapshot',
        () => getSectorSnapshot(),
        (err) => `Could not fetch sector snapshot: ${err.message}`, LOG),
    get_analyst_actions: makeToolHandler('get_analyst_actions',
        ({ symbols, limit }) => getAnalystActions(Array.isArray(symbols) ? symbols : [], limit),
        (err) => `Could not fetch analyst actions: ${err.message}`, LOG),
    get_candles:    makeCandlesHandler(LOG),
    get_indicators: makeIndicatorsHandler(LOG),
    // Vision tools (KLineCharts render + visual read). onChart: null → the image goes to
    // the LLM only, not the scan UI. This is DELIBERATE: the scanner does not surface charts
    // to the user (decided 2026-07-22) — the render is an internal vision read, not a deliverable.
    get_chart:        makeChartHandler({ log: LOG, onChart: null, readText: 'Read the price STRUCTURE visually — trend, base/breakout geometry, S/R, where price sits vs any overlays. Confirm the named setup; indicators only confirm, never lead.' }),
    get_orderblocks:  makeStructureVisionHandler({ log: LOG, kind: 'orderblocks',  vision: OB_VISION, onChart: null }),
    get_false_breaks: makeStructureVisionHandler({ log: LOG, kind: 'false_breaks', vision: FB_VISION, onChart: null }),

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

// Wrap the module-level handlers with a per-session grounding recorder. A
// successful discovery call feeds its output text to the tape (`sourced`); a
// successful per-name call records the ticker it ran on (`touched`). A failed
// call (toolError — e.g. a bogus symbol that errored) confers nothing, so a
// fabricated ticker the model merely *attempted* never gets credited.
function _wrapForGrounding(handlers, ledger) {
    const wrapped = {}
    for (const [name, fn] of Object.entries(handlers)) {
        const reader = PER_NAME_TICKER_ARGS[name]
        const isDiscovery = DISCOVERY_TOOLS.has(name)
        wrapped[name] = (reader || isDiscovery)
            ? async (args) => {
                const ret = await fn(args)
                if (!isToolError(ret)) {
                    if (isDiscovery && typeof ret === 'string') recordSourced(ledger, ret)
                    if (reader) recordTouched(ledger, reader(args))
                }
                return ret
            }
            : fn
    }
    return wrapped
}

export const scannerAgentService = { chatStream }

// Exported for unit tests (scanner scorecard normalization + ranking).
export { _normalizeScan, _cleanScore, SCANNER_TOOLS_FOR_PROFILE }

// Tool subset per profile (P4a). Investing drops the technical/momentum/vision kit (candles, indicators,
// chart, orderblocks, movers, positioning, cycles) and keeps the fundamental screen. Trading = full kit.
const INVESTING_TOOL_NAMES = new Set([
    'web_search', 'screen_candidates', 'get_fundamentals', 'get_sector_snapshot',
    'get_earnings', 'get_earnings_calendar', 'get_analyst_actions', 'get_sec_filings',
    'get_quotes', 'get_price_action',
])
function SCANNER_TOOLS_FOR_PROFILE(profile) {
    return profile === 'investing' ? TOOLS.filter(t => INVESTING_TOOL_NAMES.has(t.name)) : TOOLS
}

// Injected into the volatile context when Argus is invoked as a Kairos discovery hand-off: it flips
// Argus from "build a watchlist" to "find ONE ticker + emit <kairos_pick>" (see the prompt's
// KAIROS HAND-OFF MODE section). The bias/horizon ride in the seeded opening message.
const HANDOFF_CONTEXT = 'KAIROS HAND-OFF MODE: the user was sent here by Kairos to find ONE ticker for a single call. Follow the KAIROS HAND-OFF MODE section — converge to a single best pick, do NOT ask whether they are ready for Kairos, and end with a <kairos_pick> block (not a <scan_list>).'

async function chatStream({ messages = [], model: requestedModel, editList = null, handoff = false, profile = 'trading', reasoningEffort, userId, onToken, onTicker, onPhase, onToolStart, onReasoning, signal }) {
    const prof = profile === 'investing' ? 'investing' : 'trading'
    const normalized = _buildMessages(messages)
    const { model, streamFn, provider, onUsage } = resolveAgentStream(requestedModel, userId)

    // Per-session grounding ledger — records which tickers a real, successful tool
    // engaged, so a fabricated candidate that no tool touched is dropped at normalize.
    const ledger = makeGroundingLedger()
    const toolHandlers = _wrapForGrounding(TOOL_HANDLERS, ledger)

    // Stable cached base + volatile tail: today's date (so "next week" resolves)
    // and, when editing an existing list, that list's current contents so the
    // agent can add / remove / change names against it.
    const today = new Date().toISOString().slice(0, 10)
    const dynamic = [`CURRENT DATE: ${today}. Resolve all relative timeframes (today, next week, this month) against this date.`]
    const editSection = _buildEditSection(editList)
    if (editSection) dynamic.push(editSection)
    if (handoff && prof === 'trading') dynamic.push(HANDOFF_CONTEXT)   // hand-off is a trading-only path

    const promptLoader = _profilePrompt[prof] ?? _profilePrompt.trading
    const systemPrompt = [
        { type: 'text', text: promptLoader(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamic.join('\n\n') },
    ]

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, model, provider })

    let capturedScan  = null
    let capturedPhase = null
    let capturedPick  = null

    const onScan = (json) => { try { capturedScan = JSON.parse(json) } catch { /* malformed — ignore */ } }
    const onPick = (json) => { try { capturedPick = JSON.parse(json) } catch { /* malformed — ignore */ } }
    const onPhaseCapture = (p) => {
        const n = parseInt(p, 10)
        if (n >= 1 && n <= 4) {
            capturedPhase = n
            onPhase?.(n)
        }
    }

    // All known emit tags suppressed by default; this agent captures phase, ticker
    // (which keeps its inner text in the UI), scan_list, and — in hand-off mode — kairos_pick.
    const tagCaptures = buildTagCaptures({
        phase:       onPhaseCapture,
        ticker:      { onCapture: onTicker, keepText: true },
        scan_list:   onScan,
        kairos_pick: onPick,
    })

    const raw = await streamFn({
        model,
        promptOrMessages: normalized,
        systemPrompt,
        tools:        SCANNER_TOOLS_FOR_PROFILE(prof),
        toolHandlers,
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
        ['scan_list', 'phase', 'kairos_pick'],
    ).trim()

    const scan = _normalizeScan(capturedScan, editList, ledger, prof)
    const pick = _normalizeKairosPick(capturedPick)

    logger.info(LOG, 'chatStream done', { replyLength: reply.length, profile: prof, hasScan: !!scan, candidates: scan?.candidates?.length ?? 0, hasPick: !!pick, phase: capturedPhase })
    return { reply, scan, phase: capturedPhase, ...(pick ? { pick } : {}) }
}

// Normalize a captured <kairos_pick> (hand-off mode) — the single ticker Argus recommends back to
// Kairos. Pure: null when there's no usable ticker, else a clean {ticker, direction, thesis, analysis}
// (direction defaults long; the analysis seeds Kairos's Phase 2). Exported for tests.
export function _normalizeKairosPick(p) {
    if (!p || typeof p !== 'object' || typeof p.ticker !== 'string' || !p.ticker.trim()) return null
    return {
        ticker:    p.ticker.toUpperCase().trim(),
        direction: p.direction === 'short' ? 'short' : 'long',
        thesis:    typeof p.thesis === 'string' ? p.thesis : '',
        analysis:  typeof p.analysis === 'string' ? p.analysis : '',
        // K3: Argus's recommended Kairos lens from the dominant driver (feasibility-filtered). null =
        // no recommendation → the FE keeps the user's current mode chip. See KAIROS_MODES.md.
        recommended_mode: isMode(p.recommended_mode) ? p.recommended_mode : null,
    }
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
// Trade-horizon vocabulary — the shared cross-agent constant (Idea/Kairos/Atlas holdings).
const SCAN_STYLES = TRADE_HORIZONS

function _normalizeScan(scan, editList = null, ledger = null, profile = 'trading') {
    if (!scan || typeof scan !== 'object') return null
    const priorByTicker = _editListByTicker(editList)
    // Trade style drives the deterministic composite-total weighting (Argus #2),
    // so resolve it up front and thread it into every candidate's score.
    const style = SCAN_STYLES.includes(scan.style) ? scan.style : null
    const prof  = profile === 'investing' ? 'investing' : 'trading'
    const candidates = Array.isArray(scan.candidates) ? scan.candidates : []
    const counts = { sourced: 0, validated: 0, kept: 0, dropped: 0 }
    const clean = []
    for (const c of candidates) {
        if (!c || typeof c.ticker !== 'string' || !c.ticker.trim()) continue
        const key = c.ticker.toUpperCase().trim()

        // A `keep:true` / bare reference rehydrates from the prior list — its
        // grounding was checked when the name was first added, so it is exempt
        // from re-checking (a saved name isn't a fresh fabrication).
        const isBareReference = !c.analysis && !c.signals && !c.thesis
        if ((c.keep === true || isBareReference) && priorByTicker.has(key)) {
            const prior = priorByTicker.get(key)
            const cand = _cleanCandidate(prior, style, prof)
            cand.grounding = prior.grounding ?? 'kept'
            clean.push(cand)
            counts.kept++
            continue
        }

        // Fresh candidate — check it against the tape. Enforcement (drop the
        // ungrounded) only when a ledger is present; no-ledger callers (tests,
        // non-scan paths) keep every candidate untouched.
        const tier = groundingTier(key, ledger)
        if (ledger) {
            if (tier === 'ungrounded') { counts.dropped++; continue }   // A1: drop pure fabrications
            counts[tier]++
        }
        const cand = _cleanCandidate(c, style, prof)
        if (ledger) cand.grounding = tier
        clean.push(cand)
    }
    if (ledger && (counts.dropped || counts.sourced || counts.validated)) {
        logger.info(LOG, 'grounding', counts)
    }
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
        // Shared trade-horizon vocabulary (matches Idea/Kairos/Atlas holdings) — travels
        // with the list so a handed-off candidate carries its horizon. null when unstated.
        style,
        // P4a: which Argus lens produced this list + where a candidate is built. investing → the Analyst
        // (research), trading → the trade-idea builder (Kairos).
        profile:     prof,
        destination: prof === 'investing' ? 'analyst' : 'kairos',
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

// Liquidity floor below which smc/institutional aren't feasible lenses (#4, B).
const MODE_LIQUIDITY_FLOOR = 60

// Light feasibility guard (#4, A1): smc/institutional need a liquid, structure-rich
// name. If the model recommends one but scored `liquidity` below the floor, downgrade
// the SUGGESTION to discretionary (the universal-safe default). Warn-never-block — this
// only sanitizes the pre-fill; the user can still pick any mode. discretionary/null and
// an absent/unscored liquidity axis pass through unchanged (never downgrade on missing data).
function _feasibleMode(mode, score) {
    if (mode !== 'smc' && mode !== 'institutional') return mode
    const liq = score?.liquidity
    return (Number.isFinite(liq) && liq < MODE_LIQUIDITY_FLOOR) ? 'discretionary' : mode
}

function _cleanCandidate(c, style = null, profile = 'trading') {
    const score = _cleanScore(c.score, style, profile)
    return {
        ticker:    c.ticker.toUpperCase().trim(),
        name:      typeof c.name === 'string' ? c.name : null,
        direction: c.direction === 'short' ? 'short' : 'long',
        thesis:    typeof c.thesis === 'string' ? c.thesis : '',
        analysis:  typeof c.analysis === 'string' ? c.analysis : '',
        signals:   (c.signals && typeof c.signals === 'object') ? c.signals : {},
        score,
        conviction: cleanConviction(c.conviction),
        sources:   Array.isArray(c.sources) ? c.sources.filter(s => s && s.url) : [],
        // K3/#4: Argus's recommended Kairos lens — TRADING profile only (an investing candidate goes to
        // the Analyst for research, not to Kairos, so it carries no build lens). isMode-validated + then
        // feasibility-guarded against the liquidity axis.
        recommended_mode: profile === 'investing' ? null : _feasibleMode(isMode(c.recommended_mode) ? c.recommended_mode : null, score),
        // Grounding provenance (scanner.grounding.js). null on the no-ledger path;
        // callers stamp 'sourced' | 'validated' | 'kept' when a ledger is present.
        grounding: null,
    }
}

// TRADING profile axes + style-weights (the default). Short horizons lead with technical + relative
// strength; long horizons lead with the catalyst. Liquidity is a light contributor. Each row sums to 1.
const TRADING_COMPONENTS = ['catalyst', 'technical', 'relativeStrength', 'liquidity']
const TRADING_WEIGHTS = {
    intraday:    { catalyst: 0.20, technical: 0.40, relativeStrength: 0.30, liquidity: 0.10 },
    day:         { catalyst: 0.25, technical: 0.35, relativeStrength: 0.30, liquidity: 0.10 },
    swing:       { catalyst: 0.30, technical: 0.30, relativeStrength: 0.25, liquidity: 0.15 },
    'long term': { catalyst: 0.35, technical: 0.20, relativeStrength: 0.25, liquidity: 0.20 },
}
// INVESTING profile axes (P4a) — a fundamental/quality lens for portfolio candidates. ONE weight set:
// investing is long-horizon, so style doesn't re-weight it. quality + valuation lead; then growth;
// balance-sheet a light gate. Sums to 1.
const INVESTING_COMPONENTS = ['quality', 'valuation', 'growth', 'balance_sheet']
const INVESTING_WEIGHTS    = { quality: 0.30, valuation: 0.30, growth: 0.25, balance_sheet: 0.15 }

// Resolve the scored axes + their weights for a (profile, style). Trading is style-weighted; investing
// is a single set (null/unknown trading style → swing).
function _scoreSpec(profile, style) {
    if (profile === 'investing') return { components: INVESTING_COMPONENTS, weights: INVESTING_WEIGHTS }
    return { components: TRADING_COMPONENTS, weights: TRADING_WEIGHTS[style] || TRADING_WEIGHTS.swing }
}

// Deterministic composite: a weighted mean over the PRESENT axes, renormalized by their weights so a
// partial card still scores from what it has. Overwrites any model-emitted total (Argus #2). Callers
// only reach here when ≥1 axis is finite, so wsum is always > 0.
function _composeTotal(out, components, weights) {
    let sum = 0, wsum = 0
    for (const k of components) {
        const v = out[k]
        if (Number.isFinite(v)) { sum += v * weights[k]; wsum += weights[k] }
    }
    return wsum > 0 ? Math.round(sum / wsum) : null
}

// Coerce the transparent scorecard the agent emits into a 0–100 shape, or null when no axis is present.
// The axis SET depends on the profile (trading: catalyst/technical/relStrength/liquidity; investing:
// quality/valuation/growth/balance_sheet). Each axis clamped to 0–100; a non-numeric axis → null so a
// partial card still renders. `total` is RECOMPUTED from the present axes (Argus #2) — the model's total
// is discarded. A bare total with no axes is never trusted.
function _cleanScore(raw, style = null, profile = 'trading') {
    if (!raw || typeof raw !== 'object') return null
    const { components, weights } = _scoreSpec(profile, style)
    const out = {}
    let any = false
    for (const k of components) {
        const v = raw[k]
        // Reject null/''/undefined explicitly — Number(null) and Number('') are 0, fabricating a score.
        const n = (v === null || v === undefined || v === '') ? NaN : Number(v)
        if (Number.isFinite(n)) { out[k] = Math.min(100, Math.max(0, Math.round(n))); any = true }
        else out[k] = null
    }
    if (!any) return null
    return { total: _composeTotal(out, components, weights), ...out }
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
