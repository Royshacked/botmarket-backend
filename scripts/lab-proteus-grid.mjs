#!/usr/bin/env node
// EVERY BRACKET AT EVERY HORIZON — THE FULL GRID (Roy, 2026-11-21: "why not check all brackets at all horizons, properly?")
// — declared in docs/design/proteus.md §10.17 before the run. 31 signals × 19 brackets (2/1 … 20/10) × 4 horizons (10, 21,
// 42, 63 sessions), §10.16b's baseline (the 126 sessions before each window), real minus shuffled, the grid-neighbour rule,
// and a SECOND shuffle as the count of passes chance makes. Aggregated name by name (rows not kept).
//
//   node --max-old-space-size=8000 scripts/lab-proteus-grid.mjs [N=100]   → data/lab/proteus-grid2.out.txt (10.18: 53 signals)

import fs from 'fs'
import { E, seedOf, dailyNames10y } from './lab-proteus.shared.mjs'
import { eventsOf, SIGNALS as BASE_SIGNALS } from './lab-proteus-xsection.mjs'
import { extraEvents, EXTRA, EXTRA_SHORT } from './lab-proteus-signals2.mjs'
import { bracketPct } from './lab-proteus-brackets.mjs'

const N = Number(process.argv[2] ?? 100)
const HALF = Date.parse('2021-10-26T00:00:00Z') / 1000
// 10.18: every pattern — §10.17's 31 and the 22 of lab-proteus-signals2 (53).
const SIGNALS = [...BASE_SIGNALS, ...EXTRA]
const SHORT = new Set(['R3', 'R4', 'M4', 'M5', 'M6', ...EXTRA_SHORT])
/** Events one per 10 bars, in order (eventsOf's spacing, for the extra patterns too). */
const spaced = (idx) => { const out = []; let last = -Infinity; for (const i of [...idx].sort((a, b) => a - b)) if (i - last >= 10) { out.push(i); last = i } return out }
// Reward : risk — 2 (§10.17/18) or LAB_RR (10.18c: 1.5, with the targets from 1.5%).
const RR = Number(process.env.LAB_RR ?? 2)
const BRACKETS = [...(RR === 2 ? [] : [1.5]), ...Array.from({ length: 19 }, (_, k) => k + 2)]
const SFX = RR === 2 ? '' : `-rr${RR}`
const BE = Math.round(100 / (1 + RR))
const br = (p) => `${p}/${+(p / RR).toFixed(2)}`
const HORIZONS = [{ cap: 10, back: 63, fwd: 7 }, { cap: 21, back: 63, fwd: 21 }, { cap: 42, back: 126, fwd: 42 }, { cap: 63, back: 252, fwd: 84 }]
const BASE_BACK = 126, BASE_EVERY = 2, TOP = 3

// Running sums: key → [n, sum, sumsq] (and win counts for the real side).
const acc = new Map()
const add = (key, x) => { const a = acc.get(key) ?? acc.set(key, [0, 0, 0]).get(key); a[0]++; a[1] += x; a[2] += x * x }
const wins = new Map()
const addWin = (key, w) => { const a = wins.get(key) ?? wins.set(key, [0, 0]).get(key); a[0]++; a[1] += w }

function runName(bars, side) {
    const n = bars.length
    const { ev } = eventsOf(bars)
    for (const [k, idx] of Object.entries(extraEvents(bars))) ev[k] = spaced(idx)
    const memo = new Map()
    const out = (i, p, cap, short) => {
        const k = (i * 64 + Math.round(p * 2)) * 128 + cap * 2 + (short ? 1 : 0)
        let o = memo.get(k)
        if (o === undefined) { o = bracketPct(bars, i, p, cap, short, RR); memo.set(k, o) }
        return o
    }
    const rate = (idx, p, cap, short) => { let n0 = 0, w = 0; for (const i of idx) { const o = out(i, p, cap, short); if (o) { n0++; if (o === 'win') w++ } } return n0 ? { n: n0, r: w / n0 } : { n: 0, r: null } }
    const baseIdx = (from, to) => { const idx = []; for (let i = Math.max(260, from); i < to; i += BASE_EVERY) idx.push(i); return idx }
    for (const h of HORIZONS) {
        for (let e = 260 + h.back + BASE_BACK; e + h.fwd + h.cap < n; e += h.fwd) {
            const half = bars[e].timestamp < HALF ? 'older' : 'recent'
            const bBack = baseIdx(e - h.back - BASE_BACK, e - h.back - h.cap + 1), bFwd = baseIdx(e - BASE_BACK, e - h.cap + 1)
            const pairs = []   // for question 2: { eb, ef }
            for (const sig of SIGNALS) {
                const short = SHORT.has(sig.key), idx = ev[sig.key] ?? []
                const back = idx.filter(i => i > e - h.back && i + h.cap <= e), fwd = idx.filter(i => i > e && i <= e + h.fwd)
                if (!back.length && !fwd.length) continue
                for (const p of BRACKETS) {
                    const rf = fwd.length ? rate(fwd, p, h.cap, short) : { n: 0, r: null }
                    let ef = null
                    if (rf.n) {
                        const df = rate(bFwd, p, h.cap, short)
                        if (df.r != null) { ef = rf.r - df.r; add(`${side}|${h.cap}|${p}|${sig.key}|${half}`, ef); if (side === 'real') addWin(`${h.cap}|${p}|${sig.key}`, rf.r) }
                    }
                    if (back.length >= 3 && ef != null) {
                        const rb = rate(back, p, h.cap, short), db = rate(bBack, p, h.cap, short)
                        if (rb.r != null && db.r != null) pairs.push({ eb: rb.r - db.r, ef })
                    }
                }
            }
            if (pairs.length > TOP) {
                pairs.sort((a, b) => b.eb - a.eb)
                pairs.forEach((x, k) => add(`${side}|q2|${h.cap}|${half}|${k < TOP ? 'best' : 'other'}`, x.ef))
            }
        }
    }
}

