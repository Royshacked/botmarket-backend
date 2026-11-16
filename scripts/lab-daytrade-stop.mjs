#!/usr/bin/env node
// THE DAY TRADE'S STOP — TEST 4 (Roy, 2026-11-14: "under which timeframe should we look for levels in intraday / day
// trade?"). Declared in docs/design/stock-playbook.md §Test 4 before the run. The day board's live in-play rules replayed on
// FMP 5-minute bars; the same trades stopped off the 5-minute, 15-minute, 1-hour and daily swing lows and the day's low.
//
//   node --max-old-space-size=6000 scripts/lab-daytrade-stop.mjs [--fetch] [--count] [--weeks N]
//     --count   the candidates and the sample, nothing fetched
//     --fetch   fetch the sample's 5-minute bars (data/lab/daytrade-5m.jsonl, resumable), then the table
//   → data/lab/daytrade-stop.out.txt

import dns from 'dns'
import fs from 'fs'
import readline from 'readline'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const ROOT = new URL('../', import.meta.url)
const L = await import(new URL('services/thesisLab.service.js', ROOT))
const { loadLabData } = await import(new URL('services/screenerLab.data.js', ROOT))
const { costFor } = await import(new URL('services/screenerLab.service.js', ROOT))
const { getFmpCandles } = await import(new URL('providers/fmp.price.provider.js', ROOT))

const args = process.argv.slice(2)
const weeksAt = args.indexOf('--weeks'), WEEKS = weeksAt >= 0 ? Number(args[weeksAt + 1]) : 8000
const FROM = '2024-11-01', HELD_OUT = '2026-03-01', CACHE = 'data/lab/daytrade-5m.jsonl', PARALLEL = 8
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
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

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
if (args.includes('--count')) process.exit(0)

// ─── The 5-minute bars: the week and the week before, `[t, o, h, l, c, v]` ───
async function fetchAll() {
    const have = new Set()
    if (fs.existsSync(CACHE)) for (const line of fs.readFileSync(CACHE, 'utf8').split('\n')) if (line) have.add(line.slice(8, line.indexOf('"', 8)))
    const todo = sample.filter(k => !have.has(k))
    console.log(`fetching ${todo.length} name-weeks (${have.size} cached)`)
    const sink = fs.createWriteStream(CACHE, { flags: 'a' })
    let done = 0, failed = 0
    const get = async (sym, from, to) => {
        for (let a = 0; a < 4; a++) {
            try { return await getFmpCandles(sym, { timeSpan: 'minute', multiplier: 5, from: Date.parse(from), to: Date.parse(to) }) } catch (err) {
                if (err?.status === 429) { await new Promise(res => setTimeout(res, 65_000)); continue }
                if (a === 3) throw err
            }
        }
        return []
    }
    const one = async (key) => {
        const [sym, mon] = key.split('|')
        try {
            const [prev, cur] = await Promise.all([get(sym, addDays(mon, -7), addDays(mon, -1)), get(sym, mon, addDays(mon, 5))])
            const bars = [...(prev ?? []), ...(cur ?? [])].map(b => [b.timestamp, b.open, b.high, b.low, b.close, b.volume ?? 0])
            const seen = new Set()
            const uniq = bars.filter(b => !seen.has(b[0]) && seen.add(b[0])).sort((a, b) => a[0] - b[0])
            sink.write(JSON.stringify({ key, bars: uniq }) + '\n')
        } catch { failed++; sink.write(JSON.stringify({ key, bars: [] }) + '\n') }
    }
    for (let q = 0; q < todo.length; q += PARALLEL) {
        await Promise.all(todo.slice(q, q + PARALLEL).map(one))
        done += Math.min(PARALLEL, todo.length - q)
        if (done % 400 < PARALLEL || done === todo.length) console.log(`  ${done}/${todo.length} (${failed} failed)`)
    }
    await new Promise(res => sink.end(res))
}
if (args.includes('--fetch')) await fetchAll()

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

/** One trade from bar `from` on, through `bars` (indexes into `fives`), stop S (or null), target T (or null). */
function play(fives, from, toIdx, entry, S, T) {
    let reach = entry
    for (let q = from; q <= toIdx; q++) {
        const b = fives[q]
        if (S != null && b.open <= S) return { exit: b.open, why: 'stop', reach }
        if (T != null && b.open >= T) return { exit: b.open, why: 'target', reach: Math.max(reach, b.high) }
        if (S != null && b.low <= S) return { exit: S, why: 'stop', reach }
        if (T != null && b.high >= T) return { exit: T, why: 'target', reach: Math.max(reach, b.high) }
        reach = Math.max(reach, b.high)
    }
    return { exit: fives[toIdx].close, why: 'close', reach }
}

