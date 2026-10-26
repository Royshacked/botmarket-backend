// THE MANAGERS (13F) — test J (Roy, 2026-10-26: "test the managers — do not make short cuts"). Not every fund together
// (index money swamps that — tests G–I) but WHICH manager bought: per filer, per quarter, from each filing's own book
// (scripts/lab-13f-extract.py). Cohen, Polk & Silli (2010), "Best Ideas": a manager's highest-conviction positions beat
// the market. A CONVICTION BET is a company the filer did not hold the quarter before, at ≥ 3% of its book; a
// CONCENTRATED manager holds ≤ 40 positions and $100M+.
//
// Pure: the extract's rows and metas in, no IO.

export const MIN_WEIGHT = 0.03
export const CONCENTRATED = Object.freeze({ maxN: 40, minV: 1e8 })
export const ADD_MIN = 1.5            // an add: the dollar value × 1.5+ after the price move is taken out
export const BREAK_MIN = 0.5          // a company held by under half as many filers the quarter before is a data break
export const SHARE_OF_PRIMARY = 0.3   // a CUSIP stands in for a company's own only with 30%+ of its usual holders

const NOT_COMMON = /\b(PFD|PREF|PREFERRED|NOTES?|DEB|DEBS|BONDS?|WTS?|WARRANTS?|RIGHTS?|UNITS?|DEP SHS)\b|%/

/** Is a 13F "title of class" a preferred, a note, a warrant, a right or a unit — anything but the common? Pure. */
export const isNotCommon = (cls) => NOT_COMMON.test(String(cls ?? '').toUpperCase())

const _median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/**
 * The CUSIP each company traded under, quarter by quarter. `symbols` the lab's names; `gics` {cusip: symbol} (the
 * aether job's map); `fmp` {SYM: {cusip}} (each name's FMP profile); `metas` Map(period → {cusip: [holders, shares,
 * issuer, class]}). The candidates are both maps' CUSIPs for the name; its PRIMARY is the one the most filers held
 * (the latest four quarters). In a quarter where the primary is held by under SHARE_OF_PRIMARY of its usual holders —
 * a CUSIP that changed — another CUSIP of the same issuer code (first 6) stands in: a common class, not another name's
 * primary, the most held, if it has that share. → { cusipOf: Map(sym → Map(period → cusip)), report: [...] }. Pure.
 */
export function resolveCusips(symbols, { gics, fmp, metas }) {
    const periods = [...metas.keys()].sort()
    const recent = periods.slice(-4)
    const holders = (cu, p) => metas.get(p)?.[cu]?.[0] ?? 0
    const cand = new Map(symbols.map(s => [s, new Set()]))
    for (const [cu, s] of Object.entries(gics ?? {})) if (cand.has(s)) cand.get(s).add(cu)
    for (const [s, v] of Object.entries(fmp ?? {})) if (cand.has(s) && v?.cusip) cand.get(s).add(v.cusip)
    const primary = new Map()
    const report = []
    for (const [s, cs] of cand) {
        const ranked = [...cs].map(cu => [cu, Math.max(0, ...recent.map(p => holders(cu, p)), ...periods.map(p => holders(cu, p) * 0.001))])
            .sort((a, b) => b[1] - a[1])
        if (!ranked.length || ranked[0][1] <= 0) { report.push({ symbol: s, kind: 'no_cusip_held', candidates: [...cs] }); continue }
        primary.set(s, ranked[0][0])
        const gicsOwn = Object.entries(gics ?? {}).find(([cu, sym]) => sym === s)?.[0] ?? null
        if (gicsOwn && gicsOwn !== ranked[0][0]) report.push({ symbol: s, kind: 'gics_cusip_replaced', from: gicsOwn, to: ranked[0][0] })
        if (!gicsOwn) report.push({ symbol: s, kind: 'gics_had_none', to: ranked[0][0], gicsHolder: gics?.[ranked[0][0]] ?? null })
    }
    const taken = new Set(primary.values())
    const cusipOf = new Map()
    for (const [s, pc] of primary) {
        const usual = _median(periods.map(p => holders(pc, p)).filter(h => h > 0)) ?? 0
        const m = new Map()
        for (const p of periods) {
            if (holders(pc, p) >= SHARE_OF_PRIMARY * usual) { m.set(p, pc); continue }
            const alt = Object.entries(metas.get(p) ?? {})
                .filter(([cu, v]) => cu !== pc && cu.slice(0, 6) === pc.slice(0, 6) && !taken.has(cu) && !isNotCommon(v[3]) && v[0] >= SHARE_OF_PRIMARY * usual)
                .sort((a, b) => b[1][0] - a[1][0])[0]
            if (alt) { m.set(p, alt[0]); report.push({ symbol: s, kind: 'stand_in', period: p, cusip: alt[0], holders: alt[1][0], usual }) }
        }
        cusipOf.set(s, m)
    }
    return { cusipOf, report }
}

