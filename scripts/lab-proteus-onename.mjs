#!/usr/bin/env node
// ONE NAME, EVERYTHING, OVER TIME (Roy, 2026-11-21: "let's take one name and run all the tests with all of our indicators
// and patterns and also around movement — I want to see what we get"; the frame: "a swing trade will check three months
// backwards and one month forward").
//
//   A. WALK-FORWARD, every signal: at each month-end, the last 3 months (63 sessions — only events whose 10-bar outcome
//      is already known by then) and the next month (21 sessions). Per window: events, win rate (the engine's outcome:
//      +1 ATR before a close 0.5 ATR lower in 10 bars; the bearish ones mirrored) and the edge over the same window's
//      drift. Then: when a signal WORKED in the last 3 months, did it work in the next month?
//   B. THE MOVES (K's: +4 ATR within 20 bars), every one in the 10 years: the low, the top it pulled back from, the gain,
//      and the facts at the low, at the top and into the top (moveSteps' own).
//   C. NOW: the last 3 months of every signal — what a "how it behaves now" read would say today.
//
//   node scripts/lab-proteus-onename.mjs [SYMBOL]   (default NVDA) → data/lab/proteus-onename-<SYMBOL>.out.txt

import fs from 'fs'
import readline from 'readline'
import { E, P, atrsOf } from './lab-proteus.shared.mjs'
import { mirror } from './lab-proteus-signals.mjs'
import { eventsOf, SIGNALS } from './lab-proteus-xsection.mjs'

const ROOT = new URL('../', import.meta.url)
const S = await import(new URL('services/moveSteps.engine.js', ROOT))

const SYM = (process.argv[2] ?? 'NVDA').toUpperCase()
const BACK = 63, FWD = 21, STEP = 21
const SHORT = new Set(['R3', 'R4', 'M4', 'M5', 'M6'])

async function load(sym, file = 'data/lab/screener-10y.jsonl') {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line.startsWith(`{"symbol":"${sym}"`)) continue
        const { b } = JSON.parse(line)
        rl.close()
        return b.map(([t, o, h, l, c, v]) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v }))
            .filter(x => x.close > 0 && x.open > 0 && x.high >= x.low).sort((x, y) => x.timestamp - y.timestamp)
    }
    throw new Error(`${sym} is not in the file`)
}

const bars = await load(SYM)
const n = bars.length
const atrs = atrsOf(bars)
const day = (i) => new Date(bars[i].timestamp * 1000).toISOString().slice(0, 10)
const mbars = mirror(bars)
// The engine's one outcome at bar i, long or short (mirrored).
const outcome = (i, short) => {
    const a = atrs[i]
    if (!(a > 0)) return null
    const b = short ? mbars : bars
    return E.bracket(b, i, b[i].close + P.up * a, b[i].close - P.down * a, P.horizon)
}
const lines = []
const say = (l = '') => { console.log(l); lines.push(l) }
const pct = (x) => (x == null ? '  —  ' : `${(x * 100).toFixed(0).padStart(3)}%`)
const sgn = (x) => (x == null ? '   — ' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}`.padStart(5))

const { ev } = eventsOf(bars)

/** Win rate of outcomes at bars `idx` (nulls dropped). */
const rate = (idx, short) => { const o = idx.map(i => outcome(i, short)).filter(Boolean); return { n: o.length, r: o.length ? o.filter(x => x === 'win').length / o.length : null } }
/** The window's drift: every 10th bar of [from, to). */
const drift = (from, to, short) => { const idx = []; for (let i = from; i < to; i += P.horizon) idx.push(i); return rate(idx, short) }

say(`# ${SYM} — every signal, 3 months back / 1 month forward, and every move (${new Date().toISOString().slice(0, 10)})`)
say(`${n} daily bars, ${day(0)} → ${day(n - 1)}. Outcome: +1 ATR before a close 0.5 ATR lower within 10 bars (bearish: mirrored).`)
say(`Edge = the signal's win rate minus the same window's drift (every 10th bar), in points.`)

