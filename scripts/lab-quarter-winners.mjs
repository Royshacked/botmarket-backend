// THE QUARTERS A STOCK BEAT SPY BY 5%+, READ BACKWARDS (declared in screener-lab.md §36, before the run). Roy,
// 2026-11-07: "let's check the opposite way — all the stocks that beat the SPY in a quarter with at least 5%".
// A description: what the winners had at the start (winners against LOSERS, so volatility alone does not count), and
// what happened to them inside the quarter (hindsight). S&P 500 as it was, calendar quarters 2020-Q1 → 2026-Q3.
//
//   node --max-old-space-size=6000 scripts/lab-quarter-winners.mjs
//
// Offline: data/lab caches + data/lab/guidance-8k.jsonl.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { guidanceDirection } = await import('../services/guidance8k.service.js')
const { reactionAt } = await import('../services/reportReaction.service.js')
const { featuresAt, FEATURES } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const EDGE = 5, SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3'
const guidanceOf = new Map(fs.readFileSync('data/lab/guidance-8k.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .map(r => [`${r.symbol} ${r.report}`, r.miss ? 'missing' : guidanceDirection(r)]))
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const revSurprise = (rep) => { const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated); return a > 0 && e > 0 ? (a / e - 1) * 100 : null }
const epsSurprise = (rep) => {
    const a = Number(rep?.epsActual), e = Number(rep?.epsEstimated)
    return rep?.epsActual != null && rep?.epsEstimated != null && Number.isFinite(a) && Number.isFinite(e) && e !== 0 ? Math.max(-100, Math.min(100, ((a - e) / Math.abs(e)) * 100)) : null
}

// The quarters: each one's base (the last session before it), its first and its last session.
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) cur.last = d
    else quarters.push({ q, first: d, last: d, base: cur?.last ?? null })
}
const Q = quarters.filter(x => x.base && x.q >= FIRST_Q && x.q <= LAST_Q)

const FACTS = [...FEATURES.filter(k => !['gap_open', 'report_in_week'].includes(k)), 'last_rev_surprise']
const rows = []
for (const [symbol, s] of data.names) {
    const at = new Map(s.ind.date.map((d, n) => [d, n]))
    const dates = [...s.reports.keys()].sort()
    for (const x of Q) {
        const j = at.get(x.base)
        if (j == null || j < 60 || !member(symbol, x.first)) continue
        let e = at.get(x.last), ended = false
        if (e == null) {
            const lastDay = s.ind.date.at(-1)
            if (!(lastDay > x.base && lastDay < x.last)) continue
            e = s.ind.date.length - 1; ended = true
        }
        const ret = pct(s.rows[e].close, s.rows[j].close)
        const spy = pct(data.spyByDay.get(s.ind.date[e])?.close, data.spyByDay.get(x.base)?.close)
        if (ret == null || spy == null) continue
        const f = featuresAt(s, data, j, j + 1, j + 1)
        const lastRep = dates.filter(d => d <= x.base).at(-1)
        f.last_rev_surprise = lastRep ? revSurprise(s.reports.get(lastRep)) : null
        // Inside the quarter: the first report after the base, on or before the quarter's last session.
        const repDay = dates.find(d => d > x.base && d <= s.ind.date[e])
        let inside = null
        if (repDay) {
            const k = s.ind.date.findIndex(d => d >= repDay)
            const rep = s.reports.get(repDay), reaction = k >= 0 ? reactionAt(s, k, data) : null
            inside = { eps: epsSurprise(rep), rev: revSurprise(rep), reaction, guidance: guidanceOf.get(`${symbol} ${repDay}`) ?? 'not fetched' }
        }
        const net = ret - spy
        rows.push({ symbol, q: x.q, day: x.first, sector: s.sector ?? 'unknown', ret, spy, net, ended, f, inside,
            group: net >= EDGE ? 'win' : net <= -EDGE ? 'lose' : 'mid' })
    }
}

