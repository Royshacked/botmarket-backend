#!/usr/bin/env node
// THE THESIS LENS'S TEST 3 (Roy, 2026-11-06: which timeframe finds the stop of a short term swing?) — the 4-hour swing-low
// stop against the daily one. Declared in docs/design/stock-playbook.md §Test 3 before the run.
//
//   node --max-old-space-size=6000 scripts/lab-thesis-stop.mjs --part=a|b [--sample N] [--count]
//     --count  says how many signals and how many reads, fetches nothing
//   → 4-hour bars once (data/lab/thesis-stop-h4.json, resumable), then the table (data/lab/thesis-stop-<part>.out.txt)

import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const L = await import('../services/thesisLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { HYPOTHESES, runHypothesis, costFor, MIN_ADV, MIN_PRICE } = await import('../services/screenerLab.service.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { getFmpCandles } = await import('../providers/fmp.price.provider.js')

const args = process.argv.slice(2)
const PART = (args.find(a => a.startsWith('--part=')) ?? '--part=a').split('=')[1]
const sampleAt = args.indexOf('--sample'), SAMPLE = sampleAt >= 0 ? Number(args[sampleAt + 1]) : null
const CACHE = 'data/lab/thesis-stop-h4.json', PARALLEL = 4, BACK = 30, WARMUP = 260, COVERAGE = 0.9
const O = L.DEFAULTS
const etDay = (sec) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const out = []
const say = (line = '') => { console.log(line); out.push(line) }
const f = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d))
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** Each job `{ sym, known (the last day known), from }` → its 4-hour bars, read once, stored small. */
async function fetchBars(jobs) {
    const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {}
    const todo = jobs.filter(g => !(`${g.sym}|${g.known}` in cache))
    let done = 0, failed = 0
    const one = async (g) => {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const r = await getFmpCandles(g.sym, { timeSpan: 'hour', multiplier: 1, from: Date.parse(g.from), to: Date.parse(g.known) })
                const h1 = (Array.isArray(r) ? r : []).map(b => ({ day: etDay(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close }))
                    .filter(b => b.day >= g.from && b.day <= g.known)
                cache[`${g.sym}|${g.known}`] = L.toFourHour(h1).map(b => [b.open, b.high, b.low, b.close])
                return
            } catch (err) {
                if (err?.status === 429) { await new Promise(res => setTimeout(res, 65_000)); continue }
                if (attempt === 3) { failed++; cache[`${g.sym}|${g.known}`] = [] }
            }
        }
    }
    for (let q = 0; q < todo.length; q += PARALLEL) {
        await Promise.all(todo.slice(q, q + PARALLEL).map(one))
        done += Math.min(PARALLEL, todo.length - q)
        if (done % 200 < PARALLEL || done === todo.length) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`  4-hour ${done}/${todo.length} (${failed} failed)`) }
    }
    return cache
}
const stopFrom = (cache, sym, known, close) => {
    const bars = cache[`${sym}|${known}`]
    return bars?.length ? L.intradayStop(bars.map(([open, high, low, c]) => ({ open, high, low, close: c })), close, O) : null
}
const sampled = (xs) => {
    if (SAMPLE == null) return xs
    const rand = L.rng(11)
    return xs.map(x => [rand(), x]).sort((a, b) => a[0] - b[0]).slice(0, SAMPLE).map(([, x]) => x)
}
/** The paired difference `a − b` by the month-bootstrap (summarize's). */
const paired = (xs) => L.summarize(xs.map(({ d, month }) => ({ r: d, win: false, days: 0, month })))
const pairLine = (label, xs) => { const s = paired(xs); say(`  ${label.padEnd(26)} ${String(s.n ?? 0).padStart(5)}  diff ${f(s.meanR, 3)} (${f(s.lo, 3)} … ${f(s.hi, 3)})`) }

if (PART === 'a') await partA(); else await partB()
if (!args.includes('--count')) {
    fs.writeFileSync(`data/lab/thesis-stop-${PART}.out.txt`, out.join('\n') + '\n')
    console.log(`→ data/lab/thesis-stop-${PART}.out.txt`)
}
process.exit(0)

