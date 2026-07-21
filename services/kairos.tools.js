import { getPriceAction, getCycleAnalysis, getCorrelations } from '../providers/yahoofinance.provider.js'
import { getEarningsCalendar, getFundamentals, getStockPeers, getMacroSnapshot, getSectorSnapshot } from '../providers/fmp.provider.js'
import { getTradingContext } from './tradingContext.service.js'
import { getSecFilings } from '../providers/sec.provider.js'
import { COMMON_TOOL_HANDLERS, makeToolHandler } from './agentUtils.js'
import {
    makeQuoteHandler, makeCandlesHandler, makeEarningsHandler, makeChartHandler, makeIndicatorsHandler,
} from './marketData.tools.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from './priceStructure.tools.js'
import { SMC_TOOLS, SMC_TOOL_HANDLERS } from './smc.tools.js'
import { DEFAULT_MODE } from './kairos.modes.js'

// Kairos's market-data toolset. Deliberately its OWN schemas (not imported from the
// Idea agent) so Kairos is a self-contained trial — but the heavy lifting reuses the
// same PURE providers and shared handler factories (Yahoo candles/quote/price-action,
// chart-img render, the shared indicator math, the sentiment handlers). See
// KAIROS_PLAN.md "reuse mechanisms, not schemas".

const LOG = '[kairosTools]'

