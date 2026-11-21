// LAB (2026-11-21, Roy: "so maybe targets set in the wrong timeframe?").
// The stop is a constant × σ over the horizon (lab-proteus-horizon.mjs). The target is the 30th percentile of the RUNS
// between swing turns — runs that last ~2× the horizon. Three targets, picked on the first five years, checked on the last
// five, the stop the horizon's constant, trades capped at 3 × H, long side:
//   A  today's: runs on the horizon's own swings (turns at rev × σ over H)
//   B  one timeframe down: runs on the swings of σ over H/4 (turns at rev × that σ), in σ over H
//   C  from the entry: how far price went for you within 3 × H before the stop — the level 70% of entries reached
//   node scripts/lab-proteus-target.mjs         (data/tmp/lab-fit-bars.json, from lab-proteus-fit.mjs)
import fs from 'fs'
const { sigmaSeries, swingLegs, pairRecord } = await import('../services/stockProfile.engine.js')
const cache = JSON.parse(fs.readFileSync('data/tmp/lab-fit-bars.json', 'utf8'))

const HS = [
    { name: 'short term swing', H: 5, rev: 1, K: 2.08, low: 1 },
    { name: 'swing', H: 21, rev: 1, K: 1.73, low: 5 },
    { name: 'long term', H: 63, rev: 0.5, K: 0.94, low: 21 },
]
const q = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null }
const corr = (x, y) => { const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n; let nu = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { nu += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2 } return vx && vy ? nu / Math.sqrt(vx * vy) : NaN }
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—')
const pc = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '—')

/** C: from each entry, the best move for you (in σ) within `cap` bars, stopped out at K σ. */
function excursions(bars, sig, from, to, K, cap) {
    const out = []
    for (let i = from; i < to - cap; i++) {
        const s = sig[i]
        if (!(s > 0)) continue
        const c = bars[i].close, stop = c * (1 - K * s)
        let best = 0
        for (let j = i + 1; j <= i + cap; j++) {
            if (bars[j].low <= stop) break
            best = Math.max(best, bars[j].high / c - 1)
        }
        out.push(best / s)
    }
    return out
}

for (const { name, H, rev, K, low } of HS) {
    const cfg = { unit: H, look: 60, cap: 3 * H, session: false }
    const cfgLow = { unit: low, look: 60, session: false }
    const rows = []
    for (const [sym, bars] of Object.entries(cache)) {
        if (bars.length < 1500) continue
        const h = Math.floor(bars.length / 2)
        const sig = sigmaSeries(bars, cfg, null), sigL = sigmaSeries(bars, cfgLow, null)
        const runsA = swingLegs(bars.slice(0, h), sig.slice(0, h), 0, rev).filter(l => l.up)
        const legsB = swingLegs(bars.slice(0, h), sigL.slice(0, h), 0, rev).filter(l => l.up)
        // B's runs in σ over H — the σ over H at the run's top
        const runsB = legsB.map(l => { const k = bars.findIndex(b => b.close === l.end); return k >= 0 && sig[k] > 0 ? l.size / sig[k] : null }).filter(Number.isFinite)
        const mfe1 = excursions(bars, sig, 0, h, K, 3 * H), mfe2 = excursions(bars, sig, h, bars.length, K, 3 * H)
        rows.push({ sym, bars, sig, h, A: runsA.length >= 8 ? q(runsA.map(l => l.size / l.sig), 0.3) : null, B: runsB.length >= 8 ? q(runsB, 0.3) : null, C: q(mfe1, 0.3), C2: q(mfe2, 0.3), runsA: runsA.length })
    }
    console.log(`\n══ ${name.toUpperCase()} — H = ${H}, stop ${K}σ over H, trades capped at ${3 * H} sessions ══`)
    const cc = rows.filter(r => Number.isFinite(r.C) && Number.isFinite(r.C2))
    console.log(`  C's target, a name's own: first half → second, corr ${f2(corr(cc.map(r => r.C), cc.map(r => r.C2)))} (median ${f2(q(cc.map(r => r.C), 0.5))}σ → ${f2(q(cc.map(r => r.C2), 0.5))}σ)`)
    for (const key of ['A', 'B', 'C']) {
        const T = q(rows.map(r => r[key]), 0.5)
        if (!Number.isFinite(T)) { console.log(`  ${key}: too few runs`); continue }
        const recs = rows.map(r => pairRecord(r.bars, r.sig, cfg, null, K, T, { from: r.h })).filter(r => r.enough)
        const med = (f) => q(recs.map(f), 0.5)
        const win = med(r => r.win), stp = med(r => 1 - r.win - r.never), nev = med(r => r.never)
        const expR = q(recs.map(r => r.win * (T / K) - (1 - r.win - r.never)), 0.5)
        const pcts = rows.map(r => T * r.sig.at(-1))
        console.log(`  ${key}: target ${f2(T)}σ (${f2(T / K)}:1; today median ${pc(q(pcts, 0.5))}) → second half: target first ${pc(win)}, stop first ${pc(stp)}, not finished ${pc(nev)}, ~${med(r => r.median_bars)} sessions; ${f2(expR)}R a trade (finished ones)`)
    }
}
process.exit(0)
