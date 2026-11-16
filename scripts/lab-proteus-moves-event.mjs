#!/usr/bin/env node
// THE PULLBACK BEFORE AN EVENT — ONE COMPANY (Roy, 2026-11-16: "connect it to another event — technical or fundamental").
// Declared in docs/design/proteus.md §10.6 before the run. §10.5's moves and facts; the event = earnings.
//
//   node scripts/lab-proteus-moves-event.mjs [SYMBOL=LNG]   → data/lab/proteus-moves-event-<SYMBOL>.out.txt

import fs from 'fs'
import { E, atrsOf, median, seedOf } from './lab-proteus.shared.mjs'
import { moveBars, moveStarts, facts, readName, MOVE } from './lab-proteus-moves.mjs'

export const WINDOW = 20
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10)

/** §10.6's gate on one bar's facts: a pullback. Pure. */
export const gate = (f) => !!f && (f.down_3_plus || f.deep_pullback || f.new_60_low)

/** Per bar: 'before' (one of the WINDOW bars before a report's bar), 'after' (the report's bar and the WINDOW−1 after), or null; and the report index. Pure. */
export function windows(bars, reportDays, w = WINDOW) {
    const where = new Array(bars.length).fill(null), report = new Array(bars.length).fill(null)
    const days = bars.map(b => dayOf(b.timestamp))
    reportDays.forEach((d, r) => {
        const k = days.findIndex(x => x >= d)
        if (k < 0) return
        for (let i = Math.max(0, k - w); i < k; i++) { where[i] = 'before'; report[i] = r }
        for (let i = k; i < Math.min(bars.length, k + w); i++) if (where[i] == null) { where[i] = 'after'; report[i] = r }
    })
    return { where, report }
}

/** One series → per part, the counts of §10.6 (a)–(c). Pure. */
export function eventCount(bars, reportDays, m = MOVE) {
    const atrs = atrsOf(bars), flags = moveBars(bars, atrs, m), starts = moveStarts(bars, flags, m), f = facts(bars, atrs)
    const { where, report } = windows(bars, reportDays)
    const cut = Math.floor(bars.length * (1 - m.recentShare))
    const out = {}
    for (const part of ['older', 'recent']) {
        const inPart = (i) => (part === 'older' ? i < cut : i >= cut)
        const idx = f.map((_, i) => i).filter(i => f[i] && flags[i] != null && inPart(i))
        const st = starts.filter(i => f[i] && flags[i] != null && inPart(i))
        const rate = (xs) => ({ n: xs.length, moves: xs.filter(i => flags[i]).length })
        const firsts = new Map()
        for (const i of idx) if (where[i] === 'before' && gate(f[i]) && !firsts.has(report[i])) firsts.set(report[i], i)
        out[part] = {
            starts: st.length, startsBefore: st.filter(i => where[i] === 'before').length, startsAfter: st.filter(i => where[i] === 'after').length,
            barsBefore: idx.filter(i => where[i] === 'before').length, barsAfter: idx.filter(i => where[i] === 'after').length, bars: idx.length,
            all: rate(idx), gateAny: rate(idx.filter(i => gate(f[i]))),
            gateBefore: rate(idx.filter(i => gate(f[i]) && where[i] === 'before')), noGateBefore: rate(idx.filter(i => !gate(f[i]) && where[i] === 'before')),
            gateAfter: rate(idx.filter(i => gate(f[i]) && where[i] === 'after')),
            oneAReport: rate([...firsts.values()]), firsts: [...firsts.entries()],
        }
    }
    return { out, flags, starts, f, where, cut, atrs }
}

if (process.argv[1]?.endsWith('lab-proteus-moves-event.mjs')) {   // run, not imported (the unit test imports it)
    const SYM = (process.argv[2] ?? 'LNG').toUpperCase()
    const bars = await readName(SYM)
    const ex = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
    const reportDays = (ex.history?.[SYM] ?? []).map(r => r.date).filter(Boolean).sort()
    if (!bars?.length || !reportDays.length) { console.error(`${SYM}: no bars or no report dates`); process.exit(1) }
    const real = eventCount(bars, reportDays)
    const shuf = Array.from({ length: MOVE.shuffles }, (_, s) => eventCount(E.shuffledBars(bars, E.seededRandom(seedOf(SYM) + s)), reportDays).out)

    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const P = (r) => (r.n ? `${(r.moves / r.n * 100).toFixed(0)}% (${r.moves}/${r.n})` : '—')
    const R = (r) => (r.n ? r.moves / r.n : null)
    say(`# The pullback before an event — ${SYM}, earnings (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.6`)
    say(`${bars.length} daily bars ${dayOf(bars[0].timestamp)} → ${dayOf(bars.at(-1).timestamp)} · ${reportDays.length} reports · windows ${WINDOW} bars · split ${dayOf(bars[real.cut].timestamp)}`)
    say(`a move = +${MOVE.up} ATR on a high within ${MOVE.within} bars before a close ${MOVE.stop} ATR under · the gate = 3+ down closes OR ≥ 3 ATR under the 20-bar high OR a new 60-bar low`)

    let cand = true
    for (const part of ['older', 'recent']) {
        const o = real.out[part]
        say(`\n## ${part}`)
        say(`(a) moves ${o.starts}: started BEFORE a report ${o.startsBefore} (${(o.startsBefore / o.starts * 100).toFixed(0)}%; ${(o.barsBefore / o.bars * 100).toFixed(0)}% of bars are there) · AFTER ${o.startsAfter} (${(o.startsAfter / o.starts * 100).toFixed(0)}%; ${(o.barsAfter / o.bars * 100).toFixed(0)}% of bars)`)
        say('(b) of the bars, how many began a move:')
        say(`    every bar                       ${P(o.all)}`)
        say(`    a pullback, anywhere            ${P(o.gateAny)}`)
        say(`    a pullback BEFORE a report      ${P(o.gateBefore)}`)
        say(`    no pullback, before a report    ${P(o.noGateBefore)}`)
        say(`    a pullback AFTER a report       ${P(o.gateAfter)}`)
        const sh = shuf.map(x => R(x[part].oneAReport)).filter(Number.isFinite).sort((a, b) => a - b)
        const s95 = sh[Math.min(sh.length - 1, Math.floor(sh.length * 0.95))]
        say(`(c) one entry a report (its first pullback bar before it): ${P(o.oneAReport)} · shuffled bars median ${(median(sh) * 100).toFixed(0)}%, 95th ${(s95 * 100).toFixed(0)}%`)
        for (const [r, i] of o.firsts) {
            let hi = -Infinity
            for (let j = i + 1; j <= Math.min(bars.length - 1, i + MOVE.within); j++) hi = Math.max(hi, bars[j].high)
            say(`      report ${reportDays[r]} · entry ${dayOf(bars[i].timestamp)} ${bars[i].close.toFixed(2)} → ${real.flags[i] ? 'MOVE' : 'no'} (high +${((hi / bars[i].close - 1) * 100).toFixed(0)}% in ${MOVE.within})`)
        }
        const ok = R(o.gateBefore) != null && R(o.gateAny) && R(o.gateBefore) >= 1.5 * R(o.gateAny) && (part === 'recent' || o.oneAReport.n >= 10) && R(o.oneAReport) > s95
        if (!ok) cand = false
    }
    say(`\n## A candidate for the test across names (§10.6)? ${cand ? 'YES' : 'no'}`)
    fs.writeFileSync(`data/lab/proteus-moves-event-${SYM}.out.txt`, lines.join('\n') + '\n')
    console.log(`→ data/lab/proteus-moves-event-${SYM}.out.txt`)
    process.exit(0)
}
