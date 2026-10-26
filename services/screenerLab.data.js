// The SCREENER LAB's data (screenerLab.service) — read ONCE, cached on disk, so each hypothesis runs offline in seconds.
//
// The universe — `screener` (the Hotlist's, from `daily_screener_stats`) or `smallcap` ($300M–$2B, the screener API) —
// each name's daily bars over the span, its sector, SPY's bars, and the earnings calendar over the span (FMP serves about
// a year back on this plan — older `from` answers 402). EXTRAS, read on request: each name's earnings HISTORY (back
// years — #6's streaks) and its insider PURCHASES (#10). Cached under `data/lab/` (gitignored), one file per universe and
// one for its extras; every read is resumable (a `.partial` file) and waits out the per-minute 429.

import fs from 'fs'
import path from 'path'
import { getDb } from '../providers/mongodb.provider.js'
import { getFmpCandles, fmpGet } from '../providers/fmp.price.provider.js'
import { getEarningsCalendarRaw, UNIVERSE_EXCHANGES } from '../providers/fmp.provider.js'
import { COLLECTION as STATS } from './dailyScreener.service.js'
import { createPacer } from './concurrency.util.js'
import { indicators, spyRegimes } from './screenerLab.service.js'
import { shortInterestDates, shortInterestOn, shortVolumeOn, atsWeek, SHORT_INTEREST_LAG_DAYS } from '../providers/finra.provider.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[screenerLab]'
const DIR = path.resolve('data', 'lab')
const DAY_MS = 86_400_000
/** Bars before the first session: the 200-day average and the 52-week high want a year. */
const HISTORY_DAYS = 400
/** The calendar's reach on this plan — a year back (2026-10-24: 2025-11-20 answers, 2025-10-20 is a 402). */
const CALENDAR_DAYS = 350
/** How far back the seasonal test's month-end closes go (FMP's daily bars reach 2012 on this plan, 2026-10-25). */
const MONTHS_FROM = '2012-01-01'

