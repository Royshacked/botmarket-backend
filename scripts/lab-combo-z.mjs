// COMBINED VARIANTS, CHOSEN INSIDE THE S&P, TESTED OUTSIDE IT — test Z (declared in screener-lab.md §49, before the run).
// Roy, 2026-11-08: "maybe combine variants?" Two processes (each loads ~1 GB), the choice written before the test reads
// the outside data:
//
//   node --max-old-space-size=6000 scripts/lab-combo-z.mjs --choose   S&P 2020 → 2026, vs equal weight → data/lab/combo-z.json
//   node --max-old-space-size=6000 scripts/lab-combo-z.mjs --test     §48's names outside the S&P, vs SPY, the two chosen
//
// Offline: data/lab caches (the S&P), broad-*.jsonl + broad-spy.json (lab-broad-fetch.mjs).
import dns from 'dns'
import fs from 'fs'
import readline from 'readline'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
delete process.env.LAB_BENCH
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { prepare, loadLabData, equalWeightBars } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')

const HOLD = 40, MIN_N = 200, T_BAR = 2.25, CHOICE = 'data/lab/combo-z.json'
const sp = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))

/** Each trade's facts for the pieces: revenue beat, the day before the report (k − 1) vs its averages, SPY's trend. */
function tag(data, trades) {
    const closes = data.spyDays.map(d => data.spyRealByDay.get(d)?.close)
    const spyUp = new Map()
    for (let n = 199; n < closes.length; n++) {
        const w = closes.slice(n - 199, n + 1)
        if (w.every(c => c > 0)) spyUp.set(data.spyDays[n], closes[n] > mean(w))
    }
    for (const t of trades) {
        const s = data.names.get(t.symbol), k = t.i - 2, rep = s.reports.get(s.ind.date[k])
        const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
        t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
        const c = s.rows[k - 1].close, m20 = s.ind.sma20[k - 1], m50 = s.ind.sma50[k - 1]
        t.vs20 = m20 > 0 ? c / m20 - 1 : null
        t.pullback = m20 > 0 && m50 > 0 ? c > m50 && c < m20 : null
        t.spyUp = spyUp.get(s.ind.date[k - 1]) ?? null
        t.adv = s.ind.adv20[t.i - 1] ?? 0
    }
}

/** The 96 combinations (§49), as { key, keep(t) } — `cut` is the S&P trades' top-fifth vs-20-day line. */
function combos(cut) {
    const out = []
    for (const rev of [10, 20]) for (const eps of ['any', 'beat']) for (const react of ['any', 'up'])
        for (const mkt of ['any', 'spy>200d']) for (const price of ['any', 'not stretched', 'pullback']) for (const size of ['any', '$50M+']) {
            const key = `rev ${rev}%+ · eps ${eps} · reaction ${react} · market ${mkt} · price ${price} · size ${size}`
            out.push({ key, keep: (t) => t.rev != null && t.rev >= rev
                && (eps === 'any' || t.surprise > 0)
                && (react === 'any' || t.reacted === 'up')
                && (mkt === 'any' || t.spyUp === true)
                && (price === 'any' || (price === 'pullback' ? t.pullback === true : t.vs20 != null && t.vs20 < cut))
                && (size === 'any' || t.adv >= 50e6) })
        }
    return out
}
const heldFor = (t, h) => (h === 'next' ? t : { ...t, x: Math.min(t.i + h - 1, t.x) })

