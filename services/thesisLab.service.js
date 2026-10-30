// The THESIS lens's test 1 (Roy, 2026-10-30: "do we have a way to test this approach?" → "Run") — the reversal thesis
// written as FIXED rules, a mechanical stand-in for Mentor's and Talos's judgement: does the structure (the stop below
// the last sellers' swing, the target at the start of the fall, the entry level from R:R, strength before entry) have
// an edge at all? Declared in docs/design/stock-playbook.md §Test 1 before the run; scripts/lab-thesis.mjs runs it.
//
// One side's logic, long. A SHORT runs the same code on the MIRRORED bars (`mirror`: every price negated, high and low
// swapped) — a rise becomes a fall, an upper half a lower half, and the R arithmetic is unchanged.
//
// Pure: bars come in (`{ open, high, low, close }`, oldest first); no IO here.

// The swings, the ATR, the mirror, who is in control and the target are the shared price-structure mechanism, with its
// settings (STRUCTURE) — Mentor's thesis lens reads the same, so its candidates are the rule tested here.
import { mirror, atr, swings, STRUCTURE, controlReplay, rangeTarget, lowestLow } from './swingStructure.service.js'
export { mirror, atr, swings }

export const DEFAULTS = Object.freeze({ ...STRUCTURE, minFallAtr: 5, sosWithin: 60, rr: 1.5, maxRiskPct: 10,
    wait: 20, drift: 0.1, maxHold: 250, strength: true })

/**
 * THE REVERSAL THESIS, signalled at a close (long). L* — the lowest low of the last `lookLow` sessions, a confirmed swing
 * low (bar j*); the fall — H0, the highest high in the `lookFall` sessions before j*, at least `minFallAtr` × ATR(j*)
 * above L*; AR — the first confirmed swing high after j*; the sign of strength — the first close over AR within
 * `sosWithin` sessions of j*, still under H0. The stop's base is the LAST confirmed swing low at or after j* (the last
 * sellers' swing). → `[{ i, jStar, low, h0, ar, stopBase }]`. Pure.
 */
export function reversalSignals(rows, atrs, pivots, o = DEFAULTS) {
    const out = [], done = new Set()
    let p = 0
    const lows = [], highs = []
    for (let i = 0; i < rows.length; i++) {
        while (p < pivots.length && pivots[p].at <= i) (pivots[p].type === 'L' ? lows : highs).push(pivots[p++])
        if (i < o.lookLow + o.lookFall || atrs[i] == null) continue
        let jStar = i - o.lookLow + 1
        for (let j = jStar + 1; j <= i; j++) if (rows[j].low <= rows[jStar].low) jStar = j
        if (done.has(jStar) || i - jStar > o.sosWithin) continue
        const low = lows.findLast(l => l.j === jStar)
        if (!low || atrs[jStar] == null) continue
        let h0 = -Infinity
        for (let j = Math.max(0, jStar - o.lookFall); j < jStar; j++) h0 = Math.max(h0, rows[j].high)
        if (h0 - low.price < o.minFallAtr * atrs[jStar]) continue
        const ar = highs.find(h => h.j > jStar)
        if (!ar || !(rows[i].close > ar.price) || !(rows[i].close < h0)) continue
        const stopBase = lows.filter(l => l.j >= jStar).reduce((a, b) => (b.j > a.j ? b : a))
        done.add(jStar)
        out.push({ i, jStar, low: low.price, h0, ar: ar.price, stopBase: stopBase.price })
    }
    return out
}

/**
 * BUYERS IN CONTROL, any context (test 1b — Roy, 2026-10-30: "I don't want only a bounce"): a signal at each break up of
 * the shared replay (`controlReplay` — who is in control, each swing high once, its context), once the `atHighs` and
 * `lookFall` windows are full. The stop's base is the last swing low; the target `rangeTarget`'s — the highest high of
 * the `lookFall` sessions before, at its highs the measured move. → `[{ i, stopBase, low60, h0, context }]`. Pure.
 */
