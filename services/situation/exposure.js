// WHAT EACH INDUSTRY IS EXPOSED TO (docs/design/situation-network-plan.md §7; plan step 7).
//
// The industry mapping's grounding, so the model maps a branch to industries from evidence and not from memory:
//   · SENSITIVITIES, computed here from data Render has: each `industry_index` basket's weekly returns over its ~2 years
//     against the S&P (beta), and what is left after the market against the weekly change in the 10-year (per +1
//     point), Brent (per +1%) and the broad dollar (per +1%), each with its t-statistic;
//   · PAST REACTIONS to a list of events DECLARED in the plan before any was computed: daily ones from `industry_index`
//     (2024-08 on), and monthly ones 2007–2025 seeded into `industry_reactions` (aether seed_industry_reactions.py).
// Every reaction is the industry against the average of all industries, so a day that lifts everything lifts nothing.

import { fetchSeries } from '../../providers/fred.provider.js'
import { getFmpCandles } from '../../providers/fmp.price.provider.js'
import { getEngineDb } from '../engineDb.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.exposure]'

/** The daily events, declared 2026-11-23 (plan §7). Day 0 is the first session the news could move. */
export const DAILY_EVENTS = Object.freeze([
    { id: 'us_election_2024', date: '2024-11-06', label: 'US election 2024' },
    { id: 'deepseek_2025', date: '2025-01-27', label: 'DeepSeek R1 shock' },
    { id: 'tariffs_announced_2025', date: '2025-02-03', label: 'Tariffs on Canada, Mexico, China announced' },
    { id: 'liberation_day_2025', date: '2025-04-03', label: '"Liberation Day" tariffs' },
    { id: 'tariff_pause_2025', date: '2025-04-09', label: 'The 90-day tariff pause' },
    { id: 'geneva_truce_2025', date: '2025-05-12', label: 'US-China Geneva truce' },
    { id: 'israel_strikes_iran_2025', date: '2025-06-13', label: 'Israel strikes Iran' },
    { id: 'us_strikes_iran_2025', date: '2025-06-23', label: 'US strikes Iran' },
])
/** A sensitivity counts as material at |t| ≥ this. */
export const T_MATERIAL = 2
export const MIN_WEEKS = 40

const _io = {
    engineDb: () => getEngineDb(),
    series: (id, from) => fetchSeries(id, { from }),
    spx: async () => {
        const to = Date.now(), from = to - 900 * 864e5
        const rows = await getFmpCandles('^GSPC', { timeSpan: 'day', from, to })
        return (rows ?? []).map(r => ({ date: new Date((r.timestamp > 1e12 ? r.timestamp : r.timestamp * 1000)).toISOString().slice(0, 10), close: r.close })).filter(r => r.close > 0)
    },
}
export function _setIO(io) { Object.assign(_io, io) }

// ─── pure ─────────────────────────────────────────────────────────────────────

