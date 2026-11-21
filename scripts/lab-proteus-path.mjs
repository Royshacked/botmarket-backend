#!/usr/bin/env node
// THE PATH INTO "THE BEST NOW" (Roy, 2026-11-21: "did you see a signal getting better in the back period, even if not
// reaching the level of now?"). §10.15's rows: for each name's top 3 signals by the last 3 months' edge, the average edge
// month by month — B1 (6–3 months before the window), B2 (3–0 months before), the window's M1 / M2 / M3 (high BY THE
// PICK — they cannot show a ramp), and NEXT — against every other signal. The ramp that counts is B1 → B2: the pick never
// saw those months. Per half, real and shuffled.
//
//   node --max-old-space-size=6000 scripts/lab-proteus-path.mjs [N=100]   → data/lab/proteus-path.out.txt

import fs from 'fs'
import { E, seedOf } from './lab-proteus.shared.mjs'
import { rowsOf, namesOf, SUFFIX, HALF_LABEL } from './lab-proteus-bestnow.mjs'

const N = Number(process.argv[2] ?? 100), TOP = 3

const stat = (xs) => {
    const v = xs.filter(Number.isFinite), n = v.length
    if (n < 2) return { n, m: null, se: null }
    const m = v.reduce((s, x) => s + x, 0) / n
    return { n, m, se: Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) / n) }
}

const lines = []
const say = (l = '') => { console.log(l); lines.push(l) }
const pt = (x) => (x == null ? '   —' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`.padStart(6))
say(`# The path into "the best now" (${new Date().toISOString().slice(0, 10)}) — the first ${N} names; edges in points over each month's drift`)

const sides = { real: [], shuf: [] }
let k = 0
for await (const [sym, bars] of namesOf()) {
    if (k++ >= N) break
    for (const r of rowsOf(bars)) sides.real.push({ ...r, name: sym })
    for (const r of rowsOf(E.shuffledBars(bars, E.seededRandom(seedOf(sym))))) sides.shuf.push({ ...r, name: sym })
    if (k % 10 === 0) console.log(`  ${k}`)
}

for (const side of ['real', 'shuf']) for (const half of ['older', 'recent']) {
    const hr = sides[side].filter(r => r.half === half)
    const groups = new Map()
    for (const r of hr) { const key = `${r.name}|${r.e}`; (groups.get(key) ?? groups.set(key, []).get(key)).push(r) }
    const best = new Set()
    for (const list of groups.values()) list.filter(r => r.nNow >= 3 && r.now != null).sort((a, b) => b.now - a.now).slice(0, TOP).forEach(r => best.add(r))
    const path = (rows) => ['b1', 'b2', 'm1', 'm2', 'm3', 'next'].map(p => stat(rows.filter(r => r[`${p === 'next' ? 'nNext' : `${p}n`}`] >= 1).map(r => r[p])))
    const B = path(hr.filter(r => best.has(r))), O = path(hr.filter(r => !best.has(r)))
    // The ramp the pick never saw: B2 − B1, on rows with events in both, best vs others.
    const ramp = (rows) => stat(rows.filter(r => r.b1n >= 1 && r.b2n >= 1 && r.b1 != null && r.b2 != null).map(r => r.b2 - r.b1))
    const rb = ramp(hr.filter(r => best.has(r))), ro = ramp(hr.filter(r => !best.has(r)))
    const d = rb.m - ro.m, se = Math.sqrt(rb.se ** 2 + ro.se ** 2)
    say(`\n## ${side === 'real' ? 'Real' : 'Shuffled'} — ${half === 'older' ? `older half (to ${HALF_LABEL})` : `recent half (from ${HALF_LABEL})`}`)
    say('              B1 (6–3m)  B2 (3–0m)  │  M1      M2      M3   (picked)  │  NEXT')
    say(`  best now    ${B.map((s, i) => `${pt(s.m)}${i === 1 ? '     │' : i === 4 ? '             │' : '  '}`).join('')}`)
    say(`  others      ${O.map((s, i) => `${pt(s.m)}${i === 1 ? '     │' : i === 4 ? '             │' : '  '}`).join('')}`)
    say(`  the ramp B1 → B2: best ${pt(rb.m)} (n ${rb.n}) vs others ${pt(ro.m)} (n ${ro.n}) → difference ${pt(d)} [${pt(d - 1.96 * se)} … ${pt(d + 1.96 * se)}]`)
}
fs.writeFileSync(`data/lab/proteus-path${SUFFIX}.out.txt`, lines.join('\n') + '\n')
console.log(`→ data/lab/proteus-path${SUFFIX}.out.txt`)
process.exit(0)