export function controlSignals(rows, atrs, pivots, o = DEFAULTS, atHighs = o.atHighs ?? STRUCTURE.atHighs) {
    const out = []
    controlReplay(rows, pivots, { atHighs, onBreak: ({ i, lastL, context }) => {
        const c = rows[i].close
        if (i < Math.max(atHighs, o.lookFall) || atrs[i] == null || !(lastL.price < c)) return
        // `low60` — the lowest low of the last `lookLow` sessions: the whole down move's low, for the deeper stop (`stopAt`).
        out.push({ i, stopBase: lastL.price, low60: lowestLow(rows, i, o.lookLow).price, h0: rangeTarget(rows, i, lastL.price, o.lookFall).target, context })
    } })
    return out
}

/**
 * THE BASELINE — the same geometry without the thesis: every `every`-th session, the last confirmed swing low for the
 * stop and the highest high of the last `lookFall` sessions for the target, when the close is between them. Pure.
 */
export function baselineSignals(rows, atrs, pivots, o = DEFAULTS, every = 10) {
    const out = []
    let p = 0, last = null
    for (let i = 0; i < rows.length; i++) {
        while (p < pivots.length && pivots[p].at <= i) { if (pivots[p].type === 'L') last = pivots[p]; p++ }
        if (i % every || i < o.lookLow + o.lookFall || atrs[i] == null || !last) continue
        let h0 = -Infinity
        for (let j = i - o.lookFall + 1; j <= i; j++) h0 = Math.max(h0, rows[j].high)
        if (!(h0 > rows[i].close) || !(last.price < rows[i].close)) continue
        out.push({ i, h0, stopBase: last.price })
    }
    return out
}

/**
 * The plan at the signal's close: stop, target, the entry level, and rule A (the risk limit). The entry level is set
 * either by the R:R (`rr` at E — the default) or, with `entryBy: 'risk'` (Roy, 2026-10-30: "where the user goes in is
 * set by his risk limit, not R:R"), by the risk limit: the price `riskPct` % above the stop, the R:R then only a check
 * (`minRR`, none when 0). Null past A or the check. Pure.
 */
export function plan(sig, atrs, o = DEFAULTS) {
    const S = (o.stopAt === 'low60' && sig.low60 != null ? Math.min(sig.low60, sig.stopBase) : sig.stopBase) - o.buffer * atrs[sig.i], T = sig.h0
    // (E − S) = r·|E|: on the mirrored (negative) prices of a short the same distance is E = S / (1 + r).
    const r = (o.riskPct ?? 0) / 100
    const E = o.entryBy === 'risk' ? (S > 0 ? S / (1 - r) : S / (1 + r)) : (T + o.rr * S) / (1 + o.rr)
    if (!(E > S) || !(T > E)) return null
    if (o.entryBy === 'risk' && (T - E) / (E - S) < (o.minRR ?? 0)) return null
    if (((E - S) / Math.abs(E)) * 100 > o.maxRiskPct) return null
    return { S, T, E }
}

/**
 * Enter and exit one plan, fixed levels. Entry within `wait` sessions: already at or under E at the signal's close → in
 * at that close; else a low at or under S first cancels; a session that trades to E and closes up on its open in the
 * upper half of its range (the daily stand-in for strength) → in at its close, if within `drift` × risk over E. Without
 * the strength check (`strength: false`) → in at E (or the open, under it) on the first touch. Exit from the next
 * session (the touch-entry: that same session too): a gap through a level fills at the open; a session touching both →
 * the stop. `maxHold` sessions with neither → out at the close — or, with `o.exit` (test 2), `exitManaged`'s exit on
 * `structure`. → `{ m, entry, k, exit, reason }` or null (no entry). Pure.
 */
export function play(rows, i, { S, T, E }, o = DEFAULTS, structure = null) {
    let m = null, entry = null, from = null
    // At or under the stop already (the last sellers' low broke before the signal) — the thesis is gone, no trade.
    if (rows[i].close <= S) return null
    if (rows[i].close <= E) { m = i; entry = rows[i].close; from = i + 1 }
    for (let x = i + 1; m == null && x <= Math.min(rows.length - 1, i + o.wait); x++) {
        const b = rows[x]
        if (!o.strength) {
            if (b.open <= S) return null
            if (b.low <= E) { m = x; entry = Math.min(b.open, E); from = x }
            else continue
            break
        }
        if (b.low <= S) return null
        if (b.low <= E && b.close > b.open && b.close >= (b.high + b.low) / 2 && b.close <= E + o.drift * (E - S)) { m = x; entry = b.close; from = x + 1 }
    }
    if (m == null) return null
    // Test 2's managed exits need the swings and ATR the trail rides on (`structure: { pivots, atrs }`).
    if (o.exit && o.exit !== 'fixed') return exitManaged(rows, structure.pivots, structure.atrs, m, entry, from, { S, T }, o)
    return exitDaily(rows, m, entry, from, { S, T }, o)
}

