// TECHNICALS AT SESSION 20 — TO 60% WINNERS — test U (declared in screener-lab.md §43, before the run). Roy, 2026-11-07:
// "concentrate on technicals — raise it to at least 60% winners". A winner = a pick whose REST of the quarter (bought at
// the next open) beats SPY after the cost. Every technical fact at the checkpoint; one model fitted on 2020–2023 only,
// scored unchanged on 2024 →.
//
//   node --max-old-space-size=6000 scripts/lab-quarter-technicals.mjs
//
// Offline: data/lab caches + sp500-industries.json.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { costFor, testable } = await import('../services/screenerLab.service.js')
const { featuresAt, FEATURES } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const EDGE = 5, SPLIT = '2024-01-01', FIRST_Q = '2020-Q1', LAST_Q = '2026-Q3', CHECKS = [15, 20, 25], MAIN = 20
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const industry = JSON.parse(fs.readFileSync('data/lab/sp500-industries.json', 'utf8'))
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()

const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null)
const qOf = (d) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
const quarters = []
for (const d of data.spyDays) {
    const q = qOf(d), cur = quarters.at(-1)
    if (cur?.q === q) { cur.last = d; cur.days.push(d) } else quarters.push({ q, first: d, last: d, days: [d], base: cur?.last ?? null })
}
const Q = quarters.filter(x => x.base && x.q >= FIRST_Q && x.q <= LAST_Q)
const spyC = (d) => data.spyByDay.get(d)?.close, spyO = (d) => data.spyByDay.get(d)?.open
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }

function rsi(rows, k, n = 14) {
    if (k < n) return null
    let g = 0, l = 0
    for (let d = k - n + 1; d <= k; d++) { const c = rows[d].close - rows[d - 1].close; if (c > 0) g += c; else l -= c }
    return g + l > 0 ? 100 * g / (g + l) : 50
}
function beta(s, j, n = 252) {
    if (j < n) return null
    const xs = [], ys = []
    for (let d = j - n + 1; d <= j; d++) {
        const m = pct(spyC(s.ind.date[d]), spyC(s.ind.date[d - 1])), r = pct(s.rows[d].close, s.rows[d - 1].close)
        if (m != null && r != null) { xs.push(m); ys.push(r) }
    }
    if (xs.length < n * 0.8) return null
    const mx = mean(xs), my = mean(ys)
    let c = 0, v = 0
    for (let k = 0; k < xs.length; k++) { c += (xs[k] - mx) * (ys[k] - my); v += (xs[k] - mx) ** 2 }
    return v > 0 ? c / v : null
}

const PRICE = FEATURES.filter(k => !['gap_open', 'report_in_week', 'days_since_report', 'last_surprise', 'last_reaction', 'beats_last3'].includes(k))
const QTD = ['qtd_own', 'qtd_industry', 'qtd_vs_industry', 'qtd_up_share', 'qtd_worst_dip', 'qtd_smooth', 'qtd_best_share', 'vs_prev_q_high', 'qtd_volume', 'rsi14', 'beta']
const ALL = [...PRICE, ...QTD]

