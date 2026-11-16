#!/usr/bin/env node
// PATTERNS, ORDER BLOCKS AND INDICATORS AT EVERY LINK (Roy, 2026-11-16: "did you check patterns / orderblocks /
// indicators for every step?" — "yes"). Declared in docs/design/proteus.md §10.7 before the run. §10.7's moves and
// links, described with Proteus's own detectors. The moves only (Roy's call).
//
//   node scripts/lab-proteus-moves-patterns.mjs LNG NVDA …   → data/lab/proteus-moves-patterns.out.txt

import fs from 'fs'
import { E, P, atrsOf, calcSMASeries, calcEMASeries, calcRSISeries, calcMACDSeries, median } from './lab-proteus.shared.mjs'
import { moveBars, moveStarts, readName, MOVE } from './lab-proteus-moves.mjs'
import { chainAt, breakoutAt, CHAIN } from './lab-proteus-moves-chain.mjs'

const ROOT = new URL('../', import.meta.url)
const { detectOrderBlocks, swings } = await import(new URL('services/smc.engine.js', ROOT))

export const PAT = { near: 3, obAge: 250, obSlack: 0.5, fibBand: 5, divFrom: 40, divTo: 5, dbFrom: 10, dbTo: 60, dbTol: 0.5, dbRise: 2, at200: 0.5 }

/** Everything the facts read, once per series. Pure. */
export function prepare(bars) {
    const n = bars.length, cl = bars.map(b => b.close), atrs = atrsOf(bars)
    const at = new Map(bars.map((b, i) => [b.timestamp, i]))
    const obs = detectOrderBlocks(bars).map(o => ({ ...o, i: at.get(o.at), known: at.get(o.impulseAt) + 2 })).filter(o => o.i != null && Number.isFinite(o.known))
    const sw = swings(bars, P.swingLookback)
    const wy = E.wyckoffTest(bars, atrs, Math.floor(n * 2 / 3), E.driftOutcomes(bars, atrs), [])
    const macd = calcMACDSeries(cl)
    return {
        bars, cl, atrs, obs, lows: sw.filter(s => s.type === 'low'), highs: sw.filter(s => s.type === 'high'),
        ranges: wy.range_list, springs: wy.spring_events,
        s200: calcSMASeries(cl, 200), s50: calcSMASeries(cl, 50), e20: calcEMASeries(cl, 20), rsi: calcRSISeries(cl, 14),
        line: macd.line, signal: macd.signal, hist: macd.hist,
    }
}

const fin = Number.isFinite
const anyIn = (from, to, f) => { for (let j = from; j <= to; j++) if (f(j)) return true; return false }
const crossUp = (d, j) => fin(d.line[j]) && fin(d.signal[j]) && fin(d.line[j - 1]) && fin(d.signal[j - 1]) && d.line[j - 1] <= d.signal[j - 1] && d.line[j] > d.signal[j]
const crossDown = (d, j) => fin(d.line[j]) && fin(d.signal[j]) && fin(d.line[j - 1]) && fin(d.signal[j - 1]) && d.line[j - 1] >= d.signal[j - 1] && d.line[j] < d.signal[j]
const body = (b) => Math.abs(b.close - b.open)

/** §10.7's tightened detectors (`--tight`), fixed before the run. */
export const TIGHT = { displace: 1.5, width: 1.5, age: 120, dbTol: 0.25, dbFrom: 15, dbTo: 60, dbRise: 3 }
let tight = false
/** Switch the tight detectors on or off (the lab's flag; the unit test sets it). */
export const setTight = (on) => { tight = !!on }

/** Does bar j reach block o's zone (from the side the move came from)? */
const reaches = (d, o, j, slack) => {
    const b = d.bars[j], a = d.atrs[j]
    return o.type === 'bullish' ? b.low <= o.top && b.low >= o.bottom - slack * a : b.high >= o.bottom && b.high <= o.top + slack * a
}

/** Tight only: displaced, narrow, recent, and bar j its FIRST touch since it was known. Pure. */
function tightBlock(d, o, j, t = TIGHT) {
    const a = d.atrs[o.i], after = d.cl[o.i + 3]
    if (!fin(a) || a <= 0 || after == null || o.top - o.bottom > t.width * a || j - o.i > t.age) return false
    if (o.type === 'bullish' ? after < o.top + t.displace * a : after > o.bottom - t.displace * a) return false
    for (let k = o.known; k < j; k++) if (o.type === 'bullish' ? d.bars[k].low <= o.top : d.bars[k].high >= o.bottom) return false
    return true
}

