// THE OPEN VARIANTS — test AB (declared in screener-lab.md §51, before the run). Roy, 2026-11-08: "let's continue with
// all variants." One heavy load per process, run one after the other:
//
//   node --max-old-space-size=6000 scripts/lab-ab.mjs --part=cache   1: the run-up's quiet days on §6's cache
//   node --max-old-space-size=6000 scripts/lab-ab.mjs --part=old     2: the long-hold beat vs IJH, P's names 2019-06 → 2023-10
//   node --max-old-space-size=6000 scripts/lab-ab.mjs --part=broad   1 + 3: §48's names, 2024-11 → (quiet days; hedged vs IJH)
//
// Offline: data/lab caches, broad-*.jsonl, broad-spy.json, broad-etf.json (lab-broad-fetch.mjs --etf).
import dns from 'dns'
import fs from 'fs'
import readline from 'readline'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { prepare } = await import('../services/screenerLab.data.js')
const { HYPOTHESES, trade } = await import('../services/screenerLab.service.js')
const { memberOn } = await import('../services/sp500History.service.js')

const part = process.argv.find(a => a.startsWith('--part='))?.slice(7)
if (!['cache', 'old', 'broad'].includes(part)) { console.log('--part=cache | --part=old | --part=broad'); process.exit(1) }
const sp = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const toBar = ([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume })
const etfRaw = JSON.parse(fs.readFileSync('data/lab/broad-etf.json', 'utf8'))
const ETF = Object.fromEntries(Object.entries(etfRaw).map(([s, b]) => [s, prepare({ spy: b.map(toBar), names: {} }, {}).spyRealByDay]))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))

// ── 1. THE RUN-UP'S QUIET DAYS.
function liveRunups(data, { days, keep }) {
    const h = HYPOTHESES.runup_5, want = new Set(days), out = []
    for (const [symbol, s] of data.names) for (let i = 1; i < s.rows.length; i++) {
        if (!want.has(s.ind.date[i]) || !keep(symbol, s, i)) continue
        if (h.signal({ rows: s.rows, i, ind: s.ind, reports: s.reports, name: s, data }) !== '3 of 3 beat') continue
        if (!(data.regimes?.get(s.ind.date[i - 1]) ?? '').startsWith('SPY over')) continue
        const t = trade({ rows: s.rows, i, ind: s.ind, name: s, hold: h.hold, exit: h.exit, spyByDay: data.spyByDay })
        if (t) out.push({ symbol, ...t })
    }
    return out
}
/** 5-session blocks of a per-day value (days without one skipped) → { mean, lo, hi } (95%). */
function blocks(byDay, days, size = 5) {
    const means = []
    for (let k = 0; k < days.length; k += size) {
        const xs = days.slice(k, k + size).filter(d => byDay.has(d)).map(d => byDay.get(d))
        if (xs.length) means.push(mean(xs))
    }
    if (means.length < 3) return null
    const m = mean(means), se = Math.sqrt(means.reduce((a, x) => a + (x - m) ** 2, 0) / (means.length - 1)) / Math.sqrt(means.length)
    return { mean: m, lo: m - 1.96 * se, hi: m + 1.96 * se }
}
function quietDays(label, trades, days, split) {
    const byDay = new Map()
    for (const t of trades) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t.net) }
    const BUCKETS = [['1 name', 1, 1], ['2–3', 2, 3], ['4–9', 4, 9], ['10+', 10, Infinity]]
    console.log(`\n── 1. THE RUN-UP'S QUIET DAYS — ${label}: ${trades.length} trades on ${byDay.size} sessions · per trade ${f2(mean(trades.map(t => t.net)))}`)
    const res = {}
    for (const [name, lo, hi] of BUCKETS) {
        const ds = [...byDay].filter(([, xs]) => xs.length >= lo && xs.length <= hi)
        const per = (p) => mean(ds.filter(([d]) => p(d)).map(([, xs]) => mean(xs)))
        res[name] = { all: per(() => true), a: per(d => d < split), b: per(d => d >= split) }
        console.log(`    ${name.padEnd(8)} ${String(ds.length).padStart(4)} sessions · ${String(ds.reduce((a, [, xs]) => a + xs.length, 0)).padStart(5)} trades · per session ${f2(res[name].all)} · before ${f2(res[name].a)} · after ${f2(res[name].b)}`)
    }
    const many = [...byDay].filter(([, xs]) => xs.length >= 4), perM = (p) => mean(many.filter(([d]) => p(d)).map(([, xs]) => mean(xs)))
    const m4 = { a: perM(d => d < split), b: perM(d => d >= split) }
    const flat = blocks(new Map([...byDay].map(([d, xs]) => [d, mean(xs)])), days)
    const capped = blocks(new Map([...byDay].map(([d, xs]) => [d, xs.reduce((a, x) => a + x, 0) / Math.max(xs.length, 5)])), days)
    console.log(`    4+ names: before ${f2(m4.a)} · after ${f2(m4.b)}`)
    console.log(`    per session (live budget)   ${f2(flat?.mean)} [${f2(flat?.lo, 0)} … ${f2(flat?.hi, 0)}]`)
    console.log(`    CAPPED (≤ a fifth a name)   ${f2(capped?.mean)} [${f2(capped?.lo, 0)} … ${f2(capped?.hi, 0)}]  (a fifth of the budget idle on a 1–4 name day)`)
    return { m4, capped }
}

