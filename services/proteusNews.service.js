// PROTEUS'S NEWS, PER NAME (docs/design/proteus.md §10.10, Roy 2026-11-17: "I want Proteus to also characterise this
// per name — if we see we learn nothing from it we will take it out"). The dated events around a name's moves, read
// with its weekly profile: SEC 8-Ks since 2016 (free), its earnings reports, analyst rating changes and price-target
// notes, insider purchases, and FMP headlines for the last ~3 months (the 5-minute bars' span). ~8 FMP calls a name,
// beside the bars' ~22. Each source on its own: a failed read leaves that source empty, never the profile.
//
// The pipes are the app's own: sec.provider (EDGAR), fmp.provider's fetchStockNews, fmpGet for the rest; the target
// note's direction is screenerLab.data's `targetRow`. The JUDGMENT — what the news says about the moves — is the
// engine's (`newsProfile`), counted from these.

import { get8kFilings } from '../providers/sec.provider.js'
import { fetchStockNews } from '../providers/fmp.provider.js'
import { fmpGet } from '../providers/fmp.price.provider.js'
import { targetRow } from './screenerLab.data.js'
import { logger } from './logger.service.js'

const LOG = '[proteusNews]'
const DAY = 86_400_000
/** How far back each source is read. */
export const NEWS_SPAN = Object.freeze({ secSince: '2016-01-01', headlineDays: 92, headlineWindowDays: 14, targetPages: 3, tries: 2, retryMs: 3_000 })

const _deps = {
    filings:   (sym) => get8kFilings(sym, { since: NEWS_SPAN.secSince }),
    reports:   (sym) => fmpGet(`/earnings?symbol=${encodeURIComponent(sym)}&limit=40`, { label: `FMP earnings ${sym}` }),
    grades:    (sym) => fmpGet(`/grades?symbol=${encodeURIComponent(sym)}`, { label: `FMP grades ${sym}` }),
    targets:   (sym, page) => fmpGet(`/price-target-news?symbol=${encodeURIComponent(sym)}&page=${page}&limit=100`, { label: `FMP targets ${sym}` }),
    insiders:  (sym) => fmpGet(`/insider-trading/search?symbol=${encodeURIComponent(sym)}&transactionType=P-Purchase&page=0&limit=100`, { label: `FMP insiders ${sym}` }),
    headlines: (sym, from, to) => fetchStockNews({ symbols: [sym], from, to, limit: 250 }),
}

const GENERIC = new Set(['american', 'first', 'general', 'united', 'national', 'international', 'global', 'energy', 'new', 'royal', 'southern', 'western', 'eastern', 'northern'])
const SUFFIX = new Set(['inc', 'corp', 'corporation', 'co', 'company', 'ltd', 'plc', 'holdings', 'holding', 'group', 'the', 'nv', 'sa', 'ag', 'llc', 'lp', 'class', 'de', 'incorporated', 'limited'])

/**
 * The pattern a headline that is ABOUT the company matches: its name's core (the SEC title less "Inc", "Corp" …) — the
 * first word when it is distinctive (≥ 5 letters, not "American" …), else the first two — or the ticker as "(LNG)" /
 * "$LNG". FMP tags industry stories with a ticker too ("LNG prices soar"), which are the industry's news. Pure.
 */
export function companyPattern(title, sym) {
    const words = String(title ?? '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(w => w && !SUFFIX.has(w) && w !== '&')
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const core = !words.length ? null : words[0].length >= 5 && !GENERIC.has(words[0]) ? esc(words[0]) : words.slice(0, 2).map(esc).join('[\\s-]?')
    const t = esc(String(sym ?? '').toUpperCase())
    return new RegExp([core ? `\\b${core}` : null, `\\(${t}\\)`, `\\$${t}\\b`].filter(Boolean).join('|'), 'i')
}

/** Settle one source: its value, or null (logged) when it failed every try (a dropped request is retried once). */
async function _one(sym, name, fn, sleep = (ms) => new Promise(r => setTimeout(r, ms))) {
    for (let t = 1; ; t++) {
        try { return await fn() } catch (err) {
            if (t >= NEWS_SPAN.tries) { logger.warn(LOG, `${sym} ${name} not read: ${err.message}`); return null }
            await sleep(NEWS_SPAN.retryMs)
        }
    }
}

/**
 * One name's news, compact: `{ title, filings, reports, grades, targets, insiders, headlines, headlines_from }`.
 * Dates are YYYY-MM-DD (ET for the filings' acceptance, the source's own for the rest); headlines carry their time.
 */
export async function fetchNameNews(symbol, { now = Date.now(), deps = _deps } = {}) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    const hFrom = now - NEWS_SPAN.headlineDays * DAY
    const [sec, reports, grades, targets, insiders, headlines] = await Promise.all([
        _one(sym, '8-Ks', () => deps.filings(sym)),
        _one(sym, 'reports', () => deps.reports(sym)),
        _one(sym, 'grades', () => deps.grades(sym)),
        _one(sym, 'targets', async () => {
            const out = []
            for (let p = 0; p < NEWS_SPAN.targetPages; p++) {
                const rows = (await deps.targets(sym, p)) ?? []
                out.push(...rows)
                if (rows.length < 100) break
            }
            return out
        }),
        _one(sym, 'insiders', () => deps.insiders(sym)),
        _one(sym, 'headlines', async () => {
            const out = []
            for (let to = now; to > hFrom; to -= NEWS_SPAN.headlineWindowDays * DAY) out.push(...((await deps.headlines(sym, Math.max(hFrom, to - NEWS_SPAN.headlineWindowDays * DAY), to)) ?? []))
            return out
        }),
    ])
    return {
        title: sec?.title ?? null,
        filings: (sec?.filings ?? []).map(f => ({ day: f.day, items: f.items })),
        reports: (reports ?? []).filter(r => r?.date && r.epsActual != null).map(r => ({ day: String(r.date).slice(0, 10), beat: r.epsEstimated == null ? null : r.epsActual >= r.epsEstimated })),
        grades: (grades ?? []).filter(g => g?.date && g.action && g.action !== 'maintain').map(g => ({ day: String(g.date).slice(0, 10), action: g.action })),
        targets: (targets ?? []).map(targetRow).filter(t => t?.[0] && t[1] > 0).map(([day, target, price, dir]) => ({ day, target, price, dir })),
        insiders: (insiders ?? []).filter(r => r?.transactionDate).map(r => ({ day: String(r.transactionDate).slice(0, 10) })),
        headlines: headlines == null ? null : [...new Map(headlines.filter(h => h?.publishedDate && h.title).map(h => [`${h.publishedDate}|${h.title}`, { at: h.publishedDate, title: h.title }])).values()],
        headlines_from: new Date(hFrom).toISOString().slice(0, 10),
    }
}
