// LAB (2026-11-21, Roy: "the most fit horizon, the typical R:R, the risk" — "run a fast lab on 100 names").
// Can Proteus recommend HOW to trade a name — its horizon (swing / long term) and its reward : risk — from its own past?
// Pick on the FIRST five years, check on the LAST five, against holding. Long side only.
//   node scripts/lab-proteus-fit.mjs            (daily bars cached in data/tmp/lab-fit-bars.json)
import dns from 'dns'
dns.setServers(['8.8.8.8', '1.1.1.1'])
import 'dotenv/config'
import fs from 'fs'
const { fetchScaleBars } = await import('../services/stockProfile.service.js')
const { SCALES, RATIOS, scaleProfile, sigmaSeries, pairRecord, weeklyOf } = await import('../services/stockProfile.engine.js')

const NAMES = `AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO ORCL ADBE CRM AMD INTC CSCO QCOM TXN IBM NOW INTU MU
JPM BAC WFC C GS MS SCHW AXP BLK SPGI V MA PYPL COF USB PNC TFC MET AIG CB
JNJ UNH LLY PFE MRK ABBV TMO ABT DHR BMY AMGN GILD CVS MDT ISRG SYK CI HUM VRTX REGN
XOM CVX COP SLB EOG OXY PSX MPC VLO KMI
KO PEP PG WMT COST MCD SBUX NKE HD LOW TGT CL KMB MO PM MDLZ GIS
CAT DE BA GE HON UPS FDX LMT RTX MMM UNP NEE DUK SO D`.split(/\s+/).filter(Boolean)

const CACHE = 'data/tmp/lab-fit-bars.json'
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {}
async function daily(sym) {
    if (cache[sym]) return cache[sym]
    const got = await fetchScaleBars(sym, { scales: ['swing'] })
    cache[sym] = got.swing.map(b => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close }))
    return cache[sym]
}
for (let k = 0; k < NAMES.length; k += 5) {
    await Promise.all(NAMES.slice(k, k + 5).map(s => daily(s).catch(e => { console.error(s, e.message) })))
}
fs.mkdirSync('data/tmp', { recursive: true })
fs.writeFileSync(CACHE, JSON.stringify(cache))

const margin = (r) => (r?.enough && Number.isFinite(r.per_bar) && Number.isFinite(r.hold_per_bar) ? r.per_bar - r.hold_per_bar : null)
const expR = (r, R) => (r?.enough ? r.win * R - (1 - r.win - r.never) : null)

/** One name, one scale → the first half's table and the second half's, on the FIRST half's stop. */
function halves(bars, cfg) {
    if (bars.length < 2 * (cfg.look + cfg.line + 20)) return null
    const h = Math.floor(bars.length / 2)
    const first = scaleProfile(bars.slice(0, h), cfg)
    const lv = first?.enough ? first.levels.long : null
    if (!lv?.enough) return null
    const sig = sigmaSeries(bars, cfg, null)
    const test = {}
    for (const R of RATIOS) test[R] = pairRecord(bars, sig, cfg, null, lv.stop_sig, R * lv.stop_sig, { from: h })
    return { stop_sig: lv.stop_sig, stop_pct_now: lv.stop_sig * (sig.at(-1) ?? NaN), pick: lv.ratios, test }
}

const rows = []
for (const sym of NAMES) {
    const d = cache[sym]
    if (!d?.length) continue
    const sc = { swing: halves(d, SCALES.swing), long: halves(weeklyOf(d), SCALES.long) }
    rows.push({ sym, sc })
}

// ── 1. the pick: the (scale, ratio) that beat holding by most in the first half ───────────────────────────────────────
const RS = RATIOS.slice().sort((a, b) => a - b)
function pickOf(row, { plateau = 0 } = {}) {
    let best = null
    for (const s of ['swing', 'long']) {
        const t = row.sc[s]
        if (!t) continue
        for (const R of RS) {
            const m = margin(t.pick[R])
            if (m == null || m <= 0) continue
            if (plateau) { // R and its neighbours on both sides (where they exist) also beat holding
                const k = RS.indexOf(R), nb = [RS[k - 1], RS[k + 1]].filter(x => x != null)
                if (nb.filter(x => (margin(t.pick[x]) ?? -1) > 0).length < Math.min(plateau, nb.length)) continue
            }
            if (!best || m > best.m) best = { s, R, m }
        }
    }
    return best
}

