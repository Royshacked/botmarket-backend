#!/usr/bin/env node
// THE CHAIN BACKWARDS — ONE COMPANY, THE MOVES ONLY (Roy, 2026-11-16: "look for moves · what led to them · what led to
// that, and so on"; "the steps after the first can be technical from the chart too"). Declared in docs/design/proteus.md
// §10.7 before the run. A description of the moves alone (Roy's call).
//
//   node scripts/lab-proteus-moves-chain.mjs [SYMBOL=LNG]   → data/lab/proteus-moves-chain-<SYMBOL>.out.txt

import fs from 'fs'
import { atrsOf, calcSMASeries, calcRSISeries } from './lab-proteus.shared.mjs'
import { moveBars, moveStarts, readName, MOVE } from './lab-proteus-moves.mjs'

export const CHAIN = { look: 60, runBars: 20, high250: 250, rsiHot: 70, stretchAtr: 3, climax: 2, failBars: 5, hardGap: 1, hardDay: 2, hardBars: 3, common: 2 / 3 }
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10)

/** Links 2 and 3 for one move start `s`. → null when the history before it is too short. Pure. */
export function chainAt(bars, atrs, s, c = CHAIN) {
    if (s < c.high250 + c.look) return null
    const cl = bars.map(b => b.close)
    let h = s - c.look
    for (let j = s - c.look; j < s; j++) if (cl[j] > cl[h]) h = j
    const a = atrs[s], ah = atrs[h]
    if (!Number.isFinite(a) || !Number.isFinite(ah) || ah <= 0) return null
    const s50 = calcSMASeries(cl.slice(0, s + 1), 50), s200 = calcSMASeries(cl.slice(0, s + 1), 200), rsi = calcRSISeries(cl.slice(0, h + 1), 14)
    const vol = bars.map(b => b.volume ?? 0), v20 = calcSMASeries(vol.slice(0, h + 1), 20)
    let prior60 = -Infinity
    for (let j = h - c.look; j < h; j++) prior60 = Math.max(prior60, cl[j])
    let prior250 = -Infinity
    for (let j = h - c.high250; j < h; j++) prior250 = Math.max(prior250, cl[j])
    const brokeOut = cl[h] > prior60
    let failed = false
    if (brokeOut) for (let j = h + 1; j <= Math.min(s, h + c.failBars); j++) if (cl[j] < prior60) { failed = true; break }
    let hard = false
    for (let j = h + 1; j <= Math.min(s, h + c.hardBars); j++) {
        const aj = atrs[j] ?? ah
        if (bars[j].open <= cl[j - 1] - c.hardGap * aj || cl[j] <= cl[j - 1] - c.hardDay * aj) { hard = true; break }
    }
    const run = (cl[h] - cl[Math.max(0, h - c.runBars)]) / ah
    return {
        high: h, start: s,
        // link 2 — the pullback
        drop_pct: (cl[s] / cl[h] - 1) * 100, drop_atr: (cl[h] - cl[s]) / a, bars: s - h,
        end_vs_50: s50[s] != null ? (cl[s] - s50[s]) / a : null, end_vs_200: s200[s] != null ? (cl[s] - s200[s]) / a : null,
        // link 3 — at and just after the high
        run_atr: run, new_250_high: cl[h] > prior250, rsi_hot: rsi[h] != null && rsi[h] > c.rsiHot, rsi_at_high: rsi[h],
        stretched: s50[h] != null && cl[h] - s50[h] >= c.stretchAtr * ah, climax: v20[h - 1] > 0 && vol[h] >= c.climax * v20[h - 1],
        failed_breakout: failed, hard_start: hard,
    }
}

