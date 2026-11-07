// A COMPANY'S FUNDAMENTALS AS THEY WERE KNOWN ON A DAY — from SEC's XBRL companyfacts (free; FMP's quarterly statements
// are a premium tier, 2026-11-07). Roy, 2026-11-07: "stocks beating the S&P by 5% a quarter — from all aspects, not just
// reports" (screener-lab.md §39).
//
// Point in time by the FILING date: each period's value is the first one filed (a later restatement is not what the
// market saw), and a period counts only from the day its 10-Q / 10-K was filed. Q4 is rarely filed on its own: it is the
// fiscal year less its three quarters. Pure: companyfacts JSON in, numbers out.

const DAY_MS = 86_400_000
const _days = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS
const _pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (a / b - 1) * 100 : null)

/**
 * Revenue goes by several names, and a company can switch between them (GOOGL's 2024 quarters sit under one name as
 * filed in 2024 and under another as the comparatives filed in 2025): a period's FIRST filing under any name wins it,
 * and on the same filing day the earlier name in this list.
 */
export const REVENUE_CONCEPTS = Object.freeze([
    'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet', 'RevenuesNetOfInterestExpense',
])

const _isReport = (f) => /^10-[QK]/.test(String(f?.form ?? ''))

/** One concept's duration facts → `[[start, end, val, filed]]`, each period once at its FIRST filing. Pure. */
function _durations(units) {
    const by = new Map()
    for (const f of units ?? []) {
        if (!f?.start || !f?.end || !_isReport(f) || !Number.isFinite(f.val) || !f.filed) continue
        const k = `${f.start}|${f.end}`, cur = by.get(k)
        if (!cur || f.filed < cur[3]) by.set(k, [f.start, f.end, f.val, f.filed])
    }
    return [...by.values()]
}

