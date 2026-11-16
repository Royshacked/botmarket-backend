#!/usr/bin/env node
// A VWAP ENTRY ON THE DAY BOARD'S NAMES — TEST 4c (Roy, 2026-11-14: "test a VWAP entry first"). Declared in
// docs/design/stock-playbook.md §Test 4c before the run. Test 4's signals and bars (data/lab/daytrade-5m.jsonl — run
// scripts/lab-daytrade-stop.mjs --fetch first): after the checkpoint, the first 5-minute bar that trades to VWAP and closes
// back over it; the stop under the pullback's low; against VWAP shifted ± 0.25 daily ATR (is it VWAP, or any dip?).
//
//   node --max-old-space-size=6000 scripts/lab-daytrade-vwap.mjs   → data/lab/daytrade-vwap.out.txt

import dns from 'dns'
import fs from 'fs'
import readline from 'readline'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const ROOT = new URL('../', import.meta.url)
const L = await import(new URL('services/thesisLab.service.js', ROOT))
const { loadLabData } = await import(new URL('services/screenerLab.data.js', ROOT))
const { costFor } = await import(new URL('services/screenerLab.service.js', ROOT))

const args = process.argv.slice(2)
const weeksAt = args.indexOf('--weeks'), WEEKS = weeksAt >= 0 ? Number(args[weeksAt + 1]) : 8000
const FROM = '2024-11-01', HELD_OUT = '2026-03-01', CACHE = 'data/lab/daytrade-5m.jsonl'
const GATE = { price: 5, adv: 50e6, atrPct: 3 }
const O = L.DEFAULTS
const OPEN_MIN = 9 * 60 + 30, SESSION = 390
const CHECKS = [
    { id: 'mid', part: 'A', at: 10 * 60 + 30, rule: (c) => c.rvol >= 1.5 && c.price > c.open && c.price > c.prev },
    { id: 'eod', part: 'A', at: 14 * 60 + 30, rule: (c) => c.rvol >= 1.3 && c.pos >= 0.75 && c.price > c.prev },
    { id: 'tomorrow', part: 'B', at: 15 * 60 + 30, rule: (c) => c.rvol >= 1.2 && c.pos >= 0.85 && c.price > c.prev },
]
const out = []
const say = (line = '') => { console.log(line); out.push(line) }
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d))
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }

// ─── ET time, cached per UTC day (DST-aware) ───
const _off = new Map()
const etOf = (sec) => {
    const ms = sec * 1000, key = new Date(ms).toISOString().slice(0, 10)
    if (!_off.has(key)) {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            .formatToParts(new Date(Date.parse(`${key}T16:00:00Z`))).map(x => [x.type, x.value]))
        _off.set(key, 16 * 60 - (Number(p.hour) * 60 + Number(p.minute)))   // minutes ET is behind UTC
    }
    const et = new Date(ms - _off.get(key) * 60_000)
    return { day: et.toISOString().slice(0, 10), min: et.getUTCHours() * 60 + et.getUTCMinutes() }
}
const mondayOf = (d) => { const t = new Date(`${d}T12:00:00Z`); return new Date(t - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10) }

// ─── The daily data: the gates on the prior close, the candidate days ───
const data = await loadLabData({ name: 'screener', years: 3 })
const daily = new Map()   // sym → { rows, date, idx: Map(day → i), atr14pct[], vol20[], adv20[] }
const candidates = []      // { sym, day, week }
for (const [sym, s] of data.names) {
    const r = s.rows, d = s.ind.date
    const tr = r.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - r[i - 1].close), Math.abs(b.low - r[i - 1].close)) : b.high - b.low))
    const atr14 = r.map((_, i) => (i >= 14 ? mean(tr.slice(i - 13, i + 1)) : null))
    const vol20 = r.map((_, i) => (i >= 20 ? mean(r.slice(i - 20, i).map(b => b.volume || 0)) : null))   // the 20 sessions BEFORE i
    const idx = new Map(d.map((x, i) => [x, i]))
    daily.set(sym, { rows: r, date: d, idx, atr14, vol20, adv20: s.ind.adv20 })
    for (let i = 22; i < r.length; i++) {
        if (d[i] < FROM) continue
        const p = r[i - 1], b = r[i]
        if (!(p.close >= GATE.price && s.ind.adv20[i - 1] >= GATE.adv && atr14[i - 1] / p.close * 100 >= GATE.atrPct)) continue
        // Necessary for some rule (so no signal is lost): the paced volume share, a high over the prior close.
        const v = vol20[i]
        if (!(b.high > p.close && b.volume >= 0.23 * v)) continue
        candidates.push({ sym, day: d[i], week: mondayOf(d[i]) })
    }
}
const weekKeys = [...new Set(candidates.map(c => `${c.sym}|${c.week}`))].sort()
const rand = L.rng(11)
const sample = weekKeys.map(k => [rand(), k]).sort((a, b) => a[0] - b[0]).slice(0, WEEKS).map(([, k]) => k)
console.log(`${candidates.length} candidate days in ${weekKeys.length} name-weeks; sample ${sample.length}`)


