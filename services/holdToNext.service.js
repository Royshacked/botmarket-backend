// GOOD EARNINGS, HELD TO THE NEXT EARNINGS — test N (Roy, 2026-11-07: "good earnings - hold until next earnings"). Declared
// in screener-lab.md §32, before the run. Bought at the open of the second session after the report (the result and the
// reaction both known), sold at the close of the session before the next report; net of SPY and the cost.
//
// Holds overlap and differ in length (about a quarter each), so one trade's mean says little. The verdict is read off a
// DAILY BOOK: every open trade equal weight, each session counted once, summed in 21-session blocks.
//
// A name whose bars END before the next report (bought out, delisted) is sold at its last close and stays counted: dropping
// them is the survivors' flattery §30 measured. Pure: the lab's data in (screenerLab.data with the `history` extra), no IO.

import { testable, costFor } from './screenerLab.service.js'
import { reactionAt, surprisePct, surpriseBand } from './reportReaction.service.js'

/** The next report comes this many sessions after: nearer is a duplicate, further a report missing from the calendar. */
export const NEXT_GAP = Object.freeze([40, 110])
/** The sessions before the next report that the run-up trades (screener-lab.md §6), split out of the hold. */
export const RUN_UP = 5

const _pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)

/** Did the revenue beat its estimate? null when either is unknown. Pure. */
export function revenueBeat(rep) {
    const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
    return rep?.revenueActual != null && rep?.revenueEstimated != null && a > 0 && e > 0 ? a > e : null
}

/** "Good earnings", the declared primary: EPS over +2% of its estimate (surpriseBand's line) AND revenue over its estimate. Pure. */
export const isGoodReport = (surprise, revBeat) => surprise != null && surprise > 2 && revBeat === true

/**
 * Every report with an actual from `from` to `to` → one trade held to the next report:
 * `{ symbol, i, x, day, exit_day, held, ended, surprise, band, rev_beat, good, reacted, cost, ret, spy, net, body, last }`.
 * `body` the excess to the close before the run-up window, `last` the excess of that window: null on a name that ended.
 * `member(symbol, day)` the universe on the entry day. Also returns what was left out, by reason. Pure.
 */
export function holdTrades(data, { from, to, member = null, gap = NEXT_GAP } = {}) {
    const trades = []
    const out = { no_entry: 0, not_testable: 0, not_member: 0, no_next: 0, gap: 0, no_spy: 0 }
    const lastDay = data.spyDays.at(-1)
    for (const [symbol, s] of data.names) {
        const at = new Map(s.ind.date.map((d, n) => [d, n]))
        const days = [...s.reports.keys()].sort()
        days.forEach((day, n) => {
            if ((from && day < from) || (to && day > to)) return
            const rep = s.reports.get(day), k = at.get(day)
            if (k == null || k < 61) return
            const surprise = surprisePct(rep), band = surpriseBand(surprise), reaction = reactionAt(s, k, data)
            if (!band || reaction == null) return
            const i = k + 2
            if (!(s.rows[i]?.open > 0)) { out.no_entry++; return }
            if (member && !member(symbol, s.ind.date[i])) { out.not_member++; return }
            if (!testable(s.rows, i, s.ind)) { out.not_testable++; return }

            // The next report on the calendar, on the first bar at or after its date.
            const nextDay = days[n + 1]
            let kn = nextDay ? s.ind.date.findIndex(d => d >= nextDay) : -1
            const ended = s.ind.date.at(-1) < lastDay
            let x
            if (kn >= 0) {
                if (kn - k < gap[0] || kn - k > gap[1]) { out.gap++; return }
                x = kn - 1
            } else if (ended && s.rows.length - 1 - k <= gap[1]) {
                // Its bars stop before another report: sold at the last close.
                x = s.rows.length - 1
                kn = null
            } else { out.no_next++; return }
            if (x <= i) { out.no_entry++; return }

            const s0 = data.spyByDay.get(s.ind.date[i]), s1 = data.spyByDay.get(s.ind.date[x])
            if (!(s0?.open > 0) || !(s1?.close > 0)) { out.no_spy++; return }
            const ret = _pct(s.rows[x].close, s.rows[i].open), spy = _pct(s1.close, s0.open), cost = costFor(s.ind.adv20[i - 1] ?? 0)

            // The hold in two parts: up to the run-up window, and the window itself.
            let body = null, last = null
            const y = kn == null ? -1 : x - RUN_UP
            if (y > i) {
                const sy = data.spyByDay.get(s.ind.date[y])
                if (sy?.close > 0) {
                    body = _pct(s.rows[y].close, s.rows[i].open) - _pct(sy.close, s0.open)
                    last = _pct(s.rows[x].close, s.rows[y].close) - _pct(s1.close, sy.close)
                }
            }
            const revBeat = revenueBeat(rep)
            trades.push({ symbol, i, x, day: s.ind.date[i], exit_day: s.ind.date[x], held: x - i + 1, ended: kn == null,
                surprise, band, rev_beat: revBeat, good: isGoodReport(surprise, revBeat), reacted: reaction > 0 ? 'up' : 'down',
                cost, ret, spy, net: ret - spy - cost, body, last })
        })
    }
    return { trades, out }
}

