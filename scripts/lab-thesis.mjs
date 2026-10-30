#!/usr/bin/env node
// THE THESIS LENS'S TEST 1 (Roy, 2026-10-30: "do we have a way to test this approach?" → "Run") — the reversal thesis as
// fixed rules on the point-in-time S&P 500. Declared in docs/design/stock-playbook.md §Test 1 before the run; the rules
// are services/thesisLab.service.js. Reads the lab's cached bars only (no fetch).
//
//   node scripts/lab-thesis.mjs            → the table, also written to data/lab/thesis.out.txt
//   node scripts/lab-thesis.mjs --control  → test 1b: buyers in control, any context (→ data/lab/thesis-control.out.txt)
//
// The variants beside the primary are shown, not for the bar — each is another try.

import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const L = await import('../services/thesisLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { costFor, MIN_ADV, MIN_PRICE } = await import('../services/screenerLab.service.js')
const { memberOn } = await import('../services/sp500History.service.js')

const CONTROL = process.argv.includes('--control')
const TO = '2026-10-26', HELD_OUT = '2025-10-23', WARMUP = 260
// The members' share of their sessions in the index that have a bar — under it, the ticker is not the company (reused)
// or FMP lacks it (the same rule as lab-rotation.mjs).
const COVERAGE = 0.9

const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: TO }, extras: [], member })
const days = data.spyDays.slice(WARMUP)
const covered = []
for (const sym of Object.keys(u.spans)) {
    const inIdx = days.filter(d => member(sym, d))
    const s = data.names.get(sym)
    if (!inIdx.length || !s) continue
    const have = new Set(s.ind.date)
    if (inIdx.filter(d => have.has(d)).length / inIdx.length >= COVERAGE) covered.push(sym)
}

const out = []
const say = (line = '') => { console.log(line); out.push(line) }
say(`Thesis test ${CONTROL ? '1b (buyers in control, any context)' : '1 (the reversal)'} — the S&P 500 point-in-time, ${days[0]} → ${days.at(-1)}, ${covered.length} names covered · held out from ${HELD_OUT}`)

const P = L.DEFAULTS
const VARIANTS = [
    { id: 'PRIMARY', o: P },
    { id: 'k 1.0', o: { ...P, k: 1.0 } },
    { id: 'k 2.0', o: { ...P, k: 2.0 } },
    { id: 'buffer 0', o: { ...P, buffer: 0 } },
    { id: 'buffer 0.5', o: { ...P, buffer: 0.5 } },
    { id: 'R:R 1', o: { ...P, rr: 1 } },
    { id: 'R:R 2', o: { ...P, rr: 2 } },
    { id: 'R:R 3', o: { ...P, rr: 3 } },
    // The entry set by the RISK LIMIT (Roy, 2026-10-30), the R:R ≥ 1.5 only a check — and once without it.
    { id: 'risk 3%', o: { ...P, entryBy: 'risk', riskPct: 3, minRR: 1.5 } },
    { id: 'risk 5%', o: { ...P, entryBy: 'risk', riskPct: 5, minRR: 1.5 } },
    { id: 'risk 8%', o: { ...P, entryBy: 'risk', riskPct: 8, minRR: 1.5 } },
    { id: 'risk 5% no check', o: { ...P, entryBy: 'risk', riskPct: 5, minRR: 0 } },
    // A LOWER stop (Roy, 2026-10-30: "so maybe the stop needs to be lower?") — wider buffers, and under the whole down move.
    { id: 'buffer 1.0', o: { ...P, buffer: 1.0 } },
    { id: 'buffer 2.0', o: { ...P, buffer: 2.0 } },
    { id: 'stop at 60-day low', o: { ...P, stopAt: 'low60' } },
    { id: 'no strength', o: { ...P, strength: false } },
    { id: 'SPY over 200d', o: P, regime: 'SPY over 200d' },
    { id: 'BASELINE', o: P, baseline: true },
]

/**
 * Every trade of every variant on one side → `Map(variant id → { v, trades, open })`. One NAME at a time — its mirrored
 * bars, ATR and swings are built, used for every variant, and dropped before the next (all of them held at once ran the
 * laptop out of memory, 2026-10-30).
 */
function runSide(side) {
    const res = new Map(VARIANTS.filter(v => side === 'long' || ['PRIMARY', 'BASELINE', 'R:R 1'].includes(v.id)).map(v => [v.id, { v, trades: [], open: 0 }]))
    for (const sym of covered) {
        const s = data.names.get(sym), rows0 = s.rows, date = s.ind.date, adv = s.ind.adv20
        const rows = side === 'short' ? L.mirror(rows0) : rows0
        const a = L.atr(rows), pvByK = new Map()
        for (const r of res.values()) {
            const { v } = r
            if (!pvByK.has(v.o.k)) pvByK.set(v.o.k, L.swings(rows, a, v.o.k))
            const pv = pvByK.get(v.o.k)
            const sigs = v.baseline ? L.baselineSignals(rows, a, pv, v.o) : CONTROL ? L.controlSignals(rows, a, pv, v.o) : L.reversalSignals(rows, a, pv, v.o)
            for (const sig of sigs) {
                const i = sig.i, day = date[i]
                if (i < WARMUP || !member(sym, day) || rows0[i].close < MIN_PRICE || !((adv[i] ?? 0) >= MIN_ADV)) continue
                const regime = data.regimes.get(day) ?? ''
                if (v.regime && !regime.startsWith(v.regime)) continue
                const p = L.plan(sig, a, v.o)
                if (!p) continue
                const t = L.play(rows, i, p, v.o)
                if (!t) continue
                if (t.reason === 'open') { r.open++; continue }
                // R on the PLANNED risk (the size is set at the level and kept — Roy, 2026-10-30).
                r.trades.push({ sym, day, r: L.inR(t, p.S, costFor(adv[i]), p.E), win: t.reason === 'target', reason: t.reason,
                    days: t.k - t.m, month: date[t.m].slice(0, 7), regime, held: day >= HELD_OUT, context: sig.context ?? null })
            }
        }
    }
    return res
}

