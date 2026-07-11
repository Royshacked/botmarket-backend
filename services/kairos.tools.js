import { getTickerAggregates } from '../providers/yahoofinance.provider.js'
import { calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries, calcATRSeries, calcVWAPSeries } from '../monitoring/evaluators/structured.evaluator.js'
import { sessionStartMs } from './market.service.js'
import { toolError } from './toolResult.util.js'
import { COMMON_TOOL_HANDLERS, makeToolHandler } from './agentUtils.js'
import {
    CANDLE_CFG, aggregateCandles,
    makeQuoteHandler, makeCandlesHandler, makeEarningsHandler, makeChartHandler,
} from './marketData.tools.js'

// Kairos's market-data toolset. Deliberately its OWN schemas/handlers (not imported from the
// Idea agent) so Kairos is a self-contained trial with zero blast radius on Idea — but the
// heavy lifting reuses the same PURE providers (Yahoo candles/quote, chart-img render,
// buildStudies, the shared sentiment handlers). See KAIROS_PLAN.md "reuse mechanisms, not schemas".

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
        name: 'get_chart',
        description: 'Render an actual TradingView candlestick chart IMAGE (with indicator overlays) and look at it directly, for VISUAL / structural analysis — chart patterns, false breaks, orderblocks, trendlines, where price sits vs moving averages / VWAP. Use this to decide which patterns work for the asset. For EXACT numeric levels prefer get_candles. One asset, setup stage only.',
        input_schema: {
            type: 'object',
            properties: {
                ticker:     { type: 'string', description: 'Ticker symbol e.g. AAPL, NVDA, BTCUSDT' },
                timeframe:  { type: 'string', enum: ['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr', 'day', 'week', 'month'], description: 'Chart timeframe. All resolutions render natively.' },
                indicators: { type: 'string', description: 'Optional overlays, e.g. "vwap, ema(50), volume". Leave empty for EMA 20/50 defaults.' },
                show_to_user: { type: 'boolean', description: 'Set true when this chart informs the actual playbook (zones/levels/patterns) — the user wants to see what you are reading. Leave false only for a throwaway internal peek.' },
            },
            required: ['ticker', 'timeframe'],
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
]

// Candle config / aggregation / chart caching / the get_quote·candles·earnings·chart
// handlers are shared with the Idea agent — see services/marketData.tools.js. Kept
// re-exported under the historical name for any external importer.
export { aggregateCandles as _aggregateCandles }

// ─── Indicator readout (reuses the monitor's calc*Series math) ─────────────────
// Parse "ema(20), rsi(14), atr, macd, vwap" → [{ name, period }].
export function _parseIndicatorSpecs(str) {
    return String(str || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const m = s.match(/^([a-zA-Z]+)\s*(?:\(\s*(\d+)\s*\))?/)
        return m ? { name: m[1].toLowerCase(), period: m[2] ? parseInt(m[2], 10) : null } : null
    }).filter(Boolean)
}

// Latest value of a series + up to 2 priors for trend.
function _series3(series) {
    const vals = (series || []).filter(v => v != null).slice(-3).map(v => Number(v).toFixed(2))
    if (!vals.length) return 'n/a (not enough data)'
    const latest = vals[vals.length - 1]
    const prior  = vals.slice(0, -1)
    return prior.length ? `${latest} (prev ${prior.join(', ')})` : latest
}

const _v = (n) => (n == null ? 'n/a' : Number(n).toFixed(2))

export function _formatIndicator(name, period, closes, mon, anchorMs = null) {
    switch (name) {
        case 'ema':  { const p = period ?? 20; return `ema(${p}): ${_series3(calcEMASeries(closes, p))}` }
        case 'sma':  { const p = period ?? 20; return `sma(${p}): ${_series3(calcSMASeries(closes, p))}` }
        case 'rsi':  { const p = period ?? 14; return `rsi(${p}): ${_series3(calcRSISeries(closes, p))}` }
        case 'atr':  { const p = period ?? 14; return `atr(${p}): ${_series3(calcATRSeries(mon, p))}` }
        case 'vwap': return `vwap: ${_series3(calcVWAPSeries(mon, anchorMs))} (${anchorMs != null ? 'session' : 'session-approx'})`
        case 'macd': {
            const { line, signal, hist } = calcMACDSeries(closes)
            return `macd: line ${_v(line.at(-1))} · signal ${_v(signal.at(-1))} · hist ${_v(hist.at(-1))}`
        }
        default: return `${name}: unsupported (use ema/sma/rsi/macd/atr/vwap)`
    }
}

const _STATIC_HANDLERS = {
    get_quote:    makeQuoteHandler(LOG),
    get_candles:  makeCandlesHandler(LOG),
    get_earnings: makeEarningsHandler(LOG),

    get_indicators: makeToolHandler('get_indicators', async ({ ticker, timeframe, indicators }) => {
        const cfg  = CANDLE_CFG[timeframe] ?? CANDLE_CFG['day']
        const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
        const raw  = await getTickerAggregates(ticker.toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
        const bars = cfg.aggregate ? aggregateCandles(raw, cfg.aggregate) : raw
        if (!bars.length) return toolError(`No candle data available for ${ticker}`)

        const specs = _parseIndicatorSpecs(indicators)
        if (!specs.length) return toolError('No recognizable indicators. Try "ema(20), rsi(14), atr, vwap, macd".')

        const closes = bars.map(b => b.close)
        // Monitor-form candles (t/o/h/l/c/v) for ATR + VWAP; candleMs normalizes the s/ms unit.
        const mon    = bars.map(b => ({ t: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
        const last   = closes[closes.length - 1]

        // Session-anchored VWAP (equity 09:30 ET, crypto/futures UTC-midnight; class inferred
        // from the symbol) — same anchor the monitor uses. Intraday-only in effect: on daily+
        // timeframes the bars pre-date today's session anchor, so VWAP reads n/a.
        const anchorMs = sessionStartMs(ticker.toUpperCase())
        const lines = specs.map(s => _formatIndicator(s.name, s.period, closes, mon, anchorMs))
        return `${ticker.toUpperCase()} ${timeframe} indicators (latest, close ${last != null ? last.toFixed(2) : '—'}):\n${lines.join('\n')}`
    }, (err, { ticker }) => `Could not compute indicators for ${ticker}: ${err.message}`, LOG),

    ...COMMON_TOOL_HANDLERS,
}

// Build the per-request handler map. get_chart closes over onChart so it can surface the
// rendered chart to the user's chat when the agent flags show_to_user; pass onChart = null
// (non-Anthropic provider) to keep the image model-only.
export function buildKairosToolHandlers(onChart) {
    return {
        ..._STATIC_HANDLERS,
        get_chart: makeChartHandler({
            log: LOG,
            onChart,
            readText: 'Read the price structure visually — patterns, false breaks, structure, where price sits vs the overlays.',
        }),
    }
}
