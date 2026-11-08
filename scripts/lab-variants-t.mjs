// DOES T'S PASS SURVIVE ITS NEIGHBOURS? — test X, the T grid (declared in screener-lab.md §47, before the run). Industry
// leaders by the checkpoint × how many of them × how big an industry counts, against the equal-weight market and SPY.
//
//   node --max-old-space-size=6000 scripts/lab-variants-t.mjs
//
// Offline: data/lab caches + sp500-industries.json. Both yardsticks in one process (LAB_BENCH is ignored).
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
delete process.env.LAB_BENCH
const { costFor, testable } = await import('../services/screenerLab.service.js')
const { loadLabData, equalWeightBars } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3'
const CHECKS = [25, 30, 35, 40, 45], SHARES = [['tenth', 0.1], ['fifth', 0.2], ['third', 1 / 3]], MINS = [3, 4, 6]
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const industry = JSON.parse(fs.readFileSync('data/lab/sp500-industries.json', 'utf8'))
let data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member, bench: 'spy' })
await closeDb()
const EW = equalWeightBars(data.names, data.spyDays, data.spyRealByDay, member)

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
const B = { spy: data.spyByDay, ew: EW }

// Every member at every checkpoint: its quarter so far (raw — the ranking is within a quarter, so the yardstick cancels),
// and the rest of the quarter from the next open against each yardstick, after the cost.
const obs = []
// Each name's date index once (not once a quarter): the loop below is 27 quarters × ~670 names.
const atOf = new Map([...data.names].map(([sym, s]) => [sym, new Map(s.ind.date.map((d, n) => [d, n]))]))
for (const x of Q) {
    for (const [symbol, s] of data.names) {
        if (!member(symbol, x.first) || !industry[symbol]) continue
        const at = atOf.get(symbol)
        const j = at.get(x.base), e = at.get(x.last)
        if (j == null || e == null || j < 60) continue
        for (const c of CHECKS) {
            const dc = x.days[c - 1], dn = x.days[c]
            if (!dc || !dn) continue
            const kc = at.get(dc), kn = at.get(dn)
            if (kc == null || kn == null || kc - j !== c || !(s.rows[kn].open > 0) || !testable(s.rows, kn, s.ind)) continue
            const ret = pct(s.rows[e].close, s.rows[kn].open), cost = costFor(s.ind.adv20[kc] ?? 0), own = pct(s.rows[kc].close, s.rows[j].close)
            const rest = Object.fromEntries(Object.entries(B).map(([k, b]) => [k, ret - pct(b.get(x.last)?.close, b.get(dn)?.open) - cost]))
            if (Number.isFinite(own) && Number.isFinite(rest.spy) && Number.isFinite(rest.ew)) obs.push({ q: x.q, day: x.first, c, symbol, industry: industry[symbol], own, rest })
        }
    }
}
// The bars are done with: let the ~1.1 GB go before the 90 cells (2026-11-08: the first run was stopped for memory).
atOf.clear()
data = null
const byQC = new Map()
for (const o of obs) { const k = `${o.q} ${o.c}`; if (!byQC.has(k)) byQC.set(k, []); byQC.get(k).push(o) }

/** One cell: per quarter, the members of the industries (minMembers+, the name left out) in the top `share` by their
 * median quarter so far → the mean rest; against every member. */
function cell(c, share, minMembers, bench) {
    const perQ = []
    for (const x of Q) {
        const os = byQC.get(`${x.q} ${c}`) ?? []
        if (os.length < 50) continue
        const g = new Map()
        for (const o of os) { if (!g.has(o.industry)) g.set(o.industry, []); g.get(o.industry).push(o) }
        const ranked = []
        for (const list of g.values()) {
            if (list.length < minMembers) continue
            for (const o of list) ranked.push({ o, v: median(list.filter(z => z !== o).map(z => z.own)) })
        }
        ranked.sort((a, b) => b.v - a.v)
        const top = ranked.slice(0, Math.floor(ranked.length * share)).map(z => z.o)
        if (!top.length) continue
        perQ.push({ day: x.first, top: mean(top.map(o => o.rest[bench])), all: mean(os.map(o => o.rest[bench])) })
    }
    const per = (p) => mean(perQ.filter(p).map(z => z.top))
    return { b: per(z => z.day < SPLIT), a: per(z => z.day >= SPLIT), ab: mean(perQ.filter(z => z.day < SPLIT).map(z => z.all)), aa: mean(perQ.filter(z => z.day >= SPLIT).map(z => z.all)),
        whole: mean(perQ.map(z => z.top)), t: tOf(perQ.map(z => z.top - z.all)), n: perQ.length }
}
const f2 = (x, w = 6) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`.padStart(w))
const both = (r) => r.b > 0 && r.a > 0

const grid = {}
for (const bench of ['ew', 'spy']) {
    grid[bench] = {}
    console.log(`\n── AGAINST ${bench === 'ew' ? 'THE EQUAL-WEIGHT MARKET' : 'SPY'}: rest of the quarter, % per quarter (t of top − every member) · before / after · ◆ = positive in both`)
    for (const m of MINS) {
        console.log(`  industries of ${m}+ members`)
        console.log(`    ${''.padEnd(7)}${CHECKS.map(c => `session ${c}`.padStart(25)).join('')}`)
        for (const [label, sh] of SHARES) {
            const cells = CHECKS.map(c => { const r = cell(c, sh, m, bench); grid[bench][`${c} ${label} ${m}`] = r; return r })
            console.log(`    ${label.padEnd(7)}${cells.map(r => `${both(r) ? '◆' : ' '}${f2(r.whole)} (${r.t?.toFixed(1) ?? '—'}) ${f2(r.b, 5)}/${f2(r.a, 5)}`.padStart(25)).join('')}`)
        }
    }
}

// THE DECLARED VERDICT (against the equal-weight market). The declared cell: session 35, the top fifth, 4+ members.
const cells = Object.values(grid.ew), ts = cells.map(r => r.t).filter(Number.isFinite).sort((a, b) => a - b)
const shareBoth = cells.filter(both).length / cells.length, medT = ts[Math.floor(ts.length / 2)]
const nbKeys = ['30 fifth 4', '40 fifth 4', '35 tenth 4', '35 third 4', '35 fifth 3', '35 fifth 6']
const nbOk = nbKeys.every(k => both(grid.ew[k]))
console.log(`\nDECLARED VERDICT (T grid, equal-weight): cells positive in both periods ${(shareBoth * 100).toFixed(0)}% (need ≥ 67%) · median t ${medT?.toFixed(2)} (need ≥ 1.5) · the declared cell's neighbours (${nbKeys.join(', ')}) all positive in both ${nbOk} → ${shareBoth >= 2 / 3 && medT >= 1.5 && nbOk ? 'ROBUST' : 'NOT ROBUST'}`)
process.exit(0)
