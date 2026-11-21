#!/usr/bin/env node
// REWARD / RISK IN PERCENT, 2/1 TO 20/10, EACH ON ITS HORIZON'S WINDOWS (Roy, 2026-11-21) — declared in
// docs/design/proteus.md §10.16 before the run. Per name, signal, bracket group: walk-forward windows sized to the group's
// horizon; 1. does the signal beat the same window's drift at the same bracket NOW (forward)? 2. do the best (signal,
// bracket) pairs of the look-back keep working forward? The 31 signals, daily, the first N names, every series shuffled.
//
//   node --max-old-space-size=8000 scripts/lab-proteus-brackets.mjs [N=100]   → data/lab/proteus-brackets.out.txt

import fs from 'fs'
import { E, seedOf, dailyNames10y } from './lab-proteus.shared.mjs'
import { eventsOf, SIGNALS } from './lab-proteus-xsection.mjs'

const N = Number(process.argv[2] ?? 100)
const HALF = Date.parse('2021-10-26T00:00:00Z') / 1000
const SHORT = new Set(['R3', 'R4', 'M4', 'M5', 'M6'])
export const GROUPS = [
    // 10.16b: the look-back 63 (21 left room for one event under a 10-session cap).
    { key: 'short swing', brackets: [2, 3, 4], cap: 10, back: 63, fwd: 7 },
    { key: 'swing', brackets: [5, 6, 8], cap: 21, back: 63, fwd: 21 },
    { key: 'long swing', brackets: [10, 12, 15], cap: 42, back: 126, fwd: 42 },
    { key: 'position', brackets: [20], cap: 63, back: 252, fwd: 84 },
]
// 10.16b: the baseline is the 126 sessions BEFORE a window (every 2nd bar, outcomes known by its start) — recent, and no
// baseline bar can hold the window's dip in its future (§10.16's window-local drift favoured every dip signal).
const BASE_BACK = 126, BASE_EVERY = 2, TOP = 3

/**
 * The bracket's outcome from bar i's close: 'win' (target first), 'loss' (stop first, or both in one bar), 'none' (neither
 * by the cap), null when the bars run out. Short = mirrored (target below, stop above). Pure.
 */
export function bracketPct(bars, i, p, cap, short = false, ratio = 2) {
    if (i + cap >= bars.length) return null
    // `ratio` = reward : risk (§10.16–10.18 2; 10.18c 1.5) — the stop is the target / ratio.
    const c = bars[i].close, up = p / 100, dn = p / (100 * ratio)
    for (let k = i + 1; k <= i + cap; k++) {
        const { high: h, low: l } = bars[k]
        const stop = short ? h >= c * (1 + dn) : l <= c * (1 - dn)
        const tgt = short ? l <= c * (1 - up) : h >= c * (1 + up)
        if (stop) return 'loss'
        if (tgt) return 'win'
    }
    return 'none'
}