const f = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d))
const line = (label, s) => (s.n
    ? `${label.padEnd(26)} ${String(s.n).padStart(6)}  hit ${(s.hit * 100).toFixed(1).padStart(5)}%  mean ${f(s.meanR)}R (${f(s.lo)} … ${f(s.hi)})  median ${f(s.medianR)}R  ${s.days}d`
    : `${label.padEnd(26)}      0`)

const results = {}
for (const side of ['long', 'short']) {
    say(`\n=== ${side.toUpperCase()} — before ${HELD_OUT} | held out (breakeven hit at R:R 1 = 50%, 1.5 = 40%, 2 = 33%, 3 = 25%)`)
    for (const { v, trades, open } of runSide(side).values()) {
        const pre = L.summarize(trades.filter(t => !t.held)), post = L.summarize(trades.filter(t => t.held))
        results[`${side}|${v.id}`] = { pre, post, trades }
        say(line(`${v.id} · before`, pre))
        say(line(`${v.id} · held out`, post) + (open ? `  (${open} still open, left out)` : ''))
    }
    const prim = results[`${side}|PRIMARY`].trades
    say(`\n${side} PRIMARY by signal year:`)
    for (const y of [...new Set(prim.map(t => t.day.slice(0, 4)))].sort()) say(line(`  ${y}`, L.summarize(prim.filter(t => t.day.startsWith(y)), { draws: 500 })))
    say(`${side} PRIMARY by SPY regime at the signal:`)
    for (const g of [...new Set(prim.map(t => t.regime))].sort()) say(line(`  ${g || '(none)'}`, L.summarize(prim.filter(t => t.regime === g), { draws: 500 })))
    // A few gaps far through the target (a buyout) can carry a mean: the same without the best 1%.
    for (const held of [false, true]) {
        const xs = prim.filter(t => t.held === held).sort((a, b) => a.r - b.r)
        say(line(`${side} PRIMARY ${held ? 'held out' : 'before'} − top 1%`, L.summarize(xs.slice(0, Math.floor(xs.length * 0.99)))))
    }
    // By context, the primary and the R:R 1 and 3 variants (Roy, 2026-10-30: "and if lowering to R:R 1" · "so R:R 3").
    for (const id of CONTROL ? ['PRIMARY', 'buffer 1.0', 'buffer 2.0', 'stop at 60-day low'] : []) {
        const xs = results[`${side}|${id}`]?.trades ?? []
        say(`${side} ${id} by context — before | held out:`)
        for (const c of ['reversal', 'continuation', 'breakout']) {
            say(line(`  ${c} · before`, L.summarize(xs.filter(t => t.context === c && !t.held), { draws: 1000 })))
            say(line(`  ${c} · held out`, L.summarize(xs.filter(t => t.context === c && t.held), { draws: 1000 })))
        }
    }
    const by = (k) => prim.filter(t => t.reason === k).length
    say(`${side} PRIMARY exits: target ${by('target')} · stop ${by('stop')} · time ${by('time')}`)
    const perName = new Map()
    for (const t of prim) perName.set(t.sym, (perName.get(t.sym) ?? 0) + 1)
    const counts = [...perName.values()].sort((a, b) => a - b)
    say(`${side} PRIMARY trades per name: ${perName.size} names, median ${counts[Math.floor(counts.length / 2)] ?? 0}, max ${counts.at(-1) ?? 0}`)
}

say('\n=== THE BAR (long PRIMARY): before mean > 0 and its 5% end > 0; held out mean > 0; above the BASELINE in both')
const lp = results['long|PRIMARY'], lb = results['long|BASELINE']
const checks = [
    ['before: mean R > 0', lp.pre.meanR > 0],
    ['before: the 5% end > 0', lp.pre.lo > 0],
    ['held out: mean R > 0', lp.post.meanR > 0],
    ['before: above the baseline', lp.pre.meanR > lb.pre.meanR],
    ['held out: above the baseline', lp.post.meanR > lb.post.meanR],
]
for (const [k, ok] of checks) say(`  ${ok ? '✓' : '✗'} ${k}`)
say(`  → ${checks.every(c => c[1]) ? 'PASS' : 'FAIL'}`)

fs.writeFileSync(`data/lab/thesis${CONTROL ? '-control' : ''}.out.txt`, out.join('\n') + '\n')
console.log(`→ data/lab/thesis${CONTROL ? '-control' : ''}.out.txt`)
process.exit(0)
