// THE ELLIOTT RULE CHECK (docs/design/proteus.md §8.1 decision 5, Roy 2026-11-13). An Elliott COUNT is never measured — most
// charts admit several, and a count fitted afterwards always looks right. What code CAN do is refuse an impossible one:
// the three hard rules of an impulse, checked on the prices the technical analyst read off the chart, before any count
// is shown. Plus the level that kills the count from here — what the user can hold it to. Then the CANDLE check (below):
// the wave ends must be on the chart. Free (one candle fetch, no model).

export const ELLIOTT_TOOL_DESCRIPTION = `Check an Elliott impulse count against the three HARD rules before you say or show it: wave 2 never retraces past the start of wave 1; wave 3 is never the shortest of 1, 3 and 5; wave 4 never enters wave 1's price territory. Give the direction and the wave-end PRICES you read off the chart, in order — the start of wave 1, then the end of wave 1, 2, 3, 4, 5 as far as the count has got (at least the end of wave 2). Returns whether the count is POSSIBLE, which rule breaks if not, and the price that kills it from here (and how far wave 5 may run before wave 3 would be the shortest). Give the ticker and the timeframe you read it on: each wave end is then found on the candles (a high or low at that price, in order, the extreme of its legs) and the count is checked not to be dead already. A possible count is still an interpretation, never a measured rule — an impossible one is never shown.`

const RULES = Object.freeze({
    w2dir: 'wave 2 did not move against wave 1',
    w3dir: 'wave 3 did not move with wave 1',
    w4dir: 'wave 4 did not move against wave 3',
    w5dir: 'wave 5 did not move with wave 3',
    w2: 'wave 2 retraced past the start of wave 1',
    w3short: 'wave 3 is the shortest of waves 1, 3 and 5',
    w3beyond: 'wave 3 did not go beyond the end of wave 1',
    w4: "wave 4 entered wave 1's price territory",
})

const _r = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null)

/**
 * `{ direction: 'up'|'down', points: [start, w1, w2, w3?, w4?, w5?] }` → `{ possible, broken: [rule], kills_at, kills_why,
 * wave5_max, waves }`. Prices only (the chart read supplies them). `kills_at`: the price beyond which the count, as far as
 * it has got, is impossible; once wave 5 is in, its end (past it, wave 5 is still running). `wave5_max`: wave 5's farthest end before wave 3 would be the
 * shortest — only when wave 3 is shorter than wave 1. Pure.
 */
export function checkElliottCount({ direction = 'up', points = [] } = {}) {
    if (!Array.isArray(points)) return { error: 'points must be a list of prices' }
    const p = points.map(Number)
    if (!['up', 'down'].includes(direction)) return { error: 'direction must be "up" or "down"' }
    if (p.length < 3 || p.length > 6 || p.some(x => !Number.isFinite(x) || x <= 0)) return { error: 'points: 3 to 6 positive prices — the start of wave 1, then the end of each wave so far' }
    const s = direction === 'up' ? 1 : -1
    const v = p.map(x => s * x)   // read a down count as an up count, mirrored
    const [p0, p1, p2, p3, p4, p5] = v
    const len = (a, b) => (a != null && b != null ? b - a : null)
    const l1 = len(p0, p1), l3 = len(p2, p3), l5 = len(p4, p5)
    if (!(l1 > 0)) return { error: `wave 1 must move ${direction}` }
    const broken = []
    // The legs alternate (CR 2026-11-13: 100 → 110 → 130 passed — a "wave 2" that went WITH wave 1).
    const legs = [[p1, p2, 'w2dir'], [p2, p3, 'w3dir'], [p3, p4, 'w4dir'], [p4, p5, 'w5dir']]
    legs.forEach(([a, b, key], k) => { if (b != null && !(k % 2 === 0 ? b < a : b > a)) broken.push(key) })
    if (!(p2 > p0)) broken.push('w2')
    if (p3 != null && !(p3 > p1)) broken.push('w3beyond')
    if (p4 != null && !(p4 > p1)) broken.push('w4')
    if (l5 != null && l3 < l1 && l3 < l5) broken.push('w3short')
    const back = (x) => _r(s * x)
    let kills_at = null, kills_why = null, wave5_max = null
    if (!broken.length) {
        if (p3 == null) { kills_at = back(p0); kills_why = 'wave 2 may not retrace past the start of wave 1' }
        else if (p5 == null) { kills_at = back(p1); kills_why = "wave 4 may not enter wave 1's territory (the end of wave 1)" }
        // Complete: no rule can break any more — what can be wrong is that it IS complete (live replay 2026-11-13: with
        // no level given, the model invented one).
        else { kills_at = back(p5); kills_why = 'beyond the end of wave 5, wave 5 is still running — the impulse is not complete' }
        if (p4 != null && p5 == null && l3 < l1) wave5_max = back(p4 + l3)
    }
    return {
        possible: !broken.length,
        broken: broken.map(k => RULES[k]),
        kills_at, kills_why, wave5_max, complete: !broken.length && p5 != null,
        waves: { w1: _r(l1), w3: _r(l3), w5: _r(l5) },
    }
}

