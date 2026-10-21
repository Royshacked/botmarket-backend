// The HOTLIST's columns — what each horizon asks of a name (docs/design/daily-names.md §2, §5).
// Pure: a name's overnight stats + its quote at the checkpoint in, a graded cell out. No IO.
//
// Five columns, LONG SIDE ONLY (shorts are deferred, §9):
//   open      the session open (first 30–60 min)      — computed pre-market
//   mid       mid-session                             — computed ~10:30 ET
//   eod       into the close                          — computed ~14:30 ET
//   tomorrow  overnight into the next session         — computed ~15:30 ET
//   week      2–10 days (`short term swing`)          — computed pre-market
//
// A cell is graded only when the name PASSES the column's gates (§2.1) and is IN PLAY for it (§2.2,
// §5's "Rewards"); otherwise it is "—". The grade itself is FREE RANGE: how far price can travel
// before the nearest overhead level that matters for that column, in × ATR (§5, §5.1). No entry, no
// stop, no target, no R:R — those are Mentor's (§5).

/** The columns, in board order. */
export const COLUMNS = Object.freeze(['open', 'mid', 'eod', 'tomorrow', 'week'])

/** §2.1 hard gates per column. Spread is checked only where the book is known (pre-market). */
export const GATES = Object.freeze({
    open:     { minAdvUsd: 50e6, minAtrPct: 3,   maxSpreadPct: 0.05 },
    mid:      { minAdvUsd: 50e6, minAtrPct: 3,   maxSpreadPct: 0.05 },
    eod:      { minAdvUsd: 50e6, minAtrPct: 3,   maxSpreadPct: 0.05 },
    tomorrow: { minAdvUsd: 25e6, minAtrPct: 2.5, maxSpreadPct: 0.1 },
    week:     { minAdvUsd: 20e6, minAtrPct: 2,   maxSpreadPct: 0.15 },
})
export const MIN_PRICE = 5

/** §5.1 starting cut-offs, free range in × daily ATR: [A, B]; below B is C. */
export const CUTOFFS = Object.freeze({
    open: [1.0, 0.5], mid: [0.75, 0.4], eod: [0.5, 0.25], tomorrow: [1.0, 0.5], week: [2.5, 1.5],
})

// Missing is null, not 0 — `Number(null)` is 0, and a 0 would defeat every `??` fallback below.
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

/** Within this many ATR of the session's own high, a price is breaking out: that high is not overhead. */
export const BREAKOUT_ATR = 0.1
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/**
 * The levels overhead that count for a column (§5's table), from the overnight stats and the
 * quote. `today_high` is the session's own high (in-session columns only); `day_high` in the
 * overnight stats is the LAST session's high — the open column's "prior-day high".
 *
 * A live price is always at or under the session's high, and the in-play rules want it NEAR it — so
 * counted as a ceiling, today's high would grade nearly every in-session name C and make open sky
 * impossible. A price within BREAKOUT_ATR of it is breaking out: the range is measured to the next
 * level instead (Roy, 2026-10-21).
 */
export function overheadLevels(column, stats, quote = {}) {
    const s = stats ?? {}
    const sessionHigh = num(quote.dayHigh), price = num(quote.price), atr = num(s.atr14)
    const breaking = sessionHigh != null && price > 0 && atr > 0 && sessionHigh - price <= BREAKOUT_ATR * atr
    const todayHigh = breaking ? null : sessionHigh
    const pick = {
        open:     [s.day_high, s.high5, s.high20],
        mid:      [todayHigh, s.day_high, s.high5, s.high20],
        eod:      [todayHigh, s.high5, s.high20],
        tomorrow: [todayHigh, s.high5, s.high20, s.high50],
        week:     [s.high20, s.high50, s.high52w],
    }[column] ?? []
    return pick.map(num).filter(v => v != null && v > 0)
}

/**
 * Free range: distance from `price` to the NEAREST level above it, in % and × ATR. No level above →
 * OPEN SKY (§5): flagged, never an infinite range. A level AT price is no room at all (0).
 */
export function freeRange(price, levels, atr) {
    const p = num(price), a = num(atr)
    if (!(p > 0)) return null
    const above = levels.filter(l => l >= p).sort((x, y) => x - y)
    if (!above.length) return { level: null, pct: null, atr_mult: null, open_sky: true }
    const room = above[0] - p
    return {
        level:    round(above[0], 4),
        pct:      round((room / p) * 100),
        atr_mult: a > 0 ? round(room / a) : null,
        open_sky: false,
    }
}

/** A / B / C from the free range in × ATR (§5.1). Open sky grades A — nothing is in the way. */
export function gradeFor(column, range) {
    if (!range) return null
    if (range.open_sky) return 'A'
    const [a, b] = CUTOFFS[column] ?? [Infinity, Infinity]
    const m = range.atr_mult
    if (m == null) return null
    return m >= a ? 'A' : m >= b ? 'B' : 'C'
}

/** §2.1: which gate a name fails for a column, or null when it passes. */
export function failedGate(column, stats, ctx = {}) {
    const g = GATES[column]
    const price = num(ctx.price) ?? num(stats?.close)
    if (!(price >= MIN_PRICE)) return 'price'
    if (!(num(stats?.adv20_usd) >= g.minAdvUsd)) return 'dollar_volume'
    if (!(num(stats?.atr_pct) >= g.minAtrPct)) return 'atr'
    const spread = num(ctx.spreadPct)
    if (spread != null && spread > g.maxSpreadPct) return 'spread'
    return null
}

