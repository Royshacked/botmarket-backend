// Financial Modeling Prep (FMP) fundamental & market-data provider.
//
// Grounds the portfolio agent (Atlas) in real data instead of model memory:
//  - get_fundamentals  → per-ticker fundamentals: sector, valuation, quality,
//    growth, AND (Starter plan) forward analyst consensus + valuation-plus
//    (EV/EBITDA, FCF yield) for stocks / sector look-through for ETFs.
//  - screen_candidates → cross-universe discovery (company-screener).
//  - get_macro_snapshot→ hard macro read: treasury curve, key economic
//    indicators, and today's sector rotation.
//  - getSectorSnapshot / getMarketMovers / getAnalystActions → the scanner's
//    (Argus) grounded discovery feeds: sector rotation, biggest gainers/losers/
//    most-active, and recent analyst upgrades/downgrades.
// Slow-moving data (fundamentals) is heavily cached; discovery/macro use short TTLs.
//
// PLAN NOTES (current key = Starter):
//  - Screener, analyst estimates/targets/grades, economic/treasury/sector data,
//    and ETF sector weightings are all unlocked (verified against the live key).
//  - Still Premium-locked (HTTP 402): full ETF constituent holdings, 13F
//    institutional ownership — don't build on those.
//  - Production use displaying this data to users needs FMP's Data Display &
//    Licensing agreement. Keep that in mind before shipping.

import { getDb } from './mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { compactMoney } from '../services/format.util.js'
import { createTtlCache } from '../services/ttlCache.util.js'
import { getJson } from '../services/http.util.js'

const LOG     = '[fmp]'
const BASE    = 'https://financialmodelingprep.com/stable'
const API_KEY = process.env.FMP_API_KEY

// ─── Two-layer cache (in-process Map over Mongo) ────────────────────────────
// Fundamentals barely move (quarterly), so a long TTL is fine. The Mongo layer
// survives nodemon restarts so dev reloads don't re-burn the daily quota.
const COLLECTION  = 'fmp_fundamentals_cache'
const TTL_MS      = 24 * 60 * 60 * 1000   // 24h
const MEM_MAX     = 500
const _mem        = createTtlCache({ ttlMs: TTL_MS, max: MEM_MAX }) // SYMBOL -> { asOf: ISO, text: string }

async function _readCache(symbol) {
    const hit = _mem.get(symbol)
    if (hit) return hit

    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ symbol })
        if (doc && Date.now() - doc.fetchedAt < TTL_MS) {
            const entry = { asOf: doc.asOf, text: doc.text }
            _mem.set(symbol, entry)
            return entry
        }
    } catch (err) {
        logger.warn(LOG, 'Mongo cache read failed', err.message)
    }
    return null
}

async function _writeCache(symbol, entry) {
    _mem.set(symbol, { asOf: entry.asOf, text: entry.text })
    try {
        const db = await getDb()
        await db.collection(COLLECTION).updateOne(
            { symbol },
            { $set: { symbol, ...entry } },
            { upsert: true }
        )
    } catch (err) {
        logger.warn(LOG, 'Mongo cache write failed', err.message)
    }
}

// ─── FMP HTTP ───────────────────────────────────────────────────────────────
async function _fmpGet(path) {
    if (!API_KEY) throw new Error('FMP_API_KEY is not set')
    const sep = path.includes('?') ? '&' : '?'
    return getJson(`${BASE}${path}${sep}apikey=${API_KEY}`, { label: `FMP ${path} → HTTP` })
}