const _etDay = (ts) => new Date(ts > 1e12 ? ts : ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const _ymd = (ms) => new Date(ms).toISOString().slice(0, 10)

const _deps = {
    db:        () => getDb(),
    bars:      (symbol, from, to) => getFmpCandles(symbol, { timeSpan: 'day', multiplier: 1, from, to }),
    earnings:  (from, to) => getEarningsCalendarRaw(from, to),
    // Per name, for the hypotheses that need more than a year (#6) or insiders (#10) — one read each, its whole history.
    history:   (symbol) => fmpGet(`/earnings?symbol=${encodeURIComponent(symbol)}&limit=40`, { label: `FMP earnings ${symbol}` }),
    insiders:  (symbol) => fmpGet(`/insider-trading/search?symbol=${encodeURIComponent(symbol)}&transactionType=P-Purchase&page=0&limit=100`, { label: `FMP insiders ${symbol}` }),
    screen:    (qs) => fmpGet(`/company-screener?${qs}`, { label: 'FMP screener' }),
    // The report test (2026-10-26): what the analysts did before each report — every rating change, and every price-target
    // note (100 a page, newest first), from ANALYST_FROM; compact rows (newsShock.service reads them).
    grades:    async (symbol) => ((await fmpGet(`/grades?symbol=${encodeURIComponent(symbol)}`, { label: `FMP grades ${symbol}` })) ?? [])
        .filter(g => String(g.date) >= ANALYST_FROM).map(g => [String(g.date).slice(0, 10), g.action]),
    targets:   async (symbol) => {
        const out = []
        for (let page = 0; page < 10; page++) {
            const rows = (await fmpGet(`/price-target-news?symbol=${encodeURIComponent(symbol)}&page=${page}&limit=100`, { label: `FMP targets ${symbol}` })) ?? []
            out.push(...rows.filter(r => String(r.publishedDate) >= ANALYST_FROM).map(targetRow))
            if (rows.length < 100 || String(rows.at(-1)?.publishedDate) < ANALYST_FROM) break
        }
        return out
    },
    // The seasonal test (2026-10-25): month-end closes since MONTHS_FROM — the daily bars read once, kept as months.
    months:    async (symbol) => monthEnds(await getFmpCandles(symbol, { timeSpan: 'day', multiplier: 1, from: Date.parse(MONTHS_FROM), to: Date.now() })),
    // The short tests (2026-10-25) — FINRA, in BULK: one read a settlement date / a trading day for the whole market.
    shortInterestDates: (from, to) => shortInterestDates(from, to),
    shortInterestOn:    (d) => shortInterestOn(d),
    shortVolumeOn:      (d) => shortVolumeOn(d),
    atsWeek:            (w) => atsWeek(w),
    perMinute: () => config.dailyScreenerRpm,
    now:       () => Date.now(),
    sleep:     (ms) => new Promise(r => setTimeout(r, ms)),
}

/** How far back the analysts' notes are read: the three-year span's first report, less the 90 days it looks back. */
const ANALYST_FROM = '2023-06-01'

/**
 * A price-target note → `[day, target, price when posted, direction]` — the day in ET (FMP stamps it in UTC), the
 * direction off the title: +1 raised, −1 lowered, 0 anything else (an initiation, a reiteration). Pure.
 */
export function targetRow(r) {
    const t = String(r?.newsTitle ?? '')
    const dir = /\b(raised|raises|boost(s|ed)?|lift(s|ed)?|increase[sd]?|hike[sd]?|bump(s|ed)?)\b/i.test(t) ? 1
        : /\b(lowered|lowers|cut(s)?|reduce[sd]?|trim(s|med)?|slash(es|ed)?)\b/i.test(t) ? -1 : 0
    return [_etDay(Date.parse(r?.publishedDate)), Number(r?.priceTarget) || null, Number(r?.priceWhenPosted) || null, dir]
}

/** How far back the short data is read (the three-year span's first session is 2023-10-09). */
const SHORT_FROM = '2023-06-01'

/**
 * The BULK extras (2026-10-25): read per DATE, not per name — FINRA serves the whole market a date — and kept only for
 * the universe's names. `keys(raw)` the dates to read; `read(date, names)` one date → its compact rows.
 */
const BULK = {
    // { settlement: [[SYM, short, dtc, change_pct]] }
    shortInterest: {
        keys: (raw, deps) => deps.shortInterestDates(SHORT_FROM, _ymd(deps.now())),
        read: async (d, names, deps) => (await deps.shortInterestOn(d)).filter(r => names.has(r.symbol)).map(r => [r.symbol, r.short, r.dtc, r.change_pct]),
    },
    // { week: [[SYM, ATS shares, published]] } — the Mondays from SHORT_FROM to five weeks back (Tier 2 publishes in four).
    darkPool: {
        keys: async (raw, deps) => {
            const mondays = new Set((raw.spy ?? []).map(b => _etDay(b.timestamp)).filter(d => d >= SHORT_FROM)
                .map(d => { const t = new Date(`${d}T12:00:00Z`); return _ymd(t - ((t.getUTCDay() + 6) % 7) * DAY_MS) }))
            const last = _ymd(deps.now() - 35 * DAY_MS)
            return [...mondays].filter(m => m <= last).sort()
        },
        read: async (w, names, deps) => (await deps.atsWeek(w)).filter(r => names.has(r.symbol)).map(r => [r.symbol, r.shares, r.published]),
    },
    // { day: { SYM: short share of FINRA-reported volume, ‰ } }
    shortVolume: {
        keys: async (raw) => (raw.spy ?? []).map(b => _etDay(b.timestamp)).filter(d => d >= SHORT_FROM),
        read: async (d, names, deps) => {
            const out = {}
            for (const [sym, v] of await deps.shortVolumeOn(d)) if (names.has(sym) && v.total > 0) out[sym] = Math.round((v.short / v.total) * 1000)
            return out
        },
    },
}

/** The universes the lab knows → `[{ symbol, sector }]`. */
export const UNIVERSES = Object.freeze({
    // The Hotlist's own: the latest stats day.
    screener: async (deps) => {
        const db = await deps.db()
        const last = await db.collection(STATS).find({}, { projection: { _id: 0, day: 1 } }).sort({ day: -1 }).limit(1).next()
        if (!last?.day) return []
        return (await db.collection(STATS).find({ day: last.day }, { projection: { _id: 0, symbol: 1, sector: 1 } }).toArray())
            .map(r => ({ symbol: r.symbol, sector: r.sector ?? null }))
    },
    // #9 — small caps: $300M–$2B, over $5, 100k+ shares a day, the US exchanges (Roy, 2026-10-24: "more small caps").
    smallcap: async (deps) => {
        const qs = new URLSearchParams({ marketCapMoreThan: '300000000', marketCapLowerThan: '2000000000', priceMoreThan: '5', volumeMoreThan: '100000',
            isEtf: 'false', isFund: 'false', isActivelyTrading: 'true', country: 'US', limit: '5000' }).toString()
        return ((await deps.screen(qs)) ?? []).filter(r => r?.symbol && UNIVERSE_EXCHANGES.includes(r.exchangeShortName ?? r.exchange))
            .map(r => ({ symbol: String(r.symbol).toUpperCase(), sector: r.sector ?? null }))
    },
})

/**
 * Read `read(symbol)` for each symbol into `{ SYM: value }`, resumable from `<file>.partial` — saved every 50 names and
 * on a stop. A 429 is the per-minute limit (2026-10-24: one at 150 a minute, fine a minute later): waited out, five times.
 */
async function readEach({ file, symbols, read, deps, pace, label, onProgress }) {
    const partial = `${file}.partial`
    const out = fs.existsSync(partial) ? JSON.parse(fs.readFileSync(partial, 'utf8')) : {}
    const save = () => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(partial, JSON.stringify(out)) }
    let failed = 0
    for (const [k, s] of symbols.entries()) {
        if (s in out) continue
        for (let attempt = 0; ; attempt++) {
            await pace()
            try { out[s] = (await read(s)) ?? []; break } catch (err) {
                if (err?.status === 429 && attempt < 5) { logger.warn(LOG, `429 on ${s} — waiting a minute`); await deps.sleep(65_000); continue }
                if (err?.status === 429) { save(); throw err }
                failed++
                break
            }
        }
        if ((k + 1) % 50 === 0) { save(); onProgress?.(label, k + 1, symbols.length) }
    }
    logger.info(LOG, `${label}: read ${Object.keys(out).length} of ${symbols.length} (${failed} failed)`)
    return { out, done: () => fs.rmSync(partial, { force: true }) }
}