// ── 2 / 3. THE LONG-HOLD BEAT AGAINST THE MID-CAPS.
function longHold(label, data, base, days, split, splitLabel) {
    for (const t of base) {
        const s = data.names.get(t.symbol), rep = s.reports.get(s.ind.date[t.i - 2])
        const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
        t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
    }
    const B = { IJH: ETF.IJH, IWM: ETF.IWM, SPY: data.spyRealByDay }
    const read = (ts, b) => { const bk = holdBook({ ...data, spyByDay: B[b] }, ts); return { n: ts.length, whole: bookBlocks(bk, days), a: bookBlocks(bk, days.filter(d => d < split)), b: bookBlocks(bk, days.filter(d => d >= split)) } }
    const GROUPS = [['every report (control)', () => true], ['REVENUE BEAT 5%+ (the lead)', t => t.rev >= 5], ['revenue beat 10%+', t => t.rev >= 10], ['revenue beat 15%+', t => t.rev >= 15]]
    console.log(`\n── THE LONG-HOLD BEAT, held to the next report — ${label} · book %/mo (t) · ${splitLabel}`)
    const res = {}
    for (const b of ['IJH', 'IWM', 'SPY']) {
        console.log(`  against ${b}${b === 'IJH' ? ' (the bar)' : ' (described)'}`)
        res[b] = {}
        for (const [g, keep] of GROUPS) {
            const r = read(base.filter(t => t.rev != null || g.startsWith('every')).filter(keep), b)
            res[b][g] = r
            console.log(`    ${g.padEnd(30)} ${String(r.n).padStart(5)} · ${f2(r.whole?.mean)} (t ${r.whole?.t?.toFixed(2) ?? '—'}) · ${f2(r.a?.mean)} / ${f2(r.b?.mean)}`)
        }
    }
    const L = res.IJH['REVENUE BEAT 5%+ (the lead)'], C = res.IJH['every report (control)']
    const ok = { above: L.a?.mean > 0 && L.b?.mean > 0, ctl: L.a?.mean > C.a?.mean && L.b?.mean > C.b?.mean, t: L.whole?.t >= 2 }
    const pass = ok.above && ok.ctl && ok.t
    console.log(`    BAR (vs IJH): above it in both ${ok.above} · above every report in both ${ok.ctl} · t ≥ 2 ${ok.t} (${L.whole?.t?.toFixed(2)}) → ${pass ? 'PASS' : 'FAIL'}`)
    return pass
}