/** Instant facts → `[[end, val, filed]]`, the values of one filing on one date summed (share classes). Pure. */
function _instants(units) {
    const by = new Map()
    for (const f of units ?? []) {
        if (!f?.end || !Number.isFinite(f.val) || !f.filed || !f.accn) continue
        const k = `${f.end}|${f.accn}`
        const cur = by.get(k) ?? { end: f.end, filed: f.filed, vals: new Set() }
        cur.vals.add(f.val)
        by.set(k, cur)
    }
    // Per date, the first filing's.
    const first = new Map()
    for (const r of by.values()) { const c = first.get(r.end); if (!c || r.filed < c.filed) first.set(r.end, r) }
    return [...first.values()].map(r => [r.end, [...r.vals].reduce((a, b) => a + b, 0), r.filed]).sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * companyfacts JSON → the compact rows the lab keeps: `{ rev, ni, eq, sh }` — `rev`/`ni` duration rows
 * `[start, end, val, filed]`, `eq`/`sh` instants `[end, val, filed]`. Shares from the cover page (dei), else the diluted
 * weighted average (a duration, kept at its end). Pure.
 */
export function compactFacts(json) {
    const g = json?.facts?.['us-gaap'] ?? {}, d = json?.facts?.dei ?? {}
    const rev = new Map()
    for (const c of REVENUE_CONCEPTS) for (const r of _durations(g[c]?.units?.USD)) { const k = `${r[0]}|${r[1]}`, cur = rev.get(k); if (!cur || r[3] < cur[3]) rev.set(k, r) }
    let sh = _instants(d.EntityCommonStockSharesOutstanding?.units?.shares)
    if (!sh.length) sh = _durations(g.WeightedAverageNumberOfDilutedSharesOutstanding?.units?.shares).map(([, end, val, filed]) => [end, val, filed]).sort((a, b) => a[0].localeCompare(b[0]))
    return { rev: [...rev.values()], ni: _durations(g.NetIncomeLoss?.units?.USD), eq: _instants(g.StockholdersEquity?.units?.USD), sh }
}

/**
 * Duration rows → the quarters `[{ end, val, filed }]`, oldest first: the ~3-month periods as filed, and each Q4 as its
 * fiscal year less the three quarters inside it (filed with the 10-K). Pure.
 */
export function quarterly(rows) {
    const q = new Map()
    for (const [start, end, val, filed] of rows ?? []) {
        const n = _days(start, end)
        if (n >= 80 && n <= 100 && !q.has(end)) q.set(end, { start, end, val, filed })
    }
    for (const [start, end, val, filed] of rows ?? []) {
        const n = _days(start, end)
        if (n < 350 || n > 380 || q.has(end)) continue
        const inside = [...q.values()].filter(x => x.start >= start && x.end < end)
        if (inside.length === 3) q.set(end, { start: inside.reduce((a, x) => (x.end > a ? x.end : a), start), end, val: val - inside.reduce((a, x) => a + x.val, 0), filed })
    }
    return [...q.values()].sort((a, b) => a.end.localeCompare(b.end)).map(({ end, val, filed }) => ({ end, val, filed }))
}

/** The sum of the four quarters ending at index `k`, if they are four consecutive (about a year end to end). Pure. */
function _ttm(qs, k) {
    if (k < 3) return null
    const four = qs.slice(k - 3, k + 1), span = _days(four[0].end, four[3].end)
    return span >= 250 && span <= 300 ? four.reduce((a, x) => a + x.val, 0) : null
}
const _lastKnown = (rows, day) => { let r = null; for (const x of rows) if (x[2] <= day && (!r || x[0] > r[0])) r = x; return r }

/**
 * The prepared series (`prepareFundamentals`) and a day's close → what was known that day:
 * `{ mcap_log, ps, earn_yield, book_mkt, rev_growth, margin, margin_chg, share_chg }`, each null when unknown. Pure.
 */
export function fundamentalsAt(f, day, close) {
    const out = { mcap_log: null, ps: null, earn_yield: null, book_mkt: null, rev_growth: null, margin: null, margin_chg: null, share_chg: null }
    if (!f || !(close > 0)) return out
    const rq = f.revQ.filter(x => x.filed <= day), nq = f.niQ.filter(x => x.filed <= day)
    const sh = _lastKnown(f.sh, day), eq = _lastKnown(f.eq, day)
    const mcap = sh?.[1] > 0 ? sh[1] * close : null
    const k = rq.length - 1, revTtm = _ttm(rq, k)
    if (k >= 0) {
        const yearAgo = rq.findLast(x => Math.abs(_days(x.end, rq[k].end) - 365) <= 20)
        out.rev_growth = yearAgo ? _pct(rq[k].val, yearAgo.val) : null
    }
    // Net income on the same quarters as the revenue.
    const niTtmAt = (end) => { const j = nq.findIndex(x => x.end === end); return j >= 0 ? _ttm(nq, j) : null }
    const niTtm = k >= 0 ? niTtmAt(rq[k].end) : null
    if (revTtm > 0 && niTtm != null) {
        out.margin = niTtm / revTtm * 100
        const r4 = k >= 4 ? _ttm(rq, k - 4) : null, n4 = k >= 4 ? niTtmAt(rq[k - 4].end) : null
        out.margin_chg = r4 > 0 && n4 != null ? out.margin - n4 / r4 * 100 : null
    }
    if (mcap > 0) {
        out.mcap_log = Math.log10(mcap)
        out.ps = revTtm > 0 ? mcap / revTtm : null
        out.earn_yield = niTtm != null ? niTtm / mcap * 100 : null
        out.book_mkt = eq ? eq[1] / mcap : null
    }
    if (sh) {
        const before = f.sh.filter(x => x[2] <= day && _days(x[0], sh[0]) >= 300 && _days(x[0], sh[0]) <= 430).at(-1)
        out.share_chg = before ? _pct(sh[1], before[1]) : null
    }
    return out
}

/** A jump between two share counts that is a split: within 3% of a whole ratio (2:1 … 20:1, 3:2) or its inverse. Pure. */
export function splitRatio(later, earlier) {
    if (!(later > 0) || !(earlier > 0)) return null
    const r = later / earlier, up = r >= 1 ? r : 1 / r
    const near = [1.5, ...Array.from({ length: 19 }, (_, n) => n + 2)].find(n => Math.abs(up / n - 1) <= 0.03)
    return near ? (r >= 1 ? near : 1 / near) : null
}

/**
 * Share counts on today's basis: the lab's bars are split-adjusted, so a count filed before a split is scaled by it
 * (else NVDA's market cap before June 2024 is a tenth of what it was). Each count keeps its own filing date. Pure.
 */
export function splitAdjusted(sh) {
    const out = (sh ?? []).map(x => [...x]).sort((a, b) => a[0].localeCompare(b[0]))
    let factor = 1
    for (let n = out.length - 2; n >= 0; n--) {
        // out[n + 1] is already on today's basis; its count as filed is that over the factor so far.
        const s = splitRatio(out[n + 1][1] / factor, out[n][1])
        if (s) factor *= s
        out[n][1] *= factor
    }
    return out
}

/** The compact rows → the series fundamentalsAt reads. Pure. */
export const prepareFundamentals = (c) => (c ? { revQ: quarterly(c.rev), niQ: quarterly(c.ni), eq: c.eq ?? [], sh: splitAdjusted(c.sh) } : null)