/** A known order block of `type` whose zone bar `j` reached (from the side the move came from). Pure. */
function atBlock(d, j, type, p = PAT) {
    if (!fin(d.atrs[j])) return false
    return d.obs.some(o => o.type === type && o.known <= j && j - o.i <= p.obAge && reaches(d, o, j, p.obSlack) && (!tight || tightBlock(d, o, j)))
}

/** A 2-bar swing (known by bar j) taken out on bar j and closed back within 3 bars. Pure. */
function swept(d, j, side) {
    const list = side === 'low' ? d.lows : d.highs
    const prior = list.filter(s => s.i + P.swingLookback < j).at(-1)
    if (!prior) return false
    const b = d.bars[j]
    const beyond = side === 'low' ? b.low < prior.price : b.high > prior.price
    if (!beyond) return false
    for (let k = j; k < Math.min(d.bars.length, j + P.sweepBack); k++) if (side === 'low' ? d.cl[k] > prior.price : d.cl[k] < prior.price) return true
    return false
}

/** Divergence at bar j against the extreme close 40–5 bars before: price further, the series not. Pure. */
function divergence(d, j, series, side, p = PAT) {
    let k = null
    for (let m = j - p.divFrom; m <= j - p.divTo; m++) if (m >= 0 && (k == null || (side === 'low' ? d.cl[m] < d.cl[k] : d.cl[m] > d.cl[k]))) k = m
    if (k == null || !fin(series[j]) || !fin(series[k])) return false
    return side === 'low' ? d.cl[j] < d.cl[k] && series[j] > series[k] : d.cl[j] > d.cl[k] && series[j] < series[k]
}

/** A matching extreme 10–60 bars before within 0.5 ATR, with ≥ 2 ATR between. Pure. */
function double(d, j, side, p = PAT) {
    const a = d.atrs[j]
    if (!fin(a)) return false
    const px = (m) => (side === 'low' ? d.bars[m].low : d.bars[m].high)
    const t = tight ? { dbTol: TIGHT.dbTol, dbFrom: TIGHT.dbFrom, dbTo: TIGHT.dbTo, dbRise: TIGHT.dbRise } : p
    const better = (x, y) => (side === 'low' ? x < y : x > y)
    const extremeOf = (m) => { for (let k = m - 2; k <= m + 2; k++) if (k !== m && k >= 0 && k < d.bars.length && !better(px(m), px(k))) return false; return true }
    if (tight && !extremeOf(j)) return false
    const swingsAt = new Set((side === 'low' ? d.lows : d.highs).map(s => s.i))
    for (let m = j - t.dbTo; m <= j - t.dbFrom; m++) {
        if (m < 0 || Math.abs(px(m) - px(j)) > t.dbTol * a) continue
        if (tight && !swingsAt.has(m)) continue
        let ext = side === 'low' ? -Infinity : Infinity
        for (let k = m + 1; k < j; k++) ext = side === 'low' ? Math.max(ext, d.bars[k].high) : Math.min(ext, d.bars[k].low)
        if (side === 'low' ? ext - px(j) >= t.dbRise * a : px(j) - ext >= t.dbRise * a) return true
    }
    return false
}

const hammer = (b) => { const r = b.high - b.low; return r > 0 && Math.min(b.open, b.close) - b.low >= 2 * body(b) && b.close >= b.low + (2 / 3) * r }
const star = (b) => { const r = b.high - b.low; return r > 0 && b.high - Math.max(b.open, b.close) >= 2 * body(b) && b.close <= b.low + (1 / 3) * r }
const engulf = (prev, b, up) => (up ? b.close > b.open && prev.close < prev.open && b.close >= prev.open && b.open <= prev.close
    : b.close < b.open && prev.close > prev.open && b.close <= prev.open && b.open >= prev.close)