const stat = (key) => { const a = acc.get(key); if (!a || a[0] < 2) return { n: a?.[0] ?? 0, m: null, se: null }; const m = a[1] / a[0]; return { n: a[0], m, se: Math.sqrt(Math.max(0, a[2] / a[0] - m * m) / (a[0] - 1)) } }
const minus = (a, b) => (a.m == null || b.m == null ? { m: null, lo: null } : { m: a.m - b.m, lo: a.m - b.m - 1.96 * Math.sqrt(a.se ** 2 + b.se ** 2) })

const lines = []
const say = (l = '') => { console.log(l); lines.push(l) }
const pt = (x) => (x == null ? '  —' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`)
say(`# Every bracket at every horizon (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.17, the first ${N} names; ${SIGNALS.length} signals × ${BRACKETS.length} brackets × 4 horizons, reward : risk ${RR}`)

let k = 0
for await (const [sym, bars] of dailyNames10y()) {
    if (k++ >= N) break
    runName(bars, 'real')
    runName(E.shuffledBars(bars, E.seededRandom(seedOf(sym))), 'shuf')
    runName(E.shuffledBars(bars, E.seededRandom(seedOf(sym) ^ 0x5bd1e995)), 'shuf2')
    if (k % 10 === 0) console.log(`  ${k}`)
}

// Question 1: per cell, (A − B) per half; a pass = ≥ +5 with lo > 0 both halves + half its neighbours ≥ +3 both halves.
function passes(A, B) {
    const d = new Map()
    for (const sig of SIGNALS) for (const h of HORIZONS) for (const p of BRACKETS) {
        const o = minus(stat(`${A}|${h.cap}|${p}|${sig.key}|older`), stat(`${B}|${h.cap}|${p}|${sig.key}|older`))
        const r = minus(stat(`${A}|${h.cap}|${p}|${sig.key}|recent`), stat(`${B}|${h.cap}|${p}|${sig.key}|recent`))
        d.set(`${sig.key}|${h.cap}|${p}`, { o, r })
    }
    const out = []
    for (const sig of SIGNALS) HORIZONS.forEach((h, hi) => BRACKETS.forEach((p, pi) => {
        const c = d.get(`${sig.key}|${h.cap}|${p}`)
        if (!(c.o.m >= 0.05 && c.o.lo > 0 && c.r.m >= 0.05 && c.r.lo > 0)) return
        const nb = []
        for (const [dh, dp] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
            const hh = HORIZONS[hi + dh], pp = BRACKETS[pi + dp]
            if (hh && pp) nb.push(d.get(`${sig.key}|${hh.cap}|${pp}`))
        }
        const good = nb.filter(x => x.o.m >= 0.03 && x.r.m >= 0.03).length
        if (good * 2 >= nb.length) out.push({ sig: sig.key, cap: h.cap, p, o: c.o.m, r: c.r.m })
    }))
    return { out, d }
}
const real = passes('real', 'shuf'), chance = passes('shuf2', 'shuf')

// NEARLY PASSED (Roy, 2026-11-21: "which nearly passed?") — reported, not judged: real minus shuffled ≥ +3 points with the
// interval above 0 in BOTH halves (the PASS is +5 and the neighbours), the same count on chance beside it. And every cell
// saved, for any later question.
const near = (d) => [...d].filter(([, c]) => c.o.m >= 0.03 && c.o.lo > 0 && c.r.m >= 0.03 && c.r.lo > 0).map(([k, c]) => ({ k, o: c.o.m, r: c.r.m }))
const nearReal = near(real.d), nearChance = near(chance.d)
fs.writeFileSync(`data/lab/proteus-grid2${SFX}.cells.json`, JSON.stringify(Object.fromEntries([...real.d].map(([k, c]) => [k, { o: c.o.m, olo: c.o.lo, r: c.r.m, rlo: c.r.lo }]))))
say(`\n## Question 1 — passing cells: REAL ${real.out.length}  ·  chance (a second shuffle minus the first) ${chance.out.length}  (of ${SIGNALS.length * BRACKETS.length * HORIZONS.length})`)
const bySig = new Map()
for (const x of real.out) (bySig.get(x.sig) ?? bySig.set(x.sig, []).get(x.sig)).push(x)
for (const [sig, cells] of [...bySig].sort((a, b) => b[1].length - a[1].length)) {
    say(`\n${SIGNALS.find(s => s.key === sig).label} — ${cells.length} cells`)
    for (const c of cells) {
        const w = wins.get(`${c.cap}|${c.p}|${sig}`)
        say(`  ${br(c.p).padStart(9)} in ${c.cap} sessions: real minus shuffled older ${pt(c.o)}, recent ${pt(c.r)} · win ${w ? Math.round((w[1] / w[0]) * 100) : '—'}% (break-even ${BE}%)`)
    }
}
say(`\nChance's cells (the second shuffle): ${chance.out.map(c => `${c.sig} ${br(c.p)}@${c.cap}`).join(', ') || 'none'}`)

say(`\n## Nearly passed — real minus shuffled ≥ +3 with the interval above 0 in BOTH halves: REAL ${nearReal.length} cells  ·  chance ${nearChance.length}`)
const nearBy = new Map()
for (const x of nearReal) { const [sig, cap, p] = x.k.split('|'); (nearBy.get(sig) ?? nearBy.set(sig, []).get(sig)).push({ cap: +cap, p: +p, o: x.o, r: x.r }) }
for (const [sig, cells] of [...nearBy].sort((a, b) => b[1].length - a[1].length)) {
    cells.sort((a, b) => Math.min(b.o, b.r) - Math.min(a.o, a.r))
    const caps = [...new Set(cells.map(c => c.cap))].sort((a, b) => a - b).join('/')
    const best = cells[0]
    say(`  ${(SIGNALS.find(s => s.key === sig)?.label ?? sig).padEnd(70)} ${String(cells.length).padStart(3)} cells · horizons ${caps} · best ${br(best.p)} in ${best.cap}: ${pt(best.o)} / ${pt(best.r)}`)
}
say(`  chance's near cells by signal: ${[...nearChance.reduce((m, x) => m.set(x.k.split('|')[0], (m.get(x.k.split('|')[0]) ?? 0) + 1), new Map())].map(([s, c]) => `${s} ${c}`).join(', ') || 'none'}`)

// The map of one signal per horizon: real minus shuffled, older / recent, every bracket — for the signals with passes.
for (const sig of [...bySig.keys()]) {
    say(`\n### ${sig} — real minus shuffled, older / recent, by horizon (rows) and bracket (columns ${BRACKETS[0]} … 20)`)
    for (const h of HORIZONS) say(`  ${String(h.cap).padStart(2)}s  ${BRACKETS.map(p => { const c = real.d.get(`${sig}|${h.cap}|${p}`); return `${pt(c.o.m)}/${pt(c.r.m)}` }).join(' ')}`)
}

say('\n## Question 2 — the look-back\'s top 3 (signal, bracket) per horizon: forward edge best minus others, real minus shuffled')
for (const h of HORIZONS) {
    const cell = (side, half) => { const b = stat(`${side}|q2|${h.cap}|${half}|best`), o = stat(`${side}|q2|${h.cap}|${half}|other`); return b.m == null || o.m == null ? { m: null, se: null } : { m: b.m - o.m, se: Math.sqrt(b.se ** 2 + o.se ** 2) } }
    const parts = ['older', 'recent'].map(half => { const R = cell('real', half), S = cell('shuf', half), d = minus(R, S); return `${half}: real ${pt(R.m)} · shuffled ${pt(S.m)} · real minus shuffled ${pt(d.m)} [${pt(d.lo)} …]` })
    say(`  ${String(h.cap).padStart(2)} sessions  ${parts.join('  ·  ')}`)
}
fs.writeFileSync(`data/lab/proteus-grid2${SFX}.out.txt`, lines.join('\n') + '\n')
console.log(`→ data/lab/proteus-grid2${SFX}.out.txt`)
process.exit(0)
