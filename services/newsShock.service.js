// AFTER THE NEWS (Roy, 2026-10-26: "does news move stocks — run test A"). The move ON a news day is priced before anyone
// can act; the question is what is LEFT once it has happened. A SHOCK is a session that closed `min`% or more against SPY
// on `volMult`× its usual dollar volume. Bought at the NEXT session's open (all of the shock known by then), held 1 / 5 /
// 10 / 20 sessions, net of SPY and the cost (screenerLab trade). Split by direction, by a report on the day (or the day
// before — the bell is unknown), by size, and — where FMP's news reaches (about a year) — by what the headlines say.
// Drift = the next sessions go the shock's way; reversal = they give it back.
//
// THE DISCIPLINE (screener-lab.md §2, §6): each session counted once, block ranges over the hold, the last year held out.
//
// Pure: the lab's data in (screenerLab.data), no IO. The script (scripts/lab-news-shock.mjs) reads the news.

import { trade, testable } from './screenerLab.service.js'

export const SHOCK_MIN = 5
export const VOL_MULT = 2

const _r = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)

/**
 * Every shock in `days` → `[{ symbol, day, j, dir: 'up'|'down', size, volx, report }]`. `j` the shock's bar; `size` its
 * close-to-close return less SPY's (%); `volx` its dollar volume over the 20-day average the evening before; `report` a
 * report dated that session or the one before. Only names testable on the shock day and on the entry day. Pure.
 */
export function findShocks(data, { min = SHOCK_MIN, volMult = VOL_MULT, days } = {}) {
    const want = days ? new Set(days) : null
    const out = []
    for (const [symbol, s] of data.names) {
        const { rows, ind } = s
        for (let j = 1; j + 1 < rows.length; j++) {
            const day = ind.date[j]
            if (want && !want.has(day)) continue
            if (!testable(rows, j, ind) || !testable(rows, j + 1, ind)) continue
            const s0 = data.spyByDay.get(ind.date[j - 1]), s1 = data.spyByDay.get(day)
            if (!(s0?.close > 0) || !(s1?.close > 0)) continue
            const size = (rows[j].close / rows[j - 1].close - (s1.close / s0.close)) * 100
            if (Math.abs(size) < min) continue
            const volx = (rows[j].close * (rows[j].volume || 0)) / ind.adv20[j - 1]
            if (!(volx >= volMult)) continue
            out.push({ symbol, day, j, dir: size > 0 ? 'up' : 'down', size, volx,
                report: s.reports.has(day) || s.reports.has(ind.date[j - 1]) })
        }
    }
    return out
}

/** The size band a shock falls in (absolute, against SPY). */
export const sizeBand = (size) => { const a = Math.abs(size); return a < 10 ? '5-10%' : a < 20 ? '10-20%' : '20%+' }

/**
 * The shocks → trades bought at the next session's open, held `hold` sessions, each `{ symbol, day, tag, ret, spy,
 * excess, net, gap }` (`day` the ENTRY session, the unit each session is counted once by; `gap` the next open against the
 * shock's close, %). `tagOf(shock)` names the group. Pure.
 */
export function shockTrades(data, shocks, hold, tagOf) {
    const out = []
    for (const k of shocks) {
        const s = data.names.get(k.symbol)
        const t = trade({ rows: s.rows, i: k.j + 1, ind: s.ind, name: s, hold, spyByDay: data.spyByDay })
        if (!t) continue
        const tag = tagOf(k)
        if (tag == null) continue
        out.push({ symbol: k.symbol, tag, ...t, gap: _r((s.rows[k.j + 1].open / s.rows[k.j].close - 1) * 100) })
    }
    return out
}

// ─── Test B: the second order — the shocked name's industry peers ────────────────────────────────────────────────────
//
// Roy, 2026-10-26: "does news move 2nd order stocks". The link is the industry (FMP's, off the screener stats); no
// supplier/customer map is on our data. An INDUSTRY-DAY is a session with one or more shocks in an industry, all one way
// (mixed days are dropped — no direction to read through). Its PEERS are the industry's other names, testable that day.

/** The peer's own day-0 move against SPY → 'quiet' (under `quietMax`), 'along' (the shock's way) or 'against'. */
export const peerReaction = (dir, day0, quietMax = 2) => (Math.abs(day0) < quietMax ? 'quiet' : (day0 > 0) === (dir === 'up') ? 'along' : 'against')

/**
 * The shocks → industry-days `[{ industry, day, dir, report, shockers: Set }]`: `report` any shocker
 * reported. `industryOf` Map(symbol → industry). Pure.
 */
export function industryDays(shocks, industryOf) {
    const by = new Map()
    for (const k of shocks) {
        const ind = industryOf.get(k.symbol)
        if (!ind) continue
        const key = `${ind}|${k.day}`
        if (!by.has(key)) by.set(key, { industry: ind, day: k.day, dirs: new Set(), report: false, shockers: new Set() })
        const g = by.get(key)
        g.dirs.add(k.dir); g.shockers.add(k.symbol); g.report ||= k.report
    }
    return [...by.values()].filter(g => g.dirs.size === 1).map(({ dirs, ...g }) => ({ ...g, dir: [...dirs][0] }))
}