/** The check → the model's text. Pure. */
export function formatElliottCheck(r, direction = 'up') {
    if (r.error) return `Cannot check: ${r.error}.`
    if (!r.possible) return `IMPOSSIBLE count — ${r.broken.join('; ')}. Do not show or describe it as an Elliott count; read the chart again or say no valid count is clear.`
    const parts = [`POSSIBLE count (${direction}) — an interpretation, not a measured rule.`]
    if (r.kills_at != null) parts.push(`It is dead beyond ${r.kills_at}: ${r.kills_why}.`)
    if (r.wave5_max != null) parts.push(`Wave 3 is shorter than wave 1, so wave 5 must end before ${r.wave5_max} (else wave 3 is the shortest).`)
    if (r.complete) parts.push('All five waves are in: the impulse is complete as counted. No rule can break it now; give ONLY this level, never one of your own.')
    return parts.join(' ')
}

// ─── The candle check (Roy, 2026-11-13: "add the candle check") ─────────────────────────────────────────────────────
// The rules above only see the prices handed to them; a misread price passes them. So the count is also held to the
// candles: every wave end must BE on the chart — a low or a high at that price, in order — and must be the extreme of
// its legs (nothing between two wave ends went past either), and the count must not already be dead.

const NAMES = ['the start of wave 1', 'the end of wave 1', 'the end of wave 2', 'the end of wave 3', 'the end of wave 4', 'the end of wave 5']
const _day = (b, intraday) => { const iso = new Date(b.timestamp * 1000).toISOString(); return intraday ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10) }

/**
 * `bars` (oldest → newest, `timestamp` in seconds) against a count that passed the rules → `{ found: [{ name, at }],
 * problems: [text] }`. A point matches a bar whose high (a top) or low (a bottom) is within `tolPct` of it; the LATEST
 * fitting bars are taken, in order (counts are read off the recent chart). Pure.
 */
export function checkCountOnCandles(bars, { direction = 'up', points = [], kills_at = null, complete = false, wave5_max = null, intraday = false, tolPct = 0.005 } = {}) {
    const p = points.map(Number)
    const top = (k) => (direction === 'up') === (k % 2 === 1)   // up: start low, w1 high, w2 low…; down: mirrored
    const near = (x, y) => Math.abs(x - y) <= tolPct * y
    const idx = new Array(p.length).fill(-1)
    let limit = bars.length
    for (let k = p.length - 1; k >= 0; k--) {
        for (let j = limit - 1; j >= 0; j--) if (near(top(k) ? bars[j].high : bars[j].low, p[k])) { idx[k] = j; break }
        if (idx[k] < 0) {
            return { found: [], problems: [`${NAMES[k]} (${p[k]}) is not a ${top(k) ? 'high' : 'low'} on these candles${k < p.length - 1 ? ` before ${NAMES[k + 1]}` : ''} — the price was misread or is older than the ${CHECK_WINDOW_LABEL} the check reads`] }
        }
        limit = idx[k]
    }
    const problems = []
    for (let k = 0; k < p.length - 1; k++) {
        // The bars BETWEEN two wave ends: a wave-end bar's own wick on the other side belongs to the leg before or after
        // it (a bar that ran 124 → 150 makes the high of wave 3, its low is wave 3's leg).
        const inner = bars.slice(idx[k] + 1, idx[k + 1])
        const hi = Math.max(-Infinity, ...inner.map(x => x.high)), lo = Math.min(Infinity, ...inner.map(x => x.low))
        const [hP, lP] = top(k) ? [p[k], p[k + 1]] : [p[k + 1], p[k]]
        if (hi > hP * (1 + tolPct)) problems.push(`between ${NAMES[k]} and ${NAMES[k + 1]} price reached ${_r(hi)}, above both — the wave ends are not the extremes of the leg`)
        if (lo < lP * (1 - tolPct)) problems.push(`between ${NAMES[k]} and ${NAMES[k + 1]} price fell to ${_r(lo)}, below both — the wave ends are not the extremes of the leg`)
    }
    // The leg AFTER the last wave end (CR 2026-11-13): price gone past it since means that wave is still running — the
    // count as given ("in wave 4") is out of date. For a complete count this is its kill level, said below.
    const last = p.length - 1, after = bars.slice(idx[last] + 1)
    // Dead beats out of date: a count past its kill level is said as dead, alone.
    const dead = kills_at != null && after.some(b => ((complete ? direction === 'up' : direction === 'down') ? b.high > kills_at * (1 + tolPct) : b.low < kills_at * (1 - tolPct)))
    if (!complete && !dead) {
        const past = after.find(b => (top(last) ? b.high > p[last] * (1 + tolPct) : b.low < p[last] * (1 - tolPct)))
        if (past) problems.push(`price went past ${NAMES[last]} (${p[last]}) on ${_day(past, intraday)} — that wave is still running; the count as given is out of date`)
    }
    // Wave 5's cap: past it, wave 3 would be the shortest — the count is dead.
    if (wave5_max != null && !dead) {
        const over = after.find(b => (direction === 'up' ? b.high > wave5_max * (1 + tolPct) : b.low < wave5_max * (1 - tolPct)))
        if (over) problems.push(`wave 5 already ran past ${wave5_max} on ${_day(over, intraday)} — wave 3 would be the shortest; the count is dead`)
    }
    // Already dead? After the last wave end, the kill level crossed (beyond wave 5's end, for a complete count).
    if (kills_at != null) {
        const beyondUp = complete ? direction === 'up' : direction === 'down'   // which side of kills_at kills it
        const hit = after.find(b => (beyondUp ? b.high > kills_at * (1 + tolPct) : b.low < kills_at * (1 - tolPct)))
        if (hit) problems.push(complete
            ? `price already went past the end of wave 5 (${kills_at}) on ${_day(hit, intraday)} — wave 5 was still running; the count as given is out of date`
            : `price already crossed ${kills_at} on ${_day(hit, intraday)} — the count is dead`)
    }
    return { found: idx.map((j, k) => ({ name: NAMES[k], at: _day(bars[j], intraday), price: _r(top(k) ? bars[j].high : bars[j].low) })), problems }
}

