// THE HOUSE SCAN'S CANDIDATE LIST — one industry's companies with the numbers Argus picks from
// (docs/design/house-research-chain.md step 3; Roy, 2026-10-23).
//
// DATA, not judgment. Every company of the sub-industry (rolling up when thin, the largestCompanies rule) above a
// liquidity floor, each with what the engine already stores about it: its own returns and their gap to the
// industry's, its beta to the industry basket (how much it moves when the industry moves), dollar volume, the
// trend; for the long-term book its return on capital, revenue growth and margin; the Street's forward EPS
// growth; insiders buying; the next report. Argus judges which carry Pythia's thesis — this only measures.
//
// "ALREADY MOVED" IS NOT A FILTER (Roy, 2026-10-23): momentum persists 3–12 months and a compounder keeps
// compounding, so the swing order leads with relative strength, not the laggards.
//
// ORDER, only when an industry is longer than POOL_MAX (Regional Banks: 256): the companies the assessment
// NAMED first, always; then by the book — swing: relative strength over 6 and 3 months; long term: return on
// capital, then forward EPS growth and revenue growth. Size is the tiebreaker. A missing number ranks low, not
// out: the company stays on the list with "n/a".
//
// Sources (the engine's database): gics_companies, daily_prices_recent (280 trading days, packed float32 or plain
// arrays — aether-engine signals/daily_prices.py), fin_statements (quarters), signal_estimate_snapshots,
// industry_insiders, daily_screener_stats (next earnings, the hotlist's universe only). A failed read leaves its
// numbers n/a; it never drops the industry.

import { getEngineDb } from './engineDb.js'
import { largestCompanies } from '../api/strategy/industryData.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[houseScan.candidates]'

/** The longest list Argus reads in one call. */
export const POOL_MAX = 40
/** Every company the sub-industry has — the largest industry (Regional Banks) is 256. */
const ALL = 1000
/** Sector 40 (Financials) is read on ROE: a bank's debt is its raw material, not its capital structure. */
const FINANCIALS = '40'
const DAYS = { m1: 21, m3: 63, m6: 126, m12: 252 }

const _io = {
    db: () => getEngineDb(),
    companies: (sub) => largestCompanies(sub, { limit: ALL }),
    // A company the assessment named from ANOTHER industry (second order, pythia-names.md) — on the list too.
    bySymbol: async (symbols) => {
        const db = await getEngineDb()
        return db.collection('gics_companies').find({ symbol: { $in: symbols }, stale: { $ne: true } }, { projection: { _id: 0, symbol: 1, name: 1, market_cap: 1, sub_industry: 1 } }).toArray()
    },
}
/** Test seam. */
export function _setCandidateIO(io) { Object.assign(_io, io) }

// ─── the daily window (pure) ─────────────────────────────────────────────────

/** The bytes of a stored field: the driver's BSON Binary (its buffer may run past `position`), raw bytes, or base64. */
function _u8(bin) {
    if (!bin) return null
    if (bin._bsontype === 'Binary') return bin.buffer.subarray(0, bin.position ?? bin.buffer.length)
    if (bin instanceof Uint8Array) return bin
    if (typeof bin === 'string') return Buffer.from(bin, 'base64')
    return null
}

/** One packed field → numbers: little-endian float32, NaN for a missing value → null. Pure. */
export function unpackFloats(bin) {
    const u8 = _u8(bin)
    if (!u8) return []
    const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
    const out = []
    for (let i = 0; i + 4 <= buf.length; i += 4) {
        const v = buf.readFloatLE(i)
        out.push(Number.isFinite(v) ? v : null)
    }
    return out
}

/** A daily_prices_recent document → `{ close: [], volume: [] }`, oldest first, either storage format. Pure. */
export function dailyRows(doc) {
    if (!doc) return { close: [], volume: [] }
    if (doc.format === 'packed') return { close: unpackFloats(doc.close), volume: unpackFloats(doc.volume) }
    return { close: (doc.close ?? []).map(v => (Number.isFinite(v) ? v : null)), volume: (doc.volume ?? []).map(v => (Number.isFinite(v) ? v : null)) }
}

const _ret = (close, n) => {
    const a = close.at(-1 - n), b = close.at(-1)
    return close.length > n && a > 0 && b > 0 ? b / a - 1 : null
}
const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

/** Daily simple returns, null where a bar is missing. Pure. */
export function dailyReturns(close) {
    const out = []
    for (let i = 1; i < close.length; i++) out.push(close[i] > 0 && close[i - 1] > 0 ? close[i] / close[i - 1] - 1 : null)
    return out
}