// ─── The bars → sessions, and the slower charts built from them ───

const LINES = { V: 0, 'V+': 0.25, 'V-': -0.25 }   // VWAP, and VWAP shifted by ± this many daily ATRs (the control)
const EXITS = { a: 1.5, b: 1, c: null }           // the target in R; null = the stop or the close
const LAST_ENTRY = 15 * 60 + 30
const rows = []
const signals = { mid: 0, eod: 0 }

/** Session VWAP at each bar's close: Σ(typical × volume) / Σ volume from the open. */
function vwapOf(fives, idx) {
    const out = new Map()
    let pv = 0, v = 0
    for (const q of idx) {
        const b = fives[q]
        pv += (b.high + b.low + b.close) / 3 * b.volume; v += b.volume
        out.set(q, v > 0 ? pv / v : b.close)
    }
    return out
}

/** From the entry bar's close: the stop, a target `rr` R over the entry (null = none) or the close. */
function exitFrom(fives, from, toIdx, entry, S, rr) {
    const T = rr == null ? null : entry + rr * (entry - S)
    for (let q = from; q <= toIdx; q++) {
        const b = fives[q]
        if (b.open <= S) return { exit: b.open, why: 'stop' }
        if (T != null && b.open >= T) return { exit: b.open, why: 'target' }
        if (b.low <= S) return { exit: S, why: 'stop' }
        if (T != null && b.high >= T) return { exit: T, why: 'target' }
    }
    return { exit: fives[toIdx].close, why: 'close' }
}

async function analyse() {
    const rl = readline.createInterface({ input: fs.createReadStream(CACHE), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line) continue
        const { key, bars } = JSON.parse(line)
        if (!bars?.length) continue
        const [sym, mon] = key.split('|')
        const D = daily.get(sym)
        if (!D) continue
        const fives = bars.map(([t, o, h, l, c, v]) => ({ ...etOf(t), open: o, high: h, low: l, close: c, volume: v }))
            .filter(b => b.min >= OPEN_MIN && b.min < OPEN_MIN + SESSION)
        const days = [...new Set(fives.map(b => b.day))]
        for (let di = 0; di < days.length; di++) {
            const day = days[di]
            if (day < mon) continue
            const i = D.idx.get(day)
            if (i == null || i < 22) continue
            const p = D.rows[i - 1]
            if (!(p.close >= GATE.price && D.adv20[i - 1] >= GATE.adv && D.atr14[i - 1] / p.close * 100 >= GATE.atrPct)) continue
            const todayIdx = fives.map((b, q) => (b.day === day ? q : -1)).filter(q => q >= 0)
            if (todayIdx.length < 60) continue
            const pd = days[di - 1], pi = pd ? D.idx.get(pd) : null
            const prevSum = pd ? fives.reduce((a, b) => a + (b.day === pd ? b.volume : 0), 0) : 0
            const scale = pi != null && D.rows[pi].volume > 0 && prevSum > 0 ? D.rows[pi].volume / prevSum : 1 / 0.83
            const vol20 = D.vol20[i], atrD = D.atr14[i - 1], cost = costFor(D.adv20[i - 1])
            const vw = vwapOf(fives, todayIdx)
            const toIdx = todayIdx.at(-1)
            for (const ck of CHECKS.filter(c => c.part === 'A')) {
                const upto = todayIdx.filter(q => fives[q].min + 5 <= ck.at)
                if (!upto.length) continue
                const e = upto.at(-1)
                const hi = Math.max(...upto.map(q => fives[q].high)), lo = Math.min(...upto.map(q => fives[q].low))
                const price = fives[e].close
                const cum = upto.reduce((a, q) => a + fives[q].volume, 0)
                const c = { price, prev: p.close, open: fives[todayIdx[0]].open, pos: hi > lo ? (price - lo) / (hi - lo) : null, rvol: vol20 > 0 ? cum * scale / (vol20 * (ck.at - OPEN_MIN) / SESSION) : 0 }
                if (!ck.rule(c)) continue
                signals[ck.id]++
                const a5 = L.atr(fives.slice(0, e + 1)).at(-1)
                const base = { check: ck.id, key: `${sym}|${day}|${ck.id}`, month: day.slice(0, 7), held: day >= HELD_OUT }
                const after = todayIdx.filter(q => q > e && fives[q].min + 5 <= LAST_ENTRY)
                for (const [arm, shift] of Object.entries(LINES)) {
                    const line = (q) => vw.get(q) + shift * atrD
                    let low = Infinity, at = null
                    for (const q of after) {
                        low = Math.min(low, fives[q].low)
                        const L0 = line(q)
                        if (fives[q].low <= L0 && fives[q].close > L0) { at = q; break }
                    }
                    if (at == null || a5 == null) { for (const x of Object.keys(EXITS)) rows.push({ ...base, arm, exit: x, entered: false, R: 0 }); continue }
                    const entry = fives[at].close, S = low - O.buffer * a5
                    if (!(S < entry)) { for (const x of Object.keys(EXITS)) rows.push({ ...base, arm, exit: x, entered: false, R: 0 }); continue }
                    const risk = entry - S, costR = cost / 100 * entry / risk
                    for (const [x, rr] of Object.entries(EXITS)) {
                        const o = exitFrom(fives, at + 1, toIdx, entry, S, rr)
                        rows.push({ ...base, arm, exit: x, entered: true, R: (o.exit - entry) / risk - costR, why: o.why,
                            net: (o.exit / entry - 1) * 100 - cost, riskPct: risk / entry * 100, riskAtr: risk / atrD })
                    }
                }
            }
        }
    }
}
await analyse()