/**
 * One quarter's extract rows (`[cik, cusip, shares, value, filed]`) → the books by filer for the lab's names:
 * Map(cik → Map(symbol → { shares, value, filed })), and the filers holding each name, Map(symbol → count). `symOf`
 * Map(cusip → symbol) for that quarter. Pure.
 */
export function booksOf(rows, symOf) {
    const books = new Map(), holders = new Map()
    for (const [cik, cu, shares, value, filed] of rows) {
        const s = symOf.get(cu)
        if (!s) continue
        if (!books.has(cik)) books.set(cik, new Map())
        const b = books.get(cik)
        const o = b.get(s)
        if (o) { o.shares += shares; o.value += value; if (filed < o.filed) o.filed = filed } else {
            b.set(s, { shares, value, filed })
            holders.set(s, (holders.get(s) ?? 0) + 1)
        }
    }
    return { books, holders }
}

/**
 * A quarter's bets: per filer that filed this quarter AND the one before (`filersPrev`) with a trusted unit (not 0),
 * each name at ≥ MIN_WEIGHT of its book V: NEW (not held the quarter before) or ADD (its dollar value up ADD_MIN× after
 * `priceRatio(symbol)` — the price move between the two quarter ends — is taken out). A name whose holders the quarter
 * before were under BREAK_MIN of this quarter's is a data break: no bets. → [{ cik, symbol, kind, weight, filed, N, V }].
 * Pure.
 */
export function betsOf({ cur, prev, filersCur, filersPrev, holdersCur, holdersPrev, priceRatio, period }) {
    const out = []
    for (const [cik, book] of cur.books) {
        const f = filersCur[cik], fp = filersPrev[cik]
        if (!f || !fp || f[3] === 0) continue
        const [, V, N] = f
        if (!(V > 0)) continue
        const before = prev.books.get(cik) ?? new Map()
        for (const [symbol, pos] of book) {
            const weight = pos.value / V
            if (!(weight >= MIN_WEIGHT)) continue
            if ((holdersPrev.get(symbol) ?? 0) < BREAK_MIN * (holdersCur.get(symbol) ?? 0)) continue
            const was = before.get(symbol)
            let kind = null
            if (!was || !(was.shares > 0)) kind = 'new'
            else {
                const r = priceRatio(symbol)
                if (r > 0 && was.value > 0 && pos.value / was.value / r >= ADD_MIN) kind = 'add'
            }
            if (kind) out.push({ cik, symbol, kind, weight, filed: pos.filed, N, V, period })
        }
    }
    return out
}

/** Is the filer CONCENTRATED — at most CONCENTRATED.maxN positions and a book of CONCENTRATED.minV+? Pure. */
export const isConcentrated = (bet) => bet.N <= CONCENTRATED.maxN && bet.V >= CONCENTRATED.minV

/**
 * Per key, the trade of the EARLIEST bet (entry day, then the key's order) — one trade per company per quarter per
 * group. `trades` [{ key, day, ... }]. Pure.
 */
export function firstPerKey(trades) {
    const by = new Map()
    for (const t of trades) { const o = by.get(t.key); if (!o || t.day < o.day) by.set(t.key, t) }
    return [...by.values()]
}

/** The mean with the best `frac` of the values left out (at least one when there are 20+). Pure. */
export function meanWithoutBest(xs, frac = 0.01) {
    if (!xs.length) return null
    const s = [...xs].sort((a, b) => a - b)
    const cut = xs.length >= 20 ? Math.max(1, Math.round(xs.length * frac)) : 0
    const kept = s.slice(0, s.length - cut)
    return kept.reduce((a, b) => a + b, 0) / kept.length
}

/** The median. Pure. */
export const median = _median
