// WHICH RULE, WHEN — test L (Roy, 2026-10-27: "different rules work at different times … find the rules that set which
// rules will work"). Each lab rule as a BOOK: its trades held to their own exits, its day the mean over the positions
// open that day — so rules with different holds become comparable daily (and monthly) series a switcher can choose
// between. Declared in screener-lab.md §29.
//
// Pure: the lab's data in (screenerLab.data), no IO.

import { HYPOTHESES, runHypothesis, costFor } from './screenerLab.service.js'

/** The library: lab rule → the tags kept (null = every tag). The run-up without its market filter — the switcher times it. */
export const LIBRARY = Object.freeze({
    runup_5: ['3 of 3 beat'], beat_day2: null, beat_held: null, reversal_1w: null, rsi2_uptrend: null, gapdown_held: null,
    swing_low: null, range_low: null, pullback_50: null, falsebreak_10: null, wyckoff_spring: null, sector_laggard: null,
    first_52w_high_20: null, insider_cluster_20: null,
})

/**
 * Trades → the rule's book by day: Map(day → { sum, n }) — each open position's excess over SPY that day in % (the
 * entry day open → close, after it close → close), the trade's cost taken on its entry day. Pure.
 */
export function dailyBook(trades, data) {
    const spyAt = data._spyAt ??= new Map(data.spyDays.map((d, k) => [d, k]))
    const book = new Map()
    for (const t of trades) {
        const s = data.names.get(t.symbol)
        const at = s._at ??= new Map(s.ind.date.map((d, k) => [d, k]))
        const i = at.get(t.day), j = at.get(t.exit_day)
        if (i == null || j == null || j < i) continue
        for (let k = i; k <= j; k++) {
            const d = s.ind.date[k], q = spyAt.get(d)
            const spy = data.spyByDay.get(d), spy0 = q > 0 ? data.spyByDay.get(data.spyDays[q - 1]) : null
            const name = k === i ? s.rows[k].close / s.rows[k].open - 1 : s.rows[k].close / s.rows[k - 1].close - 1
            const mkt = k === i ? (spy?.open > 0 ? spy.close / spy.open - 1 : null) : (spy0?.close > 0 ? spy.close / spy0.close - 1 : null)
            if (mkt == null || !Number.isFinite(name)) continue
            const x = (name - mkt) * 100 - (k === i ? costFor(s.ind.adv20[i - 1] ?? 0) : 0)
            const b = book.get(d) ?? { sum: 0, n: 0 }
            b.sum += x; b.n++
            book.set(d, b)
        }
    }
    return book
}

/**
 * Every rule in `library` over `days` → { rule: { trades, book } }. `keep(trade)` — a point-in-time universe (§30):
 * only the trades entered while the name was in it. Pure.
 */
export function libraryBooks(data, days, library = LIBRARY, { keep = null } = {}) {
    const out = {}
    for (const [rule, tags] of Object.entries(library)) {
        const trades = runHypothesis(HYPOTHESES[rule], data, { days }).filter(t => (!tags || tags.includes(t.tag)) && (!keep || keep(t)))
        out[rule] = { trades: trades.length, book: dailyBook(trades, data) }
    }
    return out
}
