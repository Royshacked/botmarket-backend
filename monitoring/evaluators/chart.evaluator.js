/**
 * Chart image evaluator.
 *
 * Fetches a TradingView chart from chart-img.com for the given symbol + timeframe,
 * passes it to Claude Sonnet vision, and returns YES/NO for the condition.
 *
 * Env var required: CHART_IMG_API_KEY
 */

import { claudeVision }   from '../monitor.claude.js'
import { fetchChartImage } from '../../providers/chartImg.provider.js'
import { logger }          from '../../services/logger.service.js'

const LOG = '[chart.evaluator]'

const SYSTEM = `You are a technical chart analyst.
You are looking at a TradingView candlestick chart with indicators.
Based solely on what you see in the chart, decide if the stated condition is clearly met.
If uncertain, answer NO.
Respond with a single word only: YES or NO.`

/**
 * @param {string}      condition  e.g. "bull flag on 4h", "RSI divergence"
 * @param {string}      symbol     asset ticker e.g. 'AAPL', 'BTCUSDT'
 * @param {string|null} timeframe  e.g. '4hr', 'day'
 * @returns {Promise<boolean>}
 */
export async function evaluateChart(condition, symbol, timeframe) {
    const studies = _buildStudies(condition)

    let imageBase64
    try {
        imageBase64 = await fetchChartImage(symbol, timeframe, studies)
    } catch (err) {
        logger.error(LOG, `Chart fetch failed for ${symbol}/${timeframe}:`, err.message)
        return false
    }

    const user =
        `Chart: ${symbol} — ${timeframe}\n\n` +
        `Condition: "${condition}"\n\n` +
        `YES or NO?`

    try {
        const raw  = await claudeVision(SYSTEM, user, imageBase64)
        const pass = raw.trim().toUpperCase().startsWith('Y')
        logger.info(LOG, `Chart eval "${condition.slice(0, 60)}" (${symbol}/${timeframe}) → ${pass ? 'YES' : 'NO'}`)
        return pass
    } catch (err) {
        logger.error(LOG, 'Chart eval error:', err.message)
        return false
    }
}

// ─── Studies builder ──────────────────────────────────────────────────────────

const MAX_STUDIES = 3

function _buildStudies(condition) {
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

    // Explicit EMA periods
    for (const [, p] of condition.matchAll(/ema\((\d+)\)/gi)) {
        add({ name: 'Moving Average Exponential', input: { in_0: +p }, forceOverlay: true }, `ema${p}`)
    }

    // Explicit SMA periods
    for (const [, p] of condition.matchAll(/sma\((\d+)\)/gi)) {
        add({ name: 'Moving Average', input: { in_0: +p }, forceOverlay: true }, `sma${p}`)
    }

    // Fill remaining slots with EMA(20) / EMA(50) as price context
    add({ name: 'Moving Average Exponential', input: { in_0: 20 }, forceOverlay: true }, 'ema20')
    add({ name: 'Moving Average Exponential', input: { in_0: 50 }, forceOverlay: true }, 'ema50')

    return studies
}
