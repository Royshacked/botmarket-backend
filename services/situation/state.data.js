// THE STATE'S DATA SECTIONS, BY CODE (docs/design/situation-network.md §2; plan step 2).
//
// Four of the state's six sections are numbers, not judgment, so code writes them: REGIME (FRED: level and direction),
// PRICES (the market, breadth, every industry basket against the S&P), MONEY (the engine's capex and flows) and the
// CALENDAR's known dates (FOMC, high-impact releases, the largest companies' earnings). Policy and stories are the
// LLM's (step 4). Every item is a FACT with its as-of date and source (model.js checkItem).
//
// Shared mechanism, not copies: FRED through fred.provider, index and commodity bars through getFmpCandles, the S&P and
// every stock through the engine's daily window (houseScan.candidates' dailyRows), industry lines from the engine's
// `industry_index`, money through industryData.service. A leg that fails is a GAP, named, never a zero.
//
// Prices are context, never a signal (the design: "not for trading on the prices themselves").

import { fetchSeries, fetchFedEventsRange } from '../../providers/fred.provider.js'
import { getFmpCandles } from '../../providers/fmp.price.provider.js'
import { getEarningsCalendarRaw } from '../../providers/fmp.provider.js'
import { getEngineDb } from '../engineDb.js'
import { dailyRows } from '../houseScan.candidates.js'
import { readMoneyLeaders, readAllFlows } from '../../api/strategy/industryData.service.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.data]'

// Trading days in a month, a quarter, a year.
export const BARS = Object.freeze({ m1: 21, m3: 63, m12: 252, ma50: 50, ma200: 200, high52: 252 })
/** A level counts as moved when it changed by more than this share of itself over three months (else "flat"). */
export const FLAT_SHARE = 0.02
/** How many industries the section names at each end, and the stretch percentile that marks one "stretched". */
export const TOP_N = 10
export const STRETCHED_AT = 0.9
/** The calendar looks this far ahead. */
export const CALENDAR_DAYS = 120

/**
 * The regime's FRED series. `yoy`: the series is an index and the regime reads its year-on-year change. `flatAbs`: the
 * absolute change (in the series' own unit) under which the direction is "flat" — rates move in points, not shares.
 */
export const REGIME_SERIES = Object.freeze([
    { id: 'GDPC1', label: 'Real GDP growth (quarter, annualised)', unit: '%', qoqAnnualized: true, flatAbs: 0.5 },
    { id: 'UNRATE', label: 'Unemployment rate', unit: '%', flatAbs: 0.15 },
    { id: 'PAYEMS', label: 'Payrolls, monthly change', unit: 'k', monthlyChange: true, flatAbs: 50 },
    { id: 'CPIAUCSL', label: 'CPI inflation (year on year)', unit: '%', yoy: true, flatAbs: 0.2 },
    { id: 'PCEPILFE', label: 'Core PCE inflation (year on year)', unit: '%', yoy: true, flatAbs: 0.2 },
    { id: 'DFEDTARU', label: 'Fed funds target (upper)', unit: '%', flatAbs: 0.1 },
    { id: 'DGS10', label: '10-year Treasury yield', unit: '%', flatAbs: 0.15 },
    { id: 'DGS2', label: '2-year Treasury yield', unit: '%', flatAbs: 0.15 },
    { id: 'DTWEXBGS', label: 'US dollar, broad index', unit: '', flatShare: FLAT_SHARE },
    { id: 'DCOILBRENTEU', label: 'Brent crude, $/bbl', unit: '$', flatShare: 0.05 },
])

/** The market's instruments (FMP daily bars; the S&P comes from the engine's window, the same bars every desk reads). */
export const MARKET = Object.freeze([
    { symbol: '^GSPC', label: 'S&P 500', engine: true },
    { symbol: '^IXIC', label: 'Nasdaq Composite' },
    { symbol: '^RUT', label: 'Russell 2000' },
    { symbol: '^VIX', label: 'VIX', level: true },
    { symbol: 'GCUSD', label: 'Gold, $/oz' },
    { symbol: 'BTCUSD', label: 'Bitcoin, $' },
])

/** The largest companies whose earnings the calendar names (they move the index). */
export const INDEX_MOVERS = Object.freeze(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'AVGO', 'TSLA', 'BRK-B', 'JPM', 'LLY', 'V'])