/** One series → rows { group, e, half, key, p, nb, eb, nf, ef, rf } — the look-back and forward edges per window. Pure. */
export function rowsOf(bars) {
    const n = bars.length
    const { ev } = eventsOf(bars)
    const memo = new Map()
    const out = (i, p, cap, short) => {
        const k = `${i}|${p}|${short ? 1 : 0}`
        if (!memo.has(k)) memo.set(k, bracketPct(bars, i, p, cap, short))
        return memo.get(k)
    }
    const rate = (idx, p, cap, short) => { const o = idx.map(i => out(i, p, cap, short)).filter(Boolean); return o.length ? { n: o.length, r: o.filter(x => x === 'win').length / o.length } : { n: 0, r: null } }
    const base = (from, to, p, cap, short) => { const idx = []; for (let i = Math.max(260, from); i < to; i += BASE_EVERY) idx.push(i); return rate(idx, p, cap, short) }
    const rows = []
    for (const g of GROUPS) {
        for (let e = 260 + g.back + BASE_BACK; e + g.fwd + g.cap < n; e += g.fwd) {
            const half = bars[e].timestamp < HALF ? 'older' : 'recent'
            for (const sig of SIGNALS) {
                const short = SHORT.has(sig.key), idx = ev[sig.key] ?? []
                const back = idx.filter(i => i > e - g.back && i + g.cap <= e), fwd = idx.filter(i => i > e && i <= e + g.fwd)
                for (const p of g.brackets) {
                    const rb = rate(back, p, g.cap, short), rf = rate(fwd, p, g.cap, short)
                    // The baseline of a window = the bars of the 126 sessions before it, outcomes known by its start.
                    const db = rb.n ? base(e - g.back - BASE_BACK, e - g.back - g.cap + 1, p, g.cap, short) : { r: null }
                    const df = rf.n ? base(e - BASE_BACK, e - g.cap + 1, p, g.cap, short) : { r: null }
                    rows.push({
                        group: g.key, e, half, key: sig.key, p,
                        nb: rb.n, eb: rb.r != null && db.r != null ? rb.r - db.r : null,
                        nf: rf.n, ef: rf.r != null && df.r != null ? rf.r - df.r : null, rf: rf.r,
                    })
                }
            }
        }
    }
    return rows
}

const stat = (xs) => {
    const v = xs.filter(Number.isFinite), n = v.length
    if (n < 2) return { n, m: null, se: null }
    const m = v.reduce((s, x) => s + x, 0) / n
    return { n, m, se: Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) / n) }
}