const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const n2 = (x, w = 7) => (x == null ? '—'.padStart(w) : x.toFixed(2).padStart(w))
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
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
    return nW && nL ? (sumW - nW * (nW + 1) / 2) / (nW * nL) : null
}
const P = { '2020–2023': rows.filter(r => r.day < SPLIT), '2024 →': rows.filter(r => r.day >= SPLIT) }
const G = (ts, g) => ts.filter(r => r.group === g)

console.log(`${rows.length} name-quarters · ${Q.length} quarters ${Q[0].q} → ${Q.at(-1).q} · winners (beat SPY by ${EDGE}%+) ${share(rows, r => r.group === 'win')} · losers ${share(rows, r => r.group === 'lose')} · middle ${share(rows, r => r.group === 'mid')}`)
for (const [p, ts] of Object.entries(P)) console.log(`  ${p}: ${ts.length} · winners ${share(ts, r => r.group === 'win')} (mean net ${f2(mean(G(ts, 'win').map(r => r.net)))}, median ${f2(median(G(ts, 'win').map(r => r.net)))}) · losers ${share(ts, r => r.group === 'lose')} (mean ${f2(mean(G(ts, 'lose').map(r => r.net)))})`)

console.log('\n── HOW MANY WON, QUARTER BY QUARTER (SPY\'s own quarter beside it)')
for (const x of Q) {
    const ts = rows.filter(r => r.q === x.q)
    console.log(`  ${x.q} SPY ${f2(ts[0]?.spy)} · ${String(ts.length).padStart(3)} · winners ${share(ts, r => r.group === 'win')} · losers ${share(ts, r => r.group === 'lose')} · median name ${f2(median(ts.map(r => r.net)))}`)
}

console.log('\n── KNOWN AT THE START: AUC winners vs LOSERS (over 0.5 = winners had more), and the three groups\' medians')
const facts = FACTS.map(k => {
    const [a1, a2] = Object.values(P).map(ts => auc(G(ts, 'win'), G(ts, 'lose'), r => r.f[k]))
    return { k, a1, a2, med: ['win', 'mid', 'lose'].map(g => median(G(rows, g).map(r => r.f[k]))) }
}).sort((a, b) => Math.abs((b.a1 ?? 0.5) - 0.5) + Math.abs((b.a2 ?? 0.5) - 0.5) - Math.abs((a.a1 ?? 0.5) - 0.5) - Math.abs((a.a2 ?? 0.5) - 0.5))
for (const r of facts) {
    const lead = r.a1 != null && r.a2 != null && (r.a1 - 0.5) * (r.a2 - 0.5) > 0 && Math.abs(r.a1 - 0.5) >= 0.03 && Math.abs(r.a2 - 0.5) >= 0.03
    console.log(`  ${lead ? '◆' : ' '} ${r.k.padEnd(18)} AUC ${r.a1?.toFixed(3) ?? '—'} → ${r.a2?.toFixed(3) ?? '—'} · median win ${n2(r.med[0])} mid ${n2(r.med[1])} lose ${n2(r.med[2])}`)
}
console.log('  ◆ = a lead by the declared bar (same side in both periods, 0.03+ off 0.5)')

console.log('\n── SIZE OR DIRECTION: each group\'s share of winners and of losers, by volatility fifth at the start')
const vols = rows.map(r => r.f.volatility).filter(Number.isFinite).sort((a, b) => a - b), vc = [1, 2, 3, 4].map(q => vols[Math.floor(q * vols.length / 5)])
for (let b = 0; b < 5; b++) {
    const ts = rows.filter(r => Number.isFinite(r.f.volatility) && vc.filter(c => r.f.volatility >= c).length === b)
    console.log(`  volatility Q${b + 1} (${(b ? vc[b - 1] : vols[0]).toFixed(1)}…) ${String(ts.length).padStart(5)} · winners ${share(ts, r => r.group === 'win')} · losers ${share(ts, r => r.group === 'lose')} · mean net ${f2(mean(ts.map(r => r.net)))}`)
}

