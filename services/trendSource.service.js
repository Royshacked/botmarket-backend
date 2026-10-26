// WHERE A TREND COMES FROM — test D (Roy, 2026-10-26: "events keep affecting prices even when far from the event
// date"). A name's year against SPY, in log returns so the parts add up, cut three ways:
//   - REPORTS: the reaction windows (the close before each report date → the close after it — reportReaction.reactionAt's);
//   - INDUSTRY, BETWEEN: on every other session, the rest of its industry's mean move against SPY (the name left out);
//   - OWN, BETWEEN: what is left — its own news, flows, everything else.
// The report windows are ~3% of the sessions: a part far over its share of the days is where the trend was made.
//
// Pure: the lab's data in (screenerLab.data), no IO.

const _ln = (a, b) => (a > 0 && b > 0 ? Math.log(a / b) : null)

/**
 * The industries' mean daily log move against SPY → Map(industry → Map(day → { sum, n })), so a name's own move can be
 * taken back out (industryEx). Only testable-looking bars (both closes over zero). Pure.
 */
export function industryDaily(data, industryOf) {
    const out = new Map()
    for (const [symbol, s] of data.names) {
        const ind = industryOf.get(symbol)
        if (!ind) continue
        if (!out.has(ind)) out.set(ind, new Map())
        const m = out.get(ind)
        for (let i = 1; i < s.rows.length; i++) {
            const d = s.ind.date[i], spy0 = data.spyByDay.get(s.ind.date[i - 1]), spy1 = data.spyByDay.get(d)
            const r = _ln(s.rows[i].close, s.rows[i - 1].close), q = _ln(spy1?.close, spy0?.close)
            if (r == null || q == null) continue
            const c = m.get(d) ?? { sum: 0, n: 0 }
            c.sum += r - q; c.n++
            m.set(d, c)
        }
    }
    return out
}

/** The rest of the industry's mean that day, without `own` (the name's own move) — null under `min` others. Pure. */
export function industryEx(cell, own, min = 3) {
    if (!cell || cell.n - 1 < min) return null
    return (cell.sum - own) / (cell.n - 1)
}

/**
 * One name over sessions `i0`..`i1` (bar indices; the move from i0's close to i1's) → `{ total, reports, industry, own,
 * days, report_days }` in % log points against SPY, or null when a bar's SPY or the industry is missing for more than a
 * tenth of the sessions (those sessions are left out of all three parts alike). Pure.
 */
export function decompose(s, i0, i1, data, ind, inds) {
    const at = new Map(s.ind.date.map((d, i) => [d, i]))
    const inReport = new Set()
    for (const day of s.reports.keys()) {
        const k = at.get(day)
        if (k == null) continue
        // The reaction window close k−1 → close k+1 is the moves of sessions k and k+1.
        if (k >= i0 + 1 && k <= i1) inReport.add(k)
        if (k + 1 >= i0 + 1 && k + 1 <= i1) inReport.add(k + 1)
    }
    let reports = 0, industry = 0, own = 0, missing = 0
    for (let i = i0 + 1; i <= i1; i++) {
        const spy0 = data.spyByDay.get(s.ind.date[i - 1]), spy1 = data.spyByDay.get(s.ind.date[i])
        const r = _ln(s.rows[i].close, s.rows[i - 1].close), q = _ln(spy1?.close, spy0?.close)
        if (r == null || q == null) { missing++; continue }
        const ex = r - q
        if (inReport.has(i)) { reports += ex; continue }
        const m = industryEx(inds.get(ind)?.get(s.ind.date[i]), ex)
        if (m == null) { missing++; continue }
        industry += m; own += ex - m
    }
    const days = i1 - i0
    if (missing > days / 10) return null
    const pc = (x) => x * 100
    return { total: pc(reports + industry + own), reports: pc(reports), industry: pc(industry), own: pc(own), days, report_days: inReport.size }
}
