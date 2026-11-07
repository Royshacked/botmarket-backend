// THE QUARTERS A STOCK BEAT SPY BY 5%+, FROM EVERY SIDE (declared in screener-lab.md §39, before the run). Roy, 2026-11-07:
// "from all aspects, not just reports, what is common in those stocks". §36's rows and groups; every fact the lab can
// date, by family, winners against LOSERS; then what happened inside the quarter (hindsight).
//
//   node --max-old-space-size=6000 scripts/lab-quarter-winners-all.mjs
//
// Offline: data/lab caches + data/lab/sec-facts.jsonl (lab-fundamentals-fetch.mjs) + screener.extras.json (analysts and
// shorts, for the members the screener also covers).
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { prepareFundamentals, fundamentalsAt } = await import('../services/secFundamentals.service.js')
const { featuresAt, FEATURES, fitAndScore } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const EDGE = 5, SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3', DAY_MS = 86_400_000
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()
const facts = new Map(fs.readFileSync('data/lab/sec-facts.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(r => r.c).map(r => [r.symbol, prepareFundamentals(r.c)]))
let sx = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
const grades = sx.grades ?? {}, targets = sx.targets ?? {}
// Short interest per name, oldest first, with the day it was safe to know (FINRA publishes ~7 business days on).
const shorts = new Map()
for (const [settle, rows] of Object.entries(sx.shortInterest ?? {})) for (const [sym, , dtc, change] of rows) {
    if (!data.names.has(sym)) continue
    if (!shorts.has(sym)) shorts.set(sym, [])
    shorts.get(sym).push({ known: new Date(Date.parse(`${settle}T12:00:00Z`) + 10 * DAY_MS).toISOString().slice(0, 10), dtc, change })
}
for (const l of shorts.values()) l.sort((a, b) => a.known.localeCompare(b.known))
sx = null

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const ago = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10)
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) cur.last = d
    else quarters.push({ q, first: d, last: d, base: cur?.last ?? null })
}
const QA = quarters.filter(x => x.base), Q = QA.filter(x => x.q >= FIRST_Q && x.q <= LAST_Q)
const prevQ = new Map(QA.slice(1).map((x, n) => [x.q, QA[n].q]))
const yearAgoQ = (q) => `${Number(q.slice(0, 4)) - 1}${q.slice(4)}`

// Every name's net in every quarter (no membership: a name's own history), for seasonality and the sectors.
const netOf = new Map()
for (const [symbol, s] of data.names) {
    const at = new Map(s.ind.date.map((d, n) => [d, n]))
    for (const x of QA) {
        const j = at.get(x.base), e = at.get(x.last)
        if (j == null || e == null) continue
        const r = pct(s.rows[e].close, s.rows[j].close), sp = pct(data.spyByDay.get(x.last)?.close, data.spyByDay.get(x.base)?.close)
        if (r != null && sp != null) netOf.set(`${symbol} ${x.q}`, r - sp)
    }
}
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
// The sector's median MEMBER net per quarter.
const sectorNet = new Map()
for (const x of QA) {
    const by = new Map()
    for (const [symbol, s] of data.names) {
        const v = netOf.get(`${symbol} ${x.q}`)
        if (v == null || !member(symbol, x.first)) continue
        const k = s.sector ?? 'unknown'
        if (!by.has(k)) by.set(k, []); by.get(k).push(v)
    }
    for (const [k, v] of by) if (v.length >= 8) sectorNet.set(`${k} ${x.q}`, median(v))
}

