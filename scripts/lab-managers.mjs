// THE MANAGERS (13F) — test J (services/managers.service.js): do a manager's CONVICTION BETS — a company it did not hold
// the quarter before, at 3%+ of its book — beat SPY after the filing is public? By concentrated managers (≤ 40 positions,
// $100M+) against every other filer's, plus adds, consensus and track record (Roy, 2026-10-26: "test the managers — do
// not make short cuts"). Declared in screener-lab.md §26.
//
//   python -I scripts/lab-13f-extract.py ...   (first: SEC's data sets → data/lab/13f/<period>.{meta.json,rows.tsv.gz})
//   node scripts/lab-managers.mjs [--hold=63]
//
// Bars: the 2019–2023 and 3-year caches joined (screenerLab.data joinWindows). CUSIPs: data/lab/13f/cusips.json (the
// aether job's map + fills) and fmp-cusips.json (every lab name's FMP profile), resolved against who held what.
import fs from 'fs'
import zlib from 'zlib'

const args = process.argv.slice(2)
const opt = (k, d) => Number(args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const HOLD = opt('hold', 63), MIN_HOLD = 40
const { resolveCusips, booksOf, betsOf, isConcentrated, firstPerKey, meanWithoutBest, median, CONCENTRATED } = await import('../services/managers.service.js')
const { trade, testable, blockRange } = await import('../services/screenerLab.service.js')
const { joinWindows, prepare } = await import('../services/screenerLab.data.js')

const DIR = 'data/lab/13f', SPLIT = '2025-10-23'
const periods = fs.readdirSync(DIR).filter(f => f.endsWith('.meta.json')).map(f => f.slice(0, 10)).sort()
const metas = new Map(periods.map(p => [p, JSON.parse(fs.readFileSync(`${DIR}/${p}.meta.json`, 'utf8'))]))
console.log(`${periods.length} quarters ${periods[0]} → ${periods.at(-1)}`)

const older = JSON.parse(fs.readFileSync('data/lab/screener-2019-01-02_2023-10-06.json', 'utf8'))
const newer = JSON.parse(fs.readFileSync('data/lab/screener-3y.json', 'utf8'))
const joined = joinWindows(older, newer)
console.log(`bars joined: ${Object.keys(joined.raw.names).length} names · scaled at the seam ${joined.scaled.length} · unmatched ${joined.unmatched.length}`)
const data = prepare({ ...joined.raw, calendar: [] })
const symbols = [...data.names.keys()]

// ── CUSIPs ──
const gics = JSON.parse(fs.readFileSync(`${DIR}/cusips.json`, 'utf8'))
const fmp = JSON.parse(fs.readFileSync(`${DIR}/fmp-cusips.json`, 'utf8'))
const { cusipOf, report } = resolveCusips(symbols, { gics, fmp, metas: new Map(periods.map(p => [p, metas.get(p).cusips])) })
const kinds = {}
for (const r of report) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
console.log(`CUSIPs: ${cusipOf.size} of ${symbols.length} names resolved · ${JSON.stringify(kinds)}`)
for (const r of report.filter(x => x.kind === 'gics_cusip_replaced' || x.kind === 'no_cusip_held')) console.log(`  ${JSON.stringify(r)}`)
const standIns = report.filter(x => x.kind === 'stand_in')
console.log(`  stand-ins (a changed CUSIP): ${standIns.length} name-quarters over ${new Set(standIns.map(x => x.symbol)).size} names`)
const symOf = (p) => { const m = new Map(); for (const [s, byP] of cusipOf) { const cu = byP.get(p); if (cu) m.set(cu, s) } return m }

// ── prices ──
const atOrBefore = (dates, day) => { let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= day) { k = m; lo = m + 1 } else hi = m - 1 } return k }
const closeOn = (s, day) => { const j = atOrBefore(s.ind.date, day); return j >= 0 && Date.parse(day) - Date.parse(s.ind.date[j]) <= 7 * 86_400_000 ? s.rows[j].close : null }

// ── the books, quarter by quarter; the bets ──
const readRows = (p) => zlib.gunzipSync(fs.readFileSync(`${DIR}/${p}.rows.tsv.gz`)).toString('utf8').split('\n').filter(Boolean)
    .map(l => { const [cik, cu, sh, v, filed] = l.split('\t'); return [cik, cu, +sh, +v, filed] })
const bets = []
let prev = null
for (const p of periods) {
    const cur = booksOf(readRows(p), symOf(p))
    if (prev) {
        const pp = prev.period
        const priceRatio = (sym) => { const s = data.names.get(sym), a = s && closeOn(s, pp), b = s && closeOn(s, p); return a > 0 && b > 0 ? b / a : null }
        const q = betsOf({ cur, prev, filersCur: metas.get(p).filers, filersPrev: metas.get(pp).filers, holdersCur: cur.holders, holdersPrev: prev.holders, priceRatio, period: p })
        bets.push(...q)
        const conc = Object.values(metas.get(p).filers).filter(f => f[2] <= CONCENTRATED.maxN && f[1] >= CONCENTRATED.minV && f[3] !== 0).length
        console.log(`  ${p}: ${cur.books.size} filers hold our names · ${conc} concentrated filers · bets ${q.length} (new ${q.filter(b => b.kind === 'new').length}, add ${q.filter(b => b.kind === 'add').length}) · concentrated new ${q.filter(b => b.kind === 'new' && isConcentrated(b)).length}`)
    }
    prev = { ...cur, period: p }
}

