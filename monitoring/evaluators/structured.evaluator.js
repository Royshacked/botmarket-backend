/**
 * Pure-function structured evaluator.
 * Takes candles + a ParsedCondition → { pass: boolean, reason?: string }
 * No I/O, no Claude calls — pure math.
 *
 * Candle format: { o, h, l, c, v, t }  — array newest-last.
 */

import { candleMs } from '../monitorUtils.js'

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a parsed condition against a candle series.
 *
 * Two modes:
 *   • floorAt == null  → legacy snapshot: is the condition met on the latest bar(s)?
 *   • floorAt is ms    → windowed rising-edge: did the condition *transition* into
 *                        true on a candle whose timestamp is ≥ floorAt? Honours the
 *                        "only events after createdAt count" rule and reports the
 *                        triggering candle's timestamp so the caller can tell whether
 *                        it fired before or after the idea was activated.
 *
 * @param {ParsedCondition} parsed
 * @param {Candle[]}        candles  newest-last
 * @param {number|null}     floorAt  ms timestamp; only events at/after this count
 * @param {number|null}     anchorMs session-start ms — anchors session-relative
 *                                   subjects (vwap). null falls back to UTC-day open.
 * @param {object}          opts     { stateLevel, requireHeld }
 *   • stateLevel  — snapshot mode only (floorAt null): evaluate a cross operator as
 *     its underlying LEVEL (crossAbove → gt, crossBelow → lt), i.e. "is price on the
 *     trigger side right now?" rather than "did it just cross?". Used by the pre-flight.
 *   • requireHeld — windowed mode only (floorAt set): a fresh edge since the floor is
 *     necessary but NOT sufficient — the level must ALSO still hold on the latest
 *     candle. Stops a breakout that has since reverted from staying latched true (e.g.
 *     an AND leg that fired yesterday while price is back below the level today). Used
 *     on the entry path.
 * @returns {{ pass: boolean, triggerAt?: number, reason?: string }}
 */
export function evaluate(parsed, candles, floorAt = null, anchorMs = null, opts = {}) {
    if (!candles || candles.length < 2) return { pass: false, reason: 'insufficient_data' }

    const { operator, subject } = parsed
    if (operator === 'unknown' || subject === null) {
        return { pass: false, reason: 'unparseable' }
    }

    if (floorAt != null) {
        const edge = _evaluateWindow(parsed, candles, floorAt, anchorMs)
        if (!edge.pass || !opts.requireHeld) return edge
        // Edge fired since the floor — also require the level to currently hold, so a
        // reverted breakout doesn't keep the leg true. The held check is the snapshot
        // level test (a cross collapses to its threshold).
        const held = evaluate(parsed, candles, null, anchorMs, { stateLevel: true })
        return held.pass ? edge : { pass: false, reason: 'level_not_held' }
    }

    // Snapshot mode. In stateLevel mode a cross collapses to its level test so a
    // condition that already holds (but isn't a fresh cross) reads as satisfied.
    const p = opts.stateLevel && (operator === 'crossAbove' || operator === 'crossBelow')
        ? { ...parsed, operator: operator === 'crossAbove' ? 'gt' : 'lt' }
        : parsed
    return _evaluateLatest(p, candles, anchorMs)
}

// ─── Legacy snapshot evaluation (latest bar / confirmation window) ──────────────

