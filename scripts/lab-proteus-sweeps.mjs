#!/usr/bin/env node
// THE FALSE BREAKS ACROSS THE WHOLE UNIVERSE (Roy, 2026-11-14: "Proteus identifies false breaks / sweeps in a lot of stocks —
// let's check it"). Declared in docs/design/proteus.md §10.1 before the run. Proteus's own engine on every screener name's
// daily bars, and pooled over daily and 5-minute bars — with each name's bars shuffled through the identical pipeline.
//
//   node --max-old-space-size=4000 scripts/lab-proteus-sweeps.mjs   → data/lab/proteus-sweeps.out.txt

import fs from 'fs'
import readline from 'readline'

const ROOT = new URL('../', import.meta.url)
const E = await import(new URL('services/behaviourProfile.engine.js', ROOT))
const { calcATRSeries } = await import(new URL('monitoring/evaluators/structured.evaluator.js', ROOT))
const P = E.PROFILE
const HELD_OUT = Date.parse('2026-03-01T00:00:00Z') / 1000

const out = []
const say = (l = '') => { console.log(l); out.push(l) }
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 } }
/** _shuffledBars' rule (behaviourProfile.engine): each bar's shape against the close before it, in a shuffled order. */
function shuffled(bars, rnd) {
    const parts = []
    for (let i = 1; i < bars.length; i++) { const p = bars[i - 1].close, b = bars[i]; parts.push([b.close / p, b.open / p, b.high / b.close, b.low / b.close, b.volume]) }
    for (let i = parts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [parts[i], parts[j]] = [parts[j], parts[i]] }
    const o = [bars[0]]
    for (let i = 0; i < parts.length; i++) {
        const [cr, or, hr, lr, v] = parts[i], prev = o.at(-1).close, close = prev * cr, open = prev * or
        o.push({ open, close, high: Math.max(close * hr, open, close), low: Math.min(close * lr, open, close), volume: v, timestamp: bars[i + 1].timestamp })
    }
    return o
}
const atrsOf = (bars) => calcATRSeries(bars.map(b => ({ t: b.timestamp * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })), P.atrPeriod)

/** Proteus's false-break read on one series → { chance, sweep, fb, drift } (the drift and the sweep events for pooling). */
function read(bars) {
    const atrs = atrsOf(bars)
    const cut = Math.floor(bars.length * (1 - P.recentShare))
    const drift = E.driftOutcomes(bars, atrs, P)
    const fb = E.falseBreaks(bars, atrs, cut, drift, P)
    return { chance: E.falseBreakChance(bars, cut, fb, P).verdict, sweep: fb.after_sweep.verdict, rate: fb.false_rate, sweeps: fb.sweeps, drift }
}

// Pooled outcomes: { real|shuf } × { older|recent } × { sweep|drift } → { n, wins }
const pool = () => ({ real: { older: { sweep: [0, 0], drift: [0, 0] }, recent: { sweep: [0, 0], drift: [0, 0] } },
    shuf: { older: { sweep: [0, 0], drift: [0, 0] }, recent: { sweep: [0, 0], drift: [0, 0] } } })
const addPool = (pl, side, bars, r) => {
    for (const kind of ['sweep', 'drift']) {
        const evs = kind === 'sweep' ? r.sweeps : r.drift
        for (const e of evs) { if (!e.out) continue; const part = bars[e.i].timestamp >= HELD_OUT ? 'recent' : 'older'; const c = pl[side][part][kind]; c[0]++; if (e.out === 'win') c[1]++ }
    }
}
function poolReport(pl, label) {
    say(`\n${label} — pooled win rate (+${P.up} ATR before a close ${P.down} ATR lower, within ${P.horizon} bars), sweep vs drift:`)
    for (const side of ['real', 'shuf']) for (const part of ['older', 'recent']) {
        const [sn, sw] = pl[side][part].sweep, [dn, dw] = pl[side][part].drift
        const a = sn ? sw / sn : null, b = dn ? dw / dn : null
        const se = a != null && b != null ? Math.sqrt(a * (1 - a) / sn + b * (1 - b) / dn) : null
        const d = a != null && b != null ? a - b : null
        say(`  ${(side === 'real' ? 'real' : 'shuffled').padEnd(9)} ${part.padEnd(7)} sweeps ${pct(a)} (n ${sn})  drift ${pct(b)} (n ${dn})  diff ${d == null ? '—' : (d * 100).toFixed(1)} pts (95% ${se == null ? '—' : `${((d - 1.96 * se) * 100).toFixed(1)} … ${((d + 1.96 * se) * 100).toFixed(1)}`})`)
    }
}