/** The ISO week key of a date (YYYY-Www), Monday-based. Pure. */
export function weekKey(iso) {
    const d = new Date(`${iso}T00:00:00Z`)
    const day = (d.getUTCDay() + 6) % 7
    d.setUTCDate(d.getUTCDate() - day + 3)
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
    const week = 1 + Math.round(((d - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Dated values → the LAST value of each week, `Map(week → value)`. Pure. */
export function weekly(points) {
    const out = new Map()
    for (const p of [...points].sort((a, b) => a.date.localeCompare(b.date))) if (Number.isFinite(p.value)) out.set(weekKey(p.date), p.value)
    return out
}

/** Ordinary least squares of y on x → `{ slope, t, n }` (null under 10 points or no spread). Pure. */
export function ols(x, y) {
    const n = Math.min(x.length, y.length)
    if (n < 10) return null
    const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n
    let sxx = 0, sxy = 0
    for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my) }
    if (sxx === 0) return null
    const slope = sxy / sxx, a = my - slope * mx
    let sse = 0
    for (let i = 0; i < n; i++) sse += (y[i] - a - slope * x[i]) ** 2
    const se = Math.sqrt(sse / (n - 2) / sxx)
    return { slope, t: se > 0 ? slope / se : 0, n }
}

/**
 * One basket's sensitivities from weekly series: beta to the S&P; then the residual's slope on the 10-year's change
 * (points), Brent's % change and the dollar's % change. Pure.
 */
export function sensitivities(basketW, spxW, factorsW) {
    const weeks = [...basketW.keys()].filter(w => spxW.has(w)).sort()
    const r = [], m = [], keep = []
    for (let i = 1; i < weeks.length; i++) {
        const a = weeks[i - 1], b = weeks[i]
        const rb = basketW.get(b) / basketW.get(a) - 1, rm = spxW.get(b) / spxW.get(a) - 1
        if (Number.isFinite(rb) && Number.isFinite(rm)) { r.push(rb); m.push(rm); keep.push([a, b]) }
    }
    if (r.length < MIN_WEEKS) return null
    const beta = ols(m, r)
    const resid = r.map((v, i) => v - beta.slope * m[i])
    const factor = (w, kind) => {
        const x = [], y = []
        keep.forEach(([a, b], i) => {
            if (!w.has(a) || !w.has(b)) return
            const dx = kind === 'level' ? w.get(b) - w.get(a) : w.get(b) / w.get(a) - 1
            if (Number.isFinite(dx)) { x.push(kind === 'level' ? dx : dx * 100); y.push(resid[i] * 100) }
        })
        return ols(x, y)
    }
    return {
        weeks: r.length, beta: beta.slope,
        rates: factor(factorsW.rates, 'level'),   // % return per +1 point on the 10-year
        oil: factor(factorsW.oil, 'pct'),         // % return per +1% on Brent
        dollar: factor(factorsW.dollar, 'pct'),   // % return per +1% on the dollar
    }
}

/** Each basket's reaction to each daily event: its day-0 and days-0–5 return minus the mean of all baskets. Pure. */
export function dailyReactions(docs, events = DAILY_EVENTS) {
    const out = []
    for (const e of events) {
        const rows = []
        for (const d of docs) {
            const i = (d.dates ?? []).findIndex(x => x >= e.date)
            if (i < 1 || i + 5 >= d.dates.length) continue
            const lv = d.levels
            rows.push({ basket: d._id, d0: lv[i] / lv[i - 1] - 1, d5: lv[i + 5] / lv[i - 1] - 1 })
        }
        if (rows.length < 10) continue
        const m0 = rows.reduce((s, r) => s + r.d0, 0) / rows.length, m5 = rows.reduce((s, r) => s + r.d5, 0) / rows.length
        out.push({ ...e, kind: 'daily', rows: rows.map(r => ({ basket: r.basket, d0: r.d0 - m0, d5: r.d5 - m5 })) })
    }
    return out
}

const pct = (v, d = 1) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : 'n/a')
const fac = (f, unit) => (f && Math.abs(f.t) >= T_MATERIAL ? `${f.slope >= 0 ? '+' : ''}${f.slope.toFixed(2)}% per ${unit} (t ${f.t.toFixed(1)})` : null)

/** One industry's evidence as a line for the mapping prompt. Pure. */
export function exposureLine(ind) {
    const s = ind.sens
    const parts = []
    if (s) {
        parts.push(`beta ${s.beta.toFixed(2)}`)
        const f = [fac(s.rates, '+1pt 10y'), fac(s.oil, '+1% Brent'), fac(s.dollar, '+1% dollar')].filter(Boolean)
        parts.push(f.length ? `after the market: ${f.join(', ')}` : 'no material rate / oil / dollar sensitivity')
    } else parts.push('sensitivities: too little history')
    const big = (ind.reactions ?? []).filter(r => Math.abs(r.v) >= 0.02).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 5)
    if (big.length) parts.push(`reactions vs all industries: ${big.map(r => `${r.label} ${pct(r.v)}`).join('; ')}`)
    return `${ind.code} ${ind.name}: ${parts.join('. ')}`
}

