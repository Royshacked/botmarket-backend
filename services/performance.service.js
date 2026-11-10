/**
 * "How have I actually done?" — the closed-trade record.
 *
 *   • realized — the `trades` collection, the canonical analytics store (frozen at fill,
 *     pnl = exit.realizedPnl). Covers every mode and origin.
 *
 * ── THE UNIT TRAP, killed here ────────────────────────────────────────────────
 * computeTradeStats returns win rate as a FRACTION 0–1 (`wins / count`). Handed to a model
 * unchanged, 0.62 is reported to the user as "0.62%". The conversion happens once, here at the
 * boundary, and the field is renamed `winRatePct` so a fraction can never silently be read as a
 * percentage again. Percent-suffixed names are the contract; anything without the suffix is raw.
 *
 * ── WHERE THE EQUITY CURVE JOINS ──────────────────────────────────────────────
 * This module answers as of NOW: one `{ asOf, … }` object. When account value over time starts
 * being recorded, the series is an ARRAY OF THAT SAME OBJECT — `[{asOf,…},{asOf,…}]` — and a chart
 * plots it with no reshaping. Nothing is stubbed for it here; there is no empty `equity` or
 * `series` field to mislead a reader. Add the reader beside this one when the data exists.
 */

import { tradeCaptureService } from './tradeCapture.service.js'

/** A fraction 0–1 → a percentage, 2dp. Null stays null: "no trades yet" is not "0%". */
export function toPct(fraction) {
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null
    return Math.round(fraction * 10000) / 100
}

/**
 * Restate one computeTradeStats summary in percent-suffixed terms.
 * `winRate` is dropped rather than kept alongside — two names for one number is how the wrong one
 * gets read.
 */
export function toSummaryPct(summary) {
    if (!summary || typeof summary !== 'object') return null
    const { winRate, ...rest } = summary
    return { ...rest, winRatePct: toPct(winRate) }
}

function _mapValues(obj, fn) {
    if (!obj || typeof obj !== 'object') return {}
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]))
}

/**
 * @param {string} userId
 * @param {object} [opts]  mode 'paper'|'live'|'manual', symbol, from/to (ms epoch)
 * @returns {Promise<{ asOf:number, realized:object|null, unavailable:string[] }>}
 */
export async function getPerformance(userId, { mode = null, symbol = null, from = null, to = null } = {}, deps = {}) {
    const {
        stats = (uid, f) => tradeCaptureService.tradeStats(uid, f),
        now = Date.now(),
    } = deps

    if (!userId) return { asOf: now, realized: null, unavailable: [] }

    const filter = {}
    if (mode) filter.mode = mode
    if (symbol) filter.symbol = symbol
    if (from != null) filter.fromMs = from
    if (to != null) filter.toMs = to

    // Settled rather than awaited: a failed source is NAMED in `unavailable` rather than reported
    // as zero, because "no trades" and "could not look" are different answers and only one of
    // them is safe to say out loud.
    const [realizedRes] = await Promise.allSettled([stats(userId, filter)])

    const unavailable = []
    let realized = null
    if (realizedRes.status === 'fulfilled') {
        const s = realizedRes.value ?? {}
        realized = {
            overall: toSummaryPct(s.overall),
            byMode: _mapValues(s.byMode, toSummaryPct),
            byOrigin: _mapValues(s.byOrigin, toSummaryPct),
            bySymbol: _mapValues(s.bySymbol, toSummaryPct),
        }
    } else {
        unavailable.push('realized')
    }

    // `filter` rides along so a caller (and the model) can state what the numbers cover — a win
    // rate with an unstated window is a number nobody can check.
    return { asOf: now, filter: { mode, symbol, from, to }, realized, unavailable }
}