// ─── Daily, per name ───
const raw = JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8'))
const tally = { real: { chance: {}, sweep: {} }, shuf: { chance: {}, sweep: {} } }
const inc = (o, k) => { o[k] = (o[k] ?? 0) + 1 }
const flagged = { more: [], less: [], respects: [] }
const rates = []
const dayPool = pool()
let names = 0
for (const [sym, bars0] of Object.entries(raw.names)) {
    const bars = (bars0 ?? []).filter(b => b?.close > 0 && b?.open > 0 && b.high >= b.low)
    if (bars.length < 260) continue
    names++
    const r = read(bars)
    inc(tally.real.chance, r.chance); inc(tally.real.sweep, r.sweep)
    if (r.chance === 'more') flagged.more.push(sym)
    if (r.chance === 'less') flagged.less.push(sym)
    if (r.sweep === 'respects') flagged.respects.push(sym)
    if (r.rate != null) rates.push(r.rate)
    addPool(dayPool, 'real', bars, r)
    const sb = shuffled(bars, rng(sym.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)))
    const s = read(sb)
    inc(tally.shuf.chance, s.chance); inc(tally.shuf.sweep, s.sweep)
    addPool(dayPool, 'shuf', sb, s)
    if (names % 200 === 0) console.log(`  daily ${names}`)
}
raw.names = null
rates.sort((a, b) => a - b)
say(`# Proteus's false breaks across the universe (${new Date().toISOString().slice(0, 10)}) — PROFILE as built (sweepBack ${P.sweepBack}, z ${P.z}, edge ${P.edge})`)
say(`\n## Daily, per name — ${names} names, ~4 years each (2022-09 → 2026-10)`)
say(`false-break rate: median ${pct(rates[Math.floor(rates.length / 2)])}, middle half ${pct(rates[Math.floor(rates.length / 4)])} – ${pct(rates[Math.floor(rates.length * 3 / 4)])}`)
const order = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')
say(`false breaks vs chance — real:     ${order(tally.real.chance)}`)
say(`                         shuffled: ${order(tally.shuf.chance)}`)
say(`a sweep leading higher — real:     ${order(tally.real.sweep)}`)
say(`                         shuffled: ${order(tally.shuf.sweep)}`)
say(`flagged real: more ${flagged.more.join(' ') || '—'} | less ${flagged.less.join(' ') || '—'} | sweeps respects ${flagged.respects.join(' ') || '—'}`)
poolReport(dayPool, '\n## Daily, pooled')

// ─── 5-minute, pooled (test 4's cache) ───
const fivePool = pool()
let weeks = 0
const rl = readline.createInterface({ input: fs.createReadStream('data/lab/daytrade-5m.jsonl'), crlfDelay: Infinity })
for await (const line of rl) {
    if (!line) continue
    const { bars } = JSON.parse(line)
    if (!bars?.length) continue
    // Regular hours only (the bars are regular-session already); ~10 sessions → enough for the 14-bar ATR and the swings.
    const b5 = bars.map(([t, o, h, l, c, v]) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v })).filter(b => b.close > 0 && b.high >= b.low)
    if (b5.length < 200) continue
    weeks++
    const r = read(b5)
    addPool(fivePool, 'real', b5, r)
    const sb = shuffled(b5, rng(weeks * 7919))
    addPool(fivePool, 'shuf', sb, read(sb))
    if (weeks % 500 === 0) console.log(`  5-minute ${weeks}`)
}
poolReport(fivePool, `\n## 5-minute, pooled — ${weeks} name-weeks`)
fs.writeFileSync('data/lab/proteus-sweeps.out.txt', out.join('\n') + '\n')
console.log('→ data/lab/proteus-sweeps.out.txt')
process.exit(0)
