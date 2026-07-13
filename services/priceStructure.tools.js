import { claudeVision } from '../monitoring/monitor.claude.js'
import { makeToolHandler } from './agentUtils.js'
import { cachedChartImage } from './chartImgCache.service.js'
import { logger } from './logger.service.js'

// Dedicated price-action structure tools: get_orderblocks and get_false_breaks.
//
// Why they exist: the build agents kept skewing to indicators (VWAP/EMA) over price-action
// patterns because indicator tools return confident NUMBERS while orderblocks / false breaks
// had to be eyeballed off a chart image — the harder, less certain read. These tools close that
// gap: each renders a PLAIN (indicator-free) candlestick chart and runs a FOCUSED vision pass
// that returns a structured, citable read, so a price-action pattern is as easy to reach for as
// an indicator value. The visual levels are approximate — the agent confirms exact prices with
// get_candles before committing them (the return text says so).

const LABEL = { orderblocks: 'order-block', false_breaks: 'false-break / liquidity-sweep' }

// Vision configs — system framing + the per-call question. Exported for testing.
export const OB_VISION = {
    system:
        'You are a professional price-action / Smart-Money-Concepts analyst reading a BARE ' +
        'candlestick chart (no indicators). An ORDER BLOCK is the last opposing candle or tight ' +
        'cluster before a strong impulsive move that breaks market structure: a BULLISH order block ' +
        'is the last down-close candle before a strong up-move; a BEARISH order block is the last ' +
        'up-close candle before a strong down-move. A block is fresh/untested until price returns ' +
        'into it. Read ONLY what the chart shows; if the structure is unclear, say so rather than ' +
        'invent blocks.',
    question: (symbol, timeframe) =>
        `Chart: ${symbol} — ${timeframe}. Identify the order blocks most relevant to the CURRENT ` +
        `price. For each, give: type (bullish/bearish), the approximate price zone (low–high), ` +
        `whether it is fresh/untested or already mitigated, its location vs current price ` +
        `(below/above), and a one-line reason it qualifies (the impulsive move it produced). List ` +
        `the 2–4 that matter most; if there is no clean order block, say so plainly. Give concrete ` +
        `price levels.`,
}

export const FB_VISION = {
    system:
        'You are a professional price-action analyst reading a BARE candlestick chart (no ' +
        'indicators). A FALSE BREAK (liquidity sweep / stop run) is when price pushes BEYOND a clear ' +
        'prior high or low, fails to hold, and CLOSES back inside the prior range — trapping ' +
        'breakout traders and often preceding a reversal. Read ONLY what the chart shows; if nothing ' +
        'clean is visible, say so rather than invent sweeps.',
    question: (symbol, timeframe) =>
        `Chart: ${symbol} — ${timeframe}. Identify the most relevant recent false breaks / ` +
        `liquidity sweeps. For each, give: the level that was swept (approximate price + what it was ` +
        `— prior-day high/low, swing high/low, range edge, round number), the direction (failed ` +
        `upside break / failed downside break), whether price reclaimed the level and closed back ` +
        `inside, roughly how recent it is, and a one-line note. List the ones that matter for the ` +
        `current setup; if there is no clean false break, say so plainly. Give concrete price levels.`,
}

// kind → vision config, so callers (agent tools, the Hermes monitor loop) can pick by name.
export const STRUCTURE_VISIONS = { orderblocks: OB_VISION, false_breaks: FB_VISION }

// Core read: render a PLAIN chart (no overlays) and run the focused vision pass. Returns the raw
// chart png (for optional surfacing) + the formatted, citable text. Shared by the agent tools and
// the Hermes assessment loop. Deps are injectable for testing (no network / no model call).
export async function readStructure({ symbol, timeframe, kind, vision, deps = {} }) {
    const {
        renderChart:  _renderChart  = cachedChartImage,   // shared 60s cache — a plain chart on the
        claudeVision: _claudeVision = claudeVision,        // same symbol+tf renders once (OB, FB, get_chart)
    } = deps

    const sym = String(symbol || '').toUpperCase()
    const png = await _renderChart(sym, timeframe, [])   // [] studies → bare candles (same cache key as a plain get_chart)
    const analysis = await _claudeVision(vision.system, vision.question(sym, timeframe), png, { maxTokens: 1024 })
    const text = `${sym} ${timeframe} — ${LABEL[kind]} read:\n${String(analysis).trim()}\n\n` +
        `(Levels are read visually off the chart and are APPROXIMATE — confirm exact prices with get_candles before committing them.)`
    return { png, text }
}

// Build a vision-backed structure handler for an agent toolset. `kind` is 'orderblocks' |
// 'false_breaks'. `onChart` (nullable) surfaces the analyzed chart to the user's chat when the
// agent flags show_to_user. Deps are injectable for testing.
export function makeStructureVisionHandler({ log, kind, vision, onChart, deps = {} }) {
    return makeToolHandler(
        `get_${kind}`,
        async ({ ticker, timeframe, show_to_user = false }) => {
            const { png, text } = await readStructure({ symbol: ticker, timeframe, kind, vision, deps })

            if (show_to_user && typeof onChart === 'function') {
                try { onChart({ symbol: String(ticker || '').toUpperCase(), timeframe, imageBase64: png }) }
                catch (err) { logger.warn(log, 'onChart emit failed:', err.message) }
            }
            return text
        },
        (err, { ticker }) => `Could not analyze ${kind.replace('_', ' ')} for ${ticker}: ${err.message}. Try get_chart / get_candles instead.`,
        log,
    )
}