// ─── the build ────────────────────────────────────────────────────────────────

/** basket → name, from the engine's latest `industry_timing` rows. */
async function latestNames(db) {
    const last = (await db.collection('industry_timing').find({}, { projection: { asof: 1 } }).sort({ asof: -1 }).limit(1).toArray())[0]
    if (!last) return new Map()
    const rows = await db.collection('industry_timing').find({ asof: last.asof }, { projection: { basket: 1, basket_name: 1, name: 1 } }).toArray()
    return new Map(rows.filter(r => r.basket).map(r => [r.basket, r.basket_name ?? r.name]).filter(([, n]) => n))
}

/**
 * Every basket's evidence → `{ industries: [{ basket, level, code, name, sens, reactions }], events, gaps }`. Monthly
 * reactions are matched to a basket by its GICS industry (the first 6 digits). Never throws.
 */
export async function buildExposures(names = new Map()) {
    const gaps = []
    const guard = async (name, fn, fb) => { try { return await fn() } catch (err) { gaps.push(`${name}: ${err.message}`); logger.warn(LOG, `${name} failed`, { error: err.message }); return fb } }
    const db = await guard('engine database', () => _io.engineDb(), null)
    if (!db) return { industries: [], events: [], gaps }
    const docs = await guard('industry_index', () => db.collection('industry_index').find({}, { projection: { dates: 1, levels: 1 } }).toArray(), [])
    const from = docs.map(d => d.dates?.[0]).filter(Boolean).sort()[0] ?? '2024-08-01'
    const [spx, dgs10, brent, usd] = await Promise.all([
        guard('FMP ^GSPC', () => _io.spx(), []), guard('FRED DGS10', () => _io.series('DGS10', from), []),
        guard('FRED DCOILBRENTEU', () => _io.series('DCOILBRENTEU', from), []), guard('FRED DTWEXBGS', () => _io.series('DTWEXBGS', from), []),
    ])
    const spxW = weekly(spx.map(r => ({ date: r.date, value: r.close })))
    const factorsW = { rates: weekly(dgs10), oil: weekly(brent), dollar: weekly(usd) }
    const daily = dailyReactions(docs)
    const monthly = await guard('industry_reactions', () => db.collection('industry_reactions').find({}).toArray(), [])
    // Every basket's name from the engine's latest timing rows, under the names passed in: the passed names come from the
    // previous run on an update, so a code that was ever unnamed stayed a bare code ("20101010" — prod, 2026-11-24).
    const known = await guard('industry names', () => latestNames(db), new Map())
    if (!monthly.length) gaps.push('industry_reactions: none seeded (run aether-engine scripts/seed_industry_reactions.py)')
    const industries = docs.map(d => {
        const [level, code] = String(d._id).split(':')
        const sens = sensitivities(weekly((d.dates ?? []).map((date, i) => ({ date, value: d.levels[i] }))), spxW, factorsW)
        const reactions = [
            ...daily.map(e => ({ id: e.id, label: e.label, v: e.rows.find(r => r.basket === d._id)?.d5 })).filter(r => typeof r.v === 'number'),
            ...monthly.map(e => ({ id: e._id, label: `${e.label} (${e.month})`, v: e.rows.find(r => r.code === code.slice(0, 6))?.excess })).filter(r => typeof r.v === 'number'),
        ]
        const passed = names.get(d._id)
        return { basket: d._id, level, code, name: (passed && passed !== code ? passed : null) ?? known.get(d._id) ?? code, sens, reactions }
    })
    return { industries, events: [...daily.map(e => ({ id: e.id, label: e.label, date: e.date })), ...monthly.map(e => ({ id: e._id, label: e.label, month: e.month }))], gaps }
}
