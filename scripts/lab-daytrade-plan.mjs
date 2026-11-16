#!/usr/bin/env node
// THE DAY TRADE AS MENTOR BUILDS IT — TEST 4b (Roy, 2026-11-14: "but how far from the stops were the entries?"). Declared in
// docs/design/stock-playbook.md §Test 4b before the run. Test 4's signals and bars (data/lab/daytrade-5m.jsonl — run
// scripts/lab-daytrade-stop.mjs --fetch first); per chart the stop, the target and a LIMIT entry at R:R 1.5, filled only if
// price comes down to it.
//
//   node --max-old-space-size=6000 scripts/lab-daytrade-plan.mjs [--rr 1.5]   → data/lab/daytrade-plan[-rrX].out.txt

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
const rrAt = process.argv.indexOf('--rr')
const O = L.DEFAULTS, RR = rrAt > 0 ? Number(process.argv[rrAt + 1]) : 1.5
const OUT_FILE = RR === 1.5 ? 'data/lab/daytrade-plan.out.txt' : `data/lab/daytrade-plan-rr${RR}.out.txt`
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
const bucketOf = (min, size) => (size === 60 ? Math.floor((min - OPEN_MIN) / 60) : Math.floor((min - OPEN_MIN) / size))
/** Completed bars of `size` minutes from 5-minute bars, up to (not past) `upTo` (an index into `fives`, inclusive). */
function aggregate(fives, upTo, size) {
    const outB = []
    let cur = null
    for (let q = 0; q <= upTo; q++) {
        const b = fives[q], k = `${b.day}|${bucketOf(b.min, size)}`
        if (!cur || cur.k !== k) { if (cur) outB.push(cur); cur = { k, open: b.open, high: b.high, low: b.low, close: b.close, end: b.min + 5, day: b.day } }
        else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.end = b.min + 5 }
    }
    // The last bucket counts only when it is complete at `upTo` (its end is the bucket's end, or the session's close).
    if (cur) {
        const bucketEnd = OPEN_MIN + (bucketOf(cur.end - 5, size) + 1) * size
        if (cur.end >= Math.min(bucketEnd, OPEN_MIN + SESSION)) outB.push(cur)
    }
    return outB
}


const { rangeTarget, STRUCTURE } = await import(new URL('services/swingStructure.service.js', ROOT))
const ARMS = { A: ['P5', 'P15', 'P60', 'PD'], B: ['P15', 'P60', 'PD'] }
const rows = []   // one per signal × arm
const signals = { mid: 0, eod: 0, tomorrow: 0 }

/** The plan on one chart's bars known at the checkpoint (test 3's `plan`, on that chart): { S, T, E } or null. */
function planOn(bars, price) {
    const st = L.intradayStop(bars, price, O)
    if (!st) return null
    const t = rangeTarget(bars, bars.length - 1, st.base, STRUCTURE.lookFall)
    const S = st.stop, T = t.target
    if (!(T > 0)) return null
    const E = (T + RR * S) / (1 + RR)
    if (!(E > S) || !(T > E)) return null
    if ((E - S) / E * 100 > O.maxRiskPct) return null
    return { S, T, E }
}

/**
 * Mentor's day trade: in at the checkpoint when price is at or under E, else a limit at E (filled at the bar's open when it
 * opens under E). A long's stop is under E, so price reaches E before S: a fill bar that also reaches S is filled AND
 * stopped (the cautious reading). Then S, T or the close; a gap through a level fills at the open; a bar touching both →
 * the stop; the fill bar's own high never counts for T. → { entry, exit, why } or null (never filled).
 */
