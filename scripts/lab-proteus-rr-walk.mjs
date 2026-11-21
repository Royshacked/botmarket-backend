#!/usr/bin/env node
// THE BEST REWARD : RISK NOW — 3 YEARS BACK, THE LAST YEAR FORWARD (Roy, 2026-11-21) — declared in docs/design/proteus.md
// §10.20 before the run. Per name and horizon: A = its own best of 55 brackets + holding on the 3 years before the last
// year; B = the best of all names pooled on those 3 years; C = holding. Each traded on every entry of the last year.
// The first N names, daily; every series also shuffled (dates kept).
//
//   node --max-old-space-size=8000 scripts/lab-proteus-rr-walk.mjs [N=100]   → data/lab/proteus-rr-walk.out.txt

import fs from 'fs'
import { E, seedOf, dailyNames10y } from './lab-proteus.shared.mjs'

const N = Number(process.argv[2] ?? 100)
const TARGETS = [1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20], RATIOS = [1, 1.5, 2, 2.5, 3]
const HORIZONS = [10, 21, 42, 63], COST = 0.001, PICK = 756, TEST = 252
const CHOICES = [...TARGETS.flatMap(t => RATIOS.map(r => ({ t, r, stop: t / r }))), { hold: true }]
const label = (c) => (c.hold ? 'hold' : `${c.t}%/${+c.stop.toFixed(2)}% (1:${c.r})`)

/** One trade from bar i's close → [return, sessions held]; holding = the cap's close. */
function trade(bars, i, c, cap) {
    const p0 = bars[i].close
    if (!c.hold) {
        const up = p0 * (1 + c.t / 100), dn = p0 * (1 - c.stop / 100)
        for (let k = i + 1; k <= i + cap; k++) {
            if (bars[k].low <= dn) return [-c.stop / 100 - COST, k - i]
            if (bars[k].high >= up) return [c.t / 100 - COST, k - i]
        }
    }
    return [bars[i + cap].close / p0 - 1 - COST, cap]
}

/** Per horizon and choice: [sum return, sum held] on the PICK entries and on the TEST entries. */
// 10.20b: a calendar test year (LAB_TEST=2022) — the pick the 3 calendar years before it; default the last 252 / 756 sessions.
const TEST_YEAR = process.env.LAB_TEST ? Number(process.env.LAB_TEST) : null
const SFX = TEST_YEAR ? `-${TEST_YEAR}` : ''
const at = (bars, iso) => { const t = Date.parse(`${iso}T00:00:00Z`) / 1000; const i = bars.findIndex(b => b.timestamp >= t); return i < 0 ? bars.length : i }

function sums(bars) {
    const n = bars.length
    let testFrom = n - TEST, testEnd = n, pickFrom = testFrom - PICK
    if (TEST_YEAR) { testFrom = at(bars, `${TEST_YEAR}-01-01`); testEnd = at(bars, `${TEST_YEAR + 1}-01-01`); pickFrom = at(bars, `${TEST_YEAR - 3}-01-01`) }
    if (pickFrom < 1 || (TEST_YEAR && bars[pickFrom].timestamp > Date.parse(`${TEST_YEAR - 3}-01-31T00:00:00Z`) / 1000)) return null   // no full 3 years
    const out = {}
    for (const cap of HORIZONS) {
        out[cap] = CHOICES.map(c => {
            const pick = [0, 0], test = [0, 0]
            for (let i = pickFrom; i + cap < testFrom; i++) { const [r, h] = trade(bars, i, c, cap); pick[0] += r; pick[1] += h }
            for (let i = testFrom; i < testEnd && i + cap < n; i++) { const [r, h] = trade(bars, i, c, cap); test[0] += r; test[1] += h }
            return { pick, test }
        })
    }
    return out
}

