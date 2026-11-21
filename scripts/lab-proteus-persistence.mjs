#!/usr/bin/env node
// IS "WHAT WORKED LATELY KEEPS WORKING" A TRAIT OF THE NAME? — declared in docs/design/proteus.md §10.14 before the run.
// Per name: the walk-forward of §10.13's one-name lab (3 months back / 1 month forward, every 21 sessions, the 31
// signals), its PERSISTENCE in each half of the 10 years (next-month edge after a window that worked minus after one that
// failed), and whether a name's older persistence predicts its recent one, across names — with the shuffled control.
//
//   node --max-old-space-size=6000 scripts/lab-proteus-persistence.mjs [N=100]   → data/lab/proteus-persistence.out.txt

import fs from 'fs'
import { E, P, atrsOf, seedOf, dailyNames10y } from './lab-proteus.shared.mjs'
import { mirror } from './lab-proteus-signals.mjs'
import { eventsOf, SIGNALS } from './lab-proteus-xsection.mjs'

const N = Number(process.argv[2] ?? 100)
// The forward window: 21 sessions (§10.14) or what argv[3] says (10.14b: 10).
const BACK = 63, FWD = Number(process.argv[3] ?? 21), STEP = 21, WORKED = 0.15
const HALF = Date.parse('2021-10-26T00:00:00Z') / 1000
const SHORT = new Set(['R3', 'R4', 'M4', 'M5', 'M6'])

/** One series → per half: { worked: [fwd edges], failed: [fwd edges] }, over every signal's windows. Pure. */
export function persistenceOf(bars, opts = P) {
    const n = bars.length, atrs = atrsOf(bars), mb = mirror(bars)
    const outcome = (i, short) => {
        const a = atrs[i]
        if (!(a > 0)) return null
        const b = short ? mb : bars
        return E.bracket(b, i, b[i].close + opts.up * a, b[i].close - opts.down * a, opts.horizon)
    }
    const rate = (idx, short) => { const o = idx.map(i => outcome(i, short)).filter(Boolean); return o.length ? { n: o.length, r: o.filter(x => x === 'win').length / o.length } : { n: 0, r: null } }
    const drift = (from, to, short) => { const idx = []; for (let i = Math.max(0, from); i < to; i += opts.horizon) idx.push(i); return rate(idx, short) }
    const { ev } = eventsOf(bars, opts)
    const out = { older: { worked: [], failed: [] }, recent: { worked: [], failed: [] } }
    for (const sig of SIGNALS) {
        const short = SHORT.has(sig.key), idx = ev[sig.key] ?? []
        for (let e = 300; e + FWD < n; e += STEP) {
            const back = idx.filter(i => i > e - BACK && i + opts.horizon <= e)
            const fwd = idx.filter(i => i > e && i <= e + FWD)
            if (back.length < 2 || fwd.length < 1) continue
            const rb = rate(back, short), rf = rate(fwd, short), db = drift(e - BACK, e - opts.horizon, short), df = drift(e + 1, e + FWD + 1, short)
            if (rb.r == null || rf.r == null || db.r == null || df.r == null) continue
            const eb = rb.r - db.r, ef = rf.r - df.r
            const half = bars[e].timestamp < HALF ? out.older : out.recent
            if (eb >= WORKED) half.worked.push(ef)
            else if (eb <= -WORKED) half.failed.push(ef)
        }
    }
    const spread = (h) => (h.worked.length >= 5 && h.failed.length >= 5 ? h.worked.reduce((s, x) => s + x, 0) / h.worked.length - h.failed.reduce((s, x) => s + x, 0) / h.failed.length : null)
    return { older: spread(out.older), recent: spread(out.recent), raw: out }
}

