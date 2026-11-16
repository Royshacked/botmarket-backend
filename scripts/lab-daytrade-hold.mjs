#!/usr/bin/env node
// NOT CLOSING AT THE END OF THE DAY — TEST 4e (Roy, 2026-11-14: "did you check not closing at the end of the day?"). Declared
// in docs/design/stock-playbook.md §Test 4e before the run. Test 4's signals and bars (data/lab/daytrade-5m.jsonl — run
// scripts/lab-daytrade-stop.mjs --fetch first): in at the checkpoint (E1) or on Mentor's limit plan (E2), off the 5-minute /
// 15-minute / 1-hour / daily chart; held to the stop, the target, or the close of the Nth session (0, 5, 10, 20) — the entry
// day on its 5-minute bars, the sessions after on the daily bars.
//
//   node --max-old-space-size=6000 scripts/lab-daytrade-hold.mjs   → data/lab/daytrade-hold.out.txt

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
const O = L.DEFAULTS, RR = 1.5
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
const CHARTS = ['C5', 'C15', 'C60', 'CD']
const HOLDS = [0, 5, 10, 20]
const rows = []
const signals = { mid: 0, eod: 0 }

/** E2's plan on one chart (test 4b's `planOn`): { S, T, E } or null. */
function planOn(bars, price) {
    const st = L.intradayStop(bars, price, O)
    if (!st) return null
    const S = st.stop, T = rangeTarget(bars, bars.length - 1, st.base, STRUCTURE.lookFall).target
    if (!(T > 0)) return null
    const E = (T + RR * S) / (1 + RR)
    if (!(E > S) || !(T > E) || (E - S) / E * 100 > O.maxRiskPct) return null
    return { S, T, E }
}

/** The rest of the entry day on 5-minute bars, from bar `q`: → { exit, why } or null (still open at the close). */
function sameDay(fives, q, lastQ, S, T) {
    for (; q <= lastQ; q++) {
        const b = fives[q]
        if (b.open <= S) return { exit: b.open, why: 'stop' }
        if (b.open >= T) return { exit: b.open, why: 'target' }
        if (b.low <= S) return { exit: S, why: 'stop' }
        if (b.high >= T) return { exit: T, why: 'target' }
    }
    return null
}
/** The sessions after the entry day on daily bars, up to N: → { exit, why, days }. */
function later(rowsD, i, N, S, T, dayClose) {
    if (N === 0) return { exit: dayClose, why: 'time', days: 0 }
    for (let k = 1; k <= N; k++) {
        const b = rowsD[i + k]
        if (b.open <= S) return { exit: b.open, why: 'stop', days: k }
        if (b.open >= T) return { exit: b.open, why: 'target', days: k }
        if (b.low <= S) return { exit: S, why: 'stop', days: k }
        if (b.high >= T) return { exit: T, why: 'target', days: k }
    }
    return { exit: rowsD[i + N].close, why: 'time', days: N }
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
            const vol20 = D.vol20[i], cost = costFor(D.adv20[i - 1])
            const lastQ = todayIdx.at(-1), dayClose = fives[lastQ].close
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
                const charts = { C5: fives.slice(0, e + 1), C15: aggregate(fives, e, 15), C60: aggregate(fives, e, 60), CD: D.rows.slice(0, i) }
                const base = { check: ck.id, key: `${sym}|${day}|${ck.id}`, month: day.slice(0, 7), held: day >= HELD_OUT }
                for (const chart of CHARTS) {
                    // E1 — at the checkpoint, 1.5R target.
                    const st = L.intradayStop(charts[chart], price, O)
                    const e1 = st && st.stop < price ? { entry: price, from: e + 1, S: st.stop, T: price + RR * (price - st.stop) } : null
                    // E2 — the limit plan, filled on the signal day.
                    const pl = planOn(charts[chart], price)
                    let e2 = null
                    if (pl) {
                        if (price <= pl.E) e2 = { entry: price, from: e + 1, S: pl.S, T: pl.T }
                        else for (let q = e + 1; q <= lastQ; q++) {
                            const b = fives[q]
                            if (b.low <= pl.E) { const entry = Math.min(pl.E, b.open); e2 = b.low <= pl.S ? { entry, stoppedAt: Math.min(pl.S, b.open), S: pl.S, T: pl.T } : { entry, from: q + 1, S: pl.S, T: pl.T }; break }
                        }
                    }
                    for (const [entryKind, x] of [['E1', e1], ['E2', e2]]) {
                        for (const N of HOLDS) {
                            if (!D.rows[i + N]) continue   // not N sessions of daily bars after it — out of this hold, every arm alike
                            const arm = `${entryKind} ${chart}`, row = { ...base, arm, entryKind, chart, hold: N }
                            if (!x) { rows.push({ ...row, entered: false, R: 0 }); continue }
                            const risk = x.entry - x.S, costR = cost / 100 * x.entry / risk
                            const o = x.stoppedAt != null ? { exit: x.stoppedAt, why: 'stop', days: 0 }
                                : (() => { const s = sameDay(fives, x.from, lastQ, x.S, x.T); return s ? { ...s, days: 0 } : later(D.rows, i, N, x.S, x.T, dayClose) })()
                            rows.push({ ...row, entered: true, R: (o.exit - x.entry) / risk - costR, why: o.why, days: o.days })
                        }
                    }
                }
            }
        }
    }
}
await analyse()

