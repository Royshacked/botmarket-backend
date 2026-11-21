// The trading desk's tool kit — MENTOR'S: Mentor imports it whole
// (services/agents/mentor.agent.service.js) and is the only consumer. It is not subset by lens:
// Mentor's lens is per-SETUP rather than per-build.
import { getPriceAction, getCycleAnalysis, getCorrelations } from '../priceAnalytics.service.js'
import { toolsFor } from '../agentTools.registry.js'
import { getEarningsCalendar, getFundamentals, getStockPeers, getMacroSnapshot, getSectorSnapshot } from '../../providers/fmp.provider.js'
import { makeTradingContextHandlers, TRADING_CONTEXT_TOOL_SPEC } from './tradingContext.tools.js'
import { makeMarketHoursHandlers, MARKET_HOURS_TOOL_SPEC } from './marketHours.tools.js'
import { getSecFilings } from '../../providers/sec.provider.js'
import { COMMON_TOOL_HANDLERS, makeToolHandler } from '../agentUtils.js'
import {
    makeQuoteHandler, makeCandlesHandler, makeEarningsHandler, makeChartHandler, makeIndicatorsHandler,
} from './marketData.tools.js'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from './priceStructure.tools.js'
import { SMC_TOOL_HANDLERS } from './smc.tools.js'

// The market-data toolset. The heavy lifting reuses the same PURE providers and shared handler
// factories (Yahoo candles/quote/price-action, chart-img render, the shared indicator math, the
// sentiment handlers) — reuse mechanisms, not schemas.

// makeToolHandler uses this tag for the warn line only — spend attribution reads the AGENT's tag
// (agentKeyFromLog), never this one.
const LOG = '[tradingTools]'

// TURNED OFF 2026-11-21 (Roy: "turn off the tools not in use" — never called in 250 traced Mentor replies, and the
// Proteus labs found no indicator or pattern edge): get_peers, get_correlations, get_orderblocks, get_false_breaks,
// get_indicators, get_cycle_analysis, get_derivatives_context and the SMC four (get_fvg, get_structure, get_liquidity,
// get_key_levels). Their handlers and schemas stay — declaring one again here turns it back on.
export const TRADING_TOOLS = [
    ...toolsFor({
        web_search: '',
        get_quote: `Get the current real-time price quote for a ticker. Call this when you need the live price to place zones/levels accurately.`,
        get_candles: `Fetch recent OHLCV candles for a ticker. Use this to read exact price structure — swing highs/lows, prior-day levels, breakout shelves — when mapping entry zones and reference levels. Always call this before committing numeric levels.`,
        get_price_action: `Momentum/positioning snapshot for a ticker: 1d/5d/1m/3m % moves, position within the 1y range, and relative volume. A fast read on whether the name is moving the way the thesis claims and whether volume backs it — call it early, before drilling into candles.`,
        get_macro_snapshot: `Hard macro read for the regime call: the current Treasury curve (3M/2Y/10Y/30Y + 2s10s inversion flag), key economic indicators (GDP, CPI, inflation, unemployment, Fed funds, consumer sentiment), and today's sector rotation (leaders/laggards). The DATA half of the regime read — pair it with web_search for the narrative. Weight by horizon: real weight for swing, a lighter backdrop for intraday/day. No arguments.`,
        get_sector_snapshot: `Today's sector rotation — every sector ranked leaders→laggards by average move. Institutional mode: the sector leg of the relative-strength read (is the name's sector rotating IN or OUT?). No arguments.`,
        get_trading_context: `The user's live trading venue + accounts: which modes are available (paper / live / manual), which live brokers are connected, and the marked-able accounts (id, broker, name, balance, capabilities, which is selected, and what is currently open in each). Use it to confirm a venue exists before finalizing, to feed sizing, to weigh existing exposure, and to tell the user what to mark. No arguments.`,
        check_broker_symbol: TRADING_CONTEXT_TOOL_SPEC.check_broker_symbol,
        get_chart: `Render an actual TradingView candlestick chart IMAGE (with indicator overlays) and look at it directly, for VISUAL / structural analysis — chart patterns, false breaks, orderblocks, trendlines, where price sits vs moving averages / VWAP. Use this to decide which patterns work for the asset. For EXACT numeric levels prefer get_candles. One asset, setup stage only.`,
        get_earnings: `Upcoming earnings date + EPS estimate for a ticker, plus recent quarterly actuals vs estimates. Use it as a catalyst check — is there an event inside the trade horizon that supports or blocks the setup. US equities only.`,
        get_earnings_calendar: `Upcoming earnings dates (with EPS/revenue estimates) for ALL companies reporting between two dates (YYYY-MM-DD, window up to ~3 months), optionally narrowed to specific symbols — PASS symbols when you have them, since a market-wide ask returns only the soonest rows and says so. The forward-looking "who reports when" — use it to scan for an event inside the trade horizon, or to check a shortlist for gap risk. For one ticker's next date plus its beat/miss history, prefer get_earnings.`,
        get_fundamentals: `Company fundamentals for a single ticker: sector/industry, market cap, valuation (P/E, P/B), quality (margins, ROE, debt/equity), and growth. Weight it by horizon — light for intraday/day trades, heavily for swing trades. ETFs return exposure/profile only.`,
        get_sec_filings: `Recent SEC filings for a US-listed equity: latest 8-K (item 2.02 earnings releases), 10-Q and 10-K with dates and links. On-demand deep dive when the thesis hinges on filed numbers or a material event — weight it more for swing horizons. US equities only.`,
        get_short_interest: `Short interest for a US-listed single stock: short % of float, days-to-cover, month-over-month change. Squeeze potential / crowded-bearish positioning. FINRA data, ~2-week lag.`,
        get_options_context: `Options positioning for a US equity/ETF: put/call ratio and ATM implied volatility for the nearest expiry. Reads directional skew and the size of the expected move (event risk). ~15-min delayed.`,
        // APPENDED, never inserted — the snapshot compares by index and the prompt cache keys off
        // the array prefix. Same rule as Axl's TOOLS (see axl.agent.service.js).
        // The cache breakpoint: the LAST tool of the shared prefix (it sat on get_derivatives_context until 2026-11-21).
        get_market_hours: { description: MARKET_HOURS_TOOL_SPEC.get_market_hours, cache: true },
    }),
]