/**
 * Two caches of one universe joined into one span (test J, 2026-10-26: the 2019–2023 window + the 3-year cache): per name,
 * the NEWER cache's bars, with the older one's bars before its first day in front. Each cache is adjusted as of the day
 * it was fetched, so the older bars are scaled by the ratio of the two closes on the last day both have — a split or a
 * dividend between the two fetches would otherwise be a jump. A name whose ratio is off by more than `tol` is listed in
 * `scaled` (it was scaled); one with no common day is joined unscaled and listed in `unmatched`. The rest of the newer
 * cache is kept. Pure.
 */
export function joinWindows(older, newer, { tol = 0.005 } = {}) {
    const scaled = [], unmatched = []
    const join = (sym, a = [], b = []) => {
        if (!a.length) return b
        if (!b.length) return a
        const first = b[0].timestamp
        const day = (ts) => _etDay(ts)
        const bByDay = new Map(b.map(x => [day(x.timestamp), x]))
        let ratio = null
        for (let k = a.length - 1; k >= 0; k--) {
            const m = bByDay.get(day(a[k].timestamp))
            if (m && a[k].close > 0 && m.close > 0) { ratio = m.close / a[k].close; break }
        }
        if (ratio == null) unmatched.push(sym)
        else if (Math.abs(ratio - 1) > tol) scaled.push([sym, ratio])
        const r = ratio ?? 1
        const head = a.filter(x => x.timestamp < first).map(x => ({ ...x, open: x.open * r, high: x.high * r, low: x.low * r, close: x.close * r }))
        return [...head, ...b]
    }
    const names = {}
    for (const sym of new Set([...Object.keys(older.names ?? {}), ...Object.keys(newer.names ?? {})])) names[sym] = join(sym, older.names?.[sym], newer.names?.[sym])
    const spy = join('SPY', older.spy, newer.spy)
    return { raw: { ...newer, names, spy, bars_from: older.bars_from ?? newer.bars_from, window: null }, scaled, unmatched }
}