const epsG = (est, act) => (Number.isFinite(est) && Number.isFinite(act) && act !== 0 ? Math.max(-100, Math.min(100, (est - act) / Math.abs(act) * 100)) : null)
const FAMILIES = {
    price: FEATURES.filter(k => !['gap_open', 'report_in_week', 'last_surprise', 'beats_last3', 'days_since_report', 'last_reaction'].includes(k)),
    'size & value': ['mcap_log', 'ps', 'earn_yield', 'book_mkt'],
    'growth & quality': ['rev_growth', 'margin', 'margin_chg', 'share_chg'],
    earnings: ['last_surprise', 'last_rev_surprise', 'beats_last3', 'last_reaction', 'days_since_report', 'exp_rev_growth', 'exp_eps_growth'],
    insiders: ['insider_buys90', 'insider_usd_log'],
    index: ['joined_year'],
    'seasonality & sector': ['same_q_last_year', 'sector_last_q', 'own_last_q'],
    'analysts & shorts (2024 → only)': ['target_upside', 'target_net90', 'grade_net90', 'notes90', 'days_to_cover', 'short_change'],
}
const LATE = new Set(FAMILIES['analysts & shorts (2024 → only)'])

const rows = []
for (const [symbol, s] of data.names) {
    const at = new Map(s.ind.date.map((d, n) => [d, n]))
    const dates = [...s.reports.keys()].sort(), fund = facts.get(symbol)
    for (const x of Q) {
        const j = at.get(x.base)
        if (j == null || j < 60 || !member(symbol, x.first)) continue
        let e = at.get(x.last)
        if (e == null) {
            const lastDay = s.ind.date.at(-1)
            if (!(lastDay > x.base && lastDay < x.last)) continue
            e = s.ind.date.length - 1
        }
        const ret = pct(s.rows[e].close, s.rows[j].close), spy = pct(data.spyByDay.get(s.ind.date[e])?.close, data.spyByDay.get(x.base)?.close)
        if (ret == null || spy == null) continue
        const close = s.rows[j].close, day = x.base
        const f = { ...featuresAt(s, data, j, j + 1, j + 1), ...fundamentalsAt(fund, day, close) }
        // Earnings: the last report's revenue surprise; the coming report's estimates against the same quarter a year on.
        const last = dates.filter(d => d <= day).at(-1), next = dates.find(d => d > day)
        const rl = last ? s.reports.get(last) : null
        f.last_rev_surprise = rl && Number(rl.revenueActual) > 0 && Number(rl.revenueEstimated) > 0 ? pct(Number(rl.revenueActual), Number(rl.revenueEstimated)) : null
        if (next) {
            const rn = s.reports.get(next), ya = dates.filter(d => d <= day && (Date.parse(next) - Date.parse(d)) / DAY_MS >= 330 && (Date.parse(next) - Date.parse(d)) / DAY_MS <= 400).at(-1)
            const ry = ya ? s.reports.get(ya) : null
            f.exp_rev_growth = ry ? pct(Number(rn?.revenueEstimated), Number(ry.revenueActual)) : null
            f.exp_eps_growth = ry && rn?.epsEstimated != null && ry.epsActual != null ? epsG(Number(rn.epsEstimated), Number(ry.epsActual)) : null
        } else f.exp_rev_growth = f.exp_eps_growth = null
        const buys = s.insiders.filter(t => t.filed <= day && t.filed > ago(day, 90))
        f.insider_buys90 = buys.length
        f.insider_usd_log = Math.log10(1 + buys.reduce((a, t) => a + t.usd, 0))
        f.joined_year = (u.spans[symbol] ?? []).some(([a]) => a > u.from && a <= day && a > ago(day, 365)) ? 1 : 0
        f.same_q_last_year = netOf.get(`${symbol} ${yearAgoQ(x.q)}`) ?? null
        f.sector_last_q = sectorNet.get(`${s.sector ?? 'unknown'} ${prevQ.get(x.q)}`) ?? null
        f.own_last_q = netOf.get(`${symbol} ${prevQ.get(x.q)}`) ?? null
        // Analysts and shorts: only where the cache reaches (from 2023-06, the screener's members).
        const late = day >= '2023-09-01' && grades[symbol]
        const tg = late ? (targets[symbol] ?? []).filter(t => t[0] <= day && t[0] > ago(day, 90)) : []
        f.target_upside = late && tg.length ? pct(median(tg.map(t => t[1])), close) : null
        f.target_net90 = late ? tg.reduce((a, t) => a + t[3], 0) : null
        const gr = late ? grades[symbol].filter(g => g[0] <= day && g[0] > ago(day, 90)) : []
        f.grade_net90 = late ? gr.filter(g => g[1] === 'upgrade').length - gr.filter(g => g[1] === 'downgrade').length : null
        f.notes90 = late ? tg.length + gr.length : null
        const si = late ? (shorts.get(symbol) ?? []).filter(r => r.known <= day).at(-1) : null
        f.days_to_cover = si?.dtc ?? null
        f.short_change = si?.change ?? null
        // Inside the quarter (hindsight).
        const inQ = (d) => d > day && d <= s.ind.date[e]
        const inside = {
            sector: sectorNet.get(`${s.sector ?? 'unknown'} ${x.q}`) ?? null,
            insider_buys: s.insiders.filter(t => inQ(t.filed)).length,
            target_net: late ? (targets[symbol] ?? []).filter(t => inQ(t[0])).reduce((a, t) => a + t[3], 0) : null,
            grade_net: late ? grades[symbol].filter(g => inQ(g[0]) && g[1] === 'upgrade').length - grades[symbol].filter(g => inQ(g[0]) && g[1] === 'downgrade').length : null,
        }
        const net = ret - spy
        rows.push({ symbol, q: x.q, day: x.first, sector: s.sector ?? 'unknown', net, f, inside, group: net >= EDGE ? 'win' : net <= -EDGE ? 'lose' : 'mid' })
    }
}