const one = (xs) => L.summarize(xs.map(t => ({ r: t.R, win: false, days: 0, month: t.month })))
const paired = (xs) => L.summarize(xs.map(({ d, month }) => ({ r: d, win: false, days: 0, month })))
function report(checks, label) {
    say(`\n## ${label}`)
    for (const [tag, isHeld] of [['before', false], ['held out', true]]) {
        const of = (arm, x) => rows.filter(t => checks.includes(t.check) && t.held === isHeld && t.arm === arm && t.exit === x)
        say(`\n${tag} (${of('V', 'a').length} signals)`)
        say('  line  exit  entered  R/signal (5–95%)               R/trade  net%/trade  target/stop/close  risk %  in ATR')
        for (const arm of Object.keys(LINES)) for (const x of Object.keys(EXITS)) {
            const xs = of(arm, x), en = xs.filter(t => t.entered), s = one(xs)
            const share = (w) => pct(en.length ? en.filter(t => t.why === w).length / en.length : null)
            say(`  ${arm.padEnd(4)}  ${x}(${EXITS[x] ?? '—'})  ${pct(en.length / xs.length).padStart(6)}  ${f(s.meanR, 3)} (${f(s.lo, 3)} … ${f(s.hi, 3)})`.padEnd(60) +
                `${f(mean(en.map(t => t.R)), 3).padStart(8)}  ${f(mean(en.map(t => t.net)), 3).padStart(9)}   ${share('target')}/${share('stop')}/${share('close')}`.padEnd(38) +
                `${f(median(en.map(t => t.riskPct)), 2).padStart(6)}  ${f(median(en.map(t => t.riskAtr)), 2).padStart(6)}`)
        }
        say('  VWAP − the shifted lines, R per signal, exit (a):')
        const v = new Map(of('V', 'a').map(t => [t.key, t]))
        for (const arm of ['V+', 'V-']) {
            const s = paired(of(arm, 'a').filter(t => v.has(t.key)).map(t => ({ d: v.get(t.key).R - t.R, month: t.month })))
            say(`    V − ${arm.padEnd(3)} n ${String(s.n ?? 0).padStart(5)}  diff ${f(s.meanR, 3)} (${f(s.lo, 3)} … ${f(s.hi, 3)})`)
        }
    }
}
say(`# Test 4c — a VWAP entry on the day board's names (${new Date().toISOString().slice(0, 10)}): the name-weeks test 4 fetched, held out from ${HELD_OUT}`)
say(`signals: 10:30 ${signals.mid}, 14:30 ${signals.eod}`)
report(['mid', 'eod'], 'both checkpoints')
report(['mid'], '10:30 only')
report(['eod'], '14:30 only')
fs.writeFileSync('data/lab/daytrade-vwap.out.txt', out.join('\n') + '\n')
console.log('→ data/lab/daytrade-vwap.out.txt')
process.exit(0)