console.log('\n── SECTOR: winners and losers per period')
for (const sec of [...new Set(rows.map(r => r.sector))].sort()) {
    const out = Object.values(P).map(ts => { const x = ts.filter(r => r.sector === sec); return `${String(x.length).padStart(4)} win ${share(x, r => r.group === 'win')} lose ${share(x, r => r.group === 'lose')}` })
    console.log(`  ${sec.padEnd(24)} ${out.join('  →  ')}`)
}

console.log('\n── INSIDE THE QUARTER (hindsight): the report in it')
for (const g of ['win', 'mid', 'lose']) {
    const ts = G(rows, g), r = ts.filter(t => t.inside)
    console.log(`  ${g.padEnd(4)} ${String(ts.length).padStart(5)} · had a report ${share(ts, t => t.inside)} · EPS surprise median ${f2(median(r.map(t => t.inside.eps)))} · beat EPS ${share(r.filter(t => t.inside.eps != null), t => t.inside.eps > 0)} · revenue beat ${share(r.filter(t => t.inside.rev != null), t => t.inside.rev > 0)} · revenue 10%+ ${share(r.filter(t => t.inside.rev != null), t => t.inside.rev >= 10)}`)
    console.log(`       day-one reaction vs SPY: median ${f2(median(r.map(t => t.inside.reaction)))} · up ${share(r.filter(t => t.inside.reaction != null), t => t.inside.reaction > 0)} · the quarter net WITHOUT the report's two days ${f2(median(r.map(t => t.inside.reaction == null ? null : t.net - t.inside.reaction)))} (median)`)
    const gd = ['raise', 'maintain', 'cut', 'mixed', 'numbers', 'none'].map(k => `${k} ${share(r.filter(t => !['not fetched', 'missing'].includes(t.inside.guidance)), t => t.inside.guidance === k).trim()}`)
    console.log(`       guidance (of ${r.filter(t => !['not fetched', 'missing'].includes(t.inside.guidance)).length} read): ${gd.join(' · ')}`)
}
console.log('  per period: winners against losers')
for (const [p, ts] of Object.entries(P)) {
    const w = G(ts, 'win').filter(t => t.inside), l = G(ts, 'lose').filter(t => t.inside)
    const line = (x) => `revenue beat ${share(x.filter(t => t.inside.rev != null), t => t.inside.rev > 0)} · 10%+ ${share(x.filter(t => t.inside.rev != null), t => t.inside.rev >= 10)} · EPS beat ${share(x.filter(t => t.inside.eps != null), t => t.inside.eps > 0)} · reaction up ${share(x.filter(t => t.inside.reaction != null), t => t.inside.reaction > 0)}`
    console.log(`  ${p.padEnd(10)} win  ${line(w)}`)
    console.log(`  ${''.padEnd(10)} lose ${line(l)}`)
}

console.log('\n── DOES A WINNING QUARTER REPEAT? (the same name, the next quarter)')
const byKey = new Map(rows.map(r => [`${r.symbol} ${r.q}`, r]))
const nextQ = new Map(Q.slice(0, -1).map((x, n) => [x.q, Q[n + 1].q]))
for (const [p, ts] of Object.entries(P)) {
    const pairs = ts.map(r => [r, byKey.get(`${r.symbol} ${nextQ.get(r.q)}`)]).filter(([, b]) => b)
    const after = (g) => pairs.filter(([a]) => a.group === g).map(([, b]) => b)
    const line = (g) => { const b = after(g); return `${g} → next: ${String(b.length).padStart(5)} · wins again ${share(b, r => r.group === 'win')} · loses ${share(b, r => r.group === 'lose')} · mean net ${f2(mean(b.map(r => r.net)))}` }
    console.log(`  ${p}: ${line('win')}`)
    console.log(`  ${''.padEnd(p.length)}  ${line('mid')}`)
    console.log(`  ${''.padEnd(p.length)}  ${line('lose')}`)
}
process.exit(0)