const _io = {
    series: (id, from) => fetchSeries(id, { from }),
    candles: async (symbol) => {
        const to = Date.now(), from = to - 420 * 864e5
        const rows = await getFmpCandles(symbol, { timeSpan: 'day', from, to })
        return (rows ?? []).map(r => ({ date: _dateOf(r.timestamp), close: r.close })).filter(r => r.date && r.close > 0)
    },
    engineDb: () => getEngineDb(),
    moneyLeaders: () => readMoneyLeaders({ n: 6 }),
    flows: () => readAllFlows(),
    fedEvents: (from, to) => fetchFedEventsRange(from, to),
    earnings: (from, to, symbols) => getEarningsCalendarRaw(from, to, symbols),
}
export function _setIO(io) { Object.assign(_io, io) }

// FMP's timestamp is epoch seconds (ms if it is that large).
function _dateOf(ts) {
    if (!Number.isFinite(ts)) return null
    const ms = ts > 1e12 ? ts : ts * 1000
    return new Date(ms).toISOString().slice(0, 10)
}

const _iso = (d) => d.toISOString().slice(0, 10)
const _addDays = (iso, n) => _iso(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5))
const _pct = (v, d = 1) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : 'n/a')
const _num = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : 'n/a')
const _mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const _item = (text, value, as_of, source) => ({ text, value: typeof value === 'number' && Number.isFinite(value) ? value : null, as_of, source, tag: 'fact' })

// ─── pure measures ────────────────────────────────────────────────────────────

/** The return over the last `n` bars of a close series (oldest first, nulls allowed at the edges). Pure. */
export function ret(close, n) {
    const xs = close.filter(v => v > 0)
    if (xs.length <= n) return null
    return xs.at(-1) / xs.at(-1 - n) - 1
}

/** The mean of the last `n` closes. Pure. */
export function sma(close, n) {
    const xs = close.filter(v => v > 0)
    return xs.length >= n ? _mean(xs.slice(-n)) : null
}

/** Distance of the last close from the highest close of the last `n` bars (≤ 0). Pure. */
export function fromHigh(close, n = BARS.high52) {
    const xs = close.filter(v => v > 0).slice(-n)
    if (!xs.length) return null
    return xs.at(-1) / Math.max(...xs) - 1
}

/**
 * How far the last close sits above its 50-day mean, as a percentile of the same distance over the previous year
 * (the screener's Q9 rule, industry-screener.md §3.1: ≥ 120 readings). Null when there is too little history. Pure.
 */
export function stretchPercentile(close, { ma = BARS.ma50, window = BARS.m12, minReadings = 120 } = {}) {
    const xs = close.filter(v => v > 0)
    const dist = []
    for (let i = ma - 1; i < xs.length; i++) {
        const m = _mean(xs.slice(i - ma + 1, i + 1))
        dist.push(xs[i] / m - 1)
    }
    if (dist.length < minReadings + 1) return null
    const now = dist.at(-1)
    const past = dist.slice(-1 - window, -1)
    return past.filter(d => d <= now).length / past.length
}

/**
 * A FRED series → its regime reading: the latest level, the level about three months earlier, and the direction.
 * `yoy` reads the year-on-year change of an index; `monthlyChange` the month's change (payrolls). Null when the series
 * is too short. Pure.
 */
export function seriesReading(spec, obs) {
    if (!Array.isArray(obs) || !obs.length) return null
    let pts = obs
    if (spec.yoy) {
        const byMonth = new Map(obs.map(o => [o.date.slice(0, 7), o.value]))
        pts = obs.map(o => {
            const prev = byMonth.get(`${Number(o.date.slice(0, 4)) - 1}${o.date.slice(4, 7)}`)
            return prev ? { date: o.date, value: (o.value / prev - 1) * 100 } : null
        }).filter(Boolean)
    } else if (spec.qoqAnnualized) {
        pts = obs.slice(1).map((o, i) => ({ date: o.date, value: ((o.value / obs[i].value) ** 4 - 1) * 100 }))
    } else if (spec.monthlyChange) {
        pts = obs.slice(1).map((o, i) => ({ date: o.date, value: o.value - obs[i].value }))
    }
    if (!pts.length) return null
    const last = pts.at(-1)
    const cutoff = _addDays(last.date, -90)
    const before = [...pts].reverse().find(p => p.date <= cutoff) ?? null
    let direction = null
    if (before) {
        const d = last.value - before.value
        const flat = spec.flatAbs != null ? Math.abs(d) <= spec.flatAbs : Math.abs(d) <= Math.abs(before.value) * (spec.flatShare ?? FLAT_SHARE)
        direction = flat ? 'flat' : d > 0 ? 'rising' : 'falling'
    }
    return { id: spec.id, label: spec.label, unit: spec.unit, value: last.value, date: last.date, before: before?.value ?? null, before_date: before?.date ?? null, direction }
}

