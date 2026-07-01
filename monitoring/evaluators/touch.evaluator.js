/**
 * Touch condition evaluator.
 *
 * A `touch` leaf is a pure price level that triggers the instant price TRADES at
 * the level — intra-candle, not on a candle close. On a broker it rests as a native
 * order (a closing STOP/LIMIT for exits, a stop-market for entry); this evaluator is
 * the software fallback for when a touch leaf is monitored instead (e.g. it sits in
 * an AND group with non-touch siblings, so the leg can't be offloaded whole).
 *
 * "Touch" = the level fell within a candle's range: low <= level <= high. That is
 * direction-agnostic (a touch from above and a touch from below are both touches),
 * which matches how a resting broker order fills.
 *
 * Candle format: { o, h, l, c, v, t } — array newest-last.
 *
 * Pure function — no I/O, no Claude calls.
 */

import { candleMs } from '../monitorUtils.js'

/**
 * Evaluate a touch level against a candle series.
 *
 * Unlike the structured evaluator there is no rising-edge concept: a touch IS a
 * discrete event, so the first candle at/after the floor whose range includes the
 * level fires. `floorAt` honours the "only events after activation count" rule.
 *
 * @param {ParsedCondition} parsed   from condition.parser — `value` carries the level
 * @param {Candle[]}        candles  newest-last
 * @param {number|null}     floorAt  ms timestamp; only touches at/after this count
 * @returns {{ pass: boolean, triggerAt?: number, reason?: string }}
 */
export function evaluateTouch(parsed, candles, floorAt = null) {
    if (!candles || candles.length === 0) return { pass: false, reason: 'insufficient_data' }

    const level = Number(parsed?.value)
    if (!Number.isFinite(level)) return { pass: false, reason: 'no_level' }

    for (const c of candles) {
        if (c == null || c.h == null || c.l == null) continue
        const tMs = candleMs(c.t)
        if (floorAt != null && tMs < floorAt) continue
        if (c.l <= level && level <= c.h) return { pass: true, triggerAt: tMs }
    }
    return { pass: false }
}
