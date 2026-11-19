// ECHO'S FILING EVIDENCE (docs/design/echo-pipeline.md, Steps 1–3) — what the SEC filings say about a link, read by
// code; what it MEANS is the scoring model's (Step 3).
//
//   namedIn        does the linked company's business filing name the origin (or the reverse)? — Step 2's evidence. Not a
//                  gate (Roy, 2026-11-19: Jabil, Flex, Sanmina name no customers); a label, and the cap on Exposure.
//   customerShare  the 10-K's major-customer disclosure (any customer above 10% of revenue): the share, when it names the
//                  origin — Step 3's Exposure, stated. ePlus: Cisco "approximately 29%"; ScanSource: "more than 10%".
//   supplySentences the doc's bottleneck language (capacity constrained, sold out, lead times, on allocation, record
//                  backlog, shortage) in the company's own recent filings, AS SENTENCES. The 2026-11-19 sample showed a
//                  keyword is not a finding — "short lead times" is the opposite, risk factors are hedged, boilerplate
//                  repeats every quarter, and a company quoting its SUPPLIERS' lead times is downstream of the
//                  bottleneck — so code collects, and the scoring model reads (Roy: "identifying a bottleneck can come
//                  from the LLM's reasoning too").
//
// Business filings only: a proxy (DEF 14A) names Cisco because a director worked there.

import { searchFullText, filingText, latestAnnualReport, cikFor } from '../providers/sec.provider.js'
import { logger } from './logger.service.js'

const LOG = '[echoFilings]'
export const BUSINESS_FORMS = ['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', '20-F', '40-F', '6-K']
export const SUPPLY_PHRASES = ['capacity constrained', 'capacity constraints', 'supply constrained', 'sold out', 'lead times',
    'lead time', 'on allocation', 'record backlog', 'shortage', 'shortages', 'tight supply', 'tightening supply']
const NAMED_YEARS = 3
const SUPPLY_MONTHS = 12
const SUPPLY_DOCS = 3
const SUPPLY_MAX = 8

const _deps = { search: searchFullText, text: filingText, annual: latestAnnualReport, cik: cikFor, now: () => new Date() }
export function _setDeps(d) { Object.assign(_deps, d) }