const ARMS = { A: ['S5', 'S15', 'S60', 'SD', 'LOD'], B: ['S15', 'S60', 'SD'] }
const trades = []   // { part, check, sym, day, month, held, arm, R1, R2, net1, stopped, reached, distPct, distAtr }
const signals = { mid: 0, eod: 0, tomorrow: 0 }
const volRatio = []

async function analyse() {
    if (!fs.existsSync(CACHE)) { console.log('no bars cached — run with --fetch'); return }
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
            if (todayIdx.length < 60) continue   // a short or broken session
            const sum5 = todayIdx.reduce((a, q) => a + fives[q].volume, 0)
            if (D.rows[i].volume > 0) volRatio.push(sum5 / D.rows[i].volume)
            // The 5-minute bars carry ~83% of the day's consolidated volume; the live rule reads the quote's. Scaled by the
            // name's PREVIOUS session's ratio (nothing ahead), else the median.
            const pd = days[di - 1], pi = pd ? D.idx.get(pd) : null
            const prevSum = pd ? fives.reduce((a, b) => a + (b.day === pd ? b.volume : 0), 0) : 0
            const scale = pi != null && D.rows[pi].volume > 0 && prevSum > 0 ? D.rows[pi].volume / prevSum : 1 / 0.83
            const vol20 = D.vol20[i], atrD = D.atr14[i - 1], cost = costFor(D.adv20[i - 1])
            const lastToday = todayIdx.at(-1)
            for (const ck of CHECKS) {
                const upto = todayIdx.filter(q => fives[q].min + 5 <= ck.at)
                if (!upto.length) continue
                const e = upto.at(-1)
                const hi = Math.max(...upto.map(q => fives[q].high)), lo = Math.min(...upto.map(q => fives[q].low))
                const price = fives[e].close
                const cum = upto.reduce((a, q) => a + fives[q].volume, 0)
                const c = { price, prev: p.close, open: fives[todayIdx[0]].open, pos: hi > lo ? (price - lo) / (hi - lo) : null, rvol: vol20 > 0 ? cum * scale / (vol20 * (ck.at - OPEN_MIN) / SESSION) : 0 }
                if (!ck.rule(c)) continue
                // Part B holds to the NEXT session's close; Friday (no next session fetched) is left out.
                let toIdx = lastToday
                if (ck.part === 'B') {
                    const next = days[di + 1]
                    if (!next) continue
                    toIdx = fives.map((b, q) => (b.day === next ? q : -1)).filter(q => q >= 0).at(-1)
                }
                signals[ck.id]++
                const five = fives.slice(0, e + 1)
                const a5 = L.atr(five).at(-1)
                const stops = {
                    S5:  L.intradayStop(five, price, O)?.stop,
                    S15: L.intradayStop(aggregate(fives, e, 15), price, O)?.stop,
                    S60: L.intradayStop(aggregate(fives, e, 60), price, O)?.stop,
                    SD:  L.intradayStop(D.rows.slice(0, i), price, O)?.stop,
                    LOD: a5 != null ? lo - O.buffer * a5 : null,
                }
                const held = day >= HELD_OUT, month = day.slice(0, 7)
                const base = { part: ck.part, check: ck.id, sym, day, month, held }
                const none = play(fives, e + 1, toIdx, price, null, null)
                trades.push({ ...base, arm: 'NONE', R1: null, R2: null, net1: (none.exit / price - 1) * 100 - cost })
                for (const arm of ARMS[ck.part]) {
                    const S = stops[arm]
                    if (!(S > 0 && S < price)) continue
                    const risk = price - S, costR = cost / 100 * price / risk
                    const x1 = play(fives, e + 1, toIdx, price, S, null)
                    const x2 = play(fives, e + 1, toIdx, price, S, price + RR * risk)
                    trades.push({ ...base, arm,
                        R1: (x1.exit - price) / risk - costR, R2: (x2.exit - price) / risk - costR,
                        net1: (x1.exit / price - 1) * 100 - cost,
                        stopped: x1.why === 'stop', reached: x1.reach >= price + RR * risk, target2: x2.why === 'target',
                        distPct: risk / price * 100, distAtr: risk / atrD })
                }
            }
        }
    }
}
await analyse()

