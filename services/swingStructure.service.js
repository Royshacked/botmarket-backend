// SWING STRUCTURE — who is in control of a chart, read from its swings: the shared mechanism behind the THESIS lens
// (docs/design/stock-playbook.md). Two callers, one pipe: the lab's test of the approach (thesisLab.service) and Mentor's
// facts tool (get_price_structure). Mentor JUDGES the stop and the targets (Roy, 2026-10-30: "I prefer it would be a judge
// and not hardcoded rules"); this hands him the facts he judges FROM — the swings, the normal move, the fall, the heavy
// days — and does the entry arithmetic, which is money and therefore code (as positionSize.util is).
//
// Pure: bars come in (`{ date?, open, high, low, close, volume? }`, oldest first); no IO here.

/**
 * The rule's settings, one home — the lab tested these, Mentor's candidates are read with them: `k` the swing threshold
 * in ATRs, `buffer` the stop's ATRs under the swing, `lookLow` the down move's low window, `lookFall` the target's
 * window, `atHighs` the window a breakout clears. `nearHigh` — NOT tested and not the lab's: Mentor's candidate only. A
 * high within this many ATRs over the close is the high price is already at, not a level to sell into (Roy, 2026-11-05).
 */
export const STRUCTURE = Object.freeze({ k: 1.5, buffer: 0.2, lookLow: 60, lookFall: 40, atHighs: 120, nearHigh: 1 })

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

/** Daily bars → weekly (ISO weeks, Monday first): the longer-term chart the same rules run on. Needs `date`. Pure. */
export function toWeekly(rows) {
    const monday = (d) => { const t = new Date(`${d}T12:00:00Z`); return new Date(t - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10) }
    const out = []
    for (const b of rows) {
        const w = monday(b.date), last = out.at(-1)
        if (last && last.week === w) {
            last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close
            last.volume = (last.volume ?? 0) + (b.volume ?? 0); last.date = b.date
        } else out.push({ week: w, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })
    }
    return out.map(({ week, ...b }) => ({ ...b, date: week }))
}

/**
 * WHO IS IN CONTROL, replayed close by close against the swings known at each bar (test 1b's rule): sellers from a close
 * under the last confirmed swing low; buyers from the first close over the last confirmed swing high (each swing high
 * breaks once, and only once a swing low is known). A break's context: `breakout` — the close clears the highest high
 * of the `atHighs` bars before (as many as there are); else `reversal` — sellers were in control; else `continuation`.
 * `onBreak({ i, lastH, lastL, before, context })` is called at each break. → the state at the last bar: `{ control,
 * since (bar index), lastH, lastL, lastBreak { i, context } }`. Pure.
 */
export function controlReplay(rows, pivots, { atHighs = STRUCTURE.atHighs, onBreak = null } = {}) {
    let p = 0, lastH = null, lastL = null, control = null, since = null, lastBreak = null
    const used = new Set()
    for (let i = 0; i < rows.length; i++) {
        while (p < pivots.length && pivots[p].at <= i) { if (pivots[p].type === 'H') lastH = pivots[p]; else lastL = pivots[p]; p++ }
        const c = rows[i].close
        if (lastL && c < lastL.price) { if (control !== 'sellers') { control = 'sellers'; since = i } continue }
        if (!lastH || !lastL || used.has(lastH.j) || !(c > lastH.price)) continue
        used.add(lastH.j)
        let prior = -Infinity
        for (let j = Math.max(0, i - atHighs); j < i; j++) prior = Math.max(prior, rows[j].high)
        const before = control
        lastBreak = { i, context: c > prior ? 'breakout' : before === 'sellers' ? 'reversal' : 'continuation' }
        if (control !== 'buyers') { control = 'buyers'; since = i }
        onBreak?.({ i, lastH, lastL, before, context: lastBreak.context })
    }
    return { control, since, lastH, lastL, lastBreak, lastHBroken: lastH ? used.has(lastH.j) : false }
}