function _evaluateLatest(parsed, candles, anchorMs = null) {
    const { operator, subject, value, value2, confirmation } = parsed

    const subSeries = getSubjectSeries(subject, candles, anchorMs)
    if (!subSeries || subSeries.length < 2) return { pass: false, reason: 'series_too_short' }

    // For comparisons against another indicator
    const valSeries = typeof value === 'string' ? getSubjectSeries(value, candles, anchorMs) : null

    const confs     = Math.max(0, confirmation ?? 0)
    const checkLen  = confs === 0 ? 1 : confs

    if (checkLen > subSeries.length) return { pass: false, reason: 'not_enough_bars' }

    let pass = false

    if (operator === 'crossAbove') {
        // prev[subject] <= prev[value]  AND  curr[subject] > curr[value]
        const len     = subSeries.length
        const prev    = subSeries[len - 2]
        const curr    = subSeries[len - 1]
        const prevVal = valSeries ? valSeries[len - 2] : Number(value)
        const currVal = valSeries ? valSeries[len - 1] : Number(value)
        pass = prev !== null && curr !== null
            && prevVal !== null && currVal !== null
            && prev <= prevVal && curr > currVal

    } else if (operator === 'crossBelow') {
        const len     = subSeries.length
        const prev    = subSeries[len - 2]
        const curr    = subSeries[len - 1]
        const prevVal = valSeries ? valSeries[len - 2] : Number(value)
        const currVal = valSeries ? valSeries[len - 1] : Number(value)
        pass = prev !== null && curr !== null
            && prevVal !== null && currVal !== null
            && prev >= prevVal && curr < currVal

    } else if (operator === 'isBetween') {
        const lo = Number(value)
        const hi = Number(value2)
        const slice = subSeries.slice(-checkLen)
        pass = slice.every(v => v !== null && v > lo && v < hi)

    } else {
        // gt | lt | gte | lte | eq
        const subSlice = subSeries.slice(-checkLen)
        const valSlice = valSeries
            ? valSeries.slice(-checkLen)
            : new Array(checkLen).fill(Number(value))
        pass = subSlice.every((v, i) =>
            v !== null && valSlice[i] !== null && _compare(operator, v, valSlice[i])
        )
    }

    return { pass }
}

// ─── Windowed rising-edge evaluation (events at/after a floor) ──────────────────

/**
 * Find the first candle at/after `floorAt` where the condition *becomes* true.
 *
 * A condition already satisfied before the floor (and continuously since) does NOT
 * fire — only a fresh transition into true after the floor does. Cross operators are
 * inherently edges; threshold/range operators use a rising edge (prev bar not yet
 * satisfied) so a level that was already breached before createdAt is ignored.
 *
 * @returns {{ pass: boolean, triggerAt?: number }}
 */
function _evaluateWindow(parsed, candles, floorAt, anchorMs = null) {
    const { operator, subject, value, value2, confirmation } = parsed

    const subSeries = getSubjectSeries(subject, candles, anchorMs)
    if (!subSeries || subSeries.length < 2) return { pass: false }
    const valSeries = typeof value === 'string' ? getSubjectSeries(value, candles, anchorMs) : null

    const n        = candles.length
    const isCross  = operator === 'crossAbove' || operator === 'crossBelow'
    const need     = Math.max(1, confirmation ?? 0)   // consecutive bars that must hold

    // satisfied[i] — does the condition hold *as completed at* bar i?
    const satisfied = new Array(n).fill(false)

    if (isCross) {
        for (let i = 1; i < n; i++) {
            const prev = subSeries[i - 1], curr = subSeries[i]
            const prevVal = valSeries ? valSeries[i - 1] : Number(value)
            const currVal = valSeries ? valSeries[i]     : Number(value)
            if (prev == null || curr == null || prevVal == null || currVal == null) continue
            satisfied[i] = operator === 'crossAbove'
                ? (prev <= prevVal && curr >  currVal)
                : (prev >= prevVal && curr <  currVal)
        }
    } else {
        // Per-bar truth of the comparison, then fold in the confirmation window.
        const raw = new Array(n).fill(false)
        for (let i = 0; i < n; i++) {
            const v = subSeries[i]
            if (v == null) continue
            if (operator === 'isBetween') {
                raw[i] = v > Number(value) && v < Number(value2)
            } else {
                const cmp = valSeries ? valSeries[i] : Number(value)
                raw[i] = cmp != null && _compare(operator, v, cmp)
            }
        }
        for (let i = need - 1; i < n; i++) {
            let all = true
            for (let j = i - need + 1; j <= i; j++) if (!raw[j]) { all = false; break }
            satisfied[i] = all
        }
    }

    // First rising edge at/after the floor wins. For cross operators every satisfied
    // bar is already an edge; for the rest require the prior bar to be unsatisfied so
    // a level breached before the floor (and still held) doesn't re-fire.
    // triggerAt is normalised to ms so callers can compare it to ms epochs.
    for (let i = 0; i < n; i++) {
        if (!satisfied[i]) continue
        const tMs = candleMs(candles[i].t)
        if (tMs < floorAt) continue
        if (!isCross && i > 0 && satisfied[i - 1]) continue
        return { pass: true, triggerAt: tMs }
    }
    return { pass: false }
}