const obs = []
for (const x of Q) {
    const sb = spyC(x.base), se = spyC(x.last)
    for (const [symbol, s] of data.names) {
        if (!member(symbol, x.first)) continue
        const at = new Map(s.ind.date.map((d, n) => [d, n]))
        const j = at.get(x.base), e = at.get(x.last)
        if (j == null || e == null || j < 320) continue
        const final = pct(s.rows[e].close, s.rows[j].close) - pct(se, sb)
        const b = beta(s, j)
        for (const c of CHECKS) {
            const dc = x.days[c - 1], dn = x.days[c]
            if (!dc || !dn) continue
            const kc = at.get(dc), kn = at.get(dn)
            if (kc == null || kn == null || kc - j !== c || !(s.rows[kn].open > 0) || !testable(s.rows, kn, s.ind)) continue
            const rest = pct(s.rows[e].close, s.rows[kn].open) - pct(se, spyO(dn)) - costFor(s.ind.adv20[kc] ?? 0)
            if (!Number.isFinite(rest) || !Number.isFinite(final)) continue
            const f = featuresAt(s, data, kc, kn, kn), ex = []
            for (let d = j + 1; d <= kc; d++) ex.push(pct(s.rows[d].close, s.rows[d - 1].close) - pct(spyC(s.ind.date[d]), spyC(s.ind.date[d - 1])))
            let cum = 0, low = 0
            for (const v of ex) { cum += v; low = Math.min(low, cum) }
            const m = mean(ex), sd = Math.sqrt(mean(ex.map(v => (v - m) ** 2)))
            const prevHigh = Math.max(...s.rows.slice(j - 62, j + 1).map(r => r.high))
            const vq = mean(s.rows.slice(j + 1, kc + 1).map(r => r.volume || 0)), v60 = mean(s.rows.slice(j - 59, j + 1).map(r => r.volume || 0))
            Object.assign(f, {
                qtd_own: pct(s.rows[kc].close, s.rows[j].close) - pct(spyC(dc), sb), qtd_up_share: ex.filter(v => v > 0).length / ex.length,
                qtd_worst_dip: low, qtd_smooth: sd > 0 ? m / sd : null, qtd_best_share: cum > 0 ? Math.max(...ex) / cum : null,
                vs_prev_q_high: pct(s.rows[kc].close, prevHigh), qtd_volume: v60 > 0 ? vq / v60 : null, rsi14: rsi(s.rows, kc), beta: b,
            })
            obs.push({ q: x.q, day: x.first, c, symbol, industry: industry[symbol] ?? null, rest, final, f })
        }
    }
}
// The industry's quarter so far (the name left out), and the median member's rest per quarter and checkpoint.
const grp = new Map(), byQC = new Map()
for (const o of obs) {
    const k = `${o.q} ${o.c}`
    if (!byQC.has(k)) byQC.set(k, []); byQC.get(k).push(o)
    if (o.industry) { const g = `${k} ${o.industry}`; if (!grp.has(g)) grp.set(g, []); grp.get(g).push(o) }
}
for (const list of grp.values()) {
    if (list.length < 4) continue
    for (const o of list) { o.f.qtd_industry = median(list.filter(z => z !== o).map(z => z.f.qtd_own)); o.f.qtd_vs_industry = o.f.qtd_own - o.f.qtd_industry }
}
const medRest = new Map([...byQC].map(([k, l]) => [k, median(l.map(o => o.rest))]))
for (const o of obs) { o.win = o.rest > 0; o.beatMed = o.rest > medRest.get(`${o.q} ${o.c}`); o.finalWin = o.final >= EDGE }

const f2 = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const share = (ts, p) => (ts.length ? `${(ts.filter(p).length / ts.length * 100).toFixed(1)}%` : '—').padStart(6)
const tOf = (xs) => { const v = xs.filter(Number.isFinite); if (v.length < 3) return null; const m = mean(v), sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(v.length)) : null }
function auc(ts, key) {
    const v = ts.filter(t => Number.isFinite(t.f[key])).map(t => ({ x: t.f[key], w: t.win })).sort((a, b) => a.x - b.x)
    let sumW = 0, nW = 0
    for (let n = 0; n < v.length;) { let m = n; while (m < v.length && v[m].x === v[n].x) m++; const r = (n + 1 + m) / 2; for (let q = n; q < m; q++) if (v[q].w) { sumW += r; nW++ } n = m }
    const nL = v.length - nW
    return nW && nL ? (sumW - nW * (nW + 1) / 2) / (nW * nL) : null
}

const at20 = obs.filter(o => o.c === MAIN), before = at20.filter(o => o.day < SPLIT), after = at20.filter(o => o.day >= SPLIT)
console.log(`${obs.length} picks-in-waiting (sessions ${CHECKS.join('/')}) · at session ${MAIN}: ${at20.length}`)
console.log(`  the base at session ${MAIN}: winners (rest beats SPY after cost) ${share(before, o => o.win)} → ${share(after, o => o.win)} · beat the median member ${share(before, o => o.beatMed)} → ${share(after, o => o.beatMed)} · whole quarter 5%+ ${share(before, o => o.finalWin)} → ${share(after, o => o.finalWin)}`)

