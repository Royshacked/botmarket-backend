// THE FUNDS (13F) — test G (Roy, 2026-10-26: "start with EDGAR"). Does what the funds did last quarter say where a
// company goes next? `fund_holdings` (aether-engine, pythia-money-flows.md §3.2) has one row per company per quarter:
// 13F shares, dollars and the number of filers. Per company, against the quarter before:
//   - own_chg:     the change in institutional ownership (13F dollars ÷ the market cap at the quarter end), in points;
//   - holders_chg: the change in the number of filers, log — breadth;
//   - own_level:   the ownership itself — crowding.
// The facts are public by the filing deadline (quarter end + 45 days): the trade enters the session after.
//
// Pure: rows and a cap lookup in, no IO.

export const FUND_FEATURES = Object.freeze(['own_chg', 'holders_chg', 'own_level'])

/** Ownership that more than doubles or halves in a quarter is a CUSIP or filing break, not a flow (§3.2). */
export const MAX_JUMP = 2

/** The 13F filing deadline is 45 days after the quarter end; the day after it, every filing is public. Pure. */
export function publicDay(quarter, lag = 46) {
    return new Date(Date.parse(`${quarter}T12:00:00Z`) + lag * 86_400_000).toISOString().slice(0, 10)
}

/**
 * fund_holdings rows (`{ quarter, symbol, value, holders }`) → one change per company per quarter that has the quarter
 * before: `{ symbol, quarter, prev, f: { own_chg, holders_chg, own_level } }`. `capOn(symbol, quarter)` → the market
 * cap at that quarter end, or null (the company is then skipped). Breaks (MAX_JUMP) are dropped. Pure.
 */
export function fundChanges(rows, capOn) {
    const quarters = [...new Set(rows.map(r => r.quarter))].sort()
    const prevOf = new Map(quarters.map((q, i) => [q, quarters[i - 1] ?? null]))
    const at = new Map(rows.map(r => [`${r.symbol}|${r.quarter}`, r]))
    const own = (r) => {
        const cap = capOn(r.symbol, r.quarter)
        return cap > 0 && r.value > 0 ? (r.value / cap) * 100 : null
    }
    const out = []
    for (const r of rows) {
        const prev = prevOf.get(r.quarter)
        const p = prev && at.get(`${r.symbol}|${prev}`)
        if (!p) continue
        const o1 = own(r), o0 = own(p)
        if (o1 == null || o0 == null) continue
        if (o1 / o0 > MAX_JUMP || o0 / o1 > MAX_JUMP) continue
        if (!(r.holders > 0 && p.holders > 0)) continue
        out.push({ symbol: r.symbol, quarter: r.quarter, prev,
            f: { own_chg: o1 - o0, holders_chg: Math.log(r.holders / p.holders) * 100, own_level: o1 } })
    }
    return out
}

const _atOrBefore = (dates, day) => { let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= day) { k = m; lo = m + 1 } else hi = m - 1 } return k }

/**
 * The lab's names and today's caps → `capOn(symbol, quarter)` for fundChanges: today's cap × that quarter end's close ÷
 * the last close (split-safe; it keeps today's share count). Null with no cap, or no bar within a week of the date. Pure.
 */
export function capLookup(data, capOf) {
    return (symbol, quarter) => {
        const s = data.names.get(symbol), cap = capOf.get(symbol)
        if (!s || !cap) return null
        const j = _atOrBefore(s.ind.date, quarter)
        if (j < 0 || Date.parse(quarter) - Date.parse(s.ind.date[j]) > 7 * 86_400_000) return null
        return cap * s.rows[j].close / s.rows.at(-1).close
    }
}

/**
 * The fund facts KNOWN on `day`: per symbol, the latest change whose public day (publicDay) is on or before it →
 * `known(symbol, day)` → the change or null. Pure.
 */
export function factsKnown(changes) {
    const by = new Map()
    for (const c of changes) {
        if (!by.has(c.symbol)) by.set(c.symbol, [])
        by.get(c.symbol).push(c)
    }
    for (const list of by.values()) list.sort((a, b) => a.quarter.localeCompare(b.quarter))
    return (symbol, day) => {
        const list = by.get(symbol)
        if (!list) return null
        let hit = null
        for (const c of list) if (publicDay(c.quarter) <= day) hit = c
        return hit
    }
}

/**
 * Quintile (1 = lowest … 5 = highest) of `feature` WITHIN each quarter, so the drift every quarter shares cancels →
 * Map(the change → quintile). Ties keep their input order. Pure.
 */
export function quintiles(changes, feature) {
    const out = new Map()
    const byQ = new Map()
    for (const c of changes) {
        if (!Number.isFinite(c.f[feature])) continue
        if (!byQ.has(c.quarter)) byQ.set(c.quarter, [])
        byQ.get(c.quarter).push(c)
    }
    for (const list of byQ.values()) {
        const sorted = [...list].sort((a, b) => a.f[feature] - b.f[feature])
        sorted.forEach((c, i) => out.set(c, Math.min(5, Math.floor((i * 5) / sorted.length) + 1)))
    }
    return out
}
