#!/usr/bin/env node
// THE BEST NOW, CHECKED BACKWARDS — AND GETTING BETTER TOWARD NOW (Roy, 2026-11-21) — declared in docs/design/proteus.md
// §10.15 before the run. Per name and month-end: each signal's edge NOW (the last 3 months, and its three months M1..M3),
// BEFORE (the 6 months before) and NEXT (the month after). A: does "the best now AND OK before" do better next month than
// the rest? B: does a signal getting better from M1 to M3 do better next month than one getting worse?
//
//   node --max-old-space-size=6000 scripts/lab-proteus-bestnow.mjs [N=100]   → data/lab/proteus-bestnow[-hourly].out.txt  (LAB_SCALE=7 for hourly)

import fs from 'fs'
import readline from 'readline'
import { E, P, atrsOf, seedOf, dailyNames10y } from './lab-proteus.shared.mjs'
import { mirror } from './lab-proteus-signals.mjs'
import { eventsOf, SIGNALS } from './lab-proteus-xsection.mjs'

const N = Number(process.argv[2] ?? 100)
// Windows in SESSIONS × bars a session: daily 1 (§10.15), hourly 7 (§10.15c — LAB_SCALE=7 LAB_HALF=2024-05-01).
export const SCALE = Number(process.env.LAB_SCALE ?? 1)
const NOW = 63 * SCALE, MONTH = 21 * SCALE, BEFORE = 126 * SCALE, NEXT = 21 * SCALE, STEP = 21 * SCALE, TOP = 3, TREND = 0.25
const HALF = Date.parse(`${process.env.LAB_HALF ?? '2021-10-26'}T00:00:00Z`) / 1000
export const HALF_LABEL = (process.env.LAB_HALF ?? '2021-10-26').slice(0, 7)
export const SUFFIX = SCALE === 1 ? '' : '-hourly'

/** The hourly bars (lab-proteus-fetch-hourly.mjs), one name at a time (cleaned, ≥ 260). */
export async function* hourlyNames(file = 'data/lab/hourly-5y.jsonl') {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line) continue
        const { symbol, b } = JSON.parse(line)
        const bars = (b ?? []).map(([t, o, h, l, c, v]) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v }))
            .filter(x => x.close > 0 && x.open > 0 && x.high >= x.low).sort((x, y) => x.timestamp - y.timestamp)
        if (bars.length >= 260) yield [symbol, bars]
    }
}
/** The names, daily or hourly by SCALE. */
export const namesOf = () => (SCALE === 1 ? dailyNames10y() : hourlyNames())
const SHORT = new Set(['R3', 'R4', 'M4', 'M5', 'M6'])

/** One series → the rows { half, key, nNow, now, m1, m3, nBefore, before, nNext, next } at every month-end. Pure. */
export function rowsOf(bars, opts = P) {
    const n = bars.length, atrs = atrsOf(bars), mb = mirror(bars)
    const memo = { long: new Map(), short: new Map() }
    const outcome = (i, short) => {
        const m = short ? memo.short : memo.long
        if (m.has(i)) return m.get(i)
        const a = atrs[i], b = short ? mb : bars
        const o = a > 0 ? E.bracket(b, i, b[i].close + opts.up * a, b[i].close - opts.down * a, opts.horizon) : null
        m.set(i, o)
        return o
    }
    const rate = (idx, short) => { const o = idx.map(i => outcome(i, short)).filter(Boolean); return o.length ? { n: o.length, r: o.filter(x => x === 'win').length / o.length } : { n: 0, r: null } }
    const drift = (from, to, short) => { const idx = []; for (let i = Math.max(0, from); i < to; i += opts.horizon) idx.push(i); return rate(idx, short) }
    // A window (from, to]: its events whose outcome is known by `known`, their edge over the window's drift.
    const edge = (idx, from, to, short, known) => {
        const ev = idx.filter(i => i > from && i <= to && i + opts.horizon <= known)
        const r = rate(ev, short), d = drift(from + 1, Math.min(to, known - opts.horizon) + 1, short)
        return { n: r.n, e: r.r != null && d.r != null ? r.r - d.r : null }
    }
    const { ev } = eventsOf(bars, opts)
    const rows = []
    for (let e = 300 + BEFORE; e + NEXT < n; e += STEP) {
        const half = bars[e].timestamp < HALF ? 'older' : 'recent'
        for (const sig of SIGNALS) {
            const short = SHORT.has(sig.key), idx = ev[sig.key] ?? []
            const now = edge(idx, e - NOW, e, short, e)
            const m1 = edge(idx, e - NOW, e - NOW + MONTH, short, e), m3 = edge(idx, e - MONTH, e, short, e)
            const before = edge(idx, e - NOW - BEFORE, e - NOW, short, e)
            // The path (Roy, 2026-11-21: "did a signal get better in the back period, even if not to now's level?"):
            // BEFORE in two halves (B1 the older 3 months, B2 the 3 months just before NOW), and NOW's middle month.
            const b1 = edge(idx, e - NOW - BEFORE, e - NOW - BEFORE / 2, short, e), b2 = edge(idx, e - NOW - BEFORE / 2, e - NOW, short, e)
            const m2 = edge(idx, e - NOW + MONTH, e - MONTH, short, e)
            const next = edge(idx, e, e + NEXT, short, e + NEXT + opts.horizon)
            rows.push({ e, half, key: sig.key, nNow: now.n, now: now.e, m1n: m1.n, m1: m1.e, m3n: m3.n, m3: m3.e, nBefore: before.n, before: before.e, nNext: next.n, next: next.e,
                b1n: b1.n, b1: b1.e, b2n: b2.n, b2: b2.e, m2n: m2.n, m2: m2.e })
        }
    }
    return rows
}