/** A regime reading as a state item. Pure. */
export function regimeItem(r) {
    const fmt = (v) => (r.unit === '%' ? `${_num(v)}%` : r.unit === 'k' ? `${Math.round(v)}k` : r.unit === '$' ? `$${_num(v)}` : _num(v))
    const dir = r.direction ? `, ${r.direction} over three months (from ${fmt(r.before)} on ${r.before_date})` : ''
    return _item(`${r.label}: ${fmt(r.value)}${dir}`, r.value, r.date, `FRED ${r.id}`)
}

/** A market instrument's numbers from its closes. Pure. */
export function marketReading(spec, rows) {
    const close = rows.map(r => r.close)
    if (close.length < BARS.m1 + 1) return null
    const ma200 = sma(close, BARS.ma200)
    return {
        symbol: spec.symbol, label: spec.label, level_only: Boolean(spec.level), date: rows.at(-1).date, last: close.at(-1),
        m1: ret(close, BARS.m1), m3: ret(close, BARS.m3), m12: ret(close, BARS.m12),
        from_high: fromHigh(close), above_200d: ma200 ? close.at(-1) > ma200 : null,
        avg_1y: spec.level ? _mean(close.slice(-BARS.m12)) : null,
    }
}

/** A market reading as a state item. Pure. */
export function marketItem(m, source) {
    if (m.level_only) {
        return _item(`${m.label}: ${_num(m.last, 1)} (its one-year average ${_num(m.avg_1y, 1)})`, m.last, m.date, source)
    }
    const parts = [`1m ${_pct(m.m1)}`, `3m ${_pct(m.m3)}`, m.m12 != null ? `12m ${_pct(m.m12)}` : null,
        `${_pct(m.from_high)} from its 52-week high`, m.above_200d == null ? null : (m.above_200d ? 'above its 200-day average' : 'below its 200-day average')].filter(Boolean)
    return _item(`${m.label}: ${_num(m.last, m.last > 1000 ? 0 : 2)}; ${parts.join(', ')}`, m.last, m.date, source)
}

/** The share of stocks above their own 200-day mean, from the engine's daily window. Pure over close arrays. */
export function breadth(closeSeries) {
    let above = 0, n = 0
    for (const c of closeSeries) {
        const m = sma(c, BARS.ma200)
        const last = c.filter(v => v > 0).at(-1)
        if (!m || !last) continue
        n++
        if (last > m) above++
    }
    return n ? { share: above / n, n } : null
}

/**
 * Every industry basket's line (`industry_index`: dates + equal-weight levels) against the S&P's closes → rows with
 * 1/3/12-month returns, each against the S&P over the same bars, trend and stretch. The two series must end on the
 * same day; a basket that does not is skipped (it would compare different weeks). Pure.
 */
export function industryRows(indexDocs, spx, names) {
    const out = []
    for (const d of indexDocs) {
        const levels = d.levels ?? [], dates = d.dates ?? []
        if (levels.length < BARS.m3 + 1 || dates.at(-1) !== spx.date) continue
        const r = (n) => ret(levels, n)
        const vs = (n) => (r(n) == null || ret(spx.close, n) == null ? null : r(n) - ret(spx.close, n))
        const ma50 = sma(levels, BARS.ma50), ma200 = sma(levels, BARS.ma200)
        const [level, code] = String(d._id).split(':')
        out.push({
            basket: d._id, level, code, name: names.get(d._id) ?? code, date: dates.at(-1),
            m1: r(BARS.m1), m3: r(BARS.m3), m12: r(BARS.m12), vs_m1: vs(BARS.m1), vs_m3: vs(BARS.m3), vs_m12: vs(BARS.m12),
            above_50d: ma50 ? levels.at(-1) > ma50 : null, above_200d: ma200 ? levels.at(-1) > ma200 : null,
            stretch: stretchPercentile(levels),
        })
    }
    return out
}

