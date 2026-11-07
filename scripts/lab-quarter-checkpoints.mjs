// WHEN IN THE QUARTER THE LEADERS CAN BE TOLD — test T (declared in screener-lab.md §42, before the run). Roy, 2026-11-07:
// "let's check when in the quarter we can predict who leads". At the close of session 5, 10 … 50 of each quarter: how
// many of the final winners are already ahead, and whether the leaders so far (own, industry, laggard in a moving
// industry) beat SPY over the REST of the quarter, bought at the next open.
//
//   node --max-old-space-size=6000 scripts/lab-quarter-checkpoints.mjs
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

const EDGE = 5, SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3', CHECKS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const industry = JSON.parse(fs.readFileSync('data/lab/sp500-industries.json', 'utf8'))
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) { cur.last = d; cur.days.push(d) } else quarters.push({ q, first: d, last: d, days: [d], base: cur?.last ?? null })
}
const Q = quarters.filter(x => x.base && x.q >= FIRST_Q && x.q <= LAST_Q)
const spyC = (d) => data.spyByDay.get(d)?.close, spyO = (d) => data.spyByDay.get(d)?.open

// Per quarter, per member: the final net, and at each checkpoint the QTD net and the rest bought at the next open.
const obs = [] // { q, day, c, symbol, industry, own, rest, final }
const finals = new Map() // `${q} ${symbol}` → final net
for (const x of Q) {
    const sb = spyC(x.base), se = spyC(x.last)
    for (const [symbol, s] of data.names) {
        if (!member(symbol, x.first)) continue
        const at = new Map(s.ind.date.map((d, n) => [d, n]))
        const j = at.get(x.base), e = at.get(x.last)
        if (j == null || e == null || j < 60) continue
        const final = pct(s.rows[e].close, s.rows[j].close) - pct(se, sb)
        if (!Number.isFinite(final)) continue
        finals.set(`${x.q} ${symbol}`, final)
        for (const c of CHECKS) {
            const dc = x.days[c - 1], dn = x.days[c]
            if (!dc || !dn) continue
            const kc = at.get(dc), kn = at.get(dn)
            if (kc == null || kn == null || !(s.rows[kn].open > 0) || !testable(s.rows, kn, s.ind)) continue
            const own = pct(s.rows[kc].close, s.rows[j].close) - pct(spyC(dc), sb)
            const rest = pct(s.rows[e].close, s.rows[kn].open) - pct(se, spyO(dn)) - costFor(s.ind.adv20[kc] ?? 0)
            if (Number.isFinite(own) && Number.isFinite(rest)) obs.push({ q: x.q, day: x.first, c, symbol, industry: industry[symbol] ?? null, own, rest, final })
        }
    }
}
// The industry's median QTD net at each checkpoint, the name left out.
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
const groups = new Map()
for (const o of obs) if (o.industry) { const k = `${o.q} ${o.c} ${o.industry}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o) }
for (const list of groups.values()) {
    if (list.length < 4) continue
    for (const o of list) { o.ind = median(list.filter(z => z !== o).map(z => z.own)); o.lag = o.own - o.ind }
}

const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const tOf = (xs) => { const v = xs.filter(Number.isFinite); if (v.length < 3) return null; const m = mean(v), sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(v.length)) : null }
function auc(wins, loses) {
    const v = [...wins.map(x => ({ x, w: true })), ...loses.map(x => ({ x, w: false }))].filter(z => Number.isFinite(z.x)).sort((a, b) => a.x - b.x)
    let sumW = 0, nW = 0
    for (let n = 0; n < v.length;) { let m = n; while (m < v.length && v[m].x === v[n].x) m++; const r = (n + 1 + m) / 2; for (let q = n; q < m; q++) if (v[q].w) { sumW += r; nW++ } n = m }
    const nL = v.length - nW
    return nW && nL ? (sumW - nW * (nW + 1) / 2) / (nW * nL) : null
}

console.log(`${obs.length} member-checkpoints · ${Q.length} quarters · the rest is bought at the next open, net of SPY and the cost`)

console.log('\n── VISIBLE: the quarter\'s final winners already in the top fifth by OWN, and AUC of OWN for winners vs losers')
for (const c of CHECKS) {
    let inTop = 0, nWin = 0
    const w = [], l = []
    for (const x of Q) {
        const os = obs.filter(o => o.q === x.q && o.c === c).sort((a, b) => b.own - a.own), cut = os[Math.floor(os.length / 5)]?.own
        for (const o of os) {
            if (o.final >= EDGE) { nWin++; if (o.own >= cut) inTop++; w.push(o.own) } else if (o.final <= -EDGE) l.push(o.own)
        }
    }
    console.log(`  session ${String(c).padStart(2)}: ${(inTop / nWin * 100).toFixed(0).padStart(3)}% of winners in the top fifth · AUC ${auc(w, l)?.toFixed(3)}`)
}

// Per ranking and checkpoint: each quarter's fifths → mean rest; top less every member; per period.
const RANKS = { own: (o) => o.own, industry: (o) => o.ind, laggard: (o) => o.lag }
const res = {}
console.log('\n── PREDICT THE REST: the top and bottom fifth by each ranking, mean rest-of-quarter net per quarter')
for (const [name, val] of Object.entries(RANKS)) {
    res[name] = {}
    console.log(`\n  ${name.toUpperCase()}${name === 'laggard' ? ' (own − industry; the BOTTOM fifth = behind a moving industry)' : ''}`)
    for (const c of CHECKS) {
        const perQ = []
        for (const x of Q) {
            const os = obs.filter(o => o.q === x.q && o.c === c && Number.isFinite(val(o))).sort((a, b) => val(b) - val(a))
            if (os.length < 50) continue
            const n5 = Math.floor(os.length / 5), top = os.slice(0, n5), bot = os.slice(-n5)
            const all = mean(os.map(o => o.rest))
            perQ.push({ day: x.first, top: mean(top.map(o => o.rest)), bot: mean(bot.map(o => o.rest)), all })
        }
        const split = (p) => ({ b: p(perQ.filter(r => r.day < SPLIT)), a: p(perQ.filter(r => r.day >= SPLIT)) })
        const top = split(rs => mean(rs.map(r => r.top))), bot = split(rs => mean(rs.map(r => r.bot))), all = split(rs => mean(rs.map(r => r.all)))
        const ex = perQ.map(r => r.top - r.all), exB = perQ.map(r => r.bot - r.all)
        res[name][c] = { top, bot, all, t: tOf(ex), tB: tOf(exB) }
        console.log(`    session ${String(c).padStart(2)} · top ${f2(top.b)} → ${f2(top.a)} · bottom ${f2(bot.b)} → ${f2(bot.a)} · every member ${f2(all.b)} → ${f2(all.a)} · top − all t ${tOf(ex)?.toFixed(2)} · bottom − all t ${tOf(exB)?.toFixed(2)}`)
    }
}

console.log('\nDECLARED BAR (top fifth above SPY and above every member in both periods · t ≥ 2 · a neighbouring checkpoint above both too)')
for (const [name] of Object.entries(RANKS)) {
    // The laggard's side is its bottom fifth (behind its industry); own and industry, the top.
    const side = name === 'laggard' ? 'bot' : 'top', tk = name === 'laggard' ? 'tB' : 't'
    const ok = (c) => { const r = res[name][c]; return r && r[side].b > 0 && r[side].a > 0 && r[side].b > r.all.b && r[side].a > r.all.a }
    const marks = CHECKS.map((c, n) => {
        const nb = [CHECKS[n - 1], CHECKS[n + 1]].filter(Boolean).some(ok), sig = res[name][c]?.[tk] >= 2
        return `${c}: ${ok(c) && sig && nb ? 'PASS' : 'fail'}${ok(c) ? '·both' : ''}${sig ? '·t' : ''}`
    })
    console.log(`  ${name.padEnd(9)} ${marks.join('  ')}`)
}
process.exit(0)
