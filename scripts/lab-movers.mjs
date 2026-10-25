// WHAT TELLS AN UP MOVER FROM A DOWN MOVER (services/moverDiff.service.js) — every name-week 5%+ over SPY against every
// one 5%+ under, on the facts known at the entry's open; bins cut and the model fitted before the held-out year.
//
//   node scripts/lab-movers.mjs [min=5] [--daily]
//
// --daily: an entry EVERY session, held five (Roy, 2026-10-25: "do this test every day") — not only Monday's; the
// deciles also count each entry session once (neighbouring sessions share most of their window).
//
// Offline on the three-year cache (data/lab/screener-3y.json + its earnings history); writes data/lab/movers-diff[-daily].json.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const min = Number(process.argv.slice(2).find(a => !a.startsWith('--'))) || 5
const daily = process.argv.includes('--daily')
const { collectMovers, binByFeature, fitAndScore, FEATURES } = await import('../services/moverDiff.service.js')
const { loadLabData } = await import('../services/screenerLab.data.js')
const { closeDb } = await import('../providers/mongodb.provider.js')
const data = await loadLabData({ name: 'screener', years: 3, extras: ['history'] })
await closeDb()
const splitAt = data.calendarFrom
const movers = collectMovers(data, { weeks: 150, min, daily })
data.names.clear()
const days = [...new Set(movers.map(m => m.week))].sort()
const [before, held] = [movers.filter(m => m.week < splitAt), movers.filter(m => m.week >= splitAt)]
const share = (xs) => ((xs.filter(m => m.up).length / (xs.length || 1)) * 100).toFixed(1)
console.log(`${movers.length} movers (${min}%+ either way vs SPY, ${daily ? 'every session, held 5' : 'Monday to Friday'}) · ${days[0]} → ${days.at(-1)} (${days.length} entries) · before ${splitAt}: ${before.length} (${share(before)}% up) · held out: ${held.length} (${share(held)}% up)\n`)

const bins = binByFeature(movers, splitAt)
console.log('PER FACT — the share that went UP, by quintile (cut before the held-out year): before | held out · spread top − bottom')
const order = FEATURES.filter(k => bins[k]).sort((a, b) => Math.abs(bins[b].spread_before ?? 0) - Math.abs(bins[a].spread_before ?? 0))
for (const k of order) {
    const v = bins[k]
    const row = (side) => v.bins.map(b => String(b[side].up ?? '—').padStart(5)).join(' ')
    const same = v.spread_before != null && v.spread_held != null && Math.sign(v.spread_before) === Math.sign(v.spread_held) && Math.abs(v.spread_held) >= 3
    console.log(`  ${k.padEnd(18)} ${row('before')}  | ${row('held')}   ${String(v.spread_before).padStart(5)} | ${String(v.spread_held).padStart(5)} ${same ? ' ← holds' : ''}   cuts ${v.cuts.join(' / ')}`)
}

const fit = fitAndScore(movers, splitAt)
console.log(`\nALL TOGETHER — logistic regression fitted on ${fit.train} movers before, scored on ${fit.held.n} held out: AUC ${fit.held.auc} (0.5 = a coin)`)
console.log('  held-out deciles, least → most bullish:  up-share (per session) · net vs SPY')
for (const [d, x] of fit.held.deciles.entries()) console.log(`    ${String(d + 1).padStart(2)}  ${String(x.up).padStart(5)}%  (per session ${x.up_per_session}%, ${x.sessions})  ${x.net_mean >= 0 ? '+' : ''}${x.net_mean}%   (${x.n})`)
console.log(`  weights (standardized): ${Object.entries(fit.weights).slice(0, 10).map(([k, w]) => `${k} ${w}`).join(' · ')}`)
fs.writeFileSync(`data/lab/movers-diff${daily ? '-daily' : ''}.json`, JSON.stringify({ min, daily, splitAt, n: movers.length, bins, fit }, null, 1))