const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const n2 = (x, w = 8) => (x == null ? '—'.padStart(w) : (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)).padStart(w))
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const share = (ts, p) => (ts.length ? `${(ts.filter(p).length / ts.length * 100).toFixed(0)}%` : '—').padStart(4)
/** The chance a random winner's value is over a random loser's (ties half). Pure. */
function auc(wins, loses, val) {
    const v = [...wins.map(t => ({ x: val(t), w: true })), ...loses.map(t => ({ x: val(t), w: false }))].filter(z => Number.isFinite(z.x)).sort((a, b) => a.x - b.x)
    let sumW = 0, nW = 0
    for (let n = 0; n < v.length;) {
        let m = n
        while (m < v.length && v[m].x === v[n].x) m++
        const r = (n + 1 + m) / 2
        for (let q = n; q < m; q++) if (v[q].w) { sumW += r; nW++ }
        n = m
    }
    const nL = v.length - nW
    return nW && nL && nW >= 30 && nL >= 30 ? (sumW - nW * (nW + 1) / 2) / (nW * nL) : null
}
const P = { before: rows.filter(r => r.day < SPLIT), after: rows.filter(r => r.day >= SPLIT) }
const G = (ts, g) => ts.filter(r => r.group === g)
const known = (k) => (rows.filter(r => Number.isFinite(r.f[k])).length / rows.length * 100).toFixed(0)

console.log(`${rows.length} name-quarters · ${Q.length} quarters · winners ${share(rows, r => r.group === 'win')} · losers ${share(rows, r => r.group === 'lose')} · SEC facts for ${facts.size} of ${Object.keys(u.spans).length} names`)
console.log('\n── KNOWN AT THE START: AUC winners vs LOSERS, 2020–2023 → 2024 → (over 0.5 = winners had more) · medians win / mid / lose · % of rows known')
const leads = []
for (const [fam, keys] of Object.entries(FAMILIES)) {
    console.log(`\n  ${fam}`)
    for (const k of keys) {
        const a1 = LATE.has(k) ? null : auc(G(P.before, 'win'), G(P.before, 'lose'), r => r.f[k]), a2 = auc(G(P.after, 'win'), G(P.after, 'lose'), r => r.f[k])
        const lead = a1 != null && a2 != null && (a1 - 0.5) * (a2 - 0.5) > 0 && Math.abs(a1 - 0.5) >= 0.03 && Math.abs(a2 - 0.5) >= 0.03
        if (lead) leads.push(k)
        const med = ['win', 'mid', 'lose'].map(g => median(G(rows, g).map(r => r.f[k])))
        console.log(`  ${lead ? '◆' : ' '} ${k.padEnd(18)} AUC ${a1?.toFixed(3) ?? '  —  '} → ${a2?.toFixed(3) ?? '  —  '} · ${med.map(m => n2(m)).join(' /')} · known ${known(k).padStart(3)}%`)
    }
}
console.log(`\n  ◆ leads (same side both periods, 0.03+ off 0.5): ${leads.join(', ') || 'none'}`)

