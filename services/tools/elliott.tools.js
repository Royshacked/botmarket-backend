// THE ELLIOTT RULE CHECK (docs/design/proteus.md §8.1 decision 5, Roy 2026-11-13). An Elliott COUNT is never measured — most
// charts admit several, and a count fitted afterwards always looks right. What code CAN do is refuse an impossible one:
// the three hard rules of an impulse, checked on the prices the technical analyst read off the chart, before any count
// is shown. Plus the level that kills the count from here — what the user can hold it to. Pure, free (no data, no model).

export const ELLIOTT_TOOL_DESCRIPTION = `Check an Elliott impulse count against the three HARD rules before you say or show it: wave 2 never retraces past the start of wave 1; wave 3 is never the shortest of 1, 3 and 5; wave 4 never enters wave 1's price territory. Give the direction and the wave-end PRICES you read off the chart, in order — the start of wave 1, then the end of wave 1, 2, 3, 4, 5 as far as the count has got (at least the end of wave 2). Returns whether the count is POSSIBLE, which rule breaks if not, and the price that kills it from here (and how far wave 5 may run before wave 3 would be the shortest). Free and exact. A possible count is still an interpretation, never a measured rule — an impossible one is never shown.`

const RULES = Object.freeze({
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
    const p = (points ?? []).map(Number)
    if (!['up', 'down'].includes(direction)) return { error: 'direction must be "up" or "down"' }
    if (p.length < 3 || p.length > 6 || p.some(x => !Number.isFinite(x) || x <= 0)) return { error: 'points: 3 to 6 positive prices — the start of wave 1, then the end of each wave so far' }
    const s = direction === 'up' ? 1 : -1
    const v = p.map(x => s * x)   // read a down count as an up count, mirrored
    const [p0, p1, p2, p3, p4, p5] = v
    const len = (a, b) => (a != null && b != null ? b - a : null)
    const l1 = len(p0, p1), l3 = len(p2, p3), l5 = len(p4, p5)
    if (!(l1 > 0)) return { error: `wave 1 must move ${direction}` }
    const broken = []
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

export function makeElliottHandlers() {
    return {
        check_elliott_count: async ({ direction, points } = {}) => formatElliottCheck(checkElliottCount({ direction, points }), direction ?? 'up'),
    }
}