/** The industries as state items: the top and bottom TOP_N by 3 months against the S&P, then the stretched. Pure. */
export function industryItems(rows, source = 'engine industry_index (equal-weight liquid baskets)') {
    const ranked = rows.filter(r => r.vs_m3 != null).sort((a, b) => b.vs_m3 - a.vs_m3)
    const line = (r) => `${r.name}: 3m ${_pct(r.vs_m3)} vs S&P (1m ${_pct(r.vs_m1)}, 12m ${_pct(r.vs_m12)}); ${r.above_50d ? 'above' : 'below'} 50-day, ${r.above_200d == null ? '200-day n/a' : r.above_200d ? 'above 200-day' : 'below 200-day'}`
    const items = []
    if (ranked.length) {
        const date = ranked[0].date
        items.push(_item(`Industries LEADING over 3 months against the S&P: ${ranked.slice(0, TOP_N).map(line).join(' · ')}`, null, date, source))
        items.push(_item(`Industries LAGGING over 3 months against the S&P: ${ranked.slice(-TOP_N).reverse().map(line).join(' · ')}`, null, date, source))
    }
    const stretched = rows.filter(r => r.stretch != null && r.stretch >= STRETCHED_AT).sort((a, b) => b.stretch - a.stretch)
    if (stretched.length) {
        items.push(_item(`Industries unusually STRETCHED above their 50-day (top ${Math.round((1 - STRETCHED_AT) * 100)}% of their own last year): ${stretched.map(r => `${r.name} (${Math.round(r.stretch * 100)}th pct)`).join(', ')}`,
            stretched.length, stretched[0].date, source))
    }
    return items
}

/** The engine's capex leaders and the funds' biggest flows as state items. Pure. */
export function moneyItems(leaders, flows, today, names = new Map()) {
    const nameOf = (code) => names.get(code) ?? code
    const items = []
    const usd = (v) => (typeof v !== 'number' ? 'n/a' : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`)
    if (leaders?.asof && (leaders.up?.length || leaders.down?.length)) {
        const row = (r) => `${r.name} ${r.delta >= 0 ? '+' : ''}${usd(r.delta)} (${_pct(r.change, 0)})`
        items.push(_item(`Corporate capex, last 4 quarters vs the 4 before, RISING most: ${(leaders.up ?? []).map(row).join(', ')}`, null, leaders.asof, 'engine industry_metrics (capex)'))
        if (leaders.down?.length) items.push(_item(`Corporate capex FALLING most: ${leaders.down.map(row).join(', ')}`, null, leaders.asof, 'engine industry_metrics (capex)'))
    }
    if (flows instanceof Map && flows.size) {
        const fund = [...flows.entries()].map(([code, f]) => ({ code, ...f?.funds })).filter(f => typeof f.flow_vs_universe === 'number')
            .sort((a, b) => b.flow_vs_universe - a.flow_vs_universe)
        const q = fund[0]?.quarter
        if (fund.length && q) {
            const row = (f) => `${nameOf(f.code)} ${_pct(f.flow_vs_universe)}`
            items.push(_item(`Funds' 13F flows vs the market, quarter ${q}, IN most: ${fund.slice(0, 5).map(row).join(', ')}; OUT most: ${fund.slice(-5).reverse().map(row).join(', ')}`, null, today, `engine industry_funds (13F, ${q})`))
        }
        const clusters = [...flows.entries()].filter(([, f]) => f?.insiders?.cluster).map(([code, f]) => ({ code, ...f.insiders }))
        if (clusters.length) {
            items.push(_item(`Insider buying clusters (90 days; no tested edge alone): ${clusters.slice(0, 8).map(c => `${nameOf(c.code)} (${c.companies_buying} companies)`).join(', ')}`,
                clusters.length, clusters[0].asof ?? today, 'engine industry_insiders'))
        }
    }
    return items
}