const SUFFIX = /\b(incorporated|inc|corporation|corp|company|co|limited|ltd|plc|holdings?|group|n\.?v|s\.?a|ag|se|llc|lp)\b\.?/gi
/** What other filers call a company, from its name: "Cisco Systems, Inc." → ["Cisco Systems"]. Pure. */
export function termsFor(name) {
    const base = String(name ?? '').replace(/[,]/g, ' ').replace(SUFFIX, ' ').replace(/[^\p{L}\p{N}&.' -]/gu, ' ').replace(/\s+/g, ' ').trim()
    return base.length >= 3 ? [base] : []
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The text's sentences that match `rx`, trimmed and deduplicated, at most `max`. Pure. */
export function sentencesWith(text, rx, max = 20) {
    const out = [], seen = new Set()
    for (const s of String(text ?? '').split(/(?<=[.!?])\s+(?=[A-Z(“"])/)) {
        if (!rx.test(s)) continue
        const t = s.trim().slice(0, 600)
        const key = t.toLowerCase().replace(/[^a-z]/g, '')
        if (seen.has(key)) continue
        seen.add(key)
        out.push(t)
        if (out.length >= max) break
    }
    return out
}

const HEDGE = /\b(may|might|could|cannot assure|no assurance|if we|risks? (?:of|that|related))\b/i
/** A sentence written as a risk ("may experience a shortage") rather than a statement. Pure. */
export const isHedged = (s) => HEDGE.test(s)

/**
 * The share of revenue a sentence gives the term, for the LATEST period (the first figure after the name): "represented
 * approximately 29%, 32% and 44%" → 0.29; "each constituted more than 10%" → 0.10, at least; a table row "Cisco
 * Systems, Inc 13 % 14 %" → 0.13. → `{ share, atLeast }` or null. Pure.
 */
export function shareIn(sentence, term) {
    const s = String(sentence ?? '')
    const at = s.search(new RegExp(esc(term), 'i'))
    if (at < 0) return null
    const pctOf = (x) => Math.round(Number(x) * 100) / 10000
    // "A, B, C and D contributed 19.9%, 16.3%, 10.7% and 10.5%, respectively": the term's place among the names is
    // its place among the figures (Fabrinet's 10-K; Cisco first there, but not always).
    if (/respectively/i.test(s)) {
        const firstPct = s.search(/\d{1,2}(?:\.\d+)?\s?(%|percent)/i)
        if (firstPct > at) {
            // "Cisco Systems, Inc., NVIDIA …" splits a suffix off as its own part ("Inc.", or "Inc. contributed" at the end).
            const SUFFIX_ONLY = /^(inc|corp|corporation|ltd|limited|llc|plc|co|company|n\.?v|s\.?a|ag)\.?(\s|$)/i
            const names = s.slice(0, firstPct).split(/,\s*(?:and\s+)?|\s+and\s+/).map(x => x.trim()).filter(x => x && !SUFFIX_ONLY.test(x))
            const idx = names.findIndex(x => new RegExp(esc(term), 'i').test(x))
            const figs = [...s.slice(firstPct).matchAll(/(\d{1,2}(?:\.\d+)?)\s?(?:%|percent)/gi)].map(m => m[1])
            // The names before the figures include the sentence's lead-in ("During fiscal year 2026"): count from the
            // end, where the list sits against its figures.
            const fromEnd = names.length - 1 - idx
            const k = figs.length - 1 - fromEnd
            if (idx >= 0 && k >= 0 && k < figs.length && names.length >= figs.length) return { share: pctOf(figs[k]), atLeast: false }
        }
    }
    const after = s.slice(at, at + 400)
    const bound = /(more than|greater than|in excess of|over|at least|exceed(?:ed|s)?)\s+(\d{1,2}(?:\.\d+)?)\s?(%|percent)/i.exec(after)
    const plain = /(\d{1,2}(?:\.\d+)?)\s?(%|percent)/i.exec(after)
    if (bound && (!plain || bound.index <= plain.index)) return { share: pctOf(bound[2]), atLeast: true }
    if (plain) return { share: pctOf(plain[1]), atLeast: false }
    return null
}

const quote = (terms) => terms.map(t => `"${String(t).replace(/"/g, '')}"`).join(' OR ')
const yearsAgo = (n) => { const d = _deps.now(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10) }
const monthsAgo = (n) => { const d = _deps.now(); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10) }

/**
 * Does `ticker`'s business filing name any of `terms` (the last 3 years)? → `{ named, filings: [{ form, date, url }],
 * excerpt }`, `named: null` when it could not be read (no SEC filer, or EDGAR failed). Never throws.
 */
export async function namedIn(ticker, terms) {
    const ts = (terms ?? []).filter(Boolean)
    if (!ts.length) return { named: null, filings: [], excerpt: null }
    try {
        const filer = await _deps.cik(ticker)
        if (!filer) return { named: null, filings: [], excerpt: null, reason: 'not an SEC filer' }
        const hits = await _deps.search(quote(ts), { cik: filer.cik, forms: BUSINESS_FORMS, since: yearsAgo(NAMED_YEARS) })
        if (!hits.length) return { named: false, filings: [], excerpt: null }
        const rx = new RegExp(`\\b(${ts.map(esc).join('|')})\\b`, 'i')
        let excerpt = null
        try { excerpt = sentencesWith(await _deps.text(hits[0].url), rx, 1)[0] ?? null } catch { /* the hit stands without its sentence */ }
        return { named: true, filings: hits.slice(0, 5).map(({ form, date, url }) => ({ form, date, url })), excerpt }
    } catch (err) {
        logger.warn(LOG, 'namedIn failed', { ticker, error: err.message })
        return { named: null, filings: [], excerpt: null, reason: err.message }
    }
}

/**
 * The 10-K's stated share of `ticker`'s revenue tied to `terms` (a customer, or a supplier whose products are a share
 * of sales — ScanSource's Cisco). → `{ share, atLeast, excerpt, form, date, url }`; `share: null` when the annual report
 * names no share for them. Never throws.
 */
export async function customerShare(ticker, terms) {
    const ts = (terms ?? []).filter(Boolean)
    if (!ts.length) return { share: null }
    try {
        const doc = await _deps.annual(ticker)
        if (!doc) return { share: null, reason: 'no annual report' }
        const text = await _deps.text(doc.url)
        const rx = new RegExp(`\\b(${ts.map(esc).join('|')})\\b`, 'i')
        for (const s of sentencesWith(text, rx, 40)) {
            if (!/%|percent/i.test(s)) continue
            const term = ts.find(t => new RegExp(esc(t), 'i').test(s))
            const got = shareIn(s, term)
            if (got && got.share > 0 && got.share < 1) return { ...got, excerpt: s, form: doc.form, date: doc.date, url: doc.url }
        }
        return { share: null, form: doc.form, date: doc.date, url: doc.url }
    } catch (err) {
        logger.warn(LOG, 'customerShare failed', { ticker, error: err.message })
        return { share: null, reason: err.message }
    }
}

/**
 * The doc's bottleneck language in `ticker`'s own business filings of the last 12 months, as sentences, newest filing
 * first, deduplicated across filings (a 10-Q repeats the last one's risk factors), hedged ones marked. → `{ sentences:
 * [{ text, hedged, form, date, url }], filings }`, `sentences: null` when it could not be read. Never throws.
 */
export async function supplySentences(ticker) {
    try {
        const filer = await _deps.cik(ticker)
        if (!filer) return { sentences: null, filings: 0, reason: 'not an SEC filer' }
        const hits = await _deps.search(quote(SUPPLY_PHRASES), { cik: filer.cik, forms: BUSINESS_FORMS, since: monthsAgo(SUPPLY_MONTHS) })
        const rx = new RegExp(`\\b(${SUPPLY_PHRASES.map(esc).join('|')})\\b`, 'i')
        const out = [], seen = new Set()
        for (const h of hits.slice(0, SUPPLY_DOCS)) {
            let text
            try { text = await _deps.text(h.url) } catch { continue }
            for (const s of sentencesWith(text, rx, 30)) {
                const key = s.toLowerCase().replace(/[^a-z]/g, '').slice(0, 160)
                if (seen.has(key)) continue
                seen.add(key)
                out.push({ text: s, hedged: isHedged(s), form: h.form, date: h.date, url: h.url })
            }
        }
        // Statements before risks: an assertion ("we have experienced increased lead times") is the evidence; a hedge
        // is kept only to fill the room.
        out.sort((a, b) => Number(a.hedged) - Number(b.hedged))
        return { sentences: out.slice(0, SUPPLY_MAX), filings: hits.length }
    } catch (err) {
        logger.warn(LOG, 'supplySentences failed', { ticker, error: err.message })
        return { sentences: null, filings: 0, reason: err.message }
    }
}

export const echoFilingsService = { namedIn, customerShare, supplySentences, termsFor }
