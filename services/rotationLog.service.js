// THE ROTATION'S FORWARD LOG (Roy, 2026-10-27: "build the monthly log") — the market-state map of tests L/M (screener-
// lab.md §29–§31) graded on months it has never seen. Each month from LOG_FROM: the state the evening before it, the
// rules the FIXED map (learned 2019-01 → 2023-12, frozen) and the EXPANDING map (every month before) pick, and — once
// the month is over — each one's month against SPY, next to ALL the rules held equally and the two that beat SPY on
// their own (runup_5, gapdown_held). A month's picks, once logged, are never rewritten: a later run keeps them and
// only fills the results. The same map as scripts/lab-rotation.py's step 3 (by_state).
//
// Pure: the books (rotation-daily-sp500-m.csv) and the states (rotation-regimes.csv) in, rows out; no IO.

/** The first month graded forward — the month after test M (§31) was run. */
export const LOG_FROM = '2026-11'

/** The map, as declared in §29–§31: top K by the state's mean month, at least MIN_STATE months of that state. */
export const MAP = Object.freeze({ from: '2019-01', learnTo: '2023-12', K: 3, minState: 6, expandingAfter: 12 })

/** The rules logged on their own next to the switchers. */
export const WATCH = Object.freeze(['runup_5', 'gapdown_held'])

export const LOG_HEAD = ['month', 'state', 'picked_on', 'fixed_picks', 'expanding_picks', 'fixed', 'expanding', 'all', ...WATCH]

const _mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length

/**
 * Daily books + the evening states → the monthly view: `{ months, rules, sum(month, rule), all(month), stateOf(month),
 * complete(month), lastDay }`. A month is COMPLETE once the states have a session after it; its STATE is the previous
 * month's last evening, known only once that month is complete. Months from MAP.from. Pure.
 */
export function monthly(daily, regimes) {
    const sums = new Map(), ruleSet = new Set()
    for (const { rule, day, ret } of daily) {
        const m = day.slice(0, 7)
        if (m < MAP.from) continue
        ruleSet.add(rule)
        const row = sums.get(m) ?? new Map()
        row.set(rule, (row.get(rule) ?? 0) + ret)
        sums.set(m, row)
    }
    const rules = [...ruleSet].sort()
    const lastOf = new Map()
    for (const { day, regime } of [...regimes].sort((a, b) => a.day.localeCompare(b.day))) lastOf.set(day.slice(0, 7), regime)
    const lastDay = regimes.reduce((d, r) => (r.day > d ? r.day : d), '')
    const lastMonth = lastDay.slice(0, 7)
    const months = [...lastOf.keys()].filter(m => m >= MAP.from).sort()
    const prev = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}` }
    const complete = (m) => m < lastMonth
    const sum = (m, r) => sums.get(m)?.get(r) ?? 0
    return {
        months, rules, lastDay, complete, prev, sum,
        all: (m) => _mean(rules.map(r => sum(m, r))),
        stateOf: (m) => (complete(prev(m)) ? lastOf.get(prev(m)) ?? '' : null),
    }
}

/** The map's pick for month `m` from the months `ks` → the K rules (stable on ties, by name), or null (ALL) under MIN_STATE months of its state. */
export function pickFor(view, m, ks) {
    const s = view.stateOf(m)
    const same = ks.filter(k => view.stateOf(k) === s)
    if (s == null || same.length < MAP.minState) return null
    const score = view.rules.map((r, j) => [r, _mean(same.map(k => view.sum(k, r))), j])
    return score.sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, MAP.K).map(([r]) => r)
}

/** Month `m`'s picks — `fixed` (learned MAP.from → MAP.learnTo) and `expanding` (every month before, from the 13th). Pure. */
export function picksFor(view, m) {
    const before = view.months.filter(k => k < m)
    return {
        fixed: pickFor(view, m, view.months.filter(k => k <= MAP.learnTo)),
        expanding: before.length >= MAP.expandingAfter ? pickFor(view, m, before) : null,
    }
}

/** A month's result for picks (null = ALL), in % vs SPY. */
const result = (view, m, picks) => (picks ? _mean(picks.map(r => view.sum(m, r))) : view.all(m))
const fmtPicks = (p) => (p ? p.join(';') : 'ALL')
const parsePicks = (s) => (s === 'ALL' ? null : s.split(';'))

/**
 * The log: `existing` rows (LOG_HEAD objects, strings) merged with the view — every month from LOG_FROM whose state is
 * known gets a row; a logged month keeps its picks (and the day they were logged); results filled once complete.
 * → `{ rows, changed }` (`changed`: months whose recorded picks differ from a fresh computation — the data was revised). Pure.
 */
export function mergeLog(view, existing = [], { today }) {
    const had = new Map(existing.map(r => [r.month, r]))
    // A month gets its row once the data reaches into it (its state needs the month before complete).
    const months = new Set([...view.months, ...had.keys()])
    const rows = [], changed = []
    for (const m of [...months].sort()) {
        if (m < LOG_FROM) continue
        const state = view.stateOf(m)
        const old = had.get(m)
        if (state == null && !old) continue
        const fresh = state == null ? null : picksFor(view, m)
        const fixed = old ? parsePicks(old.fixed_picks) : fresh.fixed
        const expanding = old ? parsePicks(old.expanding_picks) : fresh.expanding
        if (old && fresh && (fmtPicks(fresh.fixed) !== old.fixed_picks || fmtPicks(fresh.expanding) !== old.expanding_picks)) changed.push(m)
        const done = view.complete(m)
        const n = (x) => (done ? x.toFixed(2) : '')
        rows.push({
            month: m, state: old?.state ?? state, picked_on: old?.picked_on ?? today,
            fixed_picks: fmtPicks(fixed), expanding_picks: fmtPicks(expanding),
            fixed: n(result(view, m, fixed)), expanding: n(result(view, m, expanding)), all: n(view.all(m)),
            ...Object.fromEntries(WATCH.map(r => [r, n(view.sum(m, r))])),
        })
    }
    return { rows, changed }
}

/** The log's running score: the complete months' mean of each column and the fixed map's months above 0 / above ALL. */
export function score(rows) {
    const done = rows.filter(r => r.fixed !== '')
    if (!done.length) return null
    const col = (c) => _mean(done.map(r => Number(r[c])))
    return {
        months: done.length, fixed: col('fixed'), expanding: col('expanding'), all: col('all'),
        ...Object.fromEntries(WATCH.map(r => [r, col(r)])),
        fixedUp: done.filter(r => Number(r.fixed) > 0).length, fixedOverAll: done.filter(r => Number(r.fixed) > Number(r.all)).length,
    }
}
