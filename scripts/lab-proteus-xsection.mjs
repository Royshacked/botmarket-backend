#!/usr/bin/env node
// OUR SIGNALS, MEASURED THREE OTHER WAYS (Roy, 2026-11-21) — declared in docs/design/proteus.md §10.13 before the run:
//   (1) forward returns at 5 / 20 / 60 bars net of SPY, against every 5th bar;
//   (3) the excursions over 20 bars (MFE − MAE, in ATRs), against every 5th bar;
//   (7) the cross-section: every 21st SPY session, 14 measures ranked across all names against the next 21 / 63
//       sessions' return net of SPY (Spearman IC, top-minus-bottom fifth).
// Daily, 10 years, ~1,177 names; every series also shuffled (dates kept). Older / recent split at 2023-07-01.
//
//   node --max-old-space-size=8000 scripts/lab-proteus-xsection.mjs   → data/lab/proteus-xsection.out.txt

import fs from 'fs'
import readline from 'readline'
import { E, P, atrsOf, calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries, seedOf, dailyNames10y } from './lab-proteus.shared.mjs'
import { signals, ichimoku, TESTS as SIG_TESTS } from './lab-proteus-signals.mjs'

const SPLIT = Date.parse('2023-07-01T00:00:00Z') / 1000
const HORIZONS = [5, 20, 60]
const SPACING = 10, BASE_EVERY = 5, MIN_BARS = 260
const SHORT = new Set(['R3', 'R4', 'M4', 'M5', 'M6'])

const OWN = [
    { key: 'T20', label: 'T20. the 20 EMA touched from above' }, { key: 'T50', label: 'T50. the 50 SMA touched from above' },
    { key: 'T200', label: 'T200. the 200 SMA touched from above' }, { key: 'RSI30', label: 'RSI30. RSI 14 crossing under 30' },
    { key: 'MACDU', label: 'MACD↑. the MACD line crossing up' }, { key: 'VUP', label: 'VUP. an up bar on 2× volume' },
    { key: 'SWEEP', label: 'SWEEP. a swing low\'s false break, at the reclaim' }, { key: 'SPRING', label: 'SPRING. a Wyckoff spring' },
]
export const SIGNALS = [...OWN, ...SIG_TESTS.map(t => ({ key: t.key, label: t.label }))]

export const MEASURES = ['rsi14', 'rsi2', 'macd_hist', 'd_ema20', 'd_sma50', 'd_sma200', 'd_cloud', 'squeeze', 'gap', 'ret_1m', 'mom_12_1', 'hi_52w', 'atr_pct', 'vol_20_60']

/** SPY's closes by timestamp — the first line of the 10-year file. */
async function loadSpy(file = 'data/lab/screener-10y.jsonl') {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
        const { symbol, b } = JSON.parse(line)
        if (symbol === 'SPY') { rl.close(); return b.map(([t, , , , c]) => [t, c]).sort((x, y) => x[0] - y[0]) }
    }
    throw new Error('no SPY in the file')
}

/** Events one per SPACING bars, in order. */
const spaced = (idx) => { const out = []; let last = -Infinity; for (const i of [...idx].sort((a, b) => a - b)) if (i - last >= SPACING) { out.push(i); last = i } return out }

/** One series → { events: key → [i], measures at each rebalance index }. The signals known at their bar's close. Pure. */
export function eventsOf(bars, opts = P) {
    const atrs = atrsOf(bars), closes = bars.map(b => b.close), n = bars.length
    const cut = Math.floor(n * (1 - opts.recentShare))
    const drift = E.driftOutcomes(bars, atrs, opts)
    const fb = E.falseBreaks(bars, atrs, cut, drift, opts)
    const wy = E.wyckoffTest(bars, atrs, cut, drift, fb.sweeps, opts)
    const ema20 = calcEMASeries(closes, 20), sma50 = calcSMASeries(closes, 50), sma200 = calcSMASeries(closes, 200)
    const rsi = calcRSISeries(closes, 14)
    const { line, signal } = calcMACDSeries(closes)
    const vol20 = calcSMASeries(bars.map(b => b.volume ?? 0), 20)
    const touches = (lv) => E.levelTouches(bars, lv, atrs, opts).map(e => e.i)
    const where = (pred) => { const out = []; for (let i = 1; i < n; i++) if (pred(i)) out.push(i); return out }
    const ev = {
        T20: touches(ema20), T50: touches(sma50), T200: touches(sma200),
        RSI30: where(i => rsi[i - 1] != null && rsi[i - 1] >= opts.rsiLow && rsi[i] < opts.rsiLow),
        MACDU: where(i => line[i - 1] != null && signal[i - 1] != null && line[i - 1] <= signal[i - 1] && line[i] > signal[i]),
        VUP: where(i => vol20[i - 1] > 0 && (bars[i].volume ?? 0) >= opts.rvol * vol20[i - 1] && bars[i].close > bars[i].open),
        SWEEP: fb.sweeps.map(s => s.i),
        SPRING: (wy.spring_events ?? []).map(s => s.i),
    }
    const { d } = signals(bars, opts)
    for (const t of SIG_TESTS) ev[t.key] = d[t.key].event.map(e => e.i)
    for (const k of Object.keys(ev)) ev[k] = spaced(ev[k])
    return { ev, atrs, closes, ema20, sma50, sma200, rsi, line, signal }
}