/** Daily bars → `[['YYYY-MM', month-end close], …]`, oldest first. Pure. */
export function monthEnds(bars) {
    const out = new Map()
    for (const b of [...(bars ?? [])].sort((a, z) => a.timestamp - z.timestamp)) if (b?.close > 0) out.set(_etDay(b.timestamp).slice(0, 7), b.close)
    return [...out]
}

const _cal = (e) => ({ symbol: e.symbol, date: e.date, epsActual: e.epsActual, epsEstimated: e.epsEstimated, revenueActual: e.revenueActual, revenueEstimated: e.revenueEstimated })

/** Read a universe from the provider → the raw cache `{ built_at, universe, calendar_from, spy, names: { SYM: bars }, sectors, calendar }`. */
async function fetchRaw({ name, file, list, years, window = null, deps, pace, onProgress }) {
    const nowMs = deps.now()
    // `years` > 1 — the bars reach further back than the calendar (2026-10-25: the run-up test needs only the bars and
    // the earnings history, which go back years). `window` — an explicit span of the past (2026-10-25: the false break
    // on 2019–2023, years it never saw), with HISTORY_DAYS of bars before it and NO calendar (a 402 that far back).
    const from = window ? Date.parse(window.from) - HISTORY_DAYS * DAY_MS : nowMs - (Math.max(CALENDAR_DAYS, years * 365) + HISTORY_DAYS) * DAY_MS
    const to = window ? Date.parse(window.to) : nowMs
    await pace()
    const spy = (await deps.bars('SPY', from, to)) ?? []
    const calendarFrom = window ? window.from : _ymd(nowMs - CALENDAR_DAYS * DAY_MS)
    let calendar = []
    if (!window) { await pace(); calendar = (await deps.earnings(calendarFrom, _ymd(nowMs + 30 * DAY_MS))) ?? [] }
    const { out: names, done } = await readEach({ file, symbols: list.map(u => u.symbol), read: (s) => deps.bars(s, from, to), deps, pace, label: `${name} bars`, onProgress })
    done()
    return { built_at: new Date(nowMs).toISOString(), universe: name, years, window, bars_from: _ymd(from), calendar_from: calendarFrom, spy, names,
        sectors: Object.fromEntries(list.map(u => [u.symbol, u.sector])), calendar: calendar.map(_cal) }
}

/**
 * The raw cache (and its extras) → what the lab runs on: `{ names: Map(SYM → { rows, ind, reports, sector, insiders }),
 * spyByDay, spyDays, calendarFrom, sectorDay }`. `reports` a Map(date → report) — the calendar's, with the name's
 * earnings history merged in when read; `insiders` its purchases, oldest first; `sectorDay` (sectorStats) the sectors'
 * five-session returns per session. Pure.
 */
