// SEC EDGAR provider — free, official, no API key.
//
// Used by the scanner agent's `get_sec_filings` tool to ground "what actually
// dropped" in authoritative filings instead of model memory or scraped news:
//  - the most recent earnings-related filings (8-K item 2.02 = Results of
//    Operations, plus 10-Q / 10-K) with their filing dates, and
//  - a few headline XBRL facts (revenue / net income / EPS) from companyfacts.
//
// EDGAR requires a descriptive User-Agent and asks for <=10 req/s. Forward-
// looking earnings *dates* come from FMP; this is the "already filed" side.
//
// Endpoints:
//  - ticker→CIK map:  https://www.sec.gov/files/company_tickers.json  (long-lived)
//  - filings list:    https://data.sec.gov/submissions/CIK##########.json
//  - XBRL facts:      https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json

import { logger } from '../services/logger.service.js'
import { createTtlCache } from '../services/ttlCache.util.js'
import { getJson } from '../services/http.util.js'
import { config } from '../services/config.js'

const LOG = '[sec]'
const UA  = config.secUserAgent

// ─── ticker → CIK map (cached for the process; ~10k entries, rarely changes) ──
let _cikMap     = null   // { AAPL: { cik: '0000320193', title: 'Apple Inc.' } }
let _cikMapAt   = 0
const CIK_TTL_MS = 24 * 60 * 60 * 1000

async function _secGet(url) {
    return getJson(url, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
        label: `SEC ${url} → HTTP`,
    })
}

async function _getCikMap() {
    if (_cikMap && Date.now() - _cikMapAt < CIK_TTL_MS) return _cikMap
    const j = await _secGet('https://www.sec.gov/files/company_tickers.json')
    const map = {}
    for (const e of Object.values(j)) {
        if (e?.ticker) map[e.ticker.toUpperCase()] = { cik: String(e.cik_str).padStart(10, '0'), title: e.title }
    }
    _cikMap   = map
    _cikMapAt = Date.now()
    logger.info(LOG, 'CIK map loaded', { tickers: Object.keys(map).length })
    return map
}

// ─── submissions cache (short TTL — new filings appear intraday) ──────────────
const SUB_TTL_MS = 60 * 60 * 1000
const _subCache = createTtlCache({ ttlMs: SUB_TTL_MS, max: 300 }) // CIK -> data

async function _getSubmissions(cik) {
    const hit = _subCache.get(cik)
    if (hit) return hit
    const data = await _secGet(`https://data.sec.gov/submissions/CIK${cik}.json`)
    _subCache.set(cik, data)
    return data
}

const EARNINGS_FORMS = new Set(['8-K', '10-Q', '10-K', '6-K', '20-F'])

/**
 * Recent earnings-relevant SEC filings for a ticker, as an LLM-ready string.
 * Surfaces the latest 8-K (flagging item 2.02 "Results of Operations" — the
 * actual earnings release), 10-Q and 10-K with filing dates and links. Returns
 * a plain string ready to feed back as a tool result.
 */
export async function getSecFilings(ticker) {
    const symbol = String(ticker || '').toUpperCase().trim()
    if (!symbol) return 'No ticker provided.'

    let cikMap
    try { cikMap = await _getCikMap() }
    catch (err) { return `Could not load SEC company list: ${err.message}` }

    const entry = cikMap[symbol]
    if (!entry) return `${symbol}: no SEC filer found (foreign/OTC tickers and most ETFs are not in EDGAR's company list).`

    let sub
    try { sub = await _getSubmissions(entry.cik) }
    catch (err) { return `Could not load SEC filings for ${symbol}: ${err.message}` }

    const rec = sub?.filings?.recent
    if (!rec?.form?.length) return `${symbol} (${entry.title}): no recent filings found.`

    const rows = []
    for (let i = 0; i < rec.form.length && rows.length < 6; i++) {
        if (!EARNINGS_FORMS.has(rec.form[i])) continue
        const items   = rec.items?.[i] || ''
        const isEarn  = rec.form[i] === '8-K' && items.split(',').map(s => s.trim()).includes('2.02')
        const accNo   = (rec.accessionNumber?.[i] || '').replace(/-/g, '')
        const primary = rec.primaryDocument?.[i] || ''
        const url     = accNo ? `https://www.sec.gov/Archives/edgar/data/${Number(entry.cik)}/${accNo}/${primary}` : null
        rows.push({
            form: rec.form[i],
            date: rec.filingDate?.[i],
            tag:  isEarn ? ' [earnings release — item 2.02]' : (items ? ` [items ${items}]` : ''),
            url,
        })
    }

    if (!rows.length) return `${symbol} (${entry.title}): no recent earnings-type filings (8-K/10-Q/10-K).`

    const lines = rows.map(r => `  ${r.date}  ${r.form}${r.tag}${r.url ? `\n    ${r.url}` : ''}`)
    return [`${symbol} — ${entry.title} (CIK ${entry.cik}) — recent SEC filings:`, ...lines].join('\n')
}

/**
 * A company's 8-K filings since `since` (YYYY-MM-DD) — every one, with its items: the recent list plus the older pages
 * EDGAR splits off (`filings.files`, only those reaching past `since`). For Proteus's news profile (proteus.md §10.10).
 * → `{ cik, title, filings: [{ day, at, items }] }` oldest → newest, or null when the ticker is not an SEC filer.
 * Throws on a failed read (the caller decides).
 */