// ─── Subject series resolution ─────────────────────────────────────────────────

/**
 * Build a value-series for a subject string across the candle array.
 *
 * @param {string}        subject  e.g. 'close', 'rsi(14)', 'ema(20)', 'vwap'
 * @param {Candle[]}      candles  newest-last
 * @param {number|null}   anchorMs session-start ms for session-relative subjects (vwap)
 * @returns {(number|null)[] | null}
 */
export function getSubjectSeries(subject, candles, anchorMs = null) {
    if (!subject || !candles.length) return null
    const s = subject.toLowerCase()

    if (s === 'close')  return candles.map(c => c.c)
    if (s === 'open')   return candles.map(c => c.o)
    if (s === 'high')   return candles.map(c => c.h)
    if (s === 'low')    return candles.map(c => c.l)
    if (s === 'volume') return candles.map(c => c.v)
    if (s === 'vwap')   return calcVWAPSeries(candles, anchorMs)

    const rsiM = s.match(/^rsi\((\d+)\)$/)
    if (rsiM) return calcRSISeries(candles.map(c => c.c), +rsiM[1])

    const emaM = s.match(/^ema\((\d+)\)$/)
    if (emaM) return calcEMASeries(candles.map(c => c.c), +emaM[1])

    const smaM = s.match(/^sma\((\d+)\)$/)
    if (smaM) return calcSMASeries(candles.map(c => c.c), +smaM[1])

    const atrM = s.match(/^atr\((\d+)\)$/)
    if (atrM) return calcATRSeries(candles, +atrM[1])

    if (s === 'macd_line' || s === 'macd_signal' || s === 'macd_hist') {
        const { line, signal, hist } = calcMACDSeries(candles.map(c => c.c))
        if (s === 'macd_line')   return line
        if (s === 'macd_signal') return signal
        return hist
    }

    return null
}

// ─── Indicator math ────────────────────────────────────────────────────────────

export function calcSMASeries(closes, period) {
    const out = new Array(closes.length).fill(null)
    for (let i = period - 1; i < closes.length; i++) {
        let sum = 0
        for (let j = i - period + 1; j <= i; j++) sum += closes[j]
        out[i] = sum / period
    }
    return out
}

export function calcEMASeries(closes, period) {
    if (closes.length < period) return new Array(closes.length).fill(null)
    const out = new Array(closes.length).fill(null)
    const k   = 2 / (period + 1)

    // Seed with SMA of the first `period` values
    let ema = 0
    for (let i = 0; i < period; i++) ema += closes[i]
    ema /= period
    out[period - 1] = ema

    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k)
        out[i] = ema
    }
    return out
}

export function calcRSISeries(closes, period = 14) {
    const out = new Array(closes.length).fill(null)
    if (closes.length < period + 1) return out

    // Seed avg gain/loss from the first `period` price changes
    let avgGain = 0, avgLoss = 0
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1]
        if (diff > 0) avgGain += diff
        else          avgLoss -= diff
    }
    avgGain /= period
    avgLoss /= period

    out[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10))

    // Wilder smoothing for subsequent values
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1]
        const g    = diff > 0 ? diff : 0
        const l    = diff < 0 ? -diff : 0
        avgGain    = (avgGain * (period - 1) + g) / period
        avgLoss    = (avgLoss * (period - 1) + l) / period
        out[i]     = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10))
    }
    return out
}