/** The 14 measures at bar i (null where a part is not known yet). Pure. */
export function measuresAt(bars, i, s, extra) {
    const c = bars[i].close, a = s.atrs[i]
    if (!(a > 0) || i < MIN_BARS) return null
    const hi = Math.max(...bars.slice(i - 251, i + 1).map(b => b.high))
    const hist = s.line[i] != null && s.signal[i] != null ? (s.line[i] - s.signal[i]) / c : null
    const w = extra.width.slice(i - 119, i + 1).filter(Number.isFinite)
    const wLo = Math.min(...w), wHi = Math.max(...w)
    return {
        rsi14: s.rsi[i], rsi2: extra.rsi2[i], macd_hist: hist,
        d_ema20: (c - s.ema20[i]) / a, d_sma50: (c - s.sma50[i]) / a, d_sma200: Number.isFinite(s.sma200[i]) ? (c - s.sma200[i]) / a : null,
        d_cloud: extra.cloudTop[i] != null ? (c - extra.cloudTop[i]) / a : null,
        squeeze: Number.isFinite(extra.width[i]) && wHi > wLo ? (extra.width[i] - wLo) / (wHi - wLo) : null,
        gap: s.atrs[i - 1] > 0 ? (bars[i].open - bars[i - 1].close) / s.atrs[i - 1] : null,
        ret_1m: c / bars[i - 21].close - 1, mom_12_1: bars[i - 21].close / bars[i - 252].close - 1, hi_52w: c / hi,
        atr_pct: a / c, vol_20_60: extra.vol60[i] > 0 ? extra.vol20[i] / extra.vol60[i] : null,
    }
}

function makeAcc() { return { ev: {}, base: {} } }
const push = (o, k, v) => { (o[k] ??= []).push(v) }

/** Run one series into the accumulators: per signal and horizon, the event and baseline values; and the cross-section rows. */
function run(acc, xs, bars, spy, rebal) {
    const n = bars.length
    if (n < MIN_BARS + 70) return
    const s = eventsOf(bars)
    const ts = bars.map(b => b.timestamp)
    const excess = (i, h) => {
        if (i + h >= n) return null
        const a = spy.get(ts[i]), b = spy.get(ts[i + h])
        if (a == null || b == null) return null
        return (bars[i + h].close / bars[i].close - 1) - (b / a - 1)
    }
    const excursion = (i) => {
        const a = s.atrs[i]
        if (!(a > 0) || i + 20 >= n) return null
        let hi = -Infinity, lo = Infinity
        for (let k = i + 1; k <= i + 20; k++) { hi = Math.max(hi, bars[k].high); lo = Math.min(lo, bars[k].low) }
        return ((hi - bars[i].close) - (bars[i].close - lo)) / a
    }
    const part = (i) => (ts[i] < SPLIT ? 'older' : 'recent')
    const record = (o, key, i, sign) => {
        for (const h of HORIZONS) { const x = excess(i, h); if (x != null) push(o, `${key}|r${h}|${part(i)}`, sign * x) }
        const m = excursion(i); if (m != null) push(o, `${key}|mfe|${part(i)}`, sign * m)
    }
    for (const sig of SIGNALS) {
        const sign = SHORT.has(sig.key) ? -1 : 1
        for (const i of s.ev[sig.key]) if (i >= MIN_BARS) record(acc.ev, sig.key, i, sign)
    }
    // The baseline: every 5th bar, measured both ways (a short signal is judged against the signed baseline).
    for (let i = MIN_BARS; i < n; i += BASE_EVERY) { record(acc.base, 'long', i, 1); record(acc.base, 'short', i, -1) }

    // The cross-section: the measures at each rebalance date this name has, with the forward excess returns.
    const closes = s.closes
    const sma20 = calcSMASeries(closes, 20)
    const width = closes.map((_, i) => { if (i < 19) return null; const w = closes.slice(i - 19, i + 1), m = sma20[i]; return m ? 4 * Math.sqrt(w.reduce((q, x) => q + (x - m) ** 2, 0) / 20) / m : null })
    const extra = { rsi2: calcRSISeries(closes, 2), width, cloudTop: ichimoku(bars).top, vol20: calcSMASeries(bars.map(b => b.volume ?? 0), 20), vol60: calcSMASeries(bars.map(b => b.volume ?? 0), 60) }
    const at = new Map(ts.map((t, i) => [t, i]))
    for (const [d, t] of rebal) {
        const i = at.get(t)
        if (i == null) continue
        const m = measuresAt(bars, i, s, extra)
        if (!m) continue
        const f21 = excess(i, 21), f63 = excess(i, 63)
        if (f21 == null) continue
        ;(xs[d] ??= []).push({ m, f21, f63 })
    }
}

