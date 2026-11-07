// WHO THE WINNERS ARE (declared in screener-lab.md §41, before the run). Roy, 2026-11-07: "let's characterise the
// winners". The quarters that beat SPY by 5%+ (§36), as a portrait: a club or a draw, beta and the market, themes
// (industries), the size of the win, and the profile in one table. Hindsight allowed.
//
//   node scripts/lab-quarter-winners-profile.mjs --industries         (once, small: FMP's industry per name)
//   node --max-old-space-size=6000 scripts/lab-quarter-winners-profile.mjs
//
// Offline but for --industries: data/lab caches + sec-facts.jsonl + sp500-industries.json.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const IND = 'data/lab/sp500-industries.json'
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))

if (process.argv.includes('--industries')) {
    const { fmpGet } = await import('../providers/fmp.price.provider.js')
    const have = fs.existsSync(IND) ? JSON.parse(fs.readFileSync(IND, 'utf8')) : {}
    let n = 0
    for (const s of Object.keys(u.spans)) {
        if (have[s] !== undefined) continue
        try { const p = (await fmpGet(`/profile?symbol=${encodeURIComponent(s)}`, { label: `FMP profile ${s}` }))?.[0]; have[s] = p?.industry || null } catch { have[s] = null }
        if (++n % 50 === 0) { fs.writeFileSync(IND, JSON.stringify(have)); console.log(`  ${n}`) }
        await new Promise(r => setTimeout(r, 250))
    }
    fs.writeFileSync(IND, JSON.stringify(have))
    console.log(`industries: ${Object.values(have).filter(Boolean).length} of ${Object.keys(have).length}`)
    process.exit(0)
}

const { prepareFundamentals, fundamentalsAt } = await import('../services/secFundamentals.service.js')
const { featuresAt } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const EDGE = 5, SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3'
const member = (sym, day) => memberOn(u.spans, sym, day)
const industry = JSON.parse(fs.readFileSync(IND, 'utf8'))
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()
const facts = new Map(fs.readFileSync('data/lab/sec-facts.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.c).map(r => [r.symbol, prepareFundamentals(r.c)]))

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) cur.last = d
    else quarters.push({ q, first: d, last: d, base: cur?.last ?? null })
}
const Q = quarters.filter(x => x.base && x.q >= FIRST_Q && x.q <= LAST_Q)

/** Beta over the `n` sessions to bar `j` against SPY, daily returns. Pure. */
function betaAt(s, j, n = 252) {
    if (j < n) return null
    const xs = [], ys = []
    for (let d = j - n + 1; d <= j; d++) {
        const a = data.spyByDay.get(s.ind.date[d]), b = data.spyByDay.get(s.ind.date[d - 1])
        const m = pct(a?.close, b?.close), r = pct(s.rows[d].close, s.rows[d - 1].close)
        if (m != null && r != null) { xs.push(m); ys.push(r) }
    }
    if (xs.length < n * 0.8) return null
    const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length
    let c = 0, v = 0
    for (let k = 0; k < xs.length; k++) { c += (xs[k] - mx) * (ys[k] - my); v += (xs[k] - mx) ** 2 }
    return v > 0 ? c / v : null
}

const rows = []
for (const [symbol, s] of data.names) {
    const at = new Map(s.ind.date.map((d, n) => [d, n]))
    const dates = [...s.reports.keys()].sort()
    for (const x of Q) {
        const j = at.get(x.base)
        if (j == null || j < 60 || !member(symbol, x.first)) continue
        let e = at.get(x.last)
        if (e == null) {
            const lastDay = s.ind.date.at(-1)
            if (!(lastDay > x.base && lastDay < x.last)) continue
            e = s.ind.date.length - 1
        }
        const ret = pct(s.rows[e].close, s.rows[j].close), spy = pct(data.spyByDay.get(s.ind.date[e])?.close, data.spyByDay.get(x.base)?.close)
        if (ret == null || spy == null) continue
        const f = { ...featuresAt(s, data, j, j + 1, j + 1), ...fundamentalsAt(facts.get(symbol), x.base, s.rows[j].close), beta: betaAt(s, j) }
        const repDay = dates.find(d => d > x.base && d <= s.ind.date[e]), rep = repDay ? s.reports.get(repDay) : null
        const ra = Number(rep?.revenueActual), re = Number(rep?.revenueEstimated), ea = Number(rep?.epsActual), ee = Number(rep?.epsEstimated)
        const net = ret - spy
        rows.push({ symbol, q: x.q, day: x.first, spyQ: spy, sector: s.sector ?? 'unknown', industry: industry[symbol] ?? 'unknown', net, f,
            revBeat: ra > 0 && re > 0 ? ra > re : null, epsBeat: rep?.epsActual != null && rep?.epsEstimated != null && Number.isFinite(ea) && Number.isFinite(ee) ? ea > ee : null,
            group: net >= EDGE ? 'win' : net <= -EDGE ? 'lose' : 'mid' })
    }
}

