// LAB (2026-11-21, Roy: "fit the period to the horizon" — "run the check").
// Is a normal pullback a CONSTANT × the stock's σ over the horizon H, on every name — at H = 5 (short term swing),
// 21 (swing) and 63 (long term) sessions? And does a constant stop hold up out of sample as well as the name's own?
// Daily bars of lab-proteus-fit.mjs (data/tmp/lab-fit-bars.json, 102 names, 10 years). Long side.
//   node scripts/lab-proteus-horizon.mjs
import fs from 'fs'
const { sigmaSeries, swingLegs, counterLegs, pairRecord } = await import('../services/stockProfile.engine.js')

const cache = JSON.parse(fs.readFileSync('data/tmp/lab-fit-bars.json', 'utf8'))
const HS = [
    { name: 'short term swing', H: 5, rev: 1 },
    { name: 'swing', H: 21, rev: 1 },
    { name: 'long term', H: 63, rev: 0.5 },
]
const MIN = 8
const q = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null }
const corr = (x, y) => { const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n; let nu = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { nu += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2 } return vx && vy ? nu / Math.sqrt(vx * vy) : NaN }
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—')
const pc = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '—')

for (const { name, H, rev } of HS) {
    const cfg = { unit: H, look: 60, cap: 3 * H, session: false }
    const per = []
    for (const [sym, bars] of Object.entries(cache)) {
        if (bars.length < 1500) continue
        const h = Math.floor(bars.length / 2)
        const sig = sigmaSeries(bars, cfg, null)
        const legs1 = swingLegs(bars.slice(0, h), sig.slice(0, h), 0, rev)
        const legs2 = swingLegs(bars, sig, h, rev)
        const n1 = counterLegs(legs1).map(l => l.size / l.sig), n2 = counterLegs(legs2).map(l => l.size / l.sig)
        const r1 = legs1.filter(l => l.up).map(l => l.size / l.sig)
        if (n1.length < MIN || n2.length < MIN || r1.length < MIN) { per.push({ sym, few: true, n1: n1.length }); continue }
        per.push({ sym, bars, sig, h, k1: q(n1, 0.75), k2: q(n2, 0.75), t1: q(r1, 0.3), n2, legs: n1.length + n2.length })
    }
    const ok = per.filter(p => !p.few)
    const K = q(ok.map(p => p.k1), 0.5), T = q(ok.map(p => p.t1), 0.5)
    console.log(`\n══ ${name.toUpperCase()} — H = ${H} sessions (σ over ${H}, turns at ${rev}σ, trades capped at ${3 * H}) ══`)
    console.log(`  names with ${MIN}+ pullbacks in both halves: ${ok.length}/${per.length} (median pullbacks a name: ${q(ok.map(p => p.legs), 0.5)})`)
    if (ok.length < 10) continue
    // 1. the constant: the stop (75th pct pullback) in σ — across names, first half → second half
    const a = ok.map(p => p.k1), b = ok.map(p => p.k2)
    console.log(`  1. stop in σ: median ${f2(q(a, 0.5))}σ → ${f2(q(b, 0.5))}σ; middle half of names ${f2(q(a, 0.25))}–${f2(q(a, 0.75))}σ; a name's own difference carries: corr ${f2(corr(a, b))}`)
    // 2. out of sample: the share of second-half pullbacks deeper than the stop (by design 25%) — own vs constant
    const deep = (p, k) => p.n2.filter(x => x > k).length / p.n2.length
    const own = ok.map(p => deep(p, p.k1)), con = ok.map(p => deep(p, K))
    const miss = (xs) => q(xs.map(x => Math.abs(x - 0.25)), 0.5)
    console.log(`  2. second half, pullbacks deeper than the stop (aim 25%): own stop median ${pc(q(own, 0.5))}, off by ${pc(miss(own))} a name · constant ${f2(K)}σ median ${pc(q(con, 0.5))}, off by ${pc(miss(con))} a name`)
    // 3. the record at the constant levels, second half, capped at 3H: target first / stop first / never resolved
    const recs = ok.map(p => pairRecord(p.bars, p.sig, cfg, null, K, T, { from: p.h })).filter(r => r.enough)
    const st = (k) => q(recs.map(r => (k === 'stop' ? 1 - r.win - r.never : r[k])), 0.5)
    console.log(`  3. levels stop ${f2(K)}σ / target ${f2(T)}σ (${f2(T / K)}:1), entries in the second half held ≤ ${3 * H} sessions: target first ${pc(st('win'))}, stop first ${pc(st('stop'))}, never ${pc(st('never'))} (median bars ${q(recs.map(r => r.median_bars), 0.5)})`)
    // 4. in % on today's σ: what the constant means
    const pcts = ok.map(p => K * p.sig.at(-1)).sort((x, y) => x - y)
    console.log(`  4. the constant stop in % today across names: median ${pc(q(pcts, 0.5))}, middle half ${pc(q(pcts, 0.25))}–${pc(q(pcts, 0.75))}`)
    for (const s of ['NVDA', 'KO', 'TSLA']) { const p = ok.find(x => x.sym === s); if (p) console.log(`     ${s}: σ ${pc(p.sig.at(-1))} over ${H} → stop ~${pc(K * p.sig.at(-1))}`) }
}
process.exit(0)