// Candle aggregation + the get_quote·candles·earnings·chart·indicators handlers and the
// indicator-format helpers live in services/tools/marketData.tools.js.

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

    // AN EMPTY WINDOW IS NOT EVIDENCE AGAINST A DATE OUTSIDE IT. A live run walked straight into
    // this: the model had NVDA's earnings on 18 Nov from `get_earnings`, asked the calendar for a
    // window ending on the 17th, got nothing back, and announced a correction retracting a date
    // that was right. The absence only ever means "not in these dates", so the answer says so
    // rather than leaving the inference to be made twice.
    get_earnings_calendar: makeToolHandler('get_earnings_calendar',
        async ({ from, to, symbols }) => {
            const list = Array.isArray(symbols) ? symbols : []
            const out  = await getEarningsCalendar(from, to, list)
            // A row is a dated line; no dated line means the window held nothing.
            // A ROW starts a line with its date; the header prose contains dates too, so matching a
            // date anywhere found "rows" in the sentence that says there are none.
            const empty = typeof out === 'string' ? !/^\s*\d{4}-\d{2}-\d{2}\s/m.test(out) : !(out?.length)
            if (!empty || !list.length) return out
            return `${out}

Nothing for ${list.join(', ')} BETWEEN ${from} AND ${to}. That is all this says — it is NOT evidence that a date you already have from get_earnings is wrong, only that it falls outside this window. Widen the window, or trust get_earnings.`
        },
        (err) => `Could not fetch earnings calendar: ${err.message}`, LOG),

    get_fundamentals: makeToolHandler('get_fundamentals',
        ({ ticker }) => getFundamentals(ticker),
        (err, { ticker }) => `Could not fetch fundamentals for ${ticker}: ${err.message}`, LOG),

    get_sec_filings: makeToolHandler('get_sec_filings',
        ({ ticker }) => getSecFilings(ticker),
        (err, { ticker }) => `Could not fetch SEC filings for ${ticker}: ${err.message}`, LOG),

    ...SMC_TOOL_HANDLERS,
    ...COMMON_TOOL_HANDLERS,
    // Unbound (market hours belong to the instrument, not the user) → static, unlike the venue
    // handlers below which have to be rebuilt per request around a userId.
    ...makeMarketHoursHandlers(),
}

// Build the per-request handler map. get_chart closes over onChart so it can surface the
// rendered chart to the user's chat when the agent flags show_to_user; pass onChart = null
// (non-Anthropic provider) to keep the image model-only. userId is closed over by the
// account-aware tools (get_trading_context — the user's live venue/accounts).
export function buildTradingToolHandlers(onChart, userId = null) {
    return {
        ..._STATIC_HANDLERS,
        // Bound to the user: the venue reads, and the quote (which carries broker availability).
        ...makeTradingContextHandlers(userId),
        get_quote: makeQuoteHandler(LOG, userId),
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
