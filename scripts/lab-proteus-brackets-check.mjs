#!/usr/bin/env node
// THE CHECK ON §10.16's PASSES (2026-11-21): three of the four carry a TREND condition (F1/F2 above the cloud, X1 over the
// 200 SMA) and were judged against EVERY bar's drift — in an uptrend a long bracket wins more by itself. Here each is
// judged against the drift of bars with the SAME condition (and M2, unconditioned, against both), real and shuffled,
// per half, at the brackets that passed. The windows are §10.16's.
//
//   node --max-old-space-size=8000 scripts/lab-proteus-brackets-check.mjs [N=100]

import { E, seedOf, dailyNames10y, calcSMASeries } from './lab-proteus.shared.mjs'
import { ichimoku } from './lab-proteus-signals.mjs'
import { eventsOf } from './lab-proteus-xsection.mjs'
import { bracketPct, GROUPS } from './lab-proteus-brackets.mjs'

const N = Number(process.argv[2] ?? 100)
const HALF = Date.parse('2021-10-26T00:00:00Z') / 1000
const CHECKS = [
    { key: 'F2', cond: 'cloud', brackets: [2, 3, 4] }, { key: 'F1', cond: 'cloud', brackets: [2, 3, 4] },
    { key: 'X1', cond: 'over200', brackets: [5, 6] }, { key: 'M2', cond: 'none', brackets: [2] },
]
const groupOf = (p) => GROUPS.find(g => g.brackets.includes(p))

function measure(bars) {
    const n = bars.length, closes = bars.map(b => b.close)
    const { ev } = eventsOf(bars)
    const top = ichimoku(bars).top, s200 = calcSMASeries(closes, 200)
    const cond = { cloud: (i) => top[i] != null && closes[i] > top[i], over200: (i) => Number.isFinite(s200[i]) && closes[i] > s200[i], none: () => true }
    const out = []
    for (const c of CHECKS) for (const p of c.brackets) {
        const g = groupOf(p)
        for (let e = 260 + g.back; e + g.fwd + g.cap < n; e += g.fwd) {
            const fwd = (ev[c.key] ?? []).filter(i => i > e && i <= e + g.fwd)
            if (!fwd.length) continue
            const rate = (idx) => { const o = idx.map(i => bracketPct(bars, i, p, g.cap)).filter(Boolean); return o.length ? o.filter(x => x === 'win').length / o.length : null }
            const all = [], matched = []
            for (let i = e + 1; i <= e + g.fwd; i += 1) { if ((i - e) % 5 === 1) all.push(i); if (cond[c.cond](i)) matched.push(i) }
            const rs = rate(fwd), ra = rate(all), rm = rate(matched.filter((_, k) => k % 3 === 0))
            out.push({ key: c.key, p, half: bars[e].timestamp < HALF ? 'older' : 'recent', vsAll: rs != null && ra != null ? rs - ra : null, vsMatched: rs != null && rm != null ? rs - rm : null })
        }
    }
    return out
}

const mean = (xs) => { const v = xs.filter(Number.isFinite); if (v.length < 2) return { m: null, se: null, n: v.length }; const m = v.reduce((s, x) => s + x, 0) / v.length; return { m, se: Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1) / v.length), n: v.length } }
const pt = (x) => (x == null ? '   —' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`.padStart(6))
const rows = { real: [], shuf: [] }
let k = 0
for await (const [sym, bars] of dailyNames10y()) {
    if (k++ >= N) break
    rows.real.push(...measure(bars))
    rows.shuf.push(...measure(E.shuffledBars(bars, E.seededRandom(seedOf(sym)))))
}
console.log(`# The check on §10.16's passes — ${N} names. Forward edge vs EVERY bar's drift (as §10.16) and vs the drift of bars with the SAME condition.`)
for (const c of CHECKS) for (const p of c.brackets) for (const side of ['real', 'shuf']) {
    const cells = ['older', 'recent'].map(h => {
        const r = rows[side].filter(x => x.key === c.key && x.p === p && x.half === h)
        const a = mean(r.map(x => x.vsAll)), m = mean(r.map(x => x.vsMatched))
        return `${h} vs all ${pt(a.m)} · vs same-condition ${pt(m.m)} [${pt(m.m == null ? null : m.m - 1.96 * m.se)} … ${pt(m.m == null ? null : m.m + 1.96 * m.se)}] (n ${m.n})`
    })
    console.log(`${c.key} ${String(p).padStart(2)}/${p / 2} (${c.cond.padEnd(7)}) ${side.padEnd(4)} ${cells.join('  ·  ')}`)
}
process.exit(0)