/** Link 4 (§10.7): the breakout that failed — the first close over the prior 60-bar high in the 20 bars up to the high `h`. → null if none. Pure. */
export function breakoutAt(bars, atrs, h, c = CHAIN) {
    const cl = bars.map(b => b.close), vol = bars.map(b => b.volume ?? 0)
    const prior = (j) => { let m = -Infinity; for (let k = j - c.look; k < j; k++) m = Math.max(m, cl[k]); return m }
    let b = null
    for (let j = Math.max(c.look + 40, h - 20); j <= h; j++) if (cl[j] > prior(j)) { b = j; break }
    if (b == null) return null
    const a = atrs[b]
    if (!Number.isFinite(a) || a <= 0) return null
    const old = prior(b)
    let setAt = b - c.look
    for (let k = b - c.look; k < b; k++) if (cl[k] === old) setAt = k
    let lo = Infinity, hi = -Infinity
    for (let k = b - 40; k < b; k++) { lo = Math.min(lo, bars[k].low); hi = Math.max(hi, bars[k].high) }
    let best = -Infinity
    for (let k = b; k <= h; k++) best = Math.max(best, cl[k])
    const s200 = calcSMASeries(cl.slice(0, b + 1), 200), v20 = calcSMASeries(vol.slice(0, b), 20)
    return {
        breakout: b, base_bars: b - setAt, tight_base: hi - lo < 6 * a, base_atr: (hi - lo) / a, off_a_run: (cl[b] - cl[b - 20]) / a >= 3,
        run_atr: (cl[b] - cl[b - 20]) / a, vol_up: v20[b - 1] > 0 && vol[b] >= 1.5 * v20[b - 1], gap_up: bars[b].open >= cl[b - 1] + 0.5 * a,
        big_bar: bars[b].high - bars[b].low >= 1.5 * a, over_200: s200[b] != null && cl[b] > s200[b], reach_atr: (best - old) / a,
    }
}

