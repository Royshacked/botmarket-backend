/**
 * Indicator condition evaluator.
 *
 * Computes standard indicators from the full candle history (for warmup accuracy),
 * then asks Claude Haiku YES/NO whether the stated condition is met.
 *
 * Default periods computed every call:
 *   RSI(14)  |  EMA(20, 50)  |  SMA(20, 50, 200)  |  MACD(12,26,9)  |  ATR(14)
 *
 * Custom periods are detected from the condition text:
 *   "RSI(21) below 40"  →  also computes RSI(21) and adds it as a column.
 */

import { claudeText } from '../monitor.claude.js'
import { logger }     from '../../services/logger.service.js'
import {
    calcRSISeries,
    calcEMASeries,
    calcSMASeries,
    calcMACDSeries,
    calcATRSeries,
} from './structured.evaluator.js'

const LOG = '[indicator.evaluator]'

const SYSTEM = `You are a technical analysis engine.
You receive a table of OHLCV candles with pre-computed indicator values (oldest row first, newest last).
All indicator values are mathematically accurate — use them directly, do not recompute.
Evaluate against the last row; use multiple rows only for trend or crossover conditions.
If uncertain, answer NO.
Respond with a single word only: YES or NO.`

/**
 * @param {string}   condition  e.g. "RSI(14) below 30", "ATR expanding", "MACD turns positive"
 * @param {Candle[]} candles    full history, newest-last (300 bars for warmup accuracy)
 * @returns {Promise<boolean>}
 */
export async function evaluateIndicator(condition, candles) {
    if (!candles || candles.length < 5) {
        logger.warn(LOG, 'Not enough candles for indicator evaluation')
        return false
    }

    const indicators  = _computeIndicators(condition, candles)

    // Surface insufficient-warmup cases: a null newest value means the series
    // reads "n/a" and any condition referencing it silently evaluates NO.
    if (indicators.sma[200]?.[candles.length - 1] == null) {
        logger.warn(LOG, `SMA(200) not warmed up (${candles.length} candles) — long-period conditions may read n/a`)
    }

    const last20start = Math.max(0, candles.length - 20)
    const last20      = candles.slice(last20start)
    const table       = _buildTable(last20, indicators, last20start)

    const user =
        `Candles with pre-computed indicators (oldest first → newest last):\n${table}\n\n` +
        `Condition: "${condition}"\n\n` +
        `YES or NO?`

    try {
        const raw  = await claudeText(SYSTEM, user)
        const pass = raw.trim().toUpperCase().startsWith('Y')
        logger.info(LOG, `Indicator eval "${condition.slice(0, 60)}" → ${pass ? 'YES' : 'NO'}`)
        return pass
    } catch (err) {
        logger.error(LOG, 'Indicator eval error:', err.message)
        return false
    }
}

// ─── Indicator computation ────────────────────────────────────────────────────

function _computeIndicators(condition, candles) {
    const closes         = candles.map(c => c.c)
    const { line, signal, hist } = calcMACDSeries(closes)

    const result = {
        rsi:  { 14: calcRSISeries(closes, 14) },
        ema:  { 20: calcEMASeries(closes, 20), 50: calcEMASeries(closes, 50) },
        sma:  { 20: calcSMASeries(closes, 20), 50: calcSMASeries(closes, 50), 200: calcSMASeries(closes, 200) },
        macd: { line, signal, hist },
        atr:  { 14: calcATRSeries(candles, 14) },
    }

    // Add any custom periods explicitly mentioned in the condition text
    for (const [, p] of condition.matchAll(/rsi\((\d+)\)/gi)) {
        const period = +p
        if (!result.rsi[period]) result.rsi[period] = calcRSISeries(closes, period)
    }
    for (const [, p] of condition.matchAll(/ema\((\d+)\)/gi)) {
        const period = +p
        if (!result.ema[period]) result.ema[period] = calcEMASeries(closes, period)
    }
    for (const [, p] of condition.matchAll(/sma\((\d+)\)/gi)) {
        const period = +p
        if (!result.sma[period]) result.sma[period] = calcSMASeries(closes, period)
    }
    for (const [, p] of condition.matchAll(/atr\((\d+)\)/gi)) {
        const period = +p
        if (!result.atr[period]) result.atr[period] = calcATRSeries(candles, period)
    }

    return result
}

// ─── Table builder ────────────────────────────────────────────────────────────

function _buildTable(candles, ind, offset) {
    const rsiPeriods = Object.keys(ind.rsi).map(Number).sort((a, b) => a - b)
    const emaPeriods = Object.keys(ind.ema).map(Number).sort((a, b) => a - b)
    const smaPeriods = Object.keys(ind.sma).map(Number).sort((a, b) => a - b)
    const atrPeriods = Object.keys(ind.atr).map(Number).sort((a, b) => a - b)

    const headers = [
        'Row',
        'Close',
        ...rsiPeriods.map(p => `RSI(${p})`),
        ...emaPeriods.map(p => `EMA(${p})`),
        ...smaPeriods.map(p => `SMA(${p})`),
        'MACD',
        'MACD_hist',
        ...atrPeriods.map(p => `ATR(${p})`),
    ]

    const headerRow = headers.join(' | ')
    const sepRow    = headers.map(h => '-'.repeat(h.length)).join('-+-')

    const rows = candles.map((c, i) => {
        const idx = offset + i
        return [
            String(i + 1).padStart(3),
            _n(c.c),
            ...rsiPeriods.map(p => _pct(ind.rsi[p][idx])),
            ...emaPeriods.map(p => _n(ind.ema[p][idx])),
            ...smaPeriods.map(p => _n(ind.sma[p][idx])),
            _n(ind.macd.line[idx]),
            _n(ind.macd.hist[idx]),
            ...atrPeriods.map(p => _n(ind.atr[p][idx])),
        ].join(' | ')
    })

    return [headerRow, sepRow, ...rows].join('\n')
}

function _n(v)   { return v == null ? '       n/a' : v.toFixed(4).padStart(10) }
function _pct(v) { return v == null ? '    n/a' : v.toFixed(2).padStart(7) }
