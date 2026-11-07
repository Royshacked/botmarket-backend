// IN A MARKET TRENDING UP, THE TRENDING INDUSTRIES — test V (declared in screener-lab.md §44, before the run). Roy,
// 2026-11-07: "so if the market trends up, so trending industries". At session 15 / 20 / 25 of each quarter, in quarters
// SPY is trending up (over its 200- and 50-day, up over 63 sessions): the members of the industries leading the quarter
// so far, bought at the next open, held to the quarter's end, against SPY and every member.
//
//   node --max-old-space-size=6000 scripts/lab-quarter-trend-industry.mjs
//
// Offline: data/lab caches + sp500-industries.json.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { costFor, testable } = await import('../services/screenerLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3', CHECKS = [15, 20, 25], MAIN = 20
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const industry = JSON.parse(fs.readFileSync('data/lab/sp500-industries.json', 'utf8'))
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
const tOf = (xs) => { const v = xs.filter(Number.isFinite); if (v.length < 3) return null; const m = mean(v), sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(v.length)) : null }
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) { cur.last = d; cur.days.push(d) } else quarters.push({ q, first: d, last: d, days: [d], base: cur?.last ?? null })
}
const Q = quarters.filter(x => x.base && x.q >= FIRST_Q && x.q <= LAST_Q)
const spyC = (d) => data.spyByDay.get(d)?.close, spyO = (d) => data.spyByDay.get(d)?.open
const spyIdx = new Map(data.spyDays.map((d, n) => [d, n]))
/** SPY trending up at the close of `day`: over its 200- and 50-day averages and up over 63 sessions. Pure over the bars. */
function trendingUp(day) {
    const n = spyIdx.get(day)
    if (n == null || n < 200) return null
    const c = (k) => spyC(data.spyDays[k]), avg = (len) => mean(Array.from({ length: len }, (_, k) => c(n - k)))
    return c(n) > avg(200) && c(n) > avg(50) && c(n) > c(n - 63)
}

const obs = []
for (const x of Q) {
    const sb = spyC(x.base), se = spyC(x.last)
    for (const [symbol, s] of data.names) {
        if (!member(symbol, x.first)) continue
        const at = new Map(s.ind.date.map((d, n) => [d, n]))
        const j = at.get(x.base), e = at.get(x.last)
        if (j == null || e == null || j < 70) continue
        for (const c of CHECKS) {
            const dc = x.days[c - 1], dn = x.days[c]
            if (!dc || !dn) continue
            const kc = at.get(dc), kn = at.get(dn)
            if (kc == null || kn == null || kc - j !== c || !(s.rows[kn].open > 0) || !testable(s.rows, kn, s.ind)) continue
            const rest = pct(s.rows[e].close, s.rows[kn].open) - pct(se, spyO(dn)) - costFor(s.ind.adv20[kc] ?? 0)
            const own = pct(s.rows[kc].close, s.rows[j].close) - pct(spyC(dc), sb)
            const rs60 = pct(s.rows[kc].close, s.rows[kc - 60].close) - pct(spyC(dc), spyC(s.ind.date[kc - 60]))
            if (Number.isFinite(rest) && Number.isFinite(own)) obs.push({ q: x.q, day: x.first, c, symbol, industry: industry[symbol] ?? null, rest, own, rs60, up: trendingUp(dc) })
        }
    }
}
// The industry's median, the name left out, 4+ members.
const grp = new Map()
for (const o of obs) if (o.industry) { const k = `${o.q} ${o.c} ${o.industry}`; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(o) }
for (const list of grp.values()) {
    if (list.length < 4) continue
    for (const o of list) { const rest = list.filter(z => z !== o); o.indQtd = median(rest.map(z => z.own)); o.ind60 = median(rest.map(z => z.rs60)) }
}

const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
/** Per quarter at checkpoint c, in the regime: the top fifth by `key` → its mean rest, and every member's. */
function read(c, key, regime) {
    const out = []
    for (const x of Q) {
        const qs = obs.filter(o => o.q === x.q && o.c === c && Number.isFinite(o[key]))
        if (qs.length < 50 || qs[0].up !== regime) continue
        qs.sort((a, b) => b[key] - a[key])
        const top = qs.slice(0, Math.floor(qs.length / 5))
        out.push({ q: x.q, day: x.first, top: mean(top.map(o => o.rest)), all: mean(qs.map(o => o.rest)), hit: top.filter(o => o.rest > 0).length / top.length })
    }
    const per = (p) => { const r = out.filter(p); return { n: r.length, top: mean(r.map(z => z.top)), all: mean(r.map(z => z.all)), hit: mean(r.map(z => z.hit)) } }
    return { b: per(z => z.day < SPLIT), a: per(z => z.day >= SPLIT), t: tOf(out.map(z => z.top - z.all)), qs: out }
}

console.log(`${obs.length} member-checkpoints · ${Q.length} quarters · the rest bought at the next open, net of SPY and the cost`)
console.log(`  trending up at session ${MAIN}: ${Q.filter(x => trendingUp(x.days[MAIN - 1])).map(x => x.q).join(' ')}`)
const line = (label, r) => console.log(`    ${label.padEnd(30)} 2020–2023 (${r.b.n} q) top ${f2(r.b.top)} vs all ${f2(r.b.all)} winners ${r.b.hit == null ? ' —' : (r.b.hit * 100).toFixed(0) + '%'} · 2024 → (${r.a.n} q) top ${f2(r.a.top)} vs all ${f2(r.a.all)} winners ${r.a.hit == null ? ' —' : (r.a.hit * 100).toFixed(0) + '%'} · top − all t ${r.t?.toFixed(2) ?? '—'}`)
const res = {}
for (const c of CHECKS) {
    console.log(`\n── SESSION ${c}`)
    for (const regime of [true, false]) {
        console.log(`  ${regime ? 'MARKET TRENDING UP' : 'NOT TRENDING UP (the mirror)'}`)
        const r = read(c, 'indQtd', regime)
        if (regime) res[c] = r
        line('industry, quarter so far (primary)', r)
        line('industry, 60 sessions', read(c, 'ind60', regime))
        line('the name\'s own quarter so far', read(c, 'own', regime))
    }
}
const ok = (r) => r.b.top > 0 && r.a.top > 0 && r.b.top > r.b.all && r.a.top > r.a.all
const v = res[MAIN]
console.log(`\n  session ${MAIN}, trending up, per quarter (top − all): ${v.qs.map(z => `${z.q} ${f2(z.top - z.all, 0)}`).join(' · ')}`)
console.log(`\nDECLARED BAR (session ${MAIN}, trending up, industry quarter so far): above SPY and every member in both periods ${ok(v)} · t ≥ 2 ${v.t >= 2} (${v.t?.toFixed(2)}) · sessions 15 and 25 the same ${ok(res[15]) && ok(res[25])} → ${ok(v) && v.t >= 2 && ok(res[15]) && ok(res[25]) ? 'PASS' : 'FAIL'}`)
process.exit(0)