console.log(`\n── EACH TECHNICAL at session ${MAIN}: AUC for a winner (rest beats SPY), 2020–2023 → 2024 →`)
const rowsA = ALL.map(k => ({ k, a1: auc(before, k), a2: auc(after, k) })).sort((p, q) => Math.abs(q.a1 - 0.5) + Math.abs(q.a2 - 0.5) - Math.abs(p.a1 - 0.5) - Math.abs(p.a2 - 0.5))
for (const r of rowsA) {
    const same = (r.a1 - 0.5) * (r.a2 - 0.5) > 0 && Math.abs(r.a1 - 0.5) >= 0.02 && Math.abs(r.a2 - 0.5) >= 0.02
    console.log(`  ${same ? '◆' : ' '} ${r.k.padEnd(16)} ${r.a1?.toFixed(3)} → ${r.a2?.toFixed(3)}`)
}

// moverDiff's fitAndScore, the same logistic fit (clipped at ±4 sd, 300 epochs), but keeping each pick's score: the
// held-out top fifth is taken PER QUARTER, so one quarter's mood does not pick the whole fifth.
function fitScores(c) {
    const ts = obs.filter(o => o.c === c), train = ts.filter(o => o.day < SPLIT), test = ts.filter(o => o.day >= SPLIT)
    const mu = {}, sd = {}
    ALL.forEach((k) => { const xs = train.map(o => o.f[k]).filter(Number.isFinite); mu[k] = mean(xs) ?? 0; const v = xs.length > 1 ? xs.reduce((s, x) => s + (x - mu[k]) ** 2, 0) / (xs.length - 1) : 1; sd[k] = Math.sqrt(v) || 1 })
    const vec = (o) => ALL.map(k => Math.max(-4, Math.min(4, Number.isFinite(o.f[k]) ? (o.f[k] - mu[k]) / sd[k] : 0)))
    const X = train.map(vec), y = train.map(o => (o.win ? 1 : 0)), w = new Array(ALL.length).fill(0)
    let b = 0
    const sig = (z) => 1 / (1 + Math.exp(-z))
    for (let ep = 0; ep < 300; ep++) {
        const g = new Array(w.length).fill(0)
        let gb = 0
        for (let n = 0; n < X.length; n++) { const p = sig(b + X[n].reduce((s, x, k) => s + x * w[k], 0)), d = p - y[n]; gb += d; for (let k = 0; k < w.length; k++) g[k] += d * X[n][k] }
        b -= 0.1 * gb / X.length
        for (let k = 0; k < w.length; k++) w[k] -= 0.1 * (g[k] / X.length + 0.001 * w[k])
    }
    for (const o of ts) o.s = b + vec(o).reduce((s, x, k) => s + x * w[k], 0)
    return { train, test, w }
}
console.log('\n── THE MODEL (every technical at once, fitted on 2020–2023 only): each held-out quarter\'s own top fifth by score')
const verdict = {}
for (const c of CHECKS) {
    const { train, test, w } = fitScores(c)
    const fifth = (ts) => {
        const out = []
        for (const x of Q) {
            const qs = ts.filter(o => o.q === x.q).sort((p, z) => z.s - p.s)
            if (qs.length < 50) continue
            const top = qs.slice(0, Math.floor(qs.length / 5)), all = qs
            out.push({ top, net: mean(top.map(o => o.rest)), all: mean(all.map(o => o.rest)) })
        }
        return out
    }
    const tr = fifth(train), te = fifth(test), picksTr = tr.flatMap(z => z.top), picksTe = te.flatMap(z => z.top)
    const tt = tOf(te.map(z => z.net - z.all))
    verdict[c] = { hit: picksTe.filter(o => o.win).length / picksTe.length, net: mean(te.map(z => z.net)), all: mean(te.map(z => z.all)), t: tt, trNet: mean(tr.map(z => z.net)), trAll: mean(tr.map(z => z.all)) }
    console.log(`  session ${c}: in-sample (2020–2023) top fifth winners ${share(picksTr, o => o.win)} net ${f2(verdict[c].trNet)} vs every member ${f2(verdict[c].trAll)}`)
    console.log(`              HELD OUT (2024 →) top fifth winners ${share(picksTe, o => o.win)} (base ${share(test, o => o.win)}) · beat the median ${share(picksTe, o => o.beatMed)} · whole quarter 5%+ ${share(picksTe, o => o.finalWin)} (base ${share(test, o => o.finalWin)})`)
    console.log(`              net per quarter ${f2(verdict[c].net)} vs every member ${f2(verdict[c].all)} · top − all t ${tt?.toFixed(2)} over ${te.length} quarters`)
    if (c === MAIN) console.log(`              heaviest weights: ${ALL.map((k, i) => [k, w[i]]).sort((p, z) => Math.abs(z[1]) - Math.abs(p[1])).slice(0, 10).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' · ')}`)
}
const v = verdict[MAIN], same = (c) => verdict[c].net > 0 && verdict[c].net > verdict[c].all
console.log(`\nDECLARED BAR (session ${MAIN}, held out): 60%+ winners ${v.hit >= 0.6} (${(v.hit * 100).toFixed(1)}%) · above SPY ${v.net > 0} · above every member ${v.net > v.all} · t ≥ 2 ${v.t >= 2} · sessions 15 and 25 the same way ${same(15) && same(25)} → ${v.hit >= 0.6 && v.net > 0 && v.net > v.all && v.t >= 2 && same(15) && same(25) ? 'PASS' : 'FAIL'}`)