/** One name's output file → its summary: moves, and the facts marked common at each link. Pure. */
export function summaryOf(text) {
    const moves = text.match(/moves with \d+ bars behind them: (\d+) of (\d+)/)
    const sec4 = text.indexOf('## Link 4')
    const common = (part) => [...part.matchAll(/^ {2}(\S.*?)\s+older\s+(\d+)% \(of (\d+)\) · recent\s+(\d+)% \(of (\d+)\)\s+← common/gm)].map(m => `${m[1].trim()} (${m[2]}/${m[4]}%)`)
    const links = sec4 < 0 ? text : text.slice(0, sec4)
    const at = links.indexOf('## What the moves share')
    const l23 = at < 0 ? [] : common(links.slice(at))
    const isPullback = (s) => /pullback|ended/.test(s)
    const n4 = text.match(/## Link 4 — .*?; (\d+) moves\)/)
    return {
        moves: moves ? +moves[1] : 0,
        link2: l23.filter(isPullback), link3: l23.filter(s => !isPullback(s)),
        link4n: n4 ? +n4[1] : 0, link4: sec4 < 0 ? [] : common(text.slice(sec4)),
    }
}

if (process.argv[1]?.endsWith('lab-proteus-moves-chain.mjs') && process.argv.length > 3) {   // several names: each, then side by side
    const { execFileSync } = await import('child_process')
    const syms = process.argv.slice(2).map(s => s.toUpperCase())
    const lines = [`# The chain backwards, name by name (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.7`, '']
    for (const sym of syms) {
        try { execFileSync(process.execPath, [process.argv[1], sym], { stdio: 'ignore' }) } catch { lines.push(`${sym}: failed`); continue }
        const s = summaryOf(fs.readFileSync(`data/lab/proteus-moves-chain-${sym}.out.txt`, 'utf8'))
        lines.push(`${sym} — ${s.moves} moves`)
        lines.push(`  link 2 (the pullback):  ${s.link2.join(' · ') || '—'}`)
        lines.push(`  link 3 (the top):       ${s.link3.join(' · ') || '—'}`)
        lines.push(`  link 4 (the breakout, ${s.link4n} moves): ${s.link4.join(' · ') || '—'}`)
        console.log(lines.slice(-4).join('\n'))
    }
    fs.writeFileSync('data/lab/proteus-moves-chain-summary.out.txt', lines.join('\n') + '\n')
    console.log('→ data/lab/proteus-moves-chain-summary.out.txt')
    process.exit(0)
}

if (process.argv[1]?.endsWith('lab-proteus-moves-chain.mjs')) {   // run, not imported (the unit test imports it)
    const SYM = (process.argv[2] ?? 'LNG').toUpperCase()
    const bars = await readName(SYM), spyBars = await readName('SPY')
    const spy = new Map(spyBars.map(b => [dayOf(b.timestamp), b.close]))
    const ex = JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8'))
    const reports = (ex.history?.[SYM] ?? []).filter(r => r.date)
    const atrs = atrsOf(bars), flags = moveBars(bars, atrs), starts = moveStarts(bars, flags)
    const cut = Math.floor(bars.length * (1 - MOVE.recentShare))
    const rows = starts.map(s => chainAt(bars, atrs, s)).filter(Boolean).map(r => {
        const dh = dayOf(bars[r.high].timestamp), ds = dayOf(bars[r.start].timestamp)
        const sp0 = spy.get(dh), sp1 = spy.get(ds)
        const rep = reports.find(x => x.date > dh && x.date <= ds)
        let hi = -Infinity
        for (let j = r.start + 1; j <= Math.min(bars.length - 1, r.start + MOVE.within); j++) hi = Math.max(hi, bars[j].high)
        return { ...r, dh, ds, part: r.start < cut ? 'older' : 'recent', gain: (hi / bars[r.start].close - 1) * 100,
            spy_pct: sp0 && sp1 ? (sp1 / sp0 - 1) * 100 : null,
            report: rep ? `${rep.date} ${rep.epsActual != null && rep.epsEstimated != null ? (rep.epsActual >= rep.epsEstimated ? 'beat' : 'miss') : '?'}` : null }
    })

    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const f1 = (x, d = 1) => (x == null ? '—' : x.toFixed(d))
    say(`# The chain backwards — ${SYM}, the moves only (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.7`)
    say(`moves with ${CHAIN.high250 + CHAIN.look} bars behind them: ${rows.length} of ${starts.length} · split ${dayOf(bars[cut].timestamp)}`)
    say('\n## Each move: link 2 (the pullback) · link 3 (at and after the high) · beside: SPY over the pullback, a report in it')
    for (const r of rows) {
        const tags = [r.new_250_high && '250-bar high', r.rsi_hot && `RSI ${f1(r.rsi_at_high, 0)}`, r.stretched && 'stretched', r.climax && 'climax vol', r.failed_breakout && 'a new 60-bar high, reversed', r.hard_start && 'hard start'].filter(Boolean)
        say(`  ${r.ds} +${f1(r.gain, 0)}%${r.part === 'recent' ? ' [recent]' : ''}`)
        say(`      pullback: from ${r.dh}, ${f1(r.drop_pct)}% (${f1(r.drop_atr)} ATR) in ${r.bars} bars, ended ${f1(r.end_vs_50)} ATR vs the 50 SMA, ${f1(r.end_vs_200)} vs the 200`)
        say(`      before it: run ${f1(r.run_atr)} ATR in ${CHAIN.runBars} bars into the high${tags.length ? ' · ' + tags.join(' · ') : ''} · SPY ${f1(r.spy_pct)}% · report ${r.report ?? '—'}`)
    }

    say(`\n## What the moves share (common = on ≥ ${Math.round(CHAIN.common * 100)}% of the moves, older AND recent)`)
    const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null }
    const groups = { older: rows.filter(r => r.part === 'older'), recent: rows.filter(r => r.part === 'recent') }
    const share = (pred) => Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.length ? g.filter(pred).length / g.length : null]))
    const facts = [
        ['a pullback of ≥ 2 ATR', r => r.drop_atr >= 2], ['a pullback of ≥ 3 ATR', r => r.drop_atr >= 3], ['the pullback ≤ 20 bars', r => r.bars <= 20],
        ['ended under the 50 SMA', r => r.end_vs_50 != null && r.end_vs_50 < 0], ['ended over the 200 SMA', r => r.end_vs_200 != null && r.end_vs_200 > 0],
        ['a run of ≥ 3 ATR into the high', r => r.run_atr >= 3], ['the high a new 250-bar high', r => r.new_250_high], ['RSI over 70 at the high', r => r.rsi_hot],
        ['stretched ≥ 3 ATR over the 50 SMA', r => r.stretched], ['climax volume at the high', r => r.climax], ['a new 60-bar high that reversed', r => r.failed_breakout],
        ['a hard start (gap / big down day)', r => r.hard_start], ['SPY down over the pullback', r => r.spy_pct != null && r.spy_pct < 0],
        ['SPY down ≥ 3% over it', r => r.spy_pct != null && r.spy_pct <= -3], ['a report in the pullback', r => r.report != null],
    ]
    const common = []
    for (const [label, pred] of facts) {
        const s = share(pred), ok = s.older >= CHAIN.common && s.recent >= CHAIN.common
        if (ok) common.push(label)
        say(`  ${label.padEnd(38)} older ${f1(s.older * 100, 0).padStart(3)}% (of ${groups.older.length}) · recent ${f1(s.recent * 100, 0).padStart(3)}% (of ${groups.recent.length})${ok ? '  ← common' : ''}`)
    }
    say(`  medians — pullback ${f1(med(rows.map(r => r.drop_pct)))}% / ${f1(med(rows.map(r => r.drop_atr)))} ATR in ${med(rows.map(r => r.bars))} bars · run into the high ${f1(med(rows.map(r => r.run_atr)))} ATR · RSI at the high ${f1(med(rows.map(r => r.rsi_at_high)), 0)}`)
    say(`\n## Link 3 found: ${common.length ? common.join(' · ') : 'nothing common beyond link 2'}`)

    // Link 4 — the moves whose link 3 is a new 60-bar high that reversed (§10.7: `failed_breakout`, the key kept): what led to the breakout.
    const spyBarsByDay = new Map(spyBars.map((b, i) => [dayOf(b.timestamp), i]))
    const spyC = spyBars.map(b => b.close)
    const fb = rows.filter(r => r.failed_breakout).map(r => {
        const k = breakoutAt(bars, atrs, r.high)
        if (!k) return null
        const db = dayOf(bars[k.breakout].timestamp), si = spyBarsByDay.get(db)
        let spyHi = -Infinity
        if (si != null) for (let j = si - 60; j < si; j++) spyHi = Math.max(spyHi, spyC[j])
        const rep = reports.filter(x => x.date <= db && x.date > dayOf(bars[k.breakout - 5].timestamp)).at(-1)
        return { ...r, ...k, db, spy_up: si != null && si >= 20 ? spyC[si] > spyC[si - 20] : null, spy_high: si != null ? spyC[si] > spyHi : null,
            rep: rep ? `${rep.date} ${rep.epsActual != null && rep.epsEstimated != null ? (rep.epsActual >= rep.epsEstimated ? 'beat' : 'miss') : '?'}` : null }
    }).filter(Boolean)
    say(`\n## Link 4 — what led to the breakout (the top a new 60-bar high; ${fb.length} moves)`)
    for (const r of fb) {
        const tags = [r.tight_base && 'tight base', r.off_a_run && 'off a run', r.vol_up && 'volume ≥ 1.5×', r.gap_up && 'gap up', r.big_bar && 'big bar', r.over_200 && 'over the 200',
            r.reach_atr <= 1 && 'shallow', r.spy_up && 'SPY up', r.spy_high && 'SPY at a 60-day high'].filter(Boolean)
        say(`  move ${r.ds}${r.part === 'recent' ? ' [recent]' : ''} · breakout ${r.db}: ${r.base_bars} bars under the old high, base ${f1(r.base_atr)} ATR, run ${f1(r.run_atr)} ATR, got ${f1(r.reach_atr)} ATR over it · ${tags.join(' · ') || '—'} · report ${r.rep ?? '—'}`)
    }
    const g4 = { older: fb.filter(r => r.part === 'older'), recent: fb.filter(r => r.part === 'recent') }
    const facts4 = [
        ['under the old high ≥ 20 bars', r => r.base_bars >= 20], ['a tight base (40 bars < 6 ATR)', r => r.tight_base], ['off a run (≥ 3 ATR in 20)', r => r.off_a_run],
        ['volume ≥ 1.5× on the breakout', r => r.vol_up], ['a gap up ≥ 0.5 ATR', r => r.gap_up], ['a big bar ≥ 1.5 ATR', r => r.big_bar], ['over the 200 SMA', r => r.over_200],
        ['shallow (≤ 1 ATR over the old high)', r => r.reach_atr <= 1], ['a report in the 5 bars before', r => r.rep != null], ['SPY up over the 20 bars', r => r.spy_up === true],
        ['SPY at a 60-day high too', r => r.spy_high === true],
    ]
    const common4 = []
    for (const [label, pred] of facts4) {
        const s = Object.fromEntries(Object.entries(g4).map(([k, g]) => [k, g.length ? g.filter(pred).length / g.length : null]))
        const ok = s.older >= CHAIN.common && s.recent >= CHAIN.common
        if (ok) common4.push(label)
        say(`  ${label.padEnd(38)} older ${f1(s.older * 100, 0).padStart(3)}% (of ${g4.older.length}) · recent ${f1(s.recent * 100, 0).padStart(3)}% (of ${g4.recent.length})${ok ? '  ← common' : ''}`)
    }
    say(`  medians — under the old high ${med(fb.map(r => r.base_bars))} bars · base ${f1(med(fb.map(r => r.base_atr)))} ATR · run ${f1(med(fb.map(r => r.run_atr)))} ATR · got ${f1(med(fb.map(r => r.reach_atr)))} ATR over`)
    say(`\n## Link 4 found: ${common4.length ? common4.join(' · ') : 'nothing common'}`)
    fs.writeFileSync(`data/lab/proteus-moves-chain-${SYM}.out.txt`, lines.join('\n') + '\n')
    console.log(`→ data/lab/proteus-moves-chain-${SYM}.out.txt`)
    process.exit(0)
}