/** The known dates as state items: FOMC and high-impact releases, and the largest companies' earnings. Pure. */
export function calendarItems(fedEvents, earnings, today) {
    const items = []
    const seen = new Set()
    for (const e of fedEvents ?? []) {
        if (!(e?.kind === 'fomc' || e?.impact === 'high') || !e.date || e.date < today) continue
        const key = `${e.date}|${e.kind === 'fomc' ? 'fomc' : e.event}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push(_item(`${e.date}: ${e.kind === 'fomc' ? 'FOMC rate decision' : e.event}`, null, today, e.kind === 'fomc' ? 'federalreserve.gov schedule' : 'FRED release calendar'))
    }
    const er = (earnings ?? []).filter(r => r?.date && r.date >= today && r.symbol).sort((a, b) => a.date.localeCompare(b.date))
    if (er.length) items.push(_item(`Earnings of the index movers: ${er.map(r => `${r.symbol} ${r.date}`).join(', ')}`, null, today, 'FMP earnings calendar'))
    return items
}

// ─── the build ────────────────────────────────────────────────────────────────

/**
 * The four data sections for a state as of `today` → `{ sections: { regime, prices, money, calendar }, numbers, gaps }`.
 * `numbers` keeps the raw readings for the board; `gaps` names every leg that failed (a gap is said, never filled).
 * Never throws.
 */
export async function buildDataSections(today = _iso(new Date())) {
    const gaps = []
    const guard = async (name, fn, fallback) => {
        try { return await fn() } catch (err) { gaps.push(`${name}: ${err.message}`); logger.warn(LOG, `${name} failed`, { error: err.message }); return fallback }
    }

    // REGIME — 20 months of each series: a year-on-year needs the year before, and its direction three months more.
    const from = _addDays(today, -610)
    const readings = []
    const all = await Promise.all(REGIME_SERIES.map(spec => guard(`FRED ${spec.id}`, () => _io.series(spec.id, from), [])))
    REGIME_SERIES.forEach((spec, i) => {
        const r = seriesReading(spec, all[i])
        if (r) readings.push(r); else if (!gaps.some(g => g.startsWith(`FRED ${spec.id}`))) gaps.push(`FRED ${spec.id}: no readings`)
    })

    // PRICES — the S&P from the engine's window, the rest from FMP; breadth over the engine's universe.
    const db = await guard('engine database', () => _io.engineDb(), null)
    let spx = null
    const market = []
    const prices = []
    for (const spec of MARKET) {
        let rows = [], fromEngine = false
        if (spec.engine && db) {
            const doc = await guard(`engine ${spec.symbol}`, () => db.collection('daily_prices_recent').findOne({ symbol: spec.symbol }), null)
            if (doc) {
                const { close } = dailyRows(doc)
                rows = close.map((c, i) => ({ date: i === close.length - 1 ? doc.last_date : null, close: c }))
                spx = { date: doc.last_date, close }
                fromEngine = true
            }
        }
        if (!fromEngine) {
            rows = await guard(`FMP ${spec.symbol}`, () => _io.candles(spec.symbol), [])
        }
        const m = marketReading(spec, rows)
        if (m) { market.push(m); prices.push(marketItem(m, fromEngine ? 'engine daily_prices_recent' : `FMP daily bars ${spec.symbol}`)) }
        else gaps.push(`${spec.label}: too few bars`)
    }
    let breadthReading = null, industries = []
    const subNames = new Map()   // sub-industry code → name, for the money lines
    if (db) {
        const docs = await guard('engine daily window', () => db.collection('daily_prices_recent').find({ symbol: { $not: /^\^/ } }, { projection: { close: 1, format: 1, last_date: 1 } }).toArray(), [])
        breadthReading = breadth(docs.map(d => dailyRows(d).close))
        if (breadthReading && spx) prices.push(_item(`Breadth: ${Math.round(breadthReading.share * 100)}% of ${breadthReading.n} stocks are above their 200-day average`, breadthReading.share, spx.date, 'engine daily_prices_recent'))
        if (spx) {
            const names = await guard('industry names', async () => {
                const last = await db.collection('industry_timing').find({}, { projection: { asof: 1 } }).sort({ asof: -1 }).limit(1).next()
                const rows = last ? await db.collection('industry_timing').find({ asof: last.asof }, { projection: { basket: 1, basket_name: 1, name: 1, code: 1 } }).toArray() : []
                for (const r of rows) if (r.code && r.name) subNames.set(r.code, r.name)
                return new Map(rows.map(r => [r.basket, r.basket_name ?? r.name]))
            }, new Map())
            const idx = await guard('engine industry_index', () => db.collection('industry_index').find({}, { projection: { dates: 1, levels: 1 } }).toArray(), [])
            industries = industryRows(idx, spx, names)
            prices.push(...industryItems(industries))
        }
    }

    // MONEY — the engine's capex leaders and the funds' flows.
    const leaders = await guard('capex leaders', () => _io.moneyLeaders(), null)
    const flows = await guard('flows', () => _io.flows(), new Map())
    const money = moneyItems(leaders, flows, today, subNames)

    // CALENDAR — the next CALENDAR_DAYS.
    const to = _addDays(today, CALENDAR_DAYS)
    const fed = await guard('Fed calendar', () => _io.fedEvents(today, to), [])
    const er = await guard('earnings calendar', () => _io.earnings(today, to, INDEX_MOVERS), [])
    const calendar = calendarItems(fed, er, today)

    return {
        sections: { regime: readings.map(regimeItem), prices, money, calendar },
        numbers: { regime: readings, market, breadth: breadthReading, industries },
        gaps,
    }
}
