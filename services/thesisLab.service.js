// The THESIS lens's test 1 (Roy, 2026-10-30: "do we have a way to test this approach?" → "Run") — the reversal thesis
// written as FIXED rules, a mechanical stand-in for Mentor's and Talos's judgement: does the structure (the stop below
// the last sellers' swing, the target at the start of the fall, the entry level from R:R, strength before entry) have
// an edge at all? Declared in docs/design/stock-playbook.md §Test 1 before the run; scripts/lab-thesis.mjs runs it.
//
// One side's logic, long. A SHORT runs the same code on the MIRRORED bars (`mirror`: every price negated, high and low
// swapped) — a rise becomes a fall, an upper half a lower half, and the R arithmetic is unchanged.
//
// Pure: bars come in (`{ open, high, low, close }`, oldest first); no IO here.

/** The bars upside down: a short's chart read as a long's. Pure. */
export const mirror = (rows) => rows.map(b => ({ ...b, open: -b.open, high: -b.low, low: -b.high, close: -b.close }))

/** The mean true range of the last `n` sessions, by bar, known at that close; null until there are `n`. Pure. */
export function atr(rows, n = 20) {
    const out = new Array(rows.length).fill(null)
    let sum = 0
    const tr = rows.map((b, i) => (i ? Math.max(b.high, rows[i - 1].close) - Math.min(b.low, rows[i - 1].close) : b.high - b.low))
    for (let i = 0; i < rows.length; i++) {
        sum += tr[i]
        if (i >= n) sum -= tr[i - n]
        if (i + 1 >= n) out[i] = sum / n
    }
    return out
}

/**
 * THE SWINGS — a zigzag on highs and lows with a threshold of `k` × ATR. A swing low at bar j is CONFIRMED on the first
 * later bar whose high is k × ATR (that bar's) above it; a swing high, mirrored. → `[{ type: 'L'|'H', j, price, at }]` in
 * the order they were confirmed (`at` the confirming bar — the swing is known from that close on, never before). Pure.
 */
export function swings(rows, atrs, k = 1.5) {
    const out = []
    let mode = 0, hiJ = -1, loJ = -1
    // After a swing is confirmed, the next one starts from the extreme of the bars AFTER it — the swing bar itself is
    // left out, or its other end becomes the next swing and the two flip on the same bar forever.
    const lowest = (a, b) => { let j = a; for (let x = a + 1; x <= b; x++) if (rows[x].low <= rows[j].low) j = x; return j }
    const highest = (a, b) => { let j = a; for (let x = a + 1; x <= b; x++) if (rows[x].high >= rows[j].high) j = x; return j }
    const top = (i) => { out.push({ type: 'H', j: hiJ, price: rows[hiJ].high, at: i }); mode = -1; loJ = lowest(hiJ + 1, i) }
    const bottom = (i) => { out.push({ type: 'L', j: loJ, price: rows[loJ].low, at: i }); mode = 1; hiJ = highest(loJ + 1, i) }
    for (let i = 0; i < rows.length; i++) {
        const a = atrs[i]
        if (a == null) continue
        if (hiJ < 0) { hiJ = loJ = i; continue }
        const b = rows[i]
        if (mode >= 0 && b.high >= rows[hiJ].high) hiJ = i
        if (mode <= 0 && b.low <= rows[loJ].low) loJ = i
        // A bar never confirms a swing at itself: which of its high and low came first is unknown.
        if (mode === 1 || (mode === 0 && hiJ > loJ)) {
            if (hiJ < i && rows[hiJ].high - b.low >= k * a) top(i)
            else if (mode === 0 && loJ < i && b.high - rows[loJ].low >= k * a) bottom(i)
        } else if (loJ < i && b.high - rows[loJ].low >= k * a) bottom(i)
        else if (mode === 0 && hiJ < i && rows[hiJ].high - b.low >= k * a) top(i)
    }
    return out
}

export const DEFAULTS = Object.freeze({ k: 1.5, lookLow: 60, lookFall: 40, minFallAtr: 5, sosWithin: 60, buffer: 0.2, rr: 1.5, maxRiskPct: 10,
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
 * BUYERS IN CONTROL, any context (test 1b — Roy, 2026-10-30: "I don't want only a bounce"). Buyers are in control from
 * a close over the last confirmed swing high until a close under the last confirmed swing low. Each swing high signals
 * once, on the first close over it. The context: `breakout` — the close is over the highest high of the `atHighs`
 * sessions before; else `reversal` — sellers were in control before; else `continuation`. The stop's base is the last
 * swing low; the target the highest high of the `lookFall` sessions before, when over the close — at its highs the
 * measured move (that high + its height over the last swing low). → `[{ i, stopBase, h0, context }]`. Pure.
 */
export function controlSignals(rows, atrs, pivots, o = DEFAULTS, atHighs = 120) {
    const out = [], used = new Set()
    let p = 0, lastH = null, lastL = null, state = null
    for (let i = 0; i < rows.length; i++) {
        while (p < pivots.length && pivots[p].at <= i) { if (pivots[p].type === 'H') lastH = pivots[p]; else lastL = pivots[p]; p++ }
        const c = rows[i].close
        if (lastL && c < lastL.price) { state = 'sellers'; continue }
        if (!lastH || !lastL || used.has(lastH.j) || !(c > lastH.price)) continue
        used.add(lastH.j)
        const before = state
        state = 'buyers'
        if (i < Math.max(atHighs, o.lookFall) || atrs[i] == null || !(lastL.price < c)) continue
        let top = -Infinity, prior = -Infinity
        for (let j = i - o.lookFall; j < i; j++) top = Math.max(top, rows[j].high)
        for (let j = i - atHighs; j < i; j++) prior = Math.max(prior, rows[j].high)
        const context = c > prior ? 'breakout' : before === 'sellers' ? 'reversal' : 'continuation'
        const h0 = top > c ? top : top + (top - lastL.price)
        out.push({ i, stopBase: lastL.price, h0, context })
    }
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
    const S = sig.stopBase - o.buffer * atrs[sig.i], T = sig.h0
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
 * the stop. `maxHold` sessions with neither → out at the close. → `{ m, entry, k, exit, reason }` or null (no entry). Pure.
 */
export function play(rows, i, { S, T, E }, o = DEFAULTS) {
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