// ── the trades: the first session after the filing day ──
const traded = []
for (const b of bets) {
    const s = data.names.get(b.symbol)
    let i = s.ind.date.findIndex(d => d > b.filed)
    if (i < 1 || Date.parse(s.ind.date[i]) - Date.parse(b.filed) > 7 * 86_400_000 || !testable(s.rows, i, s.ind)) continue
    const hold = Math.min(HOLD, s.rows.length - i)
    if (hold < MIN_HOLD) continue
    const t = trade({ rows: s.rows, i, ind: s.ind, hold, spyByDay: data.spyByDay })
    if (t) traded.push({ ...b, ...t, hold, key: `${b.symbol}|${b.period}` })
}
console.log(`\n${bets.length} bets · ${traded.length} traded (the lab's price/volume floor, a session within a week, 40+ sessions left)`)

// ── the groups ──
const conc = traded.filter(t => isConcentrated(t))
const primaryAll = conc.filter(t => t.kind === 'new')
const groups = {
    PRIMARY: firstPerKey(primaryAll),
    CONTROL: firstPerKey(traded.filter(t => t.kind === 'new' && t.N > CONCENTRATED.maxN)),
    'adds (concentrated)': firstPerKey(conc.filter(t => t.kind === 'add')),
}
// Consensus: 2+ concentrated managers' new bets on one name in one quarter — known on the SECOND filing.
const byKey = new Map()
for (const t of primaryAll) { if (!byKey.has(t.key)) byKey.set(t.key, []); byKey.get(t.key).push(t) }
groups['consensus (2+ concentrated)'] = [...byKey.values()].map(xs => { const ks = [...new Map(xs.sort((a, b) => a.day.localeCompare(b.day)).map(x => [x.cik, x])).values()]; return ks.length >= 2 ? ks[1] : null }).filter(Boolean)
// Track record: the manager's earlier primary bets whose holds had FINISHED by this filing day — 5+, mean above SPY.
const byCik = new Map()
for (const t of primaryAll) { if (!byCik.has(t.cik)) byCik.set(t.cik, []); byCik.get(t.cik).push(t) }
groups['track record (5+ done, above SPY)'] = firstPerKey(primaryAll.filter(t => {
    const past = byCik.get(t.cik).filter(x => x.exit_day < t.filed)
    return past.length >= 5 && past.reduce((a, x) => a + x.net, 0) / past.length > 0
}))

const days = data.spyDays
const f = (x) => (x == null ? '   —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(7))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const stat = (xs) => {
    const n = xs.map(x => x.net), b = blockRange(xs, days, 21)
    return { n: xs.length, mean: mean(n), median: median(n), up: xs.length ? xs.filter(x => x.net > 0).length / xs.length * 100 : null, trim: meanWithoutBest(n), b,
        before: mean(xs.filter(x => x.day < SPLIT).map(x => x.net)), held: mean(xs.filter(x => x.day >= SPLIT).map(x => x.net)),
        nb: xs.filter(x => x.day < SPLIT).length, nh: xs.filter(x => x.day >= SPLIT).length }
}
console.log(`\nnet vs SPY over ${HOLD} sessions after cost, one trade per company per quarter per group`)
const S = {}
for (const [g, xs] of Object.entries(groups)) {
    const s = S[g] = stat(xs)
    console.log(`── ${g}: ${s.n} · mean ${f(s.mean)} · median ${f(s.median)} · up ${s.up?.toFixed(0)}% · without the best 1% ${f(s.trim)} · before ${s.nb} ${f(s.before)} | held out ${s.nh} ${f(s.held)} · blocks ${s.b ? `${f(s.b.ci95[0])} … ${f(s.b.ci95[1])}` : '—'}`)
    const years = [...new Set(xs.map(x => x.day.slice(0, 4)))].sort()
    console.log(`     by year: ${years.map(y => { const ys = xs.filter(x => x.day.startsWith(y)); return `${y} ${ys.length} ${f(mean(ys.map(x => x.net)))}` }).join(' · ')}`)
}
const P = S.PRIMARY, C = S.CONTROL
const checks = {
    'mean > 0 before': P.before > 0, 'mean > 0 held out': P.held > 0, 'block range above zero': P.b?.ci95[0] > 0,
    'above CONTROL before': P.before > C.before, 'above CONTROL held out': P.held > C.held, 'without the best 1% > 0': P.trim > 0,
}
console.log(`\nDECLARED BAR (PRIMARY): ${Object.entries(checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join(' · ')} → ${Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'}`)
const dump = args.find(a => a.startsWith('--dump='))?.slice(7)
if (dump) fs.writeFileSync(dump, JSON.stringify({ groups, report }))
process.exit(0)