/**
 * The trades as a book → Map(day → { sum, n }): each open trade's return that session against SPY's, the first from the
 * open it was bought at, the round-trip cost off that first session. Pure.
 */
export function holdBook(data, trades) {
    const book = new Map()
    for (const t of trades) {
        const s = data.names.get(t.symbol)
        for (let j = t.i; j <= t.x; j++) {
            const d = s.ind.date[j], sp = data.spyByDay.get(d), prev = j > t.i ? data.spyByDay.get(s.ind.date[j - 1]) : null
            const stock = j === t.i ? _pct(s.rows[j].close, s.rows[j].open) : _pct(s.rows[j].close, s.rows[j - 1].close)
            const spy = j === t.i ? _pct(sp?.close, sp?.open) : _pct(sp?.close, prev?.close)
            if (stock == null || spy == null) continue
            if (!book.has(d)) book.set(d, { sum: 0, n: 0 })
            const b = book.get(d)
            b.sum += stock - spy - (j === t.i ? t.cost : 0)
            b.n += 1
        }
    }
    return book
}

/**
 * A book over `days` → its mean per 21-session block and that mean's t, non-overlapping blocks, a session with no position
 * counting as flat: `{ blocks, mean, t }` (null with under two blocks). Pure.
 */
export function bookBlocks(book, days, size = 21) {
    const blocks = []
    for (let n = 0; n + size <= days.length; n += size) {
        let sum = 0
        for (const d of days.slice(n, n + size)) { const b = book.get(d); if (b?.n) sum += b.sum / b.n }
        blocks.push(sum)
    }
    if (blocks.length < 2) return null
    const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length
    const sd = Math.sqrt(blocks.reduce((a, b) => a + (b - mean) ** 2, 0) / (blocks.length - 1))
    return { blocks: blocks.length, mean, t: sd > 0 ? mean / (sd / Math.sqrt(blocks.length)) : null }
}

/**
 * THE DECLARED BAR (§32): the good reports' book above SPY before AND after `splitAt`, above the book of every report in
 * both, and t ≥ 2 on the whole. Each of `whole`/`before`/`after` a bookBlocks result. Pure.
 */
export function holdVerdict(good, all) {
    const above = (a, b) => a?.mean != null && b?.mean != null && a.mean > b.mean
    const beatsSpy = good.before?.mean > 0 && good.after?.mean > 0
    const beatsAll = above(good.before, all.before) && above(good.after, all.after)
    const significant = good.whole?.t != null && good.whole.t >= 2
    return { beatsSpy, beatsAll, significant, pass: Boolean(beatsSpy && beatsAll && significant) }
}