/** The fixed-level exit on daily bars from session `from` (a gap fills at the open; both levels in one bar → the stop). */
function exitDaily(rows, m, entry, from, { S, T }, o) {
    for (let x = from; x < rows.length && x <= m + o.maxHold; x++) {
        const b = rows[x], gap = x > m
        if (gap && b.open <= S) return { m, entry, k: x, exit: b.open, reason: 'stop' }
        if (gap && b.open >= T) return { m, entry, k: x, exit: b.open, reason: 'target' }
        if (b.low <= S) return { m, entry, k: x, exit: S, reason: 'stop' }
        if (b.high >= T) return { m, entry, k: x, exit: T, reason: 'target' }
        if (x === m + o.maxHold) return { m, entry, k: x, exit: b.close, reason: 'time' }
    }
    return { m, entry, k: null, exit: null, reason: 'open' }
}

/**
 * TEST 2's exits (Roy, 2026-10-30: half for now · the daily trail · D also). `o.exit`: `'half'` — `o.partial` out at the
 * target, the stop at S until then, the rest's stop the trail after; `'trail'` — no target, the whole position's stop the
 * trail from the entry. `o.timeStop` — the target not reached within that many sessions of the entry → all out at that
 * close. THE TRAIL: just under each swing low confirmed at or after the entry's session (its low − `buffer` × ATR at its
 * confirming bar), never down, in force from the session after the confirmation. Gaps, both-levels-in-a-bar and
 * `maxHold` as `exitDaily`. `pivots` / `atrs` — the swings and ATR of the same `rows`. → as `exitDaily`, `exit` the
 * position's AVERAGE exit price, plus `tp` (the target was reached). Pure.
 */
export function exitManaged(rows, pivots, atrs, m, entry, from, { S, T }, o = DEFAULTS) {
    const lows = pivots.filter(p => p.type === 'L' && p.at >= m)
    const share = o.exit === 'trail' ? 0 : (o.partial ?? 0.5)
    let q = 0, trail = S, hit = false, out = 0, got = 0
    const done = (k, px, reason) => ({ m, entry, k, exit: got + (1 - out) * px, reason, tp: hit })
    for (let x = from; x < rows.length && x <= m + o.maxHold; x++) {
        while (q < lows.length && lows[q].at < x) { trail = Math.max(trail, lows[q].price - o.buffer * atrs[lows[q].at]); q++ }
        const b = rows[x], gap = x > m
        if (!hit && share > 0) {
            if (gap && b.open <= S) return done(x, b.open, 'stop')
            if (gap && b.open >= T) { hit = true; out = share; got = share * b.open }
            else if (b.low <= S) return done(x, S, 'stop')
            else if (b.high >= T) { hit = true; out = share; got = share * T }
            if (hit && out >= 1) return done(x, T, 'target')
            if (hit) continue
        } else {
            const why = hit ? 'trail' : trail > S ? 'trail' : 'stop'
            if (gap && b.open <= trail) return done(x, b.open, why)
            if (b.low <= trail) return done(x, trail, why)
        }
        if (!hit && o.timeStop && x - m >= o.timeStop) return done(x, b.close, 'time')
        if (x === m + o.maxHold) return done(x, b.close, 'time')
    }
    return { m, entry, k: null, exit: null, reason: 'open', tp: hit }
}

/** Hourly bars → 4-hour: each session's first four hourly bars, then its rest. `bars` — `[{ day, open, high, low, close }]`. Pure. */
export function toFourHour(bars) {
    const out = []
    let k = 0
    for (let q = 0; q < bars.length; q++) {
        const b = bars[q]
        k = q > 0 && bars[q - 1].day === b.day ? k + 1 : 0
        const last = out.at(-1)
        if (last && last.day === b.day && (k < 4) === last.first) {
            last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close
        } else out.push({ day: b.day, open: b.open, high: b.high, low: b.low, close: b.close, first: k < 4 })
    }
    return out.map(({ first, ...b }) => b)
}