/** The low: the move's start bar `s`, the top `h` it fell from. Pure. */
export function lowFacts(d, s, h, p = PAT) {
    const from = s - p.near, a = d.atrs[s]
    let runLow = Infinity
    for (let j = Math.max(0, h - 60); j < h; j++) runLow = Math.min(runLow, d.cl[j])
    const depth = d.cl[h] > runLow ? (d.cl[h] - d.cl[s]) / (d.cl[h] - runLow) * 100 : null
    return {
        depth,
        bull_ob: anyIn(from, s, j => atBlock(d, j, 'bullish')),
        swept_low: anyIn(from, s, j => swept(d, j, 'low')),
        spring: d.springs.some(sp => sp.dip >= from && sp.dip <= s),
        in_range: d.ranges.some(r => r.known <= s && s <= r.until),
        fib: depth != null && [38.2, 50, 61.8].some(f => Math.abs(depth - f) <= p.fibBand),
        at_200: fin(d.s200[s]) && fin(a) && anyIn(from, s, j => Math.abs(d.bars[j].low - d.s200[j]) <= p.at200 * a),
        macd_under_0: fin(d.line[s]) && d.line[s] < 0,
        hist_turn: fin(d.hist[s]) && fin(d.hist[s - 1]) && d.hist[s] > d.hist[s - 1],
        macd_cross_up: anyIn(from, Math.min(d.bars.length - 1, s + p.near), j => crossUp(d, j)),
        rsi_div: divergence(d, s, d.rsi, 'low'), macd_div: divergence(d, s, d.line, 'low'),
        double_bottom: anyIn(from, s, j => double(d, j, 'low')),
        bull_candle: anyIn(s, Math.min(d.bars.length - 1, s + 1), j => hammer(d.bars[j]) || engulf(d.bars[j - 1], d.bars[j], true)),
    }
}

/** The top `h`. Pure. */
export function topFacts(d, h, p = PAT) {
    const from = h - p.near, to = Math.min(d.bars.length - 1, h + p.near)
    return {
        bear_ob: anyIn(from, to, j => atBlock(d, j, 'bearish')),
        swept_high: anyIn(from, to, j => swept(d, j, 'high')),
        macd_cross_down: anyIn(h, Math.min(d.bars.length - 1, h + 5), j => crossDown(d, j)),
        rsi_div: anyIn(from, h, j => divergence(d, j, d.rsi, 'high')), macd_div: anyIn(from, h, j => divergence(d, j, d.line, 'high')),
        double_top: anyIn(from, to, j => double(d, j, 'high')),
        bear_candle: anyIn(h, Math.min(d.bars.length - 1, h + 1), j => star(d.bars[j]) || engulf(d.bars[j - 1], d.bars[j], false)),
    }
}

/** The breakout `b`. Pure. */
export function breakoutFacts(d, b) {
    const from = Math.max(1, b - 20)
    return {
        wyckoff_breakout: d.ranges.some(r => Math.abs(r.until - b) <= 3 && d.cl[r.until] > r.high),
        bull_ob_retest: anyIn(from, b, j => atBlock(d, j, 'bullish')),
        swept_low: anyIn(from, b, j => swept(d, j, 'low')),
        macd_over_0: fin(d.line[b]) && d.line[b] > 0,
        macd_cross_up: anyIn(Math.max(1, b - 10), b, j => crossUp(d, j)),
        stacked: fin(d.e20[b]) && fin(d.s50[b]) && d.e20[b] > d.s50[b],
        rsi_over_60: fin(d.rsi[b]) && d.rsi[b] > 60,
    }
}

export const WORDS = Object.freeze({
    low: { bull_ob: 'at a bullish order block', swept_low: 'swept a swing low', spring: 'a Wyckoff spring', in_range: 'inside a Wyckoff range',
        fib: 'retraced 38.2/50/61.8% (±5)', at_200: 'at the 200 SMA', macd_under_0: 'MACD under zero', hist_turn: 'MACD histogram turning up',
        macd_cross_up: 'MACD cross up (±3 bars)', rsi_div: 'RSI bullish divergence', macd_div: 'MACD bullish divergence', double_bottom: 'a double bottom',
        bull_candle: 'hammer / bullish engulfing' },
    top: { bear_ob: 'at a bearish order block', swept_high: 'swept a swing high', macd_cross_down: 'MACD cross down (5 bars after)',
        rsi_div: 'RSI bearish divergence', macd_div: 'MACD bearish divergence', double_top: 'a double top', bear_candle: 'shooting star / bearish engulfing' },
    breakout: { wyckoff_breakout: 'a Wyckoff range breakout', bull_ob_retest: 'a bullish OB retested (20 bars before)', swept_low: 'a swept swing low (20 before)',
        macd_over_0: 'MACD over zero', macd_cross_up: 'MACD cross up (10 bars before)', stacked: '20 EMA over the 50 SMA', rsi_over_60: 'RSI over 60' },
})

