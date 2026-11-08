// OTHER VARIANTS OUTSIDE THE S&P — test AA (declared in screener-lab.md §50, before the run). Roy, 2026-11-08: "check
// other variants." A: the live run-up rule with the gone names in, against SPY. B: the revenue-beat grid against these
// names' own equal-weight market (and SPY, described).
//
//   node --max-old-space-size=6000 scripts/lab-broad-variants.mjs
//
// Offline: broad-*.jsonl + broad-spy.json (lab-broad-fetch.mjs), broad-universe.json, sp500-universe.json.
import dns from 'dns'
import fs from 'fs'
import readline from 'readline'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { prepare, equalWeightBars } = await import('../services/screenerLab.data.js')
const { HYPOTHESES, trade, blockRange } = await import('../services/screenerLab.service.js')
const { memberOn } = await import('../services/sp500History.service.js')

const FIRST = '2024-11-01', SPLIT = '2025-11-01', FLOOR = { price: 5, adv: 10e6 }
const MINS = [5, 7.5, 10, 15, 20], HOLDS = [20, 30, 40, 60, 'next']
const sp = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const uni = JSON.parse(fs.readFileSync('data/lab/broad-universe.json', 'utf8'))
const gone = new Set(uni.names.filter(n => n.source !== 'active').map(n => n.symbol))
const { symbols } = JSON.parse(fs.readFileSync('data/lab/broad-eligible.json', 'utf8'))
const keepSym = new Set(symbols)
const toBar = ([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume })
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
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
console.log(`${data.names.size} names outside-S&P candidates · SPY ${data.spyDays[0]} → ${data.spyDays.at(-1)} · entries ${FIRST} →`)

// ── A. THE LIVE RUN-UP RULE, the gone names in.
const h = HYPOTHESES.runup_5, want = new Set(days)
const runs = []
for (const [symbol, s] of data.names) {
    for (let i = 1; i < s.rows.length; i++) {
        if (!want.has(s.ind.date[i]) || !overFloor(s, i) || !notSp(symbol, s.ind.date[i])) continue
        const tag = h.signal({ rows: s.rows, i, ind: s.ind, reports: s.reports, name: s, data })
        if (tag == null) continue
        const t = trade({ rows: s.rows, i, ind: s.ind, name: s, hold: h.hold, exit: h.exit, spyByDay: data.spyByDay })
        if (t) runs.push({ symbol, streak: tag, spyUp: (data.regimes?.get(s.ind.date[i - 1]) ?? '').startsWith('SPY over'), gone: gone.has(symbol), ...t })
    }
}
const readRun = (ts) => ({ n: ts.length, net: mean(ts.map(t => t.net)), y1: mean(ts.filter(t => t.day < SPLIT).map(t => t.net)), y2: mean(ts.filter(t => t.day >= SPLIT).map(t => t.net)),
    up: ts.length ? ts.filter(t => t.net > 0).length / ts.length * 100 : null, blocks: blockRange(ts, days, 5) })
const showRun = (label, r) => console.log(`    ${label.padEnd(40)} ${String(r.n).padStart(5)} · net/trade ${f2(r.net)} · beat SPY ${r.up?.toFixed(0) ?? '—'}% · year 1 ${f2(r.y1)} · year 2 ${f2(r.y2)} · blocks ${r.blocks ? `${f2(r.blocks.mean)} [${f2(r.blocks.ci95[0], 0)} … ${f2(r.blocks.ci95[1], 0)}]` : '—'}`)
const live = runs.filter(t => t.streak === '3 of 3 beat' && t.spyUp)
const A = readRun(live)
console.log('\n── A. THE LIVE RUN-UP RULE (5 sessions before the report, last three beat, SPY over its 200-day) · vs SPY, net of the cost')
showRun('THE LIVE RULE, gone names in', A)
showRun('the live rule, today\'s names only', readRun(live.filter(t => !t.gone)))
showRun('every run-up (no streak, no regime gate)', readRun(runs))
showRun('last three beat, any market', readRun(runs.filter(t => t.streak === '3 of 3 beat')))
showRun('SPY over its 200-day, any streak', readRun(runs.filter(t => t.spyUp)))
const passA = A.y1 > 0 && A.y2 > 0 && A.blocks?.ci95[0] > 0
console.log(`    BAR A: positive in both years ${A.y1 > 0 && A.y2 > 0} · block range above zero ${A.blocks?.ci95[0] > 0} → ${passA ? 'PASS' : 'FAIL'}`)