const one = (xs) => L.summarize(xs.map(t => ({ r: t.R, win: false, days: 0, month: t.month })))
const paired = (xs) => L.summarize(xs.map(({ d, month }) => ({ r: d, win: false, days: 0, month })))
const passes = []
function report(checks, label) {
    say(`\n## ${label}`)
    for (const entryKind of ['E1', 'E2']) {
        say(`\n### ${entryKind === 'E1' ? 'E1 — in at the checkpoint, 1.5R target' : "E2 — Mentor's limit plan (rangeTarget, R:R 1.5 at E), filled on the signal day"}`)
        say('  chart  hold  before: entered  R/signal (5–95%)          target/stop/time  days | held out: R/signal (5–95%)          target/stop/time | vs daily before / held out')
        for (const N of HOLDS) for (const chart of CHARTS) {
            const of = (ch, isHeld) => rows.filter(t => checks.includes(t.check) && t.entryKind === entryKind && t.chart === ch && t.hold === N && t.held === isHeld)
            const cell = (isHeld) => {
                const xs = of(chart, isHeld), en = xs.filter(t => t.entered), s = one(xs)
                const share = (w) => pct(en.length ? en.filter(t => t.why === w).length / en.length : null)
                return { s, en, xs, text: `${f(s.meanR, 3)} (${f(s.lo, 3)} … ${f(s.hi, 3)})`, mix: `${share('target')}/${share('stop')}/${share('time')}` }
            }
            const vsD = (isHeld) => {
                if (chart === 'CD') return '—'
                const d = new Map(of('CD', isHeld).map(t => [t.key, t]))
                const s = paired(of(chart, isHeld).filter(t => d.has(t.key)).map(t => ({ d: t.R - d.get(t.key).R, month: t.month })))
                return `${f(s.meanR, 3)} (${f(s.lo, 3)}…${f(s.hi, 3)})`
            }
            const b = cell(false), h = cell(true)
            if (b.s.meanR > 0 && b.s.lo > 0 && h.s.meanR > 0) passes.push(`${label} · ${entryKind} ${chart} hold ${N}`)
            say(`  ${chart.padEnd(5)} ${String(N).padStart(4)}  ${pct(b.en.length / b.xs.length).padStart(6)}  ${b.text.padEnd(26)} ${b.mix.padEnd(16)} ${String(median(b.en.map(t => t.days)) ?? '—').padStart(4)} | ${h.text.padEnd(26)} ${h.mix.padEnd(16)} | ${vsD(false)} / ${vsD(true)}`)
        }
    }
}
say(`# Test 4e — not closing at the end of the day (${new Date().toISOString().slice(0, 10)}): the name-weeks test 4 fetched, held out from ${HELD_OUT}`)
say(`signals: 10:30 ${signals.mid}, 14:30 ${signals.eod}`)
report(['mid', 'eod'], 'both checkpoints')
report(['mid'], '10:30 only')
report(['eod'], '14:30 only')
say(`\nPASS (R/signal > 0 with 5% end > 0 before, > 0 held out): ${passes.length ? passes.join('; ') : 'none'}`)
fs.writeFileSync('data/lab/daytrade-hold.out.txt', out.join('\n') + '\n')
console.log('→ data/lab/daytrade-hold.out.txt')
process.exit(0)
