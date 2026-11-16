#!/usr/bin/env node
// THE MOVES BACKWARDS — ONE COMPANY (Roy, 2026-11-16: "find the movements · look at the chart · how they started · is
// there a common thing — let's try one company"). Declared in docs/design/proteus.md §10.5 before the run. A description.
//
//   node scripts/lab-proteus-moves.mjs [SYMBOL=LNG]   → data/lab/proteus-moves-<SYMBOL>.out.txt

import fs from 'fs'
import readline from 'readline'
import { E, atrsOf, calcSMASeries, calcRSISeries, median, seedOf } from './lab-proteus.shared.mjs'

/** §10.5, fixed before the run. */
export const MOVE = { up: 4, stop: 1, within: 20, recentShare: 1 / 3, shuffles: 20 }

/** Per bar: does a move begin at its close (+up ATR on a high within `within` bars before a close `stop` ATR under)? Pure. */
export function moveBars(bars, atrs, m = MOVE) {
    return bars.map((b, i) => {
        const a = atrs[i]
        if (!Number.isFinite(a) || a <= 0 || i + m.within >= bars.length) return null
        for (let j = i + 1; j <= i + m.within; j++) {
            if (bars[j].high >= b.close + m.up * a) return true
            if (bars[j].close <= b.close - m.stop * a) return false
        }
        return false
    })
}

/** The moves: qualifying bars within `within` of each other are one move, starting at its lowest close. Pure. */
export function moveStarts(bars, flags, m = MOVE) {
    const starts = []
    let group = []
    const flush = () => { if (group.length) starts.push(group.reduce((x, y) => (bars[y].close < bars[x].close ? y : x))); group = [] }
    for (let i = 0; i < flags.length; i++) {
        if (flags[i] !== true) continue
        if (group.length && i - group.at(-1) > m.within) flush()
        group.push(i)
    }
    flush()
    return starts
}

/** The §10.5 facts, per bar (null where not measurable). `spy` = Map(timestamp-day → {close, sma200, hi20}) or null. Pure. */
export function facts(bars, atrs, spy = null) {
    const n = bars.length, c = bars.map(b => b.close), v = bars.map(b => b.volume ?? 0)
    const s50 = calcSMASeries(c, 50), s200 = calcSMASeries(c, 200), rsi = calcRSISeries(c, 14)
    const v20 = calcSMASeries(v, 20), v5 = calcSMASeries(v, 5), v50 = calcSMASeries(v, 50)
    // The latest 2-bar swing low CONFIRMED by bar i (its two right bars closed).
    const swingLow = new Array(n).fill(null)
    for (let i = 4, last = null; i < n; i++) {
        const k = i - 2
        if (bars[k].low < bars[k - 1].low && bars[k].low < bars[k - 2].low && bars[k].low < bars[k + 1].low && bars[k].low < bars[k + 2].low) last = bars[k].low
        swingLow[i] = last
    }
    const day = (t) => new Date(t * 1000).toISOString().slice(0, 10)
    const out = []
    for (let i = 0; i < n; i++) {
        const a = atrs[i]
        if (i < 200 || !Number.isFinite(a) || a <= 0 || s200[i] == null) { out.push(null); continue }
        const win = (k, f) => { for (let j = Math.max(0, i - k + 1); j <= i; j++) if (f(j)) return true; return false }
        let hi20 = -Infinity, lo60 = Infinity, hi10 = -Infinity, lo10 = Infinity
        for (let j = i - 19; j <= i; j++) hi20 = Math.max(hi20, c[j])
        for (let j = i - 9; j <= i; j++) { hi10 = Math.max(hi10, bars[j].high); lo10 = Math.min(lo10, bars[j].low) }
        let downs = 0
        for (let j = i; j > 0 && c[j] < c[j - 1]; j--) downs++
        const atrMed = median(atrs.slice(i - 99, i + 1))
        const b = bars[i], range = b.high - b.low
        const sp = spy?.get(day(b.timestamp))
        out.push({
            swept_low: win(3, j => swingLow[j - 1] != null && bars[j].low < swingLow[j - 1] && c[j] > swingLow[j - 1]),
            new_60_low: win(3, j => { if (j < 60) return false; for (let k = j - 60; k < j; k++) if (c[k] <= c[j]) return false; return true }),
            deep_pullback: hi20 - c[i] >= 3 * a,
            rsi_under_30: win(3, j => rsi[j] != null && rsi[j] < 30),
            down_3_plus: downs >= 3 || (i > 0 && (() => { let d = 0; for (let j = i - 1; j > 0 && c[j] < c[j - 1]; j--) d++; return d >= 3 })()),
            over_200: c[i] > s200[i],
            over_50: s50[i] != null && c[i] > s50[i],
            at_50_or_200: (s50[i] != null && Math.abs(c[i] - s50[i]) <= 0.5 * a) || Math.abs(c[i] - s200[i]) <= 0.5 * a,
            volume_2x: v20[i - 1] > 0 && v[i] >= 2 * v20[i - 1],
            volume_dry: v50[i] > 0 && v5[i] < 0.7 * v50[i],
            atr_squeeze: atrMed > 0 && a < 0.8 * atrMed,
            tight_10: hi10 - lo10 < 3 * a,
            gap_down: b.open <= c[i - 1] - 0.5 * a,
            reversal_bar: range > 0 && b.close > b.open && b.close >= b.low + (2 / 3) * range,
            spy_over_200: sp ? sp.close > sp.sma200 : null,
            spy_pullback_5: sp ? sp.close <= 0.95 * sp.hi20 : null,
        })
    }
    return out
}