export function prepare(raw, extras = {}) {
    const byName = new Map()
    const add = (e) => {
        const s = String(e?.symbol ?? '').toUpperCase()
        if (!s || !e.date) return
        if (!byName.has(s)) byName.set(s, new Map())
        // The calendar's row wins where both have the date (the same numbers, read fresher).
        if (!byName.get(s).has(e.date)) byName.get(s).set(e.date, e)
    }
    for (const e of raw.calendar ?? []) add(e)
    // The short data by name: short interest oldest first, each with the day it was safe to know (FINRA publishes it
    // about seven business days after settlement); short volume as Map(day → its short share, ‰).
    const si = new Map(), sv = new Map()
    for (const [settlement, rows] of Object.entries(extras.shortInterest ?? {})) for (const [sym, short, dtc, change] of rows ?? []) {
        if (!si.has(sym)) si.set(sym, [])
        si.get(sym).push({ settlement, known: _ymd(Date.parse(`${settlement}T12:00:00Z`) + SHORT_INTEREST_LAG_DAYS * DAY_MS), short, dtc, change })
    }
    for (const list of si.values()) list.sort((a, b) => a.settlement.localeCompare(b.settlement))
    // Dark-pool weeks by name, oldest first: the week's Monday, its ATS shares, the day FINRA published it.
    const dp = new Map()
    for (const [week, rows] of Object.entries(extras.darkPool ?? {})) for (const [sym, shares, published] of rows ?? []) {
        if (!dp.has(sym)) dp.set(sym, [])
        dp.get(sym).push({ week, shares, published })
    }
    for (const list of dp.values()) list.sort((a, b) => a.week.localeCompare(b.week))
    for (const [day, m] of Object.entries(extras.shortVolume ?? {})) for (const [sym, r] of Object.entries(m ?? {})) {
        if (!sv.has(sym)) sv.set(sym, new Map())
        sv.get(sym).set(day, r / 10)
    }
    for (const rows of Object.values(extras.history ?? {})) for (const e of rows ?? []) add(_cal(e))
    const names = new Map()
    for (const [s, bars] of Object.entries(raw.names ?? {})) {
        const rows = (bars ?? []).filter(b => b?.close > 0 && b?.open > 0)
        if (rows.length < 30) continue
        const dates = rows.map(b => _etDay(b.timestamp))
        const insiders = (extras.insiders?.[s] ?? []).filter(t => t?.filingDate && t.transactionType === 'P-Purchase')
            .map(t => ({ filed: String(t.filingDate).slice(0, 10), who: t.reportingCik ?? t.reportingName, role: t.typeOfOwner ?? '', usd: (Number(t.securitiesTransacted) || 0) * (Number(t.price) || 0) }))
            .sort((a, b) => a.filed.localeCompare(b.filed))
        names.set(s, { rows, ind: indicators(rows, dates), reports: byName.get(s) ?? new Map(), sector: raw.sectors?.[s] ?? null, insiders,
            months: new Map(extras.months?.[s] ?? []), si: si.get(s) ?? [], sv: sv.get(s) ?? new Map(), dp: dp.get(s) ?? [],
            grades: extras.grades?.[s] ?? [], targets: extras.targets?.[s] ?? [] })
    }
    const spyByDay = new Map((raw.spy ?? []).map(b => [_etDay(b.timestamp), b]))
    const spyDays = [...spyByDay.keys()].sort()
    return { names, spyByDay, spyDays, calendarFrom: raw.calendar_from, barsFrom: raw.bars_from ?? null, years: raw.years ?? 1, window: raw.window ?? null, builtAt: raw.built_at, universe: raw.universe, sectorDay: sectorStats(names),
        regimes: spyRegimes(spyDays.map(d => ({ day: d, close: spyByDay.get(d).close }))), spyMonths: new Map(extras.months?.SPY ?? []) }
}

/**
 * Per session, per sector: the members' five-session returns as of that close → `Map(day → Map(sector → { median, p10,
 * n }))` — #8 reads a name against its sector. A sector with fewer than 8 names that day is left out. Pure.
 */