export function calcMACDSeries(closes, fast = 12, slow = 26, signalPeriod = 9) {
    const emaFast = calcEMASeries(closes, fast)
    const emaSlow = calcEMASeries(closes, slow)

    const line = closes.map((_, i) =>
        emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
    )

    // Build signal EMA from the non-null portion of the MACD line
    const startIdx  = line.findIndex(v => v !== null)
    const lineVals  = line.slice(startIdx).map(v => v ?? 0)
    const sigVals   = calcEMASeries(lineVals, signalPeriod)

    const signal = new Array(closes.length).fill(null)
    sigVals.forEach((v, i) => { signal[startIdx + i] = v })

    const hist = closes.map((_, i) =>
        line[i] !== null && signal[i] !== null ? line[i] - signal[i] : null
    )

    return { line, signal, hist }
}

export function calcATRSeries(candles, period = 14) {
    const out = new Array(candles.length).fill(null)
    if (candles.length < period + 1) return out

    // True Range for each bar
    const trs = candles.map((c, i) => {
        if (i === 0) return c.h - c.l
        const prev = candles[i - 1].c
        return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev))
    })

    // Seed with simple average of first `period` TRs
    let atr = 0
    for (let i = 0; i < period; i++) atr += trs[i]
    atr /= period
    out[period - 1] = atr

    // Wilder smoothing
    for (let i = period; i < candles.length; i++) {
        atr    = (atr * (period - 1) + trs[i]) / period
        out[i] = atr
    }
    return out
}

/**
 * Session-anchored VWAP series.
 *
 * VWAP = Σ(typicalPrice·volume) / Σ(volume), accumulated from the session open and
 * RESET each session — that intraday reset is the whole point of VWAP, so it's a
 * meaningful subject only on intraday timeframes. Bars before the anchor read null
 * (no VWAP defined for them in the current session); a zero-volume bar contributes
 * nothing and carries the prior running value forward (typical price if it's first).
 *
 * @param {Candle[]}    candles   newest-last
 * @param {number|null} anchorMs  session-start ms. When absent (e.g. the legacy flat
 *                                eval path), fall back to UTC-midnight of the newest
 *                                bar so VWAP still computes — correct for 24h assets,
 *                                approximate for equities (includes pre-market).
 * @returns {(number|null)[]}
 */
export function calcVWAPSeries(candles, anchorMs = null) {
    const out = new Array(candles.length).fill(null)
    if (!candles.length) return out

    // Guard null/undefined explicitly — Number(null) is 0 (finite), which would
    // anchor at the epoch and accumulate across the whole window instead of a session.
    let anchor = anchorMs == null ? NaN : Number(anchorMs)
    if (!Number.isFinite(anchor)) {
        const lastMs = candleMs(candles[candles.length - 1].t)
        anchor = lastMs - (lastMs % 86_400_000)   // start of the newest bar's UTC day
    }

    let cumPV = 0, cumV = 0
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i]
        if (candleMs(c.t) < anchor) continue           // pre-session bar — no VWAP
        const tp  = (c.h + c.l + c.c) / 3
        const vol = Number(c.v) || 0
        cumPV += tp * vol
        cumV  += vol
        out[i] = cumV > 0 ? cumPV / cumV : tp          // all-zero-volume → typical price
    }
    return out
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _compare(operator, a, b) {
    switch (operator) {
        case 'gt':  return a >  b
        case 'lt':  return a <  b
        case 'gte': return a >= b
        case 'lte': return a <= b
        case 'eq':  return Math.abs(a - b) < 1e-9
        default:    return false
    }
}