/**
 * The target candidate at bar `i`: the highest high of the `lookFall` bars before it when over the close (`range_top` —
 * the start of the fall); at the highs, that high plus its height over `swingLow` (`measured_move`). `room` is how far
 * over the close the high must sit to count as a target: 0 for the lab, whose tested rule this is; a normal move for
 * Mentor's candidate (AAPL, 2026-11-05: 349.51 under a 351.73 high read "target 351.73", 0.09R at today's price). With
 * room, the measured move starts from the true high, the latest bar's included (AAPL: 354.50, not 351.73); the lab's
 * rule looks only at the bars before. Pure.
 */
export function rangeTarget(rows, i, swingLow, lookFall = STRUCTURE.lookFall, room = 0) {
    let top = -Infinity
    for (let j = Math.max(0, i - lookFall); j < i; j++) top = Math.max(top, rows[j].high)
    if (top > rows[i].close + room) return { target: top, kind: 'range_top' }
    const high = room > 0 ? Math.max(top, rows[i].high) : top
    return { target: swingLow == null ? null : high + (high - swingLow), kind: 'measured_move', high }
}

/** The lowest low of the `n` bars ending at `i` (the latest on a tie) → `{ price, j }`. Pure. */
export function lowestLow(rows, i, n = STRUCTURE.lookLow) {
    let price = Infinity, j = i
    for (let x = Math.max(0, i - n + 1); x <= i; x++) if (rows[x].low <= price) { price = rows[x].low; j = x }
    return { price, j }
}

/**
 * The last bar at or before `i` whose low traded under `level` — "a price it has not visited since" is that bar's date
 * (docs/design/thesis-lens-followups.md). A short passes mirrored bars and a mirrored level. → its index, or null. Pure.
 */
export function lastTradedUnder(rows, level, i = rows.length - 1) {
    for (let j = i; j >= 0; j--) if (rows[j].low < level) return j
    return null
}

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/**
 * THE FACTS a thesis read is judged from, as of the last bar (long side — a short reads `mirror`ed bars). `k` — the
 * swing threshold in ATRs. → `{ as_of, close, atr, atr_pct, swings (the last `keep`), last_swing_low, last_swing_high,
 * control ('buyers'|'sellers'|null) and since, last_break { date, context }, fall { from, low }, candidates { stop,
 * deep_stop, deep_stop_last_traded (the last date under it, or null), target, target_kind (range_top | measured_move), lookback_bars }, heavy_days,
 * break_candidate { swing_to_break, higher_swing (the last printed, or null), fall_low, stop (assumed), stop_is, target, context } or null }`, or null under 60 bars. Candidates are the lab's rules (test 1b) —
 * a starting point Mentor judges, never the answer. Pure.
 */