/** Mean, its 95% interval, n. */
const stat = (xs) => {
    const v = xs.filter(Number.isFinite), n = v.length
    if (n < 2) return { n, m: null, lo: null, hi: null }
    const m = v.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))
    return { n, m, se: sd / Math.sqrt(n) }
}
const diff = (a, b) => {
    const A = stat(a), B = stat(b)
    if (A.m == null || B.m == null) return { d: null, lo: null, hi: null, na: A.n, nb: B.n }
    const d = A.m - B.m, se = Math.sqrt(A.se ** 2 + B.se ** 2)
    return { d, lo: d - 1.96 * se, hi: d + 1.96 * se, na: A.n, nb: B.n, a: A.m, b: B.m }
}

/** A side's rows → the A and B comparisons per half. */
function analyse(rows) {
    const out = {}
    for (const half of ['older', 'recent']) {
        const hr = rows.filter(r => r.half === half)
        // A: per (name, date), the top TOP signals by NOW edge (≥ 3 events now).
        const byKey = new Map()
        for (const r of hr) { const k = `${r.name}|${r.e}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push(r) }
        const best = new Set()
        for (const list of byKey.values()) {
            list.filter(r => r.nNow >= 3 && r.now != null).sort((a, b) => b.now - a.now).slice(0, TOP).forEach(r => best.add(r))
        }
        const withNext = (r) => r.nNext >= 1 && r.next != null
        const bestRows = hr.filter(r => best.has(r))
        const bestOk = bestRows.filter(r => r.nBefore >= 2 && r.before != null && r.before >= 0 && withNext(r))
        const bestNotOk = bestRows.filter(r => r.nBefore >= 2 && r.before != null && r.before < 0 && withNext(r))
        const others = hr.filter(r => !best.has(r) && withNext(r))
        const a1 = diff(bestRows.filter(r => r.nBefore >= 2 && r.before != null).map(r => r.before), hr.filter(r => !best.has(r) && r.nBefore >= 2 && r.before != null).map(r => r.before))
        const a2 = diff(bestOk.map(r => r.next), others.map(r => r.next))
        const aNot = diff(bestNotOk.map(r => r.next), others.map(r => r.next))
        const aAll = diff(bestRows.filter(withNext).map(r => r.next), others.map(r => r.next))
        // B: improving vs worsening from M1 to M3.
        const trended = hr.filter(r => r.m1n >= 1 && r.m3n >= 1 && r.m1 != null && r.m3 != null && withNext(r))
        const imp = trended.filter(r => r.m3 - r.m1 >= TREND), wor = trended.filter(r => r.m3 - r.m1 <= -TREND)
        const b = diff(imp.map(r => r.next), wor.map(r => r.next))
        out[half] = { a1, a2, aNot, aAll, b }
    }
    return out
}

if (process.argv[1]?.endsWith('lab-proteus-bestnow.mjs')) {
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const pt = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`)
    const line = (label, x) => `${label} ${pt(x.d)} pts [${pt(x.lo)} … ${pt(x.hi)}]  (${pt(x.a)} vs ${pt(x.b)}; n ${x.na} vs ${x.nb})`
    say(`# The best now, checked backwards — and getting better toward now (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.15, the first ${N} names`)
    const sides = { real: [], shuf: [] }
    let k = 0
    for await (const [sym, bars] of namesOf()) {
        if (k++ >= N) break
        for (const r of rowsOf(bars)) sides.real.push({ ...r, name: sym })
        for (const r of rowsOf(E.shuffledBars(bars, E.seededRandom(seedOf(sym))))) sides.shuf.push({ ...r, name: sym })
        if (k % 10 === 0) console.log(`  ${k}`)
    }
    const res = { real: analyse(sides.real), shuf: analyse(sides.shuf) }
    const ok = (x) => x.d != null && x.d >= 0.05 && x.lo > 0
    const verdict = {}
    for (const side of ['real', 'shuf']) {
        say(`\n## ${side === 'real' ? 'Real' : 'Shuffled (the control)'}`)
        for (const half of ['older', 'recent']) {
            const r = res[side][half]
            say(`\n### ${half === 'older' ? `Older half (to ${HALF_LABEL})` : `Recent half (from ${HALF_LABEL})`}`)
            say(`  A1  the best now — their BEFORE edge vs the others':   ${line('', r.a1)}`)
            say(`  A2  best now AND OK before — NEXT edge vs the others:  ${line('', r.a2)}`)
            say(`      best now, NOT OK before — NEXT edge vs the others: ${line('', r.aNot)}`)
            say(`      best now (any) — NEXT edge vs the others:          ${line('', r.aAll)}`)
            say(`  B   improving M1→M3 minus worsening — NEXT edge:        ${line('', r.b)}`)
        }
        verdict[side] = { a2: ok(res[side].older.a2) && ok(res[side].recent.a2), b: ok(res[side].older.b) && ok(res[side].recent.b) }
    }
    say('\n## Verdict (the declared PASS: ≥ +5 pts, interval above 0, both halves, the shuffled control not passing)')
    say(`A2 — the best now that were OK before: ${verdict.real.a2 && !verdict.shuf.a2 ? 'PASS' : 'no'}${verdict.shuf.a2 ? ' [shuffled passes]' : ''}`)
    say(`B  — getting better toward now:        ${verdict.real.b && !verdict.shuf.b ? 'PASS' : 'no'}${verdict.shuf.b ? ' [shuffled passes]' : ''}`)
    fs.writeFileSync(`data/lab/proteus-bestnow${SUFFIX}.out.txt`, lines.join('\n') + '\n')
    console.log(`→ data/lab/proteus-bestnow${SUFFIX}.out.txt`)
    process.exit(0)
}