/** The equal-weight industry basket's daily returns, aligned from the END (every window ends on the same day). Pure. */
export function basketReturns(series) {
    const len = Math.max(0, ...series.map(s => s.length))
    const out = []
    for (let k = len; k >= 1; k--) {
        const xs = series.map(s => s[s.length - k]).filter(v => Number.isFinite(v))
        out.push(xs.length ? _mean(xs) : null)
    }
    return out
}

/** Beta of `r` to `m` over their common tail (at least 60 paired days, else null). Pure. */
export function beta(r, m) {
    const n = Math.min(r.length, m.length)
    const pairs = []
    for (let k = 1; k <= n; k++) {
        const a = r[r.length - k], b = m[m.length - k]
        if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b])
    }
    if (pairs.length < 60) return null
    const ma = _mean(pairs.map(p => p[0])), mb = _mean(pairs.map(p => p[1]))
    let cov = 0, varb = 0
    for (const [a, b] of pairs) { cov += (a - ma) * (b - mb); varb += (b - mb) ** 2 }
    return varb > 0 ? cov / varb : null
}

/** A company's price numbers from its daily window. Pure. */
export function priceStats({ close: c, volume }) {
    const last20 = []
    for (let k = 1; k <= Math.min(20, c.length); k++) {
        const p = c[c.length - k], v = volume[volume.length - k]
        if (p > 0 && v >= 0) last20.push(p * v)
    }
    const sma50 = c.length >= 50 ? _mean(c.slice(-50).filter(v => v > 0)) : null
    return {
        ret_1m: _ret(c, DAYS.m1), ret_3m: _ret(c, DAYS.m3), ret_6m: _ret(c, DAYS.m6), ret_12m: _ret(c, DAYS.m12),
        adv20_usd: last20.length >= 10 ? _mean(last20) : null,
        above_50d: sma50 && c.at(-1) > 0 ? c.at(-1) > sma50 : null,
    }
}

// ─── the business (pure) ──────────────────────────────────────────────────────

const _sum = (rows, pick) => {
    const xs = rows.map(pick).filter(v => Number.isFinite(v))
    return xs.length === rows.length && xs.length ? xs.reduce((s, x) => s + x, 0) : null
}

/**
 * Trailing-12-month return on capital, revenue growth and operating margin from quarters (newest first).
 * ROIC = operating income × (1 − the TTM tax rate, held to 0–35%, 21% when unmeasurable) over debt + equity − cash
 * at the last quarter; a financial reads ROE (net income over equity) in the same field. Pure.
 */
export function businessStats(quarters, { financial = false } = {}) {
    const q = (quarters ?? []).slice(0, 8)
    const ttm = q.slice(0, 4), prior = q.slice(4, 8)
    if (ttm.length < 4) return { roic: null, return_measure: financial ? 'roe' : 'roic', rev_growth: null, op_margin: null }
    const rev = _sum(ttm, d => d.is?.revenue)
    const revPrior = prior.length === 4 ? _sum(prior, d => d.is?.revenue) : null
    const op = _sum(ttm, d => d.is?.operatingIncome)
    const ni = _sum(ttm, d => d.is?.netIncome)
    const bs = ttm[0].bs ?? {}
    let roic = null
    if (financial) {
        roic = ni != null && bs.totalStockholdersEquity > 0 ? ni / bs.totalStockholdersEquity : null
    } else {
        const pre = _sum(ttm, d => d.is?.incomeBeforeTax), tax = _sum(ttm, d => d.is?.incomeTaxExpense)
        const rate = pre > 0 && tax != null ? Math.min(0.35, Math.max(0, tax / pre)) : 0.21
        const capital = (bs.totalDebt ?? 0) + (bs.totalStockholdersEquity ?? 0) - (bs.cashAndCashEquivalents ?? 0)
        roic = op != null && capital > 0 ? (op * (1 - rate)) / capital : null
    }
    return {
        roic, return_measure: financial ? 'roe' : 'roic',
        rev_growth: rev != null && revPrior > 0 ? rev / revPrior - 1 : null,
        op_margin: rev > 0 && op != null ? op / rev : null,
    }
}

/** The Street's EPS growth from the fiscal year in progress to the next, and how many analysts. Pure. */
export function estimateStats(snapshot, today) {
    const years = (snapshot?.years ?? []).filter(y => y.fy_end >= today).sort((a, b) => a.fy_end.localeCompare(b.fy_end))
    const [y0, y1] = years
    return {
        fwd_eps_growth: y0?.eps_avg > 0 && Number.isFinite(y1?.eps_avg) ? y1.eps_avg / y0.eps_avg - 1 : null,
        analysts: y1?.n_eps ?? y0?.n_eps ?? null,
    }
}

// ─── the order (pure) ─────────────────────────────────────────────────────────

