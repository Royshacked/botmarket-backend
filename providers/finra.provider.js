// FINRA — short interest and daily short volume, the ORIGINAL source both Massive and FMP redistribute (2026-10-25:
// the screener lab's short tests; Massive's plan answers five calls a minute, FMP's short endpoints are legacy-only).
//
// NO API KEY. Two public reads, both verified against the live service on 2026-10-25:
//
// 1. SHORT INTEREST — `POST api.finra.org/data/group/otcMarket/name/consolidatedShortInterest`. Twice a month, per
//    SETTLEMENT DATE (the 15th and the month's end, or the business day before), every symbol: shares short, the
//    previous figure, the average daily volume, days to cover. Paged at 5,000 records (`record-total` header — ~19k
//    symbols a date). It is PUBLISHED about seven business days after its settlement date: a backtest may only use a
//    figure from then (the caller's job — `SHORT_INTEREST_LAG_DAYS` says how long).
// 2. DAILY SHORT VOLUME — `cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt`, one pipe-delimited file a trading
//    day for the whole market (`Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market`), out the next morning.
//    It counts the trades FINRA's facilities report (the off-exchange and TRF prints), not every venue's: its "total"
//    is not the consolidated volume, so read the RATIO, never the shares.

import { getJson } from '../services/http.util.js'

const SI_URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest'
const SV_URL = (day) => `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${day.replaceAll('-', '')}.txt`
const PAGE = 5000

/** Calendar days from a settlement date to when its short interest is safe to have known (published ~7 business days on). */
export const SHORT_INTEREST_LAG_DAYS = 12

/** The settlement dates between `from` and `to` (YYYY-MM-DD), oldest first — read off one always-listed symbol. */
export async function shortInterestDates(from, to, { probe = 'AAPL', get = getJson } = {}) {
    const rows = await get(SI_URL, { method: 'POST', headers: { Accept: 'application/json' }, label: 'FINRA short-interest dates', timeoutMs: 30000,
        body: { limit: 500, fields: ['settlementDate'], compareFilters: [{ compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: probe }],
            dateRangeFilters: [{ fieldName: 'settlementDate', startDate: from, endDate: to }] } })
    return [...new Set((rows ?? []).map(r => r.settlementDate).filter(Boolean))].sort()
}

/**
 * Every symbol's short interest on one settlement date → `[{ symbol, settlement, short, previous, adv, dtc, change_pct }]`.
 * Paged until a page comes back short.
 */
export async function shortInterestOn(settlement, { get = getJson } = {}) {
    const out = []
    for (let offset = 0; ; offset += PAGE) {
        const rows = await get(SI_URL, { method: 'POST', headers: { Accept: 'application/json' }, label: 'FINRA short interest', timeoutMs: 60000,
            body: { limit: PAGE, offset, fields: ['symbolCode', 'settlementDate', 'currentShortPositionQuantity', 'previousShortPositionQuantity', 'averageDailyVolumeQuantity', 'daysToCoverQuantity', 'changePercent'],
                compareFilters: [{ compareType: 'EQUAL', fieldName: 'settlementDate', fieldValue: settlement }] } })
        for (const r of rows ?? []) {
            if (!r?.symbolCode) continue
            out.push({ symbol: String(r.symbolCode).toUpperCase(), settlement: r.settlementDate, short: r.currentShortPositionQuantity ?? null, previous: r.previousShortPositionQuantity ?? null,
                adv: r.averageDailyVolumeQuantity ?? null, dtc: r.daysToCoverQuantity ?? null, change_pct: r.changePercent ?? null })
        }
        if (!Array.isArray(rows) || rows.length < PAGE) return out
    }
}

/** The day's short-volume file, parsed → Map(symbol → { short, exempt, total }). Pure. */
export function parseShortVolume(text) {
    const out = new Map()
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const [date, symbol, short, exempt, total] = line.split('|')
        if (!/^\d{8}$/.test(date ?? '') || !symbol) continue
        out.set(symbol.toUpperCase(), { short: Number(short) || 0, exempt: Number(exempt) || 0, total: Number(total) || 0 })
    }
    return out
}

/**
 * One trading day's short volume for the whole market → Map(symbol → { short, exempt, total }); an empty Map on a
 * day with no file (a holiday answers 403/404). Three tries on a network failure.
 */
export async function shortVolumeOn(day, { fetchFn = fetch } = {}) {
    for (let k = 1; ; k++) {
        try {
            const res = await fetchFn(SV_URL(day), { signal: AbortSignal.timeout(30000) })
            if (res.status === 403 || res.status === 404) return new Map()
            if (!res.ok) throw new Error(`FINRA short volume ${day}: ${res.status}`)
            return parseShortVolume(await res.text())
        } catch (err) {
            if (k >= 3) throw err
            await new Promise(r => setTimeout(r, 2000 * k))
        }
    }
}

// ─── 3. DARK POOLS — the weekly ATS volume per symbol (2026-10-25, the lab's dark-pool test) ──────────────────────
// `POST api.finra.org/data/group/otcMarket/name/weeklySummary`, summaryTypeCode ATS_W_SMBL: per symbol per week, the
// shares and trades every ATS (alternative trading system — the "dark pools") reported. Weekly, not per print, and
// LATE: NMS Tier 1 names (the S&P 500, the Russell 1000) two weeks after the week, the rest four. Each row carries its
// own `initialPublishedDate`, the day it became public — what a backtest may know it from. ~12k rows a week, paged.
const ATS_URL = 'https://api.finra.org/data/group/otcMarket/name/weeklySummary'

/** Every symbol's ATS volume for the week starting `weekStart` (a Monday) → `[{ symbol, week, shares, trades, published, tier }]`. */
export async function atsWeek(weekStart, { get = getJson } = {}) {
    const bySym = new Map()
    for (let offset = 0; ; offset += PAGE) {
        const rows = await get(ATS_URL, { method: 'POST', headers: { Accept: 'application/json' }, label: 'FINRA ATS weekly', timeoutMs: 60000,
            body: { limit: PAGE, offset, fields: ['issueSymbolIdentifier', 'weekStartDate', 'totalWeeklyShareQuantity', 'totalWeeklyTradeCount', 'initialPublishedDate', 'tierIdentifier'],
                compareFilters: [{ compareType: 'EQUAL', fieldName: 'weekStartDate', fieldValue: weekStart }, { compareType: 'EQUAL', fieldName: 'summaryTypeCode', fieldValue: 'ATS_W_SMBL' }] } })
        for (const r of rows ?? []) {
            if (!r?.issueSymbolIdentifier) continue
            const s = String(r.issueSymbolIdentifier).toUpperCase(), cur = bySym.get(s)
            // One row a symbol; were there two, their volume adds and the later publication counts.
            if (cur) { cur.shares += r.totalWeeklyShareQuantity ?? 0; cur.trades += r.totalWeeklyTradeCount ?? 0; if (r.initialPublishedDate > cur.published) cur.published = r.initialPublishedDate; continue }
            bySym.set(s, { symbol: s, week: r.weekStartDate, shares: r.totalWeeklyShareQuantity ?? 0, trades: r.totalWeeklyTradeCount ?? 0, published: r.initialPublishedDate ?? null, tier: r.tierIdentifier ?? null })
        }
        if (!Array.isArray(rows) || rows.length < PAGE) return [...bySym.values()]
    }
}