if (process.argv.includes('--choose')) {
    const { closeDb } = await import('../providers/mongodb.provider.js')
    const FROM = '2020-01-01', SPLIT = '2024-01-01'
    const member = (sym, day) => memberOn(sp.spans, sym, day)
    const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member, bench: 'spy' })
    await closeDb()
    const ew = { ...data, spyByDay: equalWeightBars(data.names, data.spyDays, data.spyRealByDay, member) }
    const base = holdTrades(data, { from: FROM, member }).trades
    tag(data, base)
    const v = base.map(t => t.vs20).filter(Number.isFinite).sort((a, b) => a - b), cut = v[Math.floor(v.length * 0.8)]
    const days = data.spyDays.filter(d => d >= FROM)
    const rows = []
    for (const c of combos(cut)) {
        const ts = base.filter(c.keep).map(t => heldFor(t, HOLD))
        if (!ts.length) { rows.push({ key: c.key, n: 0 }); continue }
        const b = holdBook(ew, ts)
        rows.push({ key: c.key, n: ts.length, whole: bookBlocks(b, days), before: bookBlocks(b, days.filter(d => d < SPLIT)), after: bookBlocks(b, days.filter(d => d >= SPLIT)) })
    }
    const ok = rows.filter(r => r.n >= MIN_N && r.before?.mean > 0 && r.after?.mean > 0 && Number.isFinite(r.whole?.t)).sort((a, b) => b.whole.t - a.whole.t)
    console.log(`S&P 500 ${FROM} → · ${base.length} reports · stretched cut (top fifth vs the 20-day) ${(cut * 100).toFixed(1)}% · ${rows.filter(r => r.n >= MIN_N).length} of ${rows.length} combinations with ${MIN_N}+ trades · ${ok.length} positive both before and after ${SPLIT}`)
    console.log('\n── THE TOP 15 (40 sessions, vs the equal-weight market): book/mo (t) · before / after · n')
    for (const r of ok.slice(0, 15)) console.log(`  ${f2(r.whole.mean)} (${r.whole.t.toFixed(2)}) ${f2(r.before.mean)} / ${f2(r.after.mean)} · ${String(r.n).padStart(5)} · ${r.key}`)
    const chosen = ok.slice(0, 2).map(r => r.key)
    fs.writeFileSync(CHOICE, JSON.stringify({ chosen_at: new Date().toISOString(), cut, chosen, inside: rows.map(r => ({ key: r.key, n: r.n, mean: r.whole?.mean ?? null, t: r.whole?.t ?? null, before: r.before?.mean ?? null, after: r.after?.mean ?? null })) }))
    console.log(`\nCHOSEN → ${CHOICE}:\n  1. ${chosen[0]}\n  2. ${chosen[1]}`)
    process.exit(0)
}

if (!process.argv.includes('--test')) { console.log('--choose | --test'); process.exit(1) }
const choice = JSON.parse(fs.readFileSync(CHOICE, 'utf8'))
const FIRST = '2024-11-01', SPLIT = '2025-11-01', FLOOR = { price: 5, adv: 10e6 }
const uni = JSON.parse(fs.readFileSync('data/lab/broad-universe.json', 'utf8'))
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
const all = holdTrades(data, { from: FIRST, member: notSp }).trades.filter(t => {
    const s = data.names.get(t.symbol)
    return s.rows[t.i - 1].close >= FLOOR.price && (s.ind.adv20[t.i - 1] ?? 0) >= FLOOR.adv
})
tag(data, all)
console.log(`outside the S&P ${FIRST} →: ${all.length} reports over the floor · SPY ${data.spyDays[0]} → · market known on ${(all.filter(t => t.spyUp != null).length / all.length * 100).toFixed(0)}% · pullback known on ${(all.filter(t => t.pullback != null).length / all.length * 100).toFixed(0)}%`)
const days = data.spyDays.filter(d => d >= FIRST)
function read(ts) {
    const b = holdBook(data, ts)
    return { n: ts.length, beat: ts.length ? ts.filter(t => t.net > 0).length / ts.length * 100 : null, whole: bookBlocks(b, days), y1: bookBlocks(b, days.filter(d => d < SPLIT)), y2: bookBlocks(b, days.filter(d => d >= SPLIT)) }
}
// heldFor here must re-net the trade (beat SPY is per trade): the 40-session return against SPY, after the cost.
const held40 = (t) => {
    const x = Math.min(t.i + HOLD - 1, t.x), s = data.names.get(t.symbol)
    const ret = pct(s.rows[x].close, s.rows[t.i].open), spy = pct(data.spyByDay.get(s.ind.date[x])?.close, data.spyByDay.get(s.ind.date[t.i])?.open)
    return ret == null || spy == null ? null : { ...t, x, net: ret - spy - t.cost }
}
const ctl40 = read(all.map(held40).filter(Boolean)), ctlNext = read(all)
const show = (label, r) => console.log(`    ${label.padEnd(18)} ${String(r.n).padStart(5)} · beat SPY ${r.beat == null ? ' —' : r.beat.toFixed(0) + '%'} · book/mo ${f2(r.whole?.mean)} t ${r.whole?.t?.toFixed(2) ?? '—'} · year 1 ${f2(r.y1?.mean)} · year 2 ${f2(r.y2?.mean)}`)
console.log('\n  every report (control)')
show('40 sessions', ctl40); show('to the next report', ctlNext)