// ─── A. Walk-forward ─────────────────────────────────────────────────────────────────────────────────────────────────
say('\n## A. Walk-forward — when it worked in the last 3 months, did it work in the next month?')
say('Per signal: windows with ≥ 2 events back and ≥ 1 forward (one event per 10 bars: a signal fires ~3 times in 3 months). "worked back" = back edge ≥ +15 pts; "failed back" ≤ −15.')
say('signal   windows │ fwd edge after WORKED (n) │ fwd edge after FAILED (n) │ fwd edge, all │ corr(back, fwd)')
const summary = []
const timelines = {}
for (const sig of SIGNALS) {
    const short = SHORT.has(sig.key)
    const idx = ev[sig.key] ?? []
    const rows = []
    for (let e = 300; e + FWD < n; e += STEP) {
        // Back: events whose 10-bar outcome is KNOWN at e (i + horizon ≤ e); forward: events in (e, e + 21].
        const back = idx.filter(i => i > e - BACK && i + P.horizon <= e)
        const fwd = idx.filter(i => i > e && i <= e + FWD)
        const rb = rate(back, short), rf = rate(fwd, short)
        const db = drift(e - BACK, e - P.horizon, short), df = drift(e + 1, e + FWD + 1, short)
        rows.push({ e, nb: rb.n, eb: rb.r != null && db.r != null ? rb.r - db.r : null, rb: rb.r, nf: rf.n, ef: rf.r != null && df.r != null ? rf.r - df.r : null, rf: rf.r })
    }
    timelines[sig.key] = rows
    const both = rows.filter(r => r.nb >= 2 && r.nf >= 1 && r.eb != null && r.ef != null)
    const avg = (xs) => (xs.length ? xs.reduce((s, r) => s + r.ef, 0) / xs.length : null)
    const worked = both.filter(r => r.eb >= 0.15), failed = both.filter(r => r.eb <= -0.15)
    let corr = null
    if (both.length >= 8) {
        const mb = both.reduce((s, r) => s + r.eb, 0) / both.length, mf = both.reduce((s, r) => s + r.ef, 0) / both.length
        let num = 0, vb = 0, vf = 0
        for (const r of both) { num += (r.eb - mb) * (r.ef - mf); vb += (r.eb - mb) ** 2; vf += (r.ef - mf) ** 2 }
        corr = vb && vf ? num / Math.sqrt(vb * vf) : null
    }
    summary.push({ key: sig.key, label: sig.label, windows: both.length, worked: avg(worked), nw: worked.length, failed: avg(failed), nf: failed.length, all: avg(both), corr })
    say(`${sig.key.padEnd(7)} ${String(both.length).padStart(5)}   │ ${sgn(avg(worked))} (${String(worked.length).padStart(2)})              │ ${sgn(avg(failed))} (${String(failed.length).padStart(2)})              │ ${sgn(avg(both))}        │ ${corr == null ? '  —' : corr.toFixed(2).padStart(5)}`)
}
const pooledW = summary.filter(s => s.worked != null), pooledF = summary.filter(s => s.failed != null)
const wAvg = (xs, k, nk) => { const t = xs.reduce((s, x) => s + x[nk], 0); return t ? xs.reduce((s, x) => s + x[k] * x[nk], 0) / t : null }
say(`\nALL SIGNALS TOGETHER: after a 3-month window where it WORKED, the next month's edge ${sgn(wAvg(pooledW, 'worked', 'nw'))} pts (${pooledW.reduce((s, x) => s + x.nw, 0)} windows); after one where it FAILED ${sgn(wAvg(pooledF, 'failed', 'nf'))} pts (${pooledF.reduce((s, x) => s + x.nf, 0)}).`)

// The timelines of the three most active signals, for a look.
say('\n### Timelines — the last 24 months, three busiest signals (back n / win / edge → forward n / win / edge)')
const busiest = [...summary].sort((a, b) => b.windows - a.windows).slice(0, 3).map(s => s.key)
for (const k of busiest) {
    say(`\n${SIGNALS.find(s => s.key === k).label}${SHORT.has(k) ? ' (SHORT)' : ''}`)
    for (const r of timelines[k].slice(-24)) say(`  ${day(r.e)}  back ${String(r.nb).padStart(2)} ${pct(r.rb)} ${sgn(r.eb)}  →  fwd ${String(r.nf).padStart(2)} ${pct(r.rf)} ${sgn(r.ef)}`)
}