export async function get8kFilings(ticker, { since = '2016-01-01' } = {}) {
    const symbol = String(ticker || '').toUpperCase().trim()
    const entry = (await _getCikMap())[symbol]
    if (!entry) return null
    const out = []
    // `url` (Echo's 8-K intake reads the filing): the primary document, when EDGAR names it.
    const take = (f) => (f?.form ?? []).forEach((form, i) => {
        if ((form === '8-K' || form === '8-K/A') && f.filingDate[i] >= since) {
            const acc = String(f.accessionNumber?.[i] ?? '').replace(/-/g, '')
            const doc = f.primaryDocument?.[i]
            out.push({ day: f.filingDate[i], at: f.acceptanceDateTime?.[i] ?? null, items: f.items?.[i] ?? '', url: acc && doc ? `https://www.sec.gov/Archives/edgar/data/${Number(entry.cik)}/${acc}/${doc}` : null })
        }
    })
    const sub = await _getSubmissions(entry.cik)
    take(sub?.filings?.recent)
    for (const p of sub?.filings?.files ?? []) {
        if (p.filingTo < since) continue
        take(await _secGet(`https://data.sec.gov/submissions/${p.name}`))
    }
    return { cik: entry.cik, title: entry.title, filings: [...new Map(out.map(f => [`${f.day}|${f.at}|${f.items}`, f])).values()].sort((a, b) => a.day.localeCompare(b.day)) }
}

// ─── Echo's filing reads (docs/design/echo-pipeline.md, Steps 1–3) ─────────────────────────────────────────────────
// EDGAR full-text search (efts.sec.gov) answers "does X's filing name Y" and "which filings say *lead times*" across
// every form since 2001; the document itself is read for the sentence. Both are EDGAR's, under its 10-requests-a-second
// ask — the callers are a few names an event, never a sweep.

/** A ticker's SEC filer — `{ cik, title }` — or null (foreign / OTC / funds). Throws on a failed read. */
export async function cikFor(ticker) {
    return (await _getCikMap())[String(ticker || '').toUpperCase().trim()] ?? null
}

const FTS_TTL_MS = 6 * 60 * 60 * 1000
const _ftsCache = createTtlCache({ ttlMs: FTS_TTL_MS, max: 500 })

/**
 * EDGAR full-text search. `query` is EDGAR's syntax (quoted phrases, OR). `cik` narrows to one filer; `forms` is kept
 * here, after the answer (EDGAR's own form filter fails on long queries). → `[{ form, date, cik, url, names }]` newest
 * first, at most the first page (100). Throws on a failed read.
 */
export async function searchFullText(query, { cik = null, forms = null, since = null, until = null } = {}) {
    const p = new URLSearchParams({ q: query })
    if (cik) p.set('ciks', String(cik).padStart(10, '0'))
    if (since || until) {
        p.set('dateRange', 'custom')
        p.set('startdt', since ?? '2001-01-01')
        p.set('enddt', until ?? new Date().toISOString().slice(0, 10))
    }
    const url = `https://efts.sec.gov/LATEST/search-index?${p}`
    let j = _ftsCache.get(url)
    if (!j) { j = await _secGet(url); _ftsCache.set(url, j) }
    const want = forms ? new Set(forms) : null
    return (j?.hits?.hits ?? [])
        .map(h => {
            const [acc, file] = String(h._id ?? '').split(':')
            const filer = String(h._source?.ciks?.[0] ?? cik ?? '').replace(/^0+/, '')
            return {
                form: h._source?.form ?? null, date: h._source?.file_date ?? null, cik: filer,
                url: acc && file && filer ? `https://www.sec.gov/Archives/edgar/data/${filer}/${acc.replace(/-/g, '')}/${file}` : null,
                names: h._source?.display_names ?? [],
            }
        })
        .filter(h => h.url && (!want || want.has(h.form)))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
}

const DOC_TTL_MS = 24 * 60 * 60 * 1000
const _docCache = createTtlCache({ ttlMs: DOC_TTL_MS, max: 60 })

/** A filing document as plain text (tags out, entities out, one space). Cached a day. Throws on a failed read. */
export async function filingText(url) {
    const hit = _docCache.get(url)
    if (hit) return hit
    const html = await getJson(url, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' }, label: `SEC ${url} → HTTP`, as: 'text', timeoutMs: 30000,
    })
    const text = htmlToText(html)
    _docCache.set(url, text)
    return text
}

/** Pure: a filing's HTML → plain text. */
export function htmlToText(html) {
    return String(html ?? '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
        .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
        .replace(/&#\d+;|&#x[0-9a-f]+;|&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** A filer's latest annual report (10-K, else 20-F / 40-F) — `{ form, date, url }` or null. Throws on a failed read. */
export async function latestAnnualReport(ticker) {
    const entry = await cikFor(ticker)
    if (!entry) return null
    const rec = (await _getSubmissions(entry.cik))?.filings?.recent
    const i = (rec?.form ?? []).findIndex(f => f === '10-K' || f === '20-F' || f === '40-F')
    if (i < 0) return null
    const acc = String(rec.accessionNumber[i]).replace(/-/g, '')
    return { form: rec.form[i], date: rec.filingDate[i], url: `https://www.sec.gov/Archives/edgar/data/${Number(entry.cik)}/${acc}/${rec.primaryDocument[i]}` }
}