const list = combos(choice.cut), byKey = new Map(list.map(c => [c.key, c]))
let pass = false
choice.chosen.forEach((key, n) => {
    const picks = all.filter(byKey.get(key).keep), r40 = read(picks.map(held40).filter(Boolean)), rN = read(picks)
    console.log(`\n  CHOSEN ${n + 1}: ${key}`)
    show('40 sessions', r40); show('to the next report', rN)
    const a = r40.y1?.mean > 0 && r40.y2?.mean > 0, b = r40.y1?.mean > ctl40.y1?.mean && r40.y2?.mean > ctl40.y2?.mean
    const c = r40.whole?.t >= T_BAR, d = rN.y1?.mean > 0 && rN.y2?.mean > 0
    console.log(`    BAR: above SPY in both years ${a} · above every report in both ${b} · t ≥ ${T_BAR} ${c} (${r40.whole?.t?.toFixed(2)}) · to the next report above SPY in both ${d} → ${a && b && c && d ? 'PASS' : 'FAIL'}`)
    if (a && b && c && d) pass = true
})
console.log(`\nDECLARED VERDICT (test Z): ${pass ? 'PASS' : 'FAIL'}`)

// Described only, after the verdict: every combination's outside 40-session book beside its inside one.
console.log('\n── DESCRIBED (not the test): inside (S&P vs equal weight) → outside (vs SPY), 40 sessions, by inside t')
const inside = new Map(choice.inside.map(r => [r.key, r]))
const rows = list.map(c => { const r = read(all.filter(c.keep).map(held40).filter(Boolean)); return { key: c.key, in: inside.get(c.key), out: r } })
    .filter(r => r.in?.n >= MIN_N && r.out.n >= 50).sort((a, b) => (b.in.t ?? -9) - (a.in.t ?? -9))
for (const r of rows.slice(0, 20)) console.log(`  in ${f2(r.in.mean)} (${r.in.t?.toFixed(2)}) → out ${f2(r.out.whole?.mean)} (${r.out.whole?.t?.toFixed(2) ?? '—'}) y1 ${f2(r.out.y1?.mean)} y2 ${f2(r.out.y2?.mean)} · ${String(r.out.n).padStart(4)} · ${r.key}`)
const ins = rows.map(r => r.in.t), outs = rows.map(r => r.out.whole?.t ?? 0), mi = mean(ins), mo = mean(outs)
const corr = rows.length > 2 ? ins.reduce((s, x, n) => s + (x - mi) * (outs[n] - mo), 0) / Math.sqrt(ins.reduce((s, x) => s + (x - mi) ** 2, 0) * outs.reduce((s, x) => s + (x - mo) ** 2, 0)) : null
console.log(`  ${rows.length} combinations with ${MIN_N}+ inside and 50+ outside · inside t vs outside t, correlation ${corr?.toFixed(2) ?? '—'}`)
process.exit(0)