async function partA() {
    const TO = '2026-10-26', HELD_OUT = '2025-10-23'
    const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
    const member = (sym, day) => memberOn(u.spans, sym, day)
    const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: TO }, extras: [], member })
    const days = data.spyDays.slice(WARMUP)
    let sigs = []
    for (const sym of Object.keys(u.spans)) {
        const s = data.names.get(sym)
        if (!s) continue
        const inIdx = days.filter(d => member(sym, d)), have = new Set(s.ind.date)
        if (!inIdx.length || inIdx.filter(d => have.has(d)).length / inIdx.length < COVERAGE) continue
        const a = L.atr(s.rows)
        for (const sig of L.controlSignals(s.rows, a, L.swings(s.rows, a, O.k), O)) {
            const i = sig.i, day = s.ind.date[i]
            if (sig.context !== 'reversal' || i < WARMUP || i + 1 >= s.rows.length || !member(sym, day) || s.rows[i].close < MIN_PRICE || !((s.ind.adv20[i] ?? 0) >= MIN_ADV)) continue
            const p = L.plan(sig, a, O)
            if (p) sigs.push({ sym, i, day, sig, p, atr: a[i], known: day, from: s.ind.date[Math.max(0, i - BACK)] })
        }
    }
    console.log(`${sigs.length} reversal signals with a plan`)
    sigs = sampled(sigs)
    if (args.includes('--count')) return console.log(`sample ${sigs.length} → up to ${sigs.length} reads`)
    const cache = await fetchBars(sigs)

    const usable = []
    for (const g of sigs) {
        const st = stopFrom(cache, g.sym, g.known, data.names.get(g.sym).rows[g.i].close)
        if (!st) continue
        const p4 = L.plan({ i: 0, stopBase: st.base, h0: g.sig.h0 }, [st.atr], O)
        usable.push({ ...g, st, p4 })
    }
    say(`Thesis test 3, part A — reversal signals sampled ${sigs.length}, with a 4-hour low under the close ${usable.length} · held out from ${HELD_OUT}`)
    const withPlan = usable.filter(g => g.p4)
    const closeOf = (g) => data.names.get(g.sym).rows[g.i].close
    say(`4-hour plan possible (rule A, level between stop and target): ${withPlan.length} (${(withPlan.length / usable.length * 100).toFixed(0)}%); no plan = no trade for the 4-hour arm`)
    say(`stop distance from the signal's close, daily ATRs (median): daily ${median(usable.map(g => (closeOf(g) - g.p.S) / g.atr)).toFixed(2)} · 4-hour ${median(usable.map(g => (closeOf(g) - g.st.stop) / g.atr)).toFixed(2)}`)
    say(`level under the signal's close, daily ATRs (median, 0 = at or over it): daily ${median(usable.map(g => Math.max(0, closeOf(g) - g.p.E) / g.atr)).toFixed(2)} · 4-hour ${median(withPlan.map(g => Math.max(0, closeOf(g) - g.p4.E) / g.atr)).toFixed(2)}`)
    say()

    const ARMS = {
        'A0 daily, wait 20, hold 250': { key: 'p', o: { ...O } },
        'A1 daily, wait 5, hold 10': { key: 'p', o: { ...O, wait: 5, maxHold: 10 } },
        'A2 4-hour, wait 5, hold 10': { key: 'p4', o: { ...O, wait: 5, maxHold: 10 } },
        'shown: daily, wait 20, hold 10': { key: 'p', o: { ...O, maxHold: 10 } },
        'shown: 4-hour, wait 20, hold 10': { key: 'p4', o: { ...O, maxHold: 10 } },
    }
    const perSignal = {}
    for (const [name, arm] of Object.entries(ARMS)) {
        const trades = [], sig = new Map()
        for (const g of usable) {
            const s = data.names.get(g.sym), date = s.ind.date, pl = g[arm.key]
            const key = `${g.sym}|${g.day}`
            sig.set(key, 0)
            if (!pl) continue
            const t = L.play(s.rows, g.i, pl, arm.o)
            if (!t || t.reason === 'open') continue
            const r = L.inR(t, pl.S, costFor(s.ind.adv20[g.i]), pl.E)
            sig.set(key, r)
            trades.push({ r, win: t.reason === 'target', stop: t.reason === 'stop', time: t.reason === 'time', days: t.k - t.m, month: date[g.i].slice(0, 7), held: g.day >= HELD_OUT })
        }
        perSignal[name] = sig
        for (const [lab, xs, of] of [['before', trades.filter(t => !t.held), usable.filter(g => g.day < HELD_OUT).length], ['held out', trades.filter(t => t.held), usable.filter(g => g.day >= HELD_OUT).length]]) {
            const v = L.summarize(xs)
            if (!v.n) { say(`${name} · ${lab}: none`); continue }
            const rs = xs.reduce((a, t) => a + t.r, 0) / of
            say(`${(name + ' · ' + lab).padEnd(44)} ${String(v.n).padStart(5)} (${(v.n / of * 100).toFixed(0).padStart(2)}% filled)  target ${(v.hit * 100).toFixed(0)}%  stop ${(xs.filter(t => t.stop).length / v.n * 100).toFixed(0)}%  time ${(xs.filter(t => t.time).length / v.n * 100).toFixed(0)}%  mean ${f(v.meanR)}R (${f(v.lo)} … ${f(v.hi)})  ${v.days}d  per signal ${f(rs, 3)}R`)
        }
    }
    say()
    say('THE BAR — R per signal, A2 − A1, month bootstrap:')
    const a1 = perSignal['A1 daily, wait 5, hold 10'], a2 = perSignal['A2 4-hour, wait 5, hold 10']
    const diffs = usable.map(g => { const k = `${g.sym}|${g.day}`; return { d: a2.get(k) - a1.get(k), month: g.day.slice(0, 7), held: g.day >= HELD_OUT } })
    pairLine('before', diffs.filter(x => !x.held))
    pairLine('held out', diffs.filter(x => x.held))
}