// ─── B. The moves ────────────────────────────────────────────────────────────────────────────────────────────────────
say('\n## B. Every move (+4 ATR within 20 bars, K\'s rule) — and what was there at its low, its top, and into the top')
const flags = E.moveFlags ? E.moveFlags(bars, atrs) : null
const starts = flags ? E.moveStartsOf(bars, flags) : []
const cut = Math.floor(n * (1 - P.recentShare))
const w = E.wyckoffTest(bars, atrs, cut, E.driftOutcomes(bars, atrs), [])
const d = S.prepareSteps(bars, atrs, { ranges: w.range_list ?? [], springs: w.spring_events ?? [] })
const closes = bars.map(b => b.close)
const counts = { low: {}, top: {}, into: {} }
const lows = [], tops = []
let moves = 0
for (const s of starts) {
    const run = S.runOf(closes, s)
    if (!run) continue
    lows.push(s); tops.push(run.h)
    const f = S.stepFacts(d, s, run.h, run.lo)
    let hi = closes[s]
    for (let j = s + 1; j <= Math.min(n - 1, s + 20); j++) hi = Math.max(hi, bars[j].high)
    const on = (step) => Object.entries(f[step]).filter(([, v]) => v === true).map(([k]) => k)
    for (const step of ['low', 'top', 'into']) for (const k of on(step)) counts[step][k] = (counts[step][k] ?? 0) + 1
    moves++
    say(`  ${day(s)} low ${closes[s].toFixed(2)} → +${((hi / closes[s] - 1) * 100).toFixed(0)}% (+${((hi - closes[s]) / atrs[s]).toFixed(1)} ATR) · pulled back from ${day(run.h)} (${((closes[s] / closes[run.h] - 1) * 100).toFixed(0)}%)`)
    say(`      at the low: ${on('low').join(', ') || '—'}`)
    say(`      at the top: ${on('top').join(', ') || '—'}   ·   into the top: ${on('into').join(', ') || '—'}`)
}
say(`\n${moves} moves. How often each fact was there (of ${moves}):`)
for (const step of ['low', 'top', 'into']) say(`  ${S.STEP_NAMES[step]}: ${Object.entries(counts[step]).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(' · ') || '—'}`)

// Every signal (today's included) around the moves: at the LOW (it fired in the 3 bars up to the low) and at the TOP
// (within 3 bars either side) — against how often it fires in the same span at ANY bar. More often at moves than at any
// bar = it comes with this name's moves; about as often = it is just common.
say('\nEvery signal around the moves — share of moves with it there vs share of ANY bar with it in the same span:')
say('signal   at the low (3 bars up to it)   at the top (±3 bars)')
const near = (set, i, from, to) => { for (let j = i + from; j <= i + to; j++) if (set.has(j)) return true; return false }
for (const sig of SIGNALS) {
    const set = new Set(ev[sig.key] ?? [])
    const share = (idx, from, to) => (idx.length ? idx.filter(i => near(set, i, from, to)).length / idx.length : null)
    const any = []
    for (let i = 300; i < n - 3; i++) any.push(i)
    const lo = share(lows, -3, 0), loAny = share(any, -3, 0), tp = share(tops, -3, 3), tpAny = share(any, -3, 3)
    const mark = (a, b) => (a != null && b != null && a >= 2 * b && a >= 0.2 ? '  ◀' : '')
    say(`${sig.key.padEnd(7)}  ${pct(lo)} vs ${pct(loAny)}${mark(lo, loAny).padEnd(4)}              ${pct(tp)} vs ${pct(tpAny)}${mark(tp, tpAny)}`)
}
say('◀ = at least twice as common at the moves as at any bar, and on ≥ 20% of them (a description of this name\'s moves, not a test).')

// ─── C. Now ──────────────────────────────────────────────────────────────────────────────────────────────────────────
say(`\n## C. Now — the last 3 months to ${day(n - 1)}, every signal (events with a known outcome)`)
say('signal  events  win   edge   (the drift of the same 3 months: long ' + pct(drift(n - BACK, n - P.horizon, false).r) + ', short ' + pct(drift(n - BACK, n - P.horizon, true).r) + ')')
for (const sig of SIGNALS) {
    const short = SHORT.has(sig.key)
    const back = (ev[sig.key] ?? []).filter(i => i > n - BACK && i + P.horizon < n)
    const rb = rate(back, short), db = drift(n - BACK, n - P.horizon, short)
    say(`${sig.key.padEnd(7)} ${String(rb.n).padStart(4)}   ${pct(rb.r)}  ${sgn(rb.r != null && db.r != null ? rb.r - db.r : null)}   ${sig.label.replace(/^[^.]+\. /, '')}${short ? ' (SHORT)' : ''}`)
}

const out = `data/lab/proteus-onename-${SYM}.out.txt`
fs.writeFileSync(out, lines.join('\n') + '\n')
console.log(`→ ${out}`)
process.exit(0)