if (process.argv[1]?.endsWith('lab-proteus-brackets.mjs')) {
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const pt = (x) => (x == null ? '   —' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`.padStart(6))
    say(`# Reward / risk in percent, each on its horizon's windows (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.16, the first ${N} names`)
    const sides = { real: [], shuf: [] }
    let k = 0
    for await (const [sym, bars] of dailyNames10y()) {
        if (k++ >= N) break
        for (const r of rowsOf(bars)) sides.real.push({ ...r, name: sym })
        for (const r of rowsOf(E.shuffledBars(bars, E.seededRandom(seedOf(sym))))) sides.shuf.push({ ...r, name: sym })
        if (k % 10 === 0) console.log(`  ${k}`)
    }

    // 1. Does it work NOW — per group, signal, bracket: the mean forward edge, per half and side.
    // Indexed once: side|group|half|signal|bracket → the forward edges and win rates (rows with ≥ 1 forward event).
    const index = new Map()
    for (const side of ['real', 'shuf']) for (const r of sides[side]) {
        if (r.nf < 1) continue
        for (const h of [r.half, 'all']) {
            const key = `${side}|${r.group}|${h}|${r.key}|${r.p}`
            const slot = index.get(key) ?? index.set(key, { ef: [], rf: [] }).get(key)
            slot.ef.push(r.ef); slot.rf.push(r.rf)
        }
    }
    const cell = (side, half, g, key, p) => stat(index.get(`${side}|${g}|${half}|${key}|${p}`)?.ef ?? [])
    // 10.16b: the verdict reads REAL MINUS SHUFFLED (the shuffled control as the subtraction, not a second bar to clear).
    const minus = (a, b) => (a.m == null || b.m == null ? { m: null, lo: null } : { m: a.m - b.m, lo: a.m - b.m - 1.96 * Math.sqrt(a.se ** 2 + b.se ** 2) })
    const pass1 = []
    for (const g of GROUPS) {
        say(`\n## 1. ${g.key} — brackets ${g.brackets.map(p => `${p}/${p / 2}`).join(', ')} %, cap ${g.cap} sessions, look back ${g.back} / forward ${g.fwd}`)
        say('per bracket: real older / recent  ·  REAL MINUS SHUFFLED older / recent  ·  win% (real, all)')
        for (const sig of SIGNALS) {
            const parts = [], d = {}
            for (const p of g.brackets) {
                const o = cell('real', 'older', g.key, sig.key, p), r = cell('real', 'recent', g.key, sig.key, p)
                const so = cell('shuf', 'older', g.key, sig.key, p), sr = cell('shuf', 'recent', g.key, sig.key, p)
                const win = stat(index.get(`real|${g.key}|all|${sig.key}|${p}`)?.rf ?? []).m
                d[p] = { o: minus(o, so), r: minus(r, sr) }
                parts.push(`${`${p}/${p / 2}`.padEnd(6)}${pt(o.m)} ${pt(r.m)} · ${pt(d[p].o.m)} ${pt(d[p].r.m)} · ${win == null ? ' —' : `${Math.round(win * 100)}%`.padStart(4)}`)
            }
            say(`${sig.key.padEnd(7)}${parts.join('  │ ')}`)
            g.brackets.forEach((p, j) => {
                const ok = (x) => x.m != null && x.m >= 0.05 && x.lo > 0
                const nb = [g.brackets[j - 1], g.brackets[j + 1]].filter(Boolean)
                const neighbour = nb.length === 0 || nb.some(q => d[q].o.m >= 0.03 && d[q].r.m >= 0.03)
                if (ok(d[p].o) && ok(d[p].r) && neighbour) pass1.push(`${sig.key} at ${p}/${p / 2} (${g.key}): real minus shuffled older ${pt(d[p].o.m)}, recent ${pt(d[p].r.m)}`)
            })
        }
    }

    // 2. The best (signal, bracket) of the look-back, forward: best-minus-others, real minus shuffled.
    say('\n## 2. The best (signal, bracket) pairs of the look-back — forward edge, best minus every other pair; then real minus shuffled')
    const pass2 = []
    for (const g of GROUPS) {
        const dd = {}
        for (const side of ['real', 'shuf']) for (const half of ['older', 'recent']) {
            const rows = sides[side].filter(r => r.group === g.key && r.half === half)
            const by = new Map()
            for (const r of rows) { const key = `${r.name}|${r.e}`; (by.get(key) ?? by.set(key, []).get(key)).push(r) }
            const best = new Set()
            for (const list of by.values()) list.filter(r => r.nb >= 3 && r.eb != null).sort((a, b) => b.eb - a.eb).slice(0, TOP).forEach(r => best.add(r))
            const a = stat(rows.filter(r => best.has(r) && r.nf >= 1).map(r => r.ef)), b = stat(rows.filter(r => !best.has(r) && r.nf >= 1).map(r => r.ef))
            dd[`${side}|${half}`] = a.m != null && b.m != null ? { m: a.m - b.m, se: Math.sqrt(a.se ** 2 + b.se ** 2), na: a.n } : { m: null, se: null, na: a.n }
        }
        const cells = ['older', 'recent'].map(h => {
            const R = dd[`real|${h}`], S = dd[`shuf|${h}`], m = minus(R, S)
            return `${h}: real ${pt(R.m)} (n ${R.na}) · shuffled ${pt(S.m)} · real minus shuffled ${pt(m.m)} [${pt(m.lo)} …]`
        })
        say(`  ${g.key.padEnd(11)} ${cells.join('  ·  ')}`)
        const ok = ['older', 'recent'].every(h => { const m = minus(dd[`real|${h}`], dd[`shuf|${h}`]); return m.m != null && m.m >= 0.05 && m.lo > 0 })
        if (ok) pass2.push(g.key)
    }

    say('\n## Verdict (10.16b: real minus shuffled ≥ +5 points, interval above 0, both halves; a neighbour ≥ +3)')
    say(`1. works now: ${pass1.length ? pass1.join('; ') : 'no signal at any bracket'}`)
    say(`2. the best keep working: ${pass2.length ? pass2.join('; ') : 'no group'}`)
    fs.writeFileSync('data/lab/proteus-brackets-b.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-brackets-b.out.txt')
    process.exit(0)
}