/** Percentile of each value among the present ones (0 lowest … 1 highest); a missing value → 0. Pure. */
function _pct(rows, key) {
    const vals = rows.map(r => r[key]).filter(v => Number.isFinite(v)).sort((a, b) => a - b)
    return (r) => {
        const v = r[key]
        if (!Number.isFinite(v) || vals.length < 2) return 0
        let lo = 0
        while (lo < vals.length && vals[lo] < v) lo++
        return lo / (vals.length - 1)
    }
}

const BOOK_ORDER = {
    swing:     [['rel_6m', 2], ['rel_3m', 1]],
    long_term: [['roic', 2], ['fwd_eps_growth', 1], ['rev_growth', 1]],
}

/** The list, named first then by the book's score, size breaking ties; cut to `max`. Pure. */
export function orderCandidates(rows, book, { named = [], max = POOL_MAX } = {}) {
    const weights = BOOK_ORDER[book] ?? BOOK_ORDER.long_term
    const pcts = weights.map(([k, w]) => [_pct(rows, k), w])
    const total = weights.reduce((s, [, w]) => s + w, 0)
    const score = new Map(rows.map(r => [r.symbol, pcts.reduce((s, [p, w]) => s + p(r) * w, 0) / total]))
    const want = new Set(named.map(s => String(s).toUpperCase()))
    return [...rows]
        .map(r => ({ ...r, named: want.has(r.symbol), score: Number(score.get(r.symbol).toFixed(3)) }))
        .sort((a, b) => (b.named - a.named) || (b.score - a.score) || ((b.market_cap ?? 0) - (a.market_cap ?? 0)))
        .slice(0, max)
}

/** The liquidity floor for a book, in dollars traded a day. */
export function minAdv(book) {
    return book === 'swing' ? config.houseScanMinAdvSwing : config.houseScanMinAdvLong
}

// ─── the read ─────────────────────────────────────────────────────────────────

const _today = () => new Date().toISOString().slice(0, 10)

/**
 * One sub-industry's candidate list for a book. `sub` is the metrics node (readSubIndustry().sub); `named` the
 * companies the assessment named (kept even below the floor — Pythia's reason outranks a volume number, and
 * Argus sees why). → `{ rows, total, below_floor }`, rows ordered and cut to POOL_MAX; `{ rows: [] }` on a
 * failed company read.
 */
