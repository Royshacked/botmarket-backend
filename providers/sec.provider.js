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

const LOG = '[sec]'
const UA  = process.env.SEC_USER_AGENT || 'ar2trade scanner roy.shacked@mail.huji.ac.il'

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
