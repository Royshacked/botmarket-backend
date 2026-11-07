// WHERE TWO SIDE GROUPS' GAINS COME FROM (Roy, 2026-11-07: "good reports + guidance numbers only and big beat — let's
// analyse them"). Both were picked AFTER §32–33's results, so this is a description, not a test: by year, sector, size,
// the surprise, the day-one reaction, the hold's parts, and how much a few winners carry.
//
//   node --max-old-space-size=6000 scripts/lab-guidance-groups.mjs
//
// Offline: data/lab caches + data/lab/guidance-8k.jsonl.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { guidanceDirection } = await import('../services/guidance8k.service.js')
const { holdTrades, holdBook, bookBlocks } = await import('../services/holdToNext.service.js')
const { reactionAt } = await import('../services/reportReaction.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { memberOn } = await import('../services/sp500History.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')

const guidanceOf = new Map(fs.readFileSync('data/lab/guidance-8k.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .map(r => [`${r.symbol} ${r.report}`, r.miss ? 'missing' : guidanceDirection(r)]))
const u = JSON.parse(fs.readFileSync('data/lab/sp500-universe.json', 'utf8'))
const member = (sym, day) => memberOn(u.spans, sym, day)
const data = await loadLabData({ name: 'sp500', window: { from: '2019-01-02', to: '2026-10-26' }, extras: ['history', 'insiders'], member })
await closeDb()
const FROM = '2020-01-01', SPLIT = '2024-01-01'
const trades = holdTrades(data, { from: FROM, member }).trades
for (const t of trades) {
    const s = data.names.get(t.symbol), k = t.i - 2
    t.guidance = guidanceOf.get(`${t.symbol} ${s.ind.date[k]}`) ?? 'not fetched'
    t.sector = s.sector ?? 'unknown'
    t.reaction = reactionAt(s, k, data)
    t.adv = s.ind.adv20[t.i - 1] ?? 0
}
const days = data.spyDays.filter(d => d >= FROM)

const f = (x, w = 7) => (x == null ? '—'.padStart(w) : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(w))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
const beat = (ts) => `${(ts.filter(t => t.net > 0).length / ts.length * 100).toFixed(0)}%`.padStart(4)
const row = (label, ts) => (ts.length
    ? console.log(`    ${label.padEnd(26)} ${String(ts.length).padStart(5)} · net ${f(mean(ts.map(t => t.net)))} median ${f(median(ts.map(t => t.net)))} beat SPY ${beat(ts)}`)
    : console.log(`    ${label.padEnd(26)}     0`))
// Cuts by quintile of a value WITHIN the group, so each bin has a fifth of its trades.
function quintiles(ts, key, label) {
    const v = [...ts].sort((a, b) => a[key] - b[key]).filter(t => t[key] != null)
    for (let q = 0; q < 5; q++) {
        const bin = v.slice(Math.floor(q * v.length / 5), Math.floor((q + 1) * v.length / 5))
        if (bin.length) row(`${label} Q${q + 1} (${bin[0][key].toFixed(1)}…${bin.at(-1)[key].toFixed(1)})`, bin)
    }
}

function analyse(title, ts, control) {
    console.log(`\n══ ${title}`)
    const b = holdBook(data, ts), w = bookBlocks(b, days)
    const bb = bookBlocks(b, days.filter(d => d < SPLIT)), ba = bookBlocks(b, days.filter(d => d >= SPLIT))
    console.log(`  ${ts.length} trades · net ${f(mean(ts.map(t => t.net)))} median ${f(median(ts.map(t => t.net)))} beat SPY ${beat(ts)} · book/mo ${f(w?.mean)} t ${w?.t?.toFixed(2)} · before ${f(bb?.mean)} after ${f(ba?.mean)}`)
    console.log(`  against every report (same days, equal weight): net ${f(mean(control.map(t => t.net)))} → this group ${f(mean(ts.map(t => t.net)) - mean(control.map(t => t.net)))} better per trade`)

    // How much a few winners carry.
    const sorted = [...ts].sort((a, b) => b.net - a.net), total = ts.reduce((a, t) => a + t.net, 0)
    for (const share of [0.01, 0.05]) {
        const top = sorted.slice(0, Math.max(1, Math.round(ts.length * share)))
        const rest = sorted.slice(top.length)
        console.log(`  without the top ${share * 100}% (${top.length} trades, mean ${f(mean(top.map(t => t.net)))}): the rest ${f(mean(rest.map(t => t.net)))}`)
    }
    console.log(`  the 10 best: ${sorted.slice(0, 10).map(t => `${t.symbol} ${t.day.slice(0, 7)} ${f(t.net, 0)}`).join(' · ')}`)
    console.log(`  sum of all nets ${total.toFixed(0)}% · the 10 best ${sorted.slice(0, 10).reduce((a, t) => a + t.net, 0).toFixed(0)}%`)

    console.log('  by year bought')
    for (const y of [...new Set(ts.map(t => t.day.slice(0, 4)))].sort()) row(y, ts.filter(t => t.day.startsWith(y)))
    console.log('  by sector (10+ trades)')
    const secs = [...new Set(ts.map(t => t.sector))].map(s => [s, ts.filter(t => t.sector === s)]).filter(([, x]) => x.length >= 10).sort((a, b) => mean(b[1].map(t => t.net)) - mean(a[1].map(t => t.net)))
    for (const [s, x] of secs) row(s, x)
    console.log('  by dollar volume (size), within the group ($M a day)')
    for (const t of ts) t.adv_m = t.adv / 1e6
    quintiles(ts, 'adv_m', 'ADV')
    console.log('  by the EPS surprise (%)')
    quintiles(ts, 'surprise', 'surprise')
    console.log('  by the day-one reaction vs SPY (%)')
    quintiles(ts, 'reaction', 'reaction')
    console.log('  by the market on the day')
    row('reacted up', ts.filter(t => t.reacted === 'up'))
    row('reacted down', ts.filter(t => t.reacted === 'down'))
    console.log('  the hold in parts (trades that reached a next report)')
    const parts = ts.filter(t => t.body != null)
    console.log(`    to the run-up window ${f(mean(parts.map(t => t.body)))} · the last 5 sessions ${f(mean(parts.map(t => t.last)))}`)
}

const good = (t) => t.good
const A = trades.filter(t => good(t) && t.guidance === 'numbers')
const B = trades.filter(t => t.band === 'big beat' && t.rev_beat === true && t.reacted === 'up')
const both = A.filter(t => B.includes(t))
console.log(`${trades.length} trades · A good + numbers only ${A.length} · B big beat + revenue + bought ${B.length} · in both ${both.length}`)
analyse('A — GOOD REPORT + GUIDANCE AS NUMBERS ONLY', A, trades)
analyse('B — BIG BEAT (EPS > +10%) + REVENUE BEAT + THE MARKET BOUGHT', B, trades)
analyse('A and B together (the overlap)', both, trades)
analyse('B without A (big beats that stated a direction, or none)', B.filter(t => !A.includes(t)), trades)
process.exit(0)
