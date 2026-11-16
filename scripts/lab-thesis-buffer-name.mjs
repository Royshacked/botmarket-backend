#!/usr/bin/env node
// TEST 5 — THE STOP'S DEPTH, PER STOCK (Roy, 2026-11-16: "each ticker behaves individually"). Declared in
// docs/design/stock-playbook.md §Test 5 before the run. Test 1's trades (thesisLab.service) played at five stop depths;
// per name the older two-thirds choose the depth, the recent third checks it; every name's bars shuffled through the
// identical pipeline beside it. Reads the lab's cached bars only (no fetch).
//
//   node --max-old-space-size=6000 scripts/lab-thesis-buffer-name.mjs   → data/lab/thesis-buffer-name.out.txt

import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])

const L = await import('../services/thesisLab.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { costFor, MIN_ADV, MIN_PRICE } = await import('../services/screenerLab.service.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { shuffledBars, seededRandom } = await import('../services/behaviourProfile.engine.js')

const TO = '2026-10-26', HELD_OUT = '2025-10-23', WARMUP = 260, COVERAGE = 0.9
const P = L.DEFAULTS
/** The depths, fixed before the run (§Test 5). The first is Mentor's — the reference. */
export const DEPTHS = [
    { id: '0.2 ATR', o: P },
    { id: '0.5 ATR', o: { ...P, buffer: 0.5 } },
    { id: '1 ATR', o: { ...P, buffer: 1 } },
    { id: '2 ATR', o: { ...P, buffer: 2 } },
    { id: '60-day low', o: { ...P, stopAt: 'low60' } },
]
/** The per-name bar (Proteus's, in R): edge, z, minimum older / recent signals, the recent third's edge. */
export const BAR = { edge: 0.1, z: 3, minN: 15, minRecent: 5, recentEdge: 0.05 }

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const sd = (xs) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : null }

/**
 * One name's verdict from its signals' R at every depth (`[{ i, r: [R per depth] }]`) and the recent third's first bar
 * index `cut`. → { verdict, best, n, edge, z, recent }. Pure.
 */
export function depthVerdict(sigs, cut, bar = BAR) {
    const older = sigs.filter(s => s.i < cut), recent = sigs.filter(s => s.i >= cut)
    if (older.length < bar.minN) return { verdict: 'thin', best: null, n: older.length }
    let best = 0, bestEdge = 0
    for (let d = 1; d < DEPTHS.length; d++) {
        const e = mean(older.map(s => s.r[d] - s.r[0]))
        if (e > bestEdge) { best = d; bestEdge = e }
    }
    if (best === 0) return { verdict: 'no', best: 0, n: older.length, edge: 0 }
    const diffs = older.map(s => s.r[best] - s.r[0]), s = sd(diffs)
    const z = s > 0 ? bestEdge / (s / Math.sqrt(diffs.length)) : 0
    const out = { best, n: older.length, edge: bestEdge, z }
    if (!(bestEdge >= bar.edge && z >= bar.z)) return { ...out, verdict: 'no' }
    if (recent.length < bar.minRecent) return { ...out, verdict: 'unconfirmed' }
    const re = mean(recent.map(x => x.r[best] - x.r[0]))
    return { ...out, recent: re, verdict: re >= bar.recentEdge ? 'respects' : 'faded' }
}

/** The lowest low of the `n` sessions to `i` — the 60-day low for the baseline's deeper stop. Pure. */
const lowest = (rows, i, n) => { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, rows[j].low); return m }

/** One series' signals of one set, each played at every depth → `[{ i, day, r: [R per depth] }]`. */
function playAll(rows, date, adv, real, set, member, sym) {
    const a = L.atr(rows), pv = L.swings(rows, a, P.k)
    const sigs = set === 'reversal'
        ? L.reversalSignals(rows, a, pv, P).map(s => ({ ...s, low60: s.low }))   // L* is the 60-day low already
        : L.baselineSignals(rows, a, pv, P).map(s => ({ ...s, low60: lowest(rows, s.i, P.lookLow) }))
    const out = []
    for (const sig of sigs) {
        const i = sig.i, day = date[i]
        // The universe's filters on the REAL bars (who was a member, tradable) — the shuffle only changes the path.
        if (i < WARMUP || !member(sym, day) || real[i].close < MIN_PRICE || !((adv[i] ?? 0) >= MIN_ADV)) continue
        const r = DEPTHS.map(({ o }) => {
            const p = L.plan(sig, a, o)
            if (!p) return 0
            const t = L.play(rows, i, p, o)
            if (!t) return 0
            return L.inR(t.reason === 'open' ? { entry: t.entry, exit: t.mark } : t, p.S, costFor(adv[i]), p.E)
        })
        out.push({ i, day, r })
    }
    return out
}

