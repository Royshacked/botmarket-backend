// THE REVENUE BEAT OUTSIDE THE S&P 500, AGAINST SPY — test Y (declared in screener-lab.md §48, before the run). Roy,
// 2026-11-08: "check also companies not in the SPY against the SPY ETF … start with the 2 last years".
//
//   node --max-old-space-size=6000 scripts/lab-broad-revenue.mjs
//
// Offline: data/lab/broad-*.jsonl (lab-broad-fetch.mjs) + broad-universe.json + sp500-universe.json.
import dns from 'dns'
import fs from 'fs'
import readline from 'readline'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { prepare } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')

const FIRST = '2024-11-01', SPLIT = '2025-11-01', MIN = 10, FLOOR = { price: 5, adv: 10e6 }
const uni = JSON.parse(fs.readFileSync('data/lab/broad-universe.json', 'utf8'))
const sourceOf = new Map(uni.names.map(n => [n.symbol, n.source]))
const sp = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const { symbols } = JSON.parse(fs.readFileSync('data/lab/broad-eligible.json', 'utf8'))
const keep = new Set(symbols)

// The bars, streamed: only the eligible names and SPY are kept.
const raw = { spy: [], names: {}, sectors: Object.fromEntries(uni.names.map(n => [n.symbol, n.sector])), calendar: [] }
const toBar = ([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume })
for await (const line of readline.createInterface({ input: fs.createReadStream('data/lab/broad-bars.jsonl') })) {
    if (!line) continue
    const r = JSON.parse(line)
    if (!r.b?.length) continue
    if (r.symbol === 'SPY') raw.spy = r.b.map(toBar)
    else if (keep.has(r.symbol)) raw.names[r.symbol] = r.b.map(toBar)
}
const history = {}
for await (const line of readline.createInterface({ input: fs.createReadStream('data/lab/broad-history.jsonl') })) {
    if (!line) continue
    const r = JSON.parse(line)
    if (r.h?.length) history[r.symbol] = r.h
}
const data = prepare(raw, { history }, { bench: 'spy' })
console.log(`${data.names.size} names with bars · ${Object.keys(history).length} with earnings history · SPY ${data.spyDays[0]} → ${data.spyDays.at(-1)}`)

// Outside the S&P 500 on the entry day, and over the size floor at entry.
const notSp = (sym, day) => !memberOn(sp.spans, sym, day)
const { trades, out } = holdTrades(data, { from: FIRST, member: notSp })
const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const all = trades.filter(t => {
    const s = data.names.get(t.symbol)
    return s.rows[t.i - 1].close >= FLOOR.price && (s.ind.adv20[t.i - 1] ?? 0) >= FLOOR.adv
})
for (const t of all) {
    const s = data.names.get(t.symbol), rep = s.reports.get(s.ind.date[t.i - 2])
    const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
    t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
    t.adv = s.ind.adv20[t.i - 1]
    t.gone = sourceOf.get(t.symbol) !== 'active'
}
console.log(`reports from ${FIRST}: ${trades.length} outside the S&P · ${all.length} over the floor · left out ${JSON.stringify(out)} · revenue known ${(all.filter(t => t.rev != null).length / all.length * 100).toFixed(0)}% · names gone since ${all.filter(t => t.gone).length}`)

const heldFor = (t, h) => {
    if (h === 'next') return t
    const x = Math.min(t.i + h - 1, t.x)
    const s = data.names.get(t.symbol), s0 = data.spyByDay.get(s.ind.date[t.i]), s1 = data.spyByDay.get(s.ind.date[x])
    const ret = pct(s.rows[x].close, s.rows[t.i].open), spy = pct(s1?.close, s0?.open)
    return ret == null || spy == null ? null : { ...t, x, held: x - t.i + 1, ret, spy, net: ret - spy - t.cost }
}
const days = data.spyDays.filter(d => d >= FIRST)
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
function read(ts) {
    const b = holdBook(data, ts)
    return { n: ts.length, per: mean(ts.map(t => t.net)), beat: ts.length ? ts.filter(t => t.net > 0).length / ts.length * 100 : null,
        whole: bookBlocks(b, days), y1: bookBlocks(b, days.filter(d => d < SPLIT)), y2: bookBlocks(b, days.filter(d => d >= SPLIT)) }
}
const line = (label, r) => console.log(`    ${label.padEnd(36)} ${String(r.n).padStart(5)} · per hold ${f2(r.per)} beat SPY ${r.beat == null ? ' —' : r.beat.toFixed(0) + '%'} · book/mo ${f2(r.whole?.mean)} t ${r.whole?.t?.toFixed(2) ?? '—'} · year 1 ${f2(r.y1?.mean)} · year 2 ${f2(r.y2?.mean)}`)

const GROUPS = {
    'REVENUE BEAT 10%+ (primary)': (t) => t.rev != null && t.rev >= MIN,
    'every report (control)': () => true,
    'EPS beat over 10%': (t) => t.band === 'big beat',
    'good (EPS + revenue)': (t) => t.good,
    'revenue 10%+, $10–50M a day': (t) => t.rev >= MIN && t.adv < 50e6,
    'revenue 10%+, $50M+ a day': (t) => t.rev >= MIN && t.adv >= 50e6,
}
const res = {}
for (const h of [40, 'next']) {
    console.log(`\n── HELD ${h === 'next' ? 'TO THE NEXT REPORT' : `${h} SESSIONS`} · against SPY, net of the cost`)
    const ts = all.map(t => heldFor(t, h)).filter(Boolean)
    res[h] = {}
    for (const [label, keepIt] of Object.entries(GROUPS)) { const r = read(ts.filter(keepIt)); res[h][label] = r; line(label, r) }
    // The survivorship check: year two with and without the names gone since (the calendar recovers them there).
    const y2 = ts.filter(t => t.day >= SPLIT && t.rev != null && t.rev >= MIN)
    const bk = (xs) => bookBlocks(holdBook(data, xs), days.filter(d => d >= SPLIT))?.mean
    console.log(`    survivorship, year 2, revenue 10%+: with the gone names ${f2(bk(y2))} (${y2.length}, ${y2.filter(t => t.gone).length} gone) · today's names only ${f2(bk(y2.filter(t => !t.gone)))}`)
}

const p = res[40]['REVENUE BEAT 10%+ (primary)'], c = res[40]['every report (control)'], nx = res.next['REVENUE BEAT 10%+ (primary)']
const aboveSpy = p.y1?.mean > 0 && p.y2?.mean > 0, aboveCtl = p.y1?.mean > c.y1?.mean && p.y2?.mean > c.y2?.mean, sig = p.whole?.t >= 2, nb = nx.y1?.mean > 0 && nx.y2?.mean > 0
console.log(`\nDECLARED BAR (40 sessions): above SPY in both years ${aboveSpy} · above every report in both ${aboveCtl} · t ≥ 2 ${sig} (${p.whole?.t?.toFixed(2)}) · to the next report above SPY in both ${nb} → ${aboveSpy && aboveCtl && sig && nb ? 'PASS' : 'FAIL'}`)
process.exit(0)