/**
 * The session's volume against an ordinary day's, paced by how much of the session has passed —
 * 1.0 is a normal day so far. Null before there is anything to compare. Pure.
 *
 * @param {number} volume       the session's cumulative volume
 * @param {number} avgVolume    the 20-day average daily volume
 * @param {number} elapsedFrac  0–1, the share of the 390-minute session gone
 */
export function relativeVolume(volume, avgVolume, elapsedFrac) {
    const v = num(volume), avg = num(avgVolume), f = num(elapsedFrac)
    if (!(v >= 0) || !(avg > 0) || !(f > 0)) return null
    return round(v / (avg * Math.min(1, f)))
}

/**
 * Is the name IN PLAY for a column (§2.2, §5)? → `{ in: boolean, why: string[] }`. The `why` is what
 * the board shows, so it is written for a trader.
 *
 * ctx: `{ price, prevClose, open, dayHigh, dayLow, rvol, pmVolPct, catalyst, today }` — `catalyst`
 * is the news label for the name (§3) or null; `pmVolPct` is pre-market volume as % of an average
 * day; `today` the ET session date (for earnings).
 */
export function inPlay(column, stats, ctx = {}) {
    const s = stats ?? {}
    const why = []
    const price = num(ctx.price), prev = num(ctx.prevClose) ?? num(s.close)
    const gapPct = price > 0 && prev > 0 ? ((price - prev) / prev) * 100 : null
    const hi = num(ctx.dayHigh), lo = num(ctx.dayLow)
    const rangePos = hi != null && lo != null && hi > lo && price != null ? (price - lo) / (hi - lo) : null
    const material = ctx.catalyst?.material === true
    const earningsToday = s.next_earnings && ctx.today && s.next_earnings === ctx.today

    switch (column) {
    case 'open': {
        const pmVol = num(ctx.pmVolPct)
        if (gapPct != null && gapPct >= 3 && pmVol != null && pmVol >= 1) why.push(`gap +${round(gapPct, 1)}% on ${round(pmVol, 1)}% of a day's volume pre-market`)
        else if (material && gapPct != null && gapPct >= 1.5) why.push(`gap +${round(gapPct, 1)}% on fresh news`)
        break
    }
    case 'mid': {
        if (num(ctx.rvol) >= 1.5 && price > num(ctx.open) && gapPct != null && gapPct > 0) why.push(`${ctx.rvol}× normal volume, above the open`)
        break
    }
    case 'eod': {
        if (num(ctx.rvol) >= 1.3 && rangePos != null && rangePos >= 0.75 && gapPct > 0) why.push(`in the top quarter of the day's range on ${ctx.rvol}× volume`)
        break
    }
    case 'tomorrow': {
        // A binary overnight is excluded (§2.7) — earnings tonight is a coin toss, not a setup.
        if (earningsToday) break
        if (rangePos != null && rangePos >= 0.85 && num(ctx.rvol) >= 1.2 && gapPct > 0) why.push(`closing at the highs on ${ctx.rvol}× volume`)
        break
    }
    case 'week': {
        const structure = s.nr7 || s.inside_day || (num(s.high20) > 0 && num(s.close) >= num(s.high20) * 0.97)
        const days = _daysUntil(ctx.today, s.next_earnings)
        const scheduled = days != null && days >= 2 && days <= 10
        // LONG SIDE ONLY (§9): a lasting catalyst counts for a long only when it surprised UP — the
        // first live run had Netflix's "disappointing outlook" (a negative drift) qualifying a long.
        const drift = material && ['drift', 'lasting'].includes(ctx.catalyst?.type) && ctx.catalyst?.surprise === 'positive'
        if (num(s.rs20) > 0 && structure && (scheduled || drift)) {
            why.push([
                s.nr7 ? 'NR7' : s.inside_day ? 'inside day' : 'near the 20-day high',
                `RS +${s.rs20} vs SPY (20d)`,
                scheduled ? `earnings in ${days} days` : `${ctx.catalyst.type} catalyst`,
            ].join(' · '))
        }
        break
    }
    }
    return { in: why.length > 0, why }
}

function _daysUntil(today, date) {
    if (!today || !date) return null
    const d = (Date.parse(date) - Date.parse(today)) / 86_400_000
    return Number.isFinite(d) ? Math.round(d) : null
}

/**
 * One column's cell for one name: the gate, in play, the free range, the grade. → `{ grade, why,
 * gate, range }`; `grade` null and `gate`/`why` saying which when it is "—". `unverified` is true
 * for every cell until its column has the outcome history of §7 (the board stamps it).
 */
export function cell(column, stats, ctx = {}) {
    const gate = failedGate(column, stats, ctx)
    if (gate) return { grade: null, gate, why: [], range: null }
    const play = inPlay(column, stats, ctx)
    if (!play.in) return { grade: null, gate: null, why: [], range: null }
    const range = freeRange(num(ctx.price) ?? num(stats?.close), overheadLevels(column, stats, ctx), stats?.atr14)
    return { grade: gradeFor(column, range), gate: null, why: play.why, range }
}
