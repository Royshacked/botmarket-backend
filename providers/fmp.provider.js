// Financial Modeling Prep (FMP) fundamentals provider.
//
// Used by the portfolio agent's `get_fundamentals` tool to ground instrument
// selection in real company data (margins, valuation, growth, sector) instead
// of model memory. Fundamentals change quarterly, so results are heavily cached.
//
// DEV / FREE-PLAN NOTES:
//  - The free "Basic" plan is fundamentals-only, ~250 calls/day, US-centric.
//  - It cannot screen/discover tickers — this is a per-ticker LOOKUP. The agent
//    generates candidates itself, then calls this to qualify them.
//  - ETFs have no company statements; only the /profile (exposure) is useful.
//  - Production use displaying this data to users needs a paid plan + FMP's
//    Data Display & Licensing agreement. Keep that in mind before shipping.

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

function _formatEtf(symbol, p) {
    // FMP's sector/industry for funds is unreliable (e.g. SPY → "Financial
    // Services"), so we don't surface it. ETFs carry no company statements.
    return [
        `${symbol} — ${p.companyName || 'ETF'} (ETF / fund)`,
        line('Exchange', p.exchange || p.exchangeFullName),
        line('AUM (market cap)', money(p.marketCap)),
        line('Beta', num(p.beta)),
        line('Price', money(p.price)),
        'Note: ETFs have no company financial statements; this is exposure/profile data only.',
        p.description ? `About: ${String(p.description).slice(0, 280)}` : null,
    ].filter(Boolean).join('\n')
}

function _formatStock(symbol, p, ratios = {}, growth = {}) {
    // FMP stable has no direct ROE in ratios-ttm; derive it from per-share figures.
    const roe = (Number(ratios.netIncomePerShareTTM) > 0 && Number(ratios.bookValuePerShareTTM) > 0)
        ? Number(ratios.netIncomePerShareTTM) / Number(ratios.bookValuePerShareTTM)
        : null
    return [
        `${symbol} — ${p.companyName || symbol}`,
        line('Sector / industry', [p.sector, p.industry].filter(Boolean).join(' / ') || null),
        line('Exchange', p.exchange || p.exchangeFullName),
        line('Market cap', money(p.marketCap)),
        line('Beta', num(p.beta)),
        '— Valuation (TTM) —',
        line('P/E', num(ratios.priceToEarningsRatioTTM)),
        line('Price/Book', num(ratios.priceToBookRatioTTM)),
        line('Price/Sales', num(ratios.priceToSalesRatioTTM)),
        line('Dividend yield', pct(ratios.dividendYieldTTM)),
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
        text = _formatEtf(symbol, p)
    } else {
        // Two extra calls only for company stocks; tolerate partial failure.
        const [ratiosArr, growthArr] = await Promise.all([
            _fmpGet(`/ratios-ttm?symbol=${symbol}`).catch(e => { logger.warn(LOG, `ratios ${symbol}`, e.message); return [] }),
            _fmpGet(`/financial-growth?symbol=${symbol}&limit=1`).catch(e => { logger.warn(LOG, `growth ${symbol}`, e.message); return [] }),
        ])
        const ratios = Array.isArray(ratiosArr) ? ratiosArr[0] : ratiosArr
        const growth = Array.isArray(growthArr) ? growthArr[0] : growthArr
        text = _formatStock(symbol, p, ratios || {}, growth || {})
    }

    const asOf = new Date().toISOString()
    await _writeCache(symbol, { text, asOf, fetchedAt: Date.now() })
    logger.info(LOG, 'fundamentals fetched', { symbol, isEtf: !!(p.isEtf || p.isFund) })
    return text
}