if (process.argv[1]?.endsWith('lab-thesis-buffer-name.mjs')) {   // run, not imported (the unit test imports it)
    const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
    const member = (sym, day) => memberOn(u.spans, sym, day)
    const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: TO }, extras: [], member })
    const days = data.spyDays.slice(WARMUP)
    const covered = []
    for (const sym of Object.keys(u.spans)) {
        const inIdx = days.filter(d => member(sym, d)), s = data.names.get(sym)
        if (!inIdx.length || !s) continue
        const have = new Set(s.ind.date)
        if (inIdx.filter(d => have.has(d)).length / inIdx.length >= COVERAGE) covered.push(sym)
    }

    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    say(`# Test 5 — the stop's depth, per stock (${new Date().toISOString().slice(0, 10)}) — S&P 500 point-in-time, ${covered.length} names · held out from ${HELD_OUT}`)
    say(`depths: ${DEPTHS.map(d => d.id).join(' · ')} (the first is Mentor's) · bar: +${BAR.edge}R at z ${BAR.z} on ≥ ${BAR.minN} older signals, recent ≥ ${BAR.recentEdge}R on ≥ ${BAR.minRecent}`)

    for (const set of ['reversal', 'baseline']) {
        const tally = { real: {}, shuf: {} }, bestBy = { real: {}, shuf: {} }, flagged = [], pooled = DEPTHS.map(() => ({ pre: [], post: [] }))
        const perName = []
        for (const sym of covered) {
            const s = data.names.get(sym), rows = s.rows, date = s.ind.date, adv = s.ind.adv20
            const cut = Math.floor(rows.length * 2 / 3)
            for (const side of ['real', 'shuf']) {
                const series = side === 'real' ? rows : shuffledBars(rows, seededRandom([...sym].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 11)))
                const sigs = playAll(series, date, adv, rows, set, member, sym)
                const v = depthVerdict(sigs, cut)
                tally[side][v.verdict] = (tally[side][v.verdict] ?? 0) + 1
                if (v.best != null && v.verdict !== 'thin') bestBy[side][DEPTHS[v.best].id] = (bestBy[side][DEPTHS[v.best].id] ?? 0) + 1
                if (side === 'real') {
                    perName.push(sigs.length)
                    if (v.verdict === 'respects') flagged.push(`${sym} (${DEPTHS[v.best].id}, +${v.edge.toFixed(2)}R z ${v.z.toFixed(1)}, recent +${v.recent.toFixed(2)})`)
                    for (const x of sigs) DEPTHS.forEach((_, d) => pooled[d][x.day >= HELD_OUT ? 'post' : 'pre'].push(x.r[d]))
                }
            }
        }
        perName.sort((a, b) => a - b)
        const order = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'
        say(`\n## ${set.toUpperCase()} signals — per name: median ${perName[perName.length >> 1]} signals over the whole span (max ${perName.at(-1)})`)
        say(`per name — real:     ${order(tally.real)}`)
        say(`           shuffled: ${order(tally.shuf)}`)
        const r = tally.real.respects ?? 0, sh = tally.shuf.respects ?? 0
        say(`respects: real ${r} vs shuffled ${sh} → ${r >= 2 * sh && r >= sh + 10 ? 'PASS (a stop depth is a trait of some stocks)' : 'no'}${flagged.length ? `  [${flagged.join('; ')}]` : ''}`)
        say(`the "best" depth on the older two-thirds (names not thin) — real: ${order(bestBy.real)}`)
        say(`                                                          shuffled: ${order(bestBy.shuf)}`)
        say('pooled mean R per signal (0R where a depth does not trade) — before | held out:')
        DEPTHS.forEach((d, k) => say(`  ${d.id.padEnd(11)} ${(mean(pooled[k].pre) ?? 0).toFixed(3)}R (n ${pooled[k].pre.length}) | ${(mean(pooled[k].post) ?? 0).toFixed(3)}R (n ${pooled[k].post.length})`))
    }
    fs.writeFileSync('data/lab/thesis-buffer-name.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/thesis-buffer-name.out.txt')
    process.exit(0)
}