console.log('\n── THE TOP AND BOTTOM FIFTH OF EACH LEAD (cut on 2020–2023): winners and losers per period')
for (const k of leads) {
    const v = P.before.map(r => r.f[k]).filter(Number.isFinite).sort((a, b) => a - b), lo = v[Math.floor(v.length / 5)], hi = v[Math.floor(4 * v.length / 5)]
    const cell = (ts, p) => { const x = ts.filter(r => Number.isFinite(r.f[k]) && p(r.f[k])); return `${String(x.length).padStart(5)} win ${share(x, r => r.group === 'win')} lose ${share(x, r => r.group === 'lose')} net ${f2(mean(x.map(r => r.net)))}` }
    console.log(`  ${k.padEnd(18)} bottom (< ${n2(lo, 0)}): ${cell(P.before, z => z < lo)} → ${cell(P.after, z => z < lo)}`)
    console.log(`  ${''.padEnd(18)} top (≥ ${n2(hi, 0)}):    ${cell(P.before, z => z >= hi)} → ${cell(P.after, z => z >= hi)}`)
}

// Every fact known in both periods at once: fitted on 2020–2023, scored on 2024 → (winners against losers only).
const ALL = Object.values(FAMILIES).flat().filter(k => !LATE.has(k))
const movers = rows.filter(r => r.group !== 'mid').map(r => ({ week: r.day, up: r.group === 'win', net: r.net, x: Float32Array.from(ALL, k => (Number.isFinite(r.f[k]) ? r.f[k] : NaN)) }))
const fit = fitAndScore(movers, SPLIT, { features: ALL })
console.log(`\n── EVERY FACT TOGETHER — fitted on 2020–2023 (${fit.train}), scored on 2024 → (${fit.held.n}): AUC ${fit.held.auc}`)
console.log(`  heaviest weights: ${Object.entries(fit.weights).slice(0, 10).map(([k, w]) => `${k} ${w}`).join(' · ')}`)
fit.held.deciles.forEach((d, n) => console.log(`  decile ${String(n + 1).padStart(2)}: ${String(d.n).padStart(5)} · winners ${String(d.up).padStart(5)}% · mean net ${f2(d.net_mean)}`))

console.log('\n── INSIDE THE QUARTER (hindsight)')
for (const g of ['win', 'mid', 'lose']) {
    const ts = G(rows, g), sec = ts.map(r => r.inside.sector)
    console.log(`  ${g.padEnd(4)} ${String(ts.length).padStart(5)} · net median ${f2(median(ts.map(r => r.net)))} = its sector's ${f2(median(sec))} + its own ${f2(median(ts.map(r => (r.inside.sector == null ? null : r.net - r.inside.sector))))} · sector beat SPY ${share(ts.filter(r => r.inside.sector != null), r => r.inside.sector > 0)} · insider buy ${share(ts, r => r.inside.insider_buys > 0)}`)
    const late = ts.filter(r => r.inside.target_net != null)
    console.log(`       (2024 →, ${late.length}) target raises − cuts in the quarter: mean ${n2(mean(late.map(r => r.inside.target_net)), 0)} · net raised ${share(late, r => r.inside.target_net > 0)} · upgrades − downgrades: mean ${n2(mean(late.map(r => r.inside.grade_net)), 0)}`)
}
console.log('\n  how much of a winner is its sector: winners whose sector median beat SPY by 5%+ ' +
    `${share(G(rows, 'win').filter(r => r.inside.sector != null), r => r.inside.sector >= 5)} · whose OWN part (net − sector) is 5%+ ${share(G(rows, 'win').filter(r => r.inside.sector != null), r => r.net - r.inside.sector >= 5)}`)
process.exit(0)