// ─── Formatting helpers ─────────────────────────────────────────────────────
const num  = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : null)
const pct  = (v, d = 1) => (Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(d)}%` : null)
const money = compactMoney
const line = (label, val) => (val != null ? `${label}: ${val}` : null)

/**
 * Top sector sleeves of an ETF as LLM-ready lines, e.g. "Technology 32.1%".
 * `weightPercentage` from FMP is ALREADY a percent number (e.g. 9.92), not a
 * ratio — display as-is. Pure — exported for testing.
 */
export function formatEtfSectorWeights(weights, topN = 6) {
    const rows = (Array.isArray(weights) ? weights : [])
        .map(w => ({ sector: w?.sector, pct: Number(w?.weightPercentage) }))
        .filter(w => w.sector && Number.isFinite(w.pct))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, topN)
    if (!rows.length) return []
    return ['— Sector exposure (look-through) —', ...rows.map(r => `${r.sector}: ${r.pct.toFixed(1)}%`)]
}

function _formatEtf(symbol, p, sectorWeights = []) {
    // FMP's top-level sector/industry for funds is unreliable (e.g. SPY →
    // "Financial Services"), so we surface the real look-through weights instead.
    return [
        `${symbol} — ${p.companyName || 'ETF'} (ETF / fund)`,
        line('Exchange', p.exchange || p.exchangeFullName),
        line('AUM (market cap)', money(p.marketCap)),
        line('Beta', num(p.beta)),
        line('Price', money(p.price)),
        ...formatEtfSectorWeights(sectorWeights),
        'Note: ETFs have no company financial statements; this is exposure/profile data only.',
        p.description ? `About: ${String(p.description).slice(0, 280)}` : null,
    ].filter(Boolean).join('\n')
}

/**
 * Forward analyst view as LLM-ready lines: consensus price target (+ upside vs
 * the given price) and the buy/hold/sell rating split. Both inputs optional —
 * returns only the lines it can build. Pure — exported for testing.
 */
export function formatAnalystBlock(price, ptc, grades) {
    const out = []
    const tgt = Number(ptc?.targetConsensus)
    if (Number.isFinite(tgt) && tgt > 0) {
        const px = Number(price)
        const up = Number.isFinite(px) && px > 0 ? (tgt - px) / px : null
        out.push(`Price target (consensus): ${money(tgt)}${up != null ? ` (${up >= 0 ? '+' : ''}${(up * 100).toFixed(0)}% vs price)` : ''}`)
    }
    if (grades) {
        const buy  = (Number(grades.strongBuy) || 0) + (Number(grades.buy) || 0)
        const hold = Number(grades.hold) || 0
        const sell = (Number(grades.sell) || 0) + (Number(grades.strongSell) || 0)
        const total = buy + hold + sell
        if (total > 0) out.push(`Analyst ratings: ${grades.consensus || '—'} (${buy} buy / ${hold} hold / ${sell} sell, ${total} analysts)`)
    }
    return out.length ? ['— Analyst view (forward) —', ...out] : []
}

/**
 * Liquidity + float lines for the risk/sizing read (Phase 3). `freeFloat` from FMP
 * is a PERCENT number (95.9 = 95.9%), not a ratio. Returns an array of lines (may be
 * empty). Pure — exported for testing.
 */
export function formatLiquidityFloat(profile = {}, floatRow = null) {
    const px   = Number(profile?.price)
    const avgV = Number(profile?.averageVolume)
    const out  = []
    if (Number.isFinite(avgV) && avgV > 0) {
        out.push(line('Avg volume', avgV.toLocaleString('en-US')))
        if (Number.isFinite(px) && px > 0) out.push(line('Avg $ volume', money(px * avgV)))
    }
    const ff = Number(floatRow?.freeFloat)
    if (Number.isFinite(ff)) {
        out.push(line('Free float', `${ff.toFixed(1)}%${ff < 25 ? ' — LOW float, elevated squeeze/gap risk; size down' : ''}`))
    }
    const fs = Number(floatRow?.floatShares)
    if (Number.isFinite(fs) && fs > 0) {
        const compact = fs >= 1e9 ? `${(fs / 1e9).toFixed(1)}B` : fs >= 1e6 ? `${(fs / 1e6).toFixed(0)}M` : fs.toLocaleString('en-US')
        out.push(line('Float shares', compact))
    }
    return out.filter(Boolean)
}

function _formatStock(symbol, p, ratios = {}, growth = {}, km = {}, ptc = null, grades = null, floatRow = null) {
    // FMP stable has no direct ROE in ratios-ttm; derive it from per-share figures.
    const roe = (Number(ratios.netIncomePerShareTTM) > 0 && Number(ratios.bookValuePerShareTTM) > 0)
        ? Number(ratios.netIncomePerShareTTM) / Number(ratios.bookValuePerShareTTM)
        : null
    const liq = formatLiquidityFloat(p, floatRow)
    return [
        `${symbol} — ${p.companyName || symbol}`,
        line('Sector / industry', [p.sector, p.industry].filter(Boolean).join(' / ') || null),
        line('Exchange', p.exchange || p.exchangeFullName),
        line('Market cap', money(p.marketCap)),
        line('Beta', num(p.beta)),
        ...(liq.length ? ['— Liquidity & float (risk / sizing) —', ...liq] : []),
        '— Valuation (TTM) —',
        line('P/E', num(ratios.priceToEarningsRatioTTM)),
        line('Price/Book', num(ratios.priceToBookRatioTTM)),
        line('Price/Sales', num(ratios.priceToSalesRatioTTM)),
        line('Dividend yield', pct(ratios.dividendYieldTTM)),
        line('EV/EBITDA', num(km.evToEBITDATTM)),
        line('EV/Sales', num(km.evToSalesTTM)),
        line('FCF yield', pct(km.freeCashFlowYieldTTM)),
        line('Earnings yield', pct(km.earningsYieldTTM)),
        line('ROIC', pct(km.returnOnInvestedCapitalTTM)),
        line('Net debt/EBITDA', num(km.netDebtToEBITDATTM)),
        '— Quality (TTM) —',
        line('Gross margin', pct(ratios.grossProfitMarginTTM)),
        line('Operating margin', pct(ratios.operatingProfitMarginTTM)),
        line('Net margin', pct(ratios.netProfitMarginTTM)),
        line('ROE (derived)', pct(roe)),
        line('Debt/Equity', num(ratios.debtToEquityRatioTTM)),
        line('Current ratio', num(ratios.currentRatioTTM)),
        '— Growth —',
        line('Revenue growth (latest FY)', pct(growth.revenueGrowth)),
        line('EPS growth (latest FY)', pct(growth.epsgrowth)),
        line('Net income growth (latest FY)', pct(growth.netIncomeGrowth)),
        line('Revenue/share 3y', pct(growth.threeYRevenueGrowthPerShare)),
        line('Revenue/share 5y', pct(growth.fiveYRevenueGrowthPerShare)),
        ...formatAnalystBlock(p.price, ptc, grades),
        p.description ? `About: ${String(p.description).slice(0, 280)}` : null,
    ].filter(Boolean).join('\n')
}

// ─── Sector lookup ──────────────────────────────────────────────────────────
// Lightweight profile cache keyed by symbol — stores only sector/industry so
// portfolioState.service can group positions by sector without re-fetching the
// full fundamentals blob. Shares the same 24h TTL as fundamentals.
const SECTOR_TTL_MS = 24 * 60 * 60 * 1000
const _sectorCache = createTtlCache({ ttlMs: SECTOR_TTL_MS }) // SYMBOL -> { sector, industry }

/**
 * Sector and industry for a ticker as raw strings, cached 24h.
 * Returns { sector, industry } or null when the ticker is unknown / ETF / foreign.
 */
export async function getSectorRaw(ticker) {
    const symbol = String(ticker || '').toUpperCase().trim()
    if (!symbol) return null

    const hit = _sectorCache.get(symbol)
    if (hit) return { sector: hit.sector, industry: hit.industry }

    try {
        const arr = await _fmpGet(`/profile?symbol=${symbol}`)
        const p   = Array.isArray(arr) ? arr[0] : null
        if (!p) return null
        const entry = { sector: p.sector || null, industry: p.industry || null }
        _sectorCache.set(symbol, entry)
        return { sector: entry.sector, industry: entry.industry }
    } catch {
        return null
    }
}

// ─── Earnings calendar (forward-looking) ────────────────────────────────────
// Short-TTL cache keyed by the date window; the calendar shifts daily as
// estimates/actuals land. Free plan exposes this (verified): each row carries
// symbol, date, epsEstimated and revenueEstimated.
const CAL_TTL_MS = 6 * 60 * 60 * 1000
const _calCache = createTtlCache({ ttlMs: CAL_TTL_MS, max: 50 }) // "from|to" -> rows

/**
 * Upcoming earnings between `from` and `to` (YYYY-MM-DD, max ~3-month window),
 * as an LLM-ready string. Optionally narrow to a set of symbols the agent is
 * already considering. Returns the soonest-first list, capped so the tool
 * result stays small.
 */
export async function getEarningsCalendar(from, to, symbols = []) {
    const today = new Date().toISOString().slice(0, 10)
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : today
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to)   ? to   : new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
    const key = `${f}|${t}`

    let rows
    const hit = _calCache.get(key)
    if (hit) {
        rows = hit
    } else {
        const arr = await _fmpGet(`/earnings-calendar?from=${f}&to=${t}`)
        rows = Array.isArray(arr) ? arr : []
        _calCache.set(key, rows)
    }

    const wanted = new Set(symbols.map(s => String(s).toUpperCase()))
    let filtered = wanted.size ? rows.filter(r => wanted.has(String(r.symbol).toUpperCase())) : rows
    filtered = filtered
        .filter(r => r.date)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, wanted.size ? 50 : 40)

    if (!filtered.length) {
        return wanted.size
            ? `No scheduled earnings for ${[...wanted].join(', ')} between ${f} and ${t}.`
            : `No earnings found between ${f} and ${t}.`
    }

    const lines = filtered.map(r => {
        const eps = r.epsEstimated != null ? `est EPS ${num(r.epsEstimated)}` : null
        const rev = r.revenueEstimated != null ? `est rev ${money(r.revenueEstimated)}` : null
        const extra = [eps, rev].filter(Boolean).join(', ')
        return `  ${r.date}  ${r.symbol}${extra ? ` — ${extra}` : ''}`
    })
    return [`Earnings calendar ${f} → ${t}${wanted.size ? ` (filtered to ${wanted.size} symbols)` : ''}:`, ...lines].join('\n')
}

/**
 * Raw upcoming earnings rows for programmatic use (not LLM-formatted).
 * Reuses the same cache as getEarningsCalendar.
 * Returns [{ symbol, date, epsEstimated, revenueEstimated }] filtered to the given symbols.
 */
export async function getEarningsCalendarRaw(from, to, symbols = []) {
    const today = new Date().toISOString().slice(0, 10)
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : today
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to)   ? to   : new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
    const key = `${f}|${t}`

    let rows
    const hit = _calCache.get(key)
    if (hit) {
        rows = hit
    } else {
        const arr = await _fmpGet(`/earnings-calendar?from=${f}&to=${t}`)
        rows = Array.isArray(arr) ? arr : []
        _calCache.set(key, rows)
    }

    const wanted = new Set(symbols.map(s => String(s).toUpperCase()))
    return (wanted.size ? rows.filter(r => wanted.has(String(r.symbol).toUpperCase())) : rows)
        .filter(r => r.date)
        .sort((a, b) => a.date.localeCompare(b.date))
}

// ─── Per-ticker earnings (next date + recent actual-vs-estimate) ────────────
// `/stable/earnings?symbol=` returns upcoming rows (epsActual null) AND historical quarters
// (epsActual populated), newest first — so one call covers both halves the LLM string needs.
const EARN_ROW_TTL_MS = 6 * 60 * 60 * 1000
const _earnRowCache = createTtlCache({ ttlMs: EARN_ROW_TTL_MS, max: 300 }) // SYMBOL -> text

/** Earnings summary for a ticker (next date + last 4 quarters actual vs estimate), LLM-ready. */
export async function getEarnings(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _earnRowCache.get(sym)
    if (hit) return hit

    let rows
    try {
        const arr = await _fmpGet(`/earnings?symbol=${sym}&limit=8`)
        rows = Array.isArray(arr) ? arr : []
    } catch (err) {
        return `No earnings data for ${sym}: ${err.message}`
    }
    if (!rows.length) return `No earnings data for ${sym}.`

    const today    = new Date().toISOString().slice(0, 10)
    const upcoming = rows.filter(r => r.date && r.date >= today && r.epsActual == null).sort((a, b) => a.date.localeCompare(b.date))
    const past     = rows.filter(r => r.epsActual != null).sort((a, b) => b.date.localeCompare(a.date))

    const lines = [`${sym} — earnings:`]
    const next  = upcoming[0]
    if (next) lines.push(`Next earnings: ${next.date}${next.epsEstimated != null ? ` (est EPS ${num(next.epsEstimated)})` : ''}`)
    if (past.length) {
        lines.push('Recent quarters (actual vs estimate):')
        for (const q of past.slice(0, 4)) {
            const a = num(q.epsActual), e = num(q.epsEstimated)
            const surp = (q.epsActual != null && q.epsEstimated != null && Number(q.epsEstimated) !== 0)
                ? ` (${(((q.epsActual - q.epsEstimated) / Math.abs(q.epsEstimated)) * 100).toFixed(1)}% surprise)`
                : ''
            lines.push(`  ${q.date}: actual ${a ?? 'n/a'} vs est ${e ?? 'n/a'}${surp}`)
        }
    }
    const text = lines.join('\n')
    _earnRowCache.set(sym, text)
    return text
}

/**
 * Fundamentals for a ticker as an LLM-ready string. Profile is fetched first and
 * its `isEtf`/`isFund` flag decides the shape: stocks get valuation/quality/
 * growth; ETFs get exposure/profile only (and skip the empty statement calls).
 * Result is cached (24h) keyed by symbol.
 */
export async function getFundamentals(ticker) {
    const symbol = String(ticker || '').toUpperCase().trim()
    if (!symbol) return 'No ticker provided.'

    const cached = await _readCache(symbol)
    if (cached) return cached.text

    const profileArr = await _fmpGet(`/profile?symbol=${symbol}`)
    const p = Array.isArray(profileArr) ? profileArr[0] : null
    if (!p) return `No fundamentals found for ${symbol} (unknown or unsupported ticker on the FMP plan).`

    let text
    if (p.isEtf || p.isFund) {
        // Sector look-through is the useful extra for funds; tolerate its absence.
        const weightsArr = await _fmpGet(`/etf/sector-weightings?symbol=${symbol}`).catch(e => { logger.warn(LOG, `etf weights ${symbol}`, e.message); return [] })
        text = _formatEtf(symbol, p, Array.isArray(weightsArr) ? weightsArr : [])
    } else {
        // Extra calls only for company stocks; each tolerates partial failure so a
        // single locked/empty endpoint never sinks the whole fundamentals lookup.
        const [ratiosArr, growthArr, kmArr, ptcArr, gradesArr, floatArr] = await Promise.all([
            _fmpGet(`/ratios-ttm?symbol=${symbol}`).catch(e => { logger.warn(LOG, `ratios ${symbol}`, e.message); return [] }),
            _fmpGet(`/financial-growth?symbol=${symbol}&limit=1`).catch(e => { logger.warn(LOG, `growth ${symbol}`, e.message); return [] }),
            _fmpGet(`/key-metrics-ttm?symbol=${symbol}`).catch(e => { logger.warn(LOG, `keymetrics ${symbol}`, e.message); return [] }),
            _fmpGet(`/price-target-consensus?symbol=${symbol}`).catch(() => []),
            _fmpGet(`/grades-consensus?symbol=${symbol}`).catch(() => []),
            _fmpGet(`/shares-float?symbol=${symbol}`).catch(e => { logger.warn(LOG, `float ${symbol}`, e.message); return [] }),
        ])
        const first  = a => (Array.isArray(a) ? a[0] : a)
        text = _formatStock(symbol, p, first(ratiosArr) || {}, first(growthArr) || {}, first(kmArr) || {}, first(ptcArr) || null, first(gradesArr) || null, first(floatArr) || null)
    }

    const asOf = new Date().toISOString()
    await _writeCache(symbol, { text, asOf, fetchedAt: Date.now() })
    logger.info(LOG, 'fundamentals fetched', { symbol, isEtf: !!(p.isEtf || p.isFund) })
    return text
}

// ─── Screener (cross-universe discovery) ────────────────────────────────────
// company-screener: the agent's Phase-4 discovery leg — find names that fit the
// mandate's shape (sector, size, quality proxies) instead of recalling tickers
// from memory. Short TTL keyed by the normalized filter set; the same screen run
// twice in a construction session shouldn't re-burn a call.
const SCREEN_TTL_MS = 30 * 60 * 1000
const _screenCache  = createTtlCache({ ttlMs: SCREEN_TTL_MS, max: 50 })

// Whitelisted screener params → their FMP query keys. Anything not here is
// ignored, so a hallucinated filter can't reach the API.
const SCREEN_PARAMS = {
    sector: 'sector', industry: 'industry', country: 'country', exchange: 'exchange',
    marketCapMoreThan: 'marketCapMoreThan', marketCapLowerThan: 'marketCapLowerThan',
    priceMoreThan: 'priceMoreThan', priceLowerThan: 'priceLowerThan',
    betaMoreThan: 'betaMoreThan', betaLowerThan: 'betaLowerThan',
    dividendMoreThan: 'dividendMoreThan', volumeMoreThan: 'volumeMoreThan',
    isEtf: 'isEtf',
}

/** One-line " (Technology, mcap>$10B)" suffix describing the applied filters. */
function _describeFilters(f) {
    const parts = []
    if (f.sector)   parts.push(f.sector)
    if (f.industry) parts.push(f.industry)
    if (f.country)  parts.push(f.country)
    if (f.marketCapMoreThan)  parts.push(`mcap>${money(f.marketCapMoreThan)}`)
    if (f.marketCapLowerThan) parts.push(`mcap<${money(f.marketCapLowerThan)}`)
    if (f.dividendMoreThan)   parts.push(`div>${f.dividendMoreThan}`)
    if (f.isEtf === true || f.isEtf === 'true') parts.push('ETFs')
    return parts.length ? ` (${parts.join(', ')})` : ''
}

/** Screener rows → LLM-ready list, one compact line per name. Pure — exported for testing. */
export function formatScreenerRows(rows, filters = {}) {
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return `No stocks matched the screen${_describeFilters(filters)}.`
    const lines = list.map(r => {
        const kind = r.isEtf ? 'ETF' : r.isFund ? 'Fund' : null
        const si   = [r.sector, r.industry].filter(Boolean).join(' / ')
        const px   = Number(r.price)
        const dv   = Number(r.lastAnnualDividend)
        const bits = [
            `${String(r.symbol || '?').padEnd(6)} ${r.companyName || ''}`.trim(),
            kind || null,
            si || null,
            money(r.marketCap) ? `mcap ${money(r.marketCap)}` : null,
            Number.isFinite(Number(r.beta)) ? `β ${num(r.beta)}` : null,
            Number.isFinite(px) && px > 0 ? `$${num(px)}` : null,
            dv > 0 && px > 0 ? `div ${pct(dv / px)}` : null,
        ].filter(Boolean)
        return `  ${bits.join(' | ')}`
    })
    return [`Screen results${_describeFilters(filters)} — ${list.length} match${list.length === 1 ? '' : 'es'}:`, ...lines].join('\n')
}

/**
 * Screen the US universe by the whitelisted filters and return an LLM-ready list.
 * `filters` may include any SCREEN_PARAMS key plus `limit` (1–50, default 25).
 * Discovery only — the agent still qualifies each hit with get_fundamentals.
 */
export async function screenCandidates(filters = {}) {
    const f = filters && typeof filters === 'object' ? filters : {}
    const parts = []
    for (const [k, apiKey] of Object.entries(SCREEN_PARAMS)) {
        const v = f[k]
        if (v == null || v === '') continue
        parts.push(`${apiKey}=${encodeURIComponent(v)}`)
    }
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 25, 1), 50)
    parts.push(`limit=${limit}`)
    parts.push('isActivelyTrading=true')
    const qs  = parts.sort().join('&')   // sorted → stable cache key regardless of input order
    const hit = _screenCache.get(qs)
    if (hit) return hit

    const rows = await _fmpGet(`/company-screener?${qs}`)
    const text = formatScreenerRows(rows, f)
    _screenCache.set(qs, text)
    logger.info(LOG, 'screen', { filters: _describeFilters(f).trim(), matches: Array.isArray(rows) ? rows.length : 0 })
    return text
}

// ─── Macro snapshot (hard regime data) ──────────────────────────────────────
// Bundles the treasury curve, key economic indicators, and today's sector
// rotation into one LLM-ready read for Phase 2. One tool call, one cache entry —
// this is context that barely moves intraday, so a 1h TTL is plenty.
const MACRO_TTL_MS = 60 * 60 * 1000
const _macroCache  = createTtlCache({ ttlMs: MACRO_TTL_MS, max: 4 })
const ECON_INDICATORS = [
    ['Real GDP',           'realGDP'],
    ['CPI',                'CPI'],
    ['Inflation (YoY)',    'inflationRate'],
    ['Unemployment',       'unemploymentRate'],
    ['Fed funds rate',     'federalFunds'],
    ['Consumer sentiment', 'consumerSentiment'],
]

// The sector snapshot is pinned to a trading date; on weekends/holidays `date=today`
// returns 0 rows, so walk back up to a few days to the last day that actually has data.
// On a trading day back=0 hits immediately (one fetch); off-hours it finds Friday's close.
async function _fetchSectorSnapshot() {
    for (let back = 0; back <= 5; back++) {
        const d = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10)
        const arr = await _fmpGet(`/sector-performance-snapshot?date=${d}`).catch(e => { logger.warn(LOG, 'sector snapshot', e.message); return [] })
        if (Array.isArray(arr) && arr.length) return arr
    }
    return []
}

/** Assembled macro parts → LLM-ready snapshot. Pure — exported for testing. */
export function formatMacroSnapshot({ treasury = [], sectors = [], indicators = [] } = {}) {
    const sections = []

    const t = [...(Array.isArray(treasury) ? treasury : [])]
        .filter(r => r?.date)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
    if (t) {
        const g = k => (Number.isFinite(Number(t[k])) ? Number(t[k]) : null)
        const y2 = g('year2'), y10 = g('year10')
        const spread = (y2 != null && y10 != null) ? y10 - y2 : null
        const curve = [
            g('month3') != null ? `3M ${g('month3').toFixed(2)}%` : null,
            y2  != null ? `2Y ${y2.toFixed(2)}%`   : null,
            y10 != null ? `10Y ${y10.toFixed(2)}%` : null,
            g('year30') != null ? `30Y ${g('year30').toFixed(2)}%` : null,
        ].filter(Boolean).join('  ')
        const spreadLine = spread != null
            ? `  | 2s10s ${spread >= 0 ? '+' : ''}${(spread * 100).toFixed(0)}bp${spread < 0 ? ' (INVERTED)' : ''}`
            : ''
        sections.push(`Treasury curve (${t.date}): ${curve}${spreadLine}`)
    }

    const inds = (Array.isArray(indicators) ? indicators : []).filter(x => x && x.label)
    if (inds.length) {
        const fmtVal = (label, v) => {
            const n = Number(v)
            if (!Number.isFinite(n)) return String(v)
            return /rate|inflation|unemployment|fed/i.test(label)
                ? `${n.toFixed(2)}%`
                : n.toLocaleString('en-US', { maximumFractionDigits: 1 })
        }
        sections.push(`Key indicators:\n${inds.map(x => `  ${x.label}: ${fmtVal(x.label, x.value)}${x.date ? ` (as of ${x.date})` : ''}`).join('\n')}`)
    }

    const secs = (Array.isArray(sectors) ? sectors : [])
        .filter(s => s?.sector && Number.isFinite(Number(s.averageChange)))
        .sort((a, b) => Number(b.averageChange) - Number(a.averageChange))
    if (secs.length) {
        const fmt = s => `${s.sector} ${Number(s.averageChange) >= 0 ? '+' : ''}${Number(s.averageChange).toFixed(2)}%`
        const when = secs[0]?.date || 'today'
        const exch = secs[0]?.exchange ? `${secs[0].exchange}, ${when}` : when
        sections.push(`Sector move (${exch}) — leaders: ${secs.slice(0, 3).map(fmt).join(', ')}; laggards: ${secs.slice(-3).reverse().map(fmt).join(', ')}`)
    }

    if (!sections.length) return 'Macro snapshot unavailable right now — fall back to web_search.'
    return ['MACRO SNAPSHOT (hard data — pair with web_search for the narrative):', ...sections].join('\n')
}

/**
 * Fetch + assemble the raw macro parts { treasury, sectors, indicators } once, cached 1h.
 * Both the LLM snapshot (getMacroSnapshot) and the structured read (getMacroRaw) format
 * from these same parts, so they share a single set of FMP round-trips.
 */
async function _macroParts() {
    const hit = _macroCache.get('parts')
    if (hit) return hit

    const today = new Date().toISOString().slice(0, 10)
    const from  = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10)
    const [treasuryArr, sectorArr, ...indArrs] = await Promise.all([
        _fmpGet(`/treasury-rates?from=${from}&to=${today}`).catch(e => { logger.warn(LOG, 'treasury', e.message); return [] }),
        _fetchSectorSnapshot(),
        ...ECON_INDICATORS.map(([, name]) => _fmpGet(`/economic-indicators?name=${name}`).catch(() => [])),
    ])
    const indicators = ECON_INDICATORS.map(([label], i) => {
        const row = Array.isArray(indArrs[i]) ? indArrs[i][0] : null
        return row ? { label, value: row.value, date: row.date } : null
    }).filter(Boolean)

    const parts = {
        treasury:  Array.isArray(treasuryArr) ? treasuryArr : [],
        sectors:   Array.isArray(sectorArr)   ? sectorArr   : [],
        indicators,
    }
    _macroCache.set('parts', parts)
    logger.info(LOG, 'macro parts', { indicators: indicators.length, hasTreasury: parts.treasury.length > 0 })
    return parts
}

/** Treasury curve + key economic indicators + today's sector rotation, LLM-ready. Cached 1h. */
export async function getMacroSnapshot() {
    return formatMacroSnapshot(await _macroParts())
}

// ─── Sector snapshot (rotation discovery) ───────────────────────────────────
// Just today's sector rotation, leaders→laggards — the discovery read for the
// scanner's sector-rotation angle (screen inside the leading groups) and the
// sector leg of its relative-strength check. Reuses the macro parts cache, so it
// costs nothing extra when get_macro_snapshot already ran this hour.

/** Sector rows → leaders-first rotation list, LLM-ready. Pure — exported for testing. */
export function formatSectorSnapshot(sectors = []) {
    const secs = (Array.isArray(sectors) ? sectors : [])
        .filter(s => s?.sector && Number.isFinite(Number(s.averageChange)))
        .sort((a, b) => Number(b.averageChange) - Number(a.averageChange))
    if (!secs.length) return 'Sector snapshot unavailable right now — fall back to get_quotes on the sector ETFs (XLK/XLE/XLF/XLV/XLY…).'
    const fmt  = s => `  ${String(s.sector).padEnd(24)} ${Number(s.averageChange) >= 0 ? '+' : ''}${Number(s.averageChange).toFixed(2)}%`
    const when = secs[0]?.date || 'today'
    const exch = secs[0]?.exchange ? `${secs[0].exchange}, ${when}` : when
    return [`Sector rotation (${exch}) — leaders first; screen inside the groups aligned with your thesis:`, ...secs.map(fmt)].join('\n')
}

/** Today's sector rotation (all sectors, leaders→laggards), LLM-ready. Cached 1h (shares the macro parts cache). */
export async function getSectorSnapshot() {
    const { sectors } = await _macroParts()
    return formatSectorSnapshot(sectors)
}

// ─── Market movers (momentum discovery) ─────────────────────────────────────
// biggest-gainers / biggest-losers / most-actives — the momentum / gap / "what's
// moving" starting pool for the scanner's Phase-2 discovery. These shift through
// the session, so a short TTL; one cache entry per kind.
const MOVERS_TTL_MS = 5 * 60 * 1000
const _moversCache  = createTtlCache({ ttlMs: MOVERS_TTL_MS, max: 6 })
const MOVER_KINDS = {
    gainers: ['biggest-gainers', 'Top gainers'],
    losers:  ['biggest-losers',  'Top losers'],
    active:  ['most-actives',    'Most active'],
}

/** Mover rows → compact LLM-ready list. Pure — exported for testing. */
export function formatMovers(kind, rows, limit = 20) {
    const label = MOVER_KINDS[kind]?.[1] || 'Movers'
    const list  = (Array.isArray(rows) ? rows : []).slice(0, Math.max(1, limit))
    if (!list.length) return `No ${label.toLowerCase()} available right now.`
    const lines = list.map(r => {
        const px   = Number(r.price)
        const chgP = Number(r.changesPercentage)
        const bits = [
            `${String(r.symbol || '?').padEnd(6)} ${r.name || ''}`.trim(),
            r.exchange || null,
            Number.isFinite(px) && px > 0 ? `$${num(px)}` : null,
            Number.isFinite(chgP) ? `${chgP >= 0 ? '+' : ''}${chgP.toFixed(2)}%` : null,
        ].filter(Boolean)
        return `  ${bits.join(' | ')}`
    })
    return [`${label} (US, today) — top ${list.length}:`, ...lines].join('\n')
}

/**
 * Market movers for one kind ('gainers' | 'losers' | 'active'), LLM-ready. Cached 5m.
 * Discovery only — the raw momentum pool; the agent still qualifies each name.
 */
export async function getMarketMovers(kind = 'gainers', limit = 20) {
    const k = MOVER_KINDS[kind] ? kind : 'gainers'
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)
    let rows = _moversCache.get(k)
    if (!rows) {
        const arr = await _fmpGet(`/${MOVER_KINDS[k][0]}`)
        rows = Array.isArray(arr) ? arr : []
        _moversCache.set(k, rows)
    }
    return formatMovers(k, rows, n)
}

// ─── Analyst actions (rating-change discovery) ──────────────────────────────
// Recent upgrades / downgrades — a catalyst pool beyond earnings. With no symbols,
// the market-wide latest-changes feed (grades-latest-news) for "who moved" discovery;
// with symbols, each name's recent actions (grades) to validate a shortlist. Short
// TTL — ratings land through the day.
const GRADES_TTL_MS = 30 * 60 * 1000
const _gradesCache  = createTtlCache({ ttlMs: GRADES_TTL_MS, max: 60 })
const _actionTag = a => {
    const s = String(a || '').toLowerCase()
    if (s.includes('up'))   return '▲ upgrade'
    if (s.includes('down')) return '▼ downgrade'
    if (s.includes('init') || s.includes('coverage')) return '＋ initiate'
    return a ? String(a) : 'maintain'
}
const _gradeMove = r => (r.previousGrade && r.newGrade) ? ` (${r.previousGrade}→${r.newGrade})` : (r.newGrade ? ` (→${r.newGrade})` : '')

/** Bulk recent rating changes (grades-latest-news) → LLM-ready. Pure — exported for testing. */
export function formatAnalystActionsBulk(rows, limit = 25) {
    const list = (Array.isArray(rows) ? rows : [])
        .filter(r => r?.symbol)
        .sort((a, b) => String(b.publishedDate || '').localeCompare(String(a.publishedDate || '')))
        .slice(0, Math.max(1, limit))
    if (!list.length) return 'No recent analyst rating changes available.'
    const lines = list.map(r => `  ${String(r.publishedDate || '').slice(0, 10)}  ${String(r.symbol).padEnd(6)} ${_actionTag(r.action)} by ${r.gradingCompany || '—'}${_gradeMove(r)}`)
    return ['Recent analyst rating changes (market-wide, newest first) — a catalyst pool; qualify each name before listing:', ...lines].join('\n')
}

/** Per-symbol recent rating actions (grades) → LLM-ready. Pure — exported for testing. */
export function formatAnalystActionsForSymbols(bySymbol = {}) {
    const entries = Object.entries(bySymbol).filter(([, rows]) => Array.isArray(rows) && rows.length)
    if (!entries.length) return 'No recent analyst rating actions for those symbols.'
    const blocks = entries.map(([sym, rows]) => {
        const recent = rows.slice(0, 4).map(r => `    ${r.date || '—'}  ${_actionTag(r.action)} by ${r.gradingCompany || '—'}${_gradeMove(r)}`)
        return [`  ${sym}:`, ...recent].join('\n')
    })
    return ['Analyst rating actions (recent, per name):', ...blocks].join('\n')
}

/**
 * Recent analyst rating changes. No symbols → the market-wide latest-changes feed
 * (discovery). Symbols → each name's recent actions (validation), capped to 12 names.
 * Cached 30m per key.
 */
export async function getAnalystActions(symbols = [], limit = 25) {
    const wanted = (Array.isArray(symbols) ? symbols : [])
        .map(s => String(s).toUpperCase().trim()).filter(Boolean)

    if (wanted.length) {
        const bySymbol = {}
        await Promise.all(wanted.slice(0, 12).map(async sym => {
            let rows = _gradesCache.get(`sym:${sym}`)
            if (!rows) {
                const arr = await _fmpGet(`/grades?symbol=${sym}`).catch(() => [])
                rows = (Array.isArray(arr) ? arr : [])
                    .filter(r => r?.date)
                    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                    .slice(0, 8)
                _gradesCache.set(`sym:${sym}`, rows)
            }
            bySymbol[sym] = rows
        }))
        return formatAnalystActionsForSymbols(bySymbol)
    }

    const n = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 50)
    let rows = _gradesCache.get('bulk')
    if (!rows) {
        const arr = await _fmpGet('/grades-latest-news?page=0&limit=100').catch(() => [])
        rows = Array.isArray(arr) ? arr : []
        _gradesCache.set('bulk', rows)
    }
    return formatAnalystActionsBulk(rows, n)
}

// ─── Stock peers (the correlation-read peer set) ────────────────────────────
// FMP /stock-peers = the fundamental peer cohort (same sector / size). The value
// is the SYMBOL SET: the agent feeds the ones that matter into get_correlations
// to measure what the asset actually tracks — instead of guessing peers via search.
const PEERS_TTL_MS = 12 * 60 * 60 * 1000   // 12h — peer sets barely move
const _peersCache  = createTtlCache({ ttlMs: PEERS_TTL_MS, max: 300 })

/** Fundamental peer set for a ticker, LLM-ready. FMP /stock-peers. Cached 12h. */
export async function getStockPeers(ticker) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'No ticker provided.'

    const hit = _peersCache.get(sym)
    if (hit) return hit

    let rows
    try {
        const arr = await _fmpGet(`/stock-peers?symbol=${sym}`)
        rows = Array.isArray(arr) ? arr : []
    } catch (err) {
        return `No peer data for ${sym}: ${err.message}`
    }
    const text = formatPeers(sym, rows)
    _peersCache.set(sym, text)
    return text
}

/** Peer rows → one LLM-ready line (self excluded, capped). Pure — exported for testing. */
export function formatPeers(symbol, rows, topN = 10) {
    const sym   = String(symbol || '').toUpperCase().trim()
    const peers = (Array.isArray(rows) ? rows : [])
        .filter(r => r?.symbol && String(r.symbol).toUpperCase().trim() !== sym)
        .slice(0, topN)
    if (!peers.length) return `No fundamental peers found for ${sym}.`
    const list = peers.map(r => `${String(r.symbol).toUpperCase().trim()}${r.companyName ? ` (${r.companyName})` : ''}`).join(', ')
    return `${sym} fundamental peers (same sector/size cohort — feed the ones that matter into get_correlations to measure what it ACTUALLY tracks):\n${list}`
}

/**
 * Structured macro read for fingerprinting / trigger comparison (not LLM-formatted):
 * { asOf, spread2s10s, fedFunds, inflation, leaders[] }. Numbers are percent points;
 * leaders is today's top-3 sectors by move. Shares the getMacroSnapshot cache.
 */
export async function getMacroRaw() {
    const parts = await _macroParts()
    const t = [...parts.treasury].filter(r => r?.date).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
    const g = k => (t && Number.isFinite(Number(t[k])) ? Number(t[k]) : null)
    const y2 = g('year2'), y10 = g('year10')
    // Look up by the stable FMP indicator name, resolved to its display label via ECON_INDICATORS —
    // so renaming a display label there can't silently null these out.
    const labelFor = fmpName => ECON_INDICATORS.find(([, name]) => name === fmpName)?.[0]
    const ind = fmpName => {
        const x = parts.indicators.find(i => i.label === labelFor(fmpName))
        return x && Number.isFinite(Number(x.value)) ? Number(x.value) : null
    }
    const leaders = [...parts.sectors]
        .filter(s => s?.sector && Number.isFinite(Number(s.averageChange)))
        .sort((a, b) => Number(b.averageChange) - Number(a.averageChange))
        .slice(0, 3).map(s => s.sector)
    return {
        asOf:        t?.date ?? null,
        spread2s10s: (y2 != null && y10 != null) ? Number((y10 - y2).toFixed(2)) : null,
        fedFunds:    ind('federalFunds'),
        inflation:   ind('inflationRate'),
        leaders,
    }
}