const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const n2 = (x, w = 7) => (x == null ? '—'.padStart(w) : x.toFixed(2).padStart(w))
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
const share = (ts, p) => (ts.length ? `${(ts.filter(p).length / ts.length * 100).toFixed(0)}%` : '—').padStart(4)
const isWin = (r) => r.group === 'win'
const rate = rows.filter(isWin).length / rows.length

console.log(`${rows.length} name-quarters · winners ${(rate * 100).toFixed(1)}% · industries known for ${rows.filter(r => r.industry !== 'unknown').length}`)

// ── A CLUB OR A DRAW?
console.log('\n── A CLUB OR A DRAW? names with 12+ quarters as a member: their winning quarters against chance at the same rate')
const byName = new Map()
for (const r of rows) { if (!byName.has(r.symbol)) byName.set(r.symbol, []); byName.get(r.symbol).push(r) }
const long = [...byName].filter(([, v]) => v.length >= 12)
const winRates = long.map(([, v]) => v.filter(isWin).length / v.length)
const n0 = Math.round(mean(long.map(([, v]) => v.length)))
// The spread chance gives: a binomial at the overall rate over the average count.
const sdChance = Math.sqrt(rate * (1 - rate) / n0), sdSeen = Math.sqrt(mean(winRates.map(w => (w - mean(winRates)) ** 2)))
console.log(`  ${long.length} names, ~${n0} quarters each · win rate spread across names: seen ${(sdSeen * 100).toFixed(1)} pts, chance alone ${(sdChance * 100).toFixed(1)} pts`)
const binomTail = (k, n, p) => { let s = 0; for (let i = k; i <= n; i++) { let c = 1; for (let z = 0; z < i; z++) c = c * (n - z) / (z + 1); s += c * p ** i * (1 - p) ** (n - i) } return s }
const often = long.filter(([, v]) => binomTail(v.filter(isWin).length, v.length, rate) < 0.05).length, seldom = long.filter(([, v]) => 1 - binomTail(v.filter(isWin).length + 1, v.length, rate) < 0.05).length
console.log(`  names winning more often than chance allows (p < 5%): ${often} (chance: ~${(long.length * 0.05).toFixed(0)}) · less often: ${seldom}`)
console.log(`  the most frequent winners: ${long.sort((a, b) => b[1].filter(isWin).length / b[1].length - a[1].filter(isWin).length / a[1].length).slice(0, 15).map(([s, v]) => `${s} ${v.filter(isWin).length}/${v.length}`).join(' · ')}`)
console.log(`  the least: ${long.slice(-10).map(([s, v]) => `${s} ${v.filter(isWin).length}/${v.length}`).join(' · ')}`)
const both = long.map(([, v]) => [v.filter(r => r.day < SPLIT), v.filter(r => r.day >= SPLIT)]).filter(([a, b]) => a.length >= 8 && b.length >= 6)
const third = (xs) => { const s = [...xs].sort((a, b) => a[0] - b[0]); return [s.slice(0, Math.floor(s.length / 3)), s.slice(Math.floor(2 * s.length / 3))] }
const [lo, hi] = third(both.map(([a, b]) => [a.filter(isWin).length / a.length, b.filter(isWin).length / b.length]))
console.log(`  does it carry? the third of names that won LEAST in 2020–2023 won ${(mean(lo.map(x => x[1])) * 100).toFixed(0)}% of 2024 → quarters; the third that won MOST, ${(mean(hi.map(x => x[1])) * 100).toFixed(0)}%`)

// ── BETA AND THE MARKET
console.log('\n── BETA AND THE MARKET: winners\' beta (252 sessions to the start) by what SPY did that quarter')
for (const [label, p] of [['SPY up 5%+', (r) => r.spyQ >= 5], ['SPY 0…5%', (r) => r.spyQ >= 0 && r.spyQ < 5], ['SPY down', (r) => r.spyQ < 0]]) {
    const ts = rows.filter(p), w = ts.filter(isWin), l = ts.filter(r => r.group === 'lose')
    console.log(`  ${label.padEnd(10)} ${String(ts.length).padStart(5)} · beta median: winners ${n2(median(w.map(r => r.f.beta)))} · losers ${n2(median(l.map(r => r.f.beta)))} · all ${n2(median(ts.map(r => r.f.beta)))} · winners ${share(ts, isWin)}`)
}
const bc = rows.map(r => r.f.beta).filter(Number.isFinite).sort((a, b) => a - b), bq = [1, 2, 3, 4].map(q => bc[Math.floor(q * bc.length / 5)])
for (let b = 0; b < 5; b++) {
    const ts = rows.filter(r => Number.isFinite(r.f.beta) && bq.filter(c => r.f.beta >= c).length === b)
    const up = ts.filter(r => r.spyQ >= 5), dn = ts.filter(r => r.spyQ < 0)
    console.log(`  beta Q${b + 1} (${n2(b ? bq[b - 1] : bc[0], 0)}…): winners when SPY up 5%+ ${share(up, isWin)} · when SPY down ${share(dn, isWin)} · overall ${share(ts, isWin)}`)
}