// ── B. THE REVENUE-BEAT GRID against these names' own market.
const floorDays = new Map()
for (const [symbol, s] of data.names) {
    const set = new Set()
    for (let i = 1; i < s.rows.length; i++) if (overFloor(s, i)) set.add(s.ind.date[i])
    floorDays.set(symbol, set)
}
const EW = equalWeightBars(data.names, data.spyDays, data.spyRealByDay, (sym, day) => floorDays.get(sym).has(day) && notSp(sym, day))
const BENCH = { ew: { ...data, spyByDay: EW }, spy: data }
const base = holdTrades(data, { from: FIRST, member: notSp }).trades.filter(t => overFloor(data.names.get(t.symbol), t.i))
for (const t of base) {
    const s = data.names.get(t.symbol), rep = s.reports.get(s.ind.date[t.i - 2])
    const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
    t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
}
const heldFor = (t, hh) => (hh === 'next' ? t : { ...t, x: Math.min(t.i + hh - 1, t.x) })
const read = (ts, b) => { const bk = holdBook(BENCH[b], ts); return { n: ts.length, whole: bookBlocks(bk, days), y1: bookBlocks(bk, days.filter(d => d < SPLIT)), y2: bookBlocks(bk, days.filter(d => d >= SPLIT)) } }
const both = (r) => r.y1?.mean > 0 && r.y2?.mean > 0
const grid = {}
for (const b of ['ew', 'spy']) {
    grid[b] = []
    console.log(`\n── B. AGAINST ${b === 'ew' ? 'THESE NAMES\' EQUAL-WEIGHT MARKET' : 'SPY (described)'}: book %/mo (t) · year 1 / year 2 · ◆ = positive in both`)
    console.log(`  ${'beat ≥'.padEnd(8)}${HOLDS.map(x => String(x).padStart(25)).join('')}`)
    const ctl = HOLDS.map(hh => read(base.map(t => heldFor(t, hh)), b))
    console.log(`  ${'every'.padEnd(8)}${ctl.map(r => `${both(r) ? '◆' : ' '}${f2(r.whole?.mean, 6)} (${r.whole?.t?.toFixed(1) ?? '—'}) ${f2(r.y1?.mean, 6)}/${f2(r.y2?.mean, 6)}`.padStart(25)).join('')}`)
    for (const m of MINS) {
        const picks = base.filter(t => t.rev != null && t.rev >= m)
        const cells = HOLDS.map(hh => read(picks.map(t => heldFor(t, hh)), b))
        grid[b].push(...cells)
        console.log(`  ${`${m}%`.padEnd(8)}${cells.map(r => `${both(r) ? '◆' : ' '}${f2(r.whole?.mean, 6)} (${r.whole?.t?.toFixed(1) ?? '—'}) ${f2(r.y1?.mean, 6)}/${f2(r.y2?.mean, 6)}`.padStart(25)).join('')}`)
    }
    console.log(`  (reports ${base.length} · picks ${MINS.map(m => `≥${m}% ${base.filter(t => t.rev != null && t.rev >= m).length}`).join(' · ')})`)
}
const ts = grid.ew.map(r => r.whole?.t).filter(Number.isFinite).sort((a, b) => a - b), medT = ts[Math.floor(ts.length / 2)]
const share = grid.ew.filter(both).length / grid.ew.length
const passB = share >= 2 / 3 && medT >= 1.5
console.log(`\n    BAR B (vs equal weight): cells positive in both years ${(share * 100).toFixed(0)}% (need ≥ 67%) · median t ${medT?.toFixed(2)} (need ≥ 1.5) → ${passB ? 'ROBUST' : 'NOT ROBUST'}`)
console.log(`\nDECLARED VERDICT (test AA): A the live run-up ${passA ? 'PASS' : 'FAIL'} · B the revenue grid ${passB ? 'ROBUST' : 'NOT ROBUST'}`)
process.exit(0)
