import { getQuote, getTickerAggregates, getEarnings } from '../providers/yahoofinance.provider.js'
import { fetchChartImage } from '../providers/chartImg.provider.js'
import { buildStudies } from '../monitoring/evaluators/chart.evaluator.js'
import { toolError } from './toolResult.util.js'
import { makeToolHandler } from './agentUtils.js'
import { logger } from './logger.service.js'

// Shared market-data toolset for the chart-reading agents (Idea, Kairos, and any
// future market-data agent like Axl). The provider math is identical across agents;
// only the per-handler LOG tag, the get_chart "how to read it" sentence, and each
// agent's extra handlers (get_sec_filings / get_indicators) differ — those stay in
// the agent modules. See CODE_MAP: "reuse mechanisms, not schemas".

// Per timeframe: Yahoo bar spec + how many candles to return + lookback window.
// `aggregate` (2hr/4hr) means fetch native 1hr bars and combine N→1 server-side,
// since Yahoo has no native 2hr/4hr. windowDays respects Yahoo's intraday history
// limits (1min ≤ 7d, 5/15/30min ≤ 60d, 1hr ≤ 730d); extra lookback is just sliced
// off, so it only needs to be a safe upper bound that captures `count` bars.
export const CANDLE_CFG = {
    '1min':  { timeSpan: 'minute', multiplier: 1,  count: 60, windowDays: 5   },
    '5min':  { timeSpan: 'minute', multiplier: 5,  count: 60, windowDays: 10  },
    '15min': { timeSpan: 'minute', multiplier: 15, count: 50, windowDays: 20  },
    '30min': { timeSpan: 'minute', multiplier: 30, count: 40, windowDays: 40  },
    '1hr':   { timeSpan: 'hour',   multiplier: 1,  count: 30, windowDays: 5   },
    '2hr':   { timeSpan: 'hour',   multiplier: 1,  count: 30, windowDays: 16, aggregate: 2 },
    '4hr':   { timeSpan: 'hour',   multiplier: 1,  count: 24, windowDays: 24, aggregate: 4 },
    'day':   { timeSpan: 'day',    multiplier: 1,  count: 40, windowDays: 60  },
    'week':  { timeSpan: 'week',   multiplier: 1,  count: 24, windowDays: 200 },
    'month': { timeSpan: 'month',  multiplier: 1,  count: 24, windowDays: 800 },
}

export function fmtVol(v) {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
    if (v >= 1_000)     return (v / 1_000).toFixed(0) + 'K'
    return String(v)
}

// Yahoo offers no native 2hr/4hr interval, so get_candles fetches 1hr bars and
// aggregates them into true 2hr/4hr OHLCV here — deterministic and exact, rather
// than asking the model to mentally group 1hr rows. Groups are aligned to end
// on the newest bar (any oldest partial group is dropped).
export function aggregateCandles(rows, groupSize) {
    if (!Array.isArray(rows) || rows.length === 0) return []
    const rem     = rows.length % groupSize
    const aligned = rem ? rows.slice(rem) : rows
    const out = []
    for (let i = 0; i < aligned.length; i += groupSize) {
        const grp = aligned.slice(i, i + groupSize)
        out.push({
            timestamp: grp[0].timestamp,
            open:      grp[0].open,
            high:      Math.max(...grp.map(c => c.high)),
            low:       Math.min(...grp.map(c => c.low)),
            close:     grp[grp.length - 1].close,
            volume:    grp.reduce((s, c) => s + (c.volume || 0), 0),
        })
    }
    return out
}

// Fetch → (optionally aggregate) → slice to `count` most recent bars for a timeframe.
async function _fetchCandleRows(ticker, timeframe) {
    const cfg  = CANDLE_CFG[timeframe] ?? CANDLE_CFG['day']
    const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
    const raw  = await getTickerAggregates(ticker.toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
    const bars = cfg.aggregate ? aggregateCandles(raw, cfg.aggregate) : raw
    return { cfg, bars }
}

// ─── Chart image (vision) ─────────────────────────────────────────────────────
// Renders are cached briefly by symbol+timeframe+studies — chart-img is paid /
// rate-limited and an agent may request the same view repeatedly (internal check,
// then again to show it). One cache shared across agents.
const _chartCache  = new Map()   // key -> { at, png }
const CHART_TTL_MS = 60 * 1000   // intraday views go stale fast; 60s is plenty within a chat

export async function cachedChartImage(symbol, timeframe, studies) {
    const key = `${symbol}|${timeframe}|${studies.map(s => s.name).join(',')}`
    const hit = _chartCache.get(key)
    if (hit && Date.now() - hit.at < CHART_TTL_MS) return hit.png
    const png = await fetchChartImage(symbol, timeframe, studies)
    if (_chartCache.size > 100) _chartCache.clear()
    _chartCache.set(key, { at: Date.now(), png })
    return png
}

// ─── Handler factories ────────────────────────────────────────────────────────
// Each returns a tool handler wrapped in the standard makeToolHandler try/catch so
// the model-visible failure string stays identical to what the agents returned before.

export function makeQuoteHandler(log) {
    return makeToolHandler(
        'get_quote',
        ({ ticker }) => getQuote(ticker),
        (err, { ticker }) => `Could not fetch quote for ${ticker}: ${err.message}`,
        log,
    )
}

export function makeCandlesHandler(log) {
    return makeToolHandler(
        'get_candles',
        async ({ ticker, timeframe }) => {
            const { bars, cfg } = await _fetchCandleRows(ticker, timeframe)
            const rows = bars.slice(-cfg.count)
            if (rows.length === 0) return toolError(`No candle data available for ${ticker}`)

            const header = `${ticker.toUpperCase()} ${timeframe} — ${rows.length} candles, newest last:\n`
            const lines  = rows.map(c => {
                const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
                return `${d}  O:${c.open.toFixed(2)}  H:${c.high.toFixed(2)}  L:${c.low.toFixed(2)}  C:${c.close.toFixed(2)}  V:${fmtVol(c.volume)}`
            })
            return header + lines.join('\n')
        },
        (err, { ticker }) => `Could not fetch candles for ${ticker}: ${err.message}`,
        log,
    )
}

export function makeEarningsHandler(log) {
    return makeToolHandler(
        'get_earnings',
        ({ ticker }) => getEarnings(ticker),
        (err, { ticker }) => `Could not fetch earnings for ${ticker}: ${err.message}`,
        log,
    )
}

// get_chart renders an actual TradingView chart and hands it to the LLM as an image
// for true visual TA. `onChart` (nullable) surfaces the chart to the user's chat when
// the agent flags show_to_user. `readText` is the trailing "how to read it" sentence,
// which differs per agent.
export function makeChartHandler({ log, onChart, readText }) {
    return makeToolHandler(
        'get_chart',
        async ({ ticker, timeframe, indicators = '', show_to_user = false }) => {
            const symbol  = String(ticker || '').toUpperCase()
            const studies = buildStudies(indicators || '')
            const png     = await cachedChartImage(symbol, timeframe, studies)

            if (show_to_user && typeof onChart === 'function') {
                try { onChart({ symbol, timeframe, imageBase64: png }) }
                catch (err) { logger.warn(log, 'onChart emit failed:', err.message) }
            }

            const studyNames = studies.map(s => s.name).join(', ') || 'EMA20/50'
            return [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
                { type: 'text',  text: `${symbol} ${timeframe} TradingView chart (studies: ${studyNames}). ${readText}` },
            ]
        },
        (err, { ticker }) => `Could not render chart for ${ticker}: ${err.message}. Use get_candles instead.`,
        log,
    )
}