/** The candle check → the model's text, after the rules' text. Pure. */
export function formatCandleCheck(c) {
    if (c.problems.length) return `NOT ON THE CHART — ${c.problems.join('; ')}. Do not show or describe this count; read the candles again (get_candles) or say no valid count is clear.`
    return `On the candles (draw THESE prices): ${c.found.map(f => `${f.name} ${f.at} at ${f.price}`).join(', ')}.`
}

const INTRADAY_TF = new Set(['1min', '5min', '15min', '30min', '1hr', '2hr', '4hr'])

/**
 * How far back the check reads, per timeframe (CR 2026-11-13: through get_candles' window it saw ~60 days of daily bars
 * and ~28 weeks, so most real counts read "not on the chart"). An impulse on a daily chart spans months; on a weekly, years.
 */
export const CHECK_WINDOW_DAYS = Object.freeze({ '1hr': 90, '4hr': 240, day: 3 * 365, week: 10 * 365 })
const CHECK_WINDOW_LABEL = 'history'

/** `deps.fetchBars(ticker, timeframe)` → bars — the get_candles fetch by default (one candle pipe). */
export function makeElliottHandlers({ deps = {} } = {}) {
    const fetchBars = deps.fetchBars ?? (async (t, tf) => (await (await import('./marketData.tools.js'))._fetchCandleRows(t, tf, { windowDays: CHECK_WINDOW_DAYS[tf] })).bars)
    return {
        check_elliott_count: async ({ ticker, timeframe = 'day', direction, points } = {}) => {
            const r = checkElliottCount({ direction, points })
            const rules = formatElliottCheck(r, direction ?? 'up')
            if (r.error || !r.possible) return rules
            const sym = String(ticker ?? '').trim().toUpperCase()
            if (!sym) return `${rules} UNCHECKED against the candles (no ticker) — call again with \`ticker\` and \`timeframe\` before showing it.`
            try {
                const bars = await fetchBars(sym, timeframe)
                if (!bars?.length) return `${rules} UNCHECKED: no candles for ${sym} ${timeframe} — say the count could not be checked.`
                const c = checkCountOnCandles(bars, { direction, points, kills_at: r.kills_at, complete: r.complete, wave5_max: r.wave5_max, intraday: INTRADAY_TF.has(timeframe) })
                return c.problems.length ? formatCandleCheck(c) : `${rules} ${formatCandleCheck(c)}`
            } catch (err) {
                return `${rules} UNCHECKED: the candles could not be read (${err.message}) — say the count could not be checked against the chart.`
            }
        },
    }
}