export async function industryCandidates(sub, book, { named = [], covered = new Set(), today = _today(), deps = _io } = {}) {
    let companies
    try { companies = (await deps.companies(sub)) ?? [] }
    catch (err) { logger.warn(LOG, 'company read failed', { code: sub?.code, error: err.message }); return { rows: [], total: 0, below_floor: 0 } }
    if (!companies.length) return { rows: [], total: 0, below_floor: 0 }
    const total = companies.length
    const own = new Set(companies.map(c => c.symbol))
    const outside = [...new Set(named.map(s => String(s).toUpperCase()))].filter(s => !own.has(s))
    if (outside.length) {
        const extra = await Promise.resolve(deps.bySymbol?.(outside)).catch(() => []) ?? []
        companies = [...companies, ...extra.map(c => ({ ...c, second_order: true }))]
    }
    const symbols = companies.map(c => c.symbol)
    const db = await deps.db()
    const read = async (label, fn) => {
        try { return await fn() } catch (err) { logger.warn(LOG, `${label} read failed — n/a`, { code: sub?.code, error: err.message }); return [] }
    }
    const [prices, quarters, estimates, screener, insiders, gics] = await Promise.all([
        read('prices', () => db.collection('daily_prices_recent').find({ symbol: { $in: symbols } }, { projection: { _id: 0, symbol: 1, format: 1, close: 1, volume: 1, last_date: 1 } }).toArray()),
        book === 'long_term'
            ? read('statements', () => db.collection('fin_statements').find({ symbol: { $in: symbols }, kind: 'quarter' }, { projection: { _id: 0, symbol: 1, date: 1, is: 1, bs: 1 } }).sort({ date: -1 }).toArray())
            : [],
        read('estimates', () => db.collection('signal_estimate_snapshots').find({ symbol: { $in: symbols } }, { projection: { _id: 0, symbol: 1, asof: 1, years: 1 } }).sort({ asof: -1 }).toArray()),
        read('earnings', () => db.collection('daily_screener_stats').find({ symbol: { $in: symbols } }, { projection: { _id: 0, symbol: 1, next_earnings: 1 } }).toArray()),
        read('insiders', () => db.collection('industry_insiders').find({ level: 'sub_industry', code: sub.code }, { projection: { _id: 0, asof: 1, 'insiders.top': 1 } }).sort({ asof: -1 }).limit(1).toArray()),
        read('sectors', () => db.collection('gics_companies').find({ symbol: { $in: symbols } }, { projection: { _id: 0, symbol: 1, sector_code: 1 } }).toArray()),
    ])

    const bySym = (rows) => { const m = new Map(); for (const r of rows) if (!m.has(r.symbol)) m.set(r.symbol, r); return m }
    const priceOf = bySym(prices), estOf = bySym(estimates), earnOf = bySym(screener), sectorOf = bySym(gics)
    const quartersOf = new Map()
    for (const q of quarters) { const l = quartersOf.get(q.symbol) ?? []; if (l.length < 8) l.push(q); quartersOf.set(q.symbol, l) }
    const buyers = new Set((insiders[0]?.insiders?.top ?? []).map(t => t.symbol))

    const windows = new Map(symbols.map(s => [s, dailyRows(priceOf.get(s))]))
    const returns = new Map([...windows].map(([s, w]) => [s, dailyReturns(w.close)]))
    // The industry is its OWN companies: a second-order name moves the basket and the median of nothing.
    const basket = basketReturns([...returns].filter(([s, r]) => own.has(s) && r.length).map(([, r]) => r))
    const stats = new Map([...windows].map(([s, w]) => [s, priceStats(w)]))
    const median = (k) => {
        const xs = [...stats].filter(([s]) => own.has(s)).map(([, x]) => x[k]).filter(v => Number.isFinite(v)).sort((a, b) => a - b)
        return xs.length ? xs[Math.floor(xs.length / 2)] : null
    }
    const ind3 = median('ret_3m'), ind6 = median('ret_6m')
    const rel = (v, i) => (Number.isFinite(v) && Number.isFinite(i) ? v - i : null)

    const want = new Set(named.map(s => String(s).toUpperCase()))
    const floor = minAdv(book)
    let belowFloor = 0
    const rows = []
    for (const c of companies) {
        const p = stats.get(c.symbol)
        const isNamed = want.has(c.symbol)
        if (!isNamed && !(p.adv20_usd >= floor)) { belowFloor++; continue }
        rows.push({
            symbol: c.symbol, name: c.name ?? null, market_cap: c.market_cap ?? null, covered: covered.has(c.symbol),
            ...(c.second_order ? { second_order: c.sub_industry ?? true } : {}),
            ...p, rel_3m: rel(p.ret_3m, ind3), rel_6m: rel(p.ret_6m, ind6),
            beta: beta(returns.get(c.symbol), basket),
            ...(book === 'long_term' ? businessStats(quartersOf.get(c.symbol), { financial: sectorOf.get(c.symbol)?.sector_code === FINANCIALS }) : {}),
            ...estimateStats(estOf.get(c.symbol), today),
            insiders_buying: buyers.has(c.symbol),
            next_earnings: earnOf.get(c.symbol)?.next_earnings ?? null,
        })
    }
    return { rows: orderCandidates(rows, book, { named, max: POOL_MAX }), total, below_floor: belowFloor, industry: { ret_3m: ind3, ret_6m: ind6 } }
}

// ─── as text, for Argus (pure) ───────────────────────────────────────────────

const _p = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : 'n/a')
const _usdM = (v) => (Number.isFinite(v) ? (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`) : 'n/a')

/** One candidate as a line. Pure. */
export function candidateLine(r) {
    const parts = [
        `${r.symbol} ${String(r.name ?? '').slice(0, 34)}`,
        `cap ${_usdM(r.market_cap)}`,
        `3m ${_p(r.ret_3m)} (vs industry ${_p(r.rel_3m)}) 6m ${_p(r.ret_6m)} (vs industry ${_p(r.rel_6m)}) 12m ${_p(r.ret_12m)}`,
        `beta to industry ${Number.isFinite(r.beta) ? r.beta.toFixed(2) : 'n/a'}`,
        `${r.above_50d == null ? '' : r.above_50d ? 'above' : 'below'} 50d`.trim(),
        `trades ${_usdM(r.adv20_usd)}/day`,
    ]
    if ('roic' in r) parts.push(`${r.return_measure === 'roe' ? 'ROE' : 'ROIC'} ${_p(r.roic)} rev growth ${_p(r.rev_growth)} op margin ${_p(r.op_margin)}`)
    parts.push(`Street EPS next FY ${_p(r.fwd_eps_growth)}${r.analysts ? ` (${r.analysts} analysts)` : ''}`)
    if (r.insiders_buying) parts.push('INSIDERS BUYING')
    if (r.next_earnings) parts.push(`reports ${r.next_earnings}`)
    if (r.named) parts.push(r.second_order ? `NAMED BY PYTHIA (second order — in ${r.second_order === true ? 'another industry' : r.second_order})` : 'NAMED BY PYTHIA')
    if (r.covered) parts.push('[OUR COVERAGE]')
    return parts.filter(Boolean).join(' | ')
}