if (part === 'cache') {
    let raw = JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8'))
    const { history } = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
    const data = prepare(raw, { history }, { bench: 'spy' }); raw = null
    const days = data.spyDays.filter(d => d >= '2023-10-09')
    const live = liveRunups(data, { days, keep: (sym, s, i) => s.rows[i - 1].close >= 5 && (s.ind.adv20[i - 1] ?? 0) >= 5e6 })
    const { m4, capped } = quietDays("§6's cache (1,177 names, 2023-10 → 2026-10; split 2025-11-08)", live, days, '2025-11-08')
    const pass = m4.a > 0 && m4.b > 0 && capped?.lo > 0
    console.log(`\nPART 1 BAR (§6's cache): 4+ name sessions positive in both halves ${m4.a > 0 && m4.b > 0} · capped block range above zero ${capped?.lo > 0} → ${pass ? 'PASS' : 'FAIL — the number is the quiet days'}`)
    process.exit(0)
}

if (part === 'old') {
    const everSp = new Set(Object.keys(sp.spans))
    let raw = JSON.parse(fs.readFileSync('data/lab/screener-2019-01-02_2023-10-06.json', 'utf8'))
    for (const sym of Object.keys(raw.names)) if (everSp.has(sym)) delete raw.names[sym]
    const { history } = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
    const data = prepare(raw, { history }, { bench: 'spy' }); raw = null
    const FROM = '2019-06-01', days = data.spyDays.filter(d => d >= FROM)
    const base = holdTrades(data, { from: FROM }).trades
    console.log(`P's names (never in the S&P, today's screener): ${data.names.size} · ${base.length} reports ${FROM} → ${days.at(-1)}`)
    const pass = longHold("P's names, 2019-06 → 2023-10", data, base, days, '2021-08-01', 'before / after 2021-08-01')
    console.log(`\nPART 2: ${pass ? 'PASS' : 'FAIL'}`)
    process.exit(0)
}

// part === 'broad'
const FIRST = '2024-11-01', SPLIT = '2025-11-01', FLOOR = { price: 5, adv: 10e6 }
const uni = JSON.parse(fs.readFileSync('data/lab/broad-universe.json', 'utf8'))
const keepSym = new Set(JSON.parse(fs.readFileSync('data/lab/broad-eligible.json', 'utf8')).symbols)
const raw = { spy: JSON.parse(fs.readFileSync('data/lab/broad-spy.json', 'utf8')).map(toBar), names: {}, sectors: Object.fromEntries(uni.names.map(n => [n.symbol, n.sector])), calendar: [] }
for await (const line of readline.createInterface({ input: fs.createReadStream('data/lab/broad-bars.jsonl') })) {
    if (!line) continue
    const r = JSON.parse(line)
    if (r.symbol !== 'SPY' && r.b?.length && keepSym.has(r.symbol)) raw.names[r.symbol] = r.b.map(toBar)
}
const history = {}
for await (const line of readline.createInterface({ input: fs.createReadStream('data/lab/broad-history.jsonl') })) {
    if (!line) continue
    const r = JSON.parse(line)
    if (r.h?.length) history[r.symbol] = r.h
}
const data = prepare(raw, { history }, { bench: 'spy' })
const notSp = (sym, day) => !memberOn(sp.spans, sym, day)
const overFloor = (s, i) => i >= 1 && s.rows[i - 1].close >= FLOOR.price && (s.ind.adv20[i - 1] ?? 0) >= FLOOR.adv
const days = data.spyDays.filter(d => d >= FIRST)
quietDays("§48's names outside the S&P (2024-11 →; split 2025-11-01)", liveRunups(data, { days, keep: (sym, s, i) => overFloor(s, i) && notSp(sym, s.ind.date[i]) }), days, SPLIT)
const base = holdTrades(data, { from: FIRST, member: notSp }).trades.filter(t => overFloor(data.names.get(t.symbol), t.i))
const pass = longHold("§48's names outside the S&P, 2024-11 → 2026-10", data, base, days, SPLIT, 'year 1 / year 2')
console.log(`\nPART 3: ${pass ? 'PASS' : 'FAIL'}`)
process.exit(0)