export const KAIROS_TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'get_quote',
        description: 'Get the current real-time price quote for a ticker. Call this when you need the live price to place zones/levels accurately.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_candles',
        description: 'Fetch recent OHLCV candles for a ticker. Use this to read exact price structure — swing highs/lows, prior-day levels, breakout shelves — when mapping entry zones and reference levels. Always call this before committing numeric levels.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:    { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA' },
                timeframe: {
                    type: 'string',
                    enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'],
                    description: 'Candle timeframe. 2hr/4hr are aggregated server-side from native 1hr bars; every other resolution is native. Sub-hour history is limited — match the timeframe to the horizon.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_price_action',
        description: 'Momentum/positioning snapshot for a ticker: 1d/5d/1m/3m % moves, position within the 1y range, and relative volume. A fast read on whether the name is moving the way the thesis claims and whether volume backs it — call it early, before drilling into candles.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_peers',
        description: 'Fetch the fundamental PEER SET for a ticker (same sector/size cohort) — the candidate names it may move with. Use it in the Phase 2 correlation read to STOP GUESSING peers: pull the set, pick the ones that matter (close competitors, the sector/industry ETF, a lead-lag driver), then feed those into get_correlations to measure how tightly the asset ACTUALLY tracks each. US-listed equities/ETFs.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. NVDA, AAPL, XOM' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_macro_snapshot',
        description: 'Hard macro read for the Phase 2 regime call: the current Treasury curve (3M/2Y/10Y/30Y + 2s10s inversion flag), key economic indicators (GDP, CPI, inflation, unemployment, Fed funds, consumer sentiment), and today\'s sector rotation (leaders/laggards). The DATA half of the regime read — pair it with web_search for the narrative. Weight by horizon: real weight for swing, a lighter backdrop for intraday/day. No arguments.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_sector_snapshot',
        description: 'Today\'s sector rotation — every sector ranked leaders→laggards by average move. Institutional mode: the sector leg of the relative-strength read (is the name\'s sector rotating IN or OUT?). No arguments.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_trading_context',
        description: 'The user\'s live trading venue + accounts: which modes are available (paper / live / manual), which live brokers are connected, and the marked-able accounts (id, broker, name, balance, capabilities). Use it to confirm a venue exists before finalizing, to feed sizing, and to tell the user what to mark. No arguments.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_correlations',
        description: 'Pairwise correlation matrix (1y daily returns) for a set of tickers. Use it in the Phase 2 correlation read: include the traded asset alongside the names you suspect drive it — its sector/industry ETF, close peers (from get_peers), an index (SPY/QQQ), or a lead-lag driver (e.g. SMH for a chip name, BTC for a high-beta alt, a crude proxy for an E&P) — to measure how tightly it actually moves with each, beyond eyeballing charts. The numbers ground the market_sensitivity level + drivers you emit.',
        input_schema: {
            type: 'object',
            properties: { tickers: { type: 'array', items: { type: 'string' }, description: 'two or more tickers — the asset PLUS its suspected drivers, e.g. ["NVDA","SMH","QQQ"]' } },
            required: ['tickers'],
        },
    },
    {
        name: 'get_chart',
        description: 'Render an actual TradingView candlestick chart IMAGE (with indicator overlays) and look at it directly, for VISUAL / structural analysis — chart patterns, false breaks, orderblocks, trendlines, where price sits vs moving averages / VWAP. Use this to decide which patterns work for the asset. For EXACT numeric levels prefer get_candles. One asset, setup stage only.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:     { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA, BTCUSDT' },
                timeframe:  { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'], description: 'Chart timeframe. All resolutions render natively.' },
                indicators: { type: 'string', description: 'Optional overlays to draw, e.g. "vwap, ema(50), volume". Leave EMPTY for a PLAIN price-only chart (the default) — best for reading structure, orderblocks, sweeps and false breaks without moving-average clutter. Add an overlay ONLY when you want to confirm a read against it.' },
                show_to_user: { type: 'boolean', description: 'Set true when this chart informs the actual playbook (zones/levels/patterns) — the user wants to see what you are reading. Leave false only for a throwaway internal peek.' },
            },
            required: ['ticker', 'timeframe'],
        },
    },
    {
        name: 'get_orderblocks',
        description: 'Detect ORDER BLOCKS on a plain (indicator-free) candlestick chart for one ticker + timeframe. Renders the chart and runs a focused visual read: the last opposing candle/cluster before an impulsive structure break (bullish OB = last down-candle before a rally; bearish OB = last up-candle before a selloff), whether each is fresh/untested or mitigated, and its zone vs current price. Reach for this in Phase 2/4 to find price-action entry zones and triggers — as easily as you would an indicator value. Levels are approximate; confirm exact prices with get_candles.',
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
        description: 'Detect FALSE BREAKS / liquidity sweeps on a plain (indicator-free) candlestick chart for one ticker + timeframe. Renders the chart and runs a focused visual read: where price pushed beyond a clear prior high/low, failed, and closed back inside the range (a stop run / trap), whether the level was reclaimed, and how recent. Reach for this in Phase 2/4 to find price-action triggers. Levels are approximate; confirm exact prices with get_candles.',
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
        description: 'Compute exact indicator VALUES from recent candles — the SAME math the monitor uses (EMA, SMA, RSI, MACD, ATR, VWAP). Use it to confirm a read with hard numbers: ATR for sizing an entry zone to volatility, price vs EMA / VWAP for location, RSI for momentum/divergence, MACD for trend. Price action leads; indicators only confirm.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:    { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA' },
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
        description: 'Detect recurring cycles in a stock\'s price history. Two modes: "price" finds the dominant peak-to-peak / trough-to-trough interval, the current phase, and the next estimated turning point. "calendar" shows how the stock behaved in a specific calendar window (e.g. late June) over the past 3–5 years — average return, hit rate, and whether this year is tracking. Use "price" for recurring-interval / cyclic-window theses, "calendar" for seasonal / calendar-pattern theses. Pass `timeframe` on a "price" read to choose the resolution: a sub-hourly-to-hourly rung (1min–1hr) times a session-scale INTRADAY cycle (in bars); day/week/month (the default) times the multi-day swing cycle.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' },
                mode: { type: 'string', enum: ['price', 'calendar'], description: '"price" for recurring interval cycles, "calendar" for seasonal window analysis' },
                timeframe: { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', 'day', 'week', 'month'], description: 'For "price" mode: the cycle resolution. 1min–1hr = intraday cycle (bars); day (default)/week/month = multi-day swing cycle. Ignored for "calendar" (always daily/yearly).' },
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
        description: 'Upcoming earnings date + EPS estimate for a ticker, plus recent quarterly actuals vs estimates. Use it as a catalyst check — is there an event inside the trade horizon that supports or blocks the setup. US equities only.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_earnings_calendar',
        description: 'Upcoming earnings dates (with EPS/revenue estimates) for ALL companies reporting between two dates (YYYY-MM-DD, window up to ~3 months), optionally narrowed to specific symbols. The forward-looking "who reports when" — use it to scan for an event inside the call horizon, or to check a shortlist for gap risk. For one ticker\'s next date plus its beat/miss history, prefer get_earnings.',
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
        description: 'Company fundamentals for a single ticker: sector/industry, market cap, valuation (P/E, P/B), quality (margins, ROE, debt/equity), and growth. Weight it by horizon — light for intraday/day calls, heavily for swing calls. ETFs return exposure/profile only.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_sec_filings',
        description: 'Recent SEC filings for a US-listed equity: latest 8-K (item 2.02 earnings releases), 10-Q and 10-K with dates and links. On-demand deep dive when the thesis hinges on filed numbers or a material event — weight it more for swing horizons. US equities only.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, TSLA' } },
            required: ['ticker'],
        },
    },
    {
        name: 'get_short_interest',
        description: 'Short interest for a US-listed single stock: short % of float, days-to-cover, month-over-month change. Squeeze potential / crowded-bearish positioning. FINRA data, ~2-week lag.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. GME, TSLA' } }, required: ['ticker'] },
    },
    {
        name: 'get_options_context',
        description: 'Options positioning for a US equity/ETF: put/call ratio and ATM implied volatility for the nearest expiry. Reads directional skew and the size of the expected move (event risk). ~15-min delayed.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. NVDA, SPY' } }, required: ['ticker'] },
    },
    {
        name: 'get_derivatives_context',
        description: 'Crypto-perp positioning from Binance: funding rate, open interest, global long/short ratio. The crypto analog to short-interest/options sentiment. Crypto perps only.',
        input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'e.g. BTC, ETH, SOL' } }, required: ['symbol'] },
        cache_control: { type: 'ephemeral' },
    },
    ...SMC_TOOLS,   // K2 numeric SMC: get_fvg, get_structure, get_liquidity
]