export function sectorStats(names) {
    const acc = new Map()
    for (const s of names.values()) {
        if (!s.sector) continue
        s.ind.date.forEach((d, i) => {
            const r = s.ind.ret5[i]
            if (r == null) return
            if (!acc.has(d)) acc.set(d, new Map())
            const m = acc.get(d)
            if (!m.has(s.sector)) m.set(s.sector, [])
            m.get(s.sector).push(r)
        })
    }
    const out = new Map()
    for (const [d, m] of acc) {
        const row = new Map()
        for (const [sec, xs] of m) {
            if (xs.length < 8) continue
            xs.sort((a, b) => a - b)
            row.set(sec, { median: xs[Math.floor(xs.length / 2)], p10: xs[Math.floor(xs.length * 0.1)], n: xs.length })
        }
        out.set(d, row)
    }
    return out
}

/**
 * The lab's data for a universe (`screener` by default) from the cache — or, absent or on `refresh`, the provider.
 * `years` — bars that far back (its own cache, `<name>-<years>y.json`); the calendar stays a year. `window` — `{ from, to }`,
 * a span of the past instead (`<name>-<from>_<to>.json`, no calendar). `extras` —
 * `['history', 'insiders', 'months', 'grades', 'targets', 'shortInterest', 'shortVolume', 'darkPool']`, any (the FINRA three read in BULK, per date) — read once per universe into `<name>.extras.json` (shared by every span), cached too.
 */
export async function loadLabData({ name = 'screener', years = 1, window = null, refresh = false, extras = [], deps = _deps, onProgress } = {}) {
    const file = path.join(DIR, window ? `${name}-${window.from}_${window.to}.json` : years > 1 ? `${name}-${years}y.json` : `${name}.json`)
    const pace = createPacer({ perMinute: deps.perMinute(), now: deps.now, sleep: deps.sleep })
    let raw
    if (!refresh && fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    else {
        const universe = UNIVERSES[name]
        if (!universe) throw new Error(`no universe "${name}" — ${Object.keys(UNIVERSES).join(', ')}`)
        const list = await universe(deps)
        if (!list.length) throw new Error(`the "${name}" universe is empty`)
        raw = await fetchRaw({ name, file, list, years, window, deps, pace, onProgress })
        fs.mkdirSync(DIR, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(raw))
    }
    // A cache written before sectors were kept: the screener's are in Mongo, no provider read.
    if (!raw.sectors && name === 'screener') raw.sectors = Object.fromEntries((await UNIVERSES.screener(deps)).map(u => [u.symbol, u.sector]))
    const xfile = path.join(DIR, `${name}.extras.json`)
    const have = fs.existsSync(xfile) ? JSON.parse(fs.readFileSync(xfile, 'utf8')) : {}
    for (const kind of extras) {
        if (have[kind] && !refresh) continue
        if (BULK[kind]) {
            // Per date, resumable the same way — the "symbols" readEach walks are the dates.
            const names = new Set(Object.keys(raw.names))
            const keys = await BULK[kind].keys(raw, deps)
            const { out, done } = await readEach({ file: path.join(DIR, `${name}.${kind}.json`), symbols: keys, read: (d) => BULK[kind].read(d, names, deps), deps, pace, label: `${name} ${kind}`, onProgress })
            have[kind] = out
            fs.mkdirSync(DIR, { recursive: true })
            fs.writeFileSync(xfile, JSON.stringify(have))
            done()
            continue
        }
        const { out, done } = await readEach({ file: path.join(DIR, `${name}.${kind}.json`), symbols: [...Object.keys(raw.names), ...(kind === 'months' ? ['SPY'] : [])], read: (s) => deps[kind](s), deps, pace, label: `${name} ${kind}`, onProgress })
        have[kind] = out
        fs.mkdirSync(DIR, { recursive: true })
        fs.writeFileSync(xfile, JSON.stringify(have))
        done()
    }
    return prepare(raw, have)
}
