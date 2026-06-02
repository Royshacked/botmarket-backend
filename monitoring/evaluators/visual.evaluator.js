/**
 * Visual condition evaluator.
 *
 * MVP: Describes the last ~20 candles as an OHLCV table and asks Claude (Haiku)
 * YES/NO whether the named chart pattern or visual condition is present.
 *
 * Upgrade path: swap _describeCandles() for a real chart screenshot fed to a
 * vision model — the rest of the code stays identical.
 */

import { claudeText } from '../monitor.claude.js'
import { logger }     from '../../services/logger.service.js'

const LOG = '[visual.evaluator]'

const SYSTEM = `You are a technical chart analyst.
You receive a table of OHLCV candles (oldest row first, newest last) and a visual condition to evaluate.
Based solely on the price action data in the table, decide if the condition is clearly met.
If uncertain, answer NO.
Respond with a single word only: YES or NO.`

/**
 * Evaluate a visual/pattern condition against recent candle data.
 *
 * @param {string}   condition  e.g. "bullish engulfing on the last two candles"
 * @param {Candle[]} candles    newest-last
 * @returns {Promise<boolean>}
 */
export async function evaluateVisual(condition, candles) {
    if (!candles || candles.length < 3) {
        logger.warn(LOG, 'Not enough candles for visual evaluation')
        return false
    }

    const last20 = candles.slice(-20)
    const table  = _candleTable(last20)
    const user   =
        `Candles (OHLCV, oldest first → newest last):\n${table}\n\n` +
        `Condition: "${condition}"\n\n` +
        `YES or NO?`

    try {
        const raw  = await claudeText(SYSTEM, user)
        const pass = raw.trim().toUpperCase().startsWith('Y')
        logger.info(LOG, `Visual eval "${condition.slice(0, 60)}" → ${pass ? 'YES' : 'NO'}`)
        return pass
    } catch (err) {
        logger.error(LOG, 'Visual eval error:', err.message)
        return false
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _candleTable(candles) {
    const header = 'Row | Open       | High       | Low        | Close      | Volume'
    const sep    = '----+------------+------------+------------+------------+-----------'
    const rows   = candles.map((c, i) =>
        `${String(i + 1).padStart(3)} | ${_n(c.o)} | ${_n(c.h)} | ${_n(c.l)} | ${_n(c.c)} | ${_vol(c.v)}`
    )
    return [header, sep, ...rows].join('\n')
}

function _n(v) {
    return (v == null ? '       n/a' : v.toFixed(4).padStart(10))
}

function _vol(v) {
    if (v == null) return '        n/a'
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`.padStart(11)
    if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`.padStart(11)
    return String(Math.round(v)).padStart(11)
}
