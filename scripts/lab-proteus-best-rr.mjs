#!/usr/bin/env node
// THE BEST REWARD : RISK PER STOCK, PER HORIZON — NO SIGNAL (Roy, 2026-11-21: "put indicators and patterns aside — check
// what is the best r:r for each stock; start with 5 stocks on each horizon"). An entry at EVERY session's close; a grid of
// targets × reward : risk; exit at the target, the stop (a bar reaching both = the stop), or the horizon's last close; a
// 0.1% round-trip cost. Per stock and horizon: the brackets ranked by return PER SESSION HELD (a 2-month trade ties the
// money longer), against buy-and-hold over the same horizon — whole 10 years, and the older / recent halves (is a name's
// best bracket stable?).
//
//   node scripts/lab-proteus-best-rr.mjs [SYM ...]   (default NVDA KO LNG TSLA JPM) → data/lab/proteus-best-rr.out.txt

import fs from 'fs'
import readline from 'readline'

const SYMS = process.argv.slice(2).length ? process.argv.slice(2).map(s => s.toUpperCase()) : ['NVDA', 'KO', 'LNG', 'TSLA', 'JPM']
const TARGETS = [1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20]
const RATIOS = [1, 1.5, 2, 2.5, 3]
const HORIZONS = [10, 21, 42, 63]
const COST = 0.001
const HALF = Date.parse('2021-10-26T00:00:00Z') / 1000

async function load(syms, file = 'data/lab/screener-10y.jsonl') {
    const want = new Set(syms), out = {}
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
        const sym = line.slice(11, line.indexOf('"', 11))
        if (!want.has(sym)) continue
        out[sym] = JSON.parse(line).b.map(([t, o, h, l, c]) => ({ t, o, h, l, c })).filter(b => b.c > 0 && b.h >= b.l).sort((a, b) => a.t - b.t)
        if (Object.keys(out).length === want.size) { rl.close(); break }
    }
    return out
}

/** One trade from bar i's close: { ret, held } — target / stop / the cap's close; a bar reaching both = the stop. */
function trade(bars, i, tgt, stop, cap) {
    const c = bars[i].c, up = c * (1 + tgt / 100), dn = c * (1 - stop / 100)
    for (let k = i + 1; k <= i + cap; k++) {
        if (bars[k].l <= dn) return { ret: -stop / 100 - COST, held: k - i, how: 'stop' }
        if (bars[k].h >= up) return { ret: tgt / 100 - COST, held: k - i, how: 'target' }
    }
    return { ret: bars[i + cap].c / c - 1 - COST, held: cap, how: 'time' }
}

const lines = []
const say = (l = '') => { console.log(l); lines.push(l) }
const pc = (x, d = 2) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`
say(`# The best reward : risk per stock and horizon, no signal (${new Date().toISOString().slice(0, 10)})`)
say('An entry at every close; exit at the target, the stop or the horizon\'s close; 0.1% cost. Ranked by return per session held.')
say(`Targets ${TARGETS.join(', ')}% × reward:risk ${RATIOS.join(', ')} (stop = target / ratio). Halves split 2021-10.`)

const data = await load(SYMS)
for (const sym of SYMS) {
    const bars = data[sym]
    if (!bars) { say(`\n${sym}: not in the file`); continue }
    say(`\n# ${sym} — ${bars.length} sessions, ${new Date(bars[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(bars.at(-1).t * 1000).toISOString().slice(0, 10)}`)
    for (const cap of HORIZONS) {
        const res = []
        // Buy-and-hold over the same horizon (the yardstick): every entry held to the cap.
        const hold = { all: [], older: [], recent: [] }
        for (let i = 0; i + cap < bars.length; i++) { const r = bars[i + cap].c / bars[i].c - 1 - COST; hold.all.push(r); hold[bars[i].t < HALF ? 'older' : 'recent'].push(r) }
        const perDay = (xs, held) => xs.reduce((s, x) => s + x, 0) / held
        const holdPD = { all: perDay(hold.all, hold.all.length * cap), older: perDay(hold.older, hold.older.length * cap), recent: perDay(hold.recent, hold.recent.length * cap) }
        for (const tgt of TARGETS) for (const rr of RATIOS) {
            const stop = tgt / rr
            const acc = { all: [0, 0, 0, 0], older: [0, 0, 0, 0], recent: [0, 0, 0, 0] }   // sum ret, sum held, n, wins
            for (let i = 0; i + cap < bars.length; i++) {
                const t = trade(bars, i, tgt, stop, cap)
                for (const part of ['all', bars[i].t < HALF ? 'older' : 'recent']) { const a = acc[part]; a[0] += t.ret; a[1] += t.held; a[2]++; if (t.how === 'target') a[3]++ }
            }
            const pd = (a) => a[0] / a[1], avg = (a) => a[0] / a[2]
            res.push({ tgt, rr, stop, pd: pd(acc.all), avg: avg(acc.all), held: acc.all[1] / acc.all[2], win: acc.all[3] / acc.all[2], o: pd(acc.older), r: pd(acc.recent) })
        }
        res.sort((a, b) => b.pd - a.pd)
        const rankOf = (key) => [...res].sort((a, b) => b[key] - a[key])
        const bestO = rankOf('o')[0], bestR = rankOf('r')[0]
        const beat = res.filter(x => x.pd > holdPD.all).length
        say(`\n## ${sym} · horizon ${cap} sessions — buy-and-hold ${pc(holdPD.all, 3)}/session (older ${pc(holdPD.older, 3)}, recent ${pc(holdPD.recent, 3)}) · ${beat} of ${res.length} brackets beat it`)
        say('  rank  target / stop      per session   per trade   held   win    older / recent (per session)')
        for (const [k, x] of res.slice(0, 5).entries()) {
            say(`  ${String(k + 1).padStart(4)}  ${`${x.tgt}% / ${+x.stop.toFixed(2)}%`.padEnd(16)} (1:${x.rr})  ${pc(x.pd, 3).padStart(8)}   ${pc(x.avg).padStart(7)}   ${x.held.toFixed(1).padStart(4)}   ${Math.round(x.win * 100)}%    ${pc(x.o, 3)} / ${pc(x.r, 3)}`)
        }
        const w = res.at(-1)
        say(`  worst ${`${w.tgt}% / ${+w.stop.toFixed(2)}%`.padEnd(16)} (1:${w.rr})  ${pc(w.pd, 3).padStart(8)}`)
        say(`  best in the OLDER half: ${bestO.tgt}% / ${+bestO.stop.toFixed(2)}% (1:${bestO.rr}) ${pc(bestO.o, 3)} → in the recent half it made ${pc(bestO.r, 3)} (rank ${rankOf('r').indexOf(bestO) + 1} of ${res.length})`)
        say(`  best in the RECENT half: ${bestR.tgt}% / ${+bestR.stop.toFixed(2)}% (1:${bestR.rr}) ${pc(bestR.r, 3)}`)
    }
}
fs.writeFileSync('data/lab/proteus-best-rr.out.txt', lines.join('\n') + '\n')
console.log('→ data/lab/proteus-best-rr.out.txt')
