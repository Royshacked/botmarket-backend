/**
 * Chart image evaluator.
 *
 * Fetches a TradingView chart from chart-img.com for the given symbol + timeframe,
 * passes it to Claude Sonnet vision, and returns YES/NO for the condition.
 *
 * Env var required: CHART_IMG_API_KEY
 */

import { claudeVision }    from '../monitor.claude.js'
import { cachedChartImage } from '../../services/chartImgCache.service.js'
import { logger }          from '../../services/logger.service.js'
import { parseYesNo }      from '../monitorUtils.js'
import { parseIndicators } from '../parsers/indicators.parser.js'

const LOG = '[chart.evaluator]'

const SYSTEM = `You are a technical chart analyst.
You are looking at a TradingView candlestick chart with indicators.
Based solely on what you see in the chart, decide if the stated condition is clearly met.
If uncertain, answer NO.
Respond with a single word only: YES or NO.`

/**
 * @param {string}      condition      e.g. "bull flag on 4h", "cup and handle"
 * @param {string}      symbol         asset ticker e.g. 'AAPL', 'BTCUSDT'
 * @param {string|null} timeframe      e.g. '4hr', 'day'
 * @param {number|null} floorAt        ms timestamp; only patterns formed at/after this count (entry: entryFloorAt ?? savedAt)
 * @param {string[]}    priorFindings  structured conditions that already passed in the same AND gate
 * @returns {Promise<boolean>}
 */
export async function evaluateChart(condition, symbol, timeframe, floorAt = null, priorFindings = []) {
    // Plain chart: draw ONLY the indicators this condition explicitly names. A chart-pattern
    // condition (false break, orderblock, flag) reads best on bare candles.
    const studies = _buildStudies(condition, { fillDefaults: false })

    let imageBase64
    try {
        imageBase64 = await cachedChartImage(symbol, timeframe, studies)
    } catch (err) {
        logger.error(LOG, `Chart fetch failed for ${symbol}/${timeframe}:`, err.message)
        return false
    }

    // Time constraint: only patterns that formed at/after the detection floor
    let timeConstraint = ''
    if (floorAt && timeframe) {
        const tfMs = _timeframeMs(timeframe)
        if (tfMs) {
            const candlesSince = Math.max(1, Math.ceil((Date.now() - floorAt) / tfMs))
            timeConstraint = `\nTime constraint: Only consider patterns that completed within the last ${candlesSince} candle(s). Ignore any patterns that completed before this window.`
        }
    }

    // Context from prior structured conditions in the same AND gate
    let contextHint = ''
    if (priorFindings.length > 0) {
        contextHint = `\nContext: the following condition(s) just triggered — "${priorFindings.join('", "')}". Look for the chart pattern that SET UP or LED TO this condition, not just any pattern in history.`
    }

    const user =
        `Chart: ${symbol} — ${timeframe}\n\n` +
        `Condition: "${condition}"${timeConstraint}${contextHint}\n\n` +
        `YES or NO?`

    try {
        const raw  = await claudeVision(SYSTEM, user, imageBase64)
        const pass = parseYesNo(raw)
        logger.info(LOG, `Chart eval "${condition.slice(0, 60)}" (${symbol}/${timeframe}) → ${pass ? 'YES' : 'NO'}`)
        return pass
    } catch (err) {
        logger.error(LOG, 'Chart eval error:', err.message)
        return false
    }
}

function _timeframeMs(tf) {
    const min = tf.match(/^(\d+)min$/)
    if (min)  return parseInt(min[1]) * 60 * 1000
    const hr  = tf.match(/^(\d+)hr$/)
    if (hr)   return parseInt(hr[1]) * 60 * 60 * 1000
    if (tf === 'day')  return 24 * 60 * 60 * 1000
    if (tf === 'week') return 7 * 24 * 60 * 60 * 1000
    return null
}

// ─── Studies builder ──────────────────────────────────────────────────────────

const MAX_STUDIES = 3

// `fillDefaults` (default true) tops the chart off with EMA20/50 as generic price context when
// the caller named no overlays of its own. Pass `{ fillDefaults: false }` for a PLAIN chart — only
// the indicators the condition/agent explicitly references get drawn. Price-action reads (patterns,
// orderblocks, false breaks) want bare candles so the read isn't primed toward moving averages.
function _buildStudies(condition, { fillDefaults = true } = {}) {
    const studies = []
    const added   = new Set()

    const add = (study, key) => {
        if (!added.has(key) && studies.length < MAX_STUDIES) {
            studies.push(study)
            added.add(key)
        }
    }

    // Condition-specific indicators first (they matter most for the eval)

    // RSI
    const rsiMatch = condition.match(/rsi(?:\((\d+)\))?/i)
    if (rsiMatch) {
        add({ name: 'Relative Strength Index', input: { in_0: +(rsiMatch[1] ?? 14) } }, `rsi${rsiMatch[1] ?? 14}`)
    }

    // MACD
    if (/macd/i.test(condition)) {
        add({ name: 'MACD', input: { in_0: 12, in_1: 26, in_2: 9 } }, 'macd')
    }

    // Bollinger Bands
    if (/\bbb\b|bollinger/i.test(condition)) {
        add({ name: 'Bollinger Bands', input: { in_0: 20, in_1: 2 }, forceOverlay: true }, 'bb')
    }

    // ATR
    const atrMatch = condition.match(/atr(?:\((\d+)\))?/i)
    if (atrMatch) {
        add({ name: 'Average True Range', input: { in_0: +(atrMatch[1] ?? 14) } }, `atr${atrMatch[1] ?? 14}`)
    }

    // Volume
    if (/volume/i.test(condition)) {
        add({ name: 'Volume' }, 'volume')
    }

    // VWAP (session-anchored price overlay)
    if (/vwap/i.test(condition)) {
        add({ name: 'VWAP', forceOverlay: true }, 'vwap')
    }

    // Explicit EMA / SMA periods (family(N) grammar, via the shared parser — same
    // matches as the previous ema-then-sma matchAll loops, in the same order).
    for (const { family, period } of parseIndicators(condition)) {
        if (family === 'ema') add({ name: 'Moving Average Exponential', input: { in_0: period }, forceOverlay: true }, `ema${period}`)
    }
    for (const { family, period } of parseIndicators(condition)) {
        if (family === 'sma') add({ name: 'Moving Average', input: { in_0: period }, forceOverlay: true }, `sma${period}`)
    }

    // Fill remaining slots with EMA(20) / EMA(50) as generic price context — only when the caller
    // didn't ask for a plain chart. A price-action read renders bare candles so the model looks at
    // structure (orderblocks, sweeps, false breaks) instead of narrating moving averages.
    if (fillDefaults) {
        add({ name: 'Moving Average Exponential', input: { in_0: 20 }, forceOverlay: true }, 'ema20')
        add({ name: 'Moving Average Exponential', input: { in_0: 50 }, forceOverlay: true }, 'ema50')
    }

    return studies
}

// Exposed so the idea agent's get_chart tool can build the same indicator overlays
// from a free-text indicator list. Pure function — no behaviour change here.
export { _buildStudies as buildStudies }