/**
 * Industry-days → one row per (peer, day): `{ symbol, day, j, dir, report, reaction, day0, leader, reportsIn }` — `day0`
 * the peer's own move against SPY that session (%), `leader` a shocker bigger than the peer THAT DAY (`capOf` Map(symbol → today's cap), scaled by the day's close over the last one — today's cap alone would call a peer that fell since 'smaller'),
 * `reportsIn` the peer's next report within `soon` sessions of the entry. Only industries of `minMembers`+. Pure.
 */
export function peerRows(data, idays, { industryOf, capOf = new Map(), minMembers = 4, quietMax = 2, soon = 20 } = {}) {
    const members = new Map()
    for (const [s, ind] of industryOf) if (data.names.has(s)) { if (!members.has(ind)) members.set(ind, []); members.get(ind).push(s) }
    const at = new Map()
    const idx = (s) => at.get(s) ?? at.set(s, new Map(data.names.get(s).ind.date.map((d, i) => [d, i]))).get(s)
    const capOn = (s, day) => {
        const rows = data.names.get(s)?.rows, j = rows ? idx(s).get(day) : null
        return j == null || !(capOf.get(s) > 0) ? 0 : capOf.get(s) * rows[j].close / rows.at(-1).close
    }
    const out = []
    for (const g of idays) {
        const peers = members.get(g.industry) ?? []
        if (peers.length < minMembers) continue
        const leadCap = Math.max(0, ...[...g.shockers].map(s => capOn(s, g.day)))
        const s0 = data.spyByDay.get(data.spyDays[data.spyDays.indexOf(g.day) - 1]), s1 = data.spyByDay.get(g.day)
        if (!(s0?.close > 0) || !(s1?.close > 0)) continue
        for (const p of peers) {
            if (g.shockers.has(p)) continue
            const s = data.names.get(p), j = idx(p).get(g.day)
            if (j == null || j + 1 >= s.rows.length || !testable(s.rows, j, s.ind) || !testable(s.rows, j + 1, s.ind)) continue
            const day0 = (s.rows[j].close / s.rows[j - 1].close - s1.close / s0.close) * 100
            const entry = s.ind.date[j + 1], horizon = s.ind.date[Math.min(j + soon, s.rows.length - 1)]
            const reportsIn = [...s.reports.keys()].some(d => d >= entry && d <= horizon)
            out.push({ symbol: p, day: g.day, j, dir: g.dir, report: g.report, reaction: peerReaction(g.dir, day0, quietMax), day0,
                leader: leadCap > 0 && capOn(p, g.day) > 0 ? leadCap > capOn(p, g.day) : null, reportsIn })
        }
    }
    return out
}

/**
 * WHAT THE HEADLINES SAY — the first type a title matches, in this order (a deal outranks the analyst notes that follow
 * it). Crude on purpose: keywords on titles, no model — a first cut that says whether the TYPE matters before paying to
 * read the articles.
 */
export const NEWS_TYPES = Object.freeze([
    ['deal',      /\b(acquir\w*|acquisition|merger|merge|buyout|takeover|to buy|to be bought|bid for|tender offer|go[- ]private)\b/i],
    ['fda/trial', /\b(fda|phase [1-3i]+|trial|clinical|approval|approves|approved|topline|pdufa|crl)\b/i],
    ['offering',  /\b(offering|priced|pricing|convertible|dilut\w*|share sale|private placement|atm program)\b/i],
    ['guidance',  /\b(guidance|outlook|forecast|preliminary|pre-announce\w*|warns|profit warning|raises .*(view|target)|cuts .*(view|target))\b/i],
    ['analyst',   /\b(upgrade\w*|downgrade\w*|price target|initiat\w*|reiterat\w*|overweight|underweight|outperform|underperform|buy rating|sell rating|neutral)\b/i],
    ['legal/reg', /\b(lawsuit|sued|probe|investigation|subpoena|sec |doj|ftc|antitrust|settlement|recall|tariff|ban|sanction\w*|short report|short seller|fraud)\b/i],
    ['contract',  /\b(contract|partnership|partners with|agreement|award\w*|order|collaborat\w*|deal with|selected by|wins)\b/i],
    ['people',    /\b(ceo|cfo|chief executive|resign\w*|steps down|appoint\w*|names .* (ceo|chief)|activist|stake)\b/i],
])

/** Titles → the news type: the first of NEWS_TYPES any title matches, 'other' when none does, 'no headline' when empty. Pure. */
export function classifyHeadlines(titles) {
    if (!titles?.length) return 'no headline'
    for (const [type, re] of NEWS_TYPES) if (titles.some(t => re.test(t))) return type
    return 'other'
}

/**
 * The shock's headlines: published from 16:00 the session before the shock to 13:00 on the entry day (FMP stamps news
 * with no zone — 13:00 is before 09:30 ET either way, so everything here was out before the entry). `news` FMP rows.
 * → Map(symbol → [title]). Pure.
 */
export function headlinesFor(news, prevDay, entryDay) {
    const from = `${prevDay} 16:00`, to = `${entryDay} 13:00`
    const out = new Map()
    for (const n of news ?? []) {
        const s = String(n?.symbol ?? '').toUpperCase(), at = String(n?.publishedDate ?? '')
        if (!s || !n.title || at < from || at >= to) continue
        if (!out.has(s)) out.set(s, [])
        out.get(s).push(n.title)
    }
    return out
}