const corr = (pairs) => {
    const n = pairs.length
    if (n < 5) return null
    const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n
    let num = 0, vx = 0, vy = 0
    for (const [x, y] of pairs) { num += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2 }
    return vx && vy ? num / Math.sqrt(vx * vy) : null
}
/** The correlation and its 95th percentile under 1,000 shuffles of the pairing (a seeded shuffle). */
function permutation(pairs, seed = 7) {
    const r = corr(pairs)
    let s = seed >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
    const ys = pairs.map(p => p[1]), null_ = []
    for (let k = 0; k < 1000; k++) {
        const y = [...ys]
        for (let i = y.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [y[i], y[j]] = [y[j], y[i]] }
        null_.push(corr(pairs.map((p, i) => [p[0], y[i]])))
    }
    null_.sort((a, b) => a - b)
    return { r, p95: null_[Math.floor(0.95 * null_.length)] }
}

if (process.argv[1]?.endsWith('lab-proteus-persistence.mjs')) {
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const pt = (x) => (x == null ? '   —' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}`.padStart(4))
    say(`# Persistence as a trait of the name (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.14, the first ${N} names, forward ${FWD} sessions`)
    say('Persistence = next-month edge after a 3-month window where a signal WORKED (≥ +15 pts) minus after one where it FAILED (≤ −15), all 31 signals; points.')
    say('name     older   recent   │ shuffled: older recent')
    const real = [], shuf = [], pooled = { real: { older: { w: [], f: [] }, recent: { w: [], f: [] } }, shuf: { older: { w: [], f: [] }, recent: { w: [], f: [] } } }
    let k = 0
    for await (const [sym, bars] of dailyNames10y()) {
        if (k++ >= N) break
        const a = persistenceOf(bars), b = persistenceOf(E.shuffledBars(bars, E.seededRandom(seedOf(sym))))
        for (const [side, x] of [['real', a], ['shuf', b]]) for (const h of ['older', 'recent']) { pooled[side][h].w.push(...x.raw[h].worked); pooled[side][h].f.push(...x.raw[h].failed) }
        if (a.older != null && a.recent != null) real.push([a.older, a.recent, sym])
        if (b.older != null && b.recent != null) shuf.push([b.older, b.recent, sym])
        say(`${sym.padEnd(8)} ${pt(a.older)}   ${pt(a.recent)}     │          ${pt(b.older)}   ${pt(b.recent)}`)
    }
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
    say('\n## Market-wide (all names pooled): next-month edge after WORKED vs after FAILED')
    for (const side of ['real', 'shuf']) for (const h of ['older', 'recent']) {
        const p = pooled[side][h]
        say(`  ${side.padEnd(4)} ${h.padEnd(6)} after worked ${pt(mean(p.w))} (n ${p.w.length}) · after failed ${pt(mean(p.f))} (n ${p.f.length}) · persistence ${pt(mean(p.w) - mean(p.f))}`)
    }
    say('\n## Is it a trait? A name\'s older persistence against its recent one, across names')
    const verdict = {}
    for (const [side, pairs] of [['real', real], ['shuf', shuf]]) {
        const { r, p95 } = permutation(pairs)
        const same = pairs.filter(([x, y]) => Math.sign(x) === Math.sign(y)).length
        verdict[side] = r != null && r >= 0.2 && r > p95
        say(`  ${side.padEnd(4)} ${pairs.length} names · r ${r?.toFixed(3)} (the shuffled pairing's 95th percentile ${p95?.toFixed(3)}) · same sign in both halves ${same} of ${pairs.length} · ${verdict[side] ? 'PASS' : 'no'}`)
    }
    say(`\nVerdict: ${verdict.real && !verdict.shuf ? 'PASS — persistence is a trait of the name (run on all names next)' : verdict.real && verdict.shuf ? 'NO — the shuffled control passes too' : 'NO — a name\'s persistence in one half does not predict the other'}`)
    fs.writeFileSync(`data/lab/proteus-persistence${FWD === 21 ? '' : `-fwd${FWD}`}.out.txt`, lines.join('\n') + '\n')
    console.log(`→ data/lab/proteus-persistence${FWD === 21 ? '' : `-fwd${FWD}`}.out.txt`)
    process.exit(0)
}