// ─── The table ───
const paired = (xs) => L.summarize(xs.map(({ d, month }) => ({ r: d, win: false, days: 0, month })))
function report(part, checks, label) {
    const arms = ['NONE', ...ARMS[part]]
    say(`\n## Part ${part} — ${label}`)
    for (const [tag, isHeld] of [['before', false], ['held out', true]]) {
        const sig = trades.filter(t => t.part === part && checks.includes(t.check) && t.held === isHeld && t.arm === 'NONE').length
        say(`\n${tag} (${sig} signals)`)
        say(`  arm   trades  R plan(ii)  R stop/close(i)  net%(i)  stopped  reach1.5R  hit target(ii)  stop dist %  in daily ATR`)
        for (const arm of arms) {
            const xs = trades.filter(t => t.part === part && checks.includes(t.check) && t.held === isHeld && t.arm === arm)
            if (!xs.length) { say(`  ${arm.padEnd(5)} —`); continue }
            const R2 = arm === 'NONE' ? null : mean(xs.map(t => t.R2)), R1 = arm === 'NONE' ? null : mean(xs.map(t => t.R1))
            say(`  ${arm.padEnd(5)} ${String(xs.length).padStart(6)} (${pct(xs.length / sig)})  ${f(R2, 3).padStart(8)}  ${f(R1, 3).padStart(10)}  ${f(mean(xs.map(t => t.net1)), 3).padStart(9)}  ` +
                `${arm === 'NONE' ? '   —' : pct(mean(xs.map(t => (t.stopped ? 1 : 0)))).padStart(5)}  ${arm === 'NONE' ? '     —' : pct(mean(xs.map(t => (t.reached ? 1 : 0)))).padStart(8)}  ` +
                `${arm === 'NONE' ? '      —' : pct(mean(xs.map(t => (t.target2 ? 1 : 0)))).padStart(10)}  ${arm === 'NONE' ? '     —' : f(median(xs.map(t => t.distPct)), 2).padStart(9)}  ${arm === 'NONE' ? '' : f(median(xs.map(t => t.distAtr)), 2)}`)
        }
        say(`  paired vs SD, R plan(ii):`)
        for (const arm of ARMS[part].filter(a => a !== 'SD')) {
            const byKey = (a) => new Map(trades.filter(t => t.part === part && checks.includes(t.check) && t.held === isHeld && t.arm === a).map(t => [`${t.sym}|${t.day}|${t.check}`, t]))
            const A = byKey(arm), Dm = byKey('SD')
            const ds = [...A].filter(([k]) => Dm.has(k)).map(([k, t]) => ({ d: t.R2 - Dm.get(k).R2, month: t.month }))
            const s = paired(ds)
            say(`    ${arm.padEnd(5)} − SD  n ${String(s.n ?? 0).padStart(5)}  diff ${f(s.meanR, 3)} (${f(s.lo, 3)} … ${f(s.hi, 3)})`)
        }
        say(`  paired vs NONE, net% (i) — does a stop cost the trade:`)
        for (const arm of ARMS[part]) {
            const byKey = (a) => new Map(trades.filter(t => t.part === part && checks.includes(t.check) && t.held === isHeld && t.arm === a).map(t => [`${t.sym}|${t.day}|${t.check}`, t]))
            const A = byKey(arm), N = byKey('NONE')
            const ds = [...A].filter(([k]) => N.has(k)).map(([k, t]) => ({ d: t.net1 - N.get(k).net1, month: t.month }))
            const s = paired(ds)
            say(`    ${arm.padEnd(5)} − NONE  n ${String(s.n ?? 0).padStart(5)}  diff ${f(s.meanR, 3)}% (${f(s.lo, 3)} … ${f(s.hi, 3)})`)
        }
    }
}
say(`# Test 4 — the day trade's stop (${new Date().toISOString().slice(0, 10)}): ${sample.length} name-weeks sampled, held out from ${HELD_OUT}`)
say(`signals: 10:30 ${signals.mid}, 14:30 ${signals.eod}, 15:30 (day) ${signals.tomorrow}`)
say(`5-minute volume / daily volume, median ${f(median(volRatio), 3)} (the paced relative volume is read on the 5-minute bars)`)
report('A', ['mid', 'eod'], 'intraday, both checkpoints')
report('A', ['mid'], 'intraday, 10:30 only')
report('A', ['eod'], 'intraday, 14:30 only')
report('B', ['tomorrow'], 'day trade (15:30, held to the next close)')
fs.writeFileSync('data/lab/daytrade-stop.out.txt', out.join('\n') + '\n')
console.log('→ data/lab/daytrade-stop.out.txt')
process.exit(0)