let base = 0, baseN = 0
for (const r of rows) for (const s of ['swing', 'long']) for (const R of RS) { const m = margin(r.sc[s]?.test[R]); if (m != null) { baseN++; if (m > 0) base++ } }
const pc = (a, b) => (b ? `${(100 * a / b).toFixed(0)}% (${a}/${b})` : '—')
console.log(`\n${rows.length} names with data. Long side; picked on the first ~5 years, checked on the last ~5.`)
console.log(`BASELINE — any scale & ratio beat holding in the second half: ${pc(base, baseN)}`)

for (const plateau of [0, 2]) {
    let n = 0, beat = 0, none = 0, noneBeat = 0, noneN = 0, sameScale = 0, sameN = 0, rNear = 0
    for (const r of rows) {
        const p = pickOf(r, { plateau })
        if (!p) {
            none++
            for (const s of ['swing', 'long']) for (const R of RS) { const m = margin(r.sc[s]?.test[R]); if (m != null) { noneN++; if (m > 0) noneBeat++ } }
            continue
        }
        const m = margin(r.sc[p.s].test[p.R])
        if (m == null) continue
        n++; if (m > 0) beat++
        // the second half's own best: same scale? a ratio within one step?
        let b2 = null
        for (const s of ['swing', 'long']) for (const R of RS) { const mm = margin(r.sc[s]?.test[R]); if (mm != null && (!b2 || mm > b2.m)) b2 = { s, R, m: mm } }
        if (b2) { sameN++; if (b2.s === p.s) sameScale++; if (b2.s === p.s && Math.abs(RS.indexOf(b2.R) - RS.indexOf(p.R)) <= 1) rNear++ }
    }
    console.log(`\nPICK${plateau ? ' (only where the neighbouring ratios beat holding too)' : ''}:`)
    console.log(`  a name gets a pick: ${pc(n, n + none)}; the pick beat holding in the second half: ${pc(beat, n)}  (baseline above)`)
    console.log(`  names with NO pick (holding beat every trade in the first half): any trade beat holding in the second: ${pc(noneBeat, noneN)}`)
    console.log(`  the second half's own best was on the SAME scale: ${pc(sameScale, sameN)}; and within one ratio step: ${pc(rNear, sameN)}`)
}

// ── 2. per scale: does "trading beat holding" carry from the first half to the second? ────────────────────────────────
for (const s of ['swing', 'long']) {
    const t = { yy: 0, yn: 0, ny: 0, nn: 0 }
    for (const r of rows) for (const R of RS) {
        const a = margin(r.sc[s]?.pick[R]), b = margin(r.sc[s]?.test[R])
        if (a == null || b == null) continue
        t[(a > 0 ? 'y' : 'n') + (b > 0 ? 'y' : 'n')]++
    }
    console.log(`\n${s.toUpperCase()} — beat holding, first half → second half (every name × ratio):`)
    console.log(`  beat → beat ${pc(t.yy, t.yy + t.yn)}   ·   did not → beat ${pc(t.ny, t.ny + t.nn)}`)
}

// ── 3. the typical R:R as expectancy: does the first half's best ratio stay best-ish? ────────────────────────────────
for (const s of ['swing', 'long']) {
    let n = 0, keep = 0, rank = []
    for (const r of rows) {
        const t = r.sc[s]
        if (!t) continue
        const a = RS.filter(R => expR(t.pick[R], R) != null), b = RS.filter(R => expR(t.test[R], R) != null)
        if (a.length < 4 || b.length < 4) continue
        const best1 = a.reduce((x, y) => (expR(t.pick[y], y) > expR(t.pick[x], x) ? y : x))
        const order2 = b.slice().sort((x, y) => expR(t.test[y], y) - expR(t.test[x], x))
        n++; const k = order2.indexOf(best1); if (k >= 0) rank.push(k); if (k >= 0 && k < 3) keep++
    }
    rank.sort((a, b) => a - b)
    console.log(`\n${s.toUpperCase()} — the first half's best R by expectancy (R per trade): in the second half's top 3 of 8: ${pc(keep, n)} (chance ≈ 38%); median rank ${rank[rank.length >> 1] + 1} of 8`)
}

// ── 4. the risk: does the first half's stop % (scaled to today's σ) stay a normal pullback? ──────────────────────────
for (const s of ['swing', 'long']) {
    const sh = []
    for (const r of rows) { const t = r.sc[s]; if (!t) continue; const w = t.test[1]; if (w?.enough) sh.push(1 - w.win - w.never) }
    sh.sort((a, b) => a - b)
    console.log(`${s.toUpperCase()} — at 1:1 on the first half's stop, the stop hit first in the second half: median ${(100 * sh[sh.length >> 1]).toFixed(0)}% (names ${sh.length})`)
}
process.exit(0)