// Candle aggregation + the get_quote·candles·earnings·chart·indicators handlers and
// the indicator-format helpers are shared with the Idea agent — see
// services/marketData.tools.js. Re-exported here so existing importers/tests
// (kairosIndicators.test.js) resolve the historical names unchanged.
export { aggregateCandles as _aggregateCandles, _parseIndicatorSpecs, _formatIndicator } from './marketData.tools.js'

const _STATIC_HANDLERS = {
    get_quote:        makeQuoteHandler(LOG),
    get_candles:      makeCandlesHandler(LOG),
    get_earnings:     makeEarningsHandler(LOG),
    get_indicators:   makeIndicatorsHandler(LOG),

    get_price_action: makeToolHandler('get_price_action',
        ({ ticker }) => getPriceAction(ticker),
        (err, { ticker }) => `Could not fetch price action for ${ticker}: ${err.message}`, LOG),

    get_peers: makeToolHandler('get_peers',
        ({ ticker }) => getStockPeers(ticker),
        (err, { ticker }) => `Could not fetch peers for ${ticker}: ${err.message}`, LOG),

    get_macro_snapshot: makeToolHandler('get_macro_snapshot',
        () => getMacroSnapshot(),
        (err) => `Could not fetch macro snapshot: ${err.message}`, LOG),

    get_sector_snapshot: makeToolHandler('get_sector_snapshot',
        () => getSectorSnapshot(),
        (err) => `Could not fetch sector snapshot: ${err.message}`, LOG),

    get_correlations: makeToolHandler('get_correlations',
        ({ tickers }) => getCorrelations(tickers),
        (err) => `Could not compute correlations: ${err.message}`, LOG),

    get_cycle_analysis: makeToolHandler('get_cycle_analysis',
        ({ ticker, mode, calendar_window, lookback_years, timeframe }) => getCycleAnalysis(ticker, mode, calendar_window ?? null, lookback_years ?? 4, timeframe ?? 'day'),
        (err, { ticker }) => `Could not compute cycle analysis for ${ticker}: ${err.message}`, LOG),

    get_earnings_calendar: makeToolHandler('get_earnings_calendar',
        ({ from, to, symbols }) => getEarningsCalendar(from, to, Array.isArray(symbols) ? symbols : []),
        (err) => `Could not fetch earnings calendar: ${err.message}`, LOG),

    get_fundamentals: makeToolHandler('get_fundamentals',
        ({ ticker }) => getFundamentals(ticker),
        (err, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${err.message}`, LOG),

    get_sec_filings: makeToolHandler('get_sec_filings',
        ({ ticker }) => getSecFilings(ticker),
        (err, { ticker }) => `Could not fetch SEC filings for ${ticker}: ${err.message}`, LOG),

    ...SMC_TOOL_HANDLERS,
    ...COMMON_TOOL_HANDLERS,
}

// ── Per-mode tool subsets (KAIROS_MODES.md tool allocation) ────────────────────
// The model only sees the tool LIST, so subsetting the list is what gates a mode's toolset;
// the handler map can stay full (extra handlers are never reached). UNIVERSAL tools are shared
// by all modes (DRY). NEW numeric SMC tools (K2) + get_sector_snapshot/get_rs_chart join later.
const UNIVERSAL = ['web_search', 'get_quote', 'get_candles', 'get_chart', 'get_trading_context']
// SMC-lens numeric tools (smc only). get_key_levels is SHARED (classical prior-day levels + SMC session liquidity).
const SMC_ONLY = ['get_orderblocks', 'get_fvg', 'get_structure', 'get_liquidity']
const MODE_TOOLS = {
    // classical PA + false-breaks + correlation/positioning + prior-day key levels; NOT the SMC-lens tools.
    discretionary: KAIROS_TOOLS.map(t => t.name).filter(n => !SMC_ONLY.includes(n)),
    // strict smart-money, chart-core: vision OB/sweeps + K2 numeric FVG/structure/liquidity (exact levels).
    smc: [...UNIVERSAL, 'get_price_action', 'get_orderblocks', 'get_false_breaks', 'get_indicators',
        'get_fvg', 'get_structure', 'get_liquidity', 'get_key_levels'],
    // macro/regime + relative-strength + positioning, chart-light; no order-blocks/false-breaks.
    institutional: [...UNIVERSAL, 'get_macro_snapshot', 'get_sector_snapshot', 'get_correlations', 'get_peers',
        'get_short_interest', 'get_options_context', 'get_derivatives_context', 'get_fundamentals',
        'get_sec_filings', 'get_earnings', 'get_earnings_calendar', 'get_cycle_analysis', 'get_price_action'],
}

/** The tool LIST for a mode (subset of KAIROS_TOOLS by name). Unknown mode → discretionary. */
export function KAIROS_TOOLS_FOR_MODE(mode) {
    const allowed = MODE_TOOLS[mode] ?? MODE_TOOLS[DEFAULT_MODE]
    return KAIROS_TOOLS.filter(t => allowed.includes(t.name))
}

// Build the per-request handler map. get_chart closes over onChart so it can surface the
// rendered chart to the user's chat when the agent flags show_to_user; pass onChart = null
// (non-Anthropic provider) to keep the image model-only. userId is closed over by the
// account-aware tools (get_trading_context — the user's live venue/accounts).
export function buildKairosToolHandlers(onChart, userId = null) {
    return {
        ..._STATIC_HANDLERS,
        get_trading_context: makeToolHandler('get_trading_context',
            () => getTradingContext(userId),
            (err) => `Could not fetch trading context: ${err.message}`, LOG),
        get_chart: makeChartHandler({
            log: LOG,
            onChart,
            readText: 'Read the price STRUCTURE visually first — swing highs/lows, prior-day/week levels, orderblocks, sweeps and false breaks, S/R reclaims. Read any indicator overlays only as confirmation, never as the setup.',
        }),
        // Vision-backed price-action tools — need onChart to (optionally) surface the analyzed chart.
        get_orderblocks:  makeStructureVisionHandler({ log: LOG, kind: 'orderblocks',  vision: OB_VISION, onChart }),
        get_false_breaks: makeStructureVisionHandler({ log: LOG, kind: 'false_breaks', vision: FB_VISION, onChart }),
    }
}