// ─── Statistics ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
const meanVar = (xs) => { const n = xs.length; const m = xs.reduce((a, b) => a + b, 0) / n; return { n, m, v: xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1) } }

/** Event vs baseline, winsorized at the 1st / 99th percentile of the two pooled → { d, lo, hi, ne, nb, em, bm }. */
function edge(evVals, baseVals) {
    if (!evVals?.length || !baseVals?.length) return null
    const all = [...evVals, ...baseVals].sort((a, b) => a - b)
    const lo = quantile(all, 0.01), hi = quantile(all, 0.99)
    const w = (xs) => xs.map(x => Math.min(hi, Math.max(lo, x)))
    const e = meanVar(w(evVals)), b = meanVar(w(baseVals))
    const d = e.m - b.m, se = Math.sqrt(e.v / e.n + b.v / b.n)
    return { d, lo: d - 1.96 * se, hi: d + 1.96 * se, ne: e.n, nb: b.n, em: e.m, bm: b.m }
}

const rank = (xs) => { const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); for (let k = 0; k < idx.length;) { let j = k; while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++; for (let q = k; q <= j; q++) r[idx[q][1]] = (k + j) / 2; k = j + 1 } return r }
const pearson = (a, b) => { const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length; let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2 } return da && db ? num / Math.sqrt(da * db) : null }