export const FACT_WORDS = Object.freeze({
    swept_low: 'swept a swing low (last 3 bars)', new_60_low: 'new 60-bar closing low (last 3)', deep_pullback: '≥ 3 ATR under the 20-bar high',
    rsi_under_30: 'RSI 14 under 30 (last 3)', down_3_plus: '3+ down closes running', over_200: 'close over the 200 SMA',
    over_50: 'close over the 50 SMA', at_50_or_200: 'within 0.5 ATR of the 50/200 SMA', volume_2x: 'volume ≥ 2× its 20-bar avg',
    volume_dry: 'volume dried up (5 < 0.7× 50)', atr_squeeze: 'ATR squeezed (< 0.8× 100-bar median)', tight_10: 'tight 10 bars (< 3 ATR)',
    gap_down: 'gap down ≥ 0.5 ATR', reversal_bar: 'reversal bar (up, top third)', spy_over_200: 'SPY over its 200 SMA', spy_pullback_5: 'SPY ≥ 5% under its 20-day high',
})

/** One series → per part (older / recent), per fact: { atStarts, starts, onBars, bars, fwdWith, nWith, fwdAll, nAll }. Pure. */
export function count(bars, spy = null, m = MOVE) {
    const atrs = atrsOf(bars), flags = moveBars(bars, atrs, m), starts = new Set(moveStarts(bars, flags, m)), f = facts(bars, atrs, spy)
    const cut = Math.floor(bars.length * (1 - m.recentShare))
    const res = { older: {}, recent: {} }
    for (const part of ['older', 'recent']) {
        const idx = f.map((x, i) => i).filter(i => f[i] && flags[i] != null && (part === 'older' ? i < cut : i >= cut))
        const st = idx.filter(i => starts.has(i))
        const fwdAll = idx.filter(i => flags[i]).length
        for (const k of Object.keys(FACT_WORDS)) {
            const known = idx.filter(i => f[i][k] != null), withIt = known.filter(i => f[i][k])
            const stKnown = st.filter(i => f[i][k] != null)
            res[part][k] = {
                atStarts: stKnown.filter(i => f[i][k]).length, starts: stKnown.length, onBars: withIt.length, bars: known.length,
                fwdWith: withIt.filter(i => flags[i]).length, nWith: withIt.length, fwdAll, nAll: idx.length,
            }
        }
        res[part]._starts = st
    }
    return { res, starts: [...starts], flags, facts: f, atrs, cut }
}

const lift = (r) => (r.starts && r.bars && r.onBars ? (r.atStarts / r.starts) / (r.onBars / r.bars) : null)

export async function readName(sym, file = 'data/lab/screener-10y.jsonl') {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
        if (!line.startsWith(`{"symbol":"${sym}"`)) continue
        rl.close()
        const { b } = JSON.parse(line)
        return b.map(([t, o, h, l, c, v]) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v }))
            .filter(x => x.close > 0 && x.open > 0 && x.high >= x.low).sort((x, y) => x.timestamp - y.timestamp)
    }
    return null
}

