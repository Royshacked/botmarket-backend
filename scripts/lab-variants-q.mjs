// DOES Q'S PASS SURVIVE ITS NEIGHBOURS? — test X, the Q grid (declared in screener-lab.md §47, before the run). The
// revenue beat's threshold × the hold, against the equal-weight market and SPY; the verdict is the grid.
//
//   node --max-old-space-size=6000 scripts/lab-variants-q.mjs
//
// Offline: data/lab caches. Both yardsticks in one process (LAB_BENCH is ignored).
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
delete process.env.LAB_BENCH
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { loadLabData, equalWeightBars } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const FROM = '2020-01-01', SPLIT = '2024-01-01', MINS = [5, 7.5, 10, 15, 20], HOLDS = [20, 30, 40, 50, 60, 'next']
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member, bench: 'spy' })
await closeDb()
const BENCH = { ew: { ...data, spyByDay: equalWeightBars(data.names, data.spyDays, data.spyRealByDay, member) }, spy: data }

const base = holdTrades(data, { from: FROM, member }).trades
for (const t of base) {
    const s = data.names.get(t.symbol), rep = s.reports.get(s.ind.date[t.i - 2])
    const a = Number(rep?.revenueActual), e = Number(rep?.revenueEstimated)
    t.rev = a > 0 && e > 0 ? (a / e - 1) * 100 : null
}
/** The trade held `h` sessions (never past the close before the next report); only i/x matter to the book. */
const heldFor = (t, h) => (h === 'next' ? t : { ...t, x: Math.min(t.i + h - 1, t.x) })
const days = data.spyDays.filter(d => d >= FROM)
function read(ts, bench) {
    const b = holdBook(BENCH[bench], ts)
    return { n: ts.length, whole: bookBlocks(b, days), before: bookBlocks(b, days.filter(x => x < SPLIT)), after: bookBlocks(b, days.filter(x => x >= SPLIT)) }
}
const f2 = (x, w = 6) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`.padStart(w))
const both = (r) => r.before?.mean > 0 && r.after?.mean > 0

const grid = {}
for (const bench of ['ew', 'spy']) {
    grid[bench] = {}
    console.log(`\n── AGAINST ${bench === 'ew' ? 'THE EQUAL-WEIGHT MARKET' : 'SPY'}: book %/mo (t) · before / after · ◆ = positive in both periods`)
    console.log(`  ${'beat ≥'.padEnd(8)}${HOLDS.map(h => String(h).padStart(24)).join('')}`)
    for (const m of MINS) {
        const picks = base.filter(t => t.rev != null && t.rev >= m)
        const cells = HOLDS.map(h => { const r = read(picks.map(t => heldFor(t, h)), bench); grid[bench][`${m} ${h}`] = r; return r })
        console.log(`  ${`${m}%`.padEnd(8)}${cells.map(r => `${both(r) ? '◆' : ' '}${f2(r.whole?.mean)} (${r.whole?.t?.toFixed(1) ?? '—'}) ${f2(r.before?.mean, 5)}/${f2(r.after?.mean, 5)}`.padStart(24)).join('')}`)
    }
    console.log(`  (picks: ${MINS.map(m => `≥${m}% ${base.filter(t => t.rev != null && t.rev >= m).length}`).join(' · ')})`)
}

console.log('\n── THE BEAT AT 10% WITH MORE (against the equal-weight market, then SPY)')
const COMBOS = {
    'revenue 10%+': (t) => t.rev >= 10,
    '+ EPS beat': (t) => t.rev >= 10 && t.surprise > 0,
    '+ the market bought': (t) => t.rev >= 10 && t.reacted === 'up',
    '+ EPS beat + bought': (t) => t.rev >= 10 && t.surprise > 0 && t.reacted === 'up',
}
for (const [label, keep] of Object.entries(COMBOS)) {
    const picks = base.filter(t => t.rev != null && keep(t))
    const cell = (h, bench) => { const r = read(picks.map(t => heldFor(t, h)), bench); return `${both(r) ? '◆' : ' '}${f2(r.whole?.mean)} t ${r.whole?.t?.toFixed(2)} (${f2(r.before?.mean, 5)}/${f2(r.after?.mean, 5)})` }
    console.log(`  ${label.padEnd(22)} ${String(picks.length).padStart(5)} · 40: ew ${cell(40, 'ew')} · spy ${cell(40, 'spy')} · next: ew ${cell('next', 'ew')} · spy ${cell('next', 'spy')}`)
}

// THE DECLARED VERDICT (against the equal-weight market).
const cells = Object.values(grid.ew), ts = cells.map(r => r.whole?.t).filter(Number.isFinite).sort((a, b) => a - b)
const shareBoth = cells.filter(both).length / cells.length, medT = ts[Math.floor(ts.length / 2)]
const nbKeys = ['7.5 40', '15 40', '10 30', '10 50', '7.5 next', '15 next', '10 60']
const nbOk = nbKeys.every(k => both(grid.ew[k]))
console.log(`\nDECLARED VERDICT (Q grid, equal-weight): cells positive in both periods ${(shareBoth * 100).toFixed(0)}% (need ≥ 67%) · median t ${medT?.toFixed(2)} (need ≥ 1.5) · the declared cells' neighbours (${nbKeys.join(', ')}) all positive in both ${nbOk} → ${shareBoth >= 2 / 3 && medT >= 1.5 && nbOk ? 'ROBUST' : 'NOT ROBUST'}`)
process.exit(0)