// ── THEMES
console.log('\n── THEMES: each quarter\'s most over-represented industries among its winners (4+ members, lift = share of winners / share of members)')
const lifts = []
for (const x of Q) {
    const ts = rows.filter(r => r.q === x.q && r.industry !== 'unknown'), w = ts.filter(isWin)
    const by = new Map()
    for (const r of ts) { const k = r.industry; if (!by.has(k)) by.set(k, { n: 0, w: 0 }); by.get(k).n++; if (isWin(r)) by.get(k).w++ }
    const list = [...by].filter(([, v]) => v.n >= 4).map(([k, v]) => ({ k, n: v.n, w: v.w, rate: v.w / v.n })).sort((a, b) => b.rate - a.rate || b.n - a.n)
    const top3 = list.slice(0, 3), inTop = top3.reduce((a, z) => a + z.w, 0), memTop = top3.reduce((a, z) => a + z.n, 0)
    lifts.push({ q: x.q, list, winShare: inTop / w.length, memShare: memTop / ts.length })
    console.log(`  ${x.q} (${w.length} winners): ${top3.map(z => `${z.k} ${z.w}/${z.n}`).join(' · ')} — top 3 hold ${(inTop / w.length * 100).toFixed(0)}% of winners, ${(memTop / ts.length * 100).toFixed(0)}% of members`)
}
// Hot next quarter? An industry in a quarter's top fifth by win rate: its win rate the quarter after.
const hot = [], cold = []
for (let n = 0; n + 1 < lifts.length; n++) {
    const cur = lifts[n].list, next = new Map(lifts[n + 1].list.map(z => [z.k, z]))
    const cut = Math.floor(cur.length / 5)
    for (const z of cur.slice(0, cut)) if (next.has(z.k)) hot.push(next.get(z.k))
    for (const z of cur.slice(-cut)) if (next.has(z.k)) cold.push(next.get(z.k))
}
const pooled = (zs) => zs.reduce((a, z) => a + z.w, 0) / zs.reduce((a, z) => a + z.n, 0)
console.log(`  the quarter after: industries in the top fifth by win rate win ${(pooled(hot) * 100).toFixed(0)}% · the bottom fifth ${(pooled(cold) * 100).toFixed(0)}% · base ${(rate * 100).toFixed(0)}%`)

// ── SIZE OF THE WIN
console.log('\n── HOW BIG')
const W = rows.filter(isWin)
for (const [a, b] of [[5, 10], [10, 20], [20, 50], [50, Infinity]]) console.log(`  +${a}${b === Infinity ? '%+' : `–${b}%`}: ${share(W, r => r.net >= a && r.net < b)} of winners`)
console.log(`  the 50%+: ${W.filter(r => r.net >= 50).sort((a, b) => b.net - a.net).slice(0, 30).map(r => `${r.symbol} ${r.q} ${f2(r.net, 0)}`).join(' · ')}`)
console.log(`  their industries: ${(() => { const m = new Map(); for (const r of W.filter(z => z.net >= 50)) m.set(r.industry, (m.get(r.industry) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(' · ') })()}`)

// ── THE PORTRAIT
console.log('\n── THE PORTRAIT: medians, winners / all members / losers')
const P = [['market cap $B', (r) => (r.f.mcap_log == null ? null : 10 ** r.f.mcap_log / 1e9)], ['beta', (r) => r.f.beta], ['volatility (20d sd %)', (r) => r.f.volatility],
    ['revenue growth %', (r) => r.f.rev_growth], ['net margin %', (r) => r.f.margin], ['price/sales', (r) => r.f.ps], ['earnings yield %', (r) => r.f.earn_yield],
    ['vs 20-day avg %', (r) => r.f.vs_sma20], ['vs 52w high %', (r) => r.f.from_high252]]
for (const [label, v] of P) console.log(`  ${label.padEnd(22)} ${n2(median(W.map(v)), 9)} ${n2(median(rows.map(v)), 9)} ${n2(median(rows.filter(r => r.group === 'lose').map(v)), 9)}`)
const L = rows.filter(r => r.group === 'lose')
console.log(`  inside: beat revenue ${share(W.filter(r => r.revBeat != null), r => r.revBeat)} / ${share(rows.filter(r => r.revBeat != null), r => r.revBeat)} / ${share(L.filter(r => r.revBeat != null), r => r.revBeat)} · beat EPS ${share(W.filter(r => r.epsBeat != null), r => r.epsBeat)} / ${share(rows.filter(r => r.epsBeat != null), r => r.epsBeat)} / ${share(L.filter(r => r.epsBeat != null), r => r.epsBeat)}`)
console.log('  by sector, share of winners against share of members:')
for (const sec of [...new Set(rows.map(r => r.sector))].sort()) {
    const a = W.filter(r => r.sector === sec).length / W.length, b = rows.filter(r => r.sector === sec).length / rows.length
    console.log(`    ${sec.padEnd(24)} ${(a * 100).toFixed(1).padStart(5)}% of winners · ${(b * 100).toFixed(1).padStart(5)}% of members · lift ${(a / b).toFixed(2)}`)
}
process.exit(0)