// STRETCHED DOWN (Roy, after the run: "what about stretched down?") — a description, not part of test U's bar. Each
// quarter's members cut by the distance from the 20-day average at the checkpoint; the deepest tenth split by the 200-day.
console.log('\n── STRETCHED DOWN (added after the run — a description): by distance from the 20-day average, each quarter cut on its own')
const cutBy = (ts, key, lo, hi) => {
    const out = []
    for (const x of Q) {
        const qs = ts.filter(o => o.q === x.q && Number.isFinite(o.f[key])).sort((p, z) => p.f[key] - z.f[key])
        if (qs.length < 50) continue
        out.push({ day: x.first, picks: qs.slice(Math.floor(lo * qs.length), Math.floor(hi * qs.length)), all: mean(qs.map(o => o.rest)) })
    }
    return out
}
const line = (label, rows) => {
    const per = (p) => { const r = rows.filter(p); return { hit: share(r.flatMap(z => z.picks), o => o.win), net: mean(r.map(z => mean(z.picks.map(o => o.rest)))), all: mean(r.map(z => z.all)), n: r.reduce((a, z) => a + z.picks.length, 0) } }
    const b = per(z => z.day < SPLIT), a = per(z => z.day >= SPLIT)
    const t = tOf(rows.map(z => mean(z.picks.map(o => o.rest)) - z.all))
    console.log(`    ${label.padEnd(30)} ${String(b.n).padStart(4)} winners ${b.hit} net ${f2(b.net)} (all ${f2(b.all)}) → ${String(a.n).padStart(4)} winners ${a.hit} net ${f2(a.net)} (all ${f2(a.all)}) · vs all t ${t?.toFixed(2)}`)
}
for (const c of CHECKS) {
    const ts = obs.filter(o => o.c === c)
    console.log(`  session ${c}`)
    line('deepest tenth under the 20d', cutBy(ts, 'vs_sma20', 0, 0.1))
    line('bottom fifth', cutBy(ts, 'vs_sma20', 0, 0.2))
    line('fifth 2', cutBy(ts, 'vs_sma20', 0.2, 0.4))
    line('fifth 3', cutBy(ts, 'vs_sma20', 0.4, 0.6))
    line('fifth 4', cutBy(ts, 'vs_sma20', 0.6, 0.8))
    line('top fifth (stretched up)', cutBy(ts, 'vs_sma20', 0.8, 1))
    const deep = cutBy(ts, 'vs_sma20', 0, 0.2)
    line('bottom fifth, ABOVE the 200d', deep.map(z => ({ ...z, picks: z.picks.filter(o => o.f.vs_sma200 > 0) })))
    line('bottom fifth, BELOW the 200d', deep.map(z => ({ ...z, picks: z.picks.filter(o => o.f.vs_sma200 <= 0) })))
}
process.exit(0)
