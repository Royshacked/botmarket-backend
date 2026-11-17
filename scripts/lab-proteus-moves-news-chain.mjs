#!/usr/bin/env node
// MAJOR NEWS ALONG THE WHOLE CHAIN (Roy, 2026-11-17: "there weren't any major news before or after — even before the
// steps that led to the move?" → "yes"). Declared in docs/design/proteus.md §10.9 before the run. Daily; the top the
// pullback fell from, the pullback, the low the move started at — where the MAJOR news sits (the stock reacted).
//
//   node scripts/lab-proteus-moves-news-chain.mjs LNG KO   → data/lab/proteus-moves-news-chain.out.txt

import fs from 'fs'
import { atrsOf, calcSMASeries } from './lab-proteus.shared.mjs'
import { readName } from './lab-proteus-moves.mjs'
import { sourcesOf, eventsOf } from './lab-proteus-moves-news.mjs'

const E = await import('../services/behaviourProfile.engine.js')
export const CHAIN_NEWS = { near: 5, bigAtr: 2, bigVol: 2, look: 60 }
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)

/** Per session: BIG (|close-to-close| ≥ 2 ATR of the day before, or volume ≥ 2× its 20-session average). Pure. */
export function bigSessions(bars, atrs, c = CHAIN_NEWS) {
    const v20 = calcSMASeries(bars.map(b => b.volume ?? 0), 20)
    return bars.map((b, i) => {
        if (!i) return false
        const a = atrs[i - 1], move = Math.abs(b.close - bars[i - 1].close)
        return (Number.isFinite(a) && a > 0 && move >= c.bigAtr * a) || (v20[i - 1] > 0 && (b.volume ?? 0) >= c.bigVol * v20[i - 1])
    })
}

/** The part of a move's chain a session index `i` falls in: 'top' (h ± near), 'low' (s ± near), 'pullback' (between), or null. Pure. */
export function partOf(i, h, s, c = CHAIN_NEWS) {
    if (Math.abs(i - s) <= c.near) return 'low'
    if (Math.abs(i - h) <= c.near) return 'top'
    if (i > h && i < s) return 'pullback'
    return null
}

if (process.argv[1]?.endsWith('lab-proteus-moves-news-chain.mjs')) {   // run, not imported (the unit test imports it)
    const syms = (process.argv.length > 2 ? process.argv.slice(2) : ['LNG', 'KO']).map(s => s.toUpperCase())
    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const r100 = (n, d) => (d ? (n / d * 100).toFixed(1) : '—')
    say(`# Major news along the whole chain (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.9`)
    say(`major = a dated event on a session the stock moved ≥ ${CHAIN_NEWS.bigAtr} ATR or traded ≥ ${CHAIN_NEWS.bigVol}× its volume; "unexplained" = such a session with no dated event. Rates per 100 sessions.`)
    for (const SYM of syms) {
        const { got, ex } = await sourcesOf(SYM)
        const events = eventsOf(SYM, got, ex).filter(e => e.what)   // the 8-K once
        const bars = await readName(SYM)
        const days = bars.map(b => dayOf(ms(b.timestamp)))
        const atrs = atrsOf(bars), big = bigSessions(bars, atrs)
        const idx = new Map(days.map((d, i) => [d, i]))
        const at = (d) => (idx.has(d) ? idx.get(d) : days.findIndex(x => x >= d))
        const evAt = new Map()
        for (const e of events) { const i = at(e.day); if (i >= 0) (evAt.get(i) ?? evAt.set(i, []).get(i)).push(e) }
        const major = (i) => big[i] && evAt.has(i)
        const unexplained = (i) => big[i] && !evAt.has(i)
        const starts = E.moveStartsOf(bars, E.moveFlags(bars, atrs)).filter(s => s >= CHAIN_NEWS.look * 2)
        const totals = { top: [0, 0, 0], pullback: [0, 0, 0], low: [0, 0, 0] }   // sessions, major, unexplained
        say(`\n## ${SYM} — ${starts.length} moves`)
        for (const s of starts) {
            let h = s - CHAIN_NEWS.look
            for (let j = s - CHAIN_NEWS.look; j < s; j++) if (bars[j].close > bars[h].close) h = j
            const seen = []
            for (let i = Math.max(1, h - CHAIN_NEWS.near); i <= Math.min(bars.length - 1, s + CHAIN_NEWS.near); i++) {
                const p = partOf(i, h, s)
                if (!p) continue
                totals[p][0]++
                if (major(i)) { totals[p][1]++; seen.push({ i, p }) }
                if (unexplained(i)) totals[p][2]++
            }
            say(`  move ${days[s]} — top ${days[h]} (${s - h} sessions before), pullback ${((bars[s].close / bars[h].close - 1) * 100).toFixed(0)}%`)
            for (const { i, p } of seen) {
                const ch = (bars[i].close / bars[i - 1].close - 1) * 100
                const what = evAt.get(i).filter(e => !e.kind.endsWith(' news')).map(e => e.what)
                const heads = evAt.get(i).filter(e => e.kind.endsWith(' news'))
                say(`      ${p.padEnd(8)} ${String(i - (p === 'top' ? h : s)).padStart(3)} vs ${p === 'top' ? 'top' : p === 'low' ? 'start' : 'start'}  ${days[i]}  ${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%  ${[...what, ...(heads.length ? [`${heads.length} headline(s): ${heads.slice(0, 2).map(e => e.what.slice(0, 90)).join(' | ')}`] : [])].join('; ')}`)
            }
            if (!seen.length) say('      — no major news at the top, in the pullback or at the low')
        }
        // The whole history's rate, the same rule.
        let n = 0, mj = 0, un = 0
        for (let i = 260; i < bars.length; i++) { n++; if (major(i)) mj++; if (unexplained(i)) un++ }
        say(`  per 100 sessions — major news / big with nothing dated:`)
        for (const p of ['top', 'pullback', 'low']) say(`    ${p.padEnd(9)} ${r100(totals[p][1], totals[p][0]).padStart(5)} / ${r100(totals[p][2], totals[p][0]).padStart(5)}   (${totals[p][0]} sessions)`)
        say(`    any time  ${r100(mj, n).padStart(5)} / ${r100(un, n).padStart(5)}   (${n} sessions)`)
        const withAt = (p) => starts.filter(s => { let h = s - CHAIN_NEWS.look; for (let j = s - CHAIN_NEWS.look; j < s; j++) if (bars[j].close > bars[h].close) h = j; for (let i = Math.max(1, h - CHAIN_NEWS.near); i <= Math.min(bars.length - 1, s + CHAIN_NEWS.near); i++) if (partOf(i, h, s) === p && major(i)) return true; return false }).length
        say(`  moves with any major news — at the top ${withAt('top')} · in the pullback ${withAt('pullback')} · at the low ${withAt('low')} (of ${starts.length})`)
    }
    fs.writeFileSync('data/lab/proteus-moves-news-chain.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-moves-news-chain.out.txt')
    process.exit(0)
}