async function partB() {
    const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
    const days = data.spyDays.filter(d => d > data.spyDays[260]).slice(3)
    const HELD_OUT = data.calendarFrom
    const all = runHypothesis(HYPOTHESES.runup_5, data, { days })
    let live = []
    for (const t of all) {
        const s = data.names.get(t.symbol)
        const at = s._at ??= new Map(s.ind.date.map((d, k) => [d, k]))
        const i = at.get(t.day), j = at.get(t.exit_day)
        if (i == null || j == null || i < 1) continue
        if (t.tag !== '3 of 3 beat' || !(data.regimes?.get(s.ind.date[i - 1]) ?? '').startsWith('SPY over')) continue
        live.push({ ...t, sym: t.symbol, i, j, known: s.ind.date[i - 1], from: s.ind.date[Math.max(0, i - 1 - BACK)] })
    }
    console.log(`${all.length} run-up entries, ${live.length} on the live rule`)
    live = sampled(live)
    if (args.includes('--count')) return console.log(`sample ${live.length} → up to ${live.length} reads`)
    const cache = await fetchBars(live)

    const usable = []
    for (const t of live) {
        const s = data.names.get(t.sym)
        const atrs = s._atr ??= L.atr(s.rows), piv = s._piv ??= L.swings(s.rows, atrs, O.k)
        const close = s.rows[t.i - 1].close, a = atrs[t.i - 1]
        const low = piv.filter(p => p.type === 'L' && p.at <= t.i - 1).at(-1)
        const st = stopFrom(cache, t.sym, t.known, close)
        if (!low || !(low.price < close) || a == null || !st) continue
        usable.push({ ...t, s, a, S1: low.price - O.buffer * a, S4: st.stop, cost: costFor(s.ind.adv20[t.i - 1] ?? 0) })
    }
    const sorted = usable.map(u => u.day).sort()
    say(`Thesis test 3, part B — the live run-up rule ${live.length} trades, with both stops ${usable.length} · ${sorted[0]} → ${sorted.at(-1)} · held out from ${HELD_OUT}`)

    const play = (t, S) => {
        const r = L.runupExit(t.s.rows, t.i, t.j, S)
        const s0 = data.spyByDay.get(t.day), s1 = data.spyByDay.get(t.s.ind.date[r.k])
        const pct = (r.exit / r.entry - 1) * 100, spy = s0?.open > 0 && s1?.close > 0 ? (s1.close / s0.open - 1) * 100 : 0
        const risk = S != null && r.entry > S ? (r.entry - S) / r.entry * 100 : null
        return { net: pct - spy - t.cost, pct, risk, r: risk ? (pct - t.cost) / risk : null, stopped: r.reason === 'stop', atrs: S != null ? (r.entry - S) / t.a : null,
            reached: S != null && r.entry > S ? r.reach >= r.entry + 1.5 * (r.entry - S) : null, month: t.day.slice(0, 7), held: t.day >= HELD_OUT, days: r.k - t.i + 1 }
    }
    const arms = { 'B0 no stop': t => play(t, null), 'B1 daily stop': t => play(t, t.S1), 'B2 4-hour stop': t => play(t, t.S4) }
    const res = {}
    for (const [name, fn] of Object.entries(arms)) {
        res[name] = usable.map(fn)
        for (const [lab, xs] of [['before', res[name].filter(x => !x.held)], ['held out', res[name].filter(x => x.held)]]) {
            const n = xs.length
            if (!n) { say(`${name} · ${lab}: none`); continue }
            const rs = xs.map(x => x.r).filter(x => x != null), ds = xs.map(x => x.atrs).filter(x => x != null), rk = xs.map(x => x.reached).filter(x => x != null)
            const v = L.summarize(xs.map(x => ({ r: x.net, win: false, days: x.days, month: x.month })))
            say(`${(name + ' · ' + lab).padEnd(26)} ${String(n).padStart(5)}  net/trade ${f(v.meanR)}% (${f(v.lo)} … ${f(v.hi)})  stopped ${(xs.filter(x => x.stopped).length / n * 100).toFixed(0).padStart(2)}%  ${rs.length ? `mean ${f(mean(rs))}R  risk ${median(xs.map(x => x.risk).filter(x => x != null)).toFixed(1)}%  ${median(ds).toFixed(2)} ATR  reached 1.5R ${(rk.filter(Boolean).length / rk.length * 100).toFixed(0)}%` : ''}`)
        }
    }
    say()
    // The rule's own weighting (screener-lab: a fixed daily budget split across the day's names): each entry session counted once.
    const bySession = (xs) => {
        const days = new Map()
        for (const x of xs) { if (!days.has(x.day)) days.set(x.day, []); days.get(x.day).push(x.net) }
        return [...days].map(([day, nets]) => ({ day, net: mean(nets), month: day.slice(0, 7), held: day >= HELD_OUT }))
    }
    const sessionLine = (label, xs) => { const v = L.summarize(xs.map(x => ({ r: x.net, win: false, days: 0, month: x.month }))); say(`  ${label.padEnd(34)} ${String(v.n).padStart(4)} sessions  net/session ${f(v.meanR)}% (${f(v.lo)} … ${f(v.hi)})`) }
    say('Each entry session counted once, net vs SPY:')
    const liveAll = bySession(live.map(t => ({ day: t.day, net: t.net })))
    sessionLine('all 4,639 (reproduces the lab) before', liveAll.filter(x => !x.held))
    sessionLine('all 4,639 (reproduces the lab) held', liveAll.filter(x => x.held))
    const dropped = bySession(live.filter(t => !usable.includes(t) && !usable.some(u => u.sym === t.sym && u.day === t.day)).map(t => ({ day: t.day, net: t.net })))
    sessionLine('left out (no stop possible) before', dropped.filter(x => !x.held))
    sessionLine('left out (no stop possible) held', dropped.filter(x => x.held))
    const sess = {}
    for (const name of Object.keys(arms)) {
        sess[name] = bySession(res[name].map((x, q) => ({ day: usable[q].day, net: x.net })))
        sessionLine(`${name} before`, sess[name].filter(x => !x.held))
        sessionLine(`${name} held out`, sess[name].filter(x => x.held))
    }
    for (const [label, a, b] of [['B2 − B1', 'B2 4-hour stop', 'B1 daily stop'], ['B1 − B0', 'B1 daily stop', 'B0 no stop'], ['B2 − B0', 'B2 4-hour stop', 'B0 no stop']]) {
        const xs = sess[a].map((x, q) => ({ d: x.net - sess[b][q].net, month: x.month, held: x.held }))
        say(`  by session, ${label}:`)
        pairLine('before', xs.filter(x => !x.held))
        pairLine('held out', xs.filter(x => x.held))
    }
    say()
    const pair = (a, b) => usable.map((_, q) => ({ d: res[a][q].net - res[b][q].net, month: res[a][q].month, held: res[a][q].held }))
    for (const [label, a, b] of [['THE BAR — net %, B2 − B1', 'B2 4-hour stop', 'B1 daily stop'], ['B1 − B0 (does a daily stop cost)', 'B1 daily stop', 'B0 no stop'], ['B2 − B0 (does a 4-hour stop cost)', 'B2 4-hour stop', 'B0 no stop']]) {
        say(label + ':')
        const xs = pair(a, b)
        pairLine('before', xs.filter(x => !x.held))
        pairLine('held out', xs.filter(x => x.held))
    }
}