if (process.argv[1]?.endsWith('lab-proteus-moves.mjs')) {   // run, not imported (the unit test imports it)
    const SYM = (process.argv[2] ?? 'LNG').toUpperCase()
    const bars = await readName(SYM), spyBars = await readName('SPY')
    if (!bars?.length) { console.error(`${SYM}: no bars`); process.exit(1) }
    const sc = spyBars.map(b => b.close), s200 = calcSMASeries(sc, 200)
    const spy = new Map(spyBars.map((b, i) => { let hi = -Infinity; for (let j = Math.max(0, i - 19); j <= i; j++) hi = Math.max(hi, sc[j]); return [new Date(b.timestamp * 1000).toISOString().slice(0, 10), { close: b.close, sma200: s200[i], hi20: hi }] }).filter(([, x]) => x.sma200 != null))
    const real = count(bars, spy)
    const shuf = []
    for (let s = 0; s < MOVE.shuffles; s++) shuf.push(count(E.shuffledBars(bars, E.seededRandom(seedOf(SYM) + s))).res)

    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const d = (i) => new Date(bars[i].timestamp * 1000).toISOString().slice(0, 10)
    const pct = (a, b) => (b ? `${(a / b * 100).toFixed(0)}%` : '—')
    say(`# The moves backwards — ${SYM} (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.5`)
    say(`${bars.length} daily bars ${d(0)} → ${d(bars.length - 1)}; a move = +${MOVE.up} ATR on a high within ${MOVE.within} bars before a close ${MOVE.stop} ATR under; older | recent split at ${d(real.cut)}`)
    say(`moves: ${real.starts.length} (older ${real.res.older._starts.length}, recent ${real.res.recent._starts.length}) · bars that begin one: older ${pct(real.res.older.over_200.fwdAll, real.res.older.over_200.nAll)}, recent ${pct(real.res.recent.over_200.fwdAll, real.res.recent.over_200.nAll)} · shuffled bars, moves a run: ${median(shuf.map(r => r.older._starts.length + r.recent._starts.length))}`)

    say('\n## Each move: where it started, how far it went (20 bars), what was true on the start bar')
    for (const i of real.starts) {
        let hi = -Infinity
        for (let j = i + 1; j <= Math.min(bars.length - 1, i + MOVE.within); j++) hi = Math.max(hi, bars[j].high)
        const f = real.facts[i]
        const on = f ? Object.keys(FACT_WORDS).filter(k => f[k] === true).join(', ') : '(warm-up)'
        say(`  ${d(i)}  ${bars[i].close.toFixed(2)} → ${hi.toFixed(2)} (+${((hi / bars[i].close - 1) * 100).toFixed(0)}%, ${((hi - bars[i].close) / real.atrs[i]).toFixed(1)} ATR)${i >= real.cut ? ' [recent]' : ''}  ${on}`)
    }

    say('\n## Each fact: at the starts vs on every bar (lift), and of the bars with it how many began a move')
    say('  fact'.padEnd(42) + 'OLDER: starts   bars   lift  shuf95 | fwd with vs all'.padEnd(52) + 'RECENT: starts   bars   lift | fwd with vs all')
    const cand = []
    for (const k of Object.keys(FACT_WORDS)) {
        const o = real.res.older[k], r = real.res.recent[k], lo = lift(o), lr = lift(r)
        const sl = shuf.map(x => lift(x.older[k])).filter(Number.isFinite).sort((a, b) => a - b)
        const s95 = sl.length ? sl[Math.min(sl.length - 1, Math.floor(sl.length * 0.95))] : null
        const ok = lo != null && lr != null && lo >= 1.5 && lr >= 1.5 && o.atStarts >= 10 && (s95 == null || lo > s95)
        if (ok) cand.push(FACT_WORDS[k])
        const L = (x) => (x == null ? '  —' : x.toFixed(2))
        say(`  ${FACT_WORDS[k].padEnd(40)}${pct(o.atStarts, o.starts).padStart(5)} ${pct(o.onBars, o.bars).padStart(6)} ${L(lo).padStart(6)} ${(s95 == null ? 'n/a' : s95.toFixed(2)).padStart(6)} | ${pct(o.fwdWith, o.nWith).padStart(4)} vs ${pct(o.fwdAll, o.nAll).padStart(4)} (n ${o.nWith})`.padEnd(94) +
            `${pct(r.atStarts, r.starts).padStart(5)} ${pct(r.onBars, r.bars).padStart(6)} ${L(lr).padStart(6)} | ${pct(r.fwdWith, r.nWith).padStart(4)} vs ${pct(r.fwdAll, r.nAll).padStart(4)} (n ${r.nWith})${ok ? '  ← candidate' : ''}`)
    }
    say(`\n## Candidates for a test across names (§10.5: lift ≥ 1.5 older AND recent, ≥ 10 older starts, over the shuffled 95th): ${cand.length ? cand.join(' · ') : 'none'}`)
    fs.writeFileSync(`data/lab/proteus-moves-${SYM}.out.txt`, lines.join('\n') + '\n')
    console.log(`→ data/lab/proteus-moves-${SYM}.out.txt`)
    process.exit(0)
}