function trade(fives, e, toIdx, price, { S, T, E }) {
    let q = e + 1, entry = null
    if (price <= E) entry = price
    else {
        for (; q <= toIdx; q++) {
            const b = fives[q]
            if (b.low <= E) {
                entry = Math.min(E, b.open)
                if (b.low <= S) return { entry, exit: Math.min(S, b.open), why: 'stop' }
                q++
                break
            }
        }
        if (entry == null) return null
    }
    for (; q <= toIdx; q++) {
        const b = fives[q]
        if (b.open <= S) return { entry, exit: b.open, why: 'stop' }
        if (b.open >= T) return { entry, exit: b.open, why: 'target' }
        if (b.low <= S) return { entry, exit: S, why: 'stop' }
        if (b.high >= T) return { entry, exit: T, why: 'target' }
    }
    return { entry, exit: fives[toIdx].close, why: 'close' }
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
            for (const ck of CHECKS) {
                const upto = todayIdx.filter(q => fives[q].min + 5 <= ck.at)
                if (!upto.length) continue
                const e = upto.at(-1)
                const hi = Math.max(...upto.map(q => fives[q].high)), lo = Math.min(...upto.map(q => fives[q].low))
                const price = fives[e].close
                const cum = upto.reduce((a, q) => a + fives[q].volume, 0)
                const c = { price, prev: p.close, open: fives[todayIdx[0]].open, pos: hi > lo ? (price - lo) / (hi - lo) : null, rvol: vol20 > 0 ? cum * scale / (vol20 * (ck.at - OPEN_MIN) / SESSION) : 0 }
                if (!ck.rule(c)) continue
                let toIdx = todayIdx.at(-1)
                if (ck.part === 'B') {
                    const next = days[di + 1]
                    if (!next) continue
                    toIdx = fives.map((b, q) => (b.day === next ? q : -1)).filter(q => q >= 0).at(-1)
                }
                signals[ck.id]++
                const charts = { P5: fives.slice(0, e + 1), P15: aggregate(fives, e, 15), P60: aggregate(fives, e, 60), PD: D.rows.slice(0, i) }
                const base = { part: ck.part, check: ck.id, key: `${sym}|${day}|${ck.id}`, month: day.slice(0, 7), held: day >= HELD_OUT }
                for (const arm of ARMS[ck.part]) {
                    const pl = planOn(charts[arm], price)
                    if (!pl) { rows.push({ ...base, arm, planned: false, filled: false, R: 0 }); continue }
                    const x = trade(fives, e, toIdx, price, pl)
                    const risk = pl.E - pl.S
                    const info = { riskPct: risk / pl.E * 100, riskAtr: risk / atrD, tOverE: (pl.T / pl.E - 1) * 100, gapPct: (price / pl.E - 1) * 100 }
                    if (!x) { rows.push({ ...base, ...info, arm, planned: true, filled: false, R: 0 }); continue }
                    const r = x.entry - pl.S, costR = cost / 100 * x.entry / r
                    rows.push({ ...base, ...info, arm, planned: true, filled: true, R: (x.exit - x.entry) / r - costR, why: x.why, net: (x.exit / x.entry - 1) * 100 - cost })
                }
            }
        }
    }
}
await analyse()

const paired = (xs) => L.summarize(xs.map(({ d, month }) => ({ r: d, win: false, days: 0, month })))
const one = (xs) => L.summarize(xs.map(t => ({ r: t.R, win: false, days: 0, month: t.month })))
function report(part, checks, label) {
    say(`\n## Part ${part} — ${label}`)
    for (const [tag, isHeld] of [['before', false], ['held out', true]]) {
        const of = (arm) => rows.filter(t => t.part === part && checks.includes(t.check) && t.held === isHeld && t.arm === arm)
        const n = of('PD').length
        say(`\n${tag} (${n} signals)`)
        say('  chart  planned  filled  R/signal (5–95%)               R/trade  net%/trade  target/stop/close  risk %  in ATR  T over E  price over E')
        for (const arm of ARMS[part]) {
            const xs = of(arm), pl = xs.filter(t => t.planned), fl = xs.filter(t => t.filled), s = one(xs)
            const share = (w) => pct(fl.length ? fl.filter(t => t.why === w).length / fl.length : null)
            say(`  ${arm.padEnd(5)} ${pct(pl.length / xs.length).padStart(7)} ${pct(fl.length / xs.length).padStart(7)}  ${f(s.meanR, 3)} (${f(s.lo, 3)} … ${f(s.hi, 3)})`.padEnd(60) +
                `${f(mean(fl.map(t => t.R)), 3).padStart(8)}  ${f(mean(fl.map(t => t.net)), 3).padStart(9)}   ${share('target')}/${share('stop')}/${share('close')}`.padEnd(38) +
                `${f(median(pl.map(t => t.riskPct)), 2).padStart(6)}  ${f(median(pl.map(t => t.riskAtr)), 2).padStart(6)}  ${f(median(pl.map(t => t.tOverE)), 2).padStart(7)}  ${f(median(pl.map(t => t.gapPct)), 2).padStart(8)}`)
        }
        say('  paired vs PD (the daily), R per signal:')
        const dm = new Map(of('PD').map(t => [t.key, t]))
        for (const arm of ARMS[part].filter(a => a !== 'PD')) {
            const s = paired(of(arm).filter(t => dm.has(t.key)).map(t => ({ d: t.R - dm.get(t.key).R, month: t.month })))
            say(`    ${arm.padEnd(5)} − PD  n ${String(s.n ?? 0).padStart(5)}  diff ${f(s.meanR, 3)} (${f(s.lo, 3)} … ${f(s.hi, 3)})`)
        }
    }
}
say(`# Test 4b — the day trade as Mentor builds it, R:R ${RR} (${new Date().toISOString().slice(0, 10)}): the name-weeks test 4 fetched, held out from ${HELD_OUT}`)
say(`signals: 10:30 ${signals.mid}, 14:30 ${signals.eod}, 15:30 (day) ${signals.tomorrow}`)
report('A', ['mid', 'eod'], 'intraday, both checkpoints')
report('A', ['mid'], 'intraday, 10:30 only')
report('A', ['eod'], 'intraday, 14:30 only')
report('B', ['tomorrow'], 'day trade (15:30, held to the next close)')
fs.writeFileSync(OUT_FILE, out.join('\n') + '\n')
console.log(`→ ${OUT_FILE}`)
process.exit(0)