const lines = []
const say = (l = '') => { console.log(l); lines.push(l) }
const pc = (x, d = 3) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
const names = { real: [], shuf: [] }
let k = 0
for await (const [sym, bars] of dailyNames10y()) {
    if (k++ >= N) break
    const a = sums(bars), b = sums(E.shuffledBars(bars, E.seededRandom(seedOf(sym))))
    if (a) names.real.push({ sym, s: a, from: TEST_YEAR ? Date.parse(`${TEST_YEAR}-01-01`) / 1000 : bars.at(-TEST).timestamp, to: TEST_YEAR ? Date.parse(`${TEST_YEAR}-12-31`) / 1000 : bars.at(-1).timestamp })
    if (b) names.shuf.push({ sym, s: b })
    if (k % 10 === 0) console.log(`  ${k}`)
}
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10)
const r0 = names.real[0]
say(`# The best reward : risk now — 3 years back, the test year forward (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.20`)
say(`${names.real.length} names. The pick: the 3 years before the test year; the test year (${day(r0.from)} → ${day(r0.to)}). Per session held; 0.1% cost.`)

const verdict = {}
for (const side of ['real', 'shuf']) {
    say(`\n## ${side === 'real' ? 'Real' : 'Shuffled (the control)'}`)
    for (const cap of HORIZONS) {
        // B: the pooled best on the pick.
        const pooled = CHOICES.map((_, j) => names[side].reduce((acc, x) => [acc[0] + x.s[cap][j].pick[0], acc[1] + x.s[cap][j].pick[1]], [0, 0]))
        const bIdx = pooled.reduce((best, p, j) => (p[0] / p[1] > pooled[best][0] / pooled[best][1] ? j : best), 0)
        const holdIdx = CHOICES.length - 1
        const rows = names[side].map(x => {
            const pd = (j, part) => x.s[cap][j][part][0] / x.s[cap][j][part][1]
            const aIdx = CHOICES.reduce((best, _, j) => (pd(j, 'pick') > pd(best, 'pick') ? j : best), 0)
            return { sym: x.sym, aIdx, A: pd(aIdx, 'test'), B: pd(bIdx, 'test'), C: pd(holdIdx, 'test') }
        })
        const ms = (xs) => { const m = xs.reduce((s, v) => s + v, 0) / xs.length; const se = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1) / xs.length); return { m, lo: m - 1.96 * se, hi: m + 1.96 * se } }
        const ab = ms(rows.map(r => r.A - r.B)), ac = ms(rows.map(r => r.A - r.C))
        const held = rows.filter(r => r.aIdx === holdIdx).length
        const pass = ab.m >= 0.0001 && ab.lo > 0 && ac.m >= 0.0001 && ac.lo > 0
        verdict[`${side}|${cap}`] = pass
        say(`\n### horizon ${cap} sessions — B (one for all) = ${label(CHOICES[bIdx])}; A picked holding for ${held} of ${rows.length} names`)
        say(`  test year, per session held — A ${pc(ms(rows.map(r => r.A)).m)} · B ${pc(ms(rows.map(r => r.B)).m)} · C (hold) ${pc(ms(rows.map(r => r.C)).m)}`)
        say(`  A − B ${pc(ab.m)} [${pc(ab.lo)} … ${pc(ab.hi)}] · A − C ${pc(ac.m)} [${pc(ac.lo)} … ${pc(ac.hi)}] · A beat B on ${rows.filter(r => r.A > r.B).length}, beat C on ${rows.filter(r => r.A > r.C).length} of ${rows.length} names → ${pass ? 'PASS' : 'no'}`)
        if (side === 'real' && cap === 21) {
            say('  per name (21 sessions): the pick · its last year · B · hold')
            for (const r of rows) say(`    ${r.sym.padEnd(6)} ${label(CHOICES[r.aIdx]).padEnd(22)} ${pc(r.A).padStart(8)} · ${pc(r.B).padStart(8)} · ${pc(r.C).padStart(8)}`)
        }
    }
}
say('\n## Verdict (A beats B and C by ≥ +0.01% a session, interval above 0; the shuffled control not passing)')
for (const cap of HORIZONS) say(`  ${String(cap).padStart(2)} sessions: real ${verdict[`real|${cap}`] ? 'PASS' : 'no'} · shuffled ${verdict[`shuf|${cap}`] ? 'PASS' : 'no'}`)
fs.writeFileSync(`data/lab/proteus-rr-walk${SFX}.out.txt`, lines.join('\n') + '\n')
console.log(`→ data/lab/proteus-rr-walk${SFX}.out.txt`)
process.exit(0)