/** Per measure, per date: the IC and the top-minus-bottom fifth, for one forward horizon. */
function crossSection(xs, dates, measure, fwd) {
    const rows = []
    for (const [d, t] of dates) {
        const pts = (xs[d] ?? []).filter(r => Number.isFinite(r.m[measure]) && Number.isFinite(r[fwd]))
        if (pts.length < 30) continue
        const ic = pearson(rank(pts.map(r => r.m[measure])), rank(pts.map(r => r[fwd])))
        const sorted = [...pts].sort((a, b) => a.m[measure] - b.m[measure]), q = Math.floor(sorted.length / 5)
        const top = sorted.slice(-q).reduce((s, r) => s + r[fwd], 0) / q, bot = sorted.slice(0, q).reduce((s, r) => s + r[fwd], 0) / q
        rows.push({ t, ic, spread: top - bot })
    }
    const sum = (rs) => {
        if (rs.length < 3) return null
        const { n, m, v } = meanVar(rs.map(r => r.ic))
        return { n, ic: m, t: m / Math.sqrt(v / n), spread: rs.reduce((s, r) => s + r.spread, 0) / rs.length }
    }
    return { older: sum(rows.filter(r => r.t < SPLIT)), recent: sum(rows.filter(r => r.t >= SPLIT)) }
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('lab-proteus-xsection.mjs')) {
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const pc = (x, d = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
    const at = (x, d = 3) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`)
    const spyBars = await loadSpy()
    const spy = new Map(spyBars)
    const rebal = spyBars.filter((_, k) => k >= MIN_BARS && k % 21 === 0).map(([t], k) => [k, t])
    say(`# Our signals, measured three other ways (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.13`)
    say(`Split at 2023-07-01. ${rebal.length} rebalance dates. Excess = the name's return minus SPY's over the same sessions.`)

    const acc = { real: makeAcc(), shuf: makeAcc() }, xs = { real: {}, shuf: {} }
    let names = 0
    for await (const [sym, bars] of dailyNames10y()) {
        run(acc.real, xs.real, bars, spy, rebal)
        run(acc.shuf, xs.shuf, E.shuffledBars(bars, E.seededRandom(seedOf(sym))), spy, rebal)
        if (++names % 100 === 0) console.log(`  ${names}`)
        if (process.env.LIMIT && names >= Number(process.env.LIMIT)) break   // a smoke run
    }
    say(`${names} names.`)

    const verdict = {}
    const judge1 = (a, key, metric, part) => edge(a.ev[`${key}|${metric}|${part}`], a.base[`${SHORT.has(key) ? 'short' : 'long'}|${metric}|${part}`])
    say('\n## (1) Forward returns net of SPY — event minus every 5th bar (winsorized 1/99%), [95% interval]; 20 bars decides (≥ +0.50%)')
    for (const s of SIGNALS) {
        say(`\n### ${s.label}${SHORT.has(s.key) ? '  (SHORT — a fall counted as a gain)' : ''}`)
        for (const side of ['real', 'shuf']) for (const part of ['older', 'recent']) {
            const cells = HORIZONS.map(h => { const e = judge1(acc[side], s.key, `r${h}`, part); return e ? `${h}b ${pc(e.d)} [${pc(e.lo)} … ${pc(e.hi)}] n ${e.ne}` : `${h}b —` })
            say(`  ${side.padEnd(4)} ${part.padEnd(6)} ${cells.join(' · ')}`)
        }
        const ok = (side) => ['older', 'recent'].every(part => { const e = judge1(acc[side], s.key, 'r20', part); return e && e.d >= 0.005 && e.lo > 0 })
        verdict[s.key] = { r: ok('real') && !ok('shuf'), rShuf: ok('shuf') }
    }
    say('\n## (3) Excursions over 20 bars — MFE − MAE in ATRs, event minus every 5th bar; decides at ≥ +0.15 ATR')
    for (const s of SIGNALS) {
        const cells = []
        for (const side of ['real', 'shuf']) for (const part of ['older', 'recent']) { const e = judge1(acc[side], s.key, 'mfe', part); cells.push(`${side} ${part} ${e ? `${at(e.d, 2)} [${at(e.lo, 2)} … ${at(e.hi, 2)}]` : '—'}`) }
        say(`  ${s.key.padEnd(6)} ${cells.join(' · ')}`)
        const ok = (side) => ['older', 'recent'].every(part => { const e = judge1(acc[side], s.key, 'mfe', part); return e && e.d >= 0.15 && e.lo > 0 })
        verdict[s.key].m = ok('real') && !ok('shuf'); verdict[s.key].mShuf = ok('shuf')
    }
    say('\n## (7) The cross-section — Spearman IC by date, mean (t), top − bottom fifth; 21 sessions decides (|IC| ≥ 0.02, t ≥ 2; recent same sign, ≥ 0.01)')
    const xv = {}
    for (const mz of MEASURES) {
        const cells = []
        let pass = {}
        for (const side of ['real', 'shuf']) {
            for (const fwd of ['f21', 'f63']) {
                const r = crossSection(xs[side], rebal, mz, fwd)
                cells.push(`${side} ${fwd === 'f21' ? '21d' : '63d'}: older IC ${at(r.older?.ic)} (t ${at(r.older?.t, 1)}) fifths ${pc(r.older?.spread)} · recent IC ${at(r.recent?.ic)} (t ${at(r.recent?.t, 1)}) fifths ${pc(r.recent?.spread)}`)
                if (fwd === 'f21') pass[side] = !!(r.older && r.recent && Math.abs(r.older.ic) >= 0.02 && Math.abs(r.older.t) >= 2 && Math.sign(r.recent.ic) === Math.sign(r.older.ic) && Math.abs(r.recent.ic) >= 0.01)
            }
        }
        xv[mz] = { pass: pass.real && !pass.shuf, shuf: pass.shuf }
        say(`\n### ${mz}\n  ${cells.join('\n  ')}`)
    }

    say('\n## Verdict (the declared PASS)')
    for (const s of SIGNALS) say(`${s.label}: (1) 20-bar return ${verdict[s.key].r ? 'PASS' : 'no'}${verdict[s.key].rShuf ? ' [shuffled passes]' : ''} · (3) excursions ${verdict[s.key].m ? 'PASS' : 'no'}${verdict[s.key].mShuf ? ' [shuffled passes]' : ''}`)
    for (const mz of MEASURES) say(`(7) ${mz}: ${xv[mz].pass ? 'PASS' : 'no'}${xv[mz].shuf ? ' [shuffled passes]' : ''}`)
    fs.writeFileSync('data/lab/proteus-xsection.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-xsection.out.txt')
    process.exit(0)
}