export function structureFacts(rows, { k = STRUCTURE.k, buffer = STRUCTURE.buffer, keep = 8, lookLow = STRUCTURE.lookLow, lookFall = STRUCTURE.lookFall, atHighs = STRUCTURE.atHighs } = {}) {
    if (!rows?.length || rows.length < 60) return null
    const a = atr(rows), pv = swings(rows, a, k), n = rows.length, i = n - 1
    const day = (j) => rows[j].date ?? null
    const pt = (p) => ({ type: p.type === 'H' ? 'high' : 'low', date: day(p.j), price: _r(p.price), confirmed: day(p.at) })
    const { control, since, lastH, lastL, lastBreak, lastHBroken } = controlReplay(rows, pv, { atHighs })
    const { price: low60, j: lowJ } = lowestLow(rows, i, lookLow)
    let from = -Infinity, fromJ = null
    for (let j = Math.max(0, lowJ - lookFall); j < lowJ; j++) if (rows[j].high >= from) { from = rows[j].high; fromJ = j }
    const close = rows[i].close
    const stop = lastL ? lastL.price - buffer * a[i] : null
    const deepStop = low60 - buffer * a[i]
    // When price last traded under the deep stop — "a price it has not visited since" is a date Mentor reads, never
    // guesses (docs/design/thesis-lens-followups.md). Null when the history read has none.
    const deepJ = lastTradedUnder(rows, deepStop, i)
    // THE BREAK CANDIDATE — scenario B's facts, for Mentor to judge (thesis-lens-followups § Every build, 2026-11-04). The
    // line: with sellers in control, the last swing high, whose close over it flips control; otherwise the nearest high
    // over the price, a confirmed swing high or the recent high since the last swing low (the same pivots as the away
    // edge). The stop is ASSUMED, because the higher low the break would leave has not printed: a swing here needs a
    // pullback of k ATR, so the first one the break could confirm sits k ATR under the line, and the stop goes the noise
    // buffer under that (Roy: Mentor assumes what the stop will be, and offers it). Null with no line over the price.
    let line = null
    if (control === 'sellers' && lastH?.price > close) line = pt(lastH)
    else {
        for (const p of pv) if (p.type === 'H' && p.price > close && (!line || p.price < line.price)) line = pt(p)
        let recentJ = null
        // Before today: today's own wick is a few cents over any close under the session high, and moves until the close.
        if (lastL) for (let j = lastL.j + 1; j < i; j++) if (rows[j].high > close && (recentJ == null || rows[j].high > rows[recentJ].high)) recentJ = j
        if (recentJ != null && (!line || rows[recentJ].high < line.price)) line = { type: 'high', date: day(recentJ), price: _r(rows[recentJ].high), confirmed: null }
    }
    let breakCandidate = null
    if (line) {
        const assumed = line.price - (k + buffer) * a[i]
        // The next swing high worth the risk: one a stop's distance over the line at least. A high just over the line
        // (COST, 2026-11-04: line 1053.75, the next high 1058.89, the stop 31 under) would fail every limit at the level.
        let next = null
        for (const p of pv) if (p.type === 'H' && p.price >= line.price + (line.price - assumed) && (next == null || p.price < next)) next = p.price
        let prior = -Infinity
        for (let j = Math.max(0, i - atHighs + 1); j <= i; j++) prior = Math.max(prior, rows[j].high)
        breakCandidate = {
            swing_to_break: line, higher_swing: lastL ? pt(lastL) : null, fall_low: { date: day(lowJ), price: _r(low60) },
            stop: _r(assumed), stop_is: 'assumed',
            // What a B that has not armed can still fall through (Roy, 2026-11-04). Its stop, when price is over it; with
            // the stop over today's price that says nothing yet, so the low of the fall stands in.
            floor: _r(assumed < close ? assumed : low60),
            target: _r(next ?? line.price + Math.max(line.price - (lastL?.price ?? low60), line.price - assumed)),
            // The same three words as a break the replay has seen (controlReplay), read for a break that has not happened.
            // A reversal is only a close that would flip control: over the last swing high, not yet broken.
            context: line.price >= prior ? 'breakout' : control === 'sellers' && line.price === _r(lastH?.price) && !lastHBroken ? 'reversal' : 'continuation',
        }
    }
    // No swing low yet: the low of the fall is the range's floor, as it is for the break candidate's target above.
    const { target, kind, high: rangeHigh = null } = rangeTarget(rows, i, lastL?.price ?? low60, lookFall, STRUCTURE.nearHigh * a[i])
    // Never a target under the close, whatever the bars did: no candidate instead (CR).
    const candidateTarget = kind === 'measured_move' && !(target > close) ? null : target
    // The heavy days of the last 60: volume ≥ 2× its 20-day mean — climaxes, shakeouts, the sign of strength.
    const heavy = []
    for (let j = Math.max(20, n - 60); j < n; j++) {
        let s = 0
        for (let x = j - 20; x < j; x++) s += rows[x].volume ?? 0
        const mult = s > 0 ? (rows[j].volume ?? 0) / (s / 20) : 0
        if (mult >= 2) heavy.push({ date: day(j), volume_x: _r(mult, 1), change_pct: _r((rows[j].close / rows[j - 1].close - 1) * 100), close: _r(rows[j].close) })
    }
    return {
        // abs — a short reads mirrored (negative) closes, and the normal move is a size either way.
        as_of: day(i), close: _r(close), atr: _r(a[i]), atr_pct: _r(Math.abs(a[i] / close) * 100),
        swing_threshold_atr: k,
        swings: pv.slice(-keep).map(pt),
        last_swing_low: lastL ? pt(lastL) : null,
        last_swing_high: lastH ? pt(lastH) : null,
        control, since: since == null ? null : day(since),
        last_break: lastBreak ? { date: day(lastBreak.i), context: lastBreak.context } : null,
        fall: fromJ != null && from > low60 ? { from: { date: day(fromJ), price: _r(from) }, low: { date: day(lowJ), price: _r(low60) }, atrs: _r((from - low60) / (a[lowJ] ?? a[i])) } : null,
        candidates: {
            stop: _r(stop), deep_stop: _r(deepStop), deep_stop_last_traded: deepJ == null ? null : day(deepJ),
            // `range_top` — the highest high of the last `lookFall` bars; `measured_move` — at the highs, that high + its height.
            target: _r(candidateTarget), target_kind: kind, range_high: rangeHigh == null ? null : _r(rangeHigh), lookback_bars: lookFall,
        },
        heavy_days: heavy,
        break_candidate: breakCandidate,
    }
}