/** One name → per link, per fact, the share of its moves (older / recent), and the moves' Fibonacci depths. Pure. */
export function describe(bars) {
    const d = prepare(bars), flags = moveBars(bars, d.atrs), starts = moveStarts(bars, flags)
    const cut = Math.floor(bars.length * (1 - MOVE.recentShare))
    const moves = starts.map(s => chainAt(bars, d.atrs, s)).filter(Boolean).map(r => {
        const k = r.failed_breakout ? breakoutAt(bars, d.atrs, r.high) : null
        return { part: r.start < cut ? 'older' : 'recent', low: lowFacts(d, r.start, r.high), top: topFacts(d, r.high), breakout: k ? breakoutFacts(d, k.breakout) : null }
    })
    const out = { moves: moves.length, depth: median(moves.map(m => m.low.depth)), links: {} }
    for (const link of ['low', 'top', 'breakout']) {
        const ms = moves.filter(m => m[link])
        out.links[link] = { n: ms.length, facts: {} }
        for (const k of Object.keys(WORDS[link])) {
            const share = (part) => { const g = ms.filter(m => m.part === part); return g.length ? g.filter(m => m[link][k]).length / g.length : null }
            const o = share('older'), r = share('recent')
            out.links[link].facts[k] = { older: o, recent: r, common: o >= CHAIN.common && r >= CHAIN.common }
        }
    }
    return out
}

if (process.argv[1]?.endsWith('lab-proteus-moves-patterns.mjs')) {   // run, not imported (the unit test imports it)
    setTight(process.argv.includes('--tight'))
    const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
    const syms = (args.length ? args : ['LNG']).map(s => s.toUpperCase())
    const OUT = `data/lab/proteus-moves-patterns${tight ? '-tight' : ''}.out.txt`
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const pc = (x) => (x == null ? '  —' : `${Math.round(x * 100)}`.padStart(3))
    say(`# Patterns, order blocks and indicators at every link${tight ? ' — TIGHT detectors' : ''} (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.7`)
    say(`common = on ≥ ${Math.round(CHAIN.common * 100)}% of a name's moves, older AND recent. Cells: older/recent %.`)
    const res = {}
    for (const sym of syms) { const bars = await readName(sym); if (bars?.length) res[sym] = describe(bars) }
    const names = Object.keys(res)
    // How loose each detector is: the share of ANY bar it fires on (every third bar from 400; LNG / KO / TSLA) — calibration.
    const loose = { low: {}, top: {}, breakout: {} }
    let nAny = 0
    for (const sym of ['LNG', 'KO', 'TSLA']) {
        const bars = await readName(sym), d = prepare(bars)
        for (let i = 400; i < bars.length - 5; i += 3) {
            nAny++
            for (const [link, fx] of [['low', lowFacts(d, i, i - 20)], ['top', topFacts(d, i)], ['breakout', breakoutFacts(d, i)]])
                for (const [k, v] of Object.entries(fx)) if (v === true) loose[link][k] = (loose[link][k] ?? 0) + 1
        }
    }
    const looseOf = (link, k) => (loose[link][k] ?? 0) / nAny
    say(`\nmoves: ${names.map(s => `${s} ${res[s].moves}`).join(' · ')}`)
    say(`median pullback depth, % of the run into the top: ${names.map(s => `${s} ${res[s].depth?.toFixed(0) ?? '—'}`).join(' · ')}`)
    for (const [link, title] of [['low', 'AT THE LOW (link 2)'], ['top', 'AT THE TOP (link 3)'], ['breakout', 'AT THE BREAKOUT (link 4)']]) {
        say(`\n## ${title} — moves per name: ${names.map(s => res[s].links[link].n).join(' / ')}`)
        say(`  ${''.padEnd(40)}${names.map(s => s.padStart(9)).join('')}`)
        for (const k of Object.keys(WORDS[link])) {
            const cells = names.map(s => { const f = res[s].links[link].facts[k]; return `${pc(f.older)}/${pc(f.recent)}${f.common ? '*' : ' '}`.padStart(9) })
            const nCommon = names.filter(s => res[s].links[link].facts[k].common).length
            const l = looseOf(link, k)
            say(`  ${WORDS[link][k].padEnd(40)}${cells.join('')}   common on ${String(nCommon).padStart(2)} · any bar ${Math.round(l * 100)}%${l > 0.3 ? ' LOOSE' : ''}`)
        }
    }
    say('\n## Per name — what is common (* above)')
    for (const s of names) {
        const c = ['low', 'top', 'breakout'].flatMap(l => Object.entries(res[s].links[l].facts).filter(([, f]) => f.common).map(([k]) => `${l}: ${WORDS[l][k]}`))
        say(`  ${s.padEnd(5)} ${c.join(' · ') || '—'}`)
    }
    fs.writeFileSync(OUT, lines.join('\n') + '\n')
    console.log(`→ ${OUT}`)
    process.exit(0)
}
