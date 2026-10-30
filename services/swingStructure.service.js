// SWING STRUCTURE — who is in control of a chart, read from its swings: the shared mechanism behind the THESIS lens
// (docs/design/stock-playbook.md). Two callers, one pipe: the lab's test of the approach (thesisLab.service) and Mentor's
// facts tool (get_price_structure). Mentor JUDGES the stop and the targets (Roy, 2026-10-30: "I prefer it would be a judge
// and not hardcoded rules"); this hands him the facts he judges FROM — the swings, the normal move, the fall, the heavy
// days — and does the entry arithmetic, which is money and therefore code (as positionSize.util is).
//
// Pure: bars come in (`{ date?, open, high, low, close, volume? }`, oldest first); no IO here.

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

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/**
 * THE FACTS a thesis read is judged from, as of the last bar (long side — a short reads `mirror`ed bars). `k` — the
 * swing threshold in ATRs. → `{ as_of, close, atr, atr_pct, swings (the last `keep`), last_swing_low, last_swing_high,
 * control ('buyers'|'sellers'|null) and since, last_break { date, context }, fall { from, low }, candidates { stop,
 * deep_stop, target, target_kind (range_top | measured_move), lookback_bars }, heavy_days }`, or null under 60 bars. Candidates are the lab's rules (test 1b) —
 * a starting point Mentor judges, never the answer. Pure.
 */
export function structureFacts(rows, { k = 1.5, buffer = 0.2, keep = 8, lookLow = 60, lookFall = 40, atHighs = 120 } = {}) {
    if (!rows?.length || rows.length < 60) return null
    const a = atr(rows), pv = swings(rows, a, k), n = rows.length, i = n - 1
    const day = (j) => rows[j].date ?? null
    const pt = (p) => ({ type: p.type === 'H' ? 'high' : 'low', date: day(p.j), price: _r(p.price), confirmed: day(p.at) })
    // Who is in control: replay the closes against the swings known at each bar.
    let lastH = null, lastL = null, control = null, since = null, lastBreak = null, q = 0
    for (let x = 0; x < n; x++) {
        while (q < pv.length && pv[q].at <= x) { if (pv[q].type === 'H') lastH = pv[q]; else lastL = pv[q]; q++ }
        const c = rows[x].close
        if (lastL && c < lastL.price && control !== 'sellers') { control = 'sellers'; since = day(x) }
        else if (lastH && c > lastH.price && lastBreak?.swing !== lastH.j) {
            let prior = -Infinity
            for (let j = Math.max(0, x - atHighs); j < x; j++) prior = Math.max(prior, rows[j].high)
            lastBreak = { swing: lastH.j, date: day(x), context: c > prior ? 'breakout' : control === 'sellers' ? 'reversal' : 'continuation' }
            if (control !== 'buyers') { control = 'buyers'; since = day(x) }
        }
    }
    let low60 = Infinity, lowJ = i
    for (let j = Math.max(0, i - lookLow + 1); j <= i; j++) if (rows[j].low <= low60) { low60 = rows[j].low; lowJ = j }
    let from = -Infinity, fromJ = null
    for (let j = Math.max(0, lowJ - lookFall); j < lowJ; j++) if (rows[j].high >= from) { from = rows[j].high; fromJ = j }
    let top = -Infinity
    for (let j = Math.max(0, i - lookFall); j < i; j++) top = Math.max(top, rows[j].high)
    const close = rows[i].close
    const stop = lastL ? lastL.price - buffer * a[i] : null
    const target = top > close ? top : lastL ? top + (top - lastL.price) : null
    // The heavy days of the last 60: volume ≥ 2× its 20-day mean — climaxes, shakeouts, the sign of strength.
    const heavy = []
    for (let j = Math.max(20, n - 60); j < n; j++) {
        let s = 0
        for (let x = j - 20; x < j; x++) s += rows[x].volume ?? 0
        const mult = s > 0 ? (rows[j].volume ?? 0) / (s / 20) : 0
        if (mult >= 2) heavy.push({ date: day(j), volume_x: _r(mult, 1), change_pct: _r((rows[j].close / rows[j - 1].close - 1) * 100), close: _r(rows[j].close) })
    }
    return {
        as_of: day(i), close: _r(close), atr: _r(a[i]), atr_pct: _r((a[i] / close) * 100),
        swing_threshold_atr: k,
        swings: pv.slice(-keep).map(pt),
        last_swing_low: lastL ? pt(lastL) : null,
        last_swing_high: lastH ? pt(lastH) : null,
        control, since,
        last_break: lastBreak ? { date: lastBreak.date, context: lastBreak.context } : null,
        fall: fromJ != null && from > low60 ? { from: { date: day(fromJ), price: _r(from) }, low: { date: day(lowJ), price: _r(low60) }, atrs: _r((from - low60) / (a[lowJ] ?? a[i])) } : null,
        candidates: {
            stop: _r(stop), deep_stop: _r(low60 - buffer * a[i]),
            // `range_top` — the highest high of the last `lookFall` bars; `measured_move` — at the highs, that high + its height.
            target: _r(target), target_kind: top > close ? 'range_top' : 'measured_move', lookback_bars: lookFall,
        },
        heavy_days: heavy,
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