/**
 * THE ENTRY LEVEL — the highest price worth paying, from the stop and the target the trader judged and the user's two
 * limits (Roy, 2026-10-30): the RISK LIMIT (`riskPct`: the stop at most this % under the entry) and the minimum REWARD
 * TO RISK (`minRR`). Each gives a ceiling; the level is the lower. The setup's entry is "the level and below". Long; a
 * short passes `side: 'short'` (stop over, target under). → `{ level, rr_at_level, risk_pct_at_level, by, problem }`. Pure.
 */
export function entryLevel({ stop, target, riskPct = null, minRR = null, side = 'long' }) {
    const S = Number(stop), T = Number(target), sg = side === 'short' ? -1 : 1
    const none = (problem) => ({ level: null, rr_at_level: null, risk_pct_at_level: null, by: null, problem })
    if (!Number.isFinite(S) || !Number.isFinite(T) || !(sg * (T - S) > 0)) return none(`the target must be ${side === 'short' ? 'under' : 'over'} the stop`)
    if (riskPct == null && minRR == null) return none('needs a risk limit, a minimum reward to risk, or both')
    if (riskPct != null && !(Number(riskPct) > 0 && Number(riskPct) < 100)) return none('the risk limit is a percent between 0 and 100')
    if (minRR != null && !(Number(minRR) > 0)) return none('the minimum reward to risk must be over 0')
    const caps = []
    // R:R at E = (T − E) / (E − S) ≥ minRR  →  E ≤ (T + minRR·S) / (1 + minRR)   (the same, mirrored, for a short)
    if (minRR != null) caps.push({ by: 'reward_to_risk', at: (T + Number(minRR) * S) / (1 + Number(minRR)) })
    // (E − S) / E ≤ r  →  E ≤ S / (1 − r) on a long; a short's stop is over: (S − E) / E ≤ r  →  E ≥ S / (1 + r)
    if (riskPct != null) { const r = Number(riskPct) / 100; caps.push({ by: 'risk_limit', at: sg > 0 ? S / (1 - r) : S / (1 + r) }) }
    const pick = caps.reduce((x, y) => (sg * y.at < sg * x.at ? y : x))
    const E = pick.at
    if (!(sg * (E - S) > 0)) return none('no entry between the stop and the target meets both limits')
    return { level: _r(E), rr_at_level: _r((sg * (T - E)) / (sg * (E - S))), risk_pct_at_level: _r((sg * (E - S) / E) * 100), by: pick.by, problem: null }
}
