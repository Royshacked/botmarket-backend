// LAB (2026-11-21, Roy: "five years is a long time — I need it for the next horizon").
// Does what WORKED LATELY on a name keep working for the NEXT trade? Every month, for each name: look back over the last
// L sessions (6 or 12 months) of COMPLETED trades, pick the horizon × ratio that did best against holding, then trade
// that pick over the next month. Against: the other combos over the same month (a random pick beats half of them).
// Stops: the horizon's constant × σ over H (lab-proteus-horizon.mjs); target = ratio × stop; capped at 3 × H; long side.
// Score: (Σ trade return − Σ holding return over the same entries and holds) ÷ Σ sessions held — excess per session.
//   node scripts/lab-proteus-rolling.mjs          (data/tmp/lab-fit-bars.json, from lab-proteus-fit.mjs)
import fs from 'fs'
const { sigmaSeries } = await import('../services/stockProfile.engine.js')
const cache = JSON.parse(fs.readFileSync('data/tmp/lab-fit-bars.json', 'utf8'))

const HS = [{ H: 5, K: 2.08 }, { H: 21, K: 1.73 }, { H: 63, K: 0.94 }]
const RS = [0.33, 0.5, 1, 2, 3]
const COMBOS = HS.flatMap(h => RS.map(R => ({ ...h, R, key: `H${h.H} ${R}:1` })))
const STEP = 21

/** Per entry: trade return, holding return over the same span, sessions held. */
function outcomes(bars, sig, { H, K, R }) {
    const cap = 3 * H, n = bars.length
    const ret = new Float64Array(n).fill(NaN), hold = new Float64Array(n).fill(NaN), held = new Float64Array(n).fill(NaN)
    for (let i = 0; i < n - cap; i++) {
        const s = sig[i]
        if (!(s > 0)) continue
        const c = bars[i].close, stop = c * (1 - K * s), tgt = c * (1 + R * K * s)
        let j = i + 1, r = null
        for (; j <= i + cap; j++) {
            if (bars[j].low <= stop) { r = stop / c - 1; break }
            if (bars[j].high >= tgt) { r = tgt / c - 1; break }
        }
        if (r == null) { j = i + cap; r = bars[j].close / c - 1 }
        ret[i] = r; hold[i] = bars[j].close / c - 1; held[i] = j - i
    }
    return { ret, hold, held }
}
const score = (o, a, b) => { let x = 0, h = 0, d = 0; for (let i = Math.max(0, a); i < b; i++) if (Number.isFinite(o.ret[i])) { x += o.ret[i]; h += o.hold[i]; d += o.held[i] } return d ? (x - h) / d : null }

for (const L of [126, 252]) {
    let picks = 0, beat = 0, rankSum = 0, gap = []
    const hBeat = { n: 0, w: 0 }
    for (const bars of Object.values(cache)) {
        if (bars.length < 1500) continue
        const sigs = Object.fromEntries(HS.map(h => [h.H, sigmaSeries(bars, { unit: h.H, look: 60, session: false }, null)]))
        const outs = COMBOS.map(c => outcomes(bars, sigs[c.H], c))
        for (let t = 400; t + STEP + 3 * 63 < bars.length; t += STEP) {
            // the look-back: entries whose trade is surely closed by t (entered at least 3H before t)
            const back = COMBOS.map((c, k) => score(outs[k], t - 3 * c.H - L, t - 3 * c.H))
            const fwd = COMBOS.map((c, k) => score(outs[k], t, t + STEP))
            if (back.some(x => x == null) || fwd.some(x => x == null)) continue
            const best = back.indexOf(Math.max(...back))
            const others = fwd.filter((_, k) => k !== best)
            picks++
            const below = others.filter(x => x < fwd[best]).length
            if (below > others.length / 2) beat++
            rankSum += 1 + others.filter(x => x > fwd[best]).length
            gap.push(fwd[best] - others.reduce((s, x) => s + x, 0) / others.length)
            // horizon only: the horizon whose combos did best on average lately — does it do best next month?
            const byH = (arr) => HS.map(h => { const v = COMBOS.map((c, k) => (c.H === h.H ? arr[k] : null)).filter(x => x != null); return v.reduce((s, x) => s + x, 0) / v.length })
            const hb = byH(back), hf = byH(fwd)
            const hPick = hb.indexOf(Math.max(...hb))
            hBeat.n++; if (hf[hPick] === Math.max(...hf)) hBeat.w++
        }
    }
    gap.sort((a, b) => a - b)
    const meanGap = gap.reduce((s, x) => s + x, 0) / gap.length
    console.log(`\n══ LOOK BACK ${L} sessions (${L === 126 ? '6' : '12'} months), pick every month, judged on the next month ══`)
    console.log(`  picks: ${picks} (names × months)`)
    console.log(`  the pick (horizon × ratio, ${COMBOS.length} combos) beat most others next month: ${(100 * beat / picks).toFixed(1)}%  (a random pick: 50%)`)
    console.log(`  its average rank next month: ${(rankSum / picks).toFixed(2)} of ${COMBOS.length}  (random: ${((COMBOS.length + 1) / 2).toFixed(1)})`)
    console.log(`  its edge over the others next month: mean ${(meanGap * 1e4).toFixed(2)} bp a session, median ${(gap[gap.length >> 1] * 1e4).toFixed(2)} bp`)
    console.log(`  HORIZON only: the horizon that did best lately was the best next month: ${(100 * hBeat.w / hBeat.n).toFixed(1)}%  (random: 33.3%)`)
}
process.exit(0)