/**
 * TEST 1c — the entry gated by STRENGTH ON AN INTRADAY CHART (Roy, 2026-10-30: "and if Talos would go in only when price
 * is strong?"), a mechanical stand-in for Talos's read. `bars` — the 1h (or 4h) bars of the sessions after the signal,
 * oldest first, each `{ day, open, high, low, close }`, `day` matching `dayOf[x]` of the daily `rows`. Watching starts
 * once price is at or under E (at once when the signal closed there); strength = a bar closing over the HIGH of the bar
 * that made the lowest low since — the sellers' last push failed — in at its close if within `drift` × risk over E. A low
 * at or under the stop first cancels; past `wait` sessions, no trade. The exit: the entry session's later intraday bars,
 * then the daily rule. → as `play`, or null. Pure.
 */
export function playIntraday(rows, dayOf, i, bars, { S, T, E }, o = DEFAULTS) {
    if (rows[i].close <= S) return null
    const lastDay = dayOf[Math.min(rows.length - 1, i + o.wait)]
    let touched = rows[i].close <= E, low = null
    for (let q = 0; q < bars.length; q++) {
        const b = bars[q]
        if (b.day > lastDay) break
        if (b.low <= S) return null
        if (!touched) { if (b.low <= E) { touched = true; low = b } continue }
        if (!low || b.low < low.low) { low = b; continue }
        if (b.close > low.high && b.close <= E + o.drift * (E - S)) {
            const m = dayOf.indexOf(b.day, i)
            for (let r = q + 1; r < bars.length && bars[r].day === b.day; r++) {
                if (bars[r].low <= S) return { m, entry: b.close, k: m, exit: S, reason: 'stop' }
                if (bars[r].high >= T) return { m, entry: b.close, k: m, exit: T, reason: 'target' }
            }
            return exitDaily(rows, m, b.close, m + 1, { S, T }, o)
        }
    }
    return null
}

/**
 * A played trade's result in R, less the round-trip cost (`costPct`, % of the entry) in R. `E` given → R on the PLANNED
 * risk (E − S): the size is set at the level and kept on an entry under it (Roy, 2026-10-30), so a fill near the stop
 * risks less money, not "more R". Without `E` → on the risk actually taken (entry − S). Pure.
 */
export function inR({ entry, exit }, S, costPct, E = null) {
    const risk = (E ?? entry) - S
    return (exit - entry) / risk - (costPct / 100) * Math.abs(entry) / risk
}

const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

/** A small seeded generator (mulberry32) — the bootstrap repeats run to run. Pure. */
export function rng(seed = 7) {
    let a = seed >>> 0
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * The trades' summary: count, hit rate (target first), mean and median R, median days held, and the 5–95% range of the
 * mean R from a bootstrap over calendar MONTHS (`draws` resamples of the months, each month's trades kept together).
 * `trades` — `[{ r, win, days, month }]`. Pure.
 */
export function summarize(trades, { draws = 2000, seed = 7 } = {}) {
    const n = trades.length
    if (!n) return { n: 0 }
    const rs = trades.map(t => t.r).sort((a, b) => a - b)
    const days = trades.map(t => t.days).sort((a, b) => a - b)
    const byMonth = new Map()
    for (const t of trades) { if (!byMonth.has(t.month)) byMonth.set(t.month, []); byMonth.get(t.month).push(t.r) }
    const months = [...byMonth.values()], rand = rng(seed), means = []
    for (let d = 0; d < draws; d++) {
        let s = 0, c = 0
        for (let q = 0; q < months.length; q++) { const xs = months[Math.floor(rand() * months.length)]; for (const x of xs) s += x; c += xs.length }
        means.push(s / c)
    }
    means.sort((a, b) => a - b)
    return { n, hit: trades.filter(t => t.win).length / n, meanR: _mean(rs), medianR: rs[Math.floor(n / 2)], days: days[Math.floor(n / 2)],
        lo: means[Math.floor(draws * 0.05)], hi: means[Math.floor(draws * 0.95)], months: months.length }
}
